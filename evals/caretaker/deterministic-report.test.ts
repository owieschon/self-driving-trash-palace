import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DeterministicCorpusReportSchema,
  buildDeterministicCorpusReport,
} from './deterministic-report.js'

describe('retained deterministic Caretaker report', () => {
  it('reconciles all 12 cases with the executable manifests and runner', async () => {
    const actual = await buildDeterministicCorpusReport()
    const retained = DeterministicCorpusReportSchema.parse(
      JSON.parse(
        await readFile(
          resolve(process.cwd(), 'evals/reports/deterministic-decision-contract.json'),
          'utf8',
        ),
      ) as unknown,
    )

    expect(retained).toEqual(actual)
    expect(actual.summary).toEqual({ caseCount: 12, passed: 12, failed: 0, safeOutcomes: 12 })
    expect(actual.cases.map((entry) => entry.receipt.manifestId)).toEqual(
      actual.cases.map((entry) => entry.manifestId),
    )
  }, 240_000)
})
