import { createHash } from 'node:crypto'

import {
  DeviceCommandEvidenceSchema,
  DeviceIdSchema,
  DeviceSchema,
  EvidenceIdSchema,
  EvidenceSchema,
  IdentityTagIdSchema,
  IdentityTagSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  TenantAccessAuditEvidenceSchema,
  type Device,
  type DeviceId,
  type Evidence,
  type IdentityTag,
  type OrganizationId,
  type PalaceId,
} from '@trash-palace/core'
import { z } from 'zod'

const DeviceModelOptionsSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    devices: z.array(DeviceSchema).min(1),
    identityTags: z.array(IdentityTagSchema),
    startsAt: IsoDateTimeSchema,
    batteryAvailablePercentage: z.number().min(0).max(100),
    initialTemperatureCelsius: z.number().min(-50).max(80).default(18),
  })
  .strict()
  .superRefine((options, context) => {
    for (const [index, device] of options.devices.entries()) {
      if (
        device.organizationId !== options.organizationId ||
        device.palaceId !== options.palaceId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['devices', index],
          message: 'Device model cannot contain a cross-tenant device',
        })
      }
    }
    for (const [index, tag] of options.identityTags.entries()) {
      if (tag.organizationId !== options.organizationId) {
        context.addIssue({
          code: 'custom',
          path: ['identityTags', index],
          message: 'Device model cannot contain a cross-tenant identity tag',
        })
      }
    }
    const kinds = options.devices.map((device) => device.kind)
    if (new Set(kinds).size !== kinds.length) {
      context.addIssue({
        code: 'custom',
        path: ['devices'],
        message: 'Device model supports one deterministic device per kind',
      })
    }
  })

export type DeviceModelOptions = z.input<typeof DeviceModelOptionsSchema>

const InstructionContextShape = {
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  palaceId: PalaceIdSchema,
  deviceId: DeviceIdSchema,
  at: IsoDateTimeSchema,
} as const

export const DeviceInstructionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...InstructionContextShape,
      kind: z.literal('set_temperature'),
      targetCelsius: z.number().min(5).max(35),
      completeAt: IsoDateTimeSchema,
      causedByEvidenceId: EvidenceIdSchema.nullable().default(null),
    })
    .strict(),
  z
    .object({
      ...InstructionContextShape,
      kind: z.literal('set_lighting'),
      intensityPercent: z.number().int().min(0).max(100),
      durationSeconds: z.number().int().positive().max(86_400),
      causedByEvidenceId: EvidenceIdSchema,
    })
    .strict(),
  z
    .object({
      ...InstructionContextShape,
      kind: z.literal('unlock'),
      identityTagId: IdentityTagIdSchema,
      durationSeconds: z.number().int().positive().max(300),
      causedByEvidenceId: EvidenceIdSchema,
    })
    .strict(),
  z
    .object({
      ...InstructionContextShape,
      kind: z.literal('locked_desired_state'),
      causedByEvidenceId: EvidenceIdSchema,
    })
    .strict(),
])

export type DeviceInstruction = z.input<typeof DeviceInstructionSchema>
type ParsedDeviceInstruction = z.output<typeof DeviceInstructionSchema>

export const EnergyProjectionInputSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    palaceId: PalaceIdSchema,
    at: IsoDateTimeSchema,
    projectedUsePercentagePoints: z.number().min(0).max(100),
    maximumPercentagePoints: z.number().min(0).max(100),
  })
  .strict()

export interface EnergyProjection {
  readonly projectedUsePercentagePoints: number
  readonly maximumPercentagePoints: number
  readonly batteryAvailablePercentage: number
  readonly projectedBatteryRemainingPercentage: number
  readonly withinRoutineBound: boolean
  readonly withinAvailableEnergy: boolean
  readonly evidence: Evidence
}

export interface DeviceModelSnapshot {
  readonly organizationId: OrganizationId
  readonly palaceId: PalaceId
  readonly at: string
  readonly temperatureCelsius: number
  readonly lightingIntensityPercent: number
  readonly lightingActive: boolean
  readonly lockDesiredState: 'locked' | 'unlocked'
  readonly projectedEnergyUsePercentagePoints: number
  readonly batteryAvailablePercentage: number
}

interface TemperatureTransition {
  readonly startsAt: number
  readonly completesAt: number
  readonly startsAtCelsius: number
  readonly targetCelsius: number
}

function isLockDevice(device: Device): boolean {
  return (
    device.kind === 'lock' ||
    device.kind === 'service_hatch_lock' ||
    device.kind === 'residential_hatch_lock'
  )
}

