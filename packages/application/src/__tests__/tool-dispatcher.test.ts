import {
  PrincipalSchema,
  MissionIdSchema,
  TOOL_REGISTRY,
  ToolCallIdSchema,
  ToolNameSchema,
  ToolCallReceiptSchema,
  UserIdSchema,
  hashToolValue,
  principalHasPermission,
  type OrganizationId,
  type Permission,
  type ProductRole,
  type ReceiptId,
  type Sha256,
  type ToolCallId,
  type ToolCallReceipt,
  type ToolName,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { OpaqueMissionFenceToken, type MissionExecutionContext } from '../mission-fence.js'
import type { AuthContext, DelegatedAuthContext } from '../models.js'
import type { EntropyPort, ToolCallReceiptRepositoryPort } from '../ports.js'
import { RepositoryToolInvocationPolicy } from '../tool-invocation-policy.js'
import {
  ToolInvocationReconciliationEvidenceService,
  type ToolInvocationReconciliationEvidencePort,
} from '../tool-invocation-reconciliation-evidence-service.js'
import {
  AuthenticatedToolDispatcher,
  HmacToolInvocationScopeHasher,
  ToolInvocationIdentityConflictError,
  type AuthenticatedToolHostContext,
  type AuthenticatedToolIdentity,
  type ToolCallReceiptRepositoryResolverPort,
  type ToolDispatcherDependencies,
  type ToolHandlerRegistry,
} from '../tool-dispatcher.js'
import {
  ToolInvocationIdentityConflictError as LedgerIdentityConflictError,
  type ToolInvocationBinding,
  type ToolInvocationClaimInput,
  type ToolInvocationClaimResult,
  type ToolInvocationClaimedRecord,
  type ToolInvocationCompletedRecord,
  type ToolInvocationCompletionInput,
  type ToolInvocationCompletionResult,
  type ToolInvocationLedgerPort,
} from '../tool-invocation-ledger.js'
import type { ToolInvocationPolicyPort } from '../tool-invocation-policy.js'
import { InMemoryApplicationStore, MutableClock, SequentialIdGenerator } from '../testing/fakes.js'
import {
  IDS,
  NOW,
  makeAction,
  makeMission,
  makeOperation,
  makePalace,
  makePlan,
} from './fixtures.js'

const CLOCK_AT = '2026-08-14T05:40:00.000Z'
const HMAC_KEY = 'test-only-scope-key-which-is-longer-than-thirty-two-bytes'
const HOME_ACTION = makeAction()
if (HOME_ACTION.type !== 'replace_homecoming_routine') {
  throw new TypeError('The dispatcher fixture requires a replacement action')
}

const ROUTINE = {
  id: IDS.protectedRoutine,
  organizationId: IDS.organization,
  palaceId: IDS.palace,
  name: 'Midnight homecoming',
  activeVersionId: IDS.protectedVersion,
  createdAt: NOW,
} as const
const ROUTINE_VERSION = {
  id: IDS.protectedVersion,
  routineId: IDS.protectedRoutine,
  organizationId: IDS.organization,
  version: 3,
  status: 'active',
  definition: HOME_ACTION.replacement,
  sourcePlanId: null,
  sourcePlanHash: null,
  createdAt: NOW,
} as const

const TOOL_INPUTS = {
  'palaces.get': { palaceId: IDS.palace },
  'crews.list': { palaceId: IDS.palace },
  'capabilities.list': { palaceId: IDS.palace },
  'routines.list': { palaceId: IDS.palace },
  'routines.get': { routineId: IDS.protectedRoutine },
  'executions.list': { missionId: IDS.mission },
  'knowledge.search': { query: 'safe homecoming', phase: 'understand' },
  'plans.propose': {
    missionId: IDS.mission,
    revision: 1,
    actions: [HOME_ACTION],
    successCriteriaIds: ['homecoming_completed'],
  },
  'plans.validate': { planId: IDS.plan },
  'plans.simulate': { planId: IDS.plan, scenarios: ['timing'] },
  'plans.request_approval': { planId: IDS.plan },
  'plans.activate': { planId: IDS.plan, actionId: IDS.action, expectedVersion: 3 },
  'operations.get': { operationId: makeOperation().id },
  'verification.get_evidence': { missionId: IDS.mission },
  'missions.cancel': { missionId: IDS.mission, reason: 'Founder cancelled the run' },
} as const satisfies Record<ToolName, unknown>

const TOOL_OUTPUTS = {
  'palaces.get': { palace: makePalace() },
  'crews.list': { crew: [], identityTags: [], schedules: [], preferences: [] },
  'capabilities.list': { devices: [], capabilities: [] },
  'routines.list': { routines: [ROUTINE], versions: [ROUTINE_VERSION] },
  'routines.get': { routine: ROUTINE, version: ROUTINE_VERSION },
  'executions.list': { executions: [] },
  'knowledge.search': {
    results: [
      {
        sourceId: 'knowledge/homecoming.md',
        version: 'sha256:fixture',
        title: 'Homecoming safety',
        excerpt: 'Validate identity before unlocking.',
      },
    ],
  },
  'plans.propose': { plan: makePlan('candidate') },
  'plans.validate': {
    valid: true,
    checks: [{ type: 'hard_invariant', passed: true, message: 'Hard invariants hold.' }],
  },
  'plans.simulate': {
    feasible: true,
    projectedBatteryUsePercentagePoints: 13.2,
    results: [{ scenario: 'timing', passed: true, evidence: 'Arrival window is feasible.' }],
  },
  'plans.request_approval': { approvalRequestId: 'apr_approval0001', paused: true },
  'plans.activate': { operation: makeOperation(), durableRoutineId: null },
  'operations.get': { operation: makeOperation(), attempts: [] },
  'verification.get_evidence': { evidence: [] },
  'missions.cancel': { missionId: IDS.mission, state: makeMission().state },
} as const satisfies Record<ToolName, unknown>

describe('authenticated tool dispatcher', () => {
  it('routes all fifteen tools through one permission gate and exact output boundary', async () => {
    const calls = new Map<ToolName, number>()
    const harness = createHarness({
      handlers: handlerRegistry(async (toolName) => {
        calls.set(toolName, (calls.get(toolName) ?? 0) + 1)
        return succeeded(toolName)
      }),
    })

    for (const role of ['owner', 'operator', 'viewer', 'service'] as const) {
      const authentication = session(role)
      for (const toolName of ToolNameSchema.options) {
        const result = await harness.dispatcher.invoke(
          {
            callId: matrixCallId(role, toolName),
            toolName,
            input: TOOL_INPUTS[toolName],
          },
          host(authentication),
        )
        const allowed = principalHasPermission(
          authentication.principal,
          TOOL_REGISTRY[toolName].permission,
        )
        expect(result.status, `${role} ${toolName}`).toBe(allowed ? 'succeeded' : 'denied')
        if (!allowed) expect(result.error?.code).toBe('PERMISSION_DENIED')
      }
    }

    for (const toolName of ToolNameSchema.options) {
      const authentication = delegated(TOOL_REGISTRY[toolName].permission)
      const result = await harness.dispatcher.invoke(
        {
          callId: matrixCallId('delegated', toolName),
          toolName,
          input: TOOL_INPUTS[toolName],
        },
        host(authentication),
      )
      expect(result.status, `delegated ${toolName}`).toBe('succeeded')
      expect(calls.get(toolName)).toBeGreaterThan(0)
    }

    expect(ToolNameSchema.options).toHaveLength(15)
  })

  it('rejects strict-schema violations before policy or handler execution', async () => {
    let policyCalls = 0
    let handlerCalls = 0
    const harness = createHarness({
      policy: {
        authorize: async () => {
          policyCalls += 1
          return makeMission({ status: 'running', phase: 'understand' })
        },
      },
      handlers: handlerRegistry(async (toolName) => {
        handlerCalls += 1
        return succeeded(toolName)
      }),
    })

    const result = await harness.dispatcher.invoke(
      {
        callId: 'call_strict_input_01',
        toolName: 'palaces.get',
        input: { palaceId: IDS.palace, organizationId: IDS.organization },
      },
      host(session('owner')),
    )

    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      error: { code: 'INVALID_INPUT', details: {} },
    })
    expect(policyCalls).toBe(0)
    expect(handlerCalls).toBe(0)
  })

  it('makes missing and cross-tenant mission references observationally identical', async () => {
    const store = new InMemoryApplicationStore({ missions: [makeMission()] })
    const harness = createHarness({ policy: new RepositoryToolInvocationPolicy(store) })
    const authentication = session('owner', true)

    const crossTenant = await harness.dispatcher.invoke(
      {
        callId: 'call_cross_tenant_01',
        toolName: 'palaces.get',
        input: TOOL_INPUTS['palaces.get'],
      },
      host(authentication, IDS.mission),
    )
    const missing = await harness.dispatcher.invoke(
      {
        callId: 'call_missing_tenant_01',
        toolName: 'palaces.get',
        input: TOOL_INPUTS['palaces.get'],
      },
      host(authentication, 'mis_absent000001'),
    )

    expect(projectFailure(crossTenant)).toEqual(projectFailure(missing))
    expect(projectFailure(crossTenant)).toEqual({
      status: 'failed',
      retryable: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'The requested resource is unavailable.',
        details: {},
      },
    })
    const replay = await harness.dispatcher.invoke(
      {
        callId: 'call_cross_tenant_01',
        toolName: 'palaces.get',
        input: TOOL_INPUTS['palaces.get'],
      },
      host(authentication, IDS.mission),
    )
    expect(replay).toEqual(crossTenant)
    expect((await harness.evidenceStore.snapshot()).evidence).toEqual([])
  })

  it('enforces the registry mission phase before service dispatch', async () => {
    let handlerCalls = 0
    const store = new InMemoryApplicationStore({
      missions: [makeMission({ status: 'running', phase: 'understand' })],
    })
    const harness = createHarness({
      policy: new RepositoryToolInvocationPolicy(store),
      handlers: handlerRegistry(async (toolName) => {
        handlerCalls += 1
        return succeeded(toolName)
      }),
    })

    const result = await harness.dispatcher.invoke(
      {
        callId: 'call_wrong_phase_0001',
        toolName: 'plans.activate',
        input: TOOL_INPUTS['plans.activate'],
      },
      host(session('owner')),
    )

    expect(result).toMatchObject({
      status: 'denied',
      retryable: false,
      error: { code: 'MISSION_PHASE_DENIED', details: {} },
    })
    expect(handlerCalls).toBe(0)
  })

  it('keeps an active duplicate pending, then replays the exact terminal result', async () => {
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let handlerCalls = 0
    const harness = createHarness({
      handlers: handlerRegistry(async (toolName) => {
        handlerCalls += 1
        markStarted?.()
        await blocked
        return succeeded(toolName)
      }),
    })
    const request = {
      callId: 'call_concurrent_read_01',
      toolName: 'palaces.get',
      input: TOOL_INPUTS['palaces.get'],
    } as const
    const invocation = harness.dispatcher.invoke(request, host(session('owner')))
    await started

    const duplicate = await harness.dispatcher.invoke(request, host(session('owner')))
    expect(duplicate).toMatchObject({
      status: 'pending',
      retryable: true,
      error: { code: 'CALL_IN_PROGRESS' },
    })
    expect(harness.receipts.all()).toEqual([])

    release?.()
    const completed = await invocation
    const replay = await harness.dispatcher.invoke(request, host(session('owner')))
    expect(replay).toEqual(completed)
    expect(handlerCalls).toBe(1)
    expect(harness.receipts.all()).toHaveLength(1)
  })

  it('replays across service lease turnover but conflicts on a different service actor', async () => {
    let handlerCalls = 0
    const harness = createHarness({
      handlers: handlerRegistry(async (toolName) => {
        handlerCalls += 1
        return succeeded(toolName)
      }),
    })
    const request = {
      callId: 'call_service_replay_01',
      toolName: 'palaces.get',
      input: TOOL_INPUTS['palaces.get'],
    } as const

    const first = await harness.dispatcher.invoke(
      request,
      host(missionService('worker-before-restart', 1)),
    )
    const replay = await harness.dispatcher.invoke(
      request,
      host(missionService('worker-after-restart', 2)),
    )
    expect(replay).toEqual(first)
    expect(handlerCalls).toBe(1)

    await expect(
      harness.dispatcher.invoke(
        request,
        host(
          missionService('worker-different-actor', 3, UserIdSchema.parse('usr_other_service01')),
        ),
      ),
    ).rejects.toBeInstanceOf(ToolInvocationIdentityConflictError)
  })

  it('marks an abandoned consequential call unknown instead of executing it twice', async () => {
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let handlerCalls = 0
    const harness = createHarness({
      handlers: handlerRegistry(async (toolName) => {
        handlerCalls += 1
        markStarted?.()
        await blocked
        return succeeded(toolName)
      }),
    })
    const request = {
      callId: 'call_abandoned_write_01',
      toolName: 'plans.activate',
      input: TOOL_INPUTS['plans.activate'],
    } as const
    const original = harness.dispatcher.invoke(
      request,
      host(missionService('worker-before-timeout', 1)),
    )
    await started
    harness.clock.advance(1_000)

    const reconciler = await harness.dispatcher.invoke(
      request,
      host(missionService('worker-after-timeout', 2)),
    )
    expect(reconciler).toMatchObject({
      status: 'unknown',
      retryable: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    })
    expect(handlerCalls).toBe(1)
    const [reconciliation] = (await harness.evidenceStore.snapshot()).evidence
    expect(reconciliation?.evidence).toMatchObject({
      type: 'tool_invocation_reconciliation',
      toolCallId: request.callId,
      toolName: request.toolName,
      abandonedClaimGeneration: 1,
      reconciledOutcome: 'still_unknown',
      observer: 'application_code',
      source: 'tool_invocation_ledger',
    })

    release?.()
    expect((await original).status).toBe('pending')
    expect(
      await harness.dispatcher.invoke(request, host(missionService('worker-replay', 3))),
    ).toEqual(reconciler)
    expect(handlerCalls).toBe(1)
  })

  it('stays pending when durable reconciliation evidence cannot be recorded', async () => {
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const unavailableEvidence: ToolInvocationReconciliationEvidencePort = {
      recordStillUnknown: async () => {
        throw new Error('evidence store unavailable')
      },
    }
    let handlerCalls = 0
    const harness = createHarness({
      reconciliationEvidence: unavailableEvidence,
      handlers: handlerRegistry(async (toolName) => {
        handlerCalls += 1
        markStarted?.()
        await blocked
        return succeeded(toolName)
      }),
    })
    const request = {
      callId: 'call_reconcile_wait_01',
      toolName: 'plans.request_approval',
      input: TOOL_INPUTS['plans.request_approval'],
    } as const
    const original = harness.dispatcher.invoke(request, host(session('owner')))
    await started
    harness.clock.advance(1_000)

    const recovery = await harness.dispatcher.invoke(request, host(session('owner')))
    expect(recovery).toMatchObject({
      status: 'pending',
      retryable: true,
      error: { code: 'RECONCILIATION_PENDING' },
    })
    expect(handlerCalls).toBe(1)
    expect(harness.receipts.all()).toEqual([])

    release?.()
    expect((await original).status).toBe('pending')
  })

  it('fails closed on malformed handler data and replays only the safe failure', async () => {
    let calls = 0
    const harness = createHarness({
      handlers: handlerRegistry(async () => {
        calls += 1
        return { status: 'succeeded', data: { palace: makePalace(), leaked: 'raw service data' } }
      }),
    })
    const request = {
      callId: 'call_bad_handler_001',
      toolName: 'palaces.get',
      input: TOOL_INPUTS['palaces.get'],
    } as const

    const first = await harness.dispatcher.invoke(request, host(session('owner')))
    const replay = await harness.dispatcher.invoke(request, host(session('owner')))
    expect(first).toMatchObject({
      status: 'failed',
      retryable: false,
      data: null,
      error: { code: 'MALFORMED_HANDLER_OUTPUT', details: {} },
    })
    expect(replay).toEqual(first)
    expect(JSON.stringify(replay)).not.toContain('raw service data')
    expect(calls).toBe(1)
  })

  it('rejects an unreferenced unknown outcome from a service handler', async () => {
    const harness = createHarness({
      handlers: handlerRegistry(async () => ({
        status: 'unknown',
        retryable: true,
        data: null,
        error: { code: 'UPSTREAM_UNKNOWN', message: 'Upstream outcome is unclear.', details: {} },
      })),
    })

    const result = await harness.dispatcher.invoke(
      {
        callId: 'call_unproven_unknown1',
        toolName: 'plans.activate',
        input: TOOL_INPUTS['plans.activate'],
      },
      host(session('owner')),
    )

    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      error: { code: 'MALFORMED_HANDLER_OUTPUT' },
    })
  })

  it('binds replay to the exact tool, input, channel, mission, and principal', async () => {
    const harness = createHarness()
    const callId = 'call_bound_identity_01'
    const request = { callId, toolName: 'palaces.get', input: TOOL_INPUTS['palaces.get'] } as const
    await harness.dispatcher.invoke(request, host(session('owner')))

    const conflicts = [
      harness.dispatcher.invoke(
        { ...request, input: { palaceId: 'pal_other000001' } },
        host(session('owner')),
      ),
      harness.dispatcher.invoke(request, { ...host(session('owner')), channel: 'mcp' }),
      harness.dispatcher.invoke(request, host(session('owner'), 'mis_other0000001')),
      harness.dispatcher.invoke(request, host(session('viewer'))),
    ]
    for (const conflict of conflicts) {
      await expect(conflict).rejects.toBeInstanceOf(ToolInvocationIdentityConflictError)
    }
  })

  it('stores append-only receipts without tenant, principal, prompt, or result bodies', async () => {
    const harness = createHarness()
    const authentication = delegated('knowledge:read')
    const secretQuery = 'Bearer phx_secret_should_never_reach_receipt'
    const result = await harness.dispatcher.invoke(
      {
        callId: 'call_receipt_redact_01',
        toolName: 'knowledge.search',
        input: { query: secretQuery, phase: 'understand' },
      },
      host(authentication),
    )
    expect(result.status).toBe('succeeded')

    const [receipt] = harness.receipts.all()
    expect(ToolCallReceiptSchema.parse(receipt)).toEqual(receipt)
    const serialized = JSON.stringify(receipt)
    for (const sensitive of [
      IDS.organization,
      IDS.owner,
      authentication.tokenId,
      secretQuery,
      'Homecoming safety',
    ]) {
      expect(serialized).not.toContain(sensitive)
    }
    expect(receipt).not.toHaveProperty('organizationId')
    expect(receipt).not.toHaveProperty('principal')
    expect(receipt).not.toHaveProperty('input')
    expect(receipt).not.toHaveProperty('result')
    expect(receipt?.tenantScopeHash).not.toBe(hashToolValue(IDS.organization))
  })
})

