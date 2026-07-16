import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  CapabilitySchema,
  CrewMemberSchema,
  CrewPreferenceSchema,
  CrewScheduleSchema,
  DeviceSchema,
  IdentityTagSchema,
  PalaceSchema,
} from './entities.js'
import { EvidenceSchema } from './evidence.js'
import { ExecutionSchema } from './execution-progress.js'
import {
  ApprovalIdSchema,
  AttemptIdSchema,
  EvidenceIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OperationIdSchema,
  PalaceIdSchema,
  PlanActionIdSchema,
  PlanIdSchema,
  ReceiptIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  Sha256Schema,
  ToolCallIdSchema,
} from './identifiers.js'
import { MissionPhaseSchema, MissionStateSchema } from './missions.js'
import { AttemptSchema, OperationSchema } from './operations.js'
import { PlanActionSchema, PlanSchema } from './plans.js'
import { PermissionSchema, type Permission } from './roles.js'
import { RoutineSchema, RoutineStatusSchema, RoutineVersionSchema } from './routines.js'
import { ToolNameSchema, type ToolName } from './tool-names.js'

export const PalacesGetInputSchema = z.object({ palaceId: PalaceIdSchema }).strict()
export const CrewsListInputSchema = z
  .object({ palaceId: PalaceIdSchema, activeOnly: z.boolean().default(true) })
  .strict()
export const CapabilitiesListInputSchema = z.object({ palaceId: PalaceIdSchema }).strict()
export const RoutinesListInputSchema = z
  .object({
    palaceId: PalaceIdSchema,
    statuses: z.array(RoutineStatusSchema).min(1).optional(),
  })
  .strict()
export const RoutinesGetInputSchema = z
  .object({ routineId: RoutineIdSchema, versionId: RoutineVersionIdSchema.optional() })
  .strict()
export const ExecutionsListInputSchema = z
  .object({
    routineId: RoutineIdSchema.optional(),
    missionId: MissionIdSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((input) => input.routineId !== undefined || input.missionId !== undefined, {
    message: 'Execution lookup requires a routine or mission ID',
  })
export const KnowledgeSearchInputSchema = z
  .object({
    query: z.string().min(1).max(500),
    phase: MissionPhaseSchema,
    limit: z.number().int().min(1).max(12).default(6),
  })
  .strict()
export const PlansProposeInputSchema = z
  .object({
    missionId: MissionIdSchema,
    revision: z.number().int().positive(),
    actions: z.array(PlanActionSchema).min(1).max(16),
    successCriteriaIds: z.array(z.string().min(1).max(120)).min(1),
  })
  .strict()
export const PlansValidateInputSchema = z.object({ planId: PlanIdSchema }).strict()
export const PlansSimulateInputSchema = z
  .object({
    planId: PlanIdSchema,
    scenarios: z
      .array(z.enum(['timing', 'access', 'energy', 'transport_failure']))
      .min(1)
      .default(['timing', 'access', 'energy', 'transport_failure']),
  })
  .strict()
export const PlansRequestApprovalInputSchema = z.object({ planId: PlanIdSchema }).strict()
export const PlansActivateInputSchema = z
  .object({
    planId: PlanIdSchema,
    actionId: PlanActionIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict()
export const OperationsGetInputSchema = z.object({ operationId: OperationIdSchema }).strict()
export const VerificationGetEvidenceInputSchema = z.object({ missionId: MissionIdSchema }).strict()
export const MissionsCancelInputSchema = z
  .object({ missionId: MissionIdSchema, reason: z.string().min(1).max(500) })
  .strict()

export const PalacesGetOutputSchema = z.object({ palace: PalaceSchema }).strict()
export const CrewsListOutputSchema = z
  .object({
    crew: z.array(CrewMemberSchema),
    identityTags: z.array(IdentityTagSchema),
    schedules: z.array(CrewScheduleSchema),
    preferences: z.array(CrewPreferenceSchema),
  })
  .strict()
  .superRefine((output, ctx) => {
    const crewIds = new Set(output.crew.map((crewMember) => crewMember.id))
    const organizationIds = new Set(output.crew.map((crewMember) => crewMember.organizationId))
    const palaceIds = new Set(output.crew.map((crewMember) => crewMember.palaceId))
    if (crewIds.size !== output.crew.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['crew'],
        message: 'Crew projection cannot repeat a crew member',
      })
    }
    if (organizationIds.size > 1 || palaceIds.size > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['crew'],
        message: 'Crew projection must cover one tenant and palace',
      })
    }

    const organizationId = output.crew.at(0)?.organizationId
    const palaceId = output.crew.at(0)?.palaceId
    const dependentRecordCount =
      output.identityTags.length + output.schedules.length + output.preferences.length
    if (organizationId === undefined || palaceId === undefined) {
      if (dependentRecordCount > 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'Crew metadata requires its crew member projection',
        })
      }
      return
    }

    output.identityTags.forEach((tag, index) => {
      if (
        tag.organizationId !== organizationId ||
        tag.crewMemberId === null ||
        !crewIds.has(tag.crewMemberId)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['identityTags', index],
          message: 'Identity tag must belong to the projected tenant and crew',
        })
      }
    })
    output.schedules.forEach((schedule, index) => {
      if (
        schedule.organizationId !== organizationId ||
        schedule.palaceId !== palaceId ||
        !crewIds.has(schedule.crewMemberId)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['schedules', index],
          message: 'Crew schedule must belong to the projected tenant, palace, and crew',
        })
      }
    })
    output.preferences.forEach((preference, index) => {
      if (
        preference.organizationId !== organizationId ||
        preference.palaceId !== palaceId ||
        !crewIds.has(preference.crewMemberId)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['preferences', index],
          message: 'Crew preference must belong to the projected tenant, palace, and crew',
        })
      }
    })
  })
