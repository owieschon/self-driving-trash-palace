import { LiveValidationModeSchema, readinessFromEnvironment } from './readiness.js'

try {
  const mode = LiveValidationModeSchema.parse(process.argv[2])
  const readiness = readinessFromEnvironment(mode, process.env)
  process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`)
  process.exitCode = 2
} catch (error) {
  const message = error instanceof Error ? error.message : 'Invalid live-validation preflight'
  process.stderr.write(`Live-validation preflight failed: ${message}\n`)
  process.exitCode = 1
}