function createHarness(
  overrides: Partial<
    Pick<ToolDispatcherDependencies, 'handlers' | 'policy' | 'reconciliationEvidence'>
  > = {},
): {
  readonly dispatcher: AuthenticatedToolDispatcher
  readonly ledger: MemoryToolInvocationLedger
  readonly receipts: MemoryReceiptResolver
  readonly clock: MutableClock
  readonly evidenceStore: InMemoryApplicationStore
} {
  const clock = new MutableClock(new Date(CLOCK_AT))
  const ledger = new MemoryToolInvocationLedger()
  const receipts = new MemoryReceiptResolver()
  const mission = makeMission({ status: 'running', phase: 'understand' })
  const evidenceStore = new InMemoryApplicationStore(
    { missions: [mission], palaces: [makePalace()] },
    clock,
  )
  const policy: ToolInvocationPolicyPort = {
    authorize: async () => mission,
  }
  return {
    clock,
    ledger,
    receipts,
    evidenceStore,
    dispatcher: new AuthenticatedToolDispatcher({
      ledger,
      receipts,
      policy: overrides.policy ?? policy,
      handlers: overrides.handlers ?? handlerRegistry(async (toolName) => succeeded(toolName)),
      reconciliationEvidence:
        overrides.reconciliationEvidence ??
        new ToolInvocationReconciliationEvidenceService(
          evidenceStore,
          clock,
          new SequentialIdGenerator(),
        ),
      scopes: new HmacToolInvocationScopeHasher(HMAC_KEY),
      clock,
      entropy: new SequentialEntropy(),
      claimTtlMilliseconds: 1_000,
    }),
  }
}

