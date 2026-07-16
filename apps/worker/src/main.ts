import { pathToFileURL } from 'node:url'

import { composeProductionWorker } from './production-runtime.js'
import { parseWorkerServerConfiguration } from './server-configuration.js'
import { createProductionWorkerProcess } from './worker-process.js'

export async function runWorkerMain(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const configuration = parseWorkerServerConfiguration(environment)
  const resources = await composeProductionWorker(configuration)
  const worker = createProductionWorkerProcess(resources, configuration)
  const state: {
    fatalError: Error | null
    stopPromise: Promise<void> | null
  } = { fatalError: null, stopPromise: null }
  let resolveStopped: () => void = () => undefined
  let rejectStopped: (error: unknown) => void = () => undefined
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve
    rejectStopped = reject
  })
  const requestStop = (error?: unknown): void => {
    if (error !== undefined && state.fatalError === null) state.fatalError = asError(error)
    if (state.stopPromise !== null) return
    state.stopPromise = worker.stop()
    void state.stopPromise.then(resolveStopped, rejectStopped)
  }
  const onSigterm = (): void => requestStop()
  const onSigint = (): void => requestStop()
  const onDatabaseError = (error: Error): void => requestStop(error)

  process.once('SIGTERM', onSigterm)
  process.once('SIGINT', onSigint)
  resources.pool.on('error', onDatabaseError)
  try {
    await worker.start()
    await stopped
    if (state.fatalError !== null) throw state.fatalError
  } catch (error) {
    const failure = asError(error)
    requestStop(failure)
    try {
      const stopping = state.stopPromise
      if (stopping !== null) await stopping
    } catch {
      // The primary process failure remains the actionable error.
    }
    throw failure
  } finally {
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
    resources.pool.off('error', onDatabaseError)
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Worker process failed', { cause: value })
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === import.meta.url
}

if (isDirectExecution()) {
  void runWorkerMain().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'UnknownWorkerError'
    console.error(`Trash Palace worker stopped: ${name}`)
    process.exitCode = 1
  })
}
