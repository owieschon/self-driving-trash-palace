import {
  ClarificationChoiceSchema,
  ClarificationRequestSchema,
  ContextReceiptSchema,
  IsoDateTimeSchema,
  MissionSchema,
  RunIdSchema,
  Sha256Schema,
  TOOL_REGISTRY_HASH,
  hashToolValue,
  type ClarificationChoice,
  type ContextReceipt,
  type Mission,
  type RunId,
} from '@trash-palace/core'
import {
  assertMissionExecutionContext,
  type CaretakerRunSnapshot,
  type ClarificationService,
  type MissionExecutionContext,
  type MissionExecutionUnitOfWorkPort,
  type MissionRunnerPort,
} from '@trash-palace/application'

import {
  type CaretakerHostResult,
  type CaretakerHumanPausePort,
  type CaretakerLifecycleHost,
} from './caretaker-host.js'
import { contextBundleHashForReceipt } from './caretaker-context.js'
import { hashHostPolicyContract } from './host-policy.js'

type HostClarificationInput = Parameters<CaretakerHumanPausePort['requestClarification']>[0]

const TERMINAL_ACTIVATION_RETRY_DELAYS_MILLISECONDS = Object.freeze([
  10, 25, 50, 100, 250, 500,
] as const)

export class CaretakerWorkerAdapterIntegrityError extends Error {
  public override readonly name = 'CaretakerWorkerAdapterIntegrityError'
}

/**
 * Re-drives a terminal activation after the database transaction retry budget is exhausted.
 * The caller must retain the same durable run and activation identities across every attempt.
 */
export async function runTerminalCaretakerActivationWithRetry<Result>(
  operation: () => Promise<Result>,
  signal: AbortSignal,
  wait: (delayMilliseconds: number, signal: AbortSignal) => Promise<void> = waitForRetry,
): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      const delay = TERMINAL_ACTIVATION_RETRY_DELAYS_MILLISECONDS[attempt]
      if (delay === undefined || !isOptimisticConcurrencyFailure(error)) throw error
      await wait(delay, signal)
    }
  }
}

/**
 * Owns compilation and atomic persistence of the run-bound rich context artifacts, core receipt,
 * and mission receipt reference. Implementations must be idempotent for the candidate run.
 */
export interface CaretakerContextPreparationPort {
  ensureFrozen(input: {
    readonly context: MissionExecutionContext
    readonly mission: Mission
    readonly runId: RunId
    readonly referenceTime: string
    readonly signal: AbortSignal
  }): Promise<void>
}

export interface CaretakerMissionRunnerAdapterDependencies {
  readonly unitOfWork: MissionExecutionUnitOfWorkPort
  readonly contextPreparation: CaretakerContextPreparationPort
  readonly host: Pick<CaretakerLifecycleHost, 'resume'>
}

type RunnerState = Readonly<{
  mission: Mission
  latestRun: CaretakerRunSnapshot | null
  checkpoints: CaretakerRunSnapshot['checkpoint'][]
  contextReceipt: ContextReceipt | null
}>

/** Runs one bounded host activation and returns control to the worker after the first outcome. */
export class CaretakerMissionRunnerAdapter implements MissionRunnerPort {
  public constructor(private readonly dependencies: CaretakerMissionRunnerAdapterDependencies) {}