function handlerRegistry(invoke: (toolName: ToolName) => Promise<unknown>): ToolHandlerRegistry {
  return Object.fromEntries(
    ToolNameSchema.options.map((toolName) => [toolName, async () => invoke(toolName)]),
  ) as unknown as ToolHandlerRegistry
}

function succeeded(toolName: ToolName): unknown {
  return { status: 'succeeded', data: TOOL_OUTPUTS[toolName] }
}

function host(
  authentication: AuthenticatedToolIdentity,
  missionId: string = IDS.mission,
): AuthenticatedToolHostContext {
  return {
    authentication,
    missionId: MissionId(missionId),
    channel: 'http',
    signal: new AbortController().signal,
  }
}

function session(role: Exclude<ProductRole, 'delegated'>, foreign = false): AuthContext {
  return {
    sessionId: `session_${role}_1234567890123456`,
    principal: PrincipalSchema.parse({
      organizationId: foreign ? IDS.otherOrganization : IDS.organization,
      actorId: IDS.owner,
      role,
      operatorGrants: [],
      delegatedPermissions: [],
    }),
    csrfToken: 'csrf_dispatcher_fixture_1234567890',
    issuedAt: NOW,
    expiresAt: '2026-08-14T13:35:00.000Z',
    authenticatedAt: NOW,
  }
}

