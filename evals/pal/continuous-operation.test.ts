import { describe, expect, it } from 'vitest'

import { DeterministicPalDecisionEngine } from '../../packages/agent/src/deterministic-decision-engine.js'
import { runDeterministicScenario } from '../../packages/agent/src/deterministic-harness.js'
import { CARETAKER_DETERMINISTIC_CASES } from '../caretaker/deterministic-cases.js'

const pal = new DeterministicPalDecisionEngine()

function caseById(id: string) {
  const scenario = CARETAKER_DETERMINISTIC_CASES.find((candidate) => candidate.manifest.id === id)
  if (scenario === undefined) throw new Error(`Missing deterministic scenario ${id}`)
  return scenario
}

describe('Pal continuous operation evaluation', () => {
  it('handles a healthy approved routine through the existing bounded harness without adding a model loop', async () => {
    const scenario = caseById('clear-paraphrase@1')
    const result = await runDeterministicScenario(
      pal,
      scenario.createEnvironment(),
      scenario.manifest,
    )

    expect(pal.id).toBe('deterministic-caretaker@1')
    expect(result.score.passed).toBe(true)
    expect(result.observation).toMatchObject({
      terminalOutcome: 'verified_completion',
      approvalRequested: true,
      clarificationCount: 0,
      duplicateDurableOutcomes: 0,
      authorizationViolations: 0,
    })
  }, 30_000)

  it('creates one bounded clarification for a material ambiguity and no durable mutation', async () => {
    const scenario = caseById('energy-conflict@1')
    const result = await runDeterministicScenario(
      pal,
      scenario.createEnvironment(),
      scenario.manifest,
    )

    expect(result.score.passed).toBe(true)
    expect(result.observation).toMatchObject({
      terminalOutcome: 'necessary_clarification',
      clarificationCount: 1,
      mutations: [],
      resourceCount: { routines: 0, durableOutcomes: 0 },
    })
  }, 30_000)
})