  public async resume(input: {
    readonly mission: Mission
    readonly context: MissionExecutionContext
  }): Promise<'completed_checkpoint' | 'paused' | 'retry'> {
    input.context.signal.throwIfAborted()
    const acquiredMission = MissionSchema.parse(input.mission)
    assertMissionExecutionContext(input.context, {
      organizationId: acquiredMission.organizationId,
      missionId: acquiredMission.id,
    })
    if (input.context.principal.role !== 'service') {
      throw integrity('Caretaker worker activation requires a service principal')
    }

    const before = await loadRunnerState(
      this.dependencies.unitOfWork,
      input.context,
      acquiredMission.id,
    )
    assertAcquiredMissionBinding(acquiredMission, before.mission)
    const runId = candidateRunId(before)
    if (before.latestRun !== null && before.latestRun.run.id === runId) {
      requirePreparedContext(before, runId)
    }
    const activationKey = activationKeyFor({
      organizationId: before.mission.organizationId,
      missionId: before.mission.id,
      runId,
      leaseEpoch: input.context.fence.epoch,
    })
    const referenceTime = latestIso([
      before.mission.updatedAt,
      before.latestRun?.run.updatedAt,
      before.latestRun?.checkpoint.occurredAt,
    ])

    await this.dependencies.contextPreparation.ensureFrozen({
      context: input.context,
      mission: before.mission,
      runId,
      referenceTime,
      signal: input.context.signal,
    })
    input.context.signal.throwIfAborted()

    const prepared = await loadRunnerState(
      this.dependencies.unitOfWork,
      input.context,
      before.mission.id,
    )
    assertPreparationBoundary({ before, prepared, runId })
    const receipt = requirePreparedContext(prepared, runId)
    const replay = prepared.checkpoints.filter(
      (checkpoint) => checkpoint.mutationKey === activationKey,
    )
    if (replay.length > 1) {
      throw integrity('Caretaker activation identity appears in more than one checkpoint')
    }
    if (
      prepared.latestRun?.run.status === 'active' &&
      prepared.latestRun.run.leaseEpoch === input.context.fence.epoch &&
      replay.length === 0
    ) {
      throw integrity('The current lease epoch is bound to another activation identity')
    }
    const activatedAt =
      replay[0]?.occurredAt ??
      latestIso([
        prepared.mission.updatedAt,
        receipt.createdAt,
        prepared.latestRun?.run.updatedAt,
        prepared.latestRun?.checkpoint.occurredAt,
      ])

    const activation = {
      context: input.context,
      requestedRunId: runId,
      missionId: prepared.mission.id,
      activationKey,
      activatedAt,
    }
    const resumeHost = () => this.dependencies.host.resume(activation)
    const result = isTerminalMission(prepared.mission)
      ? await runTerminalCaretakerActivationWithRetry(resumeHost, input.context.signal)
      : await resumeHost()
    input.context.signal.throwIfAborted()
    if (result.runId !== runId) {
      throw integrity('Caretaker host returned another durable run identity')
    }
    return mapHostResult(result)
  }
}

function isTerminalMission(mission: Mission): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(mission.state.status)
}

function isOptimisticConcurrencyFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'OptimisticConcurrencyError'
}

function waitForRetry(delayMilliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, delayMilliseconds)
    signal.addEventListener('abort', abort, { once: true })

    function finish(): void {
      signal.removeEventListener('abort', abort)
      resolve()
    }

    function abort(): void {
      clearTimeout(timeout)
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Caretaker activation aborted'),
      )
    }
  })
}

export interface CaretakerClarificationChoiceProjectorPort {
  project(input: {
    readonly materialField: string
    readonly question: string
    readonly choices: HostClarificationInput['choices']
    readonly signal: AbortSignal
  }): Promise<readonly ClarificationChoice[]>
}

export interface StaticCaretakerClarificationChoiceDescription {
  readonly materialField: string
  readonly choiceId: string
  readonly label: string
  readonly description: string
}

/** Projects only explicitly authored descriptions; it never manufactures clarification copy. */
export class StaticCaretakerClarificationChoiceProjector implements CaretakerClarificationChoiceProjectorPort {
  readonly #entries = new Map<string, ClarificationChoice>()

  public constructor(entries: readonly StaticCaretakerClarificationChoiceDescription[]) {
    for (const entry of entries) {
      const choice = ClarificationChoiceSchema.parse({
        id: entry.choiceId,
        label: entry.label,
        description: entry.description,
      })
      const key = clarificationChoiceKey(entry.materialField, choice.id)
      if (this.#entries.has(key)) {
        throw new CaretakerWorkerAdapterIntegrityError(
          'Static clarification descriptions must have unique field and choice bindings',
        )
      }
      this.#entries.set(key, choice)
    }
  }

  public project(input: {
    readonly materialField: string
    readonly question: string
    readonly choices: HostClarificationInput['choices']
    readonly signal: AbortSignal
  }): Promise<readonly ClarificationChoice[]> {
    input.signal.throwIfAborted()
    return Promise.resolve(
      input.choices.map((hostChoice) => {
        const authored = this.#entries.get(
          clarificationChoiceKey(input.materialField, hostChoice.id),
        )
        if (authored === undefined || authored.label !== hostChoice.label) {
          throw integrity('Clarification choice lacks its exact authored description binding')
        }
        return authored
      }),
    )
  }
}

