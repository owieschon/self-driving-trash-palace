import { describe, expect, it } from 'vitest'

import {
  ExecutionSchema,
  EvidenceIdSchema,
  GatewayCommandIdSchema,
  classifyExecutionReadiness,
  type Execution,
  type ExecutionMilestone,
} from '../index.js'

const STARTED_AT = '2026-08-14T01:30:00-04:00'
const UPDATED_AT = '2026-08-14T01:50:00-04:00'
const DEADLINE = '2026-08-14T02:00:00-04:00'

const commandIds = {
  preheat: GatewayCommandIdSchema.parse('gcmd_preheat00000001'),
  pathway_lighting: GatewayCommandIdSchema.parse('gcmd_pathway0000001'),
  unlock: GatewayCommandIdSchema.parse('gcmd_unlock00000001'),
  relock: GatewayCommandIdSchema.parse('gcmd_relock00000001'),
} as const

function pendingMilestones(): ExecutionMilestone[] {
  return [
    {
      name: 'preheat',
      commandId: commandIds.preheat,
      status: 'pending',
      evidenceId: null,
      resolvedAt: null,
      failure: null,
    },
    {
      name: 'verified_arrival',
      commandId: null,
      status: 'pending',
      evidenceId: null,
      resolvedAt: null,
      failure: null,
    },
    {
      name: 'pathway_lighting',
      commandId: commandIds.pathway_lighting,
      status: 'pending',
      evidenceId: null,
      resolvedAt: null,
      failure: null,
    },
    {
      name: 'unlock',
      commandId: commandIds.unlock,
      status: 'pending',
      evidenceId: null,
      resolvedAt: null,
      failure: null,
    },
    {
      name: 'relock',
      commandId: commandIds.relock,
      status: 'pending',
      evidenceId: null,
      resolvedAt: null,
      failure: null,
    },
  ]
}

function execution(milestones: ExecutionMilestone[]): Execution {
  const evidenceIds = milestones.flatMap((milestone) =>
    milestone.evidenceId === null ? [] : [milestone.evidenceId],
  )
  const triggerId = EvidenceIdSchema.parse('evd_execution_trigger')
  if (!evidenceIds.includes(triggerId)) {
    evidenceIds.push(triggerId)
  }
  return ExecutionSchema.parse({
    id: 'exe_homecoming_progress',
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    operationId: 'op_homecoming_effects',
    routineId: 'rtn_night_shift_home',
    routineVersionId: 'rtv_night_shift_home_v1',
    status: 'running',
    triggeredByEvidenceId: 'evd_execution_trigger',
    evidenceIds,
    startedAt: STARTED_AT,
    deadline: DEADLINE,
    milestones,
    updatedAt: UPDATED_AT,
    completedAt: null,
  })
}

function complete(milestone: ExecutionMilestone, evidenceId: string): ExecutionMilestone {
  return {
    ...milestone,
    status: 'completed',
    evidenceId: EvidenceIdSchema.parse(evidenceId),
    resolvedAt: UPDATED_AT,
    failure: null,
  }
}

describe('execution milestone readiness', () => {
  it('does not become ready when preheat completes first', () => {
    const milestones = pendingMilestones()
    milestones[0] = complete(milestones[0]!, 'evd_preheat_complete')
    const progress = execution(milestones)

    expect(classifyExecutionReadiness(progress, '2026-08-14T01:55:00-04:00')).toEqual({
      ready: false,
      reason: 'not_ready',
    })
  })

  it('becomes ready only after every required milestone completes', () => {
    const milestones = pendingMilestones().map((milestone, index) =>
      complete(milestone, `evd_milestone_${index + 1}`),
    )
    const progress = execution(milestones)

    expect(classifyExecutionReadiness(progress, '2026-08-14T01:55:00-04:00')).toEqual({
      ready: true,
      reason: 'all_completed',
    })
    expect(
      ExecutionSchema.parse({
        ...progress,
        status: 'observed',
        completedAt: UPDATED_AT,
      }).status,
    ).toBe('observed')
  })

  it('becomes ready for deterministic verification on a known failure', () => {
    const milestones = pendingMilestones()
    milestones[2] = {
      ...milestones[2]!,
      status: 'failed',
      evidenceId: EvidenceIdSchema.parse('evd_lighting_failure'),
      resolvedAt: UPDATED_AT,
      failure: { code: 'DEVICE_OFFLINE', message: 'Pathway lights are offline' },
    }
    const progress = execution(milestones)

    expect(classifyExecutionReadiness(progress, '2026-08-14T01:55:00-04:00')).toEqual({
      ready: true,
      reason: 'known_failure',
    })
  })

  it('becomes ready at the deadline without pretending pending milestones completed', () => {
    const progress = execution(pendingMilestones())

    expect(classifyExecutionReadiness(progress, DEADLINE)).toEqual({
      ready: true,
      reason: 'deadline_elapsed',
    })
    expect(progress.milestones.every((milestone) => milestone.status === 'pending')).toBe(true)
  })

  it('rejects missing, duplicate, and misbound milestones', () => {
    const progress = execution(pendingMilestones())
    expect(
      ExecutionSchema.safeParse({ ...progress, milestones: progress.milestones.slice(0, 4) })
        .success,
    ).toBe(false)
    expect(
      ExecutionSchema.safeParse({
        ...progress,
        milestones: progress.milestones.map((milestone, index) =>
          index === 4 ? { ...milestone, name: 'unlock' } : milestone,
        ),
      }).success,
    ).toBe(false)
    expect(
      ExecutionSchema.safeParse({
        ...progress,
        milestones: progress.milestones.map((milestone, index) =>
          index === 1 ? { ...milestone, commandId: commandIds.unlock } : milestone,
        ),
      }).success,
    ).toBe(false)
  })

  it('rejects an observed execution that only completed preheat', () => {
    const milestones = pendingMilestones()
    milestones[0] = complete(milestones[0]!, 'evd_preheat_complete')
    const progress = execution(milestones)

    expect(
      ExecutionSchema.safeParse({
        ...progress,
        status: 'observed',
        completedAt: UPDATED_AT,
      }).success,
    ).toBe(false)
  })
})
