import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { hashToolValue } from '../../packages/core/src/index.js'

import {
  DeterministicCorpusReportSchema,
  buildDeterministicCorpusReport,
} from './deterministic-report.js'

const RETAINED_REPORT = 'evals/reports/deterministic-decision-contract.json'

try {
  await main(process.argv.slice(2))
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown deterministic report failure'
  process.stderr.write(`Deterministic report check failed: ${message}\n`)
  process.exitCode = 1
}

async function main(arguments_: readonly string[]): Promise<void> {
  const command = arguments_[0] ?? '--check'
  if (!['--check', '--print', '--write'].includes(command) || arguments_.length > 1) {
    throw new TypeError('Usage: deterministic-report-cli.ts [--check|--print|--write]')
  }

  const actual = await buildDeterministicCorpusReport()
  if (command === '--print') {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`)
    return
  }
  if (command === '--write') {
    await writeFile(resolve(process.cwd(), RETAINED_REPORT), `${JSON.stringify(actual, null, 2)}\n`)
    process.stdout.write(`Updated ${RETAINED_REPORT}.\n`)
    return
  }

  const retained = DeterministicCorpusReportSchema.parse(
    JSON.parse(await readFile(resolve(process.cwd(), RETAINED_REPORT), 'utf8')) as unknown,
  )
  if (hashToolValue(retained) !== hashToolValue(actual)) {
    throw new Error(`${RETAINED_REPORT} does not match the executable manifests and runner`)
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'verified',
      report: RETAINED_REPORT,
      proofLevel: actual.proofLevel,
      cases: actual.summary.caseCount,
      passed: actual.summary.passed,
    })}\n`,
  )
}
