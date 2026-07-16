import {
  ContextReceiptIdSchema,
  ContextReceiptSchema,
  EvidenceIdSchema,
  EvidenceSchema,
  ExecutionSchema,
  GatewayCallbackIdSchema,
  GatewayCommandIdSchema,
  MissionSchema,
  PersistedEvidenceRecordSchema,
  ReceiptIdSchema,
  RunIdSchema,
  type MissionState,
  type PersistedEvidenceRecord,
} from '@trash-palace/core'

import type { ApprovedVerificationMaterial } from '../deterministic-verifier.js'
import { ACTIVATION_APPLICATION_EVIDENCE_RULES } from '../execution-materialization-service.js'
import type { StoredExecution } from '../models.js'
import type { InMemorySeed } from '../testing/fakes.js'
import { IDS, makeApproval, makeMission, makeOperation, makePlan } from './fixtures.js'

export const VERIFICATION_EVIDENCE_IDS = {
  activeRoutine: EvidenceIdSchema.parse('evd_active_routine_01'),
  protectedInactive: EvidenceIdSchema.parse('evd_protected_off_01'),
  battery: EvidenceIdSchema.parse('evd_battery_bound_001'),
  tenantAudit: EvidenceIdSchema.parse('evd_tenant_audit_001'),
  unverifiedArrival: EvidenceIdSchema.parse('evd_unknown_arrival'),
  verifiedArrival: EvidenceIdSchema.parse('evd_rocky_arrival'),
  temperature: EvidenceIdSchema.parse('evd_temperature_ok_01'),
  lighting: EvidenceIdSchema.parse('evd_lighting_after_1'),
  unlock: EvidenceIdSchema.parse('evd_unlock_after_001'),
  relock: EvidenceIdSchema.parse('evd_relock_after_001'),
} as const

const CONTEXT_RECEIPT_ID = ContextReceiptIdSchema.parse('ctx_verification001')
const RUN_ID = RunIdSchema.parse('run_verification001')
const COMMAND_IDS = {
  preheat: GatewayCommandIdSchema.parse('gcmd_verify_preheat'),
  lighting: GatewayCommandIdSchema.parse('gcmd_verify_lighting'),
  unlock: GatewayCommandIdSchema.parse('gcmd_verify_unlock'),
  relock: GatewayCommandIdSchema.parse('gcmd_verify_relock'),
} as const

export interface VerificationFixture {
  readonly material: ApprovedVerificationMaterial
  readonly seed: InMemorySeed
}

export function makeProductionVerificationFixture(
  state: MissionState = { status: 'running', phase: 'verify' },
): VerificationFixture {
  const mission = MissionSchema.parse({
    ...makeMission(state, 14),
    runId: RUN_ID,
    contextReceiptId: CONTEXT_RECEIPT_ID,
  })
  const plan = makePlan()
  const approval = makeApproval(plan)
  const operation = makeOperation(plan, 'committed')
  const contextReceipt = ContextReceiptSchema.parse({
    id: CONTEXT_RECEIPT_ID,
    organizationId: mission.organizationId,
    missionId: mission.id,
    runId: RUN_ID,
    policyHash: 'a'.repeat(64),
    toolRegistryHash: 'b'.repeat(64),
    sources: [
      {
        sourceId: 'homecoming.verification-policy',
        version: 'homecoming-verifier@1',
        contentHash: 'c'.repeat(64),
        authority: 'host_policy',
      },
    ],
    createdAt: mission.createdAt,
  })
  const evidence = verificationEvidence(plan.hash)
  const execution: StoredExecution = {
    operationId: operation.id,
    authorization: { kind: 'mission_lease', epoch: 1 },
    execution: ExecutionSchema.parse({
      id: 'exe_verification001',
      organizationId: mission.organizationId,
      missionId: mission.id,
      operationId: operation.id,
      routineId: IDS.replacementRoutine,
      routineVersionId: IDS.replacementVersion,
      status: 'observed',
      triggeredByEvidenceId: VERIFICATION_EVIDENCE_IDS.activeRoutine,
      evidenceIds: evidence.map((record) => record.evidence.id),
      startedAt: '2026-08-14T05:44:00.000Z',
      deadline: '2026-08-14T07:06:30.000Z',
      milestones: [
        completedMilestone('preheat', COMMAND_IDS.preheat, VERIFICATION_EVIDENCE_IDS.temperature),
        completedMilestone('verified_arrival', null, VERIFICATION_EVIDENCE_IDS.verifiedArrival),
        completedMilestone(
          'pathway_lighting',
          COMMAND_IDS.lighting,
          VERIFICATION_EVIDENCE_IDS.lighting,
        ),
        completedMilestone('unlock', COMMAND_IDS.unlock, VERIFICATION_EVIDENCE_IDS.unlock),
        completedMilestone('relock', COMMAND_IDS.relock, VERIFICATION_EVIDENCE_IDS.relock),
      ],
      updatedAt: '2026-08-14T06:00:00.000Z',
      completedAt: '2026-08-14T06:00:00.000Z',
    }),
  }
  const material: ApprovedVerificationMaterial = {
    mission,
    plan,
    approval,
    operations: [operation],
    contextReceipt,
    executions: [execution],
    evidence,
  }
  return {
    material,
    seed: {
      missions: [mission],
      plans: [plan],
      approvals: [approval],
      operations: [operation],
      contextReceipts: [contextReceipt],
      executions: [execution],
      evidence,
    },
  }
}

