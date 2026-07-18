import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const contractPath = 'docs/product/product-language-and-state-contract.md'
const mapPath = 'docs/product/revision-preservation-map.md'
const [contract, preservationMap] = await Promise.all([
  readFile(resolve(root, contractPath), 'utf8'),
  readFile(resolve(root, mapPath), 'utf8'),
])

const failures: string[] = []
for (const term of [
  'TrashPal',
  'Palace',
  'Palace workspace',
  'Pal',
  'Member',
  'Goal',
  'Automation',
  'Safety rule',
  'Proposal',
  'Approval',
  'Activity',
]) {
  if (!new RegExp(`\\|\\s*${term}\\s*\\|`).test(contract)) {
    failures.push(`Missing canonical product term: ${term}`)
  }
}
for (const state of [
  'working',
  'needs_input',
  'needs_approval',
  'applying',
  'checking_result',
  'verified',
  'failed',
  'cancelled',
]) {
  if (!contract.includes(`\`${state}\``)) failures.push(`Missing canonical display state: ${state}`)
}

const owners = [
  ['TenantReadService', 'packages/application/src/tenant-read-service.ts'],
  ['MissionBootstrapService', 'packages/application/src/mission-bootstrap-service.ts'],
  ['HumanTaskService', 'packages/application/src/human-task-service.ts'],
  ['ClarificationService', 'packages/application/src/clarification-service.ts'],
  ['ApprovalService', 'packages/application/src/approval-service.ts'],
  ['OperationService', 'packages/application/src/operation-service.ts'],
  ['VerificationService', 'packages/application/src/verification-service.ts'],
  ['Worker runtime', 'apps/worker/src/worker-runtime.ts'],
  ['knowledge/catalog.json', 'knowledge/catalog.json'],
] as const

for (const [owner, path] of owners) {
  if (!preservationMap.includes(owner)) failures.push(`Preservation map omits owner: ${owner}`)
  try {
    await access(resolve(root, path))
  } catch {
    failures.push(`Preservation map names a missing owner path: ${path}`)
  }
}

for (const constraint of [
  'hard-coded fixture data',
  'new database table',
  'second knowledge tree',
]) {
  if (!preservationMap.includes(constraint)) {
    failures.push(`Preservation map is missing parallel-structure constraint: ${constraint}`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('TrashPal revision preservation verified.\n')
}