export type DeviceModelErrorCode =
  | 'CROSS_TENANT_ACCESS'
  | 'DEVICE_KIND_MISMATCH'
  | 'DEVICE_OFFLINE'
  | 'UNKNOWN_DEVICE'
  | 'UNVERIFIED_IDENTITY'
  | 'INVALID_TIME'

export class DeviceModelError extends Error {
  public readonly code: DeviceModelErrorCode

  public constructor(code: DeviceModelErrorCode, message: string) {
    super(message)
    this.name = 'DeviceModelError'
    this.code = code
  }
}

export function deterministicEvidenceId(
  ...parts: readonly string[]
): z.infer<typeof EvidenceIdSchema> {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
  return EvidenceIdSchema.parse(`evd_${digest}`)
}

export class DeterministicDeviceModel {
  readonly #organizationId: OrganizationId
  readonly #palaceId: PalaceId
  readonly #devices: Map<DeviceId, Device>
  readonly #identityTags: Map<string, IdentityTag>
  readonly #startsAtEpochMilliseconds: number
  readonly #batteryAvailablePercentage: number
  readonly #initialTemperatureCelsius: number
  #temperatureTransition: TemperatureTransition | null = null
  #lightingIntensityPercent = 0
  #lightingUntilEpochMilliseconds: number | null = null
  readonly #lockDesiredStates = new Map<DeviceId, 'locked' | 'unlocked'>()
  #projectedEnergyUsePercentagePoints = 0

  public constructor(input: DeviceModelOptions) {
    const options = DeviceModelOptionsSchema.parse(input)
    this.#organizationId = options.organizationId
    this.#palaceId = options.palaceId
    this.#devices = new Map(options.devices.map((device) => [device.id, device]))
    for (const device of options.devices) {
      if (isLockDevice(device)) this.#lockDesiredStates.set(device.id, 'locked')
    }
    this.#identityTags = new Map(options.identityTags.map((tag) => [tag.id, tag]))
    this.#startsAtEpochMilliseconds = Date.parse(options.startsAt)
    this.#batteryAvailablePercentage = options.batteryAvailablePercentage
    this.#initialTemperatureCelsius = options.initialTemperatureCelsius
  }

  public get organizationId(): OrganizationId {
    return this.#organizationId
  }

  public get palaceId(): PalaceId {
    return this.#palaceId
  }

  public device(deviceId: string): Device | undefined {
    return this.#devices.get(DeviceIdSchema.parse(deviceId))
  }

  public setDeviceHealth(deviceId: string, health: Device['health']): void {
    const id = DeviceIdSchema.parse(deviceId)
    const current = this.#devices.get(id)
    if (!current) throw new DeviceModelError('UNKNOWN_DEVICE', 'Device is not part of this palace')
    this.#devices.set(id, DeviceSchema.parse({ ...current, health }))
  }

  public apply(input: DeviceInstruction): readonly Evidence[] {
    const instruction = DeviceInstructionSchema.parse(input)
    const device = this.#authorizedDevice(instruction)
    const at = this.#parseModelTime(instruction.at)

    if (device.health !== 'online') {
      throw new DeviceModelError('DEVICE_OFFLINE', `Device ${device.id} is ${device.health}`)
    }

    switch (instruction.kind) {
      case 'set_temperature': {
        this.#requireDeviceKind(device, 'thermostat')
        const completesAt = this.#parseModelTime(instruction.completeAt)
        if (completesAt < at) {
          throw new DeviceModelError(
            'INVALID_TIME',
            'Temperature completion cannot precede its command',
          )
        }
        const startsAtCelsius = this.#temperatureAt(at)
        this.#temperatureTransition = {
          startsAt: at,
          completesAt,
          startsAtCelsius,
          targetCelsius: instruction.targetCelsius,
        }
        break
      }
      case 'set_lighting':
        this.#requireDeviceKind(device, 'pathway_light')
        this.#lightingIntensityPercent = instruction.intensityPercent
        this.#lightingUntilEpochMilliseconds = at + instruction.durationSeconds * 1_000
        break
      case 'unlock': {
        this.#requireLockDevice(device)
        const tag = this.#identityTags.get(instruction.identityTagId)
        if (!tag?.active || !tag.verified) {
          throw new DeviceModelError(
            'UNVERIFIED_IDENTITY',
            'Unlock requires a currently active, verified identity tag',
          )
        }
        this.#lockDesiredStates.set(device.id, 'unlocked')
        break
      }
      case 'locked_desired_state':
        this.#requireLockDevice(device)
        this.#lockDesiredStates.set(device.id, 'locked')
        break
    }

