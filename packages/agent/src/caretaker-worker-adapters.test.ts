import {
  ClarificationRequestIdSchema,
  ClarificationRequestSchema,
  ContextReceiptIdSchema,
  ContextReceiptSchema,
  EvidenceIdSchema,
  MissionIdSchema,
  MissionSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PrincipalSchema,
  RunIdSchema,
  TOOL_REGISTRY_HASH,
  UserIdSchema,
  computeClarificationRequestPayloadHash,
  hashToolValue,
  type ClarificationRequest,
  type ContextReceipt,
  type Mission,
  type RunId,
} from '@trash-palace/core'
import {
  CaretakerRunCheckpointSchema,
  CaretakerRunRecordSchema,
  OpaqueMissionFenceToken,
  hashCaretakerTaskLedger,
  type CaretakerRunSnapshot,
  type MissionExecutionContext,
  type MissionExecutionUnitOfWorkPort,
  type TenantRepositories,
} from '@trash-palace/application'
import { testCaretakerEvidenceProfile } from '@trash-palace/application/testing'
import { describe, expect, it, vi } from 'vitest'

import {
  CaretakerMissionRunnerAdapter,
  ClarificationCaretakerHumanPausePort,
  StaticCaretakerClarificationChoiceProjector,
  type CaretakerContextPreparationPort,
} from './caretaker-worker-adapters.js'
import { hashHostPolicyContract } from './host-policy.js'

const NOW = '2026-08-14T05:35:00.000Z'
const LATER = '2026-08-14T05:36:00.000Z'
const IDS = {
  organization: OrganizationIdSchema.parse('org_workeradapter1'),
  mission: MissionIdSchema.parse('mis_workeradapter1'),
  palace: PalaceIdSchema.parse('pal_workeradapter1'),
  owner: UserIdSchema.parse('usr_workerowner01'),
  service: UserIdSchema.parse('usr_workerservice1'),
  priorRun: RunIdSchema.parse('run_workerprevious1'),
  evidence: EvidenceIdSchema.parse('evd_workerclarify1'),
} as const

const ENERGY_DESCRIPTION =
  'Keep projected battery use below the current mission limit, even if preheating starts later.'
const COMFORT_DESCRIPTION =
  'Reach the requested temperature by arrival while retaining every lock and identity invariant.'

