import { describe, expect, it } from 'vitest'

import { createWorkerDecisionProvider, WorkerDecisionProviderError } from './decision-provider.js'
import { parseWorkerServerConfiguration } from './server-configuration.js'

describe('worker decision provider', () => {
  it('selects deterministic explicitly by default', () => {
    const provider = createWorkerDecisionProvider({ kind: 'deterministic' })

    expect(provider.kind).toBe('deterministic')
    expect(provider.engine.id).toContain('deterministic')
    expect(provider.evidenceLabel).toBe('Deterministic integration-proven')
  })

  it('initializes Claude without making a request and never falls back', () => {
    let requests = 0
    const provider = createWorkerDecisionProvider(
      {
        kind: 'claude',
        apiKey: 'test-credential-with-sufficient-length',
        authorization: {
          authorizationId: 'approval_test_001',
          maximumCostUsdPerDecision: 0.1,
        },
      },
      {
        async *query() {
          requests += 1
        },
      },
    )

    expect(provider.kind).toBe('claude')
    expect(provider.engine.id).toContain('claude-agent-sdk')
    expect(provider.evidenceLabel).toBe('Implemented')
    expect(requests).toBe(0)
  })

  it('fails closed when the selected Claude provider is invalid', () => {
    expect(() =>
      createWorkerDecisionProvider({
        kind: 'claude',
        apiKey: 'short',
        authorization: {
          authorizationId: 'approval_test_001',
          maximumCostUsdPerDecision: 0.1,
        },
      }),
    ).toThrow(WorkerDecisionProviderError)
  })

  it('requires explicit authorization and cost configuration for Claude', () => {
    expect(() =>
      parseWorkerServerConfiguration({
        TRASH_PALACE_CARETAKER_PROVIDER: 'claude',
      }),
    ).toThrow(/TRASH_PALACE_CLAUDE_MAX_COST_USD_PER_DECISION is required/)
  })
})
