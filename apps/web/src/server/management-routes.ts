import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  type ApprovalDecisionResult,
  type AuthContext,
  type ClarificationAnswerResult,
  type HumanApprovalTask,
  type HumanClarificationTask,
  type HumanMissionTaskInbox,
  type IssuedDelegatedCredential,
  type IssuedSession,
  type MissionBootstrapResult,
} from '@trash-palace/application'
import {
  ApprovalIdSchema,
  ClarificationRequestIdSchema,
  MembershipIdSchema,
  MissionIdSchema,
  PolicyViolationError,
  PrincipalSchema,
  Sha256Schema,
  hashToolValue,
  type ClarificationChoiceId,
  type DelegatedPermission,
  type Mission,
  type PalaceId,
  type Principal,
} from '@trash-palace/core'
import { z } from 'zod'

import {
  ApprovalDecisionBodySchema,
  ApprovalDecisionResponseSchema,
  ApprovalTaskResponseSchema,
  BrowserSessionResponseSchema,
  ClarificationAnswerBodySchema,
  ClarificationAnswerResponseSchema,
  ClarificationTaskResponseSchema,
  CreateMissionBodySchema,
  CreateMissionResponseSchema,
  DelegatedTokenIdSchema,
  DelegatedTokenResponseSchema,
  IssueDelegatedTokenBodySchema,
  LogoutResponseSchema,
  MissionTaskInboxResponseSchema,
  RevocationResponseSchema,
} from './api-contracts.js'
import {
  HttpBoundaryError,
  SESSION_COOKIE_NAME,
  assertEmptyBody,
  assertEmptyJsonObject,
  assertNoQuery,
  jsonResponse,
  problemResponse,
  readPresentedCredential,
  readStrictJson,
} from './http-boundary.js'

