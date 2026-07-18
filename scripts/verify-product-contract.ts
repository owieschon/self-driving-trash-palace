import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sources = await readSources([
  'apps/web/src/components/trash-palace-app.tsx',
  'apps/web/src/lib/product-api.ts',
  'apps/web/src/lib/product-state.ts',
  'apps/web/src/server/api-contracts.ts',
  'docs/product/product-language-and-state-contract.md',
])
const failures: string[] = []

for (const required of [
  'createMission',
  'pollMissionTasks',
  'getApproval',
  'answerClarification',
  'decideApproval',
  'mission_created',
  'needs_approval',
  'checking_result',
  'PalaceWorkspaceResponseSchema',
  'MissionProgressResponseSchema',
  'HelpCatalogEntryResponseSchema',
  'TrashPal',
  'Palace workspace',
  'Pal',
]) {
  if (!sources.includes(required)) failures.push(`Missing frozen product contract: ${required}`)
}

for (const forbidden of [
  'activateAutomation(',
  'Change recorded',
  'Approve change',
  'chat with Pal',
  'Ask Pal anything',
  'unlimited chat',
]) {
  if (sources.includes(forbidden))
    failures.push(`Forbidden product behavior or claim: ${forbidden}`)
}

const component = await readFile(
  resolve(root, 'apps/web/src/components/trash-palace-app.tsx'),
  'utf8',
)
for (const forbidden of [
  'Date(',
  'toLocaleString(',
  'toLocaleTimeString(',
  'Intl.DateTimeFormat(',
]) {
  if (component.includes(forbidden)) {
    failures.push(
      `Palace presentation time must be server-derived, not browser-local: ${forbidden}`,
    )
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('TrashPal product contract verified.\n')
}

async function readSources(paths: readonly string[]): Promise<string> {
  return (await Promise.all(paths.map((path) => readFile(resolve(root, path), 'utf8')))).join('\n')
}
