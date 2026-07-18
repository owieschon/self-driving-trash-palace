import type {
  Approval,
  Attempt,
  Capability,
  ClarificationAnswer,
  ClarificationRequest,
  ContextReceipt,
  CrewMember,
  CrewPreference,
  CrewSchedule,
  Device,
  IdentityTag,
  Mission,
  MissionEvent,
  MissionId,
  Operation,
  OperationOutcome,
  OrganizationId,
  Palace,
  Plan,
  PlanAction,
  PersistedEvidenceRecord,
  ProtectedResourceVersion,
  Routine,
  RoutineVersion,
  Verification,
} from '@trash-palace/core'
import {
  AttemptSchema,
  ClarificationAnswerSchema,
  ClarificationRequestSchema,
  ContextReceiptSchema,
  ExecutionSchema,
  ExecutionsListInputSchema,
  GatewayCallbackSchema,
  GatewayDispatchResultSchema,
  PersistedEvidenceRecordSchema,
  RoutineSchema,
  RoutineVersionSchema,
  classifyExecutionReadiness,
  classifyGatewayCallbackStatusTransition,
  isRoutineReplacementAction,
  validateGatewayCommandCallbackBinding,
} from '@trash-palace/core'

import { ConflictError, LeaseLostError } from '../errors.js'
import {
  parseFrozenApplicationProductEvidenceEnvelope,
  type ProductEvidenceDelivery,
} from '../product-evidence.js'
import {
  EMPTY_CARETAKER_RUN_COUNTERS,
  assertCaretakerCounterTransition,
  assertCaretakerMissionStateForCheckpoint,
  assertCaretakerPendingToolCallTransition,
  assertCaretakerTaskLedgerTransition,
  assertCaretakerToolWaitPayloadTransition,
  caretakerRunStatusForCheckpoint,
  hashCaretakerCheckpointMutation,
  hashCaretakerTaskLedger,
  parseCaretakerTaskLedger,
} from '../caretaker-run-ledger.js'
import { OpaqueMissionFenceToken, type MissionFence } from '../mission-fence.js'
import type {
  CaretakerRunCheckpoint,
  CaretakerRunRecord,
  CaretakerRunSnapshot,
  CaretakerTerminalEvidenceDelivery,
  CancellationRecord,
  CompensatingPlanLink,
  GatewayEffectRecord,
  JsonValue,
  OutboxMessage,
  PlanSimulationRecord,
  PlanValidationRecord,
  ReconciliationPoll,
  StoredExecution,
  StoredGatewayCallback,
} from '../models.js'
import {
  CaretakerTerminalEvidenceDeliverySchema,
  CaretakerRunCheckpointSchema,
  CaretakerRunRecordSchema,
  GatewayEffectRecordSchema,
} from '../models.js'
import type { ApplicationSpan, DomainObservation, ObservabilityPort } from '../observability.js'
import { SYSTEM_CLOCK, addMilliseconds, hashCanonical, iso } from '../primitives.js'
import type {
  ClockPort,
  EntropyPort,
  IdGeneratorPort,
  IdKind,
  MissionExecutionUnitOfWorkPort,
  QueuePort,
  SystemOutboxPort,
  SystemCaretakerEvidenceDeliveryPort,
  TenantRepositories,
  UnitOfWorkPort,
} from '../ports.js'

interface InMemoryMissionLeaseRecord {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly ownerId: string
  readonly epoch: number
  readonly tokenFingerprint: string | null
  readonly acquiredAt: string
  readonly renewedAt: string
  readonly expiresAt: string
  readonly releasedAt: string | null
}

export type InMemoryMissionLeaseSnapshot = Omit<InMemoryMissionLeaseRecord, 'tokenFingerprint'>

interface InMemoryState {
  palaces: Map<string, Palace>
  crewMembers: Map<string, CrewMember>
  identityTags: Map<string, IdentityTag>
  crewSchedules: Map<string, CrewSchedule>
  crewPreferences: Map<string, CrewPreference>
  devices: Map<string, Device>
  capabilities: Map<string, Capability>
  missions: Map<string, Mission>
  missionEvents: MissionEvent[]
  clarificationRequests: Map<string, ClarificationRequest>
  clarificationAnswers: Map<string, ClarificationAnswer>
  plans: Map<string, Plan>
  approvals: Map<string, Approval>
  operations: Map<string, Operation>
  attempts: Map<string, Attempt>
  routineVersions: Map<string, ProtectedResourceVersion>
  routineRecords: Map<string, Routine>
  routineVersionRecords: Map<string, RoutineVersion>
  outbox: Map<string, OutboxMessage>
  gatewayEffects: Map<string, GatewayEffectRecord>
  gatewayCallbacks: Map<string, StoredGatewayCallback>
  executions: Map<string, StoredExecution>
  contextReceipts: Map<string, ContextReceipt>
  evidence: Map<string, PersistedEvidenceRecord>
  verifications: Map<string, Verification>
  leases: Map<string, InMemoryMissionLeaseRecord>
  cancellations: Map<string, CancellationRecord>
  compensatingPlans: Map<string, CompensatingPlanLink>
  validations: Map<string, PlanValidationRecord>
  simulations: PlanSimulationRecord[]
  reconciliations: ReconciliationPoll[]
  caretakerRuns: Map<string, CaretakerRunRecord>
  caretakerRunCheckpoints: Map<string, CaretakerRunCheckpoint[]>
  caretakerTerminalEvidenceDeliveries: Map<string, CaretakerTerminalEvidenceDelivery>
  productEvidenceDeliveries: Map<string, ProductEvidenceDelivery>
  taskLedgerVersions: Map<string, number>
}

export interface InMemorySeed {
  readonly palaces?: readonly Palace[]
  readonly crewMembers?: readonly CrewMember[]
  readonly identityTags?: readonly IdentityTag[]
  readonly crewSchedules?: readonly CrewSchedule[]
  readonly crewPreferences?: readonly CrewPreference[]
  readonly devices?: readonly Device[]
  readonly capabilities?: readonly Capability[]
  readonly missions?: readonly Mission[]
  readonly clarificationRequests?: readonly ClarificationRequest[]
  readonly clarificationAnswers?: readonly ClarificationAnswer[]
  readonly plans?: readonly Plan[]
  readonly approvals?: readonly Approval[]
  readonly operations?: readonly Operation[]
  readonly attempts?: readonly Attempt[]
  readonly routineVersions?: readonly ProtectedResourceVersion[]
  readonly routines?: readonly Routine[]
  readonly routineVersionRecords?: readonly RoutineVersion[]
  readonly outbox?: readonly OutboxMessage[]
  readonly gatewayEffects?: readonly GatewayEffectRecord[]
  readonly gatewayCallbacks?: readonly StoredGatewayCallback[]
  readonly executions?: readonly StoredExecution[]
  readonly contextReceipts?: readonly ContextReceipt[]
  readonly evidence?: readonly PersistedEvidenceRecord[]
  readonly verifications?: readonly Verification[]
}

export interface InMemorySnapshot {
  readonly palaces: readonly Palace[]
  readonly crewMembers: readonly CrewMember[]
  readonly identityTags: readonly IdentityTag[]
  readonly crewSchedules: readonly CrewSchedule[]
  readonly crewPreferences: readonly CrewPreference[]
  readonly devices: readonly Device[]
  readonly capabilities: readonly Capability[]
  readonly missions: readonly Mission[]
  readonly missionEvents: readonly MissionEvent[]
  readonly clarificationRequests: readonly ClarificationRequest[]
  readonly clarificationAnswers: readonly ClarificationAnswer[]
  readonly plans: readonly Plan[]
  readonly approvals: readonly Approval[]
  readonly operations: readonly Operation[]
  readonly attempts: readonly Attempt[]
  readonly routineVersions: readonly ProtectedResourceVersion[]
  readonly routines: readonly Routine[]
  readonly routineVersionRecords: readonly RoutineVersion[]
  readonly outbox: readonly OutboxMessage[]
  readonly gatewayEffects: readonly GatewayEffectRecord[]
  readonly gatewayCallbacks: readonly StoredGatewayCallback[]
  readonly executions: readonly StoredExecution[]
  readonly contextReceipts: readonly ContextReceipt[]
  readonly evidence: readonly PersistedEvidenceRecord[]
  readonly verifications: readonly Verification[]
  readonly leases: readonly InMemoryMissionLeaseSnapshot[]
  readonly cancellations: readonly CancellationRecord[]
  readonly compensatingPlans: readonly CompensatingPlanLink[]
  readonly validations: readonly PlanValidationRecord[]
  readonly simulations: readonly PlanSimulationRecord[]
  readonly reconciliations: readonly ReconciliationPoll[]
  readonly caretakerRuns: readonly CaretakerRunRecord[]
  readonly caretakerRunCheckpoints: readonly CaretakerRunCheckpoint[]
  readonly caretakerTerminalEvidenceDeliveries: readonly CaretakerTerminalEvidenceDelivery[]
  readonly productEvidenceDeliveries: readonly ProductEvidenceDelivery[]
}

