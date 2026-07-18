import {
  ApprovalSchema,
  ApprovalIdSchema,
  ClarificationChoiceIdSchema,
  ClarificationChoiceSchema,
  ClarificationRequestIdSchema,
  DelegatedPermissionSchema,
  EvidenceIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  MissionConstraintSchema,
  MissionProgramKindSchema,
  MissionStateSchema,
  OperationIdSchema,
  OperationSchema,
  OrganizationIdSchema,
  PlanIdSchema,
  PlanSchema,
  PalaceIdSchema,
  ProductRoleSchema,
  RoutineIdSchema,
  ToolNameSchema,
  UserIdSchema,
  VerificationIdSchema,
} from '@trash-palace/core'
import { z } from 'zod'

export const WEB_API_ROUTES = {
  health: { method: 'GET', path: '/api/v1/health' },
  readiness: { method: 'GET', path: '/api/v1/ready' },
  devSession: { method: 'POST', path: '/api/v1/auth/dev-session' },
  rotateSession: { method: 'POST', path: '/api/v1/auth/session/rotate' },
  logoutSession: { method: 'POST', path: '/api/v1/auth/session/logout' },
  issueDelegatedToken: { method: 'POST', path: '/api/v1/auth/delegated-tokens' },
  createMission: { method: 'POST', path: '/api/v1/missions' },
  getMissionTasks: {
    method: 'GET',
    path: (missionId: string) => `/api/v1/missions/${encodeURIComponent(missionId)}/tasks`,
  },
  getMissionProgress: {
    method: 'GET',
    path: (missionId: string) => `/api/v1/missions/${encodeURIComponent(missionId)}/progress`,
  },
  getPalaceWorkspace: {
    method: 'GET',
    path: (palaceId: string) => `/api/v1/palaces/${encodeURIComponent(palaceId)}/workspace`,
  },
  revokeDelegatedToken: {
    method: 'DELETE',
    path: (tokenId: string) => `/api/v1/auth/delegated-tokens/${encodeURIComponent(tokenId)}`,
  },
  decideApproval: {
    method: 'POST',
    path: (approvalId: string) => `/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
  },
  getApproval: {
    method: 'GET',
    path: (approvalId: string) => `/api/v1/approvals/${encodeURIComponent(approvalId)}`,
  },
  getClarification: {
    method: 'GET',
    path: (requestId: string) => `/api/v1/clarifications/${encodeURIComponent(requestId)}`,
  },
  answerClarification: {
    method: 'POST',
    path: (requestId: string) => `/api/v1/clarifications/${encodeURIComponent(requestId)}/answer`,
  },
  tool: {
    method: 'POST',
    path: (toolName: string) => `/api/v1/tools/${encodeURIComponent(toolName)}`,
  },
} as const

export const EmptyJsonObjectSchema = z.object({}).strict()
export const HealthResponseSchema = z
  .object({ schemaVersion: z.literal('health@1'), status: z.literal('ok') })
  .strict()
export const ReadinessResponseSchema = z
  .object({
    schemaVersion: z.literal('readiness@1'),
    status: z.enum(['ready', 'unavailable']),
  })
  .strict()
export const DelegatedTokenIdSchema = z.string().regex(/^tok_[a-z0-9][a-z0-9_-]{7,63}$/)

export const IssueDelegatedTokenBodySchema = z
  .object({
    scopes: z.array(DelegatedPermissionSchema).min(1).max(13),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 60 * 60)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.scopes).size !== value.scopes.length) {
      context.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'Delegated token scopes must be unique',
      })
    }
  })

export const CreateMissionBodySchema = z
  .object({
    requestId: z.string().regex(/^[a-z][a-z0-9_-]{7,95}$/),
    palaceId: PalaceIdSchema,
    objective: z.string().min(12).max(2_000),
    constraints: MissionConstraintSchema,
    successCriteriaIds: z.array(z.string().min(1).max(120)).min(1).max(16),
  })
  .strict()
  .superRefine((body, context) => {
    if (new Set(body.successCriteriaIds).size !== body.successCriteriaIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['successCriteriaIds'],
        message: 'Mission success criteria must be unique',
      })
    }
  })

export const ApprovalDecisionBodySchema = z
  .object({
    nonce: z.string().regex(/^[A-Za-z0-9_-]{20,256}$/),
    decision: z.enum(['approve', 'reject']),
  })
  .strict()

export const BrowserSessionResponseSchema = z
  .object({
    session: z
      .object({
        organizationId: OrganizationIdSchema,
        userId: UserIdSchema,
        role: ProductRoleSchema.exclude(['service', 'delegated']),
        csrfToken: z.string().min(20),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict()

export const DelegatedTokenResponseSchema = z
  .object({
    token: z
      .object({
        id: z.string().regex(/^tok_[a-z0-9][a-z0-9_-]{7,63}$/),
        bearerToken: z.string().regex(/^tpc_[A-Za-z0-9_-]{20,}$/),
        scopes: z.array(DelegatedPermissionSchema).min(1),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict()

export const LogoutResponseSchema = z.object({ session: z.null() }).strict()
export const RevocationResponseSchema = z.object({ revoked: z.literal(true) }).strict()

export const ApprovalDecisionResponseSchema = z
  .object({
    decision: z.enum(['approved', 'rejected', 'expired', 'stale']),
    approval: z
      .object({
        id: ApprovalIdSchema,
        missionId: MissionIdSchema,
        planId: PlanIdSchema,
        status: ApprovalSchema.shape.status,
        approvedAt: z.iso.datetime({ offset: true }).nullable(),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    operations: z.array(
      z
        .object({
          id: OperationIdSchema,
          status: OperationSchema.shape.status,
        })
        .strict(),
    ),
    mission: z
      .object({
        id: MissionIdSchema,
        state: MissionStateSchema,
      })
      .strict(),
  })
  .strict()

export const CreateMissionResponseSchema = z
  .object({
    result: z.enum(['created', 'replayed']),
    mission: z
      .object({
        id: MissionIdSchema,
        palaceId: PalaceIdSchema,
        objective: z.string().min(1).max(2_000),
        state: MissionStateSchema,
        version: z.number().int().nonnegative(),
        createdAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict()

const HumanMissionProjectionSchema = z
  .object({
    id: MissionIdSchema,
    state: MissionStateSchema,
    version: z.number().int().nonnegative(),
  })
  .strict()

export const ApprovalTaskResponseSchema = z
  .object({
    approval: z
      .object({
        id: ApprovalIdSchema,
        missionId: MissionIdSchema,
        planId: PlanIdSchema,
        status: ApprovalSchema.shape.status,
        nonce: ApprovalSchema.shape.nonce,
        protectedResources: ApprovalSchema.shape.protectedResources,
        createdAt: ApprovalSchema.shape.createdAt,
        expiresAt: ApprovalSchema.shape.expiresAt,
      })
      .strict(),
    plan: z
      .object({
        id: PlanSchema.shape.id,
        revision: PlanSchema.shape.revision,
        hash: PlanSchema.shape.hash,
        status: PlanSchema.shape.status,
        objective: PlanSchema.shape.objective,
        constraints: PlanSchema.shape.constraints,
        actions: PlanSchema.shape.actions,
        successCriteriaIds: PlanSchema.shape.successCriteriaIds,
      })
      .strict(),
    mission: HumanMissionProjectionSchema,
  })
  .strict()

export const ClarificationAnswerBodySchema = z
  .object({
    choiceId: ClarificationChoiceIdSchema,
    expectedMissionVersion: z.number().int().nonnegative(),
  })
  .strict()

export const ClarificationTaskResponseSchema = z
  .object({
    request: z
      .object({
        id: ClarificationRequestIdSchema,
        missionId: MissionIdSchema,
        question: z.string().min(12).max(280),
        choices: z.array(ClarificationChoiceSchema).min(2).max(6),
        evidenceRefs: z.array(EvidenceIdSchema).max(16),
        status: z.enum(['pending', 'answered']),
        requestedAt: z.iso.datetime({ offset: true }),
        resolvedAt: z.iso.datetime({ offset: true }).nullable(),
      })
      .strict(),
    answer: z
      .object({
        choiceId: ClarificationChoiceIdSchema,
        answeredAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .nullable(),
    mission: HumanMissionProjectionSchema,
  })
  .strict()

export const ClarificationAnswerResponseSchema = z
  .object({
    result: z.enum(['answered', 'replayed']),
    request: ClarificationTaskResponseSchema.shape.request,
    answer: ClarificationTaskResponseSchema.shape.answer.unwrap(),
    mission: HumanMissionProjectionSchema,
  })
  .strict()

export const MissionTaskInboxResponseSchema = z
  .object({
    mission: HumanMissionProjectionSchema,
    clarification: z
      .object({
        id: ClarificationRequestIdSchema,
        status: z.literal('pending'),
      })
      .strict()
      .nullable(),
    approval: z
      .object({
        id: ApprovalIdSchema,
        planId: PlanIdSchema,
        status: z.literal('pending'),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((inbox, context) => {
    if (inbox.clarification !== null && inbox.approval !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A mission task inbox cannot expose two pending human decisions',
      })
    }
  })

export const PalaceDayPeriodSchema = z.enum(['morning', 'afternoon', 'evening'])

export const PalacePresentationResponseSchema = z
  .object({
    observedAt: IsoDateTimeSchema,
    timezone: z.string().min(1).max(64),
    dayPeriod: PalaceDayPeriodSchema,
  })
  .strict()

const PalaceWorkspaceMemberSchema = z
  .object({
    id: UserIdSchema,
    organizationId: OrganizationIdSchema,
    displayName: z.string().min(1).max(120),
    role: ProductRoleSchema.extract(['owner', 'operator', 'viewer']),
    grants: z.array(z.literal('routine:approve')).max(1),
  })
  .strict()

const PalaceWorkspaceIdentitySchema = z
  .object({
    id: PalaceIdSchema,
    organizationId: OrganizationIdSchema,
    name: z.string().min(1).max(120),
    timezone: z.string().min(1).max(64),
  })
  .strict()

export const WorkspaceAttentionKindSchema = z.enum([
  'clarification',
  'approval',
  'reconciliation',
  'verification',
])

const WorkspaceAttentionSchema = z
  .object({
    kind: WorkspaceAttentionKindSchema,
    missionId: MissionIdSchema,
    label: z.string().min(1).max(240),
    createdAt: IsoDateTimeSchema,
  })
  .strict()

export const CapabilityIdeaAvailabilitySchema = z.enum(['ready', 'needs_connection'])

const CapabilityIdeaSchema = z
  .object({
    programKind: MissionProgramKindSchema,
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    availability: CapabilityIdeaAvailabilitySchema,
    requiredCapabilities: z.array(z.string().min(1).max(120)).min(1).max(16),
  })
  .strict()

export const ActiveAutomationSummarySchema = z
  .object({
    routineId: RoutineIdSchema,
    programKind: MissionProgramKindSchema,
    name: z.string().min(1).max(120),
    version: z.number().int().positive(),
    activeSince: IsoDateTimeSchema,
  })
  .strict()

export const WorkspaceActivityStatusSchema = z.enum([
  'working',
  'checking_result',
  'verified',
  'failed',
  'cancelled',
])

const WorkspaceActivitySchema = z
  .object({
    id: z.string().min(1).max(120),
    missionId: MissionIdSchema,
    summary: z.string().min(1).max(500),
    status: WorkspaceActivityStatusSchema,
    occurredAt: IsoDateTimeSchema,
  })
  .strict()

export const PalaceWorkspaceResponseSchema = z
  .object({
    schemaVersion: z.literal('palace-workspace@1'),
    member: PalaceWorkspaceMemberSchema,
    palace: PalaceWorkspaceIdentitySchema,
    presentation: PalacePresentationResponseSchema,
    attention: z.array(WorkspaceAttentionSchema).max(32),
    capabilityIdeas: z.array(CapabilityIdeaSchema).max(16),
    activeAutomations: z.array(ActiveAutomationSummarySchema).max(64),
    activity: z.array(WorkspaceActivitySchema).max(100),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (workspace.member.organizationId !== workspace.palace.organizationId) {
      context.addIssue({
        code: 'custom',
        path: ['palace', 'organizationId'],
        message: 'A Palace workspace must bind the member and Palace to one organization',
      })
    }
    if (workspace.presentation.timezone !== workspace.palace.timezone) {
      context.addIssue({
        code: 'custom',
        path: ['presentation', 'timezone'],
        message: 'Palace presentation time must use the Palace timezone',
      })
    }
  })

export const MissionDisplayStateSchema = z.enum([
  'working',
  'needs_input',
  'needs_approval',
  'applying',
  'checking_result',
  'verified',
  'failed',
  'cancelled',
])

export const MissionProgressActionSchema = z.enum([
  'answer_clarification',
  'approve_proposal',
  'reject_proposal',
  'view_activity',
])

const MissionProgressTaskSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('clarification'),
        requestId: ClarificationRequestIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('approval'),
        approvalId: ApprovalIdSchema,
        planId: PlanIdSchema,
        expiresAt: IsoDateTimeSchema,
      })
      .strict(),
  ])
  .nullable()

const MissionProgressOperationSchema = z
  .object({
    id: OperationIdSchema,
    missionId: MissionIdSchema,
    status: OperationSchema.shape.status,
  })
  .strict()
  .nullable()

const MissionProgressVerificationSchema = z
  .object({
    id: VerificationIdSchema,
    missionId: MissionIdSchema,
    status: z.enum(['passed', 'failed']),
    completedAt: IsoDateTimeSchema,
    summary: z.string().min(1).max(500),
  })
  .strict()
  .nullable()

export const MissionProgressResponseSchema = z
  .object({
    schemaVersion: z.literal('mission-progress@1'),
    mission: z
      .object({
        id: MissionIdSchema,
        palaceId: PalaceIdSchema,
        organizationId: OrganizationIdSchema,
        programKind: MissionProgramKindSchema.nullable(),
        objective: z.string().min(1).max(2_000),
        state: MissionStateSchema,
        version: z.number().int().nonnegative(),
      })
      .strict(),
    displayState: MissionDisplayStateSchema,
    pendingTask: MissionProgressTaskSchema,
    operation: MissionProgressOperationSchema,
    verification: MissionProgressVerificationSchema,
    allowedNextActions: z.array(MissionProgressActionSchema).max(4),
    observedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((progress, context) => {
    if (progress.operation !== null && progress.operation.missionId !== progress.mission.id) {
      context.addIssue({
        code: 'custom',
        path: ['operation', 'missionId'],
        message: 'A mission progress operation must belong to the projected mission',
      })
    }
    if (progress.verification !== null && progress.verification.missionId !== progress.mission.id) {
      context.addIssue({
        code: 'custom',
        path: ['verification', 'missionId'],
        message: 'A mission progress verification must belong to the projected mission',
      })
    }
    if (progress.displayState === 'needs_input' && progress.pendingTask?.kind !== 'clarification') {
      context.addIssue({
        code: 'custom',
        path: ['pendingTask'],
        message: 'needs_input requires one pending clarification',
      })
    }
    if (progress.displayState === 'needs_approval' && progress.pendingTask?.kind !== 'approval') {
      context.addIssue({
        code: 'custom',
        path: ['pendingTask'],
        message: 'needs_approval requires one pending approval',
      })
    }
    if (progress.displayState === 'verified' && progress.verification?.status !== 'passed') {
      context.addIssue({
        code: 'custom',
        path: ['verification'],
        message: 'verified requires passing retained verification evidence',
      })
    }
    if (progress.displayState === 'cancelled' && progress.mission.state.status !== 'cancelled') {
      context.addIssue({
        code: 'custom',
        path: ['mission', 'state'],
        message: 'cancelled requires a cancelled mission',
      })
    }
  })

export const HelpCatalogAudienceSchema = z.enum(['customer', 'developer', 'pal', 'external-agent'])
export const HelpCatalogTrackSchema = z.enum([
  'start',
  'automations',
  'troubleshoot',
  'understand_pal',
  'developer',
  'api_mcp',
])

export const HelpCatalogEntryResponseSchema = z
  .object({
    id: z.string().min(1).max(160),
    audience: z.array(HelpCatalogAudienceSchema).min(1).max(4),
    task: z.string().min(1).max(240),
    track: HelpCatalogTrackSchema,
    prerequisites: z.array(z.string().min(1).max(160)).max(16),
    nextStep: z
      .object({
        label: z.string().min(1).max(120),
        publicRoute: z.string().regex(/^\/help(?:\/|$)/),
      })
      .strict()
      .nullable(),
    publicRoute: z.string().regex(/^\/help(?:\/|$)/),
    searchLabel: z.string().min(1).max(240),
  })
  .strict()

export const WEB_API_SCHEMA_PROJECTIONS = [
  {
    operationId: 'getHealth',
    method: 'GET',
    path: WEB_API_ROUTES.health.path,
    authentication: 'none',
    successStatus: 200,
    pathParameters: [],
    requestBodySchema: null,
    responseBodySchema: HealthResponseSchema,
  },
  {
    operationId: 'getReadiness',
    method: 'GET',
    path: WEB_API_ROUTES.readiness.path,
    authentication: 'none',
    successStatus: 200,
    pathParameters: [],
    requestBodySchema: null,
    responseBodySchema: ReadinessResponseSchema,
  },
  {
    operationId: 'createDevSession',
    method: 'POST',
    path: WEB_API_ROUTES.devSession.path,
    authentication: 'none',
    successStatus: 201,
    pathParameters: [],
    requestBodySchema: EmptyJsonObjectSchema,
    responseBodySchema: BrowserSessionResponseSchema,
  },
  {
    operationId: 'rotateSession',
    method: 'POST',
    path: WEB_API_ROUTES.rotateSession.path,
    authentication: 'session_csrf_recent',
    successStatus: 200,
    pathParameters: [],
    requestBodySchema: EmptyJsonObjectSchema,
    responseBodySchema: BrowserSessionResponseSchema,
  },
  {
    operationId: 'logoutSession',
    method: 'POST',
    path: WEB_API_ROUTES.logoutSession.path,
    authentication: 'session_csrf_recent',
    successStatus: 200,
    pathParameters: [],
    requestBodySchema: EmptyJsonObjectSchema,
    responseBodySchema: LogoutResponseSchema,
  },
  {
    operationId: 'createMission',
    method: 'POST',
    path: WEB_API_ROUTES.createMission.path,
    authentication: 'session_csrf_recent',
    successStatus: 201,
    pathParameters: [],
    requestBodySchema: CreateMissionBodySchema,
    responseBodySchema: CreateMissionResponseSchema,
  },
  {
    operationId: 'getMissionTasks',
    method: 'GET',
    path: '/api/v1/missions/{missionId}/tasks',
    authentication: 'session',
    successStatus: 200,
    pathParameters: [{ name: 'missionId', schema: MissionIdSchema }],
    requestBodySchema: null,
    responseBodySchema: MissionTaskInboxResponseSchema,
  },
  {
    operationId: 'getMissionProgress',
    method: 'GET',
    path: '/api/v1/missions/{missionId}/progress',
    authentication: 'session',
    successStatus: 200,
    pathParameters: [{ name: 'missionId', schema: MissionIdSchema }],
    requestBodySchema: null,
    responseBodySchema: MissionProgressResponseSchema,
  },
  {
    operationId: 'getPalaceWorkspace',
    method: 'GET',
    path: '/api/v1/palaces/{palaceId}/workspace',
    authentication: 'session',
    successStatus: 200,
    pathParameters: [{ name: 'palaceId', schema: PalaceIdSchema }],
    requestBodySchema: null,
    responseBodySchema: PalaceWorkspaceResponseSchema,
  },
  {
    operationId: 'issueDelegatedToken',
    method: 'POST',
    path: WEB_API_ROUTES.issueDelegatedToken.path,
    authentication: 'session_csrf_recent',
    successStatus: 201,
    pathParameters: [],
    requestBodySchema: IssueDelegatedTokenBodySchema,
    responseBodySchema: DelegatedTokenResponseSchema,
  },
  {
    operationId: 'revokeDelegatedToken',
    method: 'DELETE',
    path: '/api/v1/auth/delegated-tokens/{tokenId}',
    authentication: 'session_csrf_recent',
    successStatus: 200,
    pathParameters: [{ name: 'tokenId', schema: DelegatedTokenIdSchema }],
    requestBodySchema: null,
    responseBodySchema: RevocationResponseSchema,
  },
  {
    operationId: 'getApproval',
    method: 'GET',
    path: '/api/v1/approvals/{approvalId}',
    authentication: 'session',
    successStatus: 200,
    pathParameters: [{ name: 'approvalId', schema: ApprovalIdSchema }],
    requestBodySchema: null,
    responseBodySchema: ApprovalTaskResponseSchema,
  },
  {
    operationId: 'decideApproval',
    method: 'POST',
    path: '/api/v1/approvals/{approvalId}/decision',
    authentication: 'session_csrf_recent',
    successStatus: 200,
    pathParameters: [{ name: 'approvalId', schema: ApprovalIdSchema }],
    requestBodySchema: ApprovalDecisionBodySchema,
    responseBodySchema: ApprovalDecisionResponseSchema,
  },
  {
    operationId: 'getClarification',
    method: 'GET',
    path: '/api/v1/clarifications/{requestId}',
    authentication: 'session',
    successStatus: 200,
    pathParameters: [{ name: 'requestId', schema: ClarificationRequestIdSchema }],
    requestBodySchema: null,
    responseBodySchema: ClarificationTaskResponseSchema,
  },
  {
    operationId: 'answerClarification',
    method: 'POST',
    path: '/api/v1/clarifications/{requestId}/answer',
    authentication: 'session_csrf_recent',
    successStatus: 200,
    pathParameters: [{ name: 'requestId', schema: ClarificationRequestIdSchema }],
    requestBodySchema: ClarificationAnswerBodySchema,
    responseBodySchema: ClarificationAnswerResponseSchema,
  },
] as const

export function toolApiPath(toolName: string): string {
  return WEB_API_ROUTES.tool.path(ToolNameSchema.parse(toolName))
}

export function approvalDecisionPath(approvalId: string): string {
  return WEB_API_ROUTES.decideApproval.path(ApprovalIdSchema.parse(approvalId))
}

export type IssueDelegatedTokenBody = z.infer<typeof IssueDelegatedTokenBodySchema>
export type CreateMissionBody = z.infer<typeof CreateMissionBodySchema>
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBodySchema>
export type ClarificationAnswerBody = z.infer<typeof ClarificationAnswerBodySchema>
