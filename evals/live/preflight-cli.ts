import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CARETAKER_MODEL,
} from '../../packages/agent/src/claude-decision-engine.js'
import { TOOL_REGISTRY_HASH } from '../../packages/core/src/index.js'
import { LIVE_CASES, LIVE_CASE_SET_ID, assertLiveCaseCatalog } from './case-catalog.js'

const PreflightReceiptSchema = z
  .object({
    schemaVersion: z.literal('live-evaluation-preflight@1'),
    status: z.enum(['Ready', 'Blocked']),
    implementationReady: z.literal(true),
    networkRequestsMade: z.literal(0),
    paidRequestAttempted: z.literal(false),
    secretValuesRetained: z.literal(false),
    dispatchId: z.literal('trashpal-finish-line-v1'),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    caseSetId: z.literal(LIVE_CASE_SET_ID),
    caseCount: z.literal(16),
    provider: z.literal('claude'),
    model: z.literal(CLAUDE_CARETAKER_MODEL),
    sdkVersion: z.literal(CLAUDE_AGENT_SDK_VERSION),
    toolRegistryHash: z.string().regex(/^[a-f0-9]{64}$/),
    blockers: z.array(z.enum(['current_paid_call_approval_missing', 'credential_not_confirmed'])),
  })
  .strict()

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const manifestFlag = args.indexOf('--manifest')
  if (manifestFlag < 0 || args[manifestFlag + 1] === undefined) {
    throw new Error('--manifest is required')
  }
  const manifestPath = resolve(args[manifestFlag + 1]!)
  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { dispatch_id?: unknown }
  if (manifest.dispatch_id !== 'trashpal-finish-line-v1') {
    throw new Error('Preflight manifest dispatch ID does not match')
  }
  assertLiveCaseCatalog()
  if (LIVE_CASES.length !== 16) throw new Error('Preflight case set is incomplete')

  const approved = process.env.TRASH_PALACE_LIVE_EVAL_APPROVED === 'true'
  const credentialConfirmed = process.env.TRASH_PALACE_LIVE_EVAL_CREDENTIAL_CONFIRMED === 'true'
  const blockers = [
    ...(approved ? [] : (['current_paid_call_approval_missing'] as const)),
    ...(credentialConfirmed ? [] : (['credential_not_confirmed'] as const)),
  ]
  const receipt = PreflightReceiptSchema.parse({
    schemaVersion: 'live-evaluation-preflight@1',
    status: blockers.length === 0 ? 'Ready' : 'Blocked',
    implementationReady: true,
    networkRequestsMade: 0,
    paidRequestAttempted: false,
    secretValuesRetained: false,
    dispatchId: 'trashpal-finish-line-v1',
    manifestSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
    caseSetId: LIVE_CASE_SET_ID,
    caseCount: 16,
    provider: 'claude',
    model: CLAUDE_CARETAKER_MODEL,
    sdkVersion: CLAUDE_AGENT_SDK_VERSION,
    toolRegistryHash: TOOL_REGISTRY_HASH,
    blockers,
  })
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Live preflight failed'}\n`)
  process.exitCode = 1
})
