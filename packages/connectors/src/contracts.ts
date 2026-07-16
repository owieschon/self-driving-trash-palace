import { createHash } from 'node:crypto'

import { z } from 'zod'

export const TenantIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)

export const LogicalSlotIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)

// This mirrors the core gateway identifier at the connector boundary without
// coupling the provider adapter back to the domain package.
export const GatewayCommandIdSchema = z
  .string()
  .regex(/^gcmd_[a-z0-9][a-z0-9_-]{7,63}$/, 'Expected a gcmd_ identifier')

export const ConnectorChildCommandIdSchema = z
  .string()
  .regex(/^ccmd_[a-f0-9]{64}$/, 'Expected a derived connector child command identifier')

export const ConnectorCommandIdSchema = z.union([
  GatewayCommandIdSchema,
  ConnectorChildCommandIdSchema,
])

export const DiscoveryCandidateIdSchema = z
  .string()
  .regex(/^stcand_[a-f0-9]{64}$/, 'Expected an opaque SmartThings candidate identifier')

export const DeviceKindSchema = z.enum(['light', 'lock', 'thermostat'])

export const ConnectorCapabilitySchema = z.enum([
  'light.power',
  'light.brightness',
  'lock.state',
  'thermostat.temperature',
  'thermostat.mode',
  'thermostat.heatingSetpoint',
  'thermostat.coolingSetpoint',
])

export const ThermostatModeSchema = z.enum(['off', 'heat', 'cool', 'auto', 'emergency_heat'])

export const LogicalDeviceSchema = z
  .object({
    slotId: LogicalSlotIdSchema,
    displayName: z.string().min(1).max(80),
    kind: DeviceKindSchema,
    capabilities: z.array(ConnectorCapabilitySchema).min(1).max(7),
  })
  .strict()
  .superRefine((device, context) => {
    if (new Set(device.capabilities).size !== device.capabilities.length) {
      context.addIssue({ code: 'custom', message: 'capabilities must be unique' })
    }
    const correctKind = device.capabilities.every((capability) => {
      switch (device.kind) {
        case 'light':
          return capability.startsWith('light.')
        case 'lock':
          return capability === 'lock.state'
        case 'thermostat':
          return capability.startsWith('thermostat.')
      }
    })
    if (!correctKind) {
      context.addIssue({ code: 'custom', message: 'capability does not match device kind' })
    }
  })

export const DiscoveryCandidateSchema = z
  .object({
    candidateId: DiscoveryCandidateIdSchema,
    capabilities: z.array(ConnectorCapabilitySchema).min(1).max(7),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (new Set(candidate.capabilities).size !== candidate.capabilities.length) {
      context.addIssue({ code: 'custom', message: 'capabilities must be unique' })
    }
  })

export const ExplicitDeviceMappingInputSchema = z
  .object({
    tenantId: TenantIdSchema,
    candidateId: DiscoveryCandidateIdSchema,
    slotId: LogicalSlotIdSchema,
    confirmedBy: z.literal('human'),
  })
  .strict()

const TemperatureValueSchema = z
  .object({
    value: z.number(),
    unit: z.enum(['C', 'F']),
  })
  .strict()

export const LogicalDeviceStateSchema = z
  .object({
    slotId: LogicalSlotIdSchema,
    observedAt: z.iso.datetime(),
    source: z.enum(['provider_read', 'webhook_then_provider_read']),
    power: z.enum(['on', 'off']).optional(),
    brightness: z.number().int().min(0).max(100).optional(),
    lock: z.enum(['locked', 'unlocked', 'jammed', 'unknown']).optional(),
    temperature: TemperatureValueSchema.optional(),
    thermostatMode: ThermostatModeSchema.optional(),
    heatingSetpoint: TemperatureValueSchema.optional(),
    coolingSetpoint: TemperatureValueSchema.optional(),
  })
  .strict()

const CommandBaseShape = {
  tenantId: TenantIdSchema,
  commandId: ConnectorCommandIdSchema,
  slotId: LogicalSlotIdSchema,
} as const

const DirectCommandBaseShape = {
  ...CommandBaseShape,
  commandId: GatewayCommandIdSchema,
} as const

export const LightingStepKeySchema = z.enum(['power_on', 'set_brightness', 'scheduled_power_off'])

function lightingChildCommandId(parentCommandId: string, step: string): string {
  const preimage = `smartthings-lighting-child@1\n${parentCommandId.length}:${parentCommandId}\n${step.length}:${step}`
  return `ccmd_${createHash('sha256').update(preimage).digest('hex')}`
}

export function deriveLightingChildCommandId(
  parentCommandId: z.infer<typeof GatewayCommandIdSchema>,
  step: z.infer<typeof LightingStepKeySchema>,
): z.infer<typeof ConnectorChildCommandIdSchema> {
  return ConnectorChildCommandIdSchema.parse(
    lightingChildCommandId(
      GatewayCommandIdSchema.parse(parentCommandId),
      LightingStepKeySchema.parse(step),
    ),
  )
}

