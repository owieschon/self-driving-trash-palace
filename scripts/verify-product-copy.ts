import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const publicSurfaces = [
  'README.md',
  'knowledge/README.md',
  'knowledge/navigation.json',
  'apps/web/src/app/(product)/layout.tsx',
  'apps/web/src/components/trash-palace-app.tsx',
  'apps/web/src/lib/product-state.ts',
]

export function inspectPublicProductCopy(body: string): string[] {
  const failures: string[] = []

  for (const forbidden of [
    'Self-Driving Trash Palace',
    'Self-Driving TrashPal',
    'Credential-free Quest Log',
    'Reliability Lab',
    'Ask Pal anything',
    'unlimited chat',
    'Google Home integration is ready',
    'Alexa integration is ready',
    'Household',
  ]) {
    if (body.includes(forbidden))
      failures.push(`Public product copy contains forbidden claim: ${forbidden}`)
  }
  for (const required of [
    'TrashPal',
    'Automations',
    'Workspace',
    'Scheduled Hauler Access',
    'Validate an improvement metric',
  ]) {
    if (!body.includes(required)) failures.push(`Public product copy is missing: ${required}`)
  }

  return failures
}

async function main() {
  const body = (
    await Promise.all(publicSurfaces.map((path) => readFile(resolve(root, path), 'utf8')))
  ).join('\n')
  const failures = inspectPublicProductCopy(body)

  if (failures.length) {
    process.stderr.write(`${failures.join('\n')}\n`)
    process.exitCode = 1
  } else process.stdout.write('TrashPal public copy verified.\n')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