function delegated(permission: Permission): DelegatedAuthContext {
  return {
    tokenId: `tok_${permission.replaceAll(':', '_')}_fixture`,
    principal: PrincipalSchema.parse({
      organizationId: IDS.organization,
      actorId: IDS.owner,
      role: 'delegated',
      operatorGrants: [],
      delegatedPermissions: [permission],
    }),
    expiresAt: '2026-08-14T13:35:00.000Z',
  }
}

function missionService(
  ownerId: string,
  epoch: number,
  actorId = IDS.service,
): MissionExecutionContext {
  return {
    fence: {
      organizationId: IDS.organization,
      missionId: IDS.mission,
      ownerId,
      epoch,
      token: OpaqueMissionFenceToken.fromEntropy(
        `tool_dispatcher_fence_${ownerId}_${String(epoch)}_entropy`,
      ),
    },
    signal: new AbortController().signal,
    principal: PrincipalSchema.parse({
      organizationId: IDS.organization,
      actorId,
      role: 'service',
      operatorGrants: [],
      delegatedPermissions: [],
    }),
  }
}

function matrixCallId(role: ProductRole, toolName: ToolName): ToolCallId {
  return ToolCallIdSchema.parse(`call_${role}_${toolName.replaceAll('.', '_')}`)
}

function projectFailure(result: {
  readonly status: string
  readonly retryable: boolean
  readonly error: unknown
}): { readonly status: string; readonly retryable: boolean; readonly error: unknown } {
  return { status: result.status, retryable: result.retryable, error: result.error }
}

