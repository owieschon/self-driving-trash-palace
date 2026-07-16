import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const publicSurfaces = [
  'README.md',
  'knowledge/index.md',
  'knowledge/navigation.json',
  'apps/web/src/app/(product)/layout.tsx',
  'apps/web/src/components/trash-palace-app.tsx',
]
const body = (
  await Promise.all(publicSurfaces.map((path) => readFile(resolve(root, path), 'utf8')))
).join('\n')
const failures: string[] = []
for (const forbidden of [
  'Self-Driving Trash Palace',
  'Self-Driving TrashPal',
  'Trash Palace',
  'Credential-free Quest Log',
  'Reliability Lab',
])
  if (body.includes(forbidden))
    failures.push(`Public product copy contains obsolete wording: ${forbidden}`)
for (const required of [
  'TrashPal',
  'Automations',
  'Household',
  'Scheduled Hauler Access',
  'Improve your first automation',
])
  if (!body.includes(required)) failures.push(`Public product copy is missing: ${required}`)
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else process.stdout.write('TrashPal public copy verified.\n')