export interface ClarificationCaretakerHumanPausePortDependencies {
  readonly unitOfWork: MissionExecutionUnitOfWorkPort
  readonly clarifications: Pick<ClarificationService, 'request'>
  readonly choices: CaretakerClarificationChoiceProjectorPort
}

/** Persists an exact host-projected material question through the application service. */
export class ClarificationCaretakerHumanPausePort implements CaretakerHumanPausePort {
  public constructor(
    private readonly dependencies: ClarificationCaretakerHumanPausePortDependencies,
  ) {}

  public async requestClarification(input: HostClarificationInput): Promise<void> {
    input.signal.throwIfAborted()
    assertMissionExecutionContext(input.context, {
      organizationId: input.context.principal.organizationId,
      missionId: input.missionId,
    })
    const mission = await this.dependencies.unitOfWork.runFenced(
      input.context.fence,
      async (repositories) => repositories.missions.get(input.missionId),
    )
    if (
      mission === null ||
      mission.organizationId !== input.context.principal.organizationId ||
      mission.runId !== input.runId ||
      !(
        (mission.state.status === 'running' && mission.state.phase === 'plan') ||
        (mission.state.status === 'waiting_for_user' && mission.state.phase === 'plan')
      )
    ) {
      throw integrity('Clarification request is outside its fenced plan checkpoint')
    }

    const hostChoices = Object.freeze(
      input.choices.map((choice) => Object.freeze({ id: choice.id, label: choice.label })),
    )
    const evidenceIds = Object.freeze([...input.evidenceIds])
    const projectedChoices = await this.dependencies.choices.project({
      materialField: input.materialField,
      question: input.question,
      choices: hostChoices,
      signal: input.signal,
    })
    input.signal.throwIfAborted()
    assertProjectedChoices(hostChoices, projectedChoices)
    const idempotencyKey = Sha256Schema.parse(
      hashToolValue({
        schemaVersion: 'caretaker-clarification-request-key@1',
        missionId: input.missionId,
        runId: input.runId,
        materialField: input.materialField,
        question: input.question,
        choices: projectedChoices,
        evidenceIds,
      }),
    )
    const result = await this.dependencies.clarifications.request({
      context: input.context,
      missionId: input.missionId,
      expectedMissionVersion: mission.version,
      idempotencyKey,
      question: input.question,
      choices: projectedChoices,
      evidenceRefs: evidenceIds,
    })
    input.signal.throwIfAborted()
    assertClarificationResult({
      result,
      mission,
      runId: input.runId,
      idempotencyKey,
      question: input.question,
      choices: projectedChoices,
      evidenceIds,
      actorId: input.context.principal.actorId,
    })
  }
}

async function loadRunnerState(
  unitOfWork: MissionExecutionUnitOfWorkPort,
  context: MissionExecutionContext,
  missionId: Mission['id'],
): Promise<RunnerState> {
  context.signal.throwIfAborted()
  return unitOfWork.runFenced(context.fence, async (repositories) => {
    const mission = await repositories.missions.get(missionId)
    if (mission === null) throw integrity('Caretaker worker mission is absent')
    const latestRun = await repositories.caretakerRuns.getLatestForMission(missionId)
    if (
      (mission.runId === null) !== (latestRun === null) ||
      (latestRun !== null &&
        (mission.runId !== latestRun.run.id ||
          latestRun.run.organizationId !== mission.organizationId ||
          latestRun.run.missionId !== mission.id ||
          latestRun.checkpoint.runId !== latestRun.run.id))
    ) {
      throw integrity('Mission and latest Caretaker run identities disagree')
    }
    const checkpoints =
      latestRun === null ? [] : await repositories.caretakerRuns.listCheckpoints(latestRun.run.id)
    const contextReceipt =
      mission.contextReceiptId === null
        ? null
        : await repositories.contextReceipts.get(mission.contextReceiptId)
    return { mission, latestRun, checkpoints: [...checkpoints], contextReceipt }
  })
}