function MissionId(value: string): AuthenticatedToolHostContext['missionId'] {
  return MissionIdSchema.parse(value)
}

class SequentialEntropy implements EntropyPort {
  #sequence = 0

  public token(_bytes: number): string {
    this.#sequence += 1
    return `dispatcher_entropy_${String(this.#sequence).padStart(24, '0')}`
  }
}

type ClaimedInternal = Readonly<{
  state: 'claimed'
  record: ToolInvocationClaimedRecord
  ownerFingerprint: Sha256
}>
type CompletedInternal = Readonly<{ state: 'completed'; record: ToolInvocationCompletedRecord }>

class MemoryToolInvocationLedger implements ToolInvocationLedgerPort {
  readonly #records = new Map<string, ClaimedInternal | CompletedInternal>()

  public claim(input: ToolInvocationClaimInput): Promise<ToolInvocationClaimResult> {
    const key = invocationKey(input.organizationId, input.callId)
    const existing = this.#records.get(key)
    if (existing === undefined) {
      const record = claimedRecord(input, 1, input.proposedReceiptId, input.startedAt)
      this.#records.set(key, {
        state: 'claimed',
        record,
        ownerFingerprint: input.ownerToken.storageFingerprint(),
      })
      return Promise.resolve({ kind: 'claimed', disposition: 'execute', invocation: record })
    }
    assertSameBinding(existing.record, input)
    if (existing.state === 'completed') {
      return Promise.resolve({ kind: 'completed', invocation: existing.record })
    }
    if (Date.parse(existing.record.claimExpiresAt) > Date.parse(input.startedAt)) {
      return Promise.resolve({ kind: 'in_progress', invocation: existing.record })
    }
    const record = claimedRecord(
      input,
      existing.record.generation + 1,
      existing.record.receiptId,
      existing.record.startedAt,
    )
    this.#records.set(key, {
      state: 'claimed',
      record,
      ownerFingerprint: input.ownerToken.storageFingerprint(),
    })
    return input.executionClass === 'read'
      ? Promise.resolve({ kind: 'claimed', disposition: 'execute', invocation: record })
      : Promise.resolve({
          kind: 'claimed',
          disposition: 'resolve_unknown',
          invocation: record,
          abandonedClaim: {
            generation: existing.record.generation,
            claimExpiresAt: existing.record.claimExpiresAt,
          },
        })
  }

  public complete(input: ToolInvocationCompletionInput): Promise<ToolInvocationCompletionResult> {
    const existing = this.#records.get(invocationKey(input.organizationId, input.callId))
    if (
      existing === undefined ||
      existing.state === 'completed' ||
      existing.record.generation !== input.generation ||
      existing.ownerFingerprint !== input.ownerToken.storageFingerprint()
    ) {
      return Promise.resolve({
        kind: 'lost_claim',
        current: existing?.state === 'completed' ? 'completed' : 'in_progress',
      })
    }
    const record: ToolInvocationCompletedRecord = {
      ...bindingFrom(existing.record),
      receiptId: existing.record.receiptId,
      generation: existing.record.generation,
      startedAt: existing.record.startedAt,
      completedAt: input.completedAt,
      resultHash: input.resultHash,
      result: structuredClone(input.result),
      attemptId: input.attemptId,
      evidenceIds: [...input.evidenceIds],
    }
    this.#records.set(invocationKey(input.organizationId, input.callId), {
      state: 'completed',
      record,
    })
    return Promise.resolve({ kind: 'completed', invocation: record })
  }
}

