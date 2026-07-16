import {
  DeterministicCaretakerDecisionEngine,
  createClaudeDecisionEngine,
  type CaretakerDecisionEngine,
  type ClaudeAgentSdkClient,
} from '@trash-palace/agent'

import type { CaretakerDecisionProviderConfiguration } from './server-configuration.js'

export class WorkerDecisionProviderError extends Error {
  public override readonly name = 'WorkerDecisionProviderError'
}

export type WorkerDecisionProvider = Readonly<{
  kind: CaretakerDecisionProviderConfiguration['kind']
  engine: CaretakerDecisionEngine
  evidenceLabel: 'Deterministic integration-proven' | 'Implemented'
}>

export function createWorkerDecisionProvider(
  configuration: CaretakerDecisionProviderConfiguration,
  client?: ClaudeAgentSdkClient,
): WorkerDecisionProvider {
  if (configuration.kind === 'deterministic') {
    return Object.freeze({
      kind: configuration.kind,
      engine: new DeterministicCaretakerDecisionEngine(),
      evidenceLabel: 'Deterministic integration-proven' as const,
    })
  }

  const result = createClaudeDecisionEngine({
    apiKey: configuration.apiKey,
    liveRequestAuthorization: configuration.authorization,
    ...(client === undefined ? {} : { client }),
  })
  if (result.status !== 'ready') {
    throw new WorkerDecisionProviderError(
      `Selected Claude decision provider cannot initialize: ${result.receipt.blocker}`,
    )
  }
  return Object.freeze({
    kind: configuration.kind,
    engine: result.engine,
    evidenceLabel: 'Implemented' as const,
  })
}
