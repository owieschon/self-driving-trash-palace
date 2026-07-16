import {
  getHostPolicyProjection,
  HostPolicyProjectionSchema,
  MissionPhaseSchema,
  PermissionSchema,
  ROLE_PERMISSION_MATRIX,
  TOOL_REGISTRY,
  ToolNameSchema,
} from '@trash-palace/core'
import { z } from 'zod'

import {
  SCHEMA_VERSION,
  SemverSchema,
  Sha256Schema,
  StableIdSchema,
  sha256,
  uniqueArray,
} from './primitives.js'

const HostToolPolicySchema = z
  .object({
    toolId: ToolNameSchema,
    permission: PermissionSchema,
    risk: z.enum(['read', 'proposal', 'pause', 'consequential', 'control']),
    allowedPhases: uniqueArray(MissionPhaseSchema, 'Allowed phases').min(1),
    readOnly: z.boolean(),
  })
  .strict()

const DeniedCapabilitySchema = z.enum([
  'arbitrary-code-execution',
  'filesystem',
  'shell',
  'unrestricted-web',
])

export const HostPolicyContractSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    contractId: z.literal('caretaker-host-policy'),
    contractVersion: SemverSchema,
    corePolicy: HostPolicyProjectionSchema,
    servicePermissions: uniqueArray(PermissionSchema, 'Service permissions').min(1),
    deniedCapabilities: uniqueArray(DeniedCapabilitySchema, 'Denied capabilities').length(4),
    tools: z.array(HostToolPolicySchema).superRefine((tools, context) => {
      const seen = new Set<string>()
      tools.forEach((tool, index) => {
        if (seen.has(tool.toolId)) {
          context.addIssue({
            code: 'custom',
            message: 'Tool IDs must be unique',
            path: [index, 'toolId'],
          })
        }
        seen.add(tool.toolId)
      })
    }),
  })
  .strict()

export const HostPolicySectionSchema = z
  .object({
    source: z.literal('compiler-generated'),
    instructionRole: z.literal('host_policy'),
    contractId: StableIdSchema,
    contractVersion: SemverSchema,
    contractHash: Sha256Schema,
    policy: z
      .object({
        corePolicy: HostPolicyProjectionSchema,
        servicePermissions: z.array(PermissionSchema),
        deniedCapabilities: z.array(DeniedCapabilitySchema),
        tools: z.array(HostToolPolicySchema),
      })
      .strict(),
  })
  .strict()
  .superRefine((section, context) => {
    const contract = HostPolicyContractSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      contractId: section.contractId,
      contractVersion: section.contractVersion,
      corePolicy: section.policy.corePolicy,
      servicePermissions: section.policy.servicePermissions,
      deniedCapabilities: section.policy.deniedCapabilities,
      tools: section.policy.tools,
    })

    if (!contract.success || sha256(contract.data) !== section.contractHash) {
      context.addIssue({
        code: 'custom',
        message: 'Host policy section must match its typed contract hash',
        path: ['contractHash'],
      })
    }
  })

export type HostPolicyContract = z.infer<typeof HostPolicyContractSchema>
export type HostPolicySection = z.infer<typeof HostPolicySectionSchema>

export function getCaretakerHostPolicyContract(): HostPolicyContract {
  const tools = Object.entries(TOOL_REGISTRY)
    .map(([toolId, tool]) => ({
      toolId: ToolNameSchema.parse(toolId),
      permission: tool.permission,
      risk: tool.risk,
      allowedPhases: [...tool.allowedPhases],
      readOnly: tool.readOnly,
    }))
    .sort((left, right) => left.toolId.localeCompare(right.toolId))

  return HostPolicyContractSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    contractId: 'caretaker-host-policy',
    contractVersion: '1.0.0',
    corePolicy: getHostPolicyProjection(),
    servicePermissions: [...ROLE_PERMISSION_MATRIX.service].sort(),
    deniedCapabilities: ['arbitrary-code-execution', 'filesystem', 'shell', 'unrestricted-web'],
    tools,
  })
}

export function hashHostPolicyContract(): string {
  return sha256(getCaretakerHostPolicyContract())
}

export function projectHostPolicy(expectedContractHash: string): HostPolicySection {
  const contract = getCaretakerHostPolicyContract()
  const expectedHash = Sha256Schema.parse(expectedContractHash)
  const actualHash = hashHostPolicyContract()

  if (actualHash !== expectedHash) {
    throw new Error(`Host policy hash mismatch for ${contract.contractId}`)
  }

  return HostPolicySectionSchema.parse({
    source: 'compiler-generated',
    instructionRole: 'host_policy',
    contractId: contract.contractId,
    contractVersion: contract.contractVersion,
    contractHash: actualHash,
    policy: {
      corePolicy: contract.corePolicy,
      servicePermissions: contract.servicePermissions,
      deniedCapabilities: contract.deniedCapabilities,
      tools: contract.tools,
    },
  })
}