export const CapabilitiesListOutputSchema = z
  .object({ devices: z.array(DeviceSchema), capabilities: z.array(CapabilitySchema) })
  .strict()
  .superRefine((output, ctx) => {
    const deviceIds = new Set(output.devices.map((device) => device.id))
    const organizationIds = new Set(output.devices.map((device) => device.organizationId))
    const palaceIds = new Set(output.devices.map((device) => device.palaceId))
    if (deviceIds.size !== output.devices.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['devices'],
        message: 'Capability projection cannot repeat a device',
      })
    }
    if (organizationIds.size > 1 || palaceIds.size > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['devices'],
        message: 'Capability projection must cover one tenant and palace',
      })
    }

    const organizationId = output.devices.at(0)?.organizationId
    if (organizationId === undefined) {
      if (output.capabilities.length > 0) {
        ctx.addIssue({ code: 'custom', message: 'Capabilities require their device projection' })
      }
      return
    }
    output.capabilities.forEach((capability, index) => {
      if (capability.organizationId !== organizationId || !deviceIds.has(capability.deviceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['capabilities', index],
          message: 'Capability must belong to a projected tenant device',
        })
      }
    })
  })
export const RoutinesListOutputSchema = z
  .object({ routines: z.array(RoutineSchema), versions: z.array(RoutineVersionSchema) })
  .strict()
export const RoutinesGetOutputSchema = z
  .object({ routine: RoutineSchema, version: RoutineVersionSchema })
  .strict()
export const ExecutionsListOutputSchema = z
  .object({ executions: z.array(ExecutionSchema) })
  .strict()
export const KnowledgeSearchOutputSchema = z
  .object({
    results: z.array(
      z
        .object({
          sourceId: z.string().min(1).max(200),
          version: z.string().min(1).max(120),
          title: z.string().min(1).max(200),
          excerpt: z.string().min(1).max(2_000),
        })
        .strict(),
    ),
  })
  .strict()
export const PlansProposeOutputSchema = z.object({ plan: PlanSchema }).strict()
export const PlansValidateOutputSchema = z
  .object({
    valid: z.boolean(),
    checks: z.array(
      z
        .object({
          type: z.enum(['schema', 'capability', 'conflict', 'hard_invariant']),
          passed: z.boolean(),
          message: z.string().min(1).max(500),
        })
        .strict(),
    ),
  })
  .strict()