function verificationEvidence(planHash: string): readonly PersistedEvidenceRecord[] {
  const scope = {
    organizationId: IDS.organization,
    missionId: IDS.mission,
    palaceId: IDS.palace,
  }
  return [
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.activeRoutine,
      observedAt: '2026-08-14T05:44:00.000Z',
      type: 'routine_state',
      routineId: IDS.replacementRoutine,
      routineVersionId: IDS.replacementVersion,
      active: true,
      planId: IDS.plan,
      planHash,
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.protectedInactive,
      observedAt: '2026-08-14T05:44:00.000Z',
      type: 'routine_state',
      routineId: IDS.protectedRoutine,
      routineVersionId: IDS.protectedVersion,
      active: false,
      planId: IDS.plan,
      planHash,
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.battery,
      observedAt: '2026-08-14T05:44:00.000Z',
      type: 'battery_projection',
      projectedUsePercentagePoints: 13.2,
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.tenantAudit,
      observedAt: '2026-08-14T05:44:00.000Z',
      type: 'tenant_access_audit',
      attemptedOrganizationId: IDS.organization,
      allowed: true,
      operationId: 'op_operation0001',
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.unverifiedArrival,
      observedAt: '2026-08-14T05:50:00.000Z',
      type: 'identity_arrival',
      identityTagId: 'tag_unknown00001',
      verified: false,
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.verifiedArrival,
      observedAt: '2026-08-14T05:58:00.000Z',
      type: 'identity_arrival',
      identityTagId: IDS.identityTag,
      verified: true,
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.temperature,
      observedAt: '2026-08-14T05:59:59.000Z',
      type: 'temperature_observation',
      deviceId: IDS.device,
      celsius: 20,
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.lighting,
      observedAt: '2026-08-14T05:58:03.000Z',
      type: 'device_command',
      deviceId: IDS.pathwayLight,
      command: 'set_lighting',
      causedByEvidenceId: VERIFICATION_EVIDENCE_IDS.verifiedArrival,
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.unlock,
      observedAt: '2026-08-14T05:58:04.000Z',
      type: 'device_command',
      deviceId: IDS.lock,
      command: 'unlock',
      causedByEvidenceId: VERIFICATION_EVIDENCE_IDS.verifiedArrival,
    }),
    record({
      ...scope,
      id: VERIFICATION_EVIDENCE_IDS.relock,
      observedAt: '2026-08-14T05:59:34.000Z',
      type: 'device_command',
      deviceId: IDS.lock,
      command: 'locked_desired_state',
      causedByEvidenceId: VERIFICATION_EVIDENCE_IDS.unlock,
    }),
  ]
}

