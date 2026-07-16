import { pathToFileURL } from 'node:url'

import { parseGatewaySimulatorConfiguration } from './configuration.js'
import { createGatewaySimulatorProcess } from './runtime.js'

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown gateway simulator failure'
}

export async function runGatewaySimulatorMain(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const configuration = parseGatewaySimulatorConfiguration(environment, {
    requireSharedFixtureStart: true,
  })
  const runtime = createGatewaySimulatorProcess(configuration)
  let shutdownStarted = false
  let startup = Promise.resolve()
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (shutdownStarted) return
    shutdownStarted = true
    try {
      await startup.catch(() => undefined)
      await runtime.stop()
      process.stdout.write(
        `${JSON.stringify({ level: 'info', event: 'gateway_simulator.stopped', signal })}\n`,
      )
    } catch (error) {
      process.exitCode = 1
      process.stderr.write(
        `${JSON.stringify({
          level: 'error',
          event: 'gateway_simulator.shutdown_failed',
          signal,
          message: safeErrorMessage(error),
        })}\n`,
      )
    }
  }
  const handleSigterm = () => void shutdown('SIGTERM')
  const handleSigint = () => void shutdown('SIGINT')
  process.once('SIGTERM', handleSigterm)
  process.once('SIGINT', handleSigint)
  startup = runtime.start()
  try {
    await startup
  } catch (error) {
    process.off('SIGTERM', handleSigterm)
    process.off('SIGINT', handleSigint)
    throw error
  }
  const address = runtime.address
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      event: 'gateway_simulator.started',
      host: address?.address ?? configuration.bindHost,
      port: address?.port ?? configuration.port,
    })}\n`,
  )
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedAsScript) {
  runGatewaySimulatorMain().catch((error: unknown) => {
    process.exitCode = 1
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        event: 'gateway_simulator.start_failed',
        message: safeErrorMessage(error),
      })}\n`,
    )
  })
}
