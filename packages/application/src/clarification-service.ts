import {
  ClarificationAnswerPayloadSchema,
  ClarificationAnswerSchema,
  ClarificationChoiceSchema,
  ClarificationRequestPayloadSchema,
  ClarificationRequestSchema,
  EvidenceIdSchema,
  Sha256Schema,
  assertSameTenant,
  computeClarificationAnswerPayloadHash,
  computeClarificationRequestPayloadHash,
  isTerminalMissionState,
  type ClarificationAnswer,
  type ClarificationChoice,
  type ClarificationChoiceId,
  type ClarificationRequest,
  type ClarificationRequestId,
  type EvidenceId,
  type Mission,
  type MissionId,
  type Sha256,
} from '@trash-palace/core'

import { ConflictError, NotFoundError, OptimisticConcurrencyError } from './errors.js'
import { assertMissionExecutionContext, type MissionExecutionContext } from './mission-fence.js'
import { persistMissionTransition } from './mission-state.js'
import { enqueueMissionResume } from './mission-resume.js'
import type { AuthContext } from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { CryptoIdGenerator, SYSTEM_CLOCK, iso, parseGeneratedId } from './primitives.js'
import type {
  ClockPort,
  IdGeneratorPort,
  MissionExecutionUnitOfWorkPort,
  SensitiveMutationGuardPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export type ClarificationRequestResult = Readonly<{
  kind: 'created' | 'replayed'
  request: ClarificationRequest
  mission: Mission
}>

export type ClarificationAnswerResult = Readonly<{
  kind: 'answered' | 'replayed'
  request: ClarificationRequest
  answer: ClarificationAnswer
  mission: Mission
}>

export class ClarificationService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly missionUnitOfWork: MissionExecutionUnitOfWorkPort,
    private readonly mutationGuard: SensitiveMutationGuardPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
  ) {}

  public async request(input: {
    readonly context: MissionExecutionContext
    readonly missionId: MissionId
    readonly expectedMissionVersion: number
    readonly idempotencyKey: Sha256
    readonly question: string
    readonly choices: readonly ClarificationChoice[]
    readonly evidenceRefs: readonly EvidenceId[]
  }): Promise<ClarificationRequestResult> {
    const organizationId = input.context.principal.organizationId
    assertMissionExecutionContext(input.context, {
      organizationId,
      missionId: input.missionId,
    })
    const idempotencyKey = Sha256Schema.parse(input.idempotencyKey)
    const payload = ClarificationRequestPayloadSchema.parse({
      schemaVersion: 'clarification-request-payload@1',
      organizationId,
      missionId: input.missionId,
      requestedBy: input.context.principal.actorId,
      question: input.question,
      choices: input.choices.map((choice) => ClarificationChoiceSchema.parse(choice)),
      evidenceRefs: input.evidenceRefs.map((reference) => EvidenceIdSchema.parse(reference)),
    })
    const payloadHash = computeClarificationRequestPayloadHash(payload)

    return this.observability.trace(
      {
        name: 'domain.clarification.request',
        kind: 'domain',
        correlation: { organizationId, missionId: input.missionId },
        attributes: { choice_count: payload.choices.length },
      },
      () =>
        this.missionUnitOfWork.runFenced(input.context.fence, async (repositories) => {
          const mission = await requireMission(repositories, input.missionId)
          assertSameTenant(organizationId, [mission.organizationId])
          if (isTerminalMissionState(mission.state)) {
            throw new ConflictError('Terminal mission cannot request a clarification')
          }

          const existing =
            await repositories.clarifications.findRequestByIdempotencyKey(idempotencyKey)
          if (existing !== null) {
            if (
              existing.organizationId !== organizationId ||
              existing.missionId !== mission.id ||
              existing.payloadHash !== payloadHash
            ) {
              throw new ConflictError(
                'Clarification request idempotency key was reused with another payload',
              )
            }
            return { kind: 'replayed', request: existing, mission }
          }

          if (mission.version !== input.expectedMissionVersion) {
            throw new OptimisticConcurrencyError('Mission')
          }
          if (mission.state.status !== 'running' || mission.state.phase !== 'plan') {
            throw new ConflictError(
              'Clarifications may be requested only from the running plan checkpoint',
            )
          }
          if ((await repositories.clarifications.findPendingForMission(mission.id)) !== null) {
            throw new ConflictError('Mission already has a pending clarification')
          }
          await assertEvidenceBindings(repositories, mission, payload.evidenceRefs)

          const request = ClarificationRequestSchema.parse({
            ...payload,
            schemaVersion: 'clarification-request@1',
            id: parseGeneratedId('clarification_request', this.ids.next('clarification_request')),
            idempotencyKey,
            payloadHash,
            status: 'pending',
            requestedAt: iso(this.clock.now()),
            resolvedAt: null,
          })
          await repositories.clarifications.insertRequest(request)
          const nextMission = await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: input.expectedMissionVersion,
            event: 'material_ambiguity',
            clock: this.clock,
            ids: this.ids,
          })
          return { kind: 'created', request, mission: nextMission }
        }),
    )
  }

  public async answer(input: {
    readonly context: AuthContext
    readonly requestId: ClarificationRequestId
    readonly expectedMissionVersion: number
    readonly idempotencyKey: Sha256
    readonly choiceId: ClarificationChoiceId
    readonly evidenceRefs: readonly EvidenceId[]
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): Promise<ClarificationAnswerResult> {
    this.mutationGuard.assert(input)
    if (!['owner', 'operator'].includes(input.context.principal.role)) {
      throw new ConflictError('Only an authenticated human owner or operator may answer')
    }
    const organizationId = input.context.principal.organizationId
    const idempotencyKey = Sha256Schema.parse(input.idempotencyKey)
    const evidenceRefs = input.evidenceRefs.map((reference) => EvidenceIdSchema.parse(reference))

    return this.observability.trace(
      {
        name: 'domain.clarification.answer',
        kind: 'domain',
        correlation: { organizationId },
        attributes: {},
      },
      () =>
        this.unitOfWork.run(organizationId, async (repositories) => {
          const request = await repositories.clarifications.getRequest(input.requestId)
          if (request === null) throw new NotFoundError('Clarification request')
          const mission = await requireMission(repositories, request.missionId)
          assertSameTenant(organizationId, [request.organizationId, mission.organizationId])
          if (isTerminalMissionState(mission.state)) {
            throw new ConflictError('Terminal mission cannot accept a clarification answer')
          }
          if (!request.choices.some((choice) => choice.id === input.choiceId)) {
            throw new ConflictError('Clarification answer must select an offered choice')
          }

          const payload = ClarificationAnswerPayloadSchema.parse({
            schemaVersion: 'clarification-answer-payload@1',
            organizationId,
            missionId: mission.id,
            requestId: request.id,
            choiceId: input.choiceId,
            answeredBy: input.context.principal.actorId,
            evidenceRefs,
          })
          const payloadHash = computeClarificationAnswerPayloadHash(payload)
          const existing = await repositories.clarifications.getAnswerForRequest(request.id)
          if (existing !== null) {
            if (
              existing.idempotencyKey !== idempotencyKey ||
              existing.payloadHash !== payloadHash
            ) {
              throw new ConflictError('Clarification request already has another answer')
            }
            return { kind: 'replayed', request, answer: existing, mission }
          }
          if (
            (await repositories.clarifications.findAnswerByIdempotencyKey(idempotencyKey)) !== null
          ) {
            throw new ConflictError(
              'Clarification answer idempotency key was reused for another request',
            )
          }
          if (mission.version !== input.expectedMissionVersion) {
            throw new OptimisticConcurrencyError('Mission')
          }
          if (
            request.status !== 'pending' ||
            request.resolvedAt !== null ||
            mission.state.status !== 'waiting_for_user' ||
            mission.state.phase !== 'plan'
          ) {
            throw new ConflictError('Clarification request is no longer answerable')
          }
          await assertEvidenceBindings(repositories, mission, evidenceRefs)

          const answeredAt = iso(this.clock.now())
          const answer = ClarificationAnswerSchema.parse({
            ...payload,
            schemaVersion: 'clarification-answer@1',
            id: parseGeneratedId('clarification_answer', this.ids.next('clarification_answer')),
            idempotencyKey,
            payloadHash,
            answeredAt,
          })
          const resolvedRequest = ClarificationRequestSchema.parse({
            ...request,
            status: 'answered',
            resolvedAt: answeredAt,
          })
          await repositories.clarifications.insertAnswer({ answer, resolvedRequest })
          const nextMission = await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: input.expectedMissionVersion,
            event: 'clarification_answered',
            clock: this.clock,
            ids: this.ids,
          })
          await enqueueMissionResume(repositories, nextMission, this.ids)
          return { kind: 'answered', request: resolvedRequest, answer, mission: nextMission }
        }),
    )
  }
}

async function requireMission(
  repositories: TenantRepositories,
  missionId: MissionId,
): Promise<Mission> {
  const mission = await repositories.missions.get(missionId)
  if (mission === null) throw new NotFoundError('Mission')
  return mission
}

async function assertEvidenceBindings(
  repositories: TenantRepositories,
  mission: Mission,
  evidenceRefs: readonly EvidenceId[],
): Promise<void> {
  for (const evidenceId of evidenceRefs) {
    const record = await repositories.evidence.get(evidenceId)
    if (
      record === null ||
      record.evidence.organizationId !== mission.organizationId ||
      record.evidence.missionId !== mission.id
    ) {
      throw new ConflictError('Clarification evidence is not bound to its mission')
    }
  }
}
