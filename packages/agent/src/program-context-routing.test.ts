import { describe, expect, it } from 'vitest'
import { deriveProgramMissionContextSelection } from './context-routing.js'

describe('program-focused context routing', () => {
  it('keeps Homecoming and Hauler Access guidance separate while sharing authority controls', () => {
    const homecoming = deriveProgramMissionContextSelection(
      'night_shift_homecoming',
      'consequential-write',
    )
    const hauler = deriveProgramMissionContextSelection(
      'scheduled_hauler_access',
      'consequential-write',
    )

    expect(homecoming.sourceIds).toContain('skill.homecoming')
    expect(homecoming.sourceIds).not.toContain('skill.hauler-access')
    expect(hauler.sourceIds).toContain('skill.hauler-access')
    expect(hauler.sourceIds).not.toContain('skill.homecoming')
    for (const shared of [
      'skill.shared.approval',
      'skill.shared.reconciliation',
      'skill.shared.verification',
    ]) {
      expect(homecoming.sourceIds).toContain(shared)
      expect(hauler.sourceIds).toContain(shared)
    }
  })
})
