import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  ClarificationAnswerIdSchema,
  ClarificationRequestIdSchema,
  EvidenceIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  Sha256Schema,
  UserIdSchema,
} from './identifiers.js'

const CREDENTIAL_VALUE =
  /(?:\bbearer\s+[a-z0-9._~+/-]{8,}|\b(?:phc|phx|sk)_[a-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|authorization|cookie|credential|password|secret|token)\s*[=:]\s*\S+)/i
const HOME_PATH =
  /(?:^|[\s"'(])(?:\/(?:Users|home)\/[^/\s]+|[a-z]:\\Users\\[^\\\s]+|\\\\[^\\\s]+\\(?:Users|home)\\[^\\\s]+)/i
const PRIVATE_URL =
  /https?:\/\/(?:localhost|0\.0\.0\.0|127\.0\.0\.1|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:\/|\b)/i

function boundedPublicText(minimum: number, maximum: number, field: string) {
  return z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .superRefine((value, context) => {
      if (CREDENTIAL_VALUE.test(value)) {
        context.addIssue({
          code: 'custom',
          message: `${field} cannot contain credential-shaped data`,
        })
      }
      if (HOME_PATH.test(value)) {
        context.addIssue({ code: 'custom', message: `${field} cannot contain a private home path` })
      }
      if (PRIVATE_URL.test(value)) {
        context.addIssue({
          code: 'custom',
          message: `${field} cannot contain a private network URL`,
        })
      }
    })
}

export const ClarificationChoiceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{2,39}$/, 'Expected a bounded clarification choice identifier')
  .brand<'ClarificationChoiceId'>()

export const ClarificationChoiceSchema = z
  .object({
    id: ClarificationChoiceIdSchema,
    label: boundedPublicText(1, 80, 'Clarification choice label'),
    description: boundedPublicText(1, 240, 'Clarification choice description'),
  })
  .strict()

const ClarificationEvidenceRefsSchema = z
  .array(EvidenceIdSchema)
  .max(16)
  .superRefine((references, context) => {
    if (new Set(references).size !== references.length) {
      context.addIssue({
        code: 'custom',
        message: 'Clarification evidence references must be unique',
      })
    }
  })

const clarificationRequestFields = {
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  requestedBy: UserIdSchema,
  question: boundedPublicText(12, 280, 'Clarification question'),
  choices: z.array(ClarificationChoiceSchema).min(2).max(6),
  evidenceRefs: ClarificationEvidenceRefsSchema,
} as const

export const ClarificationRequestPayloadSchema = z
  .object({
    schemaVersion: z.literal('clarification-request-payload@1'),
    ...clarificationRequestFields,
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.choices.map((choice) => choice.id)).size !== request.choices.length) {
      context.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'Clarification choice identifiers must be unique',
      })
    }
  })

export const ClarificationRequestSchema = z
  .object({
    schemaVersion: z.literal('clarification-request@1'),
    ...clarificationRequestFields,
    id: ClarificationRequestIdSchema,
    idempotencyKey: Sha256Schema,
    payloadHash: Sha256Schema,
    status: z.enum(['pending', 'answered']),
    requestedAt: IsoDateTimeSchema,
    resolvedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.choices.map((choice) => choice.id)).size !== request.choices.length) {
      context.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'Clarification choice identifiers must be unique',
      })
    }
    if ((request.status === 'answered') !== (request.resolvedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedAt'],
        message: 'Answered clarifications require exactly one resolution timestamp',
      })
    }
    if (
      request.resolvedAt !== null &&
      Date.parse(request.resolvedAt) < Date.parse(request.requestedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedAt'],
        message: 'Clarification resolution cannot precede its request',
      })
    }
    if (
      request.payloadHash !==
      computeClarificationRequestPayloadHash({
        organizationId: request.organizationId,
        missionId: request.missionId,
        requestedBy: request.requestedBy,
        question: request.question,
        choices: request.choices,
        evidenceRefs: request.evidenceRefs,
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['payloadHash'],
        message: 'Clarification request hash must bind its canonical payload',
      })
    }
  })

const clarificationAnswerFields = {
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  requestId: ClarificationRequestIdSchema,
  choiceId: ClarificationChoiceIdSchema,
  answeredBy: UserIdSchema,
  evidenceRefs: ClarificationEvidenceRefsSchema,
} as const

export const ClarificationAnswerPayloadSchema = z
  .object({
    schemaVersion: z.literal('clarification-answer-payload@1'),
    ...clarificationAnswerFields,
  })
  .strict()

export const ClarificationAnswerSchema = z
  .object({
    schemaVersion: z.literal('clarification-answer@1'),
    ...clarificationAnswerFields,
    id: ClarificationAnswerIdSchema,
    idempotencyKey: Sha256Schema,
    payloadHash: Sha256Schema,
    answeredAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((answer, context) => {
    if (
      answer.payloadHash !==
      computeClarificationAnswerPayloadHash({
        organizationId: answer.organizationId,
        missionId: answer.missionId,
        requestId: answer.requestId,
        choiceId: answer.choiceId,
        answeredBy: answer.answeredBy,
        evidenceRefs: answer.evidenceRefs,
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['payloadHash'],
        message: 'Clarification answer hash must bind its canonical payload',
      })
    }
  })

export type ClarificationChoiceId = z.infer<typeof ClarificationChoiceIdSchema>
export type ClarificationChoice = z.infer<typeof ClarificationChoiceSchema>
export type ClarificationRequestPayload = z.infer<typeof ClarificationRequestPayloadSchema>
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>
export type ClarificationAnswerPayload = z.infer<typeof ClarificationAnswerPayloadSchema>
export type ClarificationAnswer = z.infer<typeof ClarificationAnswerSchema>

type ClarificationRequestHashInput = Readonly<{
  organizationId: unknown
  missionId: unknown
  requestedBy: unknown
  question: unknown
  choices: readonly unknown[]
  evidenceRefs: readonly unknown[]
}>

type ClarificationAnswerHashInput = Readonly<{
  organizationId: unknown
  missionId: unknown
  requestId: unknown
  choiceId: unknown
  answeredBy: unknown
  evidenceRefs: readonly unknown[]
}>

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  throw new TypeError(`Clarification canonical JSON rejects ${typeof value}`)
}

export function computeClarificationRequestPayloadHash(
  input: ClarificationRequestHashInput,
): z.infer<typeof Sha256Schema> {
  const payload = ClarificationRequestPayloadSchema.parse({
    schemaVersion: 'clarification-request-payload@1',
    organizationId: input.organizationId,
    missionId: input.missionId,
    requestedBy: input.requestedBy,
    question: input.question,
    choices: input.choices,
    evidenceRefs: input.evidenceRefs,
  })
  return Sha256Schema.parse(createHash('sha256').update(canonicalJson(payload)).digest('hex'))
}

export function computeClarificationAnswerPayloadHash(
  input: ClarificationAnswerHashInput,
): z.infer<typeof Sha256Schema> {
  const payload = ClarificationAnswerPayloadSchema.parse({
    schemaVersion: 'clarification-answer-payload@1',
    organizationId: input.organizationId,
    missionId: input.missionId,
    requestId: input.requestId,
    choiceId: input.choiceId,
    answeredBy: input.answeredBy,
    evidenceRefs: input.evidenceRefs,
  })
  return Sha256Schema.parse(createHash('sha256').update(canonicalJson(payload)).digest('hex'))
}