export const PlansSimulateOutputSchema = z
  .object({
    feasible: z.boolean(),
    projectedBatteryUsePercentagePoints: z.number().min(0).max(100),
    results: z.array(
      z
        .object({
          scenario: z.enum(['timing', 'access', 'energy', 'transport_failure']),
          passed: z.boolean(),
          evidence: z.string().min(1).max(500),
        })
        .strict(),
    ),
  })
  .strict()
export const PlansRequestApprovalOutputSchema = z
  .object({ approvalRequestId: ApprovalIdSchema, paused: z.literal(true) })
  .strict()
export const PlansActivateOutputSchema = z
  .object({
    operation: OperationSchema,
    durableRoutineId: RoutineIdSchema.nullable(),
  })
  .strict()
export const OperationsGetOutputSchema = z
  .object({ operation: OperationSchema, attempts: z.array(AttemptSchema) })
  .strict()
export const VerificationGetEvidenceOutputSchema = z
  .object({ evidence: z.array(EvidenceSchema) })
  .strict()
export const MissionsCancelOutputSchema = z
  .object({ missionId: MissionIdSchema, state: MissionStateSchema })
  .strict()

export const ToolResultStatusSchema = z.enum([
  'succeeded',
  'pending',
  'denied',
  'conflict',
  'unknown',
  'failed',
])

export const ToolResultErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    message: z.string().min(1).max(500),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .strict()

export const ToolRiskSchema = z.enum(['read', 'proposal', 'pause', 'consequential', 'control'])

export const ToolHttpRouteSchema = z
  .object({
    method: z.literal('POST'),
    path: z.string().regex(/^\/api\/v1\/tools\/[a-z][a-z_.]+$/),
    authentication: z.literal('session_or_bearer'),
  })
  .strict()

export const ToolMcpAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean(),
    idempotentHint: z.boolean(),
    openWorldHint: z.boolean(),
  })
  .strict()

type ToolContractDefinition<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType<object>,
> = Readonly<{
  permission: Permission
  risk: z.infer<typeof ToolRiskSchema>
  allowedPhases: readonly z.infer<typeof MissionPhaseSchema>[]
  readOnly: boolean
  destructive: boolean
  idempotent: boolean
  openWorld: boolean
  title: string
  description: string
  inputSchema: InputSchema
  outputSchema: OutputSchema
}>

type ToolContract<
  Name extends ToolName,
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType<object>,
> = Readonly<
  ToolContractDefinition<InputSchema, OutputSchema> & {
    name: Name
    route: Readonly<{
      method: 'POST'
      path: `/api/v1/tools/${Name}`
      authentication: 'session_or_bearer'
    }>
    mcp: Readonly<{
      title: string
      description: string
      annotations: Readonly<{
        readOnlyHint: boolean
        destructiveHint: boolean
        idempotentHint: boolean
        openWorldHint: boolean
      }>
    }>
  }
>

function contract<
  const Name extends ToolName,
  const InputSchema extends z.ZodType,
  const OutputSchema extends z.ZodType<object>,
>(
  name: Name,
  input: ToolContractDefinition<InputSchema, OutputSchema>,
): ToolContract<Name, InputSchema, OutputSchema> {
  PermissionSchema.parse(input.permission)
  ToolRiskSchema.parse(input.risk)
  const route = ToolHttpRouteSchema.parse({
    method: 'POST',
    path: `/api/v1/tools/${name}`,
    authentication: 'session_or_bearer',
  })
  const annotations = ToolMcpAnnotationsSchema.parse({
    readOnlyHint: input.readOnly,
    destructiveHint: input.destructive,
    idempotentHint: input.idempotent,
    openWorldHint: input.openWorld,
  })

  return {
    ...input,
    name,
    route: {
      method: route.method,
      path: `/api/v1/tools/${name}`,
      authentication: route.authentication,
    },
    mcp: {
      title: input.title,
      description: input.description,
      annotations,
    },
  }
}

