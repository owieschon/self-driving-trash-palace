import { describe, expect, it } from 'vitest'

import {
  ActivationContractSchema,
  AttemptSchema,
  InvalidMissionTransitionError,
  LegacyLabOperationSchema,
  MissionEventSchema,
  MissionStateSchema,
  OperationSchema,
  decideOperationReplay,
  resolveMissionTransition,
} from '../index.js'

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('mission transitions', () => {
  it('moves from an acquired lease into understanding', () => {
    expect(
      resolveMissionTransition({ status: 'queued', phase: 'understand' }, 'lease_acquired'),
    ).toEqual({ status: 'running', phase: 'understand' })
  })

  it('keeps the current checkpoint when a lease is lost', () => {
    expect(
      resolveMissionTransition({ status: 'running', phase: 'reconcile' }, 'lease_lost'),
    ).toEqual({ status: 'running', phase: 'reconcile' })
  })

  it('returns to planning when activation discovers stale approved state', () => {
    expect(
      resolveMissionTransition(
        { status: 'running', phase: 'execute' },
        'approval_expired_or_stale',
      ),
    ).toEqual({ status: 'running', phase: 'plan' })
  })

  it('keeps a dispatched cancellation nonterminal until the effect is reconciled', () => {
    expect(
      resolveMissionTransition(
        { status: 'waiting_for_system', phase: 'observe' },
        'cancel_reconciliation_required',
      ),
    ).toEqual({ status: 'running', phase: 'reconcile' })
    expect(
      resolveMissionTransition(
        { status: 'running', phase: 'reconcile' },
        'cancel_reconciliation_completed',
      ),
    ).toEqual({ status: 'cancelled', phase: 'reconcile' })
  })

  it('rejects effect reconciliation from a checkpoint with nothing dispatched', () => {
    expect(() =>
      resolveMissionTransition(
        { status: 'running', phase: 'plan' },
        'cancel_reconciliation_required',
      ),
    ).toThrow(InvalidMissionTransitionError)
  })

  it('rejects an impossible status and phase combination', () => {
    expect(
      MissionStateSchema.safeParse({ status: 'waiting_for_system', phase: 'approve' }).success,
    ).toBe(false)
  })

  it('keeps terminal states immutable', () => {
    expect(() =>
      resolveMissionTransition({ status: 'succeeded', phase: 'verify' }, 'cancel_requested'),
    ).toThrow(InvalidMissionTransitionError)
  })

  it('validates the recorded transition rather than trusting its destination', () => {
    expect(
      MissionEventSchema.safeParse({
        id: 'mev_first_transition',
        missionId: 'mis_night_shift_home',
        organizationId: 'org_rocky_roost',
        sequence: 1,
        event: 'lease_acquired',
        from: { status: 'queued', phase: 'understand' },
        to: { status: 'running', phase: 'plan' },
        occurredAt: '2026-08-14T01:35:01-04:00',
      }).success,
    ).toBe(false)
  })
})

