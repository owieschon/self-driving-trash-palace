import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  assertPublicationSafe,
  canonicalJson,
  type JsonValue,
} from '../../packages/observability/src/index.js'

import {
  DuplicateRoutineExecutableEvidenceReportSchema,
  buildDuplicateRoutineExecutableEvidenceReport,
} from './duplicate-routine-controls.js'

const RETAINED_REPORT = 'evals/reports/duplicate-routine-controls.json'

try {
  await main(process.argv.slice(2))
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown evidence report failure'
  process.stderr.write(`Duplicate-routine evidence report check failed: ${message}\n`)
  process.exitCode = 1
}

async function main(arguments_: readonly string[]): Promise<void> {
  const command = arguments_[0] ?? '--check'
  if (!['--check', '--print'].includes(command) || arguments_.length > 1) {
    throw new TypeError('Usage: duplicate-routine-report-cli.ts [--check|--print]')
  }

  const actual = buildDuplicateRoutineExecutableEvidenceReport()
  if (command === '--print') {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`)
    return
  }

  const retained = DuplicateRoutineExecutableEvidenceReportSchema.parse(
    JSON.parse(await readFile(resolve(process.cwd(), RETAINED_REPORT), 'utf8')) as unknown,
  )
  assertPublicationSafe(retained)
  if (canonicalJson(retained) !== canonicalJson(actual as unknown as JsonValue)) {
    throw new Error(`${RETAINED_REPORT} does not match the executable fixture and evidence adapter`)
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'verified',
      report: RETAINED_REPORT,
      brokenActiveRoutines: actual.acceptance.brokenActiveRoutineCount,
      correctedActiveRoutines: actual.acceptance.correctedActiveRoutineCount,
      posthogIngestion: actual.evidenceClassification.posthogIngestion,
      liveImprovementLoop: actual.evidenceClassification.liveImprovementLoop,
    })}\n`,
  )
}