const LightingChildBaseShape = {
  ...CommandBaseShape,
  commandId: ConnectorChildCommandIdSchema,
  parentCommandId: GatewayCommandIdSchema,
  notBefore: z.iso.datetime(),
} as const

const LightPowerOnCommandSchema = z
  .object({
    ...LightingChildBaseShape,
    action: z.literal('light.setPower'),
    lightingStep: z.literal('power_on'),
    power: z.literal('on'),
  })
  .strict()

const LightBrightnessCommandSchema = z
  .object({
    ...LightingChildBaseShape,
    action: z.literal('light.setBrightness'),
    lightingStep: z.literal('set_brightness'),
    brightness: z.number().int().min(1).max(100),
  })
  .strict()

const LightPowerOffCommandSchema = z
  .object({
    ...LightingChildBaseShape,
    action: z.literal('light.setPower'),
    lightingStep: z.literal('scheduled_power_off'),
    power: z.literal('off'),
  })
  .strict()

const LockCommandSchema = z
  .object({
    ...DirectCommandBaseShape,
    action: z.literal('lock.lock'),
  })
  .strict()

const UnlockCommandSchema = z
  .object({
    ...DirectCommandBaseShape,
    action: z.literal('lock.unlock'),
    confirmationId: z
      .string()
      .min(16)
      .max(160)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict()

const CelsiusHeatingCommandSchema = z
  .object({
    ...DirectCommandBaseShape,
    action: z.literal('thermostat.setHeatingSetpoint'),
    value: z.number().min(10).max(30),
    unit: z.literal('C'),
  })
  .strict()

const FahrenheitHeatingCommandSchema = z
  .object({
    ...DirectCommandBaseShape,
    action: z.literal('thermostat.setHeatingSetpoint'),
    value: z.number().min(50).max(86),
    unit: z.literal('F'),
  })
  .strict()

const CelsiusCoolingCommandSchema = z
  .object({
    ...DirectCommandBaseShape,
    action: z.literal('thermostat.setCoolingSetpoint'),
    value: z.number().min(10).max(30),
    unit: z.literal('C'),
  })
  .strict()

const FahrenheitCoolingCommandSchema = z
  .object({
    ...DirectCommandBaseShape,
    action: z.literal('thermostat.setCoolingSetpoint'),
    value: z.number().min(50).max(86),
    unit: z.literal('F'),
  })
  .strict()

const DeviceCommandStructuralSchema = z.union([
  LightPowerOnCommandSchema,
  LightBrightnessCommandSchema,
  LightPowerOffCommandSchema,
  LockCommandSchema,
  UnlockCommandSchema,
  CelsiusHeatingCommandSchema,
  FahrenheitHeatingCommandSchema,
  CelsiusCoolingCommandSchema,
  FahrenheitCoolingCommandSchema,
])

export const DeviceCommandSchema = DeviceCommandStructuralSchema.superRefine((command, context) => {
  if ('lightingStep' in command) {
    const expected = deriveLightingChildCommandId(command.parentCommandId, command.lightingStep)
    if (command.commandId !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['commandId'],
        message: 'Lighting child command ID must derive from the parent gateway command ID',
      })
    }
  }
})

const PersistedUnlockCommandSchema = z
  .object({
    ...DirectCommandBaseShape,
    action: z.literal('lock.unlock'),
  })
  .strict()

export const PersistedDeviceCommandSchema = z
  .union([
    LightPowerOnCommandSchema,
    LightBrightnessCommandSchema,
    LightPowerOffCommandSchema,
    LockCommandSchema,
    PersistedUnlockCommandSchema,
    CelsiusHeatingCommandSchema,
    FahrenheitHeatingCommandSchema,
    CelsiusCoolingCommandSchema,
    FahrenheitCoolingCommandSchema,
  ])
  .superRefine((command, context) => {
    if (
      'lightingStep' in command &&
      command.commandId !==
        deriveLightingChildCommandId(command.parentCommandId, command.lightingStep)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['commandId'],
        message: 'Persisted lighting child ID must derive from the parent gateway command ID',
      })
    }
  })

export const LightingPlanRequestSchema = z
  .object({
    tenantId: TenantIdSchema,
    parentCommandId: GatewayCommandIdSchema,
    slotId: LogicalSlotIdSchema,
    brightness: z.number().int().min(1).max(100),
    durationSeconds: z.number().int().positive().max(86_400),
    startsAt: z.iso.datetime(),
  })
  .strict()

export const LightingPlanSchema = z
  .object({
    tenantId: TenantIdSchema,
    parentCommandId: GatewayCommandIdSchema,
    slotId: LogicalSlotIdSchema,
    steps: z.tuple([
      LightPowerOnCommandSchema,
      LightBrightnessCommandSchema,
      LightPowerOffCommandSchema,
    ]),
  })
  .strict()
  .superRefine((plan, context) => {
    const expectedKeys = ['power_on', 'set_brightness', 'scheduled_power_off'] as const
    for (const [index, step] of plan.steps.entries()) {
      if (
        step.tenantId !== plan.tenantId ||
        step.parentCommandId !== plan.parentCommandId ||
        step.slotId !== plan.slotId ||
        step.lightingStep !== expectedKeys[index] ||
        step.commandId !== deriveLightingChildCommandId(plan.parentCommandId, step.lightingStep)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index],
          message: 'Lighting steps must be complete, ordered, and bound to one parent command',
        })
      }
    }
    if (
      plan.steps[0].notBefore !== plan.steps[1].notBefore ||
      Date.parse(plan.steps[2].notBefore) <= Date.parse(plan.steps[1].notBefore)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'Scheduled power-off must occur after the immediate lighting steps',
      })
    }
  })