describe('CaretakerMissionRunnerAdapter', () => {
  it('freezes context before a deterministic first activation and returns retry without looping', async () => {
    const world = new WorkerAdapterWorld()
    const calls: Parameters<
      ConstructorParameters<typeof CaretakerMissionRunnerAdapter>[0]['host']['resume']
    >[0][] = []
    const runner = world.runner(async (input) => {
      calls.push(input)
      return {
        kind: 'retry',
        runId: RunIdSchema.parse(input.requestedRunId),
        runVersion: 0,
        reason: 'tool_pending',
      }
    })

    await expect(runner.resume({ mission: world.mission, context: world.context })).resolves.toBe(
      'retry',
    )
    await expect(runner.resume({ mission: world.mission, context: world.context })).resolves.toBe(
      'retry',
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.requestedRunId).toBe(calls[1]?.requestedRunId)
    expect(calls[0]?.activationKey).toBe(calls[1]?.activationKey)
    expect(calls[0]?.activatedAt).toBe(calls[1]?.activatedAt)
    expect(world.contextReceipt?.runId).toBe(calls[0]?.requestedRunId)
    expect(calls[0]?.context).toBe(world.context)
  })

  it('keeps an active run identity and derives a stable successor for a paused run', async () => {
    const active = new WorkerAdapterWorld()
    active.installRun('active')
    active.freeze(IDS.priorRun)
    const activeCalls: string[] = []
    const activeRunner = active.runner(async (input) => {
      activeCalls.push(input.requestedRunId)
      return {
        kind: 'paused',
        runId: RunIdSchema.parse(input.requestedRunId),
        runVersion: 3,
        reason: 'approval',
      }
    })
    await expect(
      activeRunner.resume({ mission: active.mission, context: active.context }),
    ).resolves.toBe('paused')
    expect(activeCalls).toEqual([IDS.priorRun])

    const paused = new WorkerAdapterWorld()
    paused.installRun('paused')
    paused.freeze(IDS.priorRun)
    const pausedCalls: string[] = []
    const pausedRunner = paused.runner(async (input) => {
      pausedCalls.push(input.requestedRunId)
      return {
        kind: 'failed',
        runId: RunIdSchema.parse(input.requestedRunId),
        runVersion: 1,
        reason: 'safe_refusal',
      }
    })
    await expect(
      pausedRunner.resume({ mission: paused.mission, context: paused.context }),
    ).resolves.toBe('completed_checkpoint')
    expect(pausedCalls[0]).not.toBe(IDS.priorRun)
    expect(paused.contextReceipt?.runId).toBe(pausedCalls[0])
  })

  it('reuses a paused canonical run when a terminal mission needs its final checkpoint', async () => {
    const world = new WorkerAdapterWorld()
    world.installRun('paused', 'reconcile')
    world.freeze(IDS.priorRun)
    world.mission = MissionSchema.parse({
      ...world.mission,
      state: { status: 'succeeded', phase: 'verify' },
      version: world.mission.version + 1,
      updatedAt: LATER,
    })
    const calls: string[] = []
    const runner = world.runner(async (input) => {
      calls.push(input.requestedRunId)
      return {
        kind: 'completed',
        runId: RunIdSchema.parse(input.requestedRunId),
        runVersion: 10,
        verifierEvidenceIds: [IDS.evidence],
      }
    })

    await expect(runner.resume({ mission: world.mission, context: world.context })).resolves.toBe(
      'completed_checkpoint',
    )
    expect(calls).toEqual([IDS.priorRun])
    expect(world.contextReceipt?.runId).toBe(IDS.priorRun)
  })

  it('maps every durable terminal host result to a completed worker checkpoint', async () => {
    const results = ['completed', 'failed', 'cancelled'] as const
    for (const kind of results) {
      const world = new WorkerAdapterWorld()
      const runner = world.runner(async (input) => {
        const runId = RunIdSchema.parse(input.requestedRunId)
        if (kind === 'completed') {
          return { kind, runId, runVersion: 2, verifierEvidenceIds: [IDS.evidence] }
        }
        if (kind === 'cancelled') return { kind, runId, runVersion: 2 }
        return { kind, runId, runVersion: 2, reason: 'mission_failed' }
      })
      await expect(runner.resume({ mission: world.mission, context: world.context })).resolves.toBe(
        'completed_checkpoint',
      )
    }
  })

  it('fails closed when context preparation omits the receipt or mutates mission state', async () => {
    const missing = new WorkerAdapterWorld()
    const host = vi.fn(async () => {
      throw new Error('host must not run')
    })
    const missingRunner = new CaretakerMissionRunnerAdapter({
      unitOfWork: missing,
      contextPreparation: { ensureFrozen: async () => undefined },
      host: { resume: host },
    })
    await expect(
      missingRunner.resume({ mission: missing.mission, context: missing.context }),
    ).rejects.toThrow(/did not persist/)
    expect(host).not.toHaveBeenCalled()

    const mutated = new WorkerAdapterWorld()
    const mutatedRunner = new CaretakerMissionRunnerAdapter({
      unitOfWork: mutated,
      contextPreparation: {
        ensureFrozen: async ({ runId }) => {
          mutated.freeze(runId)
          mutated.mission = MissionSchema.parse({
            ...mutated.mission,
            state: { status: 'running', phase: 'plan' },
          })
        },
      },
      host: { resume: host },
    })
    await expect(
      mutatedRunner.resume({ mission: mutated.mission, context: mutated.context }),
    ).rejects.toThrow(/outside its receipt boundary/)
    expect(host).not.toHaveBeenCalled()
  })
})