function claimedRecord(
  input: ToolInvocationClaimInput,
  generation: number,
  receiptId: ReceiptId,
  startedAt: string,
): ToolInvocationClaimedRecord {
  return {
    ...bindingFrom(input),
    receiptId,
    generation,
    startedAt,
    claimExpiresAt: input.claimExpiresAt,
  }
}

function bindingFrom(input: ToolInvocationBinding): ToolInvocationBinding {
  return {
    organizationId: input.organizationId,
    missionId: input.missionId,
    principalScopeHash: input.principalScopeHash,
    callId: input.callId,
    toolName: input.toolName,
    channel: input.channel,
    inputHash: input.inputHash,
    toolContractHash: input.toolContractHash,
    toolRegistryHash: input.toolRegistryHash,
    resultSchemaHash: input.resultSchemaHash,
    executionClass: input.executionClass,
  }
}

function assertSameBinding(current: ToolInvocationBinding, requested: ToolInvocationBinding): void {
  if (JSON.stringify(bindingFrom(current)) !== JSON.stringify(bindingFrom(requested))) {
    throw new LedgerIdentityConflictError('Tool call identity is already bound')
  }
}

function invocationKey(organizationId: OrganizationId, callId: ToolCallId): string {
  return `${organizationId}:${callId}`
}

