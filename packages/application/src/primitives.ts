import { createHash, randomBytes } from 'node:crypto'

import {
  ApprovalIdSchema,
  AttemptIdSchema,
  ClarificationAnswerIdSchema,
  ClarificationRequestIdSchema,
  EvidenceIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  MissionEventIdSchema,
  OperationIdSchema,
  PlanIdSchema,
  RunIdSchema,
  ReceiptIdSchema,
  Sha256Schema,
  VerificationIdSchema,
  type Sha256,
} from '@trash-palace/core'

import type { EntropyPort, IdGeneratorPort, IdKind } from './ports.js'

const PREFIXES: Readonly<Record<IdKind, string>> = {
  approval: 'apr',
  attempt: 'att',
  cancellation: 'cancel',
  clarification_answer: 'cla',
  clarification_request: 'clr',
  execution: 'exe',
  evidence: 'evd',
  evidence_authority_receipt: 'rcp',
  mission_event: 'mev',
  operation: 'op',
  outbox: 'out',
  plan: 'pln',
  run: 'run',
  session: 'session',
  verification: 'ver',
}

export class CryptoEntropy implements EntropyPort {
  public token(bytes: number): string {
    if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
      throw new RangeError('Entropy requests must contain 16 to 128 bytes')
    }
    return randomBytes(bytes).toString('base64url')
  }
}

export class CryptoIdGenerator implements IdGeneratorPort {
  public constructor(private readonly entropy: EntropyPort = new CryptoEntropy()) {}

  public next(kind: IdKind): string {
    const body = this.entropy
      .token(18)
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]/g, '_')
    return `${PREFIXES[kind]}_x${body}`
  }
}

export function sha256(value: string): Sha256 {
  return Sha256Schema.parse(createHash('sha256').update(value, 'utf8').digest('hex'))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

export function hashCanonical(value: unknown): Sha256 {
  return sha256(JSON.stringify(canonicalize(value)))
}

export function parseGeneratedId(
  kind: 'approval',
  value: string,
): ReturnType<typeof ApprovalIdSchema.parse>
export function parseGeneratedId(
  kind: 'attempt',
  value: string,
): ReturnType<typeof AttemptIdSchema.parse>
export function parseGeneratedId(
  kind: 'event',
  value: string,
): ReturnType<typeof EventIdSchema.parse>
export function parseGeneratedId(
  kind: 'execution',
  value: string,
): ReturnType<typeof ExecutionIdSchema.parse>
export function parseGeneratedId(
  kind: 'evidence',
  value: string,
): ReturnType<typeof EvidenceIdSchema.parse>
export function parseGeneratedId(
  kind: 'evidence_authority_receipt',
  value: string,
): ReturnType<typeof ReceiptIdSchema.parse>
export function parseGeneratedId(
  kind: 'clarification_request',
  value: string,
): ReturnType<typeof ClarificationRequestIdSchema.parse>
export function parseGeneratedId(
  kind: 'clarification_answer',
  value: string,
): ReturnType<typeof ClarificationAnswerIdSchema.parse>
export function parseGeneratedId(
  kind: 'mission_event',
  value: string,
): ReturnType<typeof MissionEventIdSchema.parse>
export function parseGeneratedId(
  kind: 'operation',
  value: string,
): ReturnType<typeof OperationIdSchema.parse>
export function parseGeneratedId(kind: 'plan', value: string): ReturnType<typeof PlanIdSchema.parse>
export function parseGeneratedId(kind: 'run', value: string): ReturnType<typeof RunIdSchema.parse>
export function parseGeneratedId(
  kind: 'verification',
  value: string,
): ReturnType<typeof VerificationIdSchema.parse>
export function parseGeneratedId(kind: string, value: string): string {
  const schemas = {
    approval: ApprovalIdSchema,
    attempt: AttemptIdSchema,
    clarification_answer: ClarificationAnswerIdSchema,
    clarification_request: ClarificationRequestIdSchema,
    event: EventIdSchema,
    execution: ExecutionIdSchema,
    evidence: EvidenceIdSchema,
    evidence_authority_receipt: ReceiptIdSchema,
    mission_event: MissionEventIdSchema,
    operation: OperationIdSchema,
    plan: PlanIdSchema,
    run: RunIdSchema,
    verification: VerificationIdSchema,
  } as const
  return schemas[kind as keyof typeof schemas].parse(value)
}

export const SYSTEM_CLOCK = {
  now(): Date {
    return new Date()
  },
} as const

export function iso(date: Date): string {
  return date.toISOString()
}

export function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds)
}