export class InMemoryApplicationStore
  implements
    UnitOfWorkPort,
    MissionExecutionUnitOfWorkPort,
    SystemOutboxPort,
    SystemCaretakerEvidenceDeliveryPort
{
  #state: InMemoryState
  #tail: Promise<void> = Promise.resolve()

  public constructor(
    seed: InMemorySeed = {},
    private readonly clock: ClockPort = SYSTEM_CLOCK,
  ) {
    this.#state = {
      palaces: keyed(seed.palaces),
      crewMembers: keyed(seed.crewMembers),
      identityTags: keyed(seed.identityTags),
      crewSchedules: keyed(seed.crewSchedules),
      crewPreferences: keyed(seed.crewPreferences),
      devices: keyed(seed.devices),
      capabilities: keyed(seed.capabilities),
      missions: keyed(seed.missions),
      missionEvents: [],
      clarificationRequests: keyed(seed.clarificationRequests),
      clarificationAnswers: keyed(seed.clarificationAnswers),
      plans: keyed(seed.plans),
      approvals: keyed(seed.approvals),
      operations: keyed(seed.operations),
      attempts: keyed(seed.attempts),
      routineVersions: new Map(
        (seed.routineVersions ?? []).map((item) => [item.routineId, clone(item)]),
      ),
      routineRecords: keyed(seed.routines),
      routineVersionRecords: keyed(seed.routineVersionRecords),
      outbox: keyed(seed.outbox),
      gatewayEffects: new Map(
        (seed.gatewayEffects ?? []).map((item) => [item.command.id, clone(item)]),
      ),
      gatewayCallbacks: keyed(seed.gatewayCallbacks),
      executions: new Map((seed.executions ?? []).map((item) => [item.operationId, clone(item)])),
      contextReceipts: keyed(seed.contextReceipts),
      evidence: new Map((seed.evidence ?? []).map((item) => [item.evidence.id, clone(item)])),
      verifications: new Map(
        (seed.verifications ?? []).map((item) => [item.missionId, clone(item)]),
      ),
      leases: new Map(),
      cancellations: new Map(),
      compensatingPlans: new Map(),
      validations: new Map(),
      simulations: [],
      reconciliations: [],
      caretakerRuns: new Map(),
      caretakerRunCheckpoints: new Map(),
      caretakerTerminalEvidenceDeliveries: new Map(),
      productEvidenceDeliveries: new Map(),
      taskLedgerVersions: new Map((seed.missions ?? []).map((mission) => [mission.id, 0])),
    }
  }

  public run<Result>(
    organizationId: OrganizationId,
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result> {
    return this.#serialize(async () => {
      const candidate = cloneState(this.#state)
      const result = await work(createTenantRepositories(candidate, organizationId, this.clock))
      this.#state = candidate
      return result
    })
  }

  public runFenced<Result>(
    fence: MissionFence,
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result> {
    return this.#serialize(async () => {
      assertFenceIsLive(this.#state, fence, this.clock.now())
      const candidate = cloneState(this.#state)
      const result = await work(
        createTenantRepositories(candidate, fence.organizationId, this.clock, fence),
      )
      assertMissionScopedChanges(this.#state, candidate, fence.missionId)
      this.#state = candidate
      return result
    })
  }

  public claimDue(input: {
    ownerId: string
    now: string
    claimExpiresAt: string
    limit: number
  }): Promise<readonly OutboxMessage[]> {
    return this.#serialize(async () => {
      const candidates = [...this.#state.outbox.values()]
        .filter(
          (message) =>
            (message.status === 'pending' &&
              Date.parse(message.availableAt) <= Date.parse(input.now)) ||
            (message.status === 'claimed' &&
              message.claimExpiresAt !== null &&
              Date.parse(message.claimExpiresAt) <= Date.parse(input.now)),
        )
        .sort((left, right) => left.availableAt.localeCompare(right.availableAt))
        .slice(0, input.limit)
      return candidates.map((message) => {
        const claimed: OutboxMessage = {
          ...message,
          status: 'claimed',
          claimedBy: input.ownerId,
          claimExpiresAt: input.claimExpiresAt,
          deliveryAttempts: message.deliveryAttempts + 1,
        }
        this.#state.outbox.set(message.id, clone(claimed))
        return clone(claimed)
      })
    })
  }

  public get(runId: string): Promise<CaretakerTerminalEvidenceDelivery | null> {
    return this.#serialize(async () =>
      clone(this.#state.caretakerTerminalEvidenceDeliveries.get(runId) ?? null),
    )
  }

  public listPending(limit: number): Promise<readonly CaretakerTerminalEvidenceDelivery[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('Caretaker evidence delivery limit must be between 1 and 500')
    }
    return this.#serialize(async () =>
      clone(
        [...this.#state.caretakerTerminalEvidenceDeliveries.values()]
          .filter((delivery) => delivery.status === 'pending')
          .sort((left, right) =>
            left.createdAt === right.createdAt
              ? left.runId.localeCompare(right.runId)
              : left.createdAt.localeCompare(right.createdAt),
          )
          .slice(0, limit),
      ),
    )
  }

  public acknowledge(input: {
    readonly runId: string
    readonly eventHash: string
    readonly captureStatus: 'stored' | 'duplicate'
    readonly deliveredAt: string
  }): Promise<'acknowledged' | 'already_acknowledged'> {
    return this.#serialize(async () => {
      const current = this.#state.caretakerTerminalEvidenceDeliveries.get(input.runId)
      if (current === undefined) throw new ConflictError('Caretaker evidence delivery is absent')
      if (current.envelope.eventHash !== input.eventHash) {
        throw new ConflictError('Caretaker evidence acknowledgement changed its event hash')
      }
      if (current.status === 'delivered') return 'already_acknowledged'
      const delivered = CaretakerTerminalEvidenceDeliverySchema.parse({
        ...current,
        status: 'delivered',
        deliveredAt: input.deliveredAt,
        captureStatus: input.captureStatus,
      })
      this.#state.caretakerTerminalEvidenceDeliveries.set(input.runId, delivered)
      return 'acknowledged'
    })
  }

  public snapshot(): Promise<InMemorySnapshot> {
    return this.#serialize(async () => snapshot(this.#state))
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function createTenantRepositories(
  state: InMemoryState,
  organizationId: OrganizationId,
  clock: ClockPort,
  fence: MissionFence | null = null,
): TenantRepositories {
  const owns = (record: { readonly organizationId: OrganizationId }): boolean =>
    record.organizationId === organizationId
  const assertOwns = (record: { readonly organizationId: OrganizationId }): void => {
    if (!owns(record)) throw new ConflictError('Tenant repository rejected a cross-tenant record')
  }
  return {
    palaces: {
      async get(palaceId) {
        return owned(state.palaces.get(palaceId), owns)
      },
    },
    crews: {
      async list(palaceId, activeOnly) {
        if (typeof activeOnly !== 'boolean') throw new TypeError('activeOnly must be a boolean')
        if (owned(state.palaces.get(palaceId), owns) === null) {
          return { crew: [], identityTags: [], schedules: [], preferences: [] }
        }
        const crew = [...state.crewMembers.values()]
          .filter(
            (member) =>
              owns(member) && member.palaceId === palaceId && (!activeOnly || member.active),
          )
          .sort(
            (left, right) =>
              left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
          )
        const crewIds = new Set(crew.map((member) => member.id))
        const identityTags = [...state.identityTags.values()]
          .filter(
            (tag) =>
              owns(tag) &&
              tag.crewMemberId !== null &&
              crewIds.has(tag.crewMemberId) &&
              (!activeOnly || tag.active),
          )
          .sort((left, right) => left.id.localeCompare(right.id))
        const schedules = [...state.crewSchedules.values()]
          .filter(
            (schedule) =>
              owns(schedule) &&
              schedule.palaceId === palaceId &&
              crewIds.has(schedule.crewMemberId) &&
              (!activeOnly || schedule.active),
          )
          .sort(
            (left, right) =>
              left.crewMemberId.localeCompare(right.crewMemberId) ||
              left.id.localeCompare(right.id),
          )
        const preferences = [...state.crewPreferences.values()]
          .filter(
            (preference) =>
              owns(preference) &&
              preference.palaceId === palaceId &&
              crewIds.has(preference.crewMemberId) &&
              (!activeOnly || preference.active),
          )
          .sort(
            (left, right) =>
              left.crewMemberId.localeCompare(right.crewMemberId) ||
              left.id.localeCompare(right.id),
          )
        return clone({ crew, identityTags, schedules, preferences })
      },
    },
    capabilities: {
      async list(palaceId) {
        if (owned(state.palaces.get(palaceId), owns) === null) {
          return { devices: [], capabilities: [] }
        }
        const devices = [...state.devices.values()]
          .filter((device) => owns(device) && device.palaceId === palaceId)
          .sort((left, right) => left.id.localeCompare(right.id))
        const deviceIds = new Set(devices.map((device) => device.id))
        const projectedCapabilities = [...state.capabilities.values()]
          .filter((capability) => owns(capability) && deviceIds.has(capability.deviceId))
          .sort(
            (left, right) =>
              left.deviceId.localeCompare(right.deviceId) || left.id.localeCompare(right.id),
          )
        return clone({ devices, capabilities: projectedCapabilities })
      },
    },
    knowledge: {
      async search() {
        return []
      },
    },
    missions: {
      async get(id) {
        return owned(state.missions.get(id), owns)
      },
      async listForPalace(palaceId, limit) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
          throw new TypeError('Mission list limit must be a positive safe integer')
        }
        return clone(
          [...state.missions.values()]
            .filter((mission) => owns(mission) && mission.palaceId === palaceId)
            .sort(
              (left, right) =>
                right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
            )
            .slice(0, limit),
        )
      },
      async insert(mission) {
        assertOwns(mission)
        insertUnique(state.missions, mission.id, mission)
      },
      async save(mission, expectedVersion) {
        assertOwns(mission)
        const current = state.missions.get(mission.id)
        if (current === undefined || !owns(current) || current.version !== expectedVersion)
          return false
        if (JSON.stringify(current.taskLedger) !== JSON.stringify(mission.taskLedger)) {
          throw new ConflictError(
            'Caretaker task-ledger changes require a versioned run checkpoint',
          )
        }
        if (current.runId !== mission.runId) {
          throw new ConflictError(
            'Mission Caretaker run identity changes require a fenced activation',
          )
        }
        state.missions.set(mission.id, clone(mission))
        return true
      },
      async appendEvent(event) {
        assertOwns(event)
        if (state.missionEvents.some((candidate) => candidate.id === event.id)) {
          throw new ConflictError('Mission event already exists')
        }
        state.missionEvents.push(clone(event))
      },
    },
    clarifications: {
      async getRequest(requestId) {
        return owned(state.clarificationRequests.get(requestId), owns)
      },
      async findRequestByIdempotencyKey(idempotencyKey) {
        return clone(
          [...state.clarificationRequests.values()].find(
            (request) => owns(request) && request.idempotencyKey === idempotencyKey,
          ) ?? null,
        )
      },
      async findLatestForMission(missionId) {
        return clone(
          [...state.clarificationRequests.values()]
            .filter((request) => owns(request) && request.missionId === missionId)
            .sort((left, right) =>
              left.requestedAt === right.requestedAt
                ? right.id.localeCompare(left.id)
                : right.requestedAt.localeCompare(left.requestedAt),
            )[0] ?? null,
        )
      },
      async findPendingForMission(missionId) {
        return clone(
          [...state.clarificationRequests.values()].find(
            (request) =>
              owns(request) && request.missionId === missionId && request.status === 'pending',
          ) ?? null,
        )
      },
      async insertRequest(input) {
        const request = ClarificationRequestSchema.parse(input)
        assertOwns(request)
        const mission = state.missions.get(request.missionId)
        if (mission === undefined || !owns(mission)) {
          throw new ConflictError('Clarification request mission does not exist')
        }
        if (request.status !== 'pending' || request.resolvedAt !== null) {
          throw new ConflictError('New clarification requests must be pending')
        }
        if (
          [...state.clarificationRequests.values()].some(
            (candidate) => owns(candidate) && candidate.idempotencyKey === request.idempotencyKey,
          )
        ) {
          throw new ConflictError('Clarification request idempotency key already exists')
        }
        if (
          [...state.clarificationRequests.values()].some(
            (candidate) =>
              owns(candidate) &&
              candidate.missionId === request.missionId &&
              candidate.status === 'pending',
          )
        ) {
          throw new ConflictError('Mission already has a pending clarification')
        }
        assertClarificationEvidence(
          state,
          request.organizationId,
          request.missionId,
          request.evidenceRefs,
        )
        insertUnique(state.clarificationRequests, request.id, request)
      },
      async getAnswerForRequest(requestId) {
        return clone(
          [...state.clarificationAnswers.values()].find(
            (answer) => owns(answer) && answer.requestId === requestId,
          ) ?? null,
        )
      },
      async findAnswerByIdempotencyKey(idempotencyKey) {
        return clone(
          [...state.clarificationAnswers.values()].find(
            (answer) => owns(answer) && answer.idempotencyKey === idempotencyKey,
          ) ?? null,
        )
      },
      async insertAnswer(input) {
        const answer = ClarificationAnswerSchema.parse(input.answer)
        const resolvedRequest = ClarificationRequestSchema.parse(input.resolvedRequest)
        assertOwns(answer)
        assertOwns(resolvedRequest)
        const current = state.clarificationRequests.get(answer.requestId)
        if (current === undefined || !owns(current)) {
          throw new ConflictError('Clarification request does not exist')
        }
        if (current.status !== 'pending' || current.resolvedAt !== null) {
          throw new ConflictError('Clarification request is no longer pending')
        }
        if (
          answer.organizationId !== current.organizationId ||
          answer.missionId !== current.missionId ||
          !current.choices.some((choice) => choice.id === answer.choiceId)
        ) {
          throw new ConflictError('Clarification answer is not bound to an offered choice')
        }
        const expectedResolved = ClarificationRequestSchema.parse({
          ...current,
          status: 'answered',
          resolvedAt: answer.answeredAt,
        })
        if (hashCanonical(expectedResolved) !== hashCanonical(resolvedRequest)) {
          throw new ConflictError('Clarification request resolution changed immutable content')
        }
        if (
          [...state.clarificationAnswers.values()].some(
            (candidate) =>
              owns(candidate) &&
              (candidate.requestId === answer.requestId ||
                candidate.idempotencyKey === answer.idempotencyKey),
          )
        ) {
          throw new ConflictError('Clarification answer identity already exists')
        }
        assertClarificationEvidence(
          state,
          answer.organizationId,
          answer.missionId,
          answer.evidenceRefs,
        )
        insertUnique(state.clarificationAnswers, answer.id, answer)
        state.clarificationRequests.set(current.id, clone(resolvedRequest))
      },
    },
    plans: {
      async get(id) {
        return owned(state.plans.get(id), owns)
      },
      async getLatestForMission(missionId) {
        const plans = [...state.plans.values()]
          .filter((plan) => owns(plan) && plan.missionId === missionId)
          .sort((left, right) => right.revision - left.revision)
        return clone(plans[0] ?? null)
      },
      async insert(plan) {
        assertOwns(plan)
        insertUnique(state.plans, plan.id, plan)
      },
      async save(plan) {
        assertOwns(plan)
        if (!state.plans.has(plan.id)) throw new ConflictError('Plan does not exist')
        state.plans.set(plan.id, clone(plan))
      },
    },
    approvals: {
      async get(id) {
        return owned(state.approvals.get(id), owns)
      },
      async findForPlan(planId) {
        return clone(
          [...state.approvals.values()].find((item) => owns(item) && item.planId === planId) ??
            null,
        )
      },
      async insert(approval) {
        assertOwns(approval)
        insertUnique(state.approvals, approval.id, approval)
      },
      async save(approval) {
        assertOwns(approval)
        if (!state.approvals.has(approval.id)) throw new ConflictError('Approval does not exist')
        state.approvals.set(approval.id, clone(approval))
      },
    },
    operations: {
      async get(id) {
        return owned(state.operations.get(id), owns)
      },
      async findByPlanAction(planId, actionId) {
        return clone(
          [...state.operations.values()].find(
            (item) => owns(item) && item.planId === planId && item.planActionId === actionId,
          ) ?? null,
        )
      },
      async listForMission(missionId) {
        return clone(
          [...state.operations.values()].filter(
            (item) => owns(item) && item.missionId === missionId,
          ),
        )
      },
      async insert(operation) {
        assertOwns(operation)
        if (
          [...state.operations.values()].some(
            (item) =>
              owns(item) &&
              item.planId === operation.planId &&
              item.planActionId === operation.planActionId,
          )
        ) {
          throw new ConflictError('Plan action already owns an operation')
        }
        insertUnique(state.operations, operation.id, operation)
      },
      async save(operation) {
        assertOwns(operation)
        if (!state.operations.has(operation.id)) throw new ConflictError('Operation does not exist')
        state.operations.set(operation.id, clone(operation))
      },
    },
    attempts: {
      async listForOperation(operationId) {
        return clone(
          [...state.attempts.values()]
            .filter((item) => owns(item) && item.operationId === operationId)
            .sort((left, right) => left.sequence - right.sequence),
        )
      },
      async insert(attempt) {
        assertOwns(attempt)
        if (
          [...state.attempts.values()].some(
            (item) =>
              owns(item) &&
              item.operationId === attempt.operationId &&
              item.sequence === attempt.sequence,
          )
        ) {
          throw new ConflictError('Attempt sequence already exists')
        }
        insertUnique(state.attempts, attempt.id, attempt)
      },
      async save(attempt) {
        assertOwns(attempt)
        if (!state.attempts.has(attempt.id)) throw new ConflictError('Attempt does not exist')
        state.attempts.set(attempt.id, clone(attempt))
      },
    },
    routines: {
      async list(palaceId, statuses) {
        if (statuses?.length === 0) throw new TypeError('Routine status filter cannot be empty')
        if (owned(state.palaces.get(palaceId), owns) === null) {
          return { routines: [], versions: [] }
        }
        const statusSet = statuses === undefined ? null : new Set(statuses)
        const routines = [...state.routineRecords.values()]
          .filter((routine) => owns(routine) && routine.palaceId === palaceId)
          .sort(
            (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
          )
        const routineIds = new Set(routines.map((routine) => routine.id))
        const versions = [...state.routineVersionRecords.values()]
          .filter(
            (version) =>
              owns(version) &&
              routineIds.has(version.routineId) &&
              (statusSet === null || statusSet.has(version.status)),
          )
          .sort(
            (left, right) =>
              left.routineId.localeCompare(right.routineId) || right.version - left.version,
          )
        if (statusSet === null) return clone({ routines, versions })
        const includedRoutineIds = new Set(versions.map((version) => version.routineId))
        return clone({
          routines: routines.filter((routine) => includedRoutineIds.has(routine.id)),
          versions,
        })
      },
      async get(routineId, versionId) {
        const routine = state.routineRecords.get(routineId)
        if (routine === undefined || !owns(routine)) return null
        const selectedVersionId = versionId ?? routine.activeVersionId
        if (selectedVersionId === null) return null
        const version = state.routineVersionRecords.get(selectedVersionId)
        if (version === undefined || !owns(version) || version.routineId !== routine.id) {
          return null
        }
        return clone({ routine, version })
      },
      async getCurrentVersion(routineId) {
        return clone(state.routineVersions.get(routineId) ?? null)
      },
      async applyApprovedAction(plan, action) {
        assertOwns(plan)
        const outcome = applyRoutineAction(state, plan, action)
        return clone(outcome)
      },
    },
    outbox: {
      async findByDeduplicationKey(key) {
        return clone(
          [...state.outbox.values()].find(
            (message) => owns(message) && message.deduplicationKey === key,
          ) ?? null,
        )
      },
      async insert(message) {
        assertOwns(message)
        if (
          [...state.outbox.values()].some(
            (item) => owns(item) && item.deduplicationKey === message.deduplicationKey,
          )
        ) {
          throw new ConflictError('Outbox deduplication key already exists')
        }
        insertUnique(state.outbox, message.id, message)
      },
      async markDispatched(id, ownerId, dispatchedAt) {
        const message = state.outbox.get(id)
        if (
          message === undefined ||
          !owns(message) ||
          message.status !== 'claimed' ||
          message.claimedBy !== ownerId
        ) {
          return false
        }
        state.outbox.set(
          id,
          clone({
            ...message,
            status: 'dispatched' as const,
            dispatchedAt,
            claimedBy: null,
            claimExpiresAt: null,
          }),
        )
        return true
      },
      async release(id, ownerId, availableAt, errorCode) {
        const message = state.outbox.get(id)
        if (
          message === undefined ||
          !owns(message) ||
          message.status !== 'claimed' ||
          message.claimedBy !== ownerId
        ) {
          return false
        }
        state.outbox.set(
          id,
          clone({
            ...message,
            status: 'pending' as const,
            availableAt,
            claimedBy: null,
            claimExpiresAt: null,
            lastErrorCode: errorCode,
          }),
        )
        return true
      },
    },
    gatewayEffects: {
      async get(commandId) {
        const effect = state.gatewayEffects.get(commandId)
        return effect !== undefined && owns(effect.command) ? clone(effect) : null
      },
      async listForOperation(operationId) {
        return clone(
          [...state.gatewayEffects.values()].filter(
            (effect) => owns(effect.command) && effect.command.operationId === operationId,
          ),
        )
      },
      async materialize(input) {
        const { intent } = input
        assertOwns(intent.command)
        const existing = state.gatewayEffects.get(intent.command.id)
        if (existing !== undefined) {
          const existingIntent = {
            command: existing.command,
            dispatchAt: existing.dispatchAt,
            milestone: existing.milestone,
            cancellationPolicy: existing.cancellationPolicy,
            authorization: existing.authorization,
            createdAt: existing.createdAt,
          }
          if (JSON.stringify(existingIntent) !== JSON.stringify(intent)) {
            throw new ConflictError('Gateway effect identity was reused with another intent')
          }
          return { status: 'existing', effect: clone(existing) }
        }
        if (
          state.cancellations.has(intent.command.missionId) &&
          intent.cancellationPolicy !== 'mandatory_relock'
        ) {
          throw new ConflictError('Cancellation blocks new non-relock gateway effects')
        }
        const effect = GatewayEffectRecordSchema.parse({
          ...intent,
          dispatchState: {
            commandId: intent.command.id,
            generation: 1,
            status: 'pending',
            attemptId: null,
            updatedAt: intent.createdAt,
          },
          effectState: {
            commandId: intent.command.id,
            status: 'pending',
            callbackId: null,
            evidenceIds: [],
            updatedAt: intent.createdAt,
          },
          reconciliationAttempts: 0,
          lastReconciledAt: null,
          updatedAt: intent.createdAt,
        })
        state.gatewayEffects.set(effect.command.id, clone(effect))
        insertGatewayOutbox(state, effect, input.dispatchOutboxId)
        return { status: 'created', effect: clone(effect) }
      },
      async claimDispatch(input) {
        const effect = state.gatewayEffects.get(input.commandId)
        if (effect === undefined || !owns(effect.command)) return null
        if (
          effect.command.operationId !== input.operationId ||
          effect.dispatchState.generation !== input.generation
        ) {
          throw new ConflictError('Gateway dispatch reference is stale or mismatched')
        }
        if (effect.effectState.status === 'completed' || effect.effectState.status === 'failed') {
          return { status: 'not_claimed', reason: 'effect_terminal', effect: clone(effect) }
        }
        if (effect.dispatchState.status === 'cancelled') {
          return { status: 'not_claimed', reason: 'cancelled', effect: clone(effect) }
        }
        if (effect.dispatchState.status === 'dispatching') {
          return { status: 'not_claimed', reason: 'already_dispatching', effect: clone(effect) }
        }
        if (effect.dispatchState.status !== 'pending') {
          return { status: 'not_claimed', reason: 'dispatch_terminal', effect: clone(effect) }
        }
        if (Date.parse(effect.dispatchAt) > Date.parse(input.claimedAt)) {
          return { status: 'not_claimed', reason: 'not_due', effect: clone(effect) }
        }
        if (
          state.cancellations.has(effect.command.missionId) &&
          effect.cancellationPolicy !== 'mandatory_relock'
        ) {
          const cancelled = cancelPendingEffect(effect, input.claimedAt)
          state.gatewayEffects.set(effect.command.id, cancelled)
          cancelGatewayOutbox(state, effect.command.id)
          return { status: 'not_claimed', reason: 'cancelled', effect: clone(cancelled) }
        }
        const safetyReason = dispatchSafetyReason(state, effect)
        if (safetyReason !== null) {
          return { status: 'not_claimed', reason: safetyReason, effect: clone(effect) }
        }
        const sequence =
          [...state.attempts.values()].filter(
            (attempt) => owns(attempt) && attempt.operationId === effect.command.operationId,
          ).length + 1
        const attempt = AttemptSchema.parse({
          id: input.attemptId,
          organizationId,
          operationId: effect.command.operationId,
          sequence,
          transport: 'gateway',
          commandId: effect.command.id,
          generation: input.generation,
          status: 'pending',
          retryable: false,
          error: null,
          startedAt: input.claimedAt,
          completedAt: null,
        })
        insertUnique(state.attempts, attempt.id, attempt)
        const claimed = GatewayEffectRecordSchema.parse({
          ...effect,
          dispatchState: {
            commandId: effect.command.id,
            generation: input.generation,
            status: 'dispatching',
            attemptId: attempt.id,
            updatedAt: input.claimedAt,
          },
          updatedAt: input.claimedAt,
        })
        state.gatewayEffects.set(effect.command.id, clone(claimed))
        return { status: 'claimed', effect: clone(claimed), attempt: clone(attempt) }
      },
      async finalizeDispatch(input) {
        const effect = state.gatewayEffects.get(input.commandId)
        const attempt = state.attempts.get(input.attemptId)
        if (effect === undefined || attempt === undefined || !owns(effect.command)) return null
        if (effect.command.operationId !== input.operationId) {
          throw new ConflictError('Gateway finalization operation does not match')
        }
        if (
          effect.dispatchState.generation !== input.generation ||
          attempt.transport !== 'gateway' ||
          attempt.commandId !== effect.command.id ||
          attempt.generation !== input.generation
        ) {
          return {
            status: 'stale_generation',
            effect: clone(effect),
            attempt: clone(attempt),
          }
        }
        if (effect.dispatchState.status !== 'dispatching' || attempt.status !== 'pending') {
          return { status: 'already_finalized', effect: clone(effect), attempt: clone(attempt) }
        }
        const result = GatewayDispatchResultSchema.parse(input.result)
        const terminalAttempt = AttemptSchema.parse({
          ...attempt,
          status:
            result.status === 'accepted'
              ? 'succeeded'
              : result.status === 'unknown'
                ? 'unknown'
                : 'failed',
          retryable: result.status === 'accepted' ? false : result.retryable,
          error:
            result.status === 'accepted'
              ? null
              : result.status === 'unknown'
                ? {
                    code: 'GATEWAY_OUTCOME_UNKNOWN',
                    message: `Gateway ${result.reason.replace('_', ' ')}`,
                  }
                : { code: result.code, message: result.message },
          completedAt: input.completedAt,
        })
        state.attempts.set(attempt.id, clone(terminalAttempt))
        const dispatchState =
          result.status === 'accepted'
            ? {
                commandId: effect.command.id,
                generation: input.generation,
                status: 'accepted' as const,
                attemptId: attempt.id,
                acknowledgementId: result.acknowledgementId,
                updatedAt: input.completedAt,
              }
            : result.status === 'unknown'
              ? {
                  commandId: effect.command.id,
                  generation: input.generation,
                  status: 'unknown' as const,
                  attemptId: attempt.id,
                  retryable: true as const,
                  reason: result.reason,
                  updatedAt: input.completedAt,
                }
              : {
                  commandId: effect.command.id,
                  generation: input.generation,
                  status: 'failed' as const,
                  attemptId: attempt.id,
                  retryable: result.retryable,
                  error: { code: result.code, message: result.message },
                  updatedAt: input.completedAt,
                }
        const finalized = GatewayEffectRecordSchema.parse({
          ...effect,
          dispatchState,
          updatedAt: input.completedAt,
        })
        state.gatewayEffects.set(effect.command.id, clone(finalized))
        insertReconciliationOutbox(
          state,
          finalized,
          input.reconciliationOutboxId,
          input.completedAt,
        )
        return { status: 'applied', effect: clone(finalized), attempt: clone(terminalAttempt) }
      },
      async applyCallback(input) {
        assertOwns(input.callback)
        const existingById = state.gatewayCallbacks.get(input.callback.id)
        const existingByNonce = [...state.gatewayCallbacks.values()].find(
          (callback) => owns(callback) && callback.nonce === input.callback.nonce,
        )
        const existing = existingById ?? existingByNonce
        if (existing !== undefined) {
          if (!sameVerifiedCallback(existing, input.callback)) {
            throw new ConflictError('Gateway callback identity was reused with another payload')
          }
          const effect = state.gatewayEffects.get(existing.commandId)
          if (effect === undefined) return null
          return {
            status: 'duplicate',
            effect: clone(effect),
            callback: clone(existing),
          }
        }
        const effect = state.gatewayEffects.get(input.callback.commandId)
        if (effect === undefined || !owns(effect.command)) return null
        const wireCallback = GatewayCallbackSchema.parse({
          schemaVersion: input.callback.schemaVersion,
          id: input.callback.id,
          organizationId: input.callback.organizationId,
          missionId: input.callback.missionId,
          palaceId: input.callback.palaceId,
          commandId: input.callback.commandId,
          operationId: input.callback.operationId,
          status: input.callback.status,
          occurredAt: input.callback.occurredAt,
          nonce: input.callback.nonce,
          evidence: input.callback.evidence,
        })
        validateGatewayCommandCallbackBinding(effect.command, wireCallback)
        const currentCallbackStatus = effectCallbackStatus(state, effect)
        const transition = classifyGatewayCallbackStatusTransition(
          currentCallbackStatus,
          input.callback.status,
        )
        if (transition === 'reject_regression' || transition === 'reject_terminal_contradiction') {
          throw new ConflictError(`Gateway callback transition was rejected: ${transition}`)
        }
        if (transition === 'replay') {
          return { status: 'replayed', effect: clone(effect), callback: clone(input.callback) }
        }
        for (const record of input.evidence) {
          const parsed = PersistedEvidenceRecordSchema.parse(record)
          if (
            parsed.authorityReceipt.authority !== 'gateway_callback' ||
            parsed.authorityReceipt.callbackId !== input.callback.id ||
            parsed.authorityReceipt.commandId !== effect.command.id
          ) {
            throw new ConflictError('Gateway evidence authority does not match callback')
          }
          const existingEvidence = state.evidence.get(parsed.evidence.id)
          if (
            existingEvidence !== undefined &&
            JSON.stringify(existingEvidence) !== JSON.stringify(parsed)
          ) {
            throw new ConflictError('Evidence ID was reused with another authority record')
          }
          state.evidence.set(parsed.evidence.id, clone(parsed))
        }
        state.gatewayCallbacks.set(input.callback.id, clone(input.callback))
        const evidenceIds = input.evidence.map((record) => record.evidence.id)
        const effectState =
          input.callback.status === 'completed'
            ? {
                commandId: effect.command.id,
                status: 'completed' as const,
                callbackId: input.callback.id,
                evidenceIds,
                updatedAt: input.callback.receivedAt,
              }
            : input.callback.status === 'failed'
              ? {
                  commandId: effect.command.id,
                  status: 'failed' as const,
                  callbackId: input.callback.id,
                  evidenceIds,
                  updatedAt: input.callback.receivedAt,
                }
              : effect.effectState.status === 'cancellation_requested'
                ? {
                    ...effect.effectState,
                    callbackId: input.callback.id,
                    updatedAt: input.callback.receivedAt,
                  }
                : {
                    commandId: effect.command.id,
                    status: input.callback.status,
                    callbackId: input.callback.id,
                    evidenceIds: [],
                    updatedAt: input.callback.receivedAt,
                  }
        const advanced = GatewayEffectRecordSchema.parse({
          ...effect,
          effectState,
          updatedAt: input.callback.receivedAt,
        })
        state.gatewayEffects.set(effect.command.id, clone(advanced))
        return { status: 'advanced', effect: clone(advanced), callback: clone(input.callback) }
      },
      async cancelPendingForMission(input) {
        const cancelledCommandIds: GatewayEffectRecord['command']['id'][] = []
        const preservedCommandIds: GatewayEffectRecord['command']['id'][] = []
        const reconciliationCommandIds: GatewayEffectRecord['command']['id'][] = []
        for (const [commandId, effect] of state.gatewayEffects) {
          if (!owns(effect.command) || effect.command.missionId !== input.missionId) continue
          if (effect.effectState.status === 'completed' || effect.effectState.status === 'failed') {
            continue
          }
          if (effect.cancellationPolicy === 'mandatory_relock') {
            preservedCommandIds.push(effect.command.id)
            if (effect.dispatchState.status !== 'pending') {
              reconciliationCommandIds.push(effect.command.id)
            }
            continue
          }
          if (effect.dispatchState.status === 'pending') {
            const cancelled = cancelPendingEffect(effect, input.requestedAt)
            state.gatewayEffects.set(commandId, cancelled)
            cancelGatewayOutbox(state, commandId)
            cancelledCommandIds.push(effect.command.id)
            continue
          }
          if (effect.dispatchState.status === 'cancelled') {
            cancelledCommandIds.push(effect.command.id)
            continue
          }
          if (effect.dispatchState.status === 'failed') continue
          const cancellationRequested = GatewayEffectRecordSchema.parse({
            ...effect,
            effectState: {
              commandId: effect.command.id,
              status: 'cancellation_requested',
              callbackId:
                effect.effectState.status === 'pending' ? null : effect.effectState.callbackId,
              evidenceIds: [],
              requestedAt: input.requestedAt,
              updatedAt: input.requestedAt,
            },
            updatedAt: input.requestedAt,
          })
          state.gatewayEffects.set(commandId, cancellationRequested)
          reconciliationCommandIds.push(effect.command.id)
        }
        return {
          cancelledCommandIds: cancelledCommandIds.sort(),
          preservedCommandIds: preservedCommandIds.sort(),
          reconciliationCommandIds: reconciliationCommandIds.sort(),
        }
      },
      async reconcile(input) {
        const effect = state.gatewayEffects.get(input.commandId)
        if (effect === undefined || !owns(effect.command)) return null
        if (
          effect.command.operationId !== input.operationId ||
          effect.dispatchState.generation !== input.generation
        ) {
          throw new ConflictError('Gateway reconciliation reference is stale or mismatched')
        }
        const reconciled = GatewayEffectRecordSchema.parse({
          ...effect,
          reconciliationAttempts: effect.reconciliationAttempts + 1,
          lastReconciledAt: input.reconciledAt,
          updatedAt: input.reconciledAt,
        })
        state.gatewayEffects.set(effect.command.id, reconciled)
        if (
          reconciled.effectState.status === 'completed' ||
          reconciled.effectState.status === 'failed'
        ) {
          return { status: 'resolved', effect: clone(reconciled) }
        }
        if (reconciled.dispatchState.status === 'cancelled') {
          return { status: 'cancelled', effect: clone(reconciled) }
        }
        if (
          reconciled.dispatchState.status === 'failed' &&
          reconciled.dispatchState.retryable &&
          reconciled.reconciliationAttempts < input.maximumAttempts
        ) {
          const retry = GatewayEffectRecordSchema.parse({
            ...reconciled,
            dispatchState: {
              commandId: reconciled.command.id,
              generation: reconciled.dispatchState.generation + 1,
              status: 'pending',
              attemptId: null,
              updatedAt: input.reconciledAt,
            },
          })
          state.gatewayEffects.set(retry.command.id, retry)
          insertGatewayOutbox(state, retry, input.dispatchOutboxId)
          return { status: 'retry_authorized', effect: clone(retry) }
        }
        if (
          reconciled.dispatchState.status === 'failed' ||
          reconciled.reconciliationAttempts >= input.maximumAttempts
        ) {
          return { status: 'intervention_required', effect: clone(reconciled) }
        }
        insertReconciliationOutbox(
          state,
          reconciled,
          input.reconciliationOutboxId,
          input.nextPollAt,
        )
        return {
          status: 'waiting_for_callback',
          effect: clone(reconciled),
          nextPollAt: input.nextPollAt,
        }
      },
    },
    executions: {
      async get(executionId) {
        const result = [...state.executions.values()].find(
          (item) => owns(item.execution) && item.execution.id === executionId,
        )
        return clone(result ?? null)
      },
      async list(input) {
        const query = ExecutionsListInputSchema.parse(input)
        return clone(
          [...state.executions.values()]
            .map((item) => item.execution)
            .filter(
              (execution) =>
                owns(execution) &&
                (query.routineId === undefined || execution.routineId === query.routineId) &&
                (query.missionId === undefined || execution.missionId === query.missionId),
            )
            .sort(
              (left, right) =>
                right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id),
            )
            .slice(0, query.limit),
        )
      },
      async findForOperation(operationId) {
        const result = state.executions.get(operationId)
        return result !== undefined && owns(result.execution) ? clone(result) : null
      },
      async listForMission(missionId) {
        return clone(
          [...state.executions.values()].filter(
            (item) => owns(item.execution) && item.execution.missionId === missionId,
          ),
        )
      },
      async insert(execution) {
        assertOwns(execution.execution)
        insertUnique(state.executions, execution.operationId, execution)
      },
      async advanceMilestone(input) {
        const stored = state.executions.get(input.operationId)
        if (stored === undefined || !owns(stored.execution)) return null
        const current = stored.execution.milestones.find(
          (milestone) => milestone.name === input.milestone,
        )
        if (current === undefined || current.commandId !== input.commandId) {
          throw new ConflictError('Execution milestone command binding does not match')
        }
        const expectedStatus = input.failure === null ? 'completed' : 'failed'
        if (current.status !== 'pending') {
          if (
            current.status === expectedStatus &&
            current.evidenceId === input.evidenceId &&
            current.resolvedAt === input.resolvedAt
          ) {
            return { status: 'replayed', execution: clone(stored.execution) }
          }
          throw new ConflictError('Execution milestone is terminal and immutable')
        }
        if (!state.evidence.has(input.evidenceId)) {
          throw new ConflictError('Execution milestone evidence is not persisted')
        }
        const milestones = stored.execution.milestones.map((milestone) =>
          milestone.name === input.milestone
            ? {
                ...milestone,
                status: expectedStatus,
                evidenceId: input.evidenceId,
                resolvedAt: input.resolvedAt,
                failure: input.failure,
              }
            : milestone,
        )
        const execution = ExecutionSchema.parse({
          ...stored.execution,
          evidenceIds: [...new Set([...stored.execution.evidenceIds, input.evidenceId])],
          milestones,
          updatedAt: input.resolvedAt,
        })
        state.executions.set(input.operationId, { ...stored, execution })
        return { status: 'advanced', execution: clone(execution) }
      },
      async evaluateReadiness(input) {
        const stored = state.executions.get(input.operationId)
        if (
          stored === undefined ||
          !owns(stored.execution) ||
          stored.execution.id !== input.executionId ||
          stored.execution.missionId !== input.missionId
        ) {
          return null
        }
        if (stored.execution.status === 'observed' || stored.execution.status === 'failed') {
          return {
            status: 'replayed',
            reason:
              stored.execution.status === 'observed'
                ? 'all_completed'
                : stored.execution.milestones.some((milestone) => milestone.status === 'failed')
                  ? 'known_failure'
                  : 'deadline_elapsed',
            execution: clone(stored.execution),
          }
        }
        const readiness = classifyExecutionReadiness(stored.execution, input.evaluatedAt)
        if (!readiness.ready) {
          return { status: 'not_ready', execution: clone(stored.execution) }
        }
        const execution = ExecutionSchema.parse({
          ...stored.execution,
          status: readiness.reason === 'all_completed' ? 'observed' : 'failed',
          updatedAt: input.evaluatedAt,
          completedAt: input.evaluatedAt,
        })
        state.executions.set(input.operationId, { ...stored, execution })
        return { status: 'finalized', reason: readiness.reason, execution: clone(execution) }
      },
    },
    contextReceipts: {
      async get(receiptId) {
        return owned(state.contextReceipts.get(receiptId), owns)
      },
      async findLatestForMissionAtOrBefore(missionId, createdAt) {
        const cutoff = Date.parse(createdAt)
        const candidates = [...state.contextReceipts.values()]
          .filter(
            (receipt) =>
              owns(receipt) &&
              receipt.missionId === missionId &&
              Date.parse(receipt.createdAt) <= cutoff,
          )
          .sort(
            (left, right) =>
              Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
              right.id.localeCompare(left.id),
          )
        return clone(candidates[0] ?? null)
      },
      async insert(input) {
        const receipt = ContextReceiptSchema.parse(input)
        assertOwns(receipt)
        const mission = state.missions.get(receipt.missionId)
        if (mission === undefined || !owns(mission)) {
          throw new ConflictError('Context receipt mission does not exist')
        }
        insertUnique(state.contextReceipts, receipt.id, receipt)
      },
    },
    evidence: {
      async get(evidenceId) {
        const record = state.evidence.get(evidenceId)
        return record !== undefined && owns(record.evidence) ? clone(record) : null
      },
      async appendMany(evidence) {
        for (const item of evidence) {
          const parsed = PersistedEvidenceRecordSchema.parse(item)
          assertOwns(parsed.evidence)
          const existing = state.evidence.get(parsed.evidence.id)
          if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(item)) {
            throw new ConflictError('Evidence ID was reused with another payload')
          }
          state.evidence.set(parsed.evidence.id, clone(parsed))
        }
      },
      async listForMission(missionId) {
        return clone(
          [...state.evidence.values()].filter(
            (item) => owns(item.evidence) && item.evidence.missionId === missionId,
          ),
        )
      },
    },
    verifications: {
      async findForMission(missionId) {
        return owned(state.verifications.get(missionId), owns)
      },
      async insert(verification) {
        assertOwns(verification)
        insertUnique(state.verifications, verification.missionId, verification)
      },
    },
    missionLeases: {
      async acquire(input) {
        assertOwns(input)
        validateLeaseTtl(input.ttlMilliseconds)
        const now = clock.now()
        const existing = state.leases.get(input.missionId)
        if (
          existing !== undefined &&
          existing.releasedAt === null &&
          Date.parse(existing.expiresAt) > now.getTime()
        ) {
          return null
        }
        const epoch = (existing?.epoch ?? 0) + 1
        state.leases.set(input.missionId, {
          organizationId,
          missionId: input.missionId,
          ownerId: input.ownerId,
          epoch,
          tokenFingerprint: input.token.storageFingerprint(),
          acquiredAt: iso(now),
          renewedAt: iso(now),
          expiresAt: iso(addMilliseconds(now, input.ttlMilliseconds)),
          releasedAt: null,
        })
        return {
          organizationId,
          missionId: input.missionId,
          ownerId: input.ownerId,
          epoch,
          token: input.token,
        }
      },
      async renew(fence, ttlMilliseconds) {
        validateLeaseTtl(ttlMilliseconds)
        const now = clock.now()
        const existing = state.leases.get(fence.missionId)
        if (
          existing === undefined ||
          !matchesFence(existing, fence) ||
          existing.releasedAt !== null ||
          Date.parse(existing.expiresAt) <= now.getTime()
        ) {
          return null
        }
        state.leases.set(fence.missionId, {
          ...existing,
          renewedAt: iso(now),
          expiresAt: iso(addMilliseconds(now, ttlMilliseconds)),
        })
        return { ...fence }
      },
      async release(fence) {
        const existing = state.leases.get(fence.missionId)
        if (
          existing === undefined ||
          !matchesFence(existing, fence) ||
          existing.releasedAt !== null ||
          Date.parse(existing.expiresAt) <= clock.now().getTime()
        ) {
          return false
        }
        state.leases.set(fence.missionId, {
          ...existing,
          releasedAt: iso(clock.now()),
        })
        return true
      },
    },
    cancellations: {
      async findForMission(missionId) {
        return owned(state.cancellations.get(missionId), owns)
      },
      async insert(record) {
        assertOwns(record)
        insertUnique(state.cancellations, record.missionId, record)
      },
    },
    compensatingPlans: {
      async findByPlan(planId) {
        return owned(state.compensatingPlans.get(planId), owns)
      },
      async insert(link) {
        assertOwns(link)
        insertUnique(state.compensatingPlans, link.planId, link)
      },
    },
    planAssessments: {
      async saveValidation(record) {
        state.validations.set(record.planId, clone(record))
      },
      async getValidation(planId) {
        return clone(state.validations.get(planId) ?? null)
      },
      async saveSimulation(record) {
        state.simulations.push(clone(record))
      },
      async listSimulations(planId) {
        return clone(state.simulations.filter((item) => item.planId === planId))
      },
    },
    reconciliations: {
      async listForOperation(operationId) {
        return clone(
          state.reconciliations.filter(
            (poll) => poll.organizationId === organizationId && poll.operationId === operationId,
          ),
        )
      },
      async insert(poll) {
        assertOwns(poll)
        if (
          state.reconciliations.some(
            (item) => item.operationId === poll.operationId && item.sequence === poll.sequence,
          )
        ) {
          throw new ConflictError('Reconciliation poll sequence already exists')
        }
        state.reconciliations.push(clone(poll))
      },
    },
    productEvidence: {
      async enqueue(input) {
        if (fence !== null && input.missionId !== fence.missionId) {
          throw new ConflictError(
            'Mission fence cannot enqueue product evidence for another mission',
          )
        }
        const envelope = parseFrozenApplicationProductEvidenceEnvelope(input.envelope)
        const existing = state.productEvidenceDeliveries.get(envelope.logicalEventId)
        if (existing !== undefined) {
          if (existing.organizationId !== organizationId) {
            throw new ConflictError('Product evidence logical identity crossed a tenant boundary')
          }
          if (existing.envelope.semanticHash !== envelope.semanticHash) {
            throw new ConflictError(
              'Application evidence logical identity was reused with different semantics',
            )
          }
          return { kind: 'replayed', envelope: clone(existing.envelope) }
        }
        if (
          [...state.productEvidenceDeliveries.values()].some(
            (delivery) => delivery.envelope.event.insertId === envelope.event.insertId,
          )
        ) {
          throw new ConflictError(
            'Application evidence insert identity was reused by another logical event',
          )
        }
        const delivery: ProductEvidenceDelivery = {
          organizationId,
          envelope,
          status: 'pending',
          createdAt: iso(clock.now()),
          deliveredAt: null,
          captureStatus: null,
        }
        state.productEvidenceDeliveries.set(envelope.logicalEventId, clone(delivery))
        return { kind: 'enqueued', envelope: clone(envelope) }
      },
    },
    caretakerRuns: {
      async get(runId) {
        return caretakerSnapshot(state, organizationId, runId)
      },
      async getLatestForMission(missionId) {
        const mission = state.missions.get(missionId)
        if (
          mission === undefined ||
          mission.organizationId !== organizationId ||
          mission.runId === null
        ) {
          return null
        }
        return caretakerSnapshot(state, organizationId, mission.runId)
      },
      async listCheckpoints(runId) {
        const run = state.caretakerRuns.get(runId)
        if (run === undefined || run.organizationId !== organizationId) return []
        return clone(state.caretakerRunCheckpoints.get(runId) ?? [])
      },
      async start(input) {
        if (fence === null || fence.missionId !== input.missionId) {
          throw new LeaseLostError()
        }
        const mission = state.missions.get(input.missionId)
        if (mission === undefined || !owns(mission))
          throw new ConflictError('Mission does not exist')
        const startHash = hashCanonical({
          schemaVersion: 'caretaker-run-start@2',
          organizationId,
          missionId: input.missionId,
          runId: input.runId,
          mutationKey: input.mutationKey,
          evidenceProfileHash: input.evidenceProfile.profileHash,
          occurredAt: input.occurredAt,
        })
        const existing = state.caretakerRuns.get(input.runId)
        const existingIsTerminalFinalization =
          existing !== undefined &&
          (existing.status === 'active' || existing.status === 'paused') &&
          mission.runId === existing.id &&
          ['succeeded', 'failed', 'cancelled'].includes(mission.state.status)
        if (existing !== undefined) {
          const first = state.caretakerRunCheckpoints.get(input.runId)?.[0]
          if (
            existing.organizationId !== organizationId ||
            existing.missionId !== input.missionId
          ) {
            throw new ConflictError('Caretaker run identity is already bound')
          }
          if (
            existing.evidenceProfile.configurationHash !== input.evidenceProfile.configurationHash
          ) {
            throw new ConflictError('Caretaker evidence profile changed during a durable run')
          }
          if (
            mission.runId === existing.id &&
            ['completed', 'failed', 'cancelled'].includes(existing.status)
          ) {
            return {
              kind: 'replayed',
              snapshot: caretakerSnapshotRequired(state, organizationId, existing.id),
            }
          }
          if (
            existing.leaseEpoch === fence.epoch &&
            first?.mutationKey === input.mutationKey &&
            first.mutationHash === startHash
          ) {
            return {
              kind: 'replayed',
              snapshot: caretakerSnapshotRequired(state, organizationId, input.runId),
            }
          }
          if (
            (!existingIsTerminalFinalization && existing.status !== 'active') ||
            existing.leaseEpoch > fence.epoch
          ) {
            throw new ConflictError('Caretaker run identity is already bound')
          }
        }
        const canonicalRun =
          mission.runId === null ? undefined : state.caretakerRuns.get(mission.runId)
        if (
          canonicalRun !== undefined &&
          canonicalRun.organizationId === organizationId &&
          canonicalRun.missionId === mission.id &&
          ['completed', 'failed', 'cancelled'].includes(canonicalRun.status)
        ) {
          return {
            kind: 'replayed',
            snapshot: caretakerSnapshotRequired(state, organizationId, canonicalRun.id),
          }
        }
        const terminalFinalization = existingIsTerminalFinalization
        const externalStateSynchronization =
          existing?.status === 'active' &&
          mission.runId === existing.id &&
          ((mission.state.status === 'waiting_for_system' && mission.state.phase === 'observe') ||
            (mission.state.status === 'waiting_for_user' &&
              (mission.state.phase === 'plan' || mission.state.phase === 'approve')))
        if (
          mission.state.status !== 'running' &&
          !terminalFinalization &&
          !externalStateSynchronization
        ) {
          throw new ConflictError('A Caretaker run may start only for a running mission')
        }
        const active = [...state.caretakerRuns.values()].find(
          (run) =>
            run.organizationId === organizationId &&
            run.missionId === input.missionId &&
            run.status === 'active',
        )
        const taskLedger = parseCaretakerTaskLedger(mission.taskLedger)
        const taskLedgerVersion = state.taskLedgerVersions.get(mission.id) ?? 0
        if (terminalFinalization && existing.status === 'paused') {
          if (
            existing.evidenceProfile.configurationHash !== input.evidenceProfile.configurationHash
          ) {
            throw new ConflictError(
              'Caretaker evidence profile changed during terminal finalization',
            )
          }
          if (existing.taskLedgerVersion !== taskLedgerVersion) {
            throw new ConflictError('Paused run task-ledger version is inconsistent')
          }
          if (existing.pendingToolCall !== null) {
            throw new ConflictError('Paused terminal run retained a pending tool call')
          }
          const resumeHash = hashCanonical({
            schemaVersion: 'caretaker-run-resume@1',
            organizationId,
            missionId: input.missionId,
            runId: existing.id,
            candidateRunId: input.runId,
            mutationKey: input.mutationKey,
            leaseEpoch: fence.epoch,
            occurredAt: input.occurredAt,
          })
          const resumed = CaretakerRunRecordSchema.parse({
            ...existing,
            leaseEpoch: fence.epoch,
            status: 'active',
            phase: mission.state.phase,
            version: existing.version + 1,
            updatedAt: input.occurredAt,
            endedAt: null,
          })
          const checkpoint = CaretakerRunCheckpointSchema.parse({
            organizationId,
            missionId: existing.missionId,
            runId: existing.id,
            sequence: resumed.version,
            mutationKey: input.mutationKey,
            mutationHash: resumeHash,
            kind: 'lease_replaced',
            runStatus: 'active',
            phase: mission.state.phase,
            runVersion: resumed.version,
            taskLedgerVersion,
            taskLedgerHash: hashCaretakerTaskLedger(taskLedger),
            taskLedger,
            counters: existing.counters,
            pendingToolCall: null,
            evidenceRefs: [],
            occurredAt: input.occurredAt,
          })
          state.caretakerRuns.set(existing.id, resumed)
          state.caretakerRunCheckpoints.set(existing.id, [
            ...(state.caretakerRunCheckpoints.get(existing.id) ?? []),
            checkpoint,
          ])
          return {
            kind: 'resumed',
            snapshot: { run: resumed, checkpoint, taskLedger },
          }
        }
        if (active !== undefined) {
          if (
            active.evidenceProfile.configurationHash !== input.evidenceProfile.configurationHash
          ) {
            throw new ConflictError('Caretaker evidence profile changed during lease replacement')
          }
          if (
            active.taskLedgerVersion !== taskLedgerVersion ||
            (active.phase !== mission.state.phase &&
              !terminalFinalization &&
              !externalStateSynchronization)
          ) {
            throw new ConflictError('The active Caretaker run disagrees with its mission state')
          }
          const resumeHash = hashCanonical({
            schemaVersion: 'caretaker-run-resume@1',
            organizationId,
            missionId: input.missionId,
            runId: active.id,
            candidateRunId: input.runId,
            mutationKey: input.mutationKey,
            leaseEpoch: fence.epoch,
            occurredAt: input.occurredAt,
          })
          if (active.leaseEpoch === fence.epoch) {
            const existingResume = (state.caretakerRunCheckpoints.get(active.id) ?? []).find(
              (checkpoint) => checkpoint.mutationKey === input.mutationKey,
            )
            if (existingResume?.mutationHash !== resumeHash) {
              throw new ConflictError('The active Caretaker run belongs to the current lease epoch')
            }
            return {
              kind: 'replayed',
              snapshot: caretakerSnapshotRequired(state, organizationId, active.id),
            }
          }
          if (active.leaseEpoch > fence.epoch) {
            throw new ConflictError('A newer lease epoch owns the active Caretaker run')
          }
          const resumed = CaretakerRunRecordSchema.parse({
            ...active,
            leaseEpoch: fence.epoch,
            phase:
              terminalFinalization || externalStateSynchronization
                ? mission.state.phase
                : active.phase,
            version: active.version + 1,
            updatedAt: input.occurredAt,
          })
          const checkpoint = CaretakerRunCheckpointSchema.parse({
            organizationId,
            missionId: active.missionId,
            runId: active.id,
            sequence: resumed.version,
            mutationKey: input.mutationKey,
            mutationHash: resumeHash,
            kind: 'lease_replaced',
            runStatus: 'active',
            phase:
              terminalFinalization || externalStateSynchronization
                ? mission.state.phase
                : active.phase,
            runVersion: resumed.version,
            taskLedgerVersion,
            taskLedgerHash: hashCaretakerTaskLedger(taskLedger),
            taskLedger,
            counters: active.counters,
            pendingToolCall: active.pendingToolCall,
            evidenceRefs: [],
            occurredAt: input.occurredAt,
          })
          state.caretakerRuns.set(active.id, resumed)
          state.caretakerRunCheckpoints.set(active.id, [
            ...(state.caretakerRunCheckpoints.get(active.id) ?? []),
            checkpoint,
          ])
          state.missions.set(mission.id, { ...mission, runId: active.id })
          return {
            kind: 'resumed',
            snapshot: { run: resumed, checkpoint, taskLedger },
          }
        }
        const previousRun =
          mission.runId === null ? undefined : state.caretakerRuns.get(mission.runId)
        let inheritedCounters = EMPTY_CARETAKER_RUN_COUNTERS
        if (
          mission.runId !== null &&
          (previousRun === undefined ||
            previousRun.organizationId !== organizationId ||
            previousRun.missionId !== input.missionId)
        ) {
          throw new ConflictError('Mission latest Caretaker activation is missing')
        }
        if (previousRun !== undefined) {
          if (previousRun.status !== 'paused') {
            throw new ConflictError('Only a paused Caretaker activation may start a successor')
          }
          const latestCheckpoint = state.caretakerRunCheckpoints.get(previousRun.id)?.at(-1)
          if (latestCheckpoint?.kind === 'budget_exhausted') {
            throw new ConflictError(
              'A budget-exhausted Caretaker activation requires explicit authorization to resume',
            )
          }
          if (latestCheckpoint === undefined || previousRun.pendingToolCall !== null) {
            throw new ConflictError('Previous Caretaker activation is not resumable')
          }
          inheritedCounters = previousRun.counters
        }
        const run = CaretakerRunRecordSchema.parse({
          id: input.runId,
          organizationId,
          missionId: input.missionId,
          leaseEpoch: fence.epoch,
          status: 'active',
          phase: mission.state.phase,
          version: 0,
          taskLedgerVersion,
          counters: inheritedCounters,
          pendingToolCall: null,
          evidenceProfile: input.evidenceProfile,
          startedAt: input.occurredAt,
          updatedAt: input.occurredAt,
          endedAt: null,
        })
        const checkpoint = CaretakerRunCheckpointSchema.parse({
          organizationId,
          missionId: input.missionId,
          runId: input.runId,
          sequence: 0,
          mutationKey: input.mutationKey,
          mutationHash: startHash,
          kind: 'activated',
          runStatus: 'active',
          phase: mission.state.phase,
          runVersion: 0,
          taskLedgerVersion,
          taskLedgerHash: hashCaretakerTaskLedger(taskLedger),
          taskLedger,
          counters: inheritedCounters,
          pendingToolCall: null,
          evidenceRefs: [],
          occurredAt: input.occurredAt,
        })
        state.caretakerRuns.set(run.id, run)
        state.caretakerRunCheckpoints.set(run.id, [checkpoint])
        state.missions.set(mission.id, { ...mission, runId: run.id })
        return { kind: 'started', snapshot: { run, checkpoint, taskLedger } }
      },
      async checkpoint(input) {
        if (fence === null) throw new LeaseLostError()
        const run = state.caretakerRuns.get(input.runId)
        if (run === undefined || run.organizationId !== organizationId) {
          throw new ConflictError('Caretaker run does not exist')
        }
        if (run.missionId !== fence.missionId) throw new LeaseLostError()
        const terminalEvidence = input.terminalEvidence ?? null
        const mutationHash = hashCaretakerCheckpointMutation({
          organizationId,
          missionId: run.missionId,
          ...input,
          terminalEvidence,
        })
        const replay = (state.caretakerRunCheckpoints.get(run.id) ?? []).find(
          (checkpoint) => checkpoint.mutationKey === input.mutationKey,
        )
        if (replay !== undefined) {
          if (replay.mutationHash !== mutationHash) {
            throw new ConflictError('Caretaker checkpoint mutation key is already bound')
          }
          return {
            kind: 'replayed',
            snapshot: caretakerSnapshotRequired(state, organizationId, run.id),
          }
        }
        const mission = state.missions.get(run.missionId)
        if (mission === undefined || !owns(mission))
          throw new ConflictError('Mission does not exist')
        const currentTaskLedgerVersion = state.taskLedgerVersions.get(mission.id) ?? 0
        if (
          input.expectedVersion !== run.version ||
          input.expectedTaskLedgerVersion !== currentTaskLedgerVersion
        ) {
          return {
            kind: 'version_conflict',
            snapshot: caretakerSnapshotRequired(state, organizationId, run.id),
          }
        }
        if (run.status !== 'active' || run.leaseEpoch !== fence.epoch) throw new LeaseLostError()
        assertCaretakerMissionStateForCheckpoint({
          state: mission.state,
          kind: input.kind,
          clearsPendingToolCall: run.pendingToolCall !== null && input.pendingToolCall === null,
        })
        const previousLedger = parseCaretakerTaskLedger(mission.taskLedger)
        const nextLedger = parseCaretakerTaskLedger(input.taskLedger)
        assertCaretakerTaskLedgerTransition(previousLedger, nextLedger)
        assertCaretakerCounterTransition({
          previous: run.counters,
          next: input.counters,
          kind: input.kind,
        })
        const previousActionCheckpoint = [...(state.caretakerRunCheckpoints.get(run.id) ?? [])]
          .reverse()
          .find((checkpoint) => checkpoint.kind !== 'lease_replaced')
        if (previousActionCheckpoint === undefined) {
          throw new ConflictError('Caretaker run lacks an action checkpoint')
        }
        assertCaretakerPendingToolCallTransition({
          previous: run.pendingToolCall,
          next: input.pendingToolCall,
          previousCheckpointKind: previousActionCheckpoint.kind,
          kind: input.kind,
        })
        if (input.kind === 'tool_wait') {
          assertCaretakerToolWaitPayloadTransition({
            previousCheckpointKind: previousActionCheckpoint.kind,
            previousPhase: run.phase,
            nextPhase: mission.state.phase,
            previousTaskLedger: previousLedger,
            nextTaskLedger: nextLedger,
            evidenceRefs: input.evidenceRefs,
          })
        }
        const ledgerChanged =
          hashCaretakerTaskLedger(previousLedger) !== hashCaretakerTaskLedger(nextLedger)
        const taskLedgerVersion = currentTaskLedgerVersion + (ledgerChanged ? 1 : 0)
        const status = caretakerRunStatusForCheckpoint(input.kind)
        if ((status === 'active') !== (terminalEvidence === null)) {
          throw new ConflictError(
            'A terminal Caretaker checkpoint requires exactly one terminal evidence envelope',
          )
        }
        const nextRun = CaretakerRunRecordSchema.parse({
          ...run,
          status,
          phase: mission.state.phase,
          version: run.version + 1,
          taskLedgerVersion,
          counters: input.counters,
          pendingToolCall: input.pendingToolCall,
          evidenceProfile: run.evidenceProfile,
          updatedAt: input.occurredAt,
          endedAt: status === 'active' ? null : input.occurredAt,
        })
        const checkpoint = CaretakerRunCheckpointSchema.parse({
          organizationId,
          missionId: run.missionId,
          runId: run.id,
          sequence: nextRun.version,
          mutationKey: input.mutationKey,
          mutationHash,
          kind: input.kind,
          runStatus: status,
          phase: mission.state.phase,
          runVersion: nextRun.version,
          taskLedgerVersion,
          taskLedgerHash: hashCaretakerTaskLedger(nextLedger),
          taskLedger: nextLedger,
          counters: input.counters,
          pendingToolCall: input.pendingToolCall,
          evidenceRefs: input.evidenceRefs,
          occurredAt: input.occurredAt,
        })
        state.caretakerRuns.set(run.id, nextRun)
        state.caretakerRunCheckpoints.set(run.id, [
          ...(state.caretakerRunCheckpoints.get(run.id) ?? []),
          checkpoint,
        ])
        if (terminalEvidence !== null) {
          if (state.caretakerTerminalEvidenceDeliveries.has(run.id)) {
            throw new ConflictError('Caretaker terminal evidence handoff already exists')
          }
          state.caretakerTerminalEvidenceDeliveries.set(
            run.id,
            CaretakerTerminalEvidenceDeliverySchema.parse({
              organizationId,
              missionId: run.missionId,
              runId: run.id,
              envelope: terminalEvidence,
              status: 'pending',
              createdAt: input.occurredAt,
              deliveredAt: null,
              captureStatus: null,
            }),
          )
        }
        if (ledgerChanged) {
          state.taskLedgerVersions.set(mission.id, taskLedgerVersion)
          state.missions.set(mission.id, { ...mission, taskLedger: nextLedger })
        }
        return { kind: 'applied', snapshot: { run: nextRun, checkpoint, taskLedger: nextLedger } }
      },
    },
  }
}