class MemoryReceiptResolver implements ToolCallReceiptRepositoryResolverPort {
  readonly #repositories = new Map<OrganizationId, MemoryReceiptRepository>()

  public forTenant(input: {
    readonly organizationId: OrganizationId
    readonly tenantScopeHash: Sha256
  }): ToolCallReceiptRepositoryPort {
    let repository = this.#repositories.get(input.organizationId)
    if (repository === undefined) {
      repository = new MemoryReceiptRepository(input.tenantScopeHash)
      this.#repositories.set(input.organizationId, repository)
    }
    return repository
  }

  public all(): readonly ToolCallReceipt[] {
    return [...this.#repositories.values()].flatMap((repository) => repository.all())
  }
}

class MemoryReceiptRepository implements ToolCallReceiptRepositoryPort {
  readonly #receipts = new Map<ReceiptId, ToolCallReceipt>()

  public constructor(private readonly tenantScopeHash: Sha256) {}

  public append(receipt: ToolCallReceipt): Promise<void> {
    if (receipt.tenantScopeHash !== this.tenantScopeHash) {
      throw new Error('Tenant scope mismatch')
    }
    const parsed = ToolCallReceiptSchema.parse(receipt)
    const existing = this.#receipts.get(parsed.id)
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error('Receipt identity conflict')
    }
    this.#receipts.set(parsed.id, parsed)
    return Promise.resolve()
  }

  public get(receiptId: ReceiptId): Promise<ToolCallReceipt | null> {
    return Promise.resolve(this.#receipts.get(receiptId) ?? null)
  }

  public findByCallId(callId: ToolCallId): Promise<ToolCallReceipt | null> {
    return Promise.resolve(
      [...this.#receipts.values()].find((receipt) => receipt.callId === callId) ?? null,
    )
  }

  public all(): readonly ToolCallReceipt[] {
    return [...this.#receipts.values()]
  }
}