function candidateRunId(state: RunnerState): RunId {
  const terminalMission = ['succeeded', 'failed', 'cancelled'].includes(state.mission.state.status)
  if (state.latestRun !== null && (state.latestRun.run.status !== 'paused' || terminalMission)) {
    return state.latestRun.run.id
  }
  if (state.latestRun?.checkpoint.kind === 'budget_exhausted') {
    throw integrity('A budget-exhausted activation lacks explicit successor authorization')
  }
  const digest = hashToolValue({
    schemaVersion: 'caretaker-worker-run-identity@1',
    organizationId: state.mission.organizationId,
    missionId: state.mission.id,
    predecessorRunId: state.latestRun?.run.id ?? null,
  })
  return RunIdSchema.parse(`run_${digest.slice(0, 32)}`)
}

function activationKeyFor(input: {
  readonly organizationId: Mission['organizationId']
  readonly missionId: Mission['id']
  readonly runId: RunId
  readonly leaseEpoch: number
}) {
  return Sha256Schema.parse(
    hashToolValue({ schemaVersion: 'caretaker-worker-activation-key@1', ...input }),
  )
}

function assertAcquiredMissionBinding(acquired: Mission, durable: Mission): void {
  if (
    acquired.id !== durable.id ||
    acquired.organizationId !== durable.organizationId ||
    acquired.palaceId !== durable.palaceId ||
    acquired.version > durable.version ||
    hashToolValue({
      objective: acquired.objective,
      constraints: acquired.constraints,
      successCriteriaIds: acquired.successCriteriaIds,
      createdAt: acquired.createdAt,
    }) !==
      hashToolValue({
        objective: durable.objective,
        constraints: durable.constraints,
        successCriteriaIds: durable.successCriteriaIds,
        createdAt: durable.createdAt,
      })
  ) {
    throw integrity('Acquired mission does not bind the fenced durable mission')
  }
}

function assertPreparationBoundary(input: {
  readonly before: RunnerState
  readonly prepared: RunnerState
  readonly runId: RunId
}): void {
  const { before, prepared } = input
  const existingRunContextChanged =
    before.latestRun !== null &&
    before.latestRun.run.status !== 'paused' &&
    (prepared.mission.version !== before.mission.version ||
      prepared.mission.contextReceiptId !== before.mission.contextReceiptId)
  if (
    existingRunContextChanged ||
    prepared.mission.id !== before.mission.id ||
    prepared.mission.organizationId !== before.mission.organizationId ||
    prepared.mission.palaceId !== before.mission.palaceId ||
    prepared.mission.runId !== before.mission.runId ||
    prepared.mission.version < before.mission.version ||
    prepared.mission.version > before.mission.version + 1 ||
    prepared.mission.state.status !== before.mission.state.status ||
    prepared.mission.state.phase !== before.mission.state.phase ||
    hashToolValue(prepared.mission.taskLedger) !== hashToolValue(before.mission.taskLedger) ||
    hashToolValue({
      objective: prepared.mission.objective,
      constraints: prepared.mission.constraints,
      successCriteriaIds: prepared.mission.successCriteriaIds,
      createdAt: prepared.mission.createdAt,
    }) !==
      hashToolValue({
        objective: before.mission.objective,
        constraints: before.mission.constraints,
        successCriteriaIds: before.mission.successCriteriaIds,
        createdAt: before.mission.createdAt,
      }) ||
    hashToolValue(projectRunIdentity(prepared.latestRun)) !==
      hashToolValue(projectRunIdentity(before.latestRun))
  ) {
    throw integrity('Context preparation mutated state outside its receipt boundary')
  }
  if (prepared.latestRun?.run.status === 'active' && prepared.latestRun.run.id !== input.runId) {
    throw integrity('Prepared context targets a different active Caretaker run')
  }
}

function projectRunIdentity(snapshot: CaretakerRunSnapshot | null) {
  return snapshot === null
    ? null
    : {
        id: snapshot.run.id,
        organizationId: snapshot.run.organizationId,
        missionId: snapshot.run.missionId,
        status: snapshot.run.status,
        leaseEpoch: snapshot.run.leaseEpoch,
        version: snapshot.run.version,
        checkpointSequence: snapshot.checkpoint.sequence,
      }
}

