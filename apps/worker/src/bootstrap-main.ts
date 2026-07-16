import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runDatabaseBootstrap } from './database-bootstrap.js'
import { parseWorkerBootstrapConfiguration } from './server-configuration.js'

export async function runBootstrapMain(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const configuration = parseWorkerBootstrapConfiguration(environment)
  const result = await runDatabaseBootstrap(configuration)
  process.stdout.write(
    `Database ready: ${result.insertedRecordCount} baseline records inserted; ${result.indexedKnowledgeSourceCount} knowledge sources indexed.\n`,
  )
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url
}

if (isDirectExecution()) {
  runBootstrapMain().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'UnknownError'
    process.stderr.write(`Database bootstrap failed (${name}).\n`)
    process.exitCode = 1
  })
}
