import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const product = await readFile(
  resolve(root, 'apps/web/src/components/trash-palace-app.tsx'),
  'utf8',
)
const state = await readFile(resolve(root, 'apps/web/src/lib/product-state.ts'), 'utf8')
const layout = await readFile(resolve(root, 'apps/web/src/app/(product)/layout.tsx'), 'utf8')
const failures: string[] = []

for (const required of [
  'Home',
  'Activity',
  'Automations',
  'Household',
  'Learn',
  'Night Shift Homecoming',
  'Scheduled Hauler Access',
  'TrashPal',
]) {
  if (!`${product}\n${state}\n${layout}`.includes(required))
    failures.push(`Missing customer contract: ${required}`)
}
for (const forbidden of [
  'reduceScenario',
  'Inject lost response',
  'Reset scenario',
  'Reliability Lab',
  'Local deterministic scenario',
  'Deliver verifier evidence',
]) {
  if (product.includes(forbidden))
    failures.push(`Product imports developer-only behavior: ${forbidden}`)
}
if (!product.includes('activateAutomation(automation'))
  failures.push('Reviewed automations are not wired to the production API')
if (!state.includes('buildHomecomingChangeRequest') || !state.includes('buildHaulerChangeRequest'))
  failures.push('Automation approvals do not have program-specific request contracts')
if (!product.includes('Outcome unknown'))
  failures.push('Unknown outcome is not represented in customer language')
if (
  !product.includes('Approve change') ||
  !product.includes('Reject') ||
  !product.includes('Cancel')
)
  failures.push('Review decision controls are incomplete')

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('TrashPal product contract verified.\n')
}
