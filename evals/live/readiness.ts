import { z } from 'zod'

export const LiveValidationModeSchema = z.enum(['baseline', 'promotion', 'posthog-ingestion'])

const BlockerSchema = z
  .object({
    code: z.enum([
      'operator_approval_missing',
      'budget_approval_missing',
      'model_credential_not_confirmed',
      'posthog_configuration_not_confirmed',
      'baseline_not_frozen',
      'corpus_runner_not_implemented',
    ]),
    resolved: z.boolean(),
  })
  .strict()

export const LiveValidationReadinessSchema = z
  .object({
    schemaVersion: z.literal('live-validation-readiness@1'),
    mode: LiveValidationModeSchema,
    status: z.literal('Blocked'),
    networkRequestsMade: z.literal(0),
    secretValuesRetained: z.literal(false),
    blockers: z.array(BlockerSchema).min(1),
    claims: z
      .object({
        liveModel: z.literal('Blocked'),
        posthogIngestion: z.literal('Blocked'),
        liveLoop: z.literal('Blocked'),
      })
      .strict(),
  })
  .strict()

export interface LiveValidationReadinessInput {
  readonly mode: z.infer<typeof LiveValidationModeSchema>
  readonly operatorApproved: boolean
  readonly budgetApproved: boolean
  readonly modelCredentialPresent: boolean
  readonly posthogConfigurationPresent: boolean
  readonly baselineFrozen: boolean
}

export function buildLiveValidationReadiness(input: LiveValidationReadinessInput) {
  const blockers = [
    { code: 'operator_approval_missing' as const, resolved: input.operatorApproved },
    { code: 'budget_approval_missing' as const, resolved: input.budgetApproved },
    ...(input.mode === 'posthog-ingestion'
      ? [
          {
            code: 'posthog_configuration_not_confirmed' as const,
            resolved: input.posthogConfigurationPresent,
          },
        ]
      : [
          {
            code: 'model_credential_not_confirmed' as const,
            resolved: input.modelCredentialPresent,
          },
        ]),
    ...(input.mode === 'promotion'
      ? [{ code: 'baseline_not_frozen' as const, resolved: input.baselineFrozen }]
      : []),
    { code: 'corpus_runner_not_implemented' as const, resolved: false },
  ]

  return LiveValidationReadinessSchema.parse({
    schemaVersion: 'live-validation-readiness@1',
    mode: input.mode,
    status: 'Blocked',
    networkRequestsMade: 0,
    secretValuesRetained: false,
    blockers,
    claims: {
      liveModel: 'Blocked',
      posthogIngestion: 'Blocked',
      liveLoop: 'Blocked',
    },
  })
}

export function readinessFromEnvironment(
  mode: z.infer<typeof LiveValidationModeSchema>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return buildLiveValidationReadiness({
    mode,
    operatorApproved: environment.TRASH_PALACE_LIVE_EVAL_APPROVED === 'true',
    budgetApproved: approvedPositiveBudget(environment.TRASH_PALACE_LIVE_EVAL_MAX_BUDGET_USD),
    modelCredentialPresent: nonempty(environment.ANTHROPIC_API_KEY),
    posthogConfigurationPresent:
      environment.TRASH_PALACE_POSTHOG_EXPORT_ENABLED === 'true' &&
      ['us', 'eu'].includes(environment.TRASH_PALACE_POSTHOG_REGION ?? '') &&
      nonempty(environment.TRASH_PALACE_POSTHOG_PROJECT_TOKEN),
    baselineFrozen: environment.TRASH_PALACE_LIVE_BASELINE_FROZEN === 'true',
  })
}

function nonempty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}

function approvedPositiveBudget(value: string | undefined): boolean {
  if (!nonempty(value)) return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}
