import {
  EvidenceIdSchema,
  PersistedEvidenceRecordSchema,
  ReceiptIdSchema,
  ToolInvocationReconciliationObservationSchema,
  computeToolInvocationReconciliationObservationHash,
  type MissionId,
  type OrganizationId,
  type PersistedEvidenceRecord,
  type Sha256,
  type ToolCallId,
  type ToolName,
} from '@trash-palace/core'

import { NotFoundError } from './errors.js'
import { CryptoIdGenerator, SYSTEM_CLOCK, iso } from './primitives.js'
import type { ClockPort, IdGeneratorPort, UnitOfWorkPort } from './ports.js'

export interface ToolInvocationReconciliationEvidencePort {
  recordStillUnknown(input: {
    readonly organizationId: OrganizationId
    readonly missionId: MissionId
    readonly callId: ToolCallId
    readonly toolName: ToolName
    readonly invocationBindingHash: Sha256
    readonly abandonedClaimGeneration: number
    readonly claimExpiredAt: string
  }): Promise<PersistedEvidenceRecord>
}

export class ToolInvocationReconciliationEvidenceService implements ToolInvocationReconciliationEvidencePort {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
  ) {}

  public recordStillUnknown(input: {
    readonly organizationId: OrganizationId
    readonly missionId: MissionId
    readonly callId: ToolCallId
    readonly toolName: ToolName
    readonly invocationBindingHash: Sha256
    readonly abandonedClaimGeneration: number
    readonly claimExpiredAt: string
  }): Promise<PersistedEvidenceRecord> {
    const observedAt = iso(this.clock.now())
    const observation = ToolInvocationReconciliationObservationSchema.parse({
      schemaVersion: 'tool-invocation-reconciliation-observation@1',
      organizationId: input.organizationId,
      missionId: input.missionId,
      toolCallId: input.callId,
      toolName: input.toolName,
      invocationBindingHash: input.invocationBindingHash,
      abandonedClaimGeneration: input.abandonedClaimGeneration,
      claimExpiredAt: input.claimExpiredAt,
      source: 'tool_invocation_ledger',
      observer: 'application_code',
      durableObservation: 'expired_claim_without_terminal_result',
      reconciledOutcome: 'still_unknown',
      observedResultHash: null,
      observedAttemptId: null,
      observedAt,
    })

    return this.unitOfWork.run(input.organizationId, async (repositories) => {
      const mission = await repositories.missions.get(input.missionId)
      if (mission === null) throw new NotFoundError('Mission')
      const evidenceId = EvidenceIdSchema.parse(this.ids.next('evidence'))
      const record = PersistedEvidenceRecordSchema.parse({
        schemaVersion: 'persisted-evidence@1',
        evidence: {
          id: evidenceId,
          organizationId: mission.organizationId,
          missionId: mission.id,
          palaceId: mission.palaceId,
          type: 'tool_invocation_reconciliation',
          toolCallId: input.callId,
          toolName: input.toolName,
          invocationBindingHash: input.invocationBindingHash,
          abandonedClaimGeneration: input.abandonedClaimGeneration,
          claimExpiredAt: input.claimExpiredAt,
          source: observation.source,
          observer: observation.observer,
          durableObservation: observation.durableObservation,
          reconciledOutcome: observation.reconciledOutcome,
          observedResultHash: observation.observedResultHash,
          observedAttemptId: observation.observedAttemptId,
          observationHash: computeToolInvocationReconciliationObservationHash(observation),
          observedAt,
        },
        authorityReceipt: {
          schemaVersion: 'evidence-authority-receipt@1',
          id: ReceiptIdSchema.parse(this.ids.next('evidence_authority_receipt')),
          evidenceId,
          organizationId: mission.organizationId,
          missionId: mission.id,
          palaceId: mission.palaceId,
          verifiedAt: observedAt,
          authority: 'application',
          producer: 'application_code',
          ruleId: 'tool_invocation.abandoned_write',
          ruleVersion: 1,
          inputEvidenceIds: [],
          derivationVerified: true,
        },
        persistedAt: observedAt,
      })
      await repositories.evidence.appendMany([record])
      return record
    })
  }
}
