import {
  hashToolValue,
  PermissionSchema,
  TOOL_REGISTRY_HASH,
  TOOL_RESULT_SCHEMAS,
  TOOL_SCHEMA_PROJECTIONS,
  ToolNameSchema,
  ToolResultErrorSchema,
  ToolResultStatusSchema,
  ToolSchemaProjectionSchema,
} from '@trash-palace/core'
import { z } from 'zod'

import { ContextBudgetSchema } from './context-routing.js'
import {
  IsoDateTimeSchema,
  Sha256Schema,
  StableIdSchema,
  sha256,
  uniqueArray,
} from './primitives.js'

const TOOL_RESULT_ERROR_JSON_SCHEMA = z.json().parse(z.toJSONSchema(ToolResultErrorSchema))
const TOOL_RESULT_ERROR_SCHEMA_HASH = hashToolValue(TOOL_RESULT_ERROR_JSON_SCHEMA)

const ExactToolResultProjectionSchema = z
  .object({
    schemaVersion: z.literal('tool-result-contract@1'),
    name: ToolNameSchema,
    schema: z.json(),
    schemaHash: Sha256Schema,
  })
  .strict()

const ExactToolContractPayloadSchema = z
  .object({
    source: z.literal('compiler-generated'),
    instructionRole: z.literal('exact_contract'),
    contractId: z.literal('caretaker-tool-and-error-contracts'),
    contractVersion: z.literal('1.0.0'),
    toolRegistryHash: Sha256Schema,
    tools: z.array(ToolSchemaProjectionSchema).min(1),
    results: z.array(ExactToolResultProjectionSchema).min(1),
    resultContract: z
      .object({
        statuses: uniqueArray(ToolResultStatusSchema, 'Tool result statuses').min(1),
        errorSchema: z.json(),
        errorSchemaHash: Sha256Schema,
      })
      .strict(),
  })
  .strict()

export const ExactToolContractSectionSchema = ExactToolContractPayloadSchema.extend({
  contractHash: Sha256Schema,
})
  .strict()
  .superRefine((section, context) => {
    const { contractHash, ...payload } = section
    if (contractHash !== sha256(payload)) {
      context.addIssue({
        code: 'custom',
        message: 'Exact tool contract section hash does not match its payload',
        path: ['contractHash'],
      })
    }
    if (section.toolRegistryHash !== TOOL_REGISTRY_HASH) {
      context.addIssue({
        code: 'custom',
        message: 'Exact tool contract section must pin the current tool registry',
        path: ['toolRegistryHash'],
      })
    }
    if (
      section.resultContract.errorSchemaHash !== TOOL_RESULT_ERROR_SCHEMA_HASH ||
      hashToolValue(section.resultContract.errorSchema) !== TOOL_RESULT_ERROR_SCHEMA_HASH
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Exact tool contract section must pin the current result error schema',
        path: ['resultContract', 'errorSchemaHash'],
      })
    }

    const actualByName = new Map(TOOL_SCHEMA_PROJECTIONS.map((tool) => [tool.name, tool]))
    const seen = new Set<string>()
    section.tools.forEach((tool, index) => {
      const actual = actualByName.get(tool.name)
      if (
        seen.has(tool.name) ||
        actual?.contractHash !== tool.contractHash ||
        sha256(actual) !== sha256(tool)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Exact tool contracts must be unique projections from the current registry',
          path: ['tools', index],
        })
      }
      seen.add(tool.name)
    })
    const expectedResults = new Map(
      section.tools.map((tool) => {
        const schema = z.json().parse(z.toJSONSchema(TOOL_RESULT_SCHEMAS[tool.name]))
        return [tool.name, hashToolValue(schema)] as const
      }),
    )
    const resultNames = new Set<string>()
    section.results.forEach((result, index) => {
      if (
        resultNames.has(result.name) ||
        expectedResults.get(result.name) !== result.schemaHash ||
        hashToolValue(result.schema) !== result.schemaHash
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Exact result contracts must match the selected current tool contracts',
          path: ['results', index],
        })
      }
      resultNames.add(result.name)
    })
    if (resultNames.size !== expectedResults.size) {
      context.addIssue({
        code: 'custom',
        message: 'Every selected tool requires its exact result contract',
        path: ['results'],
      })
    }
    if (sha256(section.resultContract.statuses) !== sha256([...ToolResultStatusSchema.options])) {
      context.addIssue({
        code: 'custom',
        message: 'Exact tool contract section must contain every current result status',
        path: ['resultContract', 'statuses'],
      })
    }
  })

export const RuntimeStateKindSchema = z.enum([
  'palace',
  'crew',
  'capabilities',
  'routines',
  'executions',
  'mission',
  'plan',
  'operation',
  'verification_evidence',
])

export const RuntimeSnapshotCandidateSchema = z
  .object({
    snapshotId: StableIdSchema,
    stateKind: RuntimeStateKindSchema,
    requiredPermission: PermissionSchema,
    tenantScopeHash: Sha256Schema,
    observedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
    state: z.json(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.expiresAt !== undefined &&
      Date.parse(snapshot.expiresAt) < Date.parse(snapshot.observedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Runtime snapshot cannot expire before it was observed',
        path: ['expiresAt'],
      })
    }
  })

