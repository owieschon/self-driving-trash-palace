import { access, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import { parseSafeEvidenceEvent } from '../contracts.js'
import { LocalJsonlEvidenceSink } from '../sink.js'

const [filePath, encodedEvent, readyPath, startPath] = process.argv.slice(2)

if (
  filePath === undefined ||
  encodedEvent === undefined ||
  readyPath === undefined ||
  startPath === undefined
) {
  throw new Error('Expected file, event, ready, and start arguments')
}

const event = parseSafeEvidenceEvent(
  JSON.parse(Buffer.from(encodedEvent, 'base64url').toString('utf8')),
)
const sink = new LocalJsonlEvidenceSink(filePath)

await writeFile(readyPath, 'ready\n', { encoding: 'utf8', mode: 0o600 })
for (;;) {
  try {
    await access(startPath)
    break
  } catch {
    await delay(5)
  }
}

try {
  const result = await sink.capture(event)
  process.stdout.write(`${JSON.stringify({ kind: 'result', ...result })}\n`)
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      kind: 'error',
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  )
}