export function createLightingPlan(
  input: z.input<typeof LightingPlanRequestSchema>,
): z.infer<typeof LightingPlanSchema> {
  const request = LightingPlanRequestSchema.parse(input)
  const startsAt = new Date(request.startsAt).toISOString()
  const offAt = new Date(Date.parse(startsAt) + request.durationSeconds * 1000).toISOString()
  return LightingPlanSchema.parse({
    tenantId: request.tenantId,
    parentCommandId: request.parentCommandId,
    slotId: request.slotId,
    steps: [
      {
        tenantId: request.tenantId,
        commandId: deriveLightingChildCommandId(request.parentCommandId, 'power_on'),
        parentCommandId: request.parentCommandId,
        slotId: request.slotId,
        action: 'light.setPower',
        lightingStep: 'power_on',
        power: 'on',
        notBefore: startsAt,
      },
      {
        tenantId: request.tenantId,
        commandId: deriveLightingChildCommandId(request.parentCommandId, 'set_brightness'),
        parentCommandId: request.parentCommandId,
        slotId: request.slotId,
        action: 'light.setBrightness',
        lightingStep: 'set_brightness',
        brightness: request.brightness,
        notBefore: startsAt,
      },
      {
        tenantId: request.tenantId,
        commandId: deriveLightingChildCommandId(request.parentCommandId, 'scheduled_power_off'),
        parentCommandId: request.parentCommandId,
        slotId: request.slotId,
        action: 'light.setPower',
        lightingStep: 'scheduled_power_off',
        power: 'off',
        notBefore: offAt,
      },
    ],
  })
}

const CommandReceiptBaseSchema = z
  .object({
    commandId: ConnectorCommandIdSchema,
    slotId: LogicalSlotIdSchema,
  })
  .strict()

export const CommandReceiptSchema = z.discriminatedUnion('status', [
  CommandReceiptBaseSchema.extend({
    status: z.literal('accepted_non_terminal'),
    reconciliationRequired: z.literal(true),
  }).strict(),
  CommandReceiptBaseSchema.extend({
    status: z.literal('outcome_unknown'),
    reconciliationRequired: z.literal(true),
  }).strict(),
  CommandReceiptBaseSchema.extend({
    status: z.literal('verified'),
    reconciliationRequired: z.literal(false),
  }).strict(),
])

export const OAuthConnectionResultSchema = z
  .object({
    provider: z.literal('smartthings'),
    status: z.literal('connected'),
    scopes: z
      .object({
        deviceRead: z.literal(true),
        deviceExecute: z.literal(true),
      })
      .strict(),
    expiresAt: z.iso.datetime(),
  })
  .strict()

export const WebhookResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duplicate') }).strict(),
  z.object({ kind: z.literal('disconnected') }).strict(),
  z
    .object({
      kind: z.literal('device_updates'),
      states: z.array(LogicalDeviceStateSchema),
      verifiedCommandIds: z.array(ConnectorCommandIdSchema),
    })
    .strict(),
])

export type ConnectorCapability = z.infer<typeof ConnectorCapabilitySchema>
export type ConnectorCommandId = z.infer<typeof ConnectorCommandIdSchema>
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>
export type DeviceKind = z.infer<typeof DeviceKindSchema>
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>
export type ExplicitDeviceMappingInput = z.infer<typeof ExplicitDeviceMappingInputSchema>
export type LightingPlan = z.infer<typeof LightingPlanSchema>
export type LightingPlanRequest = z.infer<typeof LightingPlanRequestSchema>
export type LogicalDevice = z.infer<typeof LogicalDeviceSchema>
export type LogicalDeviceState = z.infer<typeof LogicalDeviceStateSchema>
export type OAuthConnectionResult = z.infer<typeof OAuthConnectionResultSchema>
export type PersistedDeviceCommand = z.infer<typeof PersistedDeviceCommandSchema>
export type WebhookResult = z.infer<typeof WebhookResultSchema>

export interface DeviceConnectorPort {
  discoverDevices(tenantId: string): Promise<readonly DiscoveryCandidate[]>
  mapDiscoveredDevice(input: ExplicitDeviceMappingInput): Promise<LogicalDevice>
  scheduleLighting(input: LightingPlanRequest): Promise<LightingPlan>
  readDeviceState(input: {
    readonly tenantId: string
    readonly slotId: string
  }): Promise<LogicalDeviceState>
  dispatchCommand(command: DeviceCommand): Promise<CommandReceipt>
  reconcileCommand(input: {
    readonly tenantId: string
    readonly commandId: string
  }): Promise<CommandReceipt>
}
