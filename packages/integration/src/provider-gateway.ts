import {
  ConnectorError,
  type DeviceCommand,
  type DeviceConnectorPort,
  type SecretString,
} from '@trash-palace/connectors'
import {
  GatewayDispatchResultSchema,
  type GatewayCommand,
  type GatewayDispatchResult,
} from '@trash-palace/core'
import type { GatewayPort } from '@trash-palace/application'

export interface ProviderUnlockAuthorityResolver {
  resolve(command: Extract<GatewayCommand, { kind: 'unlock' }>): Promise<SecretString | null>
}

/** Translates the canonical host gateway contract; provider APIs never become model or MCP tools. */
export class ProviderGatewayAdapter implements GatewayPort {
  public constructor(
    private readonly connector: DeviceConnectorPort,
    private readonly unlockAuthority: ProviderUnlockAuthorityResolver,
  ) {}

  public async dispatch(command: GatewayCommand): Promise<GatewayDispatchResult> {
    try {
      if (command.kind === 'set_lighting') {
        const plan = await this.connector.scheduleLighting({
          tenantId: command.organizationId,
          parentCommandId: command.id,
          slotId: command.payload.deviceId,
          brightness: command.payload.intensityPercent,
          durationSeconds: command.payload.durationSeconds,
          startsAt: command.createdAt,
        })
        for (const step of plan.steps.slice(0, 2)) {
          const receipt = await this.connector.dispatchCommand(step)
          if (receipt.status === 'outcome_unknown') return unknown()
        }
        return accepted(command)
      }

      const projected = await this.#projectDirectCommand(command)
      if (projected === null) {
        return failed('UNLOCK_AUTHORITY_REQUIRED', 'Fresh host unlock authority is required', false)
      }
      const receipt = await this.connector.dispatchCommand(projected)
      return receipt.status === 'outcome_unknown' ? unknown() : accepted(command)
    } catch (error) {
      if (error instanceof ConnectorError) {
        return failed(
          `PROVIDER_${error.code.toUpperCase()}`,
          'The configured device provider rejected the canonical gateway command',
          error.outcome !== 'definitely_not_sent',
        )
      }
      return unknown()
    }
  }

  async #projectDirectCommand(command: Exclude<GatewayCommand, { kind: 'set_lighting' }>) {
    const base = {
      tenantId: command.organizationId,
      commandId: command.id,
      slotId: command.payload.deviceId,
    }
    if (command.kind === 'set_temperature') {
      return {
        ...base,
        action: 'thermostat.setHeatingSetpoint' as const,
        value: command.payload.targetCelsius,
        unit: 'C' as const,
      } satisfies DeviceCommand
    }
    if (command.kind === 'locked_desired_state') {
      return { ...base, action: 'lock.lock' as const } satisfies DeviceCommand
    }
    const confirmationId = await this.unlockAuthority.resolve(command)
    return confirmationId === null
      ? null
      : ({ ...base, action: 'lock.unlock' as const, confirmationId } satisfies DeviceCommand)
  }
}

function accepted(command: GatewayCommand): GatewayDispatchResult {
  return GatewayDispatchResultSchema.parse({
    status: 'accepted',
    acknowledgementId: `gack_provider_${command.id.slice(-24)}`,
  })
}

function unknown(): GatewayDispatchResult {
  return GatewayDispatchResultSchema.parse({
    status: 'unknown',
    retryable: true,
    reason: 'lost_ack',
  })
}

function failed(code: string, message: string, retryable: boolean): GatewayDispatchResult {
  return GatewayDispatchResultSchema.parse({ status: 'failed', code, message, retryable })
}
