import type {
  ApprovalDecisionResult,
  AuthContext,
  ClarificationAnswerResult,
  HumanApprovalTask,
  HumanClarificationTask,
  HumanMissionTaskInbox,
  IssuedSession,
  MissionBootstrapResult,
} from '@trash-palace/application'
import { PrincipalSchema } from '@trash-palace/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SESSION_COOKIE_NAME } from './http-boundary.js'
import {
  createManagementRoutes,
  parseDevBootstrap,
  type ApprovalDecisionPort,
  type BrowserSessionPort,
  type DelegatedCredentialPort,
  type HumanTaskPort,
  type ClarificationAnswerPort,
  type ManagementRouteDependencies,
  type MissionBootstrapPort,
} from './management-routes.js'

const ORIGIN = 'http://127.0.0.1:3000'
const SESSION = 'signed.session.value_1234567890'
const SUCCESSOR = 'signed.session.successor_1234567890'
const CSRF = 'csrf_management_value_1234567890'
const APPROVAL_ID = 'apr_management_01'
const TOKEN_ID = 'tok_management_01'
const CLARIFICATION_ID = 'clr_management_01'

const principal = PrincipalSchema.parse({
  organizationId: 'org_management_01',
  actorId: 'usr_management_01',
  role: 'owner',
  operatorGrants: [],
  delegatedPermissions: [],
})

const context: AuthContext = {
  sessionId: 'session_management_1234567890',
  principal,
  csrfToken: CSRF,
  issuedAt: '2026-08-14T05:00:00.000Z',
  expiresAt: '2026-08-14T07:00:00.000Z',
  authenticatedAt: '2026-08-14T05:00:00.000Z',
}

