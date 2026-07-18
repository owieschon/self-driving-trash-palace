import { describe, expect, it } from 'vitest'

import { PalEventSupervisor, classifyPalSupervisionEvent } from './pal-supervision.js'

const BASE = {
  schemaVersion: 'pal-supervision-event@1' as const,
  organizationId: 'org_primary0001',
  missionId: 'mis_mission00001',
  missionVersion: 1,
} as const

describe('Pal event-driven supervision', () => {
  it.each(['night_shift_homecoming', 'scheduled_hauler_access'] as const)(
    'leaves a verified approved %s routine alone without a model call or new approval',
    async (programKind) => {
      const supervisor = new PalEventSupervisor()
      const result = await supervisor.observe({
        ...BASE,
        eventId: `evt_healthy_${programKind}`,
        kind: 'routine_execution_verified',
        programKind,
      })

      expect(result).toMatchObject({
        kind: 'no_action',
        reason: 'healthy_approved_routine',
        supervisorModelCallCount: 0,
        createdMissionCount: 0,
        approvedByPal: false,
        verifiedByPal: false,
      })
    },
  )

  it('routes material ambiguity and material authority changes to exactly one human task type', () => {
    const ambiguity = classifyPalSupervisionEvent({
      ...BASE,
      eventId: 'evt_ambiguity_001',
      kind: 'material_ambiguity',
      materialField: 'preference.temperature_celsius',
      programKind: 'night_shift_homecoming',
    })
    const authority = classifyPalSupervisionEvent({
      ...BASE,
      eventId: 'evt_authority_001',
      kind: 'authority_change',
      authorityScope: 'broader_permission',
      programKind: 'scheduled_hauler_access',
    })

    expect(ambiguity).toMatchObject({
      kind: 'human_attention',
      attention: 'clarification',
      supervisorModelCallCount: 0,
      approvedByPal: false,
    })
    expect(authority).toMatchObject({
      kind: 'human_attention',
      attention: 'approval',
      supervisorModelCallCount: 0,
      approvedByPal: false,
    })
  })

  it('deduplicates repeated same-mission drift and never creates a correction itself', async () => {
    const supervisor = new PalEventSupervisor()
    const first = await supervisor.observe({
      ...BASE,
      eventId: 'evt_drift_first',
      kind: 'deviation_detected',
      correctionKey: 'routine.window.deviation',
      correctionScope: 'same_mission',
      programKind: 'scheduled_hauler_access',
    })
    const repeated = await supervisor.observe({
      ...BASE,
      eventId: 'evt_drift_replayed',
      kind: 'deviation_detected',
      correctionKey: 'routine.window.deviation',
      correctionScope: 'same_mission',
      programKind: 'scheduled_hauler_access',
    })

    expect(first).toMatchObject({
      kind: 'resume_same_mission',
      targetTopic: 'mission.resume',
      supervisorModelCallCount: 0,
      createdMissionCount: 0,
    })
    expect(repeated).toMatchObject({
      kind: 'duplicate',
      originalKind: 'resume_same_mission',
      supervisorModelCallCount: 0,
      createdMissionCount: 0,
    })
    expect(repeated.deduplicationKey).toBe(first.deduplicationKey)
  })

  it('only classifies a bounded new mission as application-owned follow-up', () => {
    const result = classifyPalSupervisionEvent({
      ...BASE,
      eventId: 'evt_bounded_correction',
      kind: 'deviation_detected',
      correctionKey: 'device.capability.replaced',
      correctionScope: 'bounded_new_mission',
      programKind: 'night_shift_homecoming',
    })

    expect(result).toMatchObject({
      kind: 'bounded_new_mission',
      requiredAuthority: 'application_mission_bootstrap_and_human_approval',
      supervisorModelCallCount: 0,
      createdMissionCount: 0,
      approvedByPal: false,
      verifiedByPal: false,
    })
  })
})
