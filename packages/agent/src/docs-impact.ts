import { z } from 'zod'

import { ClaimRegistrySchema } from './knowledge.js'
import {
  ClaimIdSchema,
  IsoDateTimeSchema,
  RepoRelativeUriSchema,
  SCHEMA_VERSION,
  StableIdSchema,
  uniqueArray,
} from './primitives.js'

const DocsImpactBaseShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  changeId: StableIdSchema,
  changedContracts: uniqueArray(StableIdSchema, 'Changed contracts').min(1),
  affectedClaimIds: uniqueArray(ClaimIdSchema, 'Affected claim IDs'),
  assessedAt: IsoDateTimeSchema,
}

export const ContractClaimSchema = z
  .object({
    id: StableIdSchema,
    userFacing: z.boolean(),
    claimIds: uniqueArray(ClaimIdSchema, 'Contract claim IDs'),
    sourceIds: uniqueArray(StableIdSchema, 'Contract source IDs'),
  })
  .strict()

export const ContractClaimRegistrySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    contracts: z.array(ContractClaimSchema).min(1),
  })
  .strict()
  .superRefine((registry, context) => {
    const seen = new Set<string>()
    registry.contracts.forEach((contract, index) => {
      if (seen.has(contract.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Contract IDs must be unique',
          path: ['contracts', index, 'id'],
        })
      }
      seen.add(contract.id)
    })
  })

export type ContractClaimRegistry = z.infer<typeof ContractClaimRegistrySchema>

const UpdatedDocsImpactSchema = z
  .object({
    ...DocsImpactBaseShape,
    affectedClaimIds: uniqueArray(ClaimIdSchema, 'Affected claim IDs').min(1),
    disposition: z.literal('updated'),
    updatedSourceIds: uniqueArray(StableIdSchema, 'Updated source IDs').min(1),
  })
  .strict()

const GeneratedOnlyDocsImpactSchema = z
  .object({
    ...DocsImpactBaseShape,
    disposition: z.literal('generated-only'),
    generatedArtifacts: uniqueArray(RepoRelativeUriSchema, 'Generated artifacts').min(1),
  })
  .strict()

const NoUserImpactDocsImpactSchema = z
  .object({
    ...DocsImpactBaseShape,
    disposition: z.literal('no-user-impact'),
    affectedClaimIds: z.array(ClaimIdSchema).length(0),
    reason: z.string().min(12).max(500),
  })
  .strict()

export const DocsImpactSchema = z.discriminatedUnion('disposition', [
  UpdatedDocsImpactSchema,
  GeneratedOnlyDocsImpactSchema,
  NoUserImpactDocsImpactSchema,
])

export type DocsImpact = z.infer<typeof DocsImpactSchema>

export function validateDocsImpact(input: unknown, claimRegistryInput: unknown): DocsImpact {
  const impact = DocsImpactSchema.parse(input)
  const claimRegistry = ClaimRegistrySchema.parse(claimRegistryInput)
  const knownClaims = new Map(claimRegistry.claims.map((claim) => [claim.id, claim]))

  for (const claimId of impact.affectedClaimIds) {
    if (!knownClaims.has(claimId)) {
      throw new Error(`Documentation impact references unknown claim ${claimId}`)
    }
  }

  if (impact.disposition === 'updated') {
    const updatedSources = new Set(impact.updatedSourceIds)
    for (const claimId of impact.affectedClaimIds) {
      const claim = knownClaims.get(claimId)
      if (!claim || !updatedSources.has(claim.sourceId)) {
        throw new Error(`Documentation impact does not update the source that owns ${claimId}`)
      }
    }
  }

  return impact
}

export function validateResolvedDocsImpact(
  input: unknown,
  claimRegistryInput: unknown,
  contractRegistryInput: unknown,
): DocsImpact {
  const impact = validateDocsImpact(input, claimRegistryInput)
  const claimRegistry = ClaimRegistrySchema.parse(claimRegistryInput)
  const contractRegistry = ContractClaimRegistrySchema.parse(contractRegistryInput)
  const contracts = new Map(contractRegistry.contracts.map((contract) => [contract.id, contract]))
  const claims = new Map(claimRegistry.claims.map((claim) => [claim.id, claim]))

  const changedContracts = impact.changedContracts.map((contractId) => {
    const contract = contracts.get(contractId)
    if (!contract) throw new Error(`Documentation impact references unknown contract ${contractId}`)
    return contract
  })
  if (impact.disposition === 'no-user-impact' && changedContracts.some((item) => item.userFacing)) {
    throw new Error('Public contracts cannot use no-user-impact')
  }
  if (impact.disposition === 'generated-only' && changedContracts.some((item) => item.userFacing)) {
    throw new Error('User-facing contracts cannot use generated-only')
  }
  const expectedClaims = new Set(changedContracts.flatMap((contract) => contract.claimIds))
  const actualClaims = new Set(impact.affectedClaimIds)
  const missingClaims = [...expectedClaims].filter((claimId) => !actualClaims.has(claimId))
  const extraClaims = [...actualClaims].filter((claimId) => !expectedClaims.has(claimId))
  if (missingClaims.length > 0) {
    throw new Error(`Documentation impact is missing affected claims: ${missingClaims.join(', ')}`)
  }
  if (extraClaims.length > 0) {
    throw new Error(`Documentation impact contains extra unowned claims: ${extraClaims.join(', ')}`)
  }

  for (const contract of contractRegistry.contracts) {
    for (const claimId of contract.claimIds) {
      const claim = claims.get(claimId)
      if (!claim) throw new Error(`Contract ${contract.id} references unknown claim ${claimId}`)
      if (!contract.sourceIds.includes(claim.sourceId)) {
        throw new Error(`Contract ${contract.id} does not name source owner ${claim.sourceId}`)
      }
    }
  }

  return impact
}
