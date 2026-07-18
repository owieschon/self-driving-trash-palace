import {
  AttemptIdSchema,
  AttemptSchema,
  ClarificationRequestSchema,
  MissionIdSchema,
  MissionSchema,
  VerificationSchema,
  computeClarificationRequestPayloadHash,
  type MissionState,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { NotFoundError } from '../errors.js'
import { MissionProgressService } from '../mission-progress-service.js'
import type { ClockPort } from '../ports.js'
import { InMemoryApplicationStore } from '../testing/fakes.js'
import { IDS, authContext, makeApproval, makeMission, makeOperation, makePlan } from './fixtures.js'

class FixedClock implements ClockPort {
  public now(): Date {
    return new Date('2026-08-14T06:00:00.000Z')
  }
}

describe('mission progress projection', () => {
  it.each([
    {
      name: 'queued work with no durable human task',
      seed: { missions: [makeMission({ status: 'queued', phase: 'understand' })] },
      displayState: 'working',
      actions: ['view_activity'],
    },
    {
      name: 'pending clarification',
      seed: {
        missions: [makeMission({ status: 'waiting_for_user', phase: 'plan' })],
        clarificationRequests: [pendingClarification()],
      },
      displayState: 'needs_input',
      actions: ['answer_clarification'],
    },
    {
      name: 'pending approval',
      seed: approvalSeed({ status: 'waiting_for_user', phase: 'approve' }, 'pending'),
      displayState: 'needs_approval',
      actions: ['approve_proposal', 'reject_proposal'],
    },
    {
      name: 'claimed operation',
      seed: operationSeed({ status: 'running', phase: 'execute' }, 'claimed'),
      displayState: 'applying',
      actions: [],
    },
    {
      name: 'unknown attempt after a lost response',
      seed: unknownAttemptSeed(),
      displayState: 'checking_result',
      actions: ['view_activity'],
    },
    {
      name: 'committed operation awaiting verification',
      seed: operationSeed({ status: 'waiting_for_system', phase: 'observe' }, 'committed'),
      displayState: 'checking_result',
      actions: ['view_activity'],
    },
    {
      name: 'retained passing verification',
      seed: verifiedSeed('passed'),
      displayState: 'verified',
      actions: ['view_activity'],
    },
    {
      name: 'retained failing verification',
      seed: verifiedSeed('failed'),
      displayState: 'failed',
      actions: ['view_activity'],
    },
    {
      name: 'durably cancelled mission',
      seed: { missions: [makeMission({ status: 'cancelled', phase: 'execute' })] },
      displayState: 'cancelled',
      actions: ['view_activity'],
    },
  ] as const)(
    'maps $name only from durable source state',
    async ({ seed, displayState, actions }) => {
      const progress = await progressFor(seed)

      expect(progress.displayState).toBe(displayState)
      expect(progress.allowedNextActions).toEqual(actions)
      expect(progress.observedAt).toBe('2026-08-14T06:00:00.000Z')
    },
  )

  it('returns the exact pending task and does not call a proposal an automation', async () => {
    const progress = await progressFor(
      approvalSeed({ status: 'waiting_for_user', phase: 'approve' }, 'pending'),
    )

    expect(progress.pendingTask).toEqual({
      kind: 'approval',
      approvalId: 'apr_approval0001',
      planId: IDS.plan,
      expiresAt: '2026-08-14T05:50:00.000Z',
    })
    expect(progress.operation).toBeNull()
    expect(progress.verification).toBeNull()
  })

  it('keeps a missing or foreign mission observationally unavailable', async () => {
    const service = new MissionProgressService(
      new InMemoryApplicationStore({
        missions: [
          MissionSchema.parse({
            ...makeMission(),
            id: MissionIdSchema.parse('mis_foreign00001'),
            organizationId: IDS.otherOrganization,
          }),
        ],
      }),
      new FixedClock(),
    )

    await expect(
      service.get({ context: authContext, missionId: MissionIdSchema.parse('mis_missing000001') }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      service.get({ context: authContext, missionId: MissionIdSchema.parse('mis_foreign00001') }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

async function progressFor(seed: ConstructorParameters<typeof InMemoryApplicationStore>[0]) {
  const service = new MissionProgressService(new InMemoryApplicationStore(seed), new FixedClock())
  return service.get({ context: authContext, missionId: IDS.mission })
}

function approvalSeed(state: MissionState, status: 'pending' | 'approved') {
  const plan = makePlan(status === 'pending' ? 'awaiting_approval' : 'approved')
  return {
    missions: [makeMission(state)],
    plans: [plan],
    approvals: [makeApproval(plan, status)],
  }
}

function operationSeed(
  state: MissionState,
  status: 'pending' | 'claimed' | 'committed' | 'failed' | 'cancelled',
) {
  const plan = makePlan('approved')
  return {
    ...approvalSeed(state, 'approved'),
    plans: [plan],
    approvals: [makeApproval(plan, 'approved')],
    operations: [makeOperation(plan, status)],
  }
}

function unknownAttemptSeed() {
  const plan = makePlan('approved')
  const operation = makeOperation(plan, 'claimed')
  return {
    ...operationSeed({ status: 'running', phase: 'execute' }, 'claimed'),
    plans: [plan],
    approvals: [makeApproval(plan, 'approved')],
    operations: [operation],
    attempts: [
      AttemptSchema.parse({
        id: AttemptIdSchema.parse('att_unknown00001'),
        organizationId: IDS.organization,
        operationId: operation.id,
        sequence: 1,
        transport: 'worker',
        status: 'unknown',
        retryable: true,
        error: { code: 'RESPONSE_LOST', message: 'The committed response was lost.' },
        startedAt: '2026-08-14T05:37:00.000Z',
        completedAt: '2026-08-14T05:37:01.000Z',
      }),
    ],
  }
}

function pendingClarification() {
  const payload = {
    organizationId: IDS.organization,
    missionId: IDS.mission,
    requestedBy: IDS.service,
    question: 'Should this homecoming routine prioritize energy or comfort?',
    choices: [
      {
        id: 'energy_first',
        label: 'Energy first',
        description: 'Stay within the projected battery ceiling and preheat later.',
      },
      {
        id: 'comfort_first',
        label: 'Comfort first',
        description: 'Preheat earlier and accept the projected battery tradeoff.',
      },
    ],
    evidenceRefs: [],
  } as const
  return ClarificationRequestSchema.parse({
    schemaVersion: 'clarification-request@1',
    ...payload,
    id: 'clr_progress_001',
    idempotencyKey: 'a'.repeat(64),
    payloadHash: computeClarificationRequestPayloadHash(payload),
    status: 'pending',
    requestedAt: '2026-08-14T05:35:00.000Z',
    resolvedAt: null,
  })
}

function verifiedSeed(status: 'passed' | 'failed') {
  const plan = makePlan('approved')
  return {
    ...approvalSeed({ status: 'succeeded', phase: 'verify' }, 'approved'),
    plans: [plan],
    approvals: [makeApproval(plan, 'approved')],
    verifications: [
      VerificationSchema.parse({
        id: 'ver_progress_001',
        organizationId: IDS.organization,
        missionId: IDS.mission,
        source: 'application_code',
        status,
        planHash: plan.hash,
        assertions: [
          {
            predicate: {
              id: 'active_routine_count',
              type: 'active_routine_count',
              planId: plan.id,
              expected: 1,
            },
            passed: status === 'passed',
            evidenceIds: [IDS.evidence],
            message:
              status === 'passed'
                ? 'One active routine matched the plan.'
                : 'No routine matched the plan.',
          },
        ],
        completedAt: '2026-08-14T05:59:00.000Z',
      }),
    ],
  }
}
