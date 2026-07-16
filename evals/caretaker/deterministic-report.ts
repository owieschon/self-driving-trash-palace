import { hashToolValue } from '../../packages/core/src/index.js'
import { DeterministicCaretakerDecisionEngine } from '../../packages/agent/src/deterministic-decision-engine.js'
import {
  DeterministicRunReceiptSchema,
  runDeterministicScenario,
} from '../../packages/agent/src/deterministic-harness.js'
import { z } from 'zod'

import { CARETAKER_DETERMINISTIC_CASES } from './deterministic-cases.js'
import { CARETAKER_SCENARIO_MANIFESTS } from './manifests.js'

const ReportCaseSchema = z
  .object({
    manifestId: z.string().min(1),
    case: z.string().min(1),
    expectedTerminalOutcome: z.string().min(1),
    observedTerminalOutcome: z.string().min(1),
    safeOutcome: z.boolean(),
    passed: z.boolean(),
    receipt: DeterministicRunReceiptSchema,
  })
  .strict()

export const DeterministicCorpusReportSchema = z
  .object({
    schemaVersion: z.literal('caretaker-deterministic-corpus-report@1'),
    evidenceLabel: z.literal('Deterministic-verified'),
    proofLevel: z.literal('decision_contract_simulation'),
    engineId: z.literal('deterministic-caretaker@1'),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z
      .object({
        caseCount: z.literal(12),
        passed: z.number().int().min(0).max(12),
        failed: z.number().int().min(0).max(12),
        safeOutcomes: z.number().int().min(0).max(12),
      })
      .strict(),
    cases: z.array(ReportCaseSchema).length(12),
    proofBoundary: z
      .object({
        proves: z.array(z.string().min(1)).min(1),
        doesNotProve: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict()

export type DeterministicCorpusReport = z.infer<typeof DeterministicCorpusReportSchema>

export async function buildDeterministicCorpusReport(): Promise<DeterministicCorpusReport> {
  const engine = new DeterministicCaretakerDecisionEngine()
  const cases = []

  for (const scenario of CARETAKER_DETERMINISTIC_CASES) {
    const result = await runDeterministicScenario(
      engine,
      scenario.createEnvironment(),
      scenario.manifest,
    )
    cases.push({
      manifestId: result.manifest.id,
      case: result.manifest.case,
      expectedTerminalOutcome: result.manifest.expectedTerminalOutcome,
      observedTerminalOutcome: result.observation.terminalOutcome,
      safeOutcome: result.observation.safeOutcome,
      passed: result.score.passed,
      receipt: result.receipt,
    })
  }

  return DeterministicCorpusReportSchema.parse({
    schemaVersion: 'caretaker-deterministic-corpus-report@1',
    evidenceLabel: 'Deterministic-verified',
    proofLevel: 'decision_contract_simulation',
    engineId: engine.id,
    manifestHash: hashToolValue(CARETAKER_SCENARIO_MANIFESTS),
    summary: {
      caseCount: 12,
      passed: cases.filter((entry) => entry.passed).length,
      failed: cases.filter((entry) => !entry.passed).length,
      safeOutcomes: cases.filter((entry) => entry.safeOutcome).length,
    },
    cases,
    proofBoundary: {
      proves: [
        'The provider-neutral deterministic engine reaches each versioned manifest outcome.',
        'The scorer rejects forbidden mutations, unsupported claims, unsafe outcomes, and budget overruns.',
        'Every retained material claim in this simulation cites typed evidence.',
      ],
      doesNotProve: [
        'A live model selects the same context, decisions, or tools.',
        'PostgreSQL, HTTP, MCP, worker, gateway, or verifier durability.',
        'PostHog ingestion, live latency, token use, cost, or a completed self-improving loop.',
      ],
    },
  })
}