    return [this.#commandEvidence(instruction)]
  }

  public observeDevice(input: {
    readonly organizationId: string
    readonly missionId: string
    readonly palaceId: string
    readonly deviceId: string
    readonly at: string
  }): Evidence {
    const context = z.object(InstructionContextShape).strict().parse(input)
    const device = this.#authorizedDevice(context)
    const at = this.#parseModelTime(context.at)
    const base = {
      id: deterministicEvidenceId(
        'observation',
        context.organizationId,
        context.missionId,
        context.palaceId,
        device.id,
        context.at,
      ),
      organizationId: this.#organizationId,
      missionId: context.missionId,
      palaceId: this.#palaceId,
      observedAt: context.at,
      deviceId: device.id,
    }

    switch (device.kind) {
      case 'thermostat':
        return EvidenceSchema.parse({
          ...base,
          type: 'temperature_observation',
          celsius: this.#temperatureAt(at),
        })
      case 'pathway_light': {
        const active =
          this.#lightingUntilEpochMilliseconds !== null && at < this.#lightingUntilEpochMilliseconds
        return EvidenceSchema.parse({
          ...base,
          type: 'lighting_observation',
          intensityPercent: active ? this.#lightingIntensityPercent : 0,
          active,
        })
      }
      case 'lock':
      case 'service_hatch_lock':
      case 'residential_hatch_lock':
        return EvidenceSchema.parse({
          ...base,
          type: 'lock_observation',
          desiredState: this.#lockDesiredStates.get(device.id) ?? 'locked',
        })
      case 'battery_meter':
        return EvidenceSchema.parse({
          id: deterministicEvidenceId(
            'battery-observation',
            context.organizationId,
            context.missionId,
            context.palaceId,
            device.id,
            context.at,
          ),
          organizationId: this.#organizationId,
          missionId: context.missionId,
          palaceId: this.#palaceId,
          observedAt: context.at,
          type: 'battery_projection',
          projectedUsePercentagePoints: this.#projectedEnergyUsePercentagePoints,
        })
    }
  }

  public projectEnergy(input: z.input<typeof EnergyProjectionInputSchema>): EnergyProjection {
    const projection = EnergyProjectionInputSchema.parse(input)
    this.#assertTenant(projection.organizationId, projection.palaceId)
    this.#parseModelTime(projection.at)
    this.#projectedEnergyUsePercentagePoints = projection.projectedUsePercentagePoints
    const remaining = this.#batteryAvailablePercentage - projection.projectedUsePercentagePoints
    const evidence = EvidenceSchema.parse({
      id: deterministicEvidenceId(
        'energy-projection',
        projection.organizationId,
        projection.missionId,
        projection.palaceId,
        projection.at,
        projection.projectedUsePercentagePoints.toString(),
      ),
      organizationId: this.#organizationId,
      missionId: projection.missionId,
      palaceId: this.#palaceId,
      observedAt: projection.at,
      type: 'battery_projection',
      projectedUsePercentagePoints: projection.projectedUsePercentagePoints,
    })
    return Object.freeze({
      projectedUsePercentagePoints: projection.projectedUsePercentagePoints,
      maximumPercentagePoints: projection.maximumPercentagePoints,
      batteryAvailablePercentage: this.#batteryAvailablePercentage,
      projectedBatteryRemainingPercentage: remaining,
      withinRoutineBound:
        projection.projectedUsePercentagePoints <= projection.maximumPercentagePoints,
      withinAvailableEnergy: remaining >= 0,
      evidence,
    })
  }

