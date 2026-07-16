import { createHash } from 'node:crypto'

import {
  Sha256Schema,
  type MissionId,
  type OrganizationId,
  type Principal,
  type Sha256,
} from '@trash-palace/core'

import { ConflictError } from './errors.js'

export class OpaqueMissionFenceToken {
  readonly #storageFingerprint: Sha256

  private constructor(value: string) {
    this.#storageFingerprint = Sha256Schema.parse(
      createHash('sha256').update(value, 'utf8').digest('hex'),
    )
    Object.freeze(this)
  }

  public static fromEntropy(value: string): OpaqueMissionFenceToken {
    if (value.length < 16 || value.length > 512) {
      throw new RangeError('Mission fence entropy must contain 16 to 512 characters')
    }
    return new OpaqueMissionFenceToken(value)
  }

  public static isAuthentic(value: unknown): value is OpaqueMissionFenceToken {
    return value instanceof OpaqueMissionFenceToken
  }

  public storageFingerprint(): Sha256 {
    return this.#storageFingerprint
  }

  public toJSON(): never {
    throw new TypeError('Mission fence tokens cannot be serialized')
  }

  public toString(): string {
    return '[REDACTED]'
  }

  public [Symbol.toPrimitive](): string {
    return '[REDACTED]'
  }
}

export interface MissionFence {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly ownerId: string
  readonly epoch: number
  readonly token: OpaqueMissionFenceToken
}

export interface MissionExecutionContext {
  readonly fence: MissionFence
  readonly signal: AbortSignal
  readonly principal: Principal
}

export function assertMissionExecutionContext(
  context: unknown,
  expected: {
    readonly organizationId: OrganizationId
    readonly missionId: MissionId
  },
): asserts context is MissionExecutionContext {
  if (context === null || typeof context !== 'object') {
    throw new ConflictError('Mission mutation requires an active execution context')
  }
  const candidate = context as Partial<MissionExecutionContext>
  if (
    candidate.fence === undefined ||
    candidate.signal === undefined ||
    candidate.principal === undefined ||
    !OpaqueMissionFenceToken.isAuthentic(candidate.fence.token) ||
    candidate.fence.organizationId !== expected.organizationId ||
    candidate.fence.missionId !== expected.missionId ||
    candidate.principal.organizationId !== expected.organizationId ||
    candidate.principal.role !== 'service'
  ) {
    throw new ConflictError('Mission execution context does not authorize this mutation')
  }
  candidate.signal.throwIfAborted()
}