export interface BrowserSessionPort {
  issue(input: {
    readonly principal: Principal
    readonly membershipId: ReturnType<typeof MembershipIdSchema.parse>
  }): Promise<IssuedSession>
  authenticate(signedCookie: string): Promise<AuthContext>
  rotate(signedCookie: string): Promise<IssuedSession>
  revoke(signedCookie: string): Promise<void>
  assert(input: {
    readonly context: AuthContext
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): void
}

export interface DelegatedCredentialPort {
  issue(input: {
    readonly issuer: AuthContext
    readonly scopes: readonly DelegatedPermission[]
    readonly ttlMilliseconds?: number
  }): Promise<IssuedDelegatedCredential>
  revoke(input: { readonly issuer: AuthContext; readonly tokenId: string }): Promise<boolean>
}

export interface ApprovalDecisionPort {
  decide(input: {
    readonly context: AuthContext
    readonly approvalId: ReturnType<typeof ApprovalIdSchema.parse>
    readonly nonce: string
    readonly decision: 'approve' | 'reject'
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): Promise<ApprovalDecisionResult>
}

export interface HumanTaskPort {
  getMissionTasks(
    context: AuthContext,
    missionId: ReturnType<typeof MissionIdSchema.parse>,
  ): Promise<HumanMissionTaskInbox>
  getApproval(
    context: AuthContext,
    approvalId: ReturnType<typeof ApprovalIdSchema.parse>,
  ): Promise<HumanApprovalTask>
  getClarification(
    context: AuthContext,
    requestId: ReturnType<typeof ClarificationRequestIdSchema.parse>,
  ): Promise<HumanClarificationTask>
}

export interface ClarificationAnswerPort {
  answer(input: {
    readonly context: AuthContext
    readonly requestId: ReturnType<typeof ClarificationRequestIdSchema.parse>
    readonly expectedMissionVersion: number
    readonly idempotencyKey: ReturnType<typeof Sha256Schema.parse>
    readonly choiceId: ClarificationChoiceId
    readonly evidenceRefs: readonly []
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): Promise<ClarificationAnswerResult>
}

export interface MissionBootstrapPort {
  create(input: {
    readonly context: AuthContext
    readonly requestId: string
    readonly palaceId: PalaceId
    readonly objective: string
    readonly constraints: Mission['constraints']
    readonly successCriteriaIds: readonly string[]
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): Promise<MissionBootstrapResult>
}

export type DevSessionBootstrap =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true
      principal: Principal
      membershipId: ReturnType<typeof MembershipIdSchema.parse>
    }>

export interface ManagementRouteDependencies {
  readonly allowedOrigin: string
  readonly sessions: BrowserSessionPort
  readonly delegatedCredentials: DelegatedCredentialPort
  readonly approvals: ApprovalDecisionPort
  readonly humanTasks: HumanTaskPort
  readonly clarifications: ClarificationAnswerPort
  readonly missions: MissionBootstrapPort
  readonly devBootstrap: DevSessionBootstrap
}

export interface ManagementRoutes {
  readonly createDevSession: (request: Request) => Promise<Response>
  readonly rotateSession: (request: Request) => Promise<Response>
  readonly logoutSession: (request: Request) => Promise<Response>
  readonly issueDelegatedToken: (request: Request) => Promise<Response>
  readonly createMission: (request: Request) => Promise<Response>
  readonly getMissionTasks: (request: Request, missionId: string) => Promise<Response>
  readonly revokeDelegatedToken: (request: Request, tokenId: string) => Promise<Response>
  readonly getApproval: (request: Request, approvalId: string) => Promise<Response>
  readonly decideApproval: (request: Request, approvalId: string) => Promise<Response>
  readonly getClarification: (request: Request, requestId: string) => Promise<Response>
  readonly answerClarification: (request: Request, requestId: string) => Promise<Response>
}

export function createManagementRoutes(
  dependencies: ManagementRouteDependencies,
): ManagementRoutes {
  const allowedOrigin = parseExactOrigin(dependencies.allowedOrigin)

  return {
    createDevSession: (request) =>
      boundary(async () => {
        assertNoQuery(request)
        if (!dependencies.devBootstrap.enabled) {
          throw new HttpBoundaryError(404, 'NOT_FOUND', 'The requested endpoint is unavailable.')
        }
        assertExactBrowserOrigin(request, allowedOrigin)
        await assertEmptyJsonObject(request)
        const issued = await dependencies.sessions.issue({
          principal: dependencies.devBootstrap.principal,
          membershipId: dependencies.devBootstrap.membershipId,
        })
        return sessionResponse(issued, 201)
      }),
    rotateSession: (request) =>
      boundary(async () => {
        assertNoQuery(request)
        await assertEmptyJsonObject(request)
        const current = await authenticateBrowserMutation(request, dependencies, allowedOrigin)
        const issued = await dependencies.sessions.rotate(current.signedCookie)
        return sessionResponse(issued, 200)
      }),
    logoutSession: (request) =>
      boundary(async () => {
        assertNoQuery(request)
        await assertEmptyJsonObject(request)
        const current = await authenticateBrowserMutation(request, dependencies, allowedOrigin)
        await dependencies.sessions.revoke(current.signedCookie)
        return jsonResponse(LogoutResponseSchema.parse({ session: null }), {
          headers: { 'set-cookie': expiredSessionCookie() },
        })
      }),
    issueDelegatedToken: (request) =>
      boundary(async () => {
        assertNoQuery(request)
        const body = parseBody(IssueDelegatedTokenBodySchema, await readStrictJson(request))
        const current = await authenticateBrowserMutation(request, dependencies, allowedOrigin)
        const issued = await dependencies.delegatedCredentials.issue({
          issuer: current.context,
          scopes: body.scopes,
          ...(body.expiresInSeconds === undefined
            ? {}
            : { ttlMilliseconds: body.expiresInSeconds * 1_000 }),
        })
        return jsonResponse(
          DelegatedTokenResponseSchema.parse({
            token: {
              id: issued.tokenId,
              bearerToken: issued.bearerToken,
              scopes: issued.scopes,
              expiresAt: issued.expiresAt,
            },
          }),
          { status: 201 },
        )
      }),
    createMission: (request) =>
      boundary(async () => {
        assertNoQuery(request)
        const body = parseBody(CreateMissionBodySchema, await readStrictJson(request))
        const current = await authenticateBrowserMutation(request, dependencies, allowedOrigin)
        const result = await dependencies.missions.create({
          context: current.context,
          ...body,
          ...current.mutation,
        })
        return jsonResponse(CreateMissionResponseSchema.parse(projectMissionBootstrap(result)), {
          status: result.kind === 'created' ? 201 : 200,
        })
      }),
    getMissionTasks: (request, missionIdInput) =>
      boundary(async () => {
        assertNoQuery(request)
        await assertEmptyBody(request)
        const missionId = MissionIdSchema.safeParse(missionIdInput)
        if (!missionId.success) unavailableResource()
        const context = await authenticateBrowserRead(request, dependencies, allowedOrigin)
        const inbox = await dependencies.humanTasks.getMissionTasks(context, missionId.data)
        return jsonResponse(MissionTaskInboxResponseSchema.parse(projectMissionTaskInbox(inbox)))
      }),
    revokeDelegatedToken: (request, tokenIdInput) =>
      boundary(async () => {
        assertNoQuery(request)
        await assertEmptyBody(request)
        const tokenId = DelegatedTokenIdSchema.safeParse(tokenIdInput)
        if (!tokenId.success) unavailableResource()
        const current = await authenticateBrowserMutation(request, dependencies, allowedOrigin)
        if (
          !(await dependencies.delegatedCredentials.revoke({
            issuer: current.context,
            tokenId: tokenId.data,
          }))
        ) {
          unavailableResource()
        }
        return jsonResponse(RevocationResponseSchema.parse({ revoked: true }))
      }),
    getApproval: (request, approvalIdInput) =>
      boundary(async () => {
        assertNoQuery(request)
        await assertEmptyBody(request)
        const approvalId = ApprovalIdSchema.safeParse(approvalIdInput)
        if (!approvalId.success) unavailableResource()
        const context = await authenticateBrowserRead(request, dependencies, allowedOrigin)
        const task = await dependencies.humanTasks.getApproval(context, approvalId.data)
        return jsonResponse(ApprovalTaskResponseSchema.parse(projectApprovalTask(task)))
      }),
    decideApproval: (request, approvalIdInput) =>
      boundary(async () => {
        assertNoQuery(request)
        const approvalId = ApprovalIdSchema.safeParse(approvalIdInput)
        if (!approvalId.success) unavailableResource()
        const body = parseBody(ApprovalDecisionBodySchema, await readStrictJson(request))
        const current = await authenticateBrowserMutation(request, dependencies, allowedOrigin)
        const result = await dependencies.approvals.decide({
          context: current.context,
          approvalId: approvalId.data,
          nonce: body.nonce,
          decision: body.decision,
          ...current.mutation,
        })
        return jsonResponse(ApprovalDecisionResponseSchema.parse(projectApproval(result)))
      }),
    getClarification: (request, requestIdInput) =>
      boundary(async () => {
        assertNoQuery(request)
        await assertEmptyBody(request)
        const requestId = ClarificationRequestIdSchema.safeParse(requestIdInput)
        if (!requestId.success) unavailableResource()
        const context = await authenticateBrowserRead(request, dependencies, allowedOrigin)
        const task = await dependencies.humanTasks.getClarification(context, requestId.data)
        return jsonResponse(ClarificationTaskResponseSchema.parse(projectClarificationTask(task)))
      }),
    answerClarification: (request, requestIdInput) =>
      boundary(async () => {
        assertNoQuery(request)
        const requestId = ClarificationRequestIdSchema.safeParse(requestIdInput)
        if (!requestId.success) unavailableResource()
        const body = parseBody(ClarificationAnswerBodySchema, await readStrictJson(request))
        const current = await authenticateBrowserMutation(request, dependencies, allowedOrigin)
        const result = await dependencies.clarifications.answer({
          context: current.context,
          requestId: requestId.data,
          expectedMissionVersion: body.expectedMissionVersion,
          idempotencyKey: Sha256Schema.parse(
            hashToolValue({
              schemaVersion: 'clarification-http-answer-key@1',
              organizationId: current.context.principal.organizationId,
              actorId: current.context.principal.actorId,
              requestId: requestId.data,
              choiceId: body.choiceId,
            }),
          ),
          choiceId: body.choiceId,
          evidenceRefs: [],
          ...current.mutation,
        })
        return jsonResponse(
          ClarificationAnswerResponseSchema.parse(projectClarificationAnswer(result)),
        )
      }),
  }
}

async function authenticateBrowserRead(
  request: Request,
  dependencies: ManagementRouteDependencies,
  allowedOrigin: string,
): Promise<AuthContext> {
  assertExactBrowserAuthority(request, allowedOrigin)
  const presented = readPresentedCredential(request.headers)
  if (presented.kind !== 'session') {
    throw new HttpBoundaryError(401, 'BROWSER_SESSION_REQUIRED', 'A browser session is required.')
  }
  try {
    return await dependencies.sessions.authenticate(presented.value)
  } catch {
    throw new HttpBoundaryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is invalid.')
  }
}

async function authenticateBrowserMutation(
  request: Request,
  dependencies: ManagementRouteDependencies,
  allowedOrigin: string,
): Promise<{
  readonly signedCookie: string
  readonly context: AuthContext
  readonly mutation: {
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }
}> {
  assertExactBrowserAuthority(request, allowedOrigin)
  const presented = readPresentedCredential(request.headers)
  if (presented.kind !== 'session') {
    throw new HttpBoundaryError(401, 'BROWSER_SESSION_REQUIRED', 'A browser session is required.')
  }
  let context: AuthContext
  try {
    context = await dependencies.sessions.authenticate(presented.value)
  } catch {
    throw new HttpBoundaryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is invalid.')
  }
  const origin = request.headers.get('origin')
  const csrfToken = request.headers.get('x-csrf-token')
  if (origin !== allowedOrigin || csrfToken === null) mutationRejected()
  const mutation = { csrfToken, origin, allowedOrigin }
  try {
    dependencies.sessions.assert({ context, ...mutation })
  } catch {
    mutationRejected()
  }
  return { signedCookie: presented.value, context, mutation }
}

function assertExactBrowserOrigin(request: Request, allowedOrigin: string): void {
  assertExactBrowserAuthority(request, allowedOrigin)
  if (request.headers.get('origin') !== allowedOrigin) {
    mutationRejected()
  }
}

function assertExactBrowserAuthority(request: Request, allowedOrigin: string): void {
  const allowed = new URL(allowedOrigin)
  // Next reconstructs Request.url from the container bind address. The Host header
  // retains the browser-facing authority and is the boundary that must match here.
  if (request.headers.get('host')?.toLowerCase() !== allowed.host.toLowerCase()) {
    mutationRejected()
  }
}

function sessionResponse(issued: IssuedSession, status: 200 | 201): Response {
  const context = issued.context
  const body = BrowserSessionResponseSchema.parse({
    session: {
      organizationId: context.principal.organizationId,
      userId: context.principal.actorId,
      role: context.principal.role,
      csrfToken: context.csrfToken,
      expiresAt: context.expiresAt,
    },
  })
  return jsonResponse(body, {
    status,
    headers: { 'set-cookie': currentSessionCookie(issued.signedCookie, context.expiresAt) },
  })
}

function projectApproval(result: ApprovalDecisionResult) {
  return {
    decision: result.status,
    approval: {
      id: result.approval.id,
      missionId: result.approval.missionId,
      planId: result.approval.planId,
      status: result.approval.status,
      approvedAt: result.approval.approvedAt,
      expiresAt: result.approval.expiresAt,
    },
    operations: result.operations.map((operation) => ({
      id: operation.id,
      status: operation.status,
    })),
    mission: { id: result.mission.id, state: result.mission.state },
  }
}

function projectMissionBootstrap(result: MissionBootstrapResult) {
  return {
    result: result.kind,
    mission: {
      id: result.mission.id,
      palaceId: result.mission.palaceId,
      objective: result.mission.objective,
      state: result.mission.state,
      version: result.mission.version,
      createdAt: result.mission.createdAt,
    },
  }
}

function projectMissionTaskInbox(inbox: HumanMissionTaskInbox) {
  return {
    mission: {
      id: inbox.mission.id,
      state: inbox.mission.state,
      version: inbox.mission.version,
    },
    clarification:
      inbox.clarification === null
        ? null
        : { id: inbox.clarification.id, status: inbox.clarification.status },
    approval:
      inbox.approval === null
        ? null
        : {
            id: inbox.approval.id,
            planId: inbox.approval.planId,
            status: inbox.approval.status,
            expiresAt: inbox.approval.expiresAt,
          },
  }
}

function projectApprovalTask(task: HumanApprovalTask) {
  return {
    approval: {
      id: task.approval.id,
      missionId: task.approval.missionId,
      planId: task.approval.planId,
      status: task.approval.status,
      nonce: task.approval.nonce,
      protectedResources: task.approval.protectedResources,
      createdAt: task.approval.createdAt,
      expiresAt: task.approval.expiresAt,
    },
    plan: {
      id: task.plan.id,
      revision: task.plan.revision,
      hash: task.plan.hash,
      status: task.plan.status,
      objective: task.plan.objective,
      constraints: task.plan.constraints,
      actions: task.plan.actions,
      successCriteriaIds: task.plan.successCriteriaIds,
    },
    mission: {
      id: task.mission.id,
      state: task.mission.state,
      version: task.mission.version,
    },
  }
}

function projectClarificationTask(task: HumanClarificationTask) {
  return {
    request: {
      id: task.request.id,
      missionId: task.request.missionId,
      question: task.request.question,
      choices: task.request.choices,
      evidenceRefs: task.request.evidenceRefs,
      status: task.request.status,
      requestedAt: task.request.requestedAt,
      resolvedAt: task.request.resolvedAt,
    },
    answer:
      task.answer === null
        ? null
        : { choiceId: task.answer.choiceId, answeredAt: task.answer.answeredAt },
    mission: {
      id: task.mission.id,
      state: task.mission.state,
      version: task.mission.version,
    },
  }
}

function projectClarificationAnswer(result: ClarificationAnswerResult) {
  return {
    result: result.kind,
    ...projectClarificationTask({
      request: result.request,
      answer: result.answer,
      mission: result.mission,
    }),
  }
}

function currentSessionCookie(value: string, expiresAt: string): string {
  if (!/^[A-Za-z0-9._~-]{20,4096}$/.test(value)) {
    throw new TypeError('Session service returned an invalid cookie value')
  }
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`
}

function expiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
}

function parseBody<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new HttpBoundaryError(422, 'INVALID_REQUEST_BODY', 'Request body is invalid.')
  }
  return parsed.data
}

function parseExactOrigin(input: string): string {
  const url = new URL(input)
  if (
    url.origin !== input ||
    url.username !== '' ||
    url.password !== '' ||
    !['http:', 'https:'].includes(url.protocol)
  ) {
    throw new TypeError('Allowed origin must be one exact HTTP or HTTPS origin')
  }
  return url.origin
}

function boundary(work: () => Promise<Response>): Promise<Response> {
  return work().catch((error: unknown) => problemResponse(mapError(error)))
}

function mapError(error: unknown): unknown {
  if (error instanceof HttpBoundaryError) return error
  if (error instanceof AuthenticationError) {
    return new HttpBoundaryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is invalid.')
  }
  if (error instanceof PolicyViolationError) {
    return new HttpBoundaryError(403, 'ACTION_FORBIDDEN', 'The action is not permitted.')
  }
  if (error instanceof NotFoundError) {
    return new HttpBoundaryError(404, 'NOT_FOUND', 'The requested resource is unavailable.')
  }
  if (error instanceof ConflictError) {
    return new HttpBoundaryError(409, 'CONFLICT', 'The request conflicts with current state.')
  }
  if (error instanceof z.ZodError || error instanceof RangeError) {
    return new HttpBoundaryError(422, 'INVALID_REQUEST', 'The request is invalid.')
  }
  return error
}

function mutationRejected(): never {
  throw new HttpBoundaryError(401, 'MUTATION_GUARD_REJECTED', 'Mutation authentication is invalid.')
}

function unavailableResource(): never {
  throw new HttpBoundaryError(404, 'NOT_FOUND', 'The requested resource is unavailable.')
}

export function parseDevBootstrap(input: {
  readonly enabled: boolean
  readonly organizationId: string
  readonly userId: string
  readonly membershipId: string
}): DevSessionBootstrap {
  if (!input.enabled) return { enabled: false }
  return {
    enabled: true,
    principal: PrincipalSchema.parse({
      organizationId: input.organizationId,
      actorId: input.userId,
      role: 'owner',
      operatorGrants: [],
      delegatedPermissions: [],
    }),
    membershipId: MembershipIdSchema.parse(input.membershipId),
  }
}
