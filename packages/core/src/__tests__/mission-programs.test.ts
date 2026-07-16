import { describe, expect, it } from 'vitest'

import {
  HomecomingMissionConstraintSchema,
  MissionProgramKindSchema,
  MissionSchema,
  ReplaceScheduledHaulerAccessRoutineActionSchema,
  ScheduledHaulerAccessConstraintSchema,
  missionProgramKindOf,
} from '../index.js'

const baseMission = {
  id: 'mis_program_contract',
  organizationId: 'org_program_contract',
  palaceId: 'pal_program_contract',
  initiatedBy: 'usr_program_contract',
  objective: 'Improve one supported automation.',
  successCriteriaIds: ['automation_verified'],
  state: { status: 'queued', phase: 'understand' },
  version: 0,
  runId: null,
  contextReceiptId: null,
  taskLedger: [],
  createdAt: '2026-07-15T12:00:00.000Z',
  updatedAt: '2026-07-15T12:00:00.000Z',
} as const

describe('mission program contracts', () => {
  it('keeps legacy Homecoming missions readable while new missions carry an explicit kind', () => {
    const legacy = MissionSchema.parse({
      ...baseMission,
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
    })
    expect(legacy.programKind).toBeUndefined()
    expect(missionProgramKindOf(legacy)).toBe('night_shift_homecoming')
    expect(HomecomingMissionConstraintSchema.safeParse(legacy.constraints).success).toBe(true)
  })

  it('rejects constraints from a different program kind', () => {
    const candidate = {
      ...baseMission,
      programKind: 'scheduled_hauler_access',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
    }
    expect(MissionSchema.safeParse(candidate).success).toBe(false)
  })

  it('defines Hauler constraints and action separately from Homecoming', () => {
    expect(MissionProgramKindSchema.options).toEqual([
      'night_shift_homecoming',
      'scheduled_hauler_access',
    ])
    expect(
      ScheduledHaulerAccessConstraintSchema.parse({
        accessWindowStart: '09:00',
        accessWindowEnd: '10:00',
        authorizedIdentityTagId: 'tag_verified_hauler',
        serviceHatchOnly: true,
        residentialHatchMustRemainLocked: true,
        finalServiceHatchState: 'locked',
      }),
    ).toBeDefined()
    expect(ReplaceScheduledHaulerAccessRoutineActionSchema.shape.type.value).toBe(
      'replace_scheduled_hauler_access_routine',
    )
  })
})