describe('ClarificationCaretakerHumanPausePort', () => {
  it('persists canonical authored descriptions and replays one deterministic request', async () => {
    const world = new WorkerAdapterWorld()
    world.installRun('active', 'plan')
    const projector = canonicalProjector()
    let retained: ClarificationRequest | null = null
    const keys: string[] = []
    const service = {
      request: async (
        input: Parameters<
          ClarificationCaretakerHumanPausePortDependencies['clarifications']['request']
        >[0],
      ) => {
        keys.push(input.idempotencyKey)
        if (retained === null) {
          const payload = {
            organizationId: IDS.organization,
            missionId: IDS.mission,
            requestedBy: IDS.service,
            question: input.question,
            choices: input.choices,
            evidenceRefs: input.evidenceRefs,
          }
          retained = ClarificationRequestSchema.parse({
            schemaVersion: 'clarification-request@1',
            ...payload,
            id: ClarificationRequestIdSchema.parse('clr_workerrequest1'),
            idempotencyKey: input.idempotencyKey,
            payloadHash: computeClarificationRequestPayloadHash(payload),
            status: 'pending',
            requestedAt: NOW,
            resolvedAt: null,
          })
          world.mission = MissionSchema.parse({
            ...world.mission,
            state: { status: 'waiting_for_user', phase: 'plan' },
            version: world.mission.version + 1,
            updatedAt: LATER,
          })
          return { kind: 'created' as const, request: retained, mission: world.mission }
        }
        return { kind: 'replayed' as const, request: retained, mission: world.mission }
      },
    }
    const port = new ClarificationCaretakerHumanPausePort({
      unitOfWork: world,
      clarifications: service,
      choices: projector,
    })
    const input = clarificationInput(world)

    await port.requestClarification(input)
    await port.requestClarification(input)

    expect(keys[0]).toBe(keys[1])
    expect((retained as ClarificationRequest | null)?.choices).toEqual([
      { id: 'energy_first', label: 'Energy first', description: ENERGY_DESCRIPTION },
      { id: 'comfort_first', label: 'Comfort first', description: COMFORT_DESCRIPTION },
    ])
  })

  it('rejects unknown, relabeled, or reordered projected choices before persistence', async () => {
    const world = new WorkerAdapterWorld()
    world.installRun('active', 'plan')
    const service = { request: vi.fn(async () => undefined as never) }
    const reordered = new ClarificationCaretakerHumanPausePort({
      unitOfWork: world,
      clarifications: service,
      choices: {
        project: async () => [
          {
            id: 'comfort_first' as never,
            label: 'Comfort first',
            description: COMFORT_DESCRIPTION,
          },
          { id: 'energy_first' as never, label: 'Energy first', description: ENERGY_DESCRIPTION },
        ],
      },
    })
    await expect(reordered.requestClarification(clarificationInput(world))).rejects.toThrow(
      /changed an ID, label, or ordering/,
    )
    expect(service.request).not.toHaveBeenCalled()

    const unknown = new ClarificationCaretakerHumanPausePort({
      unitOfWork: world,
      clarifications: service,
      choices: canonicalProjector(),
    })
    await expect(
      unknown.requestClarification({
        ...clarificationInput(world),
        choices: [
          { id: 'unknown_choice', label: 'Unknown' },
          { id: 'comfort_first', label: 'Comfort first' },
        ],
      }),
    ).rejects.toThrow(/exact authored description/)
    expect(service.request).not.toHaveBeenCalled()
  })
})

type ClarificationCaretakerHumanPausePortDependencies = ConstructorParameters<
  typeof ClarificationCaretakerHumanPausePort
>[0]

class WorkerAdapterWorld implements MissionExecutionUnitOfWorkPort {
  public mission = fixtureMission()
  public context = executionContext()
  public latestRun: CaretakerRunSnapshot | null = null
  public checkpoints: CaretakerRunSnapshot['checkpoint'][] = []
  public contextReceipt: ContextReceipt | null = null

  public runner(
    resume: ConstructorParameters<typeof CaretakerMissionRunnerAdapter>[0]['host']['resume'],
  ) {
    const contextPreparation: CaretakerContextPreparationPort = {
      ensureFrozen: async ({ runId }) => this.freeze(runId),
    }
    return new CaretakerMissionRunnerAdapter({
      unitOfWork: this,
      contextPreparation,
      host: { resume },
    })
  }