function record(input: unknown): PersistedEvidenceRecord {
  const evidence = EvidenceSchema.parse(input)
  const index = Object.values(VERIFICATION_EVIDENCE_IDS).indexOf(evidence.id) + 1
  const receiptBase = {
    id: ReceiptIdSchema.parse(`rcp_verification_${String(index).padStart(2, '0')}`),
    evidenceId: evidence.id,
    organizationId: evidence.organizationId,
    missionId: evidence.missionId,
    palaceId: evidence.palaceId,
    verifiedAt: evidence.observedAt,
  }
  const authorityReceipt =
    evidence.type === 'identity_arrival'
      ? {
          ...receiptBase,
          authority: 'identity_telemetry' as const,
          providerEventId: `idt_verification_${String(index).padStart(2, '0')}`,
          identityTagId: evidence.identityTagId,
          authenticityVerified: true as const,
          tenantBindingVerified: true as const,
        }
      : evidence.type === 'device_command' ||
          evidence.type === 'temperature_observation' ||
          evidence.type === 'lighting_observation' ||
          evidence.type === 'lock_observation' ||
          evidence.type === 'gateway_delivery'
        ? {
            ...receiptBase,
            authority: 'gateway_callback' as const,
            callbackId: GatewayCallbackIdSchema.parse(
              `gcb_verification_${String(index).padStart(2, '0')}`,
            ),
            commandId:
              evidence.type === 'gateway_delivery'
                ? evidence.gatewayCommandId
                : gatewayCommandForEvidence(evidence.id),
            verifiedPayloadHash: 'd'.repeat(64),
            signatureVerified: true as const,
            commandBindingVerified: true as const,
          }
        : {
            ...receiptBase,
            authority: 'application' as const,
            producer: 'application_code' as const,
            ruleId: applicationEvidenceRule(evidence.id).id,
            ruleVersion: applicationEvidenceRule(evidence.id).version,
            inputEvidenceIds: [],
            derivationVerified: true as const,
          }
  return PersistedEvidenceRecordSchema.parse({
    evidence,
    authorityReceipt,
    persistedAt: evidence.observedAt,
  })
}

function gatewayCommandForEvidence(evidenceId: string) {
  if (evidenceId === VERIFICATION_EVIDENCE_IDS.temperature) return COMMAND_IDS.preheat
  if (evidenceId === VERIFICATION_EVIDENCE_IDS.lighting) return COMMAND_IDS.lighting
  if (evidenceId === VERIFICATION_EVIDENCE_IDS.unlock) return COMMAND_IDS.unlock
  if (evidenceId === VERIFICATION_EVIDENCE_IDS.relock) return COMMAND_IDS.relock
  throw new Error(`Gateway verification evidence ${evidenceId} has no command binding`)
}

function applicationEvidenceRule(evidenceId: string): { readonly id: string; readonly version: 1 } {
  if (evidenceId === VERIFICATION_EVIDENCE_IDS.activeRoutine) {
    return ACTIVATION_APPLICATION_EVIDENCE_RULES.activeRoutine
  }
  if (evidenceId === VERIFICATION_EVIDENCE_IDS.protectedInactive) {
    return ACTIVATION_APPLICATION_EVIDENCE_RULES.protectedRoutineInactive
  }
  if (evidenceId === VERIFICATION_EVIDENCE_IDS.battery) {
    return ACTIVATION_APPLICATION_EVIDENCE_RULES.batteryProjection
  }
  if (evidenceId === VERIFICATION_EVIDENCE_IDS.tenantAudit) {
    return ACTIVATION_APPLICATION_EVIDENCE_RULES.tenantBinding
  }
  throw new Error(`Application verification evidence ${evidenceId} has no authority rule`)
}

function completedMilestone(
  name: 'pathway_lighting' | 'preheat' | 'relock' | 'unlock' | 'verified_arrival',
  commandId: (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS] | null,
  evidenceId: (typeof VERIFICATION_EVIDENCE_IDS)[keyof typeof VERIFICATION_EVIDENCE_IDS],
) {
  return {
    name,
    commandId,
    status: 'completed' as const,
    evidenceId,
    resolvedAt:
      evidenceId === VERIFICATION_EVIDENCE_IDS.temperature
        ? '2026-08-14T05:59:59.000Z'
        : evidenceId === VERIFICATION_EVIDENCE_IDS.verifiedArrival
          ? '2026-08-14T05:58:00.000Z'
          : evidenceId === VERIFICATION_EVIDENCE_IDS.lighting
            ? '2026-08-14T05:58:03.000Z'
            : evidenceId === VERIFICATION_EVIDENCE_IDS.unlock
              ? '2026-08-14T05:58:04.000Z'
              : '2026-08-14T05:59:34.000Z',
    failure: null,
  }
}