describe('HTTP management routes', () => {
  let sessions: BrowserSessionPort
  let delegatedCredentials: DelegatedCredentialPort
  let approvals: ApprovalDecisionPort
  let humanTasks: HumanTaskPort
  let clarifications: ClarificationAnswerPort
  let dependencies: ManagementRouteDependencies
  let issueSession: ReturnType<typeof vi.fn<BrowserSessionPort['issue']>>
  let rotateSession: ReturnType<typeof vi.fn<BrowserSessionPort['rotate']>>
  let revokeSession: ReturnType<typeof vi.fn<BrowserSessionPort['revoke']>>
  let assertSession: ReturnType<typeof vi.fn<BrowserSessionPort['assert']>>
  let issueDelegated: ReturnType<typeof vi.fn<DelegatedCredentialPort['issue']>>
  let revokeDelegated: ReturnType<typeof vi.fn<DelegatedCredentialPort['revoke']>>
  let decideApproval: ReturnType<typeof vi.fn<ApprovalDecisionPort['decide']>>
  let getApproval: ReturnType<typeof vi.fn<HumanTaskPort['getApproval']>>
  let getClarification: ReturnType<typeof vi.fn<HumanTaskPort['getClarification']>>
  let getMissionTasks: ReturnType<typeof vi.fn<HumanTaskPort['getMissionTasks']>>
  let answerClarification: ReturnType<typeof vi.fn<ClarificationAnswerPort['answer']>>
  let createMission: ReturnType<typeof vi.fn<MissionBootstrapPort['create']>>

  beforeEach(() => {
    issueSession = vi.fn<BrowserSessionPort['issue']>().mockResolvedValue(issued(SESSION))
    rotateSession = vi.fn<BrowserSessionPort['rotate']>().mockResolvedValue(issued(SUCCESSOR))
    revokeSession = vi.fn<BrowserSessionPort['revoke']>().mockResolvedValue(undefined)
    assertSession = vi.fn<BrowserSessionPort['assert']>()
    issueDelegated = vi.fn<DelegatedCredentialPort['issue']>().mockResolvedValue({
      tokenId: TOKEN_ID,
      bearerToken: 'tpc_delegated_secret_value_1234567890',
      scopes: ['knowledge:read'],
      expiresAt: '2026-08-15T05:00:00.000Z',
    })
    revokeDelegated = vi.fn<DelegatedCredentialPort['revoke']>().mockResolvedValue(true)
    decideApproval = vi.fn<ApprovalDecisionPort['decide']>().mockResolvedValue(approvalResult())
    getApproval = vi.fn<HumanTaskPort['getApproval']>().mockResolvedValue(approvalTaskResult())
    getClarification = vi
      .fn<HumanTaskPort['getClarification']>()
      .mockResolvedValue(clarificationTaskResult())
    getMissionTasks = vi
      .fn<HumanTaskPort['getMissionTasks']>()
      .mockResolvedValue(missionTaskInboxResult())
    answerClarification = vi
      .fn<ClarificationAnswerPort['answer']>()
      .mockResolvedValue(clarificationAnswerResult())
    createMission = vi
      .fn<MissionBootstrapPort['create']>()
      .mockResolvedValue(missionBootstrapResult())
    sessions = {
      issue: issueSession,
      authenticate: vi.fn().mockResolvedValue(context),
      rotate: rotateSession,
      revoke: revokeSession,
      assert: assertSession,
    }
    delegatedCredentials = {
      issue: issueDelegated,
      revoke: revokeDelegated,
    }
    approvals = { decide: decideApproval }
    humanTasks = {
      getMissionTasks,
      getApproval,
      getClarification,
    }
    clarifications = { answer: answerClarification }
    dependencies = {
      allowedOrigin: ORIGIN,
      sessions,
      delegatedCredentials,
      approvals,
      humanTasks,
      clarifications,
      missions: { create: createMission },
      devBootstrap: parseDevBootstrap({
        enabled: true,
        organizationId: principal.organizationId,
        userId: principal.actorId,
        membershipId: 'mem_management_01',
      }),
    }
  })

  it('issues a fixed seeded session only from the explicit same-origin local endpoint', async () => {
    const response = await createManagementRoutes(dependencies).createDevSession(
      jsonRequest('/api/v1/auth/dev-session', {}, { origin: ORIGIN }),
    )

    expect(response.status).toBe(201)
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(response.headers.get('set-cookie')).toContain(
      `${SESSION_COOKIE_NAME}=${SESSION}; Path=/;`,
    )
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict')
    expect(issueSession).toHaveBeenCalledWith({
      principal,
      membershipId: 'mem_management_01',
    })
    const responseBody = await response.text()
    expect(responseBody).toContain(CSRF)
    expect(responseBody).not.toContain(SESSION)
  })

  it('uses the browser-facing authority when Next reconstructs an internal container URL', async () => {
    const response = await createManagementRoutes(dependencies).createDevSession(
      new Request('http://0.0.0.0:3000/api/v1/auth/dev-session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: new URL(ORIGIN).host,
          origin: ORIGIN,
        },
        body: '{}',
      }),
    )

    expect(response.status).toBe(201)
    expect(issueSession).toHaveBeenCalledOnce()
  })

  it('hides a disabled bootstrap and rejects hostile origins or authorities', async () => {
    const disabled = createManagementRoutes({
      ...dependencies,
      devBootstrap: { enabled: false },
    })
    const hidden = await disabled.createDevSession(
      jsonRequest('/api/v1/auth/dev-session', {}, { origin: ORIGIN }),
    )
    const hostile = await createManagementRoutes(dependencies).createDevSession(
      jsonRequest('/api/v1/auth/dev-session', {}, { origin: 'https://hostile.example' }),
    )
    const hostileAuthority = await createManagementRoutes(dependencies).createDevSession(
      jsonRequest('/api/v1/auth/dev-session', {}, { host: 'hostile.example' }),
    )

    expect(hidden.status).toBe(404)
    expect(hostile.status).toBe(401)
    expect(hostileAuthority.status).toBe(401)
    expect(issueSession).not.toHaveBeenCalled()
    expect(await hostile.text()).not.toContain('hostile.example')
  })

  it('rotates a session only after exact origin, CSRF, and recent-auth assertion', async () => {
    const response = await createManagementRoutes(dependencies).rotateSession(
      browserJsonRequest('/api/v1/auth/session/rotate', {}),
    )

    expect(response.status).toBe(200)
    expect(assertSession).toHaveBeenCalledWith({
      context,
      csrfToken: CSRF,
      origin: ORIGIN,
      allowedOrigin: ORIGIN,
    })
    expect(rotateSession).toHaveBeenCalledWith(SESSION)
    expect(response.headers.get('set-cookie')).toContain(SUCCESSOR)
  })

  it('fails closed when recent authentication is stale and never invokes the mutation', async () => {
    assertSession.mockImplementationOnce(() => {
      throw new Error('private stale-auth detail')
    })

    const response = await createManagementRoutes(dependencies).issueDelegatedToken(
      browserJsonRequest('/api/v1/auth/delegated-tokens', {
        scopes: ['knowledge:read'],
      }),
    )

    expect(response.status).toBe(401)
    expect(issueDelegated).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain('private stale-auth detail')
  })

  it('revokes a session and expires the host-only cookie', async () => {
    const response = await createManagementRoutes(dependencies).logoutSession(
      browserJsonRequest('/api/v1/auth/session/logout', {}),
    )

    expect(response.status).toBe(200)
    expect(revokeSession).toHaveBeenCalledWith(SESSION)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    await expect(response.json()).resolves.toEqual({ session: null })
  })

  it('issues a narrowly scoped delegated credential and returns its bearer secret once', async () => {
    const response = await createManagementRoutes(dependencies).issueDelegatedToken(
      browserJsonRequest('/api/v1/auth/delegated-tokens', {
        scopes: ['knowledge:read'],
        expiresInSeconds: 900,
      }),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(issueDelegated).toHaveBeenCalledWith({
      issuer: context,
      scopes: ['knowledge:read'],
      ttlMilliseconds: 900_000,
    })
    const body = await response.text()
    expect(body.match(/tpc_delegated_secret_value_1234567890/g)).toHaveLength(1)
  })

  it('rejects duplicate scopes, extra fields, bearer management, and non-JSON bodies', async () => {
    const routes = createManagementRoutes(dependencies)
    const duplicate = await routes.issueDelegatedToken(
      browserJsonRequest('/api/v1/auth/delegated-tokens', {
        scopes: ['knowledge:read', 'knowledge:read'],
      }),
    )
    const extra = await routes.issueDelegatedToken(
      browserJsonRequest('/api/v1/auth/delegated-tokens', {
        scopes: ['knowledge:read'],
        organizationId: 'org_hostile_01',
      }),
    )
    const bearer = await routes.issueDelegatedToken(
      jsonRequest(
        '/api/v1/auth/delegated-tokens',
        { scopes: ['knowledge:read'] },
        { authorization: 'Bearer delegated.token.value_1234567890', origin: ORIGIN },
      ),
    )
    const unsupported = await routes.issueDelegatedToken(
      new Request(`${ORIGIN}/api/v1/auth/delegated-tokens`, {
        method: 'POST',
        headers: browserHeaders({ 'content-type': 'text/plain' }),
        body: '{}',
      }),
    )

    expect(duplicate.status).toBe(422)
    expect(extra.status).toBe(422)
    expect(bearer.status).toBe(401)
    expect(unsupported.status).toBe(415)
    expect(issueDelegated).not.toHaveBeenCalled()
  })

  it('revokes one delegated token through a bodyless browser-only DELETE', async () => {
    const response = await createManagementRoutes(dependencies).revokeDelegatedToken(
      bodylessBrowserRequest(`/api/v1/auth/delegated-tokens/${TOKEN_ID}`, 'DELETE'),
      TOKEN_ID,
    )

    expect(response.status).toBe(200)
    expect(revokeDelegated).toHaveBeenCalledWith({ issuer: context, tokenId: TOKEN_ID })
    await expect(response.json()).resolves.toEqual({ revoked: true })
  })

  it('creates an idempotent queued mission through the guarded browser boundary', async () => {
    const response = await createManagementRoutes(dependencies).createMission(
      browserJsonRequest('/api/v1/missions', {
        requestId: 'homecoming_2026_08_14',
        palaceId: 'pal_management_01',
        objective: 'Create a safe and energy-bounded night-shift homecoming routine.',
        constraints: {
          preheatBy: '02:00',
          requireVerifiedIdentityForUnlock: true,
          pathwayLightingBeginsAfter: 'verified_arrival',
          projectedBatteryUseMaxPercentagePoints: 15,
        },
        successCriteriaIds: ['temperature_ready', 'identity_verified'],
      }),
    )

    expect(response.status).toBe(201)
    expect(createMission).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        requestId: 'homecoming_2026_08_14',
        palaceId: 'pal_management_01',
      }),
    )
    await expect(response.json()).resolves.toMatchObject({
      result: 'created',
      mission: { state: { status: 'queued', phase: 'understand' }, version: 0 },
    })
  })

  it('discovers a pending human decision from the authenticated mission inbox', async () => {
    const inbox = missionTaskInboxResult()
    const response = await createManagementRoutes(dependencies).getMissionTasks(
      new Request(`http://0.0.0.0:3000/api/v1/missions/${inbox.mission.id}/tasks`, {
        method: 'GET',
        headers: browserHeaders(),
      }),
      inbox.mission.id,
    )

    expect(response.status).toBe(200)
    expect(getMissionTasks).toHaveBeenCalledWith(context, inbox.mission.id)
    await expect(response.json()).resolves.toEqual({
      mission: {
        id: inbox.mission.id,
        state: inbox.mission.state,
        version: inbox.mission.version,
      },
      clarification: { id: inbox.clarification?.id, status: 'pending' },
      approval: null,
    })
  })

  it('does not treat approval as a tool and projects no nonce or protected internals', async () => {
    const response = await createManagementRoutes(dependencies).decideApproval(
      browserJsonRequest(`/api/v1/approvals/${APPROVAL_ID}/decision`, {
        nonce: 'approval_nonce_value_1234567890',
        decision: 'approve',
      }),
      APPROVAL_ID,
    )

    expect(response.status).toBe(200)
    expect(decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        approvalId: APPROVAL_ID,
        decision: 'approve',
        nonce: 'approval_nonce_value_1234567890',
      }),
    )
    const body = await response.text()
    expect(body).not.toContain('approval_nonce_value_1234567890')
    expect(body).not.toContain('protectedResources')
    expect(JSON.parse(body)).toMatchObject({ decision: 'approved' })
  })

  it('loads the authenticated approval task with its exact decision nonce', async () => {
    const task = approvalTaskResult()
    const response = await createManagementRoutes(dependencies).getApproval(
      bodylessBrowserRequest(`/api/v1/approvals/${task.approval.id}`, 'GET'),
      task.approval.id,
    )

    expect(response.status).toBe(200)
    expect(getApproval).toHaveBeenCalledWith(context, task.approval.id)
    await expect(response.json()).resolves.toMatchObject({
      approval: { id: task.approval.id, nonce: task.approval.nonce },
      plan: { id: task.plan.id, actions: task.plan.actions },
      mission: { id: task.mission.id, version: task.mission.version },
    })
  })

  it('loads and answers one bounded clarification through the human mutation guard', async () => {
    const taskResponse = await createManagementRoutes(dependencies).getClarification(
      bodylessBrowserRequest(`/api/v1/clarifications/${CLARIFICATION_ID}`, 'GET'),
      CLARIFICATION_ID,
    )
    const answerResponse = await createManagementRoutes(dependencies).answerClarification(
      browserJsonRequest(`/api/v1/clarifications/${CLARIFICATION_ID}/answer`, {
        choiceId: 'energy_first',
        expectedMissionVersion: 5,
      }),
      CLARIFICATION_ID,
    )

    expect(taskResponse.status).toBe(200)
    expect(answerResponse.status).toBe(200)
    expect(getClarification).toHaveBeenCalledWith(context, CLARIFICATION_ID)
    expect(answerClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        requestId: CLARIFICATION_ID,
        choiceId: 'energy_first',
        expectedMissionVersion: 5,
        evidenceRefs: [],
      }),
    )
    expect(answerClarification.mock.calls[0]?.[0].idempotencyKey).toMatch(/^[a-f0-9]{64}$/)
    await expect(taskResponse.json()).resolves.toMatchObject({
      request: { id: CLARIFICATION_ID, status: 'pending' },
      answer: null,
      mission: { version: 5 },
    })
    await expect(answerResponse.json()).resolves.toMatchObject({
      result: 'answered',
      answer: { choiceId: 'energy_first' },
      mission: { version: 6 },
    })
  })

  it('rejects query parameters and invalid resource IDs without echoing them', async () => {
    const routes = createManagementRoutes(dependencies)
    const query = await routes.rotateSession(
      browserJsonRequest('/api/v1/auth/session/rotate?next=https://hostile.example', {}),
    )
    const invalid = await routes.revokeDelegatedToken(
      bodylessBrowserRequest('/api/v1/auth/delegated-tokens/private-value', 'DELETE'),
      'private-value',
    )

    expect(query.status).toBe(400)
    expect(invalid.status).toBe(404)
    expect(await query.text()).not.toContain('hostile.example')
    expect(await invalid.text()).not.toContain('private-value')
  })
})

