import {
  VerificationSchema,
  assertSameTenant,
  type Mission,
  type PlanId,
  type Verification,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import { ApprovedPlanDeterministicVerifier } from './deterministic-verifier.js'
import { persistMissionTransition } from './mission-state.js'
import { enqueueMissionResume } from './mission-resume.js'
import type { CaretakerRunSnapshot, MissionReference, StoredExecution } from './models.js'
import { MissionReferenceSchema } from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { CryptoIdGenerator, SYSTEM_CLOCK, iso, parseGeneratedId } from './primitives.js'
import { enqueueApplicationProductEvidence } from './product-evidence.js'
import type {
  ClockPort,
  DeterministicVerifierPort,
  IdGeneratorPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export interface VerificationRunResult {
  readonly verification: Verification
  readonly mission: Mission
  readonly replayed: boolean
}

export class VerificationService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
    private readonly verifier: DeterministicVerifierPort = new ApprovedPlanDeterministicVerifier(),
  ) {}

  public async run(reference: MissionReference): Promise<VerificationRunResult> {
    const input = MissionReferenceSchema.parse(reference)
    const snapshot = await this.unitOfWork.run(input.organizationId, async (repositories) => {
      const mission = await repositories.missions.get(input.missionId)
      if (mission === null) throw new NotFoundError('Mission')
      assertSameTenant(input.organizationId, [mission.organizationId])
      const existing = await repositories.verifications.findForMission(mission.id)
      if (existing !== null) {
        const plan = await repositories.plans.getLatestForMission(mission.id)
        if (plan === null) throw new ConflictError('Verification replay requires its plan')
        const existingSnapshot = {
          kind: 'existing',
          existing,
          mission,
          plan,
          operations: await repositories.operations.listForMission(mission.id),
          executions: await repositories.executions.listForMission(mission.id),
          caretakerRun: await repositories.caretakerRuns.getLatestForMission(mission.id),
        } as const
        await this.#enqueueEvidence(repositories, {
          verification: existingSnapshot.existing,
          mission: existingSnapshot.mission,
          planId: existingSnapshot.plan.id,
          operations: existingSnapshot.operations,
          executions: existingSnapshot.executions,
          caretakerRun: existingSnapshot.caretakerRun,
        })
        return existingSnapshot
      }
      if (mission.state.status !== 'running' || mission.state.phase !== 'verify') {
        throw new ConflictError('Mission is not at the verifier checkpoint')
      }
      const plan = await repositories.plans.getLatestForMission(mission.id)
      if (plan === null || plan.status !== 'approved') {
        throw new ConflictError('Verification requires the approved plan')
      }
      const approval = await repositories.approvals.findForPlan(plan.id)
      if (approval === null) throw new ConflictError('Verification requires the exact approval')
      if (mission.contextReceiptId === null) {
        throw new ConflictError('Verification requires the mission context receipt')
      }
      const contextReceipt = await repositories.contextReceipts.get(mission.contextReceiptId)
      if (contextReceipt === null) {
        throw new ConflictError('Verification requires the mission context receipt')
      }
      const operations = await repositories.operations.listForMission(mission.id)
      const executions = await repositories.executions.listForMission(mission.id)
      const evidence = await repositories.evidence.listForMission(mission.id)
      return {
        kind: 'pending',
        mission,
        plan,
        approval,
        operations,
        contextReceipt,
        executions,
        evidence,
        caretakerRun: await repositories.caretakerRuns.getLatestForMission(mission.id),
      } as const
    })
    if (snapshot.kind === 'existing') {
      return { verification: snapshot.existing, mission: snapshot.mission, replayed: true }
    }
    const assertions = await this.observability.trace(
      {
        name: 'domain.verification.run',
        kind: 'domain',
        correlation: {
          organizationId: input.organizationId,
          missionId: input.missionId,
          planId: snapshot.plan.id,
        },
        attributes: {
          evidence_count: snapshot.evidence.length,
          execution_count: snapshot.executions.length,
        },
      },
      () =>
        this.verifier.evaluate({
          mission: snapshot.mission,
          plan: snapshot.plan,
          approval: snapshot.approval,
          operations: snapshot.operations,
          contextReceipt: snapshot.contextReceipt,
          executions: snapshot.executions,
          evidence: snapshot.evidence,
        }),
    )
    const verification = VerificationSchema.parse({
      id: parseGeneratedId('verification', this.ids.next('verification')),
      organizationId: input.organizationId,
      missionId: input.missionId,
      source: 'application_code',
      status: assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed',
      planHash: snapshot.plan.hash,
      assertions,
      completedAt: iso(this.clock.now()),
    })
    const mission = await this.unitOfWork.run(input.organizationId, async (repositories) => {
      const current = await repositories.missions.get(input.missionId)
      if (current === null) throw new NotFoundError('Mission')
      if (current.version !== snapshot.mission.version) {
        throw new ConflictError('Mission changed while verification was running')
      }
      await repositories.verifications.insert(verification)
      const nextMission = await persistMissionTransition({
        repositories,
        mission: current,
        expectedVersion: current.version,
        event: verification.status === 'passed' ? 'verification_passed' : 'intervention_required',
        clock: this.clock,
        ids: this.ids,
      })
      await enqueueMissionResume(repositories, nextMission, this.ids)
      await this.#enqueueEvidence(repositories, {
        verification,
        mission: nextMission,
        planId: snapshot.plan.id,
        operations: snapshot.operations,
        executions: snapshot.executions,
        caretakerRun: snapshot.caretakerRun,
      })
      return nextMission
    })
    return { verification, mission, replayed: false }
  }

  async #enqueueEvidence(
    repositories: TenantRepositories,
    input: {
      readonly verification: Verification
      readonly mission: Mission
      readonly planId: PlanId
      readonly operations: readonly { readonly id: string; readonly planId: PlanId }[]
      readonly executions: readonly StoredExecution[]
      readonly caretakerRun: CaretakerRunSnapshot | null
    },
  ): Promise<void> {
    const failedAssertionCount = input.verification.assertions.filter(
      (assertion) => !assertion.passed,
    ).length
    const verifiedOperationIds = new Set(
      input.operations
        .filter((operation) => operation.planId === input.planId)
        .map((operation) => operation.id),
    )
    const verifiedExecutions = input.executions.filter((stored) =>
      verifiedOperationIds.has(stored.execution.operationId),
    )
    for (const stored of verifiedExecutions) {
      await enqueueApplicationProductEvidence(repositories, this.observability, {
        event: 'execution verified',
        durableIdentity: {
          verificationId: input.verification.id,
          executionId: stored.execution.id,
        },
        occurredAt: input.verification.completedAt,
        correlation: {
          distinctId: input.mission.initiatedBy,
          organizationId: input.mission.organizationId,
          palaceId: input.mission.palaceId,
          missionId: input.mission.id,
          ...(input.mission.runId === null ? {} : { runId: input.mission.runId }),
          planId: input.planId,
          operationId: stored.execution.operationId,
          resourceId: stored.execution.routineId,
          executionId: stored.execution.id,
        },
        properties: {
          passed: input.verification.status === 'passed',
          assertion_count: input.verification.assertions.length,
          failed_assertion_count: failedAssertionCount,
        },
      })
    }
    if (input.verification.status !== 'passed') return
    await enqueueApplicationProductEvidence(repositories, this.observability, {
      event: 'mission completed',
      durableIdentity: {
        missionId: input.mission.id,
        verificationId: input.verification.id,
      },
      occurredAt: input.verification.completedAt,
      correlation: {
        distinctId: input.mission.initiatedBy,
        organizationId: input.mission.organizationId,
        palaceId: input.mission.palaceId,
        missionId: input.mission.id,
        ...(input.mission.runId === null ? {} : { runId: input.mission.runId }),
        planId: input.planId,
      },
      properties: {
        duration_ms: Math.max(
          0,
          Date.parse(input.verification.completedAt) - Date.parse(input.mission.createdAt),
        ),
        tool_call_count: input.caretakerRun?.run.counters.toolCallCount ?? 0,
        reconciliation_count: input.caretakerRun?.run.counters.reconciliationPollCount ?? 0,
      },
    })
  }
}
