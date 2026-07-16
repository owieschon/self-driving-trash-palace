import {
  ClarificationRequestSchema,
  PrincipalSchema,
  computeClarificationRequestPayloadHash,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { HumanTaskService } from '../human-task-service.js'
import type { AuthContext } from '../models.js'
import { InMemoryApplicationStore } from '../testing/fakes.js'
import { IDS, authContext, makeApproval, makeMission, makePlan } from './fixtures.js'

describe('HumanTaskService', () => {
  it('discovers the one pending clarification without requiring its opaque ID', async () => {
    const mission = makeMission({ status: 'waiting_for_user', phase: 'plan' }, 5)
    const clarification = pendingClarification()
    const service = new HumanTaskService(
      new InMemoryApplicationStore({ missions: [mission], clarificationRequests: [clarification] }),
    )

    await expect(service.getMissionTasks(authContext, mission.id)).resolves.toEqual({
      mission,
      clarification,
      approval: null,
    })
  })

  it('discovers only a pending approval for the latest tenant-bound plan', async () => {
    const plan = makePlan('awaiting_approval')
    const approval = makeApproval(plan, 'pending')
    const mission = makeMission({ status: 'waiting_for_user', phase: 'approve' }, 4)
    const service = new HumanTaskService(
      new InMemoryApplicationStore({ missions: [mission], plans: [plan], approvals: [approval] }),
    )

    await expect(service.getMissionTasks(authContext, mission.id)).resolves.toEqual({
      mission,
      clarification: null,
      approval,
    })
  })

  it('returns an empty task inbox after a human decision is no longer pending', async () => {
    const plan = makePlan('approved')
    const approval = makeApproval(plan, 'approved')
    const mission = makeMission({ status: 'running', phase: 'execute' }, 5)
    const service = new HumanTaskService(
      new InMemoryApplicationStore({ missions: [mission], plans: [plan], approvals: [approval] }),
    )

    await expect(service.getMissionTasks(authContext, mission.id)).resolves.toEqual({
      mission,
      clarification: null,
      approval: null,
    })
  })

  it('loads a complete tenant-bound approval task for an authorized human', async () => {
    const plan = makePlan('awaiting_approval')
    const approval = makeApproval(plan, 'pending')
    const mission = makeMission({ status: 'waiting_for_user', phase: 'approve' }, 4)
    const service = new HumanTaskService(
      new InMemoryApplicationStore({ missions: [mission], plans: [plan], approvals: [approval] }),
    )

    await expect(service.getApproval(authContext, approval.id)).resolves.toEqual({
      approval,
      plan,
      mission,
    })
  })

  it('fails closed for an ungranted operator and a foreign tenant', async () => {
    const plan = makePlan('awaiting_approval')
    const approval = makeApproval(plan, 'pending')
    const mission = makeMission({ status: 'waiting_for_user', phase: 'approve' }, 4)
    const service = new HumanTaskService(
      new InMemoryApplicationStore({ missions: [mission], plans: [plan], approvals: [approval] }),
    )
    const operator: AuthContext = {
      ...authContext,
      principal: PrincipalSchema.parse({ ...authContext.principal, role: 'operator' }),
    }
    const foreign: AuthContext = {
      ...authContext,
      principal: PrincipalSchema.parse({
        ...authContext.principal,
        organizationId: 'org_foreign00001',
      }),
    }

    await expect(service.getApproval(operator, approval.id)).rejects.toThrow(/routine:approve/i)
    await expect(service.getApproval(foreign, approval.id)).rejects.toThrow()
    expect(IDS.organization).not.toBe(foreign.principal.organizationId)
  })
})

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
    id: 'clr_human_task_01',
    idempotencyKey: 'a'.repeat(64),
    payloadHash: computeClarificationRequestPayloadHash(payload),
    status: 'pending',
    requestedAt: '2026-08-14T05:35:00.000Z',
    resolvedAt: null,
  })
}
