import { describe, expect, it } from 'vitest'

import {
  PAL_AGENT_IDENTITY,
  PalDecisionSchema,
  PalDecisionRequestSchema,
  PalFrozenContextSchema,
  PalLiveStateSchema,
} from './pal-context.js'
import {
  CaretakerDecisionRequestSchema,
  CaretakerDecisionSchema,
  CaretakerFrozenContextSchema,
  CaretakerLiveStateSchema,
} from './decision-engine.js'

describe('Pal context compatibility surface', () => {
  it('names Pal while reusing the one decision and context contract', () => {
    expect(PAL_AGENT_IDENTITY).toBe('Pal')
    expect(PalDecisionSchema).toBe(CaretakerDecisionSchema)
    expect(PalDecisionRequestSchema).toBe(CaretakerDecisionRequestSchema)
    expect(PalFrozenContextSchema).toBe(CaretakerFrozenContextSchema)
    expect(PalLiveStateSchema).toBe(CaretakerLiveStateSchema)
  })
})
