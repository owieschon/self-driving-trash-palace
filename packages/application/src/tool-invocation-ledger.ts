import { createHash } from 'node:crypto'

import type {
  AttemptId,
  EvidenceId,
  MissionId,
  OrganizationId,
  ReceiptId,
  Sha256,
  ToolCallChannel,
  ToolCallId,
  ToolName,
} from '@trash-palace/core'
import { Sha256Schema } from '@trash-palace/core'
import { z } from 'zod'

export const ToolInvocationExecutionClassSchema = z.enum([
  'read',
  'write_idempotent',
  'non_idempotent',
  'consequential',
])

export type ToolInvocationExecutionClass = z.infer<typeof ToolInvocationExecutionClassSchema>

export class ToolInvocationIdentityConflictError extends Error {
  override readonly name = 'ToolInvocationIdentityConflictError'
}

export class OpaqueToolInvocationClaimToken {
  readonly #storageFingerprint: Sha256

  private constructor(value: string) {
    this.#storageFingerprint = Sha256Schema.parse(
      createHash('sha256').update(value, 'utf8').digest('hex'),
    )
    Object.freeze(this)
  }

  public static fromEntropy(value: string): OpaqueToolInvocationClaimToken {
    if (value.length < 16 || value.length > 512) {
      throw new RangeError('Tool invocation claim entropy must contain 16 to 512 characters')
    }
    return new OpaqueToolInvocationClaimToken(value)
  }

  public storageFingerprint(): Sha256 {
    return this.#storageFingerprint
  }

  public toJSON(): never {
    throw new TypeError('Tool invocation claim tokens cannot be serialized')
  }

  public toString(): string {
    return '[REDACTED]'
  }

  public [Symbol.toPrimitive](): string {
    return '[REDACTED]'
  }
}

export interface ToolInvocationBinding {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly principalScopeHash: Sha256
  readonly callId: ToolCallId
  readonly toolName: ToolName
  readonly channel: ToolCallChannel
  readonly inputHash: Sha256
  readonly toolContractHash: Sha256
  readonly toolRegistryHash: Sha256
  readonly resultSchemaHash: Sha256
  readonly executionClass: ToolInvocationExecutionClass
}

export interface ToolInvocationClaimInput extends ToolInvocationBinding {
  readonly proposedReceiptId: ReceiptId
  readonly ownerToken: OpaqueToolInvocationClaimToken
  readonly startedAt: string
  readonly claimExpiresAt: string
}

export interface ToolInvocationClaimedRecord extends ToolInvocationBinding {
  readonly receiptId: ReceiptId
  readonly generation: number
  readonly startedAt: string
  readonly claimExpiresAt: string
}

export interface ToolInvocationCompletedRecord extends ToolInvocationBinding {
  readonly receiptId: ReceiptId
  readonly generation: number
  readonly startedAt: string
  readonly completedAt: string
  readonly resultHash: Sha256
  readonly result: unknown
  readonly attemptId: AttemptId | null
  readonly evidenceIds: readonly EvidenceId[]
}

export type ToolInvocationClaimResult =
  | Readonly<{
      kind: 'claimed'
      disposition: 'execute'
      invocation: ToolInvocationClaimedRecord
    }>
  | Readonly<{
      kind: 'claimed'
      disposition: 'resolve_unknown'
      invocation: ToolInvocationClaimedRecord
      abandonedClaim: Readonly<{
        generation: number
        claimExpiresAt: string
      }>
    }>
  | Readonly<{
      kind: 'in_progress'
      invocation: ToolInvocationClaimedRecord
    }>
  | Readonly<{
      kind: 'completed'
      invocation: ToolInvocationCompletedRecord
    }>

export interface ToolInvocationCompletionInput {
  readonly organizationId: OrganizationId
  readonly callId: ToolCallId
  readonly generation: number
  readonly ownerToken: OpaqueToolInvocationClaimToken
  readonly result: unknown
  readonly resultHash: Sha256
  readonly attemptId: AttemptId | null
  readonly evidenceIds: readonly EvidenceId[]
  readonly completedAt: string
}

export type ToolInvocationCompletionResult =
  | Readonly<{ kind: 'completed'; invocation: ToolInvocationCompletedRecord }>
  | Readonly<{ kind: 'lost_claim'; current: 'completed' | 'in_progress' }>

export interface ToolInvocationLedgerPort {
  claim(input: ToolInvocationClaimInput): Promise<ToolInvocationClaimResult>
  complete(input: ToolInvocationCompletionInput): Promise<ToolInvocationCompletionResult>
}