const RuntimeContextSnapshotPayloadSchema = z
  .object({
    source: z.literal('host-runtime'),
    authority: z.literal('runtime_state_only'),
    instructionRole: z.literal('untrusted_evidence'),
    snapshotId: StableIdSchema,
    stateKind: RuntimeStateKindSchema,
    requiredPermission: PermissionSchema,
    tenantScopeHash: Sha256Schema,
    observedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
    state: z.json(),
    stateHash: Sha256Schema,
  })
  .strict()

export const RuntimeContextSnapshotSchema = RuntimeContextSnapshotPayloadSchema.extend({
  snapshotHash: Sha256Schema,
})
  .strict()
  .superRefine((snapshot, context) => {
    const { snapshotHash, ...payload } = snapshot
    if (sha256(payload) !== snapshotHash || sha256(snapshot.state) !== snapshot.stateHash) {
      context.addIssue({
        code: 'custom',
        message: 'Runtime context snapshot hash does not match its payload',
        path: ['snapshotHash'],
      })
    }
  })

export const ContextBudgetUsageSchema = z
  .object({
    totalBytes: z.number().int().nonnegative(),
    authoredBytes: z.number().int().nonnegative(),
    runtimeBytes: z.number().int().nonnegative(),
    contractBytes: z.number().int().nonnegative(),
    optionalSources: z.number().int().nonnegative(),
    runtimeSnapshots: z.number().int().nonnegative(),
    toolContracts: z.number().int().positive(),
  })
  .strict()

export const BudgetedContextSchema = z
  .object({
    budget: ContextBudgetSchema,
    usage: ContextBudgetUsageSchema,
  })
  .strict()
  .superRefine(({ budget, usage }, context) => {
    for (const [usageField, budgetField] of [
      ['totalBytes', 'maxTotalBytes'],
      ['authoredBytes', 'maxAuthoredBytes'],
      ['runtimeBytes', 'maxRuntimeBytes'],
      ['contractBytes', 'maxContractBytes'],
      ['optionalSources', 'maxOptionalSources'],
      ['runtimeSnapshots', 'maxRuntimeSnapshots'],
      ['toolContracts', 'maxToolContracts'],
    ] as const) {
      if (usage[usageField] > budget[budgetField]) {
        context.addIssue({
          code: 'custom',
          message: `${usageField} exceeds the host-derived context budget`,
          path: ['usage', usageField],
        })
      }
    }
  })

export type ExactToolContractSection = z.infer<typeof ExactToolContractSectionSchema>
export type RuntimeSnapshotCandidate = z.infer<typeof RuntimeSnapshotCandidateSchema>
export type RuntimeContextSnapshot = z.infer<typeof RuntimeContextSnapshotSchema>
export type ContextBudgetUsage = z.infer<typeof ContextBudgetUsageSchema>

export function projectExactToolContracts(toolNames: readonly string[]): ExactToolContractSection {
  const parsedNames = toolNames.map(
    (toolName) => TOOL_SCHEMA_PROJECTIONS.find((tool) => tool.name === toolName)?.name,
  )
  if (parsedNames.some((toolName) => toolName === undefined)) {
    throw new Error('Exact tool contract projection contains an unknown tool')
  }
  const selected = new Set(parsedNames)
  if (selected.size !== toolNames.length) {
    throw new Error('Exact tool contract projection cannot contain duplicate tools')
  }
  const tools = TOOL_SCHEMA_PROJECTIONS.filter((tool) => selected.has(tool.name))
  const results = tools.map((tool) => {
    const schema = z.json().parse(z.toJSONSchema(TOOL_RESULT_SCHEMAS[tool.name]))
    return ExactToolResultProjectionSchema.parse({
      schemaVersion: 'tool-result-contract@1',
      name: tool.name,
      schema,
      schemaHash: hashToolValue(schema),
    })
  })

  const payload = ExactToolContractPayloadSchema.parse({
    source: 'compiler-generated',
    instructionRole: 'exact_contract',
    contractId: 'caretaker-tool-and-error-contracts',
    contractVersion: '1.0.0',
    toolRegistryHash: TOOL_REGISTRY_HASH,
    tools,
    results,
    resultContract: {
      statuses: [...ToolResultStatusSchema.options],
      errorSchema: TOOL_RESULT_ERROR_JSON_SCHEMA,
      errorSchemaHash: TOOL_RESULT_ERROR_SCHEMA_HASH,
    },
  })

  return ExactToolContractSectionSchema.parse({ ...payload, contractHash: sha256(payload) })
}

export function projectRuntimeSnapshot(input: unknown): RuntimeContextSnapshot {
  const candidate = RuntimeSnapshotCandidateSchema.parse(input)
  const payload = RuntimeContextSnapshotPayloadSchema.parse({
    source: 'host-runtime',
    authority: 'runtime_state_only',
    instructionRole: 'untrusted_evidence',
    snapshotId: candidate.snapshotId,
    stateKind: candidate.stateKind,
    requiredPermission: candidate.requiredPermission,
    tenantScopeHash: candidate.tenantScopeHash,
    observedAt: candidate.observedAt,
    ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
    state: candidate.state,
    stateHash: sha256(candidate.state),
  })
  return RuntimeContextSnapshotSchema.parse({ ...payload, snapshotHash: sha256(payload) })
}