describe('operation and attempt contracts', () => {
  const committedOperation = {
    id: 'op_homecoming_once',
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    planId: 'pln_homecoming_energy',
    planActionId: 'act_replace_homecoming',
    approvalId: 'apr_homecoming_energy',
    payloadHash: HASH_A,
    serverCreated: true,
    status: 'committed',
    outcome: {
      routineId: 'rtn_night_shift_home',
      routineVersionId: 'rtv_night_shift_home_v1',
      deactivatedRoutineId: 'rtn_midnight_entry',
    },
    createdAt: '2026-08-14T01:43:00-04:00',
    committedAt: '2026-08-14T01:43:01-04:00',
  } as const

  it('requires corrected operations to be server-created', () => {
    expect(OperationSchema.parse(committedOperation).serverCreated).toBe(true)
    expect(OperationSchema.safeParse({ ...committedOperation, serverCreated: false }).success).toBe(
      false,
    )
  })

  it('does not allow a committed operation without its durable outcome', () => {
    expect(OperationSchema.safeParse({ ...committedOperation, outcome: null }).success).toBe(false)
  })

  it('does not allow a non-committed operation to carry partial commit fields', () => {
    expect(
      OperationSchema.safeParse({
        ...committedOperation,
        status: 'pending',
        committedAt: null,
      }).success,
    ).toBe(false)
    expect(
      OperationSchema.safeParse({
        ...committedOperation,
        status: 'pending',
        outcome: null,
      }).success,
    ).toBe(false)
  })

  it('returns the original outcome only for the same payload', () => {
    expect(decideOperationReplay(HASH_A as never, HASH_A as never)).toBe('return_original_outcome')
    expect(decideOperationReplay(HASH_A as never, HASH_B as never)).toBe('conflict')
  })

  it('records a lost transport response as unknown and reconcilable', () => {
    const attempt = AttemptSchema.parse({
      id: 'att_lost_response',
      organizationId: 'org_rocky_roost',
      operationId: 'op_homecoming_once',
      sequence: 1,
      transport: 'mcp',
      status: 'unknown',
      retryable: true,
      error: { code: 'TRANSPORT_RESPONSE_LOST', message: 'Commit result was not delivered' },
      startedAt: '2026-08-14T01:43:00-04:00',
      completedAt: '2026-08-14T01:43:02-04:00',
    })
    expect(attempt.status).toBe('unknown')
  })

  it('rejects an unknown attempt that cannot enter reconciliation', () => {
    expect(
      AttemptSchema.safeParse({
        id: 'att_lost_response',
        organizationId: 'org_rocky_roost',
        operationId: 'op_homecoming_once',
        sequence: 1,
        transport: 'mcp',
        status: 'unknown',
        retryable: false,
        error: null,
        startedAt: '2026-08-14T01:43:00-04:00',
        completedAt: '2026-08-14T01:43:02-04:00',
      }).success,
    ).toBe(false)
  })

  it('binds gateway transport attempts to a stable command and dispatch generation', () => {
    const gatewayAttempt = AttemptSchema.parse({
      id: 'att_gateway_generation',
      organizationId: 'org_rocky_roost',
      operationId: 'op_homecoming_once',
      sequence: 3,
      transport: 'gateway',
      commandId: 'gcmd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      generation: 2,
      status: 'pending',
      retryable: false,
      error: null,
      startedAt: '2026-08-14T01:45:00-04:00',
      completedAt: null,
    })

    expect(gatewayAttempt).toMatchObject({ transport: 'gateway', generation: 2 })
    expect(
      AttemptSchema.safeParse({
        ...gatewayAttempt,
        commandId: undefined,
        generation: undefined,
      }).success,
    ).toBe(false)
  })

  it('forbids gateway dispatch metadata on non-gateway attempts', () => {
    expect(
      AttemptSchema.safeParse({
        id: 'att_http_request',
        organizationId: 'org_rocky_roost',
        operationId: 'op_homecoming_once',
        sequence: 1,
        transport: 'http',
        commandId: 'gcmd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        generation: 1,
        status: 'succeeded',
        retryable: false,
        error: null,
        startedAt: '2026-08-14T01:45:00-04:00',
        completedAt: '2026-08-14T01:45:01-04:00',
      }).success,
    ).toBe(false)
  })

  it('requires unknown and failed attempts to explain the terminal result', () => {
    const base = {
      id: 'att_missing_error',
      organizationId: 'org_rocky_roost',
      operationId: 'op_homecoming_once',
      sequence: 2,
      transport: 'worker',
      retryable: true,
      error: null,
      startedAt: '2026-08-14T01:44:00-04:00',
      completedAt: '2026-08-14T01:44:01-04:00',
    } as const
    expect(AttemptSchema.safeParse({ ...base, status: 'unknown' }).success).toBe(false)
    expect(AttemptSchema.safeParse({ ...base, status: 'failed' }).success).toBe(false)
  })

  it('keeps the duplicate-producing handler explicit and test-only', () => {
    const contract = ActivationContractSchema.parse({
      kind: 'legacy_negative_control',
      labOnly: true,
      clientCreatedOperationIds: true,
      organizationPlanActionUnique: false,
      revalidatesProtectedVersion: false,
      atomicReplacement: true,
      blindRetryCreatesNewOperation: true,
      productionSelectable: false,
      mcpSelectable: false,
      expectedCreatedRoutineCount: 2,
    })
    expect(contract.kind).toBe('legacy_negative_control')
  })

  it('does not use the lab handler to bypass exact approval', () => {
    const legacyOperation = {
      id: 'op_legacy_attempt_one',
      organizationId: 'org_rocky_roost',
      missionId: 'mis_night_shift_home',
      planId: 'pln_homecoming_energy',
      planActionId: 'act_replace_homecoming',
      approvalId: 'apr_homecoming_energy',
      payloadHash: HASH_A,
      clientCreated: true,
      labOnly: true,
      status: 'pending',
      outcome: null,
      createdAt: '2026-08-14T01:43:00-04:00',
      committedAt: null,
    } as const
    expect(LegacyLabOperationSchema.parse(legacyOperation).approvalId).toBe('apr_homecoming_energy')
    const { approvalId: _approvalId, ...withoutApproval } = legacyOperation
    expect(LegacyLabOperationSchema.safeParse(withoutApproval).success).toBe(false)
  })
})
