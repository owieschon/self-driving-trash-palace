import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { CaretakerDecisionRequestSchema } from './decision-engine.js'

describe('Caretaker model request contract', () => {
  it('delivers the goal, program, constraints, live state, tools, budgets, and evidence', () => {
    const schema = JSON.stringify(z.toJSONSchema(CaretakerDecisionRequestSchema))

    for (const requiredField of [
      'objective',
      'programKind',
      'constraints',
      'liveState',
      'allowedTools',
      'budget',
      'evidence',
      'frozenContext',
    ]) {
      expect(schema).toContain(`"${requiredField}"`)
    }
  })

  it('does not define credential or tenant-authority inputs for the model', () => {
    const schema = JSON.stringify(z.toJSONSchema(CaretakerDecisionRequestSchema))

    expect(schema).not.toContain('apiKey')
    expect(schema).not.toContain('authorizationHeader')
    expect(schema).not.toContain('organizationId')
  })
})
