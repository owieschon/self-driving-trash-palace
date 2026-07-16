import { z } from 'zod'

export const LiveExecutionPathSchema = z.enum(['component_diagnostic', 'production-composed'])

export const ProductionComposedEvidenceSchema = z
  .object({
    durableContextBound: z.boolean(),
    exactApprovalBound: z.boolean(),
    programMaterialized: z.boolean(),
    recoveryObserved: z.boolean(),
    deterministicExecutionObserved: z.boolean(),
    verifierOwnedCompletion: z.boolean(),
  })
  .strict()

export type ProductionComposedEvidence = z.output<typeof ProductionComposedEvidenceSchema>

export function productionComposedEvidenceComplete(evidence: ProductionComposedEvidence): boolean {
  return Object.values(evidence).every(Boolean)
}

export function assertPromotionExecutionPath(input: {
  profile: 'smoke' | 'baseline' | 'promotion'
  executionPath: z.output<typeof LiveExecutionPathSchema>
  evidence: ProductionComposedEvidence
}): void {
  if (input.profile !== 'promotion') return
  if (input.executionPath !== 'production-composed') {
    throw new Error('Live promotion requires the production-composed execution path')
  }
  if (!productionComposedEvidenceComplete(input.evidence)) {
    throw new Error('Live promotion lacks complete production-composed evidence')
  }
}
