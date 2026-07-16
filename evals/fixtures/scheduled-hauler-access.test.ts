import {
  MissionSchema,
  PlanSchema,
  ScheduledHaulerAccessConstraintSchema,
  ScheduledHaulerAccessRoutineDefinitionSchema,
  missionProgramKindOf,
} from '../../packages/core/src/index.js'
import { describe, expect, it } from 'vitest'

import { SCHEDULED_HAULER_ACCESS_FIXTURE } from './scheduled-hauler-access.js'

describe('scheduled-hauler-access@1', () => {
  it('binds a separate program, action, identity, window, compartment, and final state', () => {
    const fixture = SCHEDULED_HAULER_ACCESS_FIXTURE
    const mission = MissionSchema.parse(fixture.mission)
    const plan = PlanSchema.parse(fixture.plan)
    const constraints = ScheduledHaulerAccessConstraintSchema.parse(mission.constraints)
    const action = plan.actions[0]

    expect(missionProgramKindOf(mission)).toBe('scheduled_hauler_access')
    expect(action?.type).toBe('replace_scheduled_hauler_access_routine')
    if (action?.type !== 'replace_scheduled_hauler_access_routine') {
      throw new Error('Fixture action changed program')
    }
    expect(ScheduledHaulerAccessRoutineDefinitionSchema.parse(action.replacement)).toEqual(
      action.replacement,
    )
    expect(action.replacement.trigger.authorizedIdentityTagId).toBe(
      constraints.authorizedIdentityTagId,
    )
    expect(action.replacement.trigger.windowStart).toBe(constraints.accessWindowStart)
    expect(action.replacement.trigger.windowEnd).toBe(constraints.accessWindowEnd)
    expect(action.replacement.constraints).toMatchObject({
      serviceHatchOnly: true,
      residentialHatchMustRemainLocked: true,
      finalServiceHatchState: 'locked',
    })
  })

  it('rejects a renamed Homecoming action as the Hauler program', () => {
    const fixture = SCHEDULED_HAULER_ACCESS_FIXTURE
    const candidate = {
      ...fixture.plan,
      actions: [
        {
          ...fixture.action,
          type: 'replace_homecoming_routine',
        },
      ],
    }
    expect(PlanSchema.safeParse(candidate).success).toBe(false)
  })

  it('rejects residential access and missing final-lock constraints', () => {
    const constraints = {
      ...SCHEDULED_HAULER_ACCESS_FIXTURE.mission.constraints,
      serviceHatchOnly: false,
      residentialHatchMustRemainLocked: false,
      finalServiceHatchState: 'unlocked',
    }
    expect(ScheduledHaulerAccessConstraintSchema.safeParse(constraints).success).toBe(false)
  })
})