  public installRun(status: 'active' | 'paused', phase: Mission['state']['phase'] = 'understand') {
    this.mission = MissionSchema.parse({
      ...this.mission,
      runId: IDS.priorRun,
      state: { status: 'running', phase },
    })
    const counters = {
      toolCallCount: 0,
      planRevisionCount: 0,
      clarificationPauseCount: 0,
      reconciliationPollCount: 0,
      activeRuntimeMilliseconds: 0,
    }
    const run = CaretakerRunRecordSchema.parse({
      id: IDS.priorRun,
      organizationId: IDS.organization,
      missionId: IDS.mission,
      leaseEpoch: 1,
      status,
      phase,
      version: 0,
      taskLedgerVersion: 0,
      counters,
      pendingToolCall: null,
      evidenceProfile: testCaretakerEvidenceProfile(IDS.priorRun),
      startedAt: NOW,
      updatedAt: NOW,
      endedAt: status === 'active' ? null : NOW,
    })
    const checkpoint = CaretakerRunCheckpointSchema.parse({
      organizationId: IDS.organization,
      missionId: IDS.mission,
      runId: IDS.priorRun,
      sequence: 0,
      mutationKey: hashToolValue({ fixture: 'run' }),
      mutationHash: hashToolValue({ fixture: 'checkpoint' }),
      kind: status === 'active' ? 'activated' : 'approval_pause',
      runStatus: status,
      phase,
      runVersion: 0,
      taskLedgerVersion: 0,
      taskLedgerHash: hashCaretakerTaskLedger([]),
      taskLedger: [],
      counters,
      pendingToolCall: null,
      evidenceRefs: [],
      occurredAt: NOW,
    })
    this.latestRun = { run, checkpoint, taskLedger: [] }
    this.checkpoints = [checkpoint]
  }

  public freeze(runId: RunId): void {
    if (this.contextReceipt?.runId === runId) return
    const receipt = ContextReceiptSchema.parse({
      id: ContextReceiptIdSchema.parse(`ctx_${hashToolValue(runId).slice(0, 24)}`),
      organizationId: IDS.organization,
      missionId: IDS.mission,
      runId,
      policyHash: hashHostPolicyContract(),
      toolRegistryHash: TOOL_REGISTRY_HASH,
      sources: [
        {
          sourceId: 'skill.homecoming',
          version: '1.0.0',
          contentHash: 'a'.repeat(64),
          authority: 'skill',
        },
      ],
      createdAt: LATER,
    })
    this.contextReceipt = receipt
    this.mission = MissionSchema.parse({
      ...this.mission,
      contextReceiptId: receipt.id,
      version: this.mission.version + 1,
      updatedAt: LATER,
    })
  }

  public runFenced<Result>(
    fence: MissionExecutionContext['fence'],
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result> {
    if (fence.missionId !== IDS.mission || fence.organizationId !== IDS.organization) {
      return Promise.reject(new Error('fence rejected'))
    }
    return work({
      missions: { get: async () => this.mission },
      caretakerRuns: {
        getLatestForMission: async () => this.latestRun,
        listCheckpoints: async () => this.checkpoints,
      },
      contextReceipts: {
        get: async (id: ContextReceipt['id']) =>
          this.contextReceipt?.id === id ? this.contextReceipt : null,
      },
    } as unknown as TenantRepositories)
  }
}

function fixtureMission(): Mission {
  return MissionSchema.parse({
    id: IDS.mission,
    organizationId: IDS.organization,
    palaceId: IDS.palace,
    initiatedBy: IDS.owner,
    objective: 'Choose a bounded homecoming tradeoff',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: ['safe_homecoming'],
    state: { status: 'running', phase: 'understand' },
    version: 1,
    runId: null,
    contextReceiptId: null,
    taskLedger: [],
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function executionContext(): MissionExecutionContext {
  return {
    fence: {
      organizationId: IDS.organization,
      missionId: IDS.mission,
      ownerId: 'worker-adapter-test',
      epoch: 2,
      token: OpaqueMissionFenceToken.fromEntropy('worker-adapter-fence-token-entropy'),
    },
    signal: new AbortController().signal,
    principal: PrincipalSchema.parse({
      organizationId: IDS.organization,
      actorId: IDS.service,
      role: 'service',
      operatorGrants: [],
      delegatedPermissions: [],
    }),
  }
}

function canonicalProjector() {
  return new StaticCaretakerClarificationChoiceProjector([
    {
      materialField: 'homecoming.priority',
      choiceId: 'energy_first',
      label: 'Energy first',
      description: ENERGY_DESCRIPTION,
    },
    {
      materialField: 'homecoming.priority',
      choiceId: 'comfort_first',
      label: 'Comfort first',
      description: COMFORT_DESCRIPTION,
    },
  ])
}

function clarificationInput(world: WorkerAdapterWorld) {
  return {
    context: world.context,
    missionId: IDS.mission,
    runId: IDS.priorRun,
    materialField: 'homecoming.priority',
    question: 'Should this run prioritize energy use or arrival comfort?',
    choices: [
      { id: 'energy_first', label: 'Energy first' },
      { id: 'comfort_first', label: 'Comfort first' },
    ],
    evidenceIds: [IDS.evidence],
    signal: world.context.signal,
  } as const
}