function caretakerSnapshot(
  state: InMemoryState,
  organizationId: OrganizationId,
  runId: string,
): CaretakerRunSnapshot | null {
  const run = state.caretakerRuns.get(runId)
  if (run === undefined || run.organizationId !== organizationId) return null
  return caretakerSnapshotRequired(state, organizationId, runId)
}

function caretakerSnapshotRequired(
  state: InMemoryState,
  organizationId: OrganizationId,
  runId: string,
): CaretakerRunSnapshot {
  const run = state.caretakerRuns.get(runId)
  const checkpoint = state.caretakerRunCheckpoints.get(runId)?.at(-1)
  const mission = run === undefined ? undefined : state.missions.get(run.missionId)
  if (
    run === undefined ||
    checkpoint === undefined ||
    mission === undefined ||
    run.organizationId !== organizationId ||
    mission.organizationId !== organizationId
  ) {
    throw new ConflictError('Caretaker run snapshot is incomplete')
  }
  return {
    run: clone(run),
    checkpoint: clone(checkpoint),
    taskLedger: parseCaretakerTaskLedger(mission.taskLedger),
  }
}

function insertGatewayOutbox(
  state: InMemoryState,
  effect: GatewayEffectRecord,
  outboxId: string,
): void {
  const deduplicationKey = `gateway.dispatch:${effect.command.id}:${effect.dispatchState.generation}`
  if (
    [...state.outbox.values()].some(
      (message) =>
        message.organizationId === effect.command.organizationId &&
        message.deduplicationKey === deduplicationKey,
    )
  ) {
    throw new ConflictError('Gateway dispatch outbox already exists')
  }
  insertUnique(state.outbox, outboxId, {
    id: outboxId,
    organizationId: effect.command.organizationId,
    topic: 'gateway.dispatch',
    deduplicationKey,
    payload: {
      organizationId: effect.command.organizationId,
      operationId: effect.command.operationId,
      commandId: effect.command.id,
      generation: effect.dispatchState.generation,
    },
    status: 'pending',
    availableAt: effect.dispatchAt,
    createdAt: effect.updatedAt,
    claimedBy: null,
    claimExpiresAt: null,
    dispatchedAt: null,
    deliveryAttempts: 0,
    lastErrorCode: null,
  })
}