function issued(signedCookie: string): IssuedSession {
  return { signedCookie, context }
}

function jsonRequest(
  path: string,
  body: unknown,
  additionalHeaders: Record<string, string> = {},
): Request {
  return new Request(new URL(path, ORIGIN), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: new URL(ORIGIN).host,
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
  })
}

function browserJsonRequest(path: string, body: unknown): Request {
  return jsonRequest(path, body, browserHeaders())
}

function bodylessBrowserRequest(path: string, method: string): Request {
  return new Request(new URL(path, ORIGIN), { method, headers: browserHeaders() })
}

function browserHeaders(additional: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${SESSION}`,
    host: new URL(ORIGIN).host,
    origin: ORIGIN,
    'x-csrf-token': CSRF,
    ...additional,
  }
}

function approvalResult(): ApprovalDecisionResult {
  return {
    status: 'approved',
    approval: {
      id: APPROVAL_ID,
      organizationId: principal.organizationId,
      missionId: 'mis_management_01',
      planId: 'pln_management_01',
      planHash: 'a'.repeat(64),
      status: 'approved',
      actionIds: ['act_management_01'],
      protectedResources: [],
      requestedBy: principal.actorId,
      approvedBy: principal.actorId,
      approverRole: 'owner',
      nonce: 'approval_nonce_value_1234567890',
      createdAt: '2026-08-14T05:00:00.000Z',
      approvedAt: '2026-08-14T05:01:00.000Z',
      expiresAt: '2026-08-14T05:15:00.000Z',
    },
    operations: [
      {
        id: 'op_management_01',
        organizationId: principal.organizationId,
        missionId: 'mis_management_01',
        planId: 'pln_management_01',
        actionId: 'act_management_01',
        approvalId: APPROVAL_ID,
        payloadHash: 'b'.repeat(64),
        status: 'pending',
        outcome: null,
        createdAt: '2026-08-14T05:01:00.000Z',
      },
    ],
    mission: {
      id: 'mis_management_01',
      organizationId: principal.organizationId,
      palaceId: 'pal_management_01',
      initiatedBy: principal.actorId,
      objective: 'Return home safely',
      constraints: [],
      successCriteria: [],
      state: { status: 'running', phase: 'execute' },
      version: 4,
      createdAt: '2026-08-14T05:00:00.000Z',
      updatedAt: '2026-08-14T05:01:00.000Z',
    },
  } as unknown as ApprovalDecisionResult
}

function approvalTaskResult(): HumanApprovalTask {
  return {
    approval: {
      ...approvalResult().approval,
      status: 'pending',
      approvedBy: null,
      approverRole: null,
      approvedAt: null,
      protectedResources: [
        {
          routineId: 'rtn_management_01',
          routineVersionId: 'rtv_management_01',
          version: 1,
        },
      ],
    },
    plan: {
      id: 'pln_management_01',
      organizationId: principal.organizationId,
      missionId: 'mis_management_01',
      palaceId: 'pal_management_01',
      revision: 1,
      hash: 'a'.repeat(64),
      status: 'awaiting_approval',
      objective: 'Replace the overlapping homecoming routine safely.',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      actions: [
        {
          id: 'act_management_01',
          type: 'replace_homecoming_routine',
          palaceId: 'pal_management_01',
          protectedRoutineId: 'rtn_management_01',
          protectedRoutineVersionId: 'rtv_management_01',
          expectedProtectedVersion: 1,
          replacementRoutineId: 'rtn_replacement_01',
          replacementRoutineVersionId: 'rtv_replacement_01',
          replacement: {
            name: 'Night Shift Homecoming',
            trigger: {
              type: 'verified_arrival',
              windowStart: '00:00',
              windowEnd: '03:00',
              timezone: 'America/New_York',
            },
            actions: [
              { type: 'preheat', targetCelsius: 20, completeBy: '02:00' },
              {
                type: 'pathway_lighting',
                intensityPercent: 40,
                durationSeconds: 900,
                beginsAfter: 'verified_arrival',
              },
              { type: 'unlock', durationSeconds: 90, requireVerifiedIdentity: true },
              { type: 'lock_desired_state', afterUnlockSeconds: 90 },
            ],
            constraints: {
              projectedBatteryUseMaxPercentagePoints: 15,
              hardInvariantIds: ['verified_identity_required_for_unlock'],
            },
            projectedBatteryUsePercentagePoints: 13.2,
          },
        },
      ],
      successCriteriaIds: ['verified_homecoming'],
      createdAt: '2026-08-14T05:00:00.000Z',
    },
    mission: {
      ...clarificationTaskResult().mission,
      state: { status: 'waiting_for_user', phase: 'approve' },
      version: 5,
    },
  } as unknown as HumanApprovalTask
}

function missionTaskInboxResult(): HumanMissionTaskInbox {
  const task = clarificationTaskResult()
  return {
    mission: task.mission,
    clarification: task.request,
    approval: null,
  }
}

function clarificationTaskResult(): HumanClarificationTask {
  return {
    request: {
      schemaVersion: 'clarification-request@1',
      id: CLARIFICATION_ID,
      organizationId: principal.organizationId,
      missionId: 'mis_management_01',
      requestedBy: principal.actorId,
      question: 'Should the run preserve the energy ceiling or prioritize earlier comfort?',
      choices: [
        {
          id: 'energy_first',
          label: 'Energy first',
          description: 'Preserve the mission battery ceiling and begin preheating later.',
        },
        {
          id: 'comfort_first',
          label: 'Comfort first',
          description: 'Start earlier without weakening the mission battery ceiling.',
        },
      ],
      evidenceRefs: [],
      idempotencyKey: 'c'.repeat(64),
      payloadHash: 'd'.repeat(64),
      status: 'pending',
      requestedAt: '2026-08-14T05:00:00.000Z',
      resolvedAt: null,
    },
    answer: null,
    mission: {
      id: 'mis_management_01',
      organizationId: principal.organizationId,
      palaceId: 'pal_management_01',
      initiatedBy: principal.actorId,
      objective: 'Return home safely',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      successCriteriaIds: ['verified_homecoming'],
      state: { status: 'waiting_for_user', phase: 'plan' },
      version: 5,
      runId: 'run_management_01',
      contextReceiptId: 'ctx_management_01',
      taskLedger: [],
      createdAt: '2026-08-14T05:00:00.000Z',
      updatedAt: '2026-08-14T05:00:00.000Z',
    },
  } as unknown as HumanClarificationTask
}

function clarificationAnswerResult(): ClarificationAnswerResult {
  const task = clarificationTaskResult()
  return {
    kind: 'answered',
    request: {
      ...task.request,
      status: 'answered',
      resolvedAt: '2026-08-14T05:01:00.000Z',
    },
    answer: {
      schemaVersion: 'clarification-answer@1',
      id: 'cla_management_01',
      organizationId: principal.organizationId,
      missionId: task.mission.id,
      requestId: task.request.id,
      choiceId: 'energy_first',
      answeredBy: principal.actorId,
      evidenceRefs: [],
      idempotencyKey: 'e'.repeat(64),
      payloadHash: 'f'.repeat(64),
      answeredAt: '2026-08-14T05:01:00.000Z',
    },
    mission: {
      ...task.mission,
      state: { status: 'running', phase: 'plan' },
      version: 6,
    },
  } as unknown as ClarificationAnswerResult
}

function missionBootstrapResult(): MissionBootstrapResult {
  return {
    kind: 'created',
    mission: {
      ...clarificationTaskResult().mission,
      state: { status: 'queued', phase: 'understand' },
      version: 0,
      runId: null,
      contextReceiptId: null,
    },
  }
}
