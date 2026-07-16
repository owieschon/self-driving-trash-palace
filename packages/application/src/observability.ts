import type {
  AttemptId,
  MissionId,
  OperationId,
  OrganizationId,
  PlanId,
  RunId,
} from '@trash-palace/core'
import type {
  CompleteApplicationProductObservation,
  FrozenApplicationProductEvidenceEnvelope,
  RuntimeProductEvidenceInput,
} from '@trash-palace/observability'

export type ApplicationSpanName =
  | 'domain.approval.decide'
  | 'domain.callback.ingest'
  | 'domain.clarification.answer'
  | 'domain.clarification.request'
  | 'domain.identity-telemetry.ingest'
  | 'domain.mission.cancel'
  | 'domain.mission.lease'
  | 'domain.mission.transition'
  | 'domain.plan.propose'
  | 'domain.plan.simulate'
  | 'domain.plan.validate'
  | 'domain.verification.run'
  | 'gateway.dispatch'
  | 'operation.activate'
  | 'operation.reconcile'
  | 'outbox.dispatch'

export interface SpanCorrelation {
  readonly organizationId: OrganizationId
  readonly missionId?: MissionId
  readonly runId?: RunId
  readonly planId?: PlanId
  readonly operationId?: OperationId
  readonly attemptId?: AttemptId
}

export interface ApplicationSpan {
  readonly name: ApplicationSpanName
  readonly kind: 'domain' | 'operation' | 'worker'
  readonly correlation: SpanCorrelation
  readonly attributes?: Readonly<Record<string, boolean | number | string>>
}

export interface DiagnosticDomainObservation {
  readonly name: string
  readonly occurredAt: string
  readonly correlation: SpanCorrelation
  readonly attributes?: Readonly<Record<string, boolean | number | string>>
}

export type DomainObservation = DiagnosticDomainObservation | CompleteApplicationProductObservation

export interface ObservabilityPort {
  trace<Result>(span: ApplicationSpan, work: () => Promise<Result>): Promise<Result>
  record(observation: DomainObservation): Promise<void>
  /** Present in production command/worker compositions; freezes bytes but performs no I/O. */
  freezeProduct?(input: RuntimeProductEvidenceInput): FrozenApplicationProductEvidenceEnvelope
}

export const NOOP_OBSERVABILITY: ObservabilityPort = {
  async trace<Result>(_span: ApplicationSpan, work: () => Promise<Result>): Promise<Result> {
    return work()
  },
  record: () => Promise.resolve(),
}