function insertReconciliationOutbox(
  state: InMemoryState,
  effect: GatewayEffectRecord,
  outboxId: string,
  availableAt: string,
): void {
  const deduplicationKey = `gateway.effect.reconcile:${effect.command.id}:${effect.dispatchState.generation}:${effect.reconciliationAttempts}`
  const existing = [...state.outbox.values()].find(
    (message) =>
      message.organizationId === effect.command.organizationId &&
      message.deduplicationKey === deduplicationKey,
  )
  if (existing !== undefined) return
  insertUnique(state.outbox, outboxId, {
    id: outboxId,
    organizationId: effect.command.organizationId,
    topic: 'gateway.effect.reconcile',
    deduplicationKey,
    payload: {
      organizationId: effect.command.organizationId,
      operationId: effect.command.operationId,
      commandId: effect.command.id,
      generation: effect.dispatchState.generation,
    },
    status: 'pending',
    availableAt,
    createdAt: effect.updatedAt,
    claimedBy: null,
    claimExpiresAt: null,
    dispatchedAt: null,
    deliveryAttempts: 0,
    lastErrorCode: null,
  })
}

function cancelGatewayOutbox(state: InMemoryState, commandId: string): void {
  for (const [id, message] of state.outbox) {
    if (
      message.topic === 'gateway.dispatch' &&
      message.payload.commandId === commandId &&
      (message.status === 'pending' || message.status === 'claimed')
    ) {
      state.outbox.set(id, { ...message, status: 'cancelled' })
    }
  }
}

