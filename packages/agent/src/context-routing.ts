import {
  MissionPhaseSchema,
  MissionProgramKindSchema,
  TOOL_SCHEMA_PROJECTIONS,
  ToolNameSchema,
  type MissionProgramKind,
  type ToolName,
} from '@trash-palace/core'
import { z } from 'zod'

import { KnowledgeRiskSchema } from './knowledge.js'
import { StableIdSchema, uniqueArray } from './primitives.js'

export const MandatoryContextSelectionSchema = z
  .object({
    sourceIds: uniqueArray(StableIdSchema, 'Mandatory context source IDs').min(2),
    toolNames: uniqueArray(ToolNameSchema, 'Mandatory tool names').min(1),
  })
  .strict()

export const ContextBudgetSchema = z
  .object({
    maxTotalBytes: z.number().int().positive(),
    maxAuthoredBytes: z.number().int().positive(),
    maxRuntimeBytes: z.number().int().positive(),
    maxContractBytes: z.number().int().positive(),
    maxOptionalSources: z.number().int().nonnegative(),
    maxRuntimeSnapshots: z.number().int().nonnegative(),
    maxToolContracts: z.number().int().positive(),
  })
  .strict()

export type MandatoryContextSelection = z.infer<typeof MandatoryContextSelectionSchema>
export type ContextBudget = z.infer<typeof ContextBudgetSchema>
export type ContextMissionPhase = z.infer<typeof MissionPhaseSchema>
export type ContextRisk = z.infer<typeof KnowledgeRiskSchema>

const PHASE_SOURCE_IDS = {
  understand: [],
  plan: [],
  validate: [],
  approve: ['skill.shared.approval'],
  execute: ['skill.shared.approval'],
  reconcile: ['skill.shared.reconciliation'],
  observe: ['skill.shared.verification'],
  verify: ['skill.shared.verification'],
} as const satisfies Record<ContextMissionPhase, readonly string[]>

const PROGRAM_SOURCE_IDS = {
  night_shift_homecoming: {
    root: 'skill.homecoming',
    plan: 'skill.homecoming.planning',
    validate: 'skill.homecoming.simulation',
  },
  scheduled_hauler_access: {
    root: 'skill.hauler-access',
    plan: 'skill.hauler-access.planning',
    validate: 'skill.hauler-access.simulation',
  },
} as const satisfies Record<
  MissionProgramKind,
  { readonly root: string; readonly plan: string; readonly validate: string }
>

const RISK_SOURCE_IDS = {
  read: [],
  'reversible-write': ['concept.missions-plans-operations'],
  'consequential-write': ['concept.missions-plans-operations', 'concept.unknown-outcomes'],
} as const satisfies Record<ContextRisk, readonly string[]>

const TOOL_RISKS_BY_CONTEXT_RISK = {
  read: new Set(['read', 'control']),
  'reversible-write': new Set(['read', 'proposal', 'pause', 'control']),
  'consequential-write': new Set(['read', 'proposal', 'pause', 'consequential', 'control']),
} as const satisfies Record<ContextRisk, ReadonlySet<string>>

const CONTEXT_BUDGETS = {
  read: {
    maxTotalBytes: 1_250_000,
    maxAuthoredBytes: 96_000,
    maxRuntimeBytes: 48_000,
    maxContractBytes: 1_000_000,
    maxOptionalSources: 2,
    maxRuntimeSnapshots: 6,
    maxToolContracts: 12,
  },
  'reversible-write': {
    maxTotalBytes: 1_500_000,
    maxAuthoredBytes: 128_000,
    maxRuntimeBytes: 64_000,
    maxContractBytes: 1_200_000,
    maxOptionalSources: 3,
    maxRuntimeSnapshots: 8,
    maxToolContracts: 15,
  },
  'consequential-write': {
    maxTotalBytes: 1_750_000,
    maxAuthoredBytes: 160_000,
    maxRuntimeBytes: 96_000,
    maxContractBytes: 1_400_000,
    maxOptionalSources: 4,
    maxRuntimeSnapshots: 10,
    maxToolContracts: 15,
  },
} as const satisfies Record<ContextRisk, ContextBudget>

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort()
}

export function deriveMandatoryContextSelection(
  phaseInput: ContextMissionPhase,
  riskInput: ContextRisk,
): MandatoryContextSelection {
  return deriveProgramContextSelection('night_shift_homecoming', phaseInput, riskInput)
}

export function deriveProgramContextSelection(
  programKindInput: MissionProgramKind,
  phaseInput: ContextMissionPhase,
  riskInput: ContextRisk,
): MandatoryContextSelection {
  const programKind = MissionProgramKindSchema.parse(programKindInput)
  const phase = MissionPhaseSchema.parse(phaseInput)
  const risk = KnowledgeRiskSchema.parse(riskInput)
  const allowedToolRisks = TOOL_RISKS_BY_CONTEXT_RISK[risk]

  const toolNames = TOOL_SCHEMA_PROJECTIONS.filter(
    (tool) => tool.allowedPhases.includes(phase) && allowedToolRisks.has(tool.risk),
  ).map((tool) => tool.name)

  return MandatoryContextSelectionSchema.parse({
    sourceIds: uniqueSorted([
      'concept.context-authority',
      PROGRAM_SOURCE_IDS[programKind].root,
      ...RISK_SOURCE_IDS[risk],
      ...PHASE_SOURCE_IDS[phase],
      ...(phase === 'plan' ? [PROGRAM_SOURCE_IDS[programKind].plan] : []),
      ...(phase === 'validate' ? [PROGRAM_SOURCE_IDS[programKind].validate] : []),
    ]),
    toolNames: uniqueSorted<ToolName>(toolNames),
  })
}

export function deriveProgramMissionContextSelection(
  programKindInput: MissionProgramKind,
  riskInput: ContextRisk,
): MandatoryContextSelection {
  const programKind = MissionProgramKindSchema.parse(programKindInput)
  const risk = KnowledgeRiskSchema.parse(riskInput)
  const selections = MissionPhaseSchema.options.map((phase) =>
    deriveProgramContextSelection(programKind, phase, risk),
  )
  return MandatoryContextSelectionSchema.parse({
    sourceIds: uniqueSorted(selections.flatMap((selection) => selection.sourceIds)),
    toolNames: uniqueSorted<ToolName>(selections.flatMap((selection) => selection.toolNames)),
  })
}

/** Freezes the authored sources and exact tool contracts needed for one durable mission run. */
export function deriveMissionContextSelection(riskInput: ContextRisk): MandatoryContextSelection {
  const risk = KnowledgeRiskSchema.parse(riskInput)
  const selections = MissionPhaseSchema.options.map((phase) =>
    deriveMandatoryContextSelection(phase, risk),
  )
  return MandatoryContextSelectionSchema.parse({
    sourceIds: uniqueSorted(selections.flatMap((selection) => selection.sourceIds)),
    toolNames: uniqueSorted<ToolName>(selections.flatMap((selection) => selection.toolNames)),
  })
}

export function deriveContextBudget(riskInput: ContextRisk): ContextBudget {
  const risk = KnowledgeRiskSchema.parse(riskInput)
  return ContextBudgetSchema.parse(CONTEXT_BUDGETS[risk])
}