function requirePreparedContext(state: RunnerState, runId: RunId): ContextReceipt {
  if (state.mission.contextReceiptId === null || state.contextReceipt === null) {
    throw integrity('Caretaker context preparation did not persist a frozen receipt')
  }
  const receipt = ContextReceiptSchema.parse(state.contextReceipt)
  if (
    receipt.id !== state.mission.contextReceiptId ||
    receipt.organizationId !== state.mission.organizationId ||
    receipt.missionId !== state.mission.id ||
    receipt.runId !== runId ||
    receipt.policyHash !== hashHostPolicyContract() ||
    receipt.toolRegistryHash !== TOOL_REGISTRY_HASH ||
    Date.parse(receipt.createdAt) < Date.parse(state.mission.createdAt)
  ) {
    throw integrity('Frozen context receipt does not bind the candidate Caretaker run')
  }
  contextBundleHashForReceipt(receipt)
  return receipt
}

function mapHostResult(result: CaretakerHostResult): 'completed_checkpoint' | 'paused' | 'retry' {
  switch (result.kind) {
    case 'retry':
      return 'retry'
    case 'paused':
      return 'paused'
    case 'cancelled':
    case 'completed':
    case 'failed':
      return 'completed_checkpoint'
  }
}

function assertProjectedChoices(
  hostChoices: HostClarificationInput['choices'],
  projectedInput: readonly ClarificationChoice[],
): void {
  const projected = projectedInput.map((choice) => ClarificationChoiceSchema.parse(choice))
  if (
    projected.length !== hostChoices.length ||
    projected.some((choice, index) => {
      const hostChoice = hostChoices[index]
      return (
        hostChoice === undefined || choice.id !== hostChoice.id || choice.label !== hostChoice.label
      )
    })
  ) {
    throw integrity('Clarification choice projection changed an ID, label, or ordering')
  }
}

function assertClarificationResult(input: {
  readonly result: Awaited<ReturnType<ClarificationService['request']>>
  readonly mission: Mission
  readonly runId: RunId
  readonly idempotencyKey: ReturnType<typeof Sha256Schema.parse>
  readonly question: string
  readonly choices: readonly ClarificationChoice[]
  readonly evidenceIds: HostClarificationInput['evidenceIds']
  readonly actorId: MissionExecutionContext['principal']['actorId']
}): void {
  const request = ClarificationRequestSchema.parse(input.result.request)
  const mission = MissionSchema.parse(input.result.mission)
  if (
    request.organizationId !== input.mission.organizationId ||
    request.missionId !== input.mission.id ||
    request.requestedBy !== input.actorId ||
    request.idempotencyKey !== input.idempotencyKey ||
    request.status !== 'pending' ||
    request.question !== input.question ||
    hashToolValue(request.choices) !== hashToolValue(input.choices) ||
    hashToolValue(request.evidenceRefs) !== hashToolValue(input.evidenceIds) ||
    mission.id !== input.mission.id ||
    mission.organizationId !== input.mission.organizationId ||
    mission.runId !== input.runId ||
    mission.palaceId !== input.mission.palaceId ||
    mission.contextReceiptId !== input.mission.contextReceiptId ||
    hashToolValue(mission.taskLedger) !== hashToolValue(input.mission.taskLedger) ||
    hashToolValue({
      objective: mission.objective,
      constraints: mission.constraints,
      successCriteriaIds: mission.successCriteriaIds,
      createdAt: mission.createdAt,
    }) !==
      hashToolValue({
        objective: input.mission.objective,
        constraints: input.mission.constraints,
        successCriteriaIds: input.mission.successCriteriaIds,
        createdAt: input.mission.createdAt,
      }) ||
    mission.version < input.mission.version ||
    mission.version > input.mission.version + 1 ||
    mission.state.status !== 'waiting_for_user' ||
    mission.state.phase !== 'plan'
  ) {
    throw integrity('Clarification service returned a mismatched durable pause')
  }
}

function clarificationChoiceKey(materialField: string, choiceId: string): string {
  return `${materialField}\u0000${choiceId}`
}

function latestIso(values: readonly (string | undefined)[]): string {
  const present = values.filter((value): value is string => value !== undefined)
  if (present.length === 0) throw integrity('Caretaker activation lacks a durable timestamp')
  return IsoDateTimeSchema.parse(
    present.reduce((latest, candidate) =>
      Date.parse(candidate) > Date.parse(latest) ? candidate : latest,
    ),
  )
}

function integrity(message: string): CaretakerWorkerAdapterIntegrityError {
  return new CaretakerWorkerAdapterIntegrityError(message)
}