function cancelPendingEffect(
  effect: GatewayEffectRecord,
  cancelledAt: string,
): GatewayEffectRecord {
  return GatewayEffectRecordSchema.parse({
    ...effect,
    dispatchState: {
      commandId: effect.command.id,
      generation: effect.dispatchState.generation,
      status: 'cancelled',
      attemptId: null,
      reason: 'mission_cancelled_before_dispatch',
      cancelledAt,
      updatedAt: cancelledAt,
    },
    updatedAt: cancelledAt,
  })
}

function dispatchSafetyReason(
  state: InMemoryState,
  effect: GatewayEffectRecord,
): 'authorization_invalid' | 'capability_unavailable' | null {
  const operation = state.operations.get(effect.command.operationId)
  if (
    operation === undefined ||
    operation.organizationId !== effect.command.organizationId ||
    operation.missionId !== effect.command.missionId ||
    operation.status !== 'committed'
  ) {
    return 'authorization_invalid'
  }
  const device = state.devices.get(effect.command.payload.deviceId)
  const expectedCapability =
    effect.command.kind === 'set_temperature'
      ? 'temperature_target'
      : effect.command.kind === 'set_lighting'
        ? 'pathway_lighting'
        : 'lock_desired_state'
  const available =
    device !== undefined &&
    device.organizationId === effect.command.organizationId &&
    device.palaceId === effect.command.palaceId &&
    device.health === 'online' &&
    [...state.capabilities.values()].some(
      (capability) =>
        capability.organizationId === effect.command.organizationId &&
        capability.deviceId === device.id &&
        capability.kind === expectedCapability &&
        capability.enabled,
    )
  if (!available) return 'capability_unavailable'

  const causedByEvidenceId = effect.command.payload.causedByEvidenceId
  if (causedByEvidenceId !== null) {
    const record = state.evidence.get(causedByEvidenceId)
    if (
      record === undefined ||
      record.evidence.organizationId !== effect.command.organizationId ||
      record.evidence.missionId !== effect.command.missionId ||
      record.evidence.palaceId !== effect.command.palaceId
    ) {
      return 'authorization_invalid'
    }
  }
  if (effect.command.kind === 'unlock') {
    const tag = state.identityTags.get(effect.command.payload.identityTagId)
    const record = state.evidence.get(effect.command.payload.causedByEvidenceId)
    if (
      tag === undefined ||
      !tag.active ||
      !tag.verified ||
      record?.authorityReceipt.authority !== 'identity_telemetry' ||
      record.evidence.type !== 'identity_arrival' ||
      !record.evidence.verified ||
      record.evidence.identityTagId !== tag.id
    ) {
      return 'authorization_invalid'
    }
  }
  return null
}

