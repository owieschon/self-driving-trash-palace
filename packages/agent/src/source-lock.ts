import { z } from 'zod'

import { ClaimRegistrySchema } from './knowledge.js'
import {
  ClaimIdSchema,
  HttpsUriSchema,
  IsoDateSchema,
  SCHEMA_VERSION,
  StableIdSchema,
  uniqueArray,
} from './primitives.js'

const SourceLockEntrySchema = z
  .object({
    id: StableIdSchema,
    title: z.string().min(1).max(200),
    url: HttpsUriSchema,
    verifiedAt: IsoDateSchema,
    temporallySensitive: z.boolean(),
    conventions: uniqueArray(z.string().min(1).max(240), 'Conventions').min(1),
    affectedClaimIds: uniqueArray(ClaimIdSchema, 'Affected claim IDs').min(1),
  })
  .strict()

export const SourceLockSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    sourceReviewDate: IsoDateSchema,
    sources: z.array(SourceLockEntrySchema).min(1),
  })
  .strict()
  .superRefine((lock, context) => {
    const seen = new Set<string>()
    lock.sources.forEach((source, index) => {
      if (seen.has(source.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Source-lock IDs must be unique',
          path: ['sources', index],
        })
      }
      seen.add(source.id)
    })
  })

export type SourceLock = z.infer<typeof SourceLockSchema>

export function validateSourceLock(input: unknown, claimRegistryInput: unknown): SourceLock {
  const sourceLock = SourceLockSchema.parse(input)
  const claims = ClaimRegistrySchema.parse(claimRegistryInput)
  const knownClaims = new Set(claims.claims.map((claim) => claim.id))

  for (const source of sourceLock.sources) {
    for (const claimId of source.affectedClaimIds) {
      if (!knownClaims.has(claimId)) {
        throw new Error(`Source lock ${source.id} references unknown claim ${claimId}`)
      }
    }
  }

  return sourceLock
}