  public tenantAccessEvidence(input: {
    readonly missionId: string
    readonly attemptedOrganizationId: string
    readonly at: string
    readonly allowed: boolean
  }): Evidence {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        attemptedOrganizationId: OrganizationIdSchema,
        at: IsoDateTimeSchema,
        allowed: z.boolean(),
      })
      .strict()
      .parse(input)
    if (parsed.allowed && parsed.attemptedOrganizationId !== this.#organizationId) {
      throw new DeviceModelError(
        'CROSS_TENANT_ACCESS',
        'The deterministic model cannot record an allowed cross-tenant access',
      )
    }
    return TenantAccessAuditEvidenceSchema.parse({
      id: deterministicEvidenceId(
        'tenant-access',
        parsed.missionId,
        parsed.attemptedOrganizationId,
        parsed.at,
        parsed.allowed.toString(),
      ),
      organizationId: this.#organizationId,
      missionId: parsed.missionId,
      palaceId: this.#palaceId,
      observedAt: parsed.at,
      type: 'tenant_access_audit',
      attemptedOrganizationId: parsed.attemptedOrganizationId,
      allowed: parsed.allowed,
      operationId: null,
    })
  }

  public snapshot(at: string): DeviceModelSnapshot {
    const parsedAt = IsoDateTimeSchema.parse(at)
    const atEpochMilliseconds = this.#parseModelTime(parsedAt)
    const lightingActive =
      this.#lightingUntilEpochMilliseconds !== null &&
      atEpochMilliseconds < this.#lightingUntilEpochMilliseconds
    return Object.freeze({
      organizationId: this.#organizationId,
      palaceId: this.#palaceId,
      at: parsedAt,
      temperatureCelsius: this.#temperatureAt(atEpochMilliseconds),
      lightingIntensityPercent: lightingActive ? this.#lightingIntensityPercent : 0,
      lightingActive,
      lockDesiredState:
        [...this.#devices.values()].find((device) => device.kind === 'lock') !== undefined
          ? (this.#lockDesiredStates.get(
              [...this.#devices.values()].find((device) => device.kind === 'lock')!.id,
            ) ?? 'locked')
          : 'locked',
      projectedEnergyUsePercentagePoints: this.#projectedEnergyUsePercentagePoints,
      batteryAvailablePercentage: this.#batteryAvailablePercentage,
    })
  }

  #authorizedDevice(context: {
    readonly organizationId: OrganizationId
    readonly palaceId: PalaceId
    readonly deviceId: DeviceId
  }): Device {
    this.#assertTenant(context.organizationId, context.palaceId)
    const device = this.#devices.get(context.deviceId)
    if (!device) throw new DeviceModelError('UNKNOWN_DEVICE', 'Device is not part of this palace')
    return device
  }

  #assertTenant(organizationId: OrganizationId, palaceId: PalaceId): void {
    if (organizationId !== this.#organizationId || palaceId !== this.#palaceId) {
      throw new DeviceModelError(
        'CROSS_TENANT_ACCESS',
        'Organization and palace must match the host-owned device model',
      )
    }
  }

  #requireDeviceKind(device: Device, expected: Device['kind']): void {
    if (device.kind !== expected) {
      throw new DeviceModelError(
        'DEVICE_KIND_MISMATCH',
        `${device.kind} cannot execute an instruction for ${expected}`,
      )
    }
  }

  #requireLockDevice(device: Device): void {
    if (!isLockDevice(device)) {
      throw new DeviceModelError(
        'DEVICE_KIND_MISMATCH',
        `${device.kind} cannot execute a lock instruction`,
      )
    }
  }

  #parseModelTime(at: string): number {
    const epochMilliseconds = Date.parse(at)
    if (epochMilliseconds < this.#startsAtEpochMilliseconds) {
      throw new DeviceModelError('INVALID_TIME', 'Device model cannot observe before its start')
    }
    return epochMilliseconds
  }

  #temperatureAt(at: number): number {
    const transition = this.#temperatureTransition
    if (!transition || at <= transition.startsAt) {
      return transition?.startsAtCelsius ?? this.#initialTemperatureCelsius
    }
    if (at >= transition.completesAt || transition.completesAt === transition.startsAt) {
      return transition.targetCelsius
    }
    const progress = (at - transition.startsAt) / (transition.completesAt - transition.startsAt)
    const temperature =
      transition.startsAtCelsius +
      (transition.targetCelsius - transition.startsAtCelsius) * progress
    return Math.round(temperature * 1_000) / 1_000
  }

  #commandEvidence(instruction: ParsedDeviceInstruction): Evidence {
    const command =
      instruction.kind === 'locked_desired_state' ? 'locked_desired_state' : instruction.kind
    return DeviceCommandEvidenceSchema.parse({
      id: deterministicEvidenceId(
        'device-command',
        instruction.organizationId,
        instruction.missionId,
        instruction.palaceId,
        instruction.deviceId,
        instruction.kind,
        instruction.at,
        instruction.causedByEvidenceId ?? 'none',
      ),
      organizationId: instruction.organizationId,
      missionId: instruction.missionId,
      palaceId: instruction.palaceId,
      observedAt: instruction.at,
      type: 'device_command',
      deviceId: instruction.deviceId,
      command,
      causedByEvidenceId: instruction.causedByEvidenceId,
    })
  }
}