function effectCallbackStatus(
  state: InMemoryState,
  effect: GatewayEffectRecord,
): StoredGatewayCallback['status'] | null {
  if (effect.effectState.status === 'pending') return null
  if (effect.effectState.status === 'cancellation_requested') {
    if (effect.effectState.callbackId === null) return null
    return state.gatewayCallbacks.get(effect.effectState.callbackId)?.status ?? null
  }
  return effect.effectState.status
}

function sameVerifiedCallback(
  existing: StoredGatewayCallback,
  incoming: StoredGatewayCallback,
): boolean {
  const { receivedAt: _existingReceivedAt, ...existingPayload } = existing
  const { receivedAt: _incomingReceivedAt, ...incomingPayload } = incoming
  return JSON.stringify(existingPayload) === JSON.stringify(incomingPayload)
}

function applyRoutineAction(
  state: InMemoryState,
  plan: Plan,
  action: PlanAction,
): OperationOutcome {
  if (isRoutineReplacementAction(action)) {
    const current = state.routineVersions.get(action.protectedRoutineId)
    if (
      current === undefined ||
      current.routineVersionId !== action.protectedRoutineVersionId ||
      current.version !== action.expectedProtectedVersion
    ) {
      throw new ConflictError('Protected routine version is stale')
    }
    state.routineVersions.set(action.replacementRoutineId, {
      routineId: action.replacementRoutineId,
      routineVersionId: action.replacementRoutineVersionId,
      version: 1,
    })
    state.routineVersions.delete(action.protectedRoutineId)
    const protectedVersion = state.routineVersionRecords.get(action.protectedRoutineVersionId)
    if (protectedVersion !== undefined) {
      state.routineVersionRecords.set(
        protectedVersion.id,
        RoutineVersionSchema.parse({ ...protectedVersion, status: 'inactive' }),
      )
    }
    const protectedRoutine = state.routineRecords.get(action.protectedRoutineId)
    if (protectedRoutine !== undefined) {
      state.routineRecords.set(
        protectedRoutine.id,
        RoutineSchema.parse({ ...protectedRoutine, activeVersionId: null }),
      )
    }
    const replacementRoutine = RoutineSchema.parse({
      id: action.replacementRoutineId,
      organizationId: plan.organizationId,
      palaceId: action.palaceId,
      name: action.replacement.name,
      activeVersionId: action.replacementRoutineVersionId,
      createdAt: plan.createdAt,
    })
    const replacementVersion = RoutineVersionSchema.parse({
      id: action.replacementRoutineVersionId,
      routineId: action.replacementRoutineId,
      organizationId: plan.organizationId,
      version: 1,
      status: 'active',
      definition: action.replacement,
      sourcePlanId: plan.id,
      sourcePlanHash: plan.hash,
      createdAt: plan.createdAt,
    })
    state.routineRecords.set(replacementRoutine.id, replacementRoutine)
    state.routineVersionRecords.set(replacementVersion.id, replacementVersion)
    return {
      routineId: action.replacementRoutineId,
      routineVersionId: action.replacementRoutineVersionId,
      deactivatedRoutineId: action.protectedRoutineId,
    }
  }
  const current = state.routineVersions.get(action.routineId)
  if (current === undefined || current.version !== action.expectedCurrentVersion) {
    throw new ConflictError('Current routine version is stale')
  }
  const restoredVersion = state.routineVersionRecords.get(action.restoreVersionId)
  state.routineVersions.set(action.routineId, {
    routineId: action.routineId,
    routineVersionId: action.restoreVersionId,
    version: restoredVersion?.version ?? current.version + 1,
  })
  const routine = state.routineRecords.get(action.routineId)
  if (routine !== undefined) {
    state.routineRecords.set(
      routine.id,
      RoutineSchema.parse({ ...routine, activeVersionId: action.restoreVersionId }),
    )
  }
  for (const [versionId, version] of state.routineVersionRecords) {
    if (version.routineId !== action.routineId) continue
    state.routineVersionRecords.set(
      versionId,
      RoutineVersionSchema.parse({
        ...version,
        status: version.id === action.restoreVersionId ? 'active' : 'inactive',
      }),
    )
  }
  return {
    routineId: action.routineId,
    routineVersionId: action.restoreVersionId,
    deactivatedRoutineId: null,
  }
}

