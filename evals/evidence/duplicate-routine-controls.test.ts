import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { assertPublicationSafe } from '../../packages/observability/src/index.js'
import { describe, expect, it } from 'vitest'

import {
  DuplicateRoutineExecutableEvidenceReportSchema,
  assertDuplicateRoutineExecutableControlGate,
  buildDuplicateRoutineExecutableEvidenceReport,
} from './duplicate-routine-controls.js'

describe('retained duplicate-routine executable evidence report', () => {
  it('reconciles with the executable fixture, source adapter, and control contract', async () => {
    const actual = buildDuplicateRoutineExecutableEvidenceReport()
    const retained = DuplicateRoutineExecutableEvidenceReportSchema.parse(
      JSON.parse(
        await readFile(
          resolve(process.cwd(), 'evals/reports/duplicate-routine-controls.json'),
          'utf8',
        ),
      ) as unknown,
    )

    expect(retained).toEqual(actual)
    expect(actual.acceptance).toEqual({
      status: 'passed',
      brokenActiveRoutineCount: 2,
      correctedActiveRoutineCount: 1,
      brokenVerifierStatus: 'failed',
      correctedVerifierStatus: 'passed',
    })
    expect(actual.comparison.controlGate.status).toBe('passed')
    expect(actual.evidenceClassification).toMatchObject({
      posthogIngestion: 'Blocked',
      liveImprovementLoop: 'Blocked',
    })
    expect(() => assertPublicationSafe(retained)).not.toThrow()
  })

  it('rejects a broken control without exactly two active routines', () => {
    const report = buildDuplicateRoutineExecutableEvidenceReport()

    expect(() =>
      assertDuplicateRoutineExecutableControlGate({
        brokenActiveRoutineCount: 1,
        correctedActiveRoutineCount: 1,
        comparison: report.comparison,
      }),
    ).toThrow('exactly two active routines')
  })

  it('rejects a corrected control without exactly one active routine', () => {
    const report = buildDuplicateRoutineExecutableEvidenceReport()

    expect(() =>
      assertDuplicateRoutineExecutableControlGate({
        brokenActiveRoutineCount: 2,
        correctedActiveRoutineCount: 2,
        comparison: report.comparison,
      }),
    ).toThrow('exactly one active routine')
  })

  it('contains aliases and stable evidence identities rather than raw fixture IDs', () => {
    const serialized = JSON.stringify(buildDuplicateRoutineExecutableEvidenceReport())

    expect(serialized).not.toContain('org_rocky_roost')
    expect(serialized).not.toContain('mis_night_shift_home')
    expect(serialized).not.toContain('pln_homecoming_energy')
    expect(serialized).not.toContain('op_evidence_')
    expect(serialized).not.toContain('run_duplicate_')
    expect(serialized).toContain('tpa_organization_v1_')
  })
})
