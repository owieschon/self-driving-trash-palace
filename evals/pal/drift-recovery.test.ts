import { describe, expect, it } from 'vitest'

import { PalEventSupervisor } from '../../apps/worker/src/pal-supervision.js'

describe('Pal drift recovery evaluation', () => {
  it('routes an uncertain operation back through the existing same-mission resume seam once', async () => {
    const supervisor = new PalEventSupervisor()
    const base = {
      schemaVersion: 'pal-supervision-event@1' as const,
      organizationId: 'org_primary0001',
      missionId: 'mis_mission00001',
      missionVersion: 1,
      programKind: 'night_shift_homecoming' as const,
      kind: 'mission_resume' as const,
      outcome: 'retry' as const,
    }

    const first = await supervisor.observe({ ...base, eventId: 'evt_reconcile_first' })
    const replay = await supervisor.observe({ ...base, eventId: 'evt_reconcile_first' })

    expect(first).toMatchObject({
      kind: 'resume_same_mission',
      targetTopic: 'mission.resume',
      supervisorModelCallCount: 0,
      createdMissionCount: 0,
    })
    expect(replay).toMatchObject({
      kind: 'duplicate',
      originalKind: 'resume_same_mission',
      supervisorModelCallCount: 0,
      createdMissionCount: 0,
    })
  })

  it('never treats a failed verification as agent-approved or agent-verified recovery', async () => {
    const supervisor = new PalEventSupervisor()
    const result = await supervisor.observe({
      schemaVersion: 'pal-supervision-event@1',
      eventId: 'evt_verification_failed',
      organizationId: 'org_primary0001',
      missionId: 'mis_mission00001',
      missionVersion: 1,
      programKind: 'scheduled_hauler_access',
      kind: 'mission_verification',
      status: 'failed',
    })

    expect(result).toMatchObject({
      kind: 'human_attention',
      attention: 'verification_failure',
      approvedByPal: false,
      verifiedByPal: false,
      supervisorModelCallCount: 0,
    })
  })
})