export class MutableClock implements ClockPort {
  public constructor(private current: Date) {}
  public now(): Date {
    return new Date(this.current)
  }
  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds)
  }
}

export class FixedEntropy implements EntropyPort {
  public constructor(private readonly value = 'fixed_entropy_value_1234567890') {}
  public token(_bytes: number): string {
    return this.value
  }
}

const ID_PREFIX: Readonly<Record<IdKind, string>> = {
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

export class SequentialIdGenerator implements IdGeneratorPort {
  #sequence = 0
  public next(kind: IdKind): string {
    this.#sequence += 1
    return `${ID_PREFIX[kind]}_x${String(this.#sequence).padStart(12, '0')}`
  }
}

export class FakeQueue implements QueuePort {
  readonly published: {
    topic: string
    payload: Readonly<Record<string, JsonValue>>
    deduplicationKey: string
  }[] = []
  readonly #keys = new Set<string>()
  public failNext: Error | null = null

  public async publish(
    topic: string,
    payload: Readonly<Record<string, JsonValue>>,
    options: { readonly deduplicationKey: string },
  ): Promise<{ readonly jobId: string | null; readonly duplicate: boolean }> {
    if (this.failNext !== null) {
      const failure = this.failNext
      this.failNext = null
      throw failure
    }
    if (this.#keys.has(options.deduplicationKey)) return { jobId: null, duplicate: true }
    this.#keys.add(options.deduplicationKey)
    this.published.push({
      topic,
      payload: clone(payload),
      deduplicationKey: options.deduplicationKey,
    })
    return { jobId: `job_${this.published.length}`, duplicate: false }
  }
}

export class RecordingObservability implements ObservabilityPort {
  readonly spans: ApplicationSpan[] = []
  readonly observations: DomainObservation[] = []
  public async trace<Result>(span: ApplicationSpan, work: () => Promise<Result>): Promise<Result> {
    this.spans.push(clone(span))
    return work()
  }
  public async record(observation: DomainObservation): Promise<void> {
    this.observations.push(clone(observation))
  }
}

function keyed<Value extends { readonly id: string }>(
  values: readonly Value[] = [],
): Map<string, Value> {
  return new Map(values.map((value) => [value.id, clone(value)]))
}

function owned<Value extends { readonly organizationId: OrganizationId }>(
  value: Value | undefined,
  owns: (record: { readonly organizationId: OrganizationId }) => boolean,
): Value | null {
  return value !== undefined && owns(value) ? clone(value) : null
}

function insertUnique<Value>(map: Map<string, Value>, id: string, value: Value): void {
  if (map.has(id)) throw new ConflictError(`Record ${id} already exists`)
  map.set(id, clone(value))
}

function assertClarificationEvidence(
  state: InMemoryState,
  organizationId: OrganizationId,
  missionId: MissionId,
  evidenceRefs: readonly string[],
): void {
  for (const evidenceId of evidenceRefs) {
    const record = state.evidence.get(evidenceId)
    if (
      record === undefined ||
      record.evidence.organizationId !== organizationId ||
      record.evidence.missionId !== missionId
    ) {
      throw new ConflictError('Clarification evidence is not bound to its mission')
    }
  }
}

function matchesFence(record: InMemoryMissionLeaseRecord, fence: MissionFence): boolean {
  try {
    return (
      OpaqueMissionFenceToken.isAuthentic(fence.token) &&
      record.organizationId === fence.organizationId &&
      record.missionId === fence.missionId &&
      record.ownerId === fence.ownerId &&
      record.epoch === fence.epoch &&
      record.tokenFingerprint !== null &&
      record.tokenFingerprint === fence.token.storageFingerprint()
    )
  } catch {
    return false
  }
}

function assertFenceIsLive(state: InMemoryState, fence: MissionFence, now: Date): void {
  const record = state.leases.get(fence.missionId)
  if (
    record === undefined ||
    !matchesFence(record, fence) ||
    record.releasedAt !== null ||
    Date.parse(record.expiresAt) <= now.getTime()
  ) {
    throw new LeaseLostError()
  }
}

function validateLeaseTtl(value: number): void {
  if (!Number.isInteger(value) || value < 1_000 || value > 5 * 60_000) {
    throw new RangeError('Mission lease TTL must be between one second and five minutes')
  }
}

function leaseSnapshot(record: InMemoryMissionLeaseRecord): InMemoryMissionLeaseSnapshot {
  return {
    organizationId: record.organizationId,
    missionId: record.missionId,
    ownerId: record.ownerId,
    epoch: record.epoch,
    acquiredAt: record.acquiredAt,
    renewedAt: record.renewedAt,
    expiresAt: record.expiresAt,
    releasedAt: record.releasedAt,
  }
}

function assertMissionScopedChanges(
  before: InMemoryState,
  after: InMemoryState,
  missionId: MissionId,
): void {
  const assertMission = (candidateMissionId: MissionId | string | undefined): void => {
    if (candidateMissionId !== missionId) {
      throw new ConflictError('Mission fence cannot authorize a mutation for another mission')
    }
  }
  const assertPlan = (planId: string): void => {
    const records = [before.plans.get(planId), after.plans.get(planId)].filter(
      (record) => record !== undefined,
    )
    if (records.length === 0) assertMission(undefined)
    records.forEach((record) => assertMission(record.missionId))
  }
  const assertOperation = (operationId: string): void => {
    const records = [before.operations.get(operationId), after.operations.get(operationId)].filter(
      (record) => record !== undefined,
    )
    if (records.length === 0) assertMission(undefined)
    records.forEach((record) => {
      assertMission(record.missionId)
      assertPlan(record.planId)
    })
  }
  const assertImmutable = <Value>(
    change: ChangedMapValue<Value>,
    keys: readonly (keyof Value)[],
  ): void => {
    if (change.before == null || change.after == null) return
    for (const key of keys) {
      if (change.before[key] !== change.after[key]) {
        throw new ConflictError(`Mission-scoped ${String(key)} references are immutable`)
      }
    }
  }

  changedMapEntries(before.missions, after.missions).forEach((change) => {
    assertImmutable(change, ['id'])
    changedRecords(change).forEach((record) => assertMission(record.id))
  })
  changedArrayValues(before.missionEvents, after.missionEvents).forEach((record) =>
    assertMission(record.missionId),
  )
  changedMapEntries(before.clarificationRequests, after.clarificationRequests).forEach((change) => {
    assertImmutable(change, ['id', 'missionId', 'organizationId'])
    changedRecords(change).forEach((record) => assertMission(record.missionId))
  })
  changedMapEntries(before.clarificationAnswers, after.clarificationAnswers).forEach((change) => {
    assertImmutable(change, ['id', 'requestId', 'missionId', 'organizationId'])
    changedRecords(change).forEach((record) => assertMission(record.missionId))
  })
  changedMapEntries(before.plans, after.plans).forEach((change) => {
    assertImmutable(change, ['id', 'missionId'])
    changedRecords(change).forEach((record) => assertMission(record.missionId))
  })
  changedMapEntries(before.approvals, after.approvals).forEach((change) => {
    assertImmutable(change, ['id', 'missionId', 'planId'])
    changedRecords(change).forEach((record) => {
      assertMission(record.missionId)
      assertPlan(record.planId)
    })
  })
  changedMapEntries(before.operations, after.operations).forEach((change) => {
    assertImmutable(change, ['id', 'missionId', 'planId', 'approvalId'])
    changedRecords(change).forEach((record) => {
      assertMission(record.missionId)
      assertPlan(record.planId)
    })
  })
  changedMapEntries(before.attempts, after.attempts).forEach((change) => {
    assertImmutable(change, ['id', 'operationId'])
    changedRecords(change).forEach((record) => assertOperation(record.operationId))
  })
  changedMapEntries(before.gatewayEffects, after.gatewayEffects).forEach((change) => {
    if (
      change.before !== undefined &&
      change.after !== undefined &&
      (JSON.stringify(change.before.command) !== JSON.stringify(change.after.command) ||
        change.before.dispatchAt !== change.after.dispatchAt ||
        change.before.milestone !== change.after.milestone ||
        change.before.cancellationPolicy !== change.after.cancellationPolicy ||
        JSON.stringify(change.before.authorization) !== JSON.stringify(change.after.authorization))
    ) {
      throw new ConflictError('Mission-scoped gateway effect intent is immutable')
    }
    changedRecords(change).forEach((record) => {
      assertMission(record.command.missionId)
      assertOperation(record.command.operationId)
    })
  })
  changedMapEntries(before.gatewayCallbacks, after.gatewayCallbacks).forEach((change) => {
    assertImmutable(change, ['id', 'missionId', 'operationId', 'commandId'])
    changedRecords(change).forEach((record) => {
      assertMission(record.missionId)
      assertOperation(record.operationId)
    })
  })
  changedMapEntries(before.executions, after.executions).forEach((change) => {
    assertImmutable(change, ['operationId'])
    changedRecords(change).forEach((record) => {
      assertMission(record.execution.missionId)
      assertOperation(record.operationId)
    })
  })
  changedMapValues(before.contextReceipts, after.contextReceipts).forEach((record) =>
    assertMission(record.missionId),
  )
  changedMapValues(before.evidence, after.evidence).forEach((record) =>
    assertMission(record.evidence.missionId),
  )
  changedMapValues(before.verifications, after.verifications).forEach((record) =>
    assertMission(record.missionId),
  )
  if (changedMapEntries(before.leases, after.leases).length > 0) {
    throw new ConflictError('Mission execution cannot mutate its own fence')
  }
  changedMapValues(before.cancellations, after.cancellations).forEach((record) =>
    assertMission(record.missionId),
  )
  changedMapEntries(before.compensatingPlans, after.compensatingPlans).forEach((change) => {
    assertImmutable(change, ['planId', 'compensatesOperationId'])
    changedRecords(change).forEach((record) => {
      assertPlan(record.planId)
      assertOperation(record.compensatesOperationId)
    })
  })
  changedMapValues(before.validations, after.validations).forEach((record) =>
    assertPlan(record.planId),
  )
  changedArrayValues(before.simulations, after.simulations).forEach((record) =>
    assertPlan(record.planId),
  )
  changedArrayValues(before.reconciliations, after.reconciliations).forEach((record) =>
    assertOperation(record.operationId),
  )
  changedMapEntries(before.caretakerRuns, after.caretakerRuns).forEach((change) => {
    assertImmutable(change, ['id', 'missionId', 'organizationId'])
    if (
      change.before !== undefined &&
      change.after !== undefined &&
      JSON.stringify(change.before.evidenceProfile) !== JSON.stringify(change.after.evidenceProfile)
    ) {
      throw new ConflictError('Caretaker evidence profile is immutable')
    }
    changedRecords(change).forEach((record) => assertMission(record.missionId))
  })
  changedMapValues(
    before.caretakerTerminalEvidenceDeliveries,
    after.caretakerTerminalEvidenceDeliveries,
  ).forEach((record) => assertMission(record.missionId))
  changedMapEntries(before.outbox, after.outbox).forEach((change) => {
    assertImmutable(change, ['id', 'organizationId', 'topic'])
    changedRecords(change).forEach((record) => {
      const payloadMissionId =
        typeof record.payload.missionId === 'string' ? record.payload.missionId : undefined
      const operationId =
        typeof record.payload.operationId === 'string' ? record.payload.operationId : undefined
      if (record.payload.organizationId !== record.organizationId) {
        throw new ConflictError('Mission-scoped outbox tenant reference is invalid')
      }
      if (payloadMissionId !== undefined) assertMission(payloadMissionId)
      if (operationId !== undefined) assertOperation(operationId)
      if (
        (record.topic === 'mission.resume' || record.topic === 'mission.verify') &&
        payloadMissionId === undefined
      ) {
        throw new ConflictError('Mission outbox payload requires a missionId')
      }
      if (
        (record.topic === 'gateway.dispatch' ||
          record.topic === 'gateway.effect.reconcile' ||
          record.topic === 'execution.deadline' ||
          record.topic === 'operation.reconcile') &&
        operationId === undefined
      ) {
        throw new ConflictError('Operation outbox payload requires an operationId')
      }
      if (record.topic === 'execution.deadline' && payloadMissionId === undefined) {
        throw new ConflictError('Execution deadline outbox requires mission and operation IDs')
      }
    })
  })

  const authorizedRoutineIds = new Set<string>()
  for (const plan of [...before.plans.values(), ...after.plans.values()]) {
    if (plan.missionId !== missionId) continue
    for (const action of plan.actions) {
      if (isRoutineReplacementAction(action)) {
        authorizedRoutineIds.add(action.protectedRoutineId)
        authorizedRoutineIds.add(action.replacementRoutineId)
      } else {
        authorizedRoutineIds.add(action.routineId)
      }
    }
  }
  const assertRoutine = (routineId: string): void => {
    if (!authorizedRoutineIds.has(routineId)) {
      throw new ConflictError("Mission fence cannot authorize another mission's routine mutation")
    }
  }
  changedMapValues(before.routineVersions, after.routineVersions).forEach((record) =>
    assertRoutine(record.routineId),
  )
  changedMapValues(before.routineRecords, after.routineRecords).forEach((record) =>
    assertRoutine(record.id),
  )
  changedMapValues(before.routineVersionRecords, after.routineVersionRecords).forEach((record) =>
    assertRoutine(record.routineId),
  )
}

interface ChangedMapValue<Value> {
  readonly before: Value | undefined
  readonly after: Value | undefined
}

function changedMapEntries<Value>(
  before: Map<string, Value>,
  after: Map<string, Value>,
): ChangedMapValue<Value>[] {
  const changed: ChangedMapValue<Value>[] = []
  const keys = new Set([...before.keys(), ...after.keys()])
  for (const key of keys) {
    const previous = before.get(key)
    const next = after.get(key)
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changed.push({ before: previous, after: next })
    }
  }
  return changed
}

function changedRecords<Value>(change: ChangedMapValue<Value>): Value[] {
  return [change.before, change.after].filter((record) => record !== undefined)
}

function changedMapValues<Value>(before: Map<string, Value>, after: Map<string, Value>): Value[] {
  return changedMapEntries(before, after).flatMap(changedRecords)
}

function changedArrayValues<Value>(before: readonly Value[], after: readonly Value[]): Value[] {
  const remaining = new Map<string, number>()
  for (const value of before) {
    const key = JSON.stringify(value)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  const changed: Value[] = []
  for (const value of after) {
    const key = JSON.stringify(value)
    const count = remaining.get(key) ?? 0
    if (count === 0) changed.push(value)
    else remaining.set(key, count - 1)
  }
  return changed
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneState(state: InMemoryState): InMemoryState {
  return {
    palaces: cloneMap(state.palaces),
    crewMembers: cloneMap(state.crewMembers),
    identityTags: cloneMap(state.identityTags),
    crewSchedules: cloneMap(state.crewSchedules),
    crewPreferences: cloneMap(state.crewPreferences),
    devices: cloneMap(state.devices),
    capabilities: cloneMap(state.capabilities),
    missions: cloneMap(state.missions),
    missionEvents: clone(state.missionEvents),
    clarificationRequests: cloneMap(state.clarificationRequests),
    clarificationAnswers: cloneMap(state.clarificationAnswers),
    plans: cloneMap(state.plans),
    approvals: cloneMap(state.approvals),
    operations: cloneMap(state.operations),
    attempts: cloneMap(state.attempts),
    routineVersions: cloneMap(state.routineVersions),
    routineRecords: cloneMap(state.routineRecords),
    routineVersionRecords: cloneMap(state.routineVersionRecords),
    outbox: cloneMap(state.outbox),
    gatewayEffects: cloneMap(state.gatewayEffects),
    gatewayCallbacks: cloneMap(state.gatewayCallbacks),
    executions: cloneMap(state.executions),
    contextReceipts: cloneMap(state.contextReceipts),
    evidence: cloneMap(state.evidence),
    verifications: cloneMap(state.verifications),
    leases: cloneMap(state.leases),
    cancellations: cloneMap(state.cancellations),
    compensatingPlans: cloneMap(state.compensatingPlans),
    validations: cloneMap(state.validations),
    simulations: clone(state.simulations),
    reconciliations: clone(state.reconciliations),
    caretakerRuns: cloneMap(state.caretakerRuns),
    caretakerRunCheckpoints: new Map(
      [...state.caretakerRunCheckpoints].map(([runId, checkpoints]) => [runId, clone(checkpoints)]),
    ),
    caretakerTerminalEvidenceDeliveries: cloneMap(state.caretakerTerminalEvidenceDeliveries),
    productEvidenceDeliveries: cloneMap(state.productEvidenceDeliveries),
    taskLedgerVersions: cloneMap(state.taskLedgerVersions),
  }
}

function cloneMap<Value>(map: Map<string, Value>): Map<string, Value> {
  return new Map([...map.entries()].map(([key, value]) => [key, clone(value)]))
}

function snapshot(state: InMemoryState): InMemorySnapshot {
  return {
    palaces: clone([...state.palaces.values()]),
    crewMembers: clone([...state.crewMembers.values()]),
    identityTags: clone([...state.identityTags.values()]),
    crewSchedules: clone([...state.crewSchedules.values()]),
    crewPreferences: clone([...state.crewPreferences.values()]),
    devices: clone([...state.devices.values()]),
    capabilities: clone([...state.capabilities.values()]),
    missions: clone([...state.missions.values()]),
    missionEvents: clone(state.missionEvents),
    clarificationRequests: clone([...state.clarificationRequests.values()]),
    clarificationAnswers: clone([...state.clarificationAnswers.values()]),
    plans: clone([...state.plans.values()]),
    approvals: clone([...state.approvals.values()]),
    operations: clone([...state.operations.values()]),
    attempts: clone([...state.attempts.values()]),
    routineVersions: clone([...state.routineVersions.values()]),
    routines: clone([...state.routineRecords.values()]),
    routineVersionRecords: clone([...state.routineVersionRecords.values()]),
    outbox: clone([...state.outbox.values()]),
    gatewayEffects: clone([...state.gatewayEffects.values()]),
    gatewayCallbacks: clone([...state.gatewayCallbacks.values()]),
    executions: clone([...state.executions.values()]),
    contextReceipts: clone([...state.contextReceipts.values()]),
    evidence: clone([...state.evidence.values()]),
    verifications: clone([...state.verifications.values()]),
    leases: [...state.leases.values()].map((record) => clone(leaseSnapshot(record))),
    cancellations: clone([...state.cancellations.values()]),
    compensatingPlans: clone([...state.compensatingPlans.values()]),
    validations: clone([...state.validations.values()]),
    simulations: clone(state.simulations),
    reconciliations: clone(state.reconciliations),
    caretakerRuns: clone([...state.caretakerRuns.values()]),
    caretakerRunCheckpoints: clone([...state.caretakerRunCheckpoints.values()].flat()),
    caretakerTerminalEvidenceDeliveries: clone([
      ...state.caretakerTerminalEvidenceDeliveries.values(),
    ]),
    productEvidenceDeliveries: clone([...state.productEvidenceDeliveries.values()]),
  }
}
