import { z } from 'zod'

import {
  ContextReceiptIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  RunIdSchema,
  Sha256Schema,
} from './identifiers.js'

export const ContextSourceReceiptSchema = z
  .object({
    sourceId: z.string().regex(/^[a-z][a-z0-9_.:/-]{2,199}$/),
    version: z.string().min(1).max(120),
    contentHash: Sha256Schema,
    authority: z.enum(['host_policy', 'tool_contract', 'skill', 'reference', 'evidence']),
  })
  .strict()

export const ContextReceiptSchema = z
  .object({
    id: ContextReceiptIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    runId: RunIdSchema,
    policyHash: Sha256Schema,
    toolRegistryHash: Sha256Schema,
    sources: z.array(ContextSourceReceiptSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const sourceKeys = receipt.sources.map((source) => `${source.sourceId}@${source.version}`)
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Context sources must be unique' })
    }
  })

export type ContextSourceReceipt = z.infer<typeof ContextSourceReceiptSchema>
export type ContextReceipt = z.infer<typeof ContextReceiptSchema>