export const TOOL_REGISTRY = {
  'palaces.get': contract('palaces.get', {
    permission: 'palace:read',
    risk: 'read',
    allowedPhases: ['understand', 'plan', 'validate'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'Get palace',
    description: 'Read one palace configuration and current state.',
    inputSchema: PalacesGetInputSchema,
    outputSchema: PalacesGetOutputSchema,
  }),
  'crews.list': contract('crews.list', {
    permission: 'crew:read',
    risk: 'read',
    allowedPhases: ['understand', 'plan', 'validate'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'List crew',
    description: 'Read authorized crew, identity tags, schedules, and preferences.',
    inputSchema: CrewsListInputSchema,
    outputSchema: CrewsListOutputSchema,
  }),
  'capabilities.list': contract('capabilities.list', {
    permission: 'capability:read',
    risk: 'read',
    allowedPhases: ['understand', 'plan', 'validate'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'List capabilities',
    description: 'Read available device capabilities, constraints, and health.',
    inputSchema: CapabilitiesListInputSchema,
    outputSchema: CapabilitiesListOutputSchema,
  }),
  'routines.list': contract('routines.list', {
    permission: 'routine:read',
    risk: 'read',
    allowedPhases: ['understand', 'plan', 'validate', 'reconcile', 'verify'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'List routines',
    description: 'Read routines and their versioned definitions.',
    inputSchema: RoutinesListInputSchema,
    outputSchema: RoutinesListOutputSchema,
  }),
  'routines.get': contract('routines.get', {
    permission: 'routine:read',
    risk: 'read',
    allowedPhases: ['understand', 'plan', 'validate', 'reconcile', 'verify'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'Get routine',
    description: 'Read one routine and an exact version.',
    inputSchema: RoutinesGetInputSchema,
    outputSchema: RoutinesGetOutputSchema,
  }),
  'executions.list': contract('executions.list', {
    permission: 'routine:read',
    risk: 'read',
    allowedPhases: ['understand', 'observe', 'verify'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'List executions',
    description: 'Read execution history and outcomes for a mission or routine.',
    inputSchema: ExecutionsListInputSchema,
    outputSchema: ExecutionsListOutputSchema,
  }),
  'knowledge.search': contract('knowledge.search', {
    permission: 'knowledge:read',
    risk: 'read',
    allowedPhases: ['understand', 'plan', 'validate', 'reconcile', 'verify'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'Search knowledge',
    description: 'Search cited, versioned, permission-filtered product knowledge.',
    inputSchema: KnowledgeSearchInputSchema,
    outputSchema: KnowledgeSearchOutputSchema,
  }),
  'plans.propose': contract('plans.propose', {
    permission: 'routine:draft',
    risk: 'proposal',
    allowedPhases: ['plan'],
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'Propose plan',
    description: 'Persist an immutable candidate plan revision.',
    inputSchema: PlansProposeInputSchema,
    outputSchema: PlansProposeOutputSchema,
  }),
  'plans.validate': contract('plans.validate', {
    permission: 'routine:validate',
    risk: 'proposal',
    allowedPhases: ['validate'],
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'Validate plan',
    description: 'Apply schema, capability, conflict, and hard-invariant checks.',
    inputSchema: PlansValidateInputSchema,
    outputSchema: PlansValidateOutputSchema,
  }),
  'plans.simulate': contract('plans.simulate', {
    permission: 'routine:simulate',
    risk: 'proposal',
    allowedPhases: ['validate'],
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    title: 'Simulate plan',
    description: 'Simulate timing, access, energy, and transport-failure scenarios.',
    inputSchema: PlansSimulateInputSchema,
    outputSchema: PlansSimulateOutputSchema,
  }),
  'plans.request_approval': contract('plans.request_approval', {
    permission: 'routine:draft',
    risk: 'pause',
    allowedPhases: ['validate'],
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    title: 'Request plan approval',
    description: 'Create a pending human approval request and pause the mission.',
    inputSchema: PlansRequestApprovalInputSchema,
    outputSchema: PlansRequestApprovalOutputSchema,
  }),
  'plans.activate': contract('plans.activate', {
    permission: 'routine:activate',
    risk: 'consequential',
    allowedPhases: ['execute'],
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    title: 'Activate plan action',
    description: 'Execute one server-created action covered by an exact approval.',
    inputSchema: PlansActivateInputSchema,
    outputSchema: PlansActivateOutputSchema,
  }),
  'operations.get': contract('operations.get', {
    permission: 'operation:reconcile',
    risk: 'read',
    allowedPhases: ['execute', 'reconcile'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'Get operation',
    description: 'Read one logical operation and its delivery attempts.',
    inputSchema: OperationsGetInputSchema,
    outputSchema: OperationsGetOutputSchema,
  }),
  'verification.get_evidence': contract('verification.get_evidence', {
    permission: 'verification:read',
    risk: 'read',
    allowedPhases: ['observe', 'verify'],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    title: 'Get verification evidence',
    description: 'Read normalized evidence used by deterministic verification.',
    inputSchema: VerificationGetEvidenceInputSchema,
    outputSchema: VerificationGetEvidenceOutputSchema,
  }),
  'missions.cancel': contract('missions.cancel', {
    permission: 'mission:cancel',
    risk: 'control',
    allowedPhases: [
      'understand',
      'plan',
      'validate',
      'approve',
      'execute',
      'reconcile',
      'observe',
      'verify',
    ],
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: false,
    title: 'Cancel mission',
    description: 'Request checkpoint-aware cancellation for one mission.',
    inputSchema: MissionsCancelInputSchema,
    outputSchema: MissionsCancelOutputSchema,
  }),
} as const satisfies {
  [Name in ToolName]: ToolContract<Name, z.ZodType, z.ZodType<object>>
}

function createToolResultSchema<
  const Name extends ToolName,
  const OutputSchema extends z.ZodType<object>,
>(name: Name, outputSchema: OutputSchema) {
  const baseShape = {
    schemaVersion: z.literal('tool-result@1'),
    toolName: z.literal(name),
    callId: ToolCallIdSchema,
    retryable: z.boolean(),
    receiptId: ReceiptIdSchema,
    resourceVersion: z.number().int().nonnegative().nullable(),
  }

  return z.discriminatedUnion('status', [
    z
      .object({
        ...baseShape,
        status: z.literal('succeeded'),
        data: outputSchema,
        error: z.null(),
      })
      .strict(),
    z
      .object({
        ...baseShape,
        status: z.literal('pending'),
        data: outputSchema.nullable(),
        error: ToolResultErrorSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...baseShape,
        status: z.literal('unknown'),
        data: outputSchema.nullable(),
        error: ToolResultErrorSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...baseShape,
        status: z.literal('denied'),
        data: z.null(),
        error: ToolResultErrorSchema,
      })
      .strict(),
    z
      .object({
        ...baseShape,
        status: z.literal('conflict'),
        data: z.null(),
        error: ToolResultErrorSchema,
      })
      .strict(),
    z
      .object({
        ...baseShape,
        status: z.literal('failed'),
        data: z.null(),
        error: ToolResultErrorSchema,
      })
      .strict(),
  ])
}

export const TOOL_RESULT_SCHEMAS = {
  'palaces.get': createToolResultSchema('palaces.get', TOOL_REGISTRY['palaces.get'].outputSchema),
  'crews.list': createToolResultSchema('crews.list', TOOL_REGISTRY['crews.list'].outputSchema),
  'capabilities.list': createToolResultSchema(
    'capabilities.list',
    TOOL_REGISTRY['capabilities.list'].outputSchema,
  ),
  'routines.list': createToolResultSchema(
    'routines.list',
    TOOL_REGISTRY['routines.list'].outputSchema,
  ),
  'routines.get': createToolResultSchema(
    'routines.get',
    TOOL_REGISTRY['routines.get'].outputSchema,
  ),
  'executions.list': createToolResultSchema(
    'executions.list',
    TOOL_REGISTRY['executions.list'].outputSchema,
  ),
  'knowledge.search': createToolResultSchema(
    'knowledge.search',
    TOOL_REGISTRY['knowledge.search'].outputSchema,
  ),
  'plans.propose': createToolResultSchema(
    'plans.propose',
    TOOL_REGISTRY['plans.propose'].outputSchema,
  ),
  'plans.validate': createToolResultSchema(
    'plans.validate',
    TOOL_REGISTRY['plans.validate'].outputSchema,
  ),
  'plans.simulate': createToolResultSchema(
    'plans.simulate',
    TOOL_REGISTRY['plans.simulate'].outputSchema,
  ),
  'plans.request_approval': createToolResultSchema(
    'plans.request_approval',
    TOOL_REGISTRY['plans.request_approval'].outputSchema,
  ),
  'plans.activate': createToolResultSchema(
    'plans.activate',
    TOOL_REGISTRY['plans.activate'].outputSchema,
  ),
  'operations.get': createToolResultSchema(
    'operations.get',
    TOOL_REGISTRY['operations.get'].outputSchema,
  ),
  'verification.get_evidence': createToolResultSchema(
    'verification.get_evidence',
    TOOL_REGISTRY['verification.get_evidence'].outputSchema,
  ),
  'missions.cancel': createToolResultSchema(
    'missions.cancel',
    TOOL_REGISTRY['missions.cancel'].outputSchema,
  ),
} as const satisfies Record<ToolName, z.ZodType>

export const ToolResultEnvelopeSchema = z.union([
  TOOL_RESULT_SCHEMAS['palaces.get'],
  TOOL_RESULT_SCHEMAS['crews.list'],
  TOOL_RESULT_SCHEMAS['capabilities.list'],
  TOOL_RESULT_SCHEMAS['routines.list'],
  TOOL_RESULT_SCHEMAS['routines.get'],
  TOOL_RESULT_SCHEMAS['executions.list'],
  TOOL_RESULT_SCHEMAS['knowledge.search'],
  TOOL_RESULT_SCHEMAS['plans.propose'],
  TOOL_RESULT_SCHEMAS['plans.validate'],
  TOOL_RESULT_SCHEMAS['plans.simulate'],
  TOOL_RESULT_SCHEMAS['plans.request_approval'],
  TOOL_RESULT_SCHEMAS['plans.activate'],
  TOOL_RESULT_SCHEMAS['operations.get'],
  TOOL_RESULT_SCHEMAS['verification.get_evidence'],
  TOOL_RESULT_SCHEMAS['missions.cancel'],
])

type RegisteredToolContract<Name extends ToolName> = (typeof TOOL_REGISTRY)[Name]

export type ToolInputPayload<Name extends ToolName> = Name extends ToolName
  ? z.input<RegisteredToolContract<Name>['inputSchema']>
  : never
export type ToolInput<Name extends ToolName> = Name extends ToolName
  ? z.output<RegisteredToolContract<Name>['inputSchema']>
  : never
export type ToolOutput<Name extends ToolName> = Name extends ToolName
  ? z.output<RegisteredToolContract<Name>['outputSchema']>
  : never
export type ToolResult<Name extends ToolName> = Name extends ToolName
  ? z.output<(typeof TOOL_RESULT_SCHEMAS)[Name]>
  : never

export function parseToolInput<Name extends ToolName>(name: Name, input: unknown): ToolInput<Name>
export function parseToolInput(name: ToolName, input: unknown): ToolInput<ToolName> {
  return TOOL_REGISTRY[name].inputSchema.parse(input)
}

export function parseToolOutput<Name extends ToolName>(
  name: Name,
  output: unknown,
): ToolOutput<Name>
export function parseToolOutput(name: ToolName, output: unknown): ToolOutput<ToolName> {
  return TOOL_REGISTRY[name].outputSchema.parse(output)
}

export function parseToolResult<Name extends ToolName>(
  name: Name,
  result: unknown,
): ToolResult<Name>
export function parseToolResult(name: ToolName, result: unknown): ToolResult<ToolName> {
  return TOOL_RESULT_SCHEMAS[name].parse(result)
}

export function projectToolResultSchema(name: ToolName): z.infer<ReturnType<typeof z.json>> {
  return z.json().parse(z.toJSONSchema(TOOL_RESULT_SCHEMAS[name]))
}

export function hashToolResultSchema(name: ToolName): z.infer<typeof Sha256Schema> {
  return hashToolValue(projectToolResultSchema(name))
}

export const ToolSchemaProjectionSchema = z
  .object({
    schemaVersion: z.literal('tool-contract@1'),
    name: ToolNameSchema,
    permission: PermissionSchema,
    risk: ToolRiskSchema,
    allowedPhases: z.array(MissionPhaseSchema).min(1),
    readOnly: z.boolean(),
    route: ToolHttpRouteSchema,
    mcp: z
      .object({
        title: z.string().min(1).max(120),
        description: z.string().min(1).max(500),
        annotations: ToolMcpAnnotationsSchema,
      })
      .strict(),
    inputSchema: z.json(),
    inputSchemaHash: Sha256Schema,
    outputSchema: z.json(),
    outputSchemaHash: Sha256Schema,
    contractHash: Sha256Schema,
  })
  .strict()

const ToolSchemaProjectionPayloadSchema = ToolSchemaProjectionSchema.omit({ contractHash: true })

function canonicalToolJson(value: z.infer<ReturnType<typeof z.json>>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalToolJson(entry)).join(',')}]`

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalToolJson(entry)}`)
    .join(',')}}`
}

export function hashToolValue(value: unknown): z.infer<typeof Sha256Schema> {
  const parsed = z.json().parse(value)
  return Sha256Schema.parse(createHash('sha256').update(canonicalToolJson(parsed)).digest('hex'))
}

export function projectToolSchema(name: ToolName): z.infer<typeof ToolSchemaProjectionSchema> {
  const selected = TOOL_REGISTRY[name]
  const inputSchema = z.json().parse(z.toJSONSchema(selected.inputSchema))
  const outputSchema = z.json().parse(z.toJSONSchema(selected.outputSchema))
  const payload = ToolSchemaProjectionPayloadSchema.parse({
    schemaVersion: 'tool-contract@1',
    name,
    permission: selected.permission,
    risk: selected.risk,
    allowedPhases: [...selected.allowedPhases],
    readOnly: selected.readOnly,
    route: selected.route,
    mcp: selected.mcp,
    inputSchema,
    inputSchemaHash: hashToolValue(inputSchema),
    outputSchema,
    outputSchemaHash: hashToolValue(outputSchema),
  })

  return ToolSchemaProjectionSchema.parse({
    ...payload,
    contractHash: hashToolValue(payload),
  })
}

export function projectToolRegistry(): z.infer<typeof ToolSchemaProjectionSchema>[] {
  return [...ToolNameSchema.options]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => projectToolSchema(name))
}

export const TOOL_SCHEMA_PROJECTIONS = projectToolRegistry()
export const TOOL_REGISTRY_HASH = hashToolValue(TOOL_SCHEMA_PROJECTIONS)

export const ToolCallChannelSchema = z.enum(['in_process', 'http', 'mcp'])
export const ToolTenantScopeHashSchema = Sha256Schema.describe(
  'A keyed tenant pseudonym. Never hash a raw tenant identifier without a server-side secret.',
)

export const ToolCallReceiptSchema = z
  .object({
    schemaVersion: z.literal('tool-call-receipt@1'),
    id: ReceiptIdSchema,
    callId: ToolCallIdSchema,
    toolName: ToolNameSchema,
    status: ToolResultStatusSchema,
    channel: ToolCallChannelSchema,
    tenantScopeHash: ToolTenantScopeHashSchema,
    inputHash: Sha256Schema,
    resultHash: Sha256Schema,
    toolContractHash: Sha256Schema,
    toolRegistryHash: Sha256Schema,
    attemptId: AttemptIdSchema.nullable(),
    evidenceIds: z.array(EvidenceIdSchema),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (new Set(receipt.evidenceIds).size !== receipt.evidenceIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceIds'],
        message: 'Tool receipt evidence references must be unique',
      })
    }
    if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Tool receipt cannot complete before it starts',
      })
    }
  })

export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>
export type ToolResultError = z.infer<typeof ToolResultErrorSchema>
export type ToolResultEnvelope = z.infer<typeof ToolResultEnvelopeSchema>
export type ToolSchemaProjection = z.infer<typeof ToolSchemaProjectionSchema>
export type ToolCallChannel = z.infer<typeof ToolCallChannelSchema>
export type ToolTenantScopeHash = z.infer<typeof ToolTenantScopeHashSchema>
export type ToolCallReceipt = z.infer<typeof ToolCallReceiptSchema>
