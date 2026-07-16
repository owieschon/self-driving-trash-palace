import {
  secret,
  type CommandReceipt,
  type DeviceCommand,
  type DeviceConnectorPort,
} from '@trash-palace/connectors'
import { createGatewayCommand, type GatewayCommand } from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { ProviderGatewayAdapter } from './provider-gateway.js'

function connector(): DeviceConnectorPort {
  const dispatchCommand = vi.fn(async (command: DeviceCommand): Promise<CommandReceipt> => ({
    commandId: command.commandId,
    slotId: command.slotId,
    status: 'accepted_non_terminal',
    reconciliationRequired: true,
  }))
  return {
    discoverDevices: vi.fn(async () => []),
    mapDiscoveredDevice: vi.fn(),
    scheduleLighting: vi.fn(),
    readDeviceState: vi.fn(),
    reconcileCommand: vi.fn(),
    dispatchCommand,
  }
}

function command(kind: 'unlock' | 'locked_desired_state'): GatewayCommand {
  const base = {
    organizationId: 'org_primary0001',
    missionId: 'mis_mission00001',
    palaceId: 'pal_palace00001',
    operationId: 'op_operation0001',
    createdAt: '2026-08-14T09:00:00.000Z',
  } as const
  if (kind === 'unlock') {
    return createGatewayCommand({
      ...base,
      logicalKey: kind,
      kind,
      payload: {
        deviceId: 'dev_service_hatch_lock',
        identityTagId: 'tag_acorn_hauler',
        durationSeconds: 300,
        causedByEvidenceId: 'evd_verified_hauler',
      },
    })
  }
  return createGatewayCommand({
    ...base,
    logicalKey: kind,
    kind,
    payload: {
      deviceId: 'dev_service_hatch_lock',
      causedByEvidenceId: 'evd_access_window_end',
    },
  })
}

describe('canonical provider gateway', () => {
  it('routes canonical lock commands without exposing provider-specific tools', async () => {
    const devices = connector()
    const gateway = new ProviderGatewayAdapter(devices, { resolve: vi.fn(async () => null) })

    await expect(gateway.dispatch(command('locked_desired_state'))).resolves.toMatchObject({
      status: 'accepted',
    })
    expect(devices.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lock.lock', slotId: 'dev_service_hatch_lock' }),
    )
  })

  it('fails closed when the host has not issued fresh unlock authority', async () => {
    const devices = connector()
    const gateway = new ProviderGatewayAdapter(devices, { resolve: vi.fn(async () => null) })

    await expect(gateway.dispatch(command('unlock'))).resolves.toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'UNLOCK_AUTHORITY_REQUIRED',
    })
    expect(devices.dispatchCommand).not.toHaveBeenCalled()
  })

  it('passes only a host-resolved confirmation into the encrypted connector boundary', async () => {
    const devices = connector()
    const gateway = new ProviderGatewayAdapter(devices, {
      resolve: vi.fn(async () => secret('confirmation-private-value-001')),
    })

    await expect(gateway.dispatch(command('unlock'))).resolves.toMatchObject({
      status: 'accepted',
    })
    expect(devices.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lock.unlock',
        confirmationId: 'confirmation-private-value-001',
      }),
    )
  })
})
