import {
  ClarificationAnswerIdSchema,
  ClarificationAnswerSchema,
  ClarificationRequestIdSchema,
  ClarificationRequestSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  Sha256Schema,
  type ClarificationAnswer,
  type ClarificationRequest,
  type ClarificationRequestId,
  type MissionId,
  type OrganizationId,
  type Sha256,
} from '@trash-palace/core'
import type { ClarificationRepository } from '@trash-palace/application'
import { and, desc, eq } from 'drizzle-orm'

import type { DatabaseExecutor } from './client.js'
import { hashCanonical } from './crypto.js'
import { DatabaseConflictError } from './errors.js'
import { clarificationAnswers, clarificationRequests, evidence } from './schema.js'

export function createPgClarificationRepository(input: {
  readonly executor: DatabaseExecutor
  readonly organizationId: OrganizationId
  readonly fencedMissionId: MissionId | null
}): ClarificationRepository {
  const organizationId = OrganizationIdSchema.parse(input.organizationId)
  const fencedMissionId =
    input.fencedMissionId === null ? null : MissionIdSchema.parse(input.fencedMissionId)

  const assertFencedMission = (missionId: MissionId): void => {
    if (fencedMissionId === null || missionId !== fencedMissionId) {
      throw new DatabaseConflictError('Clarification requests require the active mission fence')
    }
  }
  const assertHumanMutation = (): void => {
    if (fencedMissionId !== null) {
      throw new DatabaseConflictError('Clarification answers require an unfenced human mutation')
    }
  }

  const getRequest = async (
    inputRequestId: ClarificationRequestId,
  ): Promise<ClarificationRequest | null> => {
    const requestId = ClarificationRequestIdSchema.parse(inputRequestId)
    const [row] = await input.executor
      .select()
      .from(clarificationRequests)
      .where(
        and(
          eq(clarificationRequests.organizationId, organizationId),
          eq(clarificationRequests.id, requestId),
        ),
      )
      .limit(1)
    return row === undefined ? null : mapRequest(row)
  }

  const assertEvidenceBindings = async (
    missionId: MissionId,
    references: readonly string[],
  ): Promise<void> => {
    for (const reference of references) {
      const [row] = await input.executor
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.organizationId, organizationId),
            eq(evidence.missionId, missionId),
            eq(evidence.id, reference),
          ),
        )
        .limit(1)
      if (row === undefined) {
        throw new DatabaseConflictError('Clarification evidence is not bound to its mission')
      }
    }
  }

  return {
    getRequest,
    async findRequestByIdempotencyKey(inputIdempotencyKey: Sha256) {
      const idempotencyKey = Sha256Schema.parse(inputIdempotencyKey)
      const [row] = await input.executor
        .select()
        .from(clarificationRequests)
        .where(
          and(
            eq(clarificationRequests.organizationId, organizationId),
            eq(clarificationRequests.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
      return row === undefined ? null : mapRequest(row)
    },
    async findLatestForMission(inputMissionId: MissionId) {
      const missionId = MissionIdSchema.parse(inputMissionId)
      const [row] = await input.executor
        .select()
        .from(clarificationRequests)
        .where(
          and(
            eq(clarificationRequests.organizationId, organizationId),
            eq(clarificationRequests.missionId, missionId),
          ),
        )
        .orderBy(desc(clarificationRequests.requestedAt), desc(clarificationRequests.id))
        .limit(1)
      return row === undefined ? null : mapRequest(row)
    },
    async findPendingForMission(inputMissionId: MissionId) {
      const missionId = MissionIdSchema.parse(inputMissionId)
      const [row] = await input.executor
        .select()
        .from(clarificationRequests)
        .where(
          and(
            eq(clarificationRequests.organizationId, organizationId),
            eq(clarificationRequests.missionId, missionId),
            eq(clarificationRequests.status, 'pending'),
          ),
        )
        .limit(1)
      return row === undefined ? null : mapRequest(row)
    },
    async insertRequest(inputRequest: ClarificationRequest) {
      const request = ClarificationRequestSchema.parse(inputRequest)
      if (request.organizationId !== organizationId) {
        throw new DatabaseConflictError('Clarification request crossed a tenant boundary')
      }
      assertFencedMission(request.missionId)
      if (request.status !== 'pending' || request.resolvedAt !== null) {
        throw new DatabaseConflictError('New clarification requests must be pending')
      }
      await assertEvidenceBindings(request.missionId, request.evidenceRefs)
      await input.executor.insert(clarificationRequests).values({
        id: request.id,
        organizationId,
        missionId: request.missionId,
        idempotencyKey: request.idempotencyKey,
        payloadHash: request.payloadHash,
        question: request.question,
        choices: request.choices,
        evidenceRefs: request.evidenceRefs,
        requestedBy: request.requestedBy,
        status: request.status,
        requestedAt: new Date(request.requestedAt),
        resolvedAt: null,
      })
    },
    async getAnswerForRequest(inputRequestId: ClarificationRequestId) {
      const requestId = ClarificationRequestIdSchema.parse(inputRequestId)
      const [row] = await input.executor
        .select()
        .from(clarificationAnswers)
        .where(
          and(
            eq(clarificationAnswers.organizationId, organizationId),
            eq(clarificationAnswers.requestId, requestId),
          ),
        )
        .limit(1)
      return row === undefined ? null : mapAnswer(row)
    },
    async findAnswerByIdempotencyKey(inputIdempotencyKey: Sha256) {
      const idempotencyKey = Sha256Schema.parse(inputIdempotencyKey)
      const [row] = await input.executor
        .select()
        .from(clarificationAnswers)
        .where(
          and(
            eq(clarificationAnswers.organizationId, organizationId),
            eq(clarificationAnswers.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
      return row === undefined ? null : mapAnswer(row)
    },
    async insertAnswer({ answer: inputAnswer, resolvedRequest: inputResolvedRequest }) {
      assertHumanMutation()
      const answer = ClarificationAnswerSchema.parse(inputAnswer)
      const resolvedRequest = ClarificationRequestSchema.parse(inputResolvedRequest)
      if (
        answer.organizationId !== organizationId ||
        resolvedRequest.organizationId !== organizationId
      ) {
        throw new DatabaseConflictError('Clarification answer crossed a tenant boundary')
      }
      const [currentRow] = await input.executor
        .select()
        .from(clarificationRequests)
        .where(
          and(
            eq(clarificationRequests.organizationId, organizationId),
            eq(clarificationRequests.id, answer.requestId),
          ),
        )
        .for('update')
        .limit(1)
      if (currentRow === undefined) {
        throw new DatabaseConflictError('Clarification request does not exist')
      }
      const current = mapRequest(currentRow)
      const expectedResolved = ClarificationRequestSchema.parse({
        ...current,
        status: 'answered',
        resolvedAt: answer.answeredAt,
      })
      if (
        current.status !== 'pending' ||
        current.resolvedAt !== null ||
        answer.missionId !== current.missionId ||
        !current.choices.some((choice) => choice.id === answer.choiceId) ||
        hashCanonical(expectedResolved) !== hashCanonical(resolvedRequest)
      ) {
        throw new DatabaseConflictError('Clarification answer is not bound to its pending request')
      }
      await assertEvidenceBindings(answer.missionId, answer.evidenceRefs)
      await input.executor.insert(clarificationAnswers).values({
        id: ClarificationAnswerIdSchema.parse(answer.id),
        organizationId,
        missionId: answer.missionId,
        requestId: answer.requestId,
        idempotencyKey: answer.idempotencyKey,
        payloadHash: answer.payloadHash,
        choiceId: answer.choiceId,
        answeredBy: answer.answeredBy,
        evidenceRefs: answer.evidenceRefs,
        answeredAt: new Date(answer.answeredAt),
      })
      const [updated] = await input.executor
        .select({
          status: clarificationRequests.status,
          resolvedAt: clarificationRequests.resolvedAt,
        })
        .from(clarificationRequests)
        .where(
          and(
            eq(clarificationRequests.organizationId, organizationId),
            eq(clarificationRequests.id, current.id),
          ),
        )
        .limit(1)
      if (
        updated?.status !== 'answered' ||
        updated.resolvedAt?.toISOString() !== answer.answeredAt
      ) {
        throw new DatabaseConflictError('Clarification request resolution did not commit')
      }
    },
  }
}

function mapRequest(row: typeof clarificationRequests.$inferSelect): ClarificationRequest {
  return ClarificationRequestSchema.parse({
    schemaVersion: 'clarification-request@1',
    id: row.id,
    organizationId: row.organizationId,
    missionId: row.missionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    requestedBy: row.requestedBy,
    question: row.question,
    choices: row.choices,
    evidenceRefs: row.evidenceRefs,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  })
}

function mapAnswer(row: typeof clarificationAnswers.$inferSelect): ClarificationAnswer {
  return ClarificationAnswerSchema.parse({
    schemaVersion: 'clarification-answer@1',
    id: row.id,
    organizationId: row.organizationId,
    missionId: row.missionId,
    requestId: row.requestId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    choiceId: row.choiceId,
    answeredBy: row.answeredBy,
    evidenceRefs: row.evidenceRefs,
    answeredAt: row.answeredAt.toISOString(),
  })
}
