import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { deriveProgramMissionContextSelection } from '../packages/agent/src/context-routing.js'
import {
  validateKnowledgeCatalog,
  validateKnowledgeNavigation,
  validateKnowledgeSourceFiles,
} from '../packages/agent/src/knowledge.js'

interface Source {
  id: string
  owner: string
  claimIds: string[]
  dependsOn: string[]
  audiences: string[]
  tasks: string[]
  risk: string
  visibility: string
  sensitivity: string
  tenantScoped: boolean
  publishable: boolean
  instructionRole: string
  retention: string
  verifiedAgainst: Record<string, string>
  version: string
  canonicalUri: string
  sha256: string
}
interface Catalog {
  schemaVersion: string
  sources: Source[]
}
interface Step {
  sourceId: string
  prerequisiteSourceIds: string[]
  nextSourceId: string | null
  terminal: boolean
}
interface Navigation {
  schemaVersion: string
  sections: { id: string; title: string; items: { sourceId: string; label: string }[] }[]
  learningPaths: { id: string; title: string; steps: Step[] }[]
  helpTracks: {
    id: 'start' | 'automations' | 'troubleshoot' | 'understand_pal' | 'developer' | 'api_mcp'
    title: string
    audience: string[]
    items: (Step & { label: string })[]
  }[]
}

const root = resolve(import.meta.dirname, '..')
const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--')
const seedIndex = arguments_.indexOf('--seed')
if (seedIndex >= 0 && arguments_[seedIndex + 1] !== 'trashpal-knowledge-v1')
  throw new Error('Use --seed trashpal-knowledge-v1')
const mode = arguments_.includes('--write')
  ? 'write'
  : arguments_.includes('--check')
    ? 'check'
    : 'check'

const catalogPath = resolve(root, 'knowledge/catalog.json')
const navigationPath = resolve(root, 'knowledge/navigation.json')
const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Catalog
const navigation = JSON.parse(await readFile(navigationPath, 'utf8')) as Navigation

if (mode === 'write') {
  for (const source of catalog.sources)
    source.sha256 = sha256(await readFile(resolve(root, source.canonicalUri), 'utf8'))
  catalog.sources.sort((left, right) => left.canonicalUri.localeCompare(right.canonicalUri))
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  await writeFile(navigationPath, `${JSON.stringify(navigation, null, 2)}\n`)
}

const parsedCatalog = validateKnowledgeCatalog(catalog)
validateKnowledgeNavigation(parsedCatalog, navigation)
await validateKnowledgeSourceFiles(parsedCatalog, root)

const requiredHelpTracks = [
  'start',
  'automations',
  'troubleshoot',
  'understand_pal',
  'developer',
  'api_mcp',
]
if (navigation.helpTracks.map((track) => track.id).join(',') !== requiredHelpTracks.join(',')) {
  throw new Error('Help tracks must remain customer-first and developer-accessible')
}
assertIncludes(
  navigation.helpTracks
    .find((track) => track.id === 'developer')
    ?.items.map((item) => item.sourceId) ?? [],
  'procedure.build-http-mcp',
)
assertIncludes(
  navigation.helpTracks
    .find((track) => track.id === 'api_mcp')
    ?.items.map((item) => item.sourceId) ?? [],
  'resource.executable-contracts',
)

const homecoming = deriveProgramMissionContextSelection(
  'night_shift_homecoming',
  'consequential-write',
)
const hauler = deriveProgramMissionContextSelection(
  'scheduled_hauler_access',
  'consequential-write',
)
assertIncludes(homecoming.sourceIds, 'skill.homecoming')
assertExcludes(homecoming.sourceIds, 'skill.hauler-access')
assertIncludes(hauler.sourceIds, 'skill.hauler-access')
assertExcludes(hauler.sourceIds, 'skill.homecoming')
for (const shared of [
  'skill.shared.approval',
  'skill.shared.reconciliation',
  'skill.shared.verification',
]) {
  assertIncludes(homecoming.sourceIds, shared)
  assertIncludes(hauler.sourceIds, shared)
}

process.stdout.write(
  `${JSON.stringify({ status: 'current', seed: 'trashpal-knowledge-v1', sources: catalog.sources.length, helpTracks: navigation.helpTracks.length, homecomingSources: homecoming.sourceIds.length, haulerSources: hauler.sourceIds.length })}\n`,
)

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function assertIncludes(values: readonly string[], expected: string): void {
  if (!values.includes(expected)) throw new Error(`Expected focused context to include ${expected}`)
}
function assertExcludes(values: readonly string[], forbidden: string): void {
  if (values.includes(forbidden)) throw new Error(`Focused context leaked ${forbidden}`)
}
