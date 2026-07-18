import {
  MissionIdSchema,
  MissionProgramKindSchema,
  OrganizationIdSchema,
  hashToolValue,
} from '@trash-palace/core'
import { z } from 'zod'

const EventIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:@/-]+$/)
const MaterialFieldSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z][a-zA-Z0-9_.-]*$/)
const CorrectionKeySchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-zA-Z0-9_.-]*$/)

const EventBaseShape = {
  schemaVersion: z.literal('pal-supervision-event@1'),
  eventId: EventIdSchema,
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  programKind: MissionProgramKindSchema,
  missionVersion: z.number().int().nonnegative(),
} as const

/**
 * Inputs are emitted by existing durable work, never a timer or a model poll. They describe the
 * event after the owning service has already made the state transition.
 */
export const PalSupervisionEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...EventBaseShape, kind: z.literal('routine_execution_verified') }).strict(),
  z
    .object({
      ...EventBaseShape,
      kind: z.literal('material_ambiguity'),
      materialField: MaterialFieldSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      kind: z.literal('authority_change'),
      authorityScope: z.enum(['new_automation', 'broader_permission', 'weaker_safety_rule']),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      kind: z.literal('deviation_detected'),
      correctionKey: CorrectionKeySchema,
      correctionScope: z.enum(['same_mission', 'bounded_new_mission']),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      kind: z.literal('mission_resume'),
      outcome: z.enum(['completed_checkpoint', 'paused', 'retry']),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      kind: z.literal('mission_verification'),
      status: z.enum(['passed', 'failed']),
    })
    .strict(),
])

export type PalSupervisionEvent = z.output<typeof PalSupervisionEventSchema>

type PalSupervisionBase = Readonly<{
  sourceEventId: string
  deduplicationKey: string
  /** The supervisor only classifies. A later bounded mission activation owns any model call. */
  supervisorModelCallCount: 0
  createdMissionCount: 0
  approvedByPal: false
  verifiedByPal: false
}>

export type PalSupervisionDisposition =
  | (PalSupervisionBase &
      Readonly<{
        kind: 'no_action'
        reason: 'healthy_approved_routine' | 'completed_checkpoint' | 'verification_passed'
      }>)
  | (PalSupervisionBase &
      Readonly<{
        kind: 'human_attention'
        attention: 'clarification' | 'approval' | 'paused' | 'verification_failure'
      }>)
  | (PalSupervisionBase &
      Readonly<{
        kind: 'resume_same_mission'
        reason: 'retry' | 'safe_correction'
        targetTopic: 'mission.resume'
      }>)
  | (PalSupervisionBase &
      Readonly<{
        kind: 'bounded_new_mission'
        reason: 'safe_correction'
        /** Only the existing application mission bootstrap and approval path may materialize it. */
        requiredAuthority: 'application_mission_bootstrap_and_human_approval'
      }>)
  | (PalSupervisionBase &
      Readonly<{
        kind: 'duplicate'
        originalKind: Exclude<PalSupervisionDisposition['kind'], 'duplicate'>
      }>)

export interface PalSupervisionPort {
  observe(input: z.input<typeof PalSupervisionEventSchema>): Promise<PalSupervisionDisposition>
}

/**
 * Event-driven classifier for Pal's continuous-operation boundary. It keeps only local duplicate
 * suppression; durable queue and outbox deduplication remain the owner of external effects.
 */
export class PalEventSupervisor implements PalSupervisionPort {
  readonly #observed = new Map<string, Exclude<PalSupervisionDisposition['kind'], 'duplicate'>>()

  public observe(
    input: z.input<typeof PalSupervisionEventSchema>,
  ): Promise<PalSupervisionDisposition> {
    const event = PalSupervisionEventSchema.parse(input)
    const deduplicationKey = supervisionDeduplicationKey(event)
    const previous = this.#observed.get(deduplicationKey)
    if (previous !== undefined) {
      return Promise.resolve({
        ...baseDisposition(event, deduplicationKey),
        kind: 'duplicate',
        originalKind: previous,
      })
    }
    const disposition = classifyPalSupervisionEvent(event, deduplicationKey)
    this.#observed.set(deduplicationKey, disposition.kind)
    return Promise.resolve(disposition)
  }
}

export function classifyPalSupervisionEvent(
  input: z.input<typeof PalSupervisionEventSchema>,
  providedDeduplicationKey?: string,
): Exclude<PalSupervisionDisposition, { readonly kind: 'duplicate' }> {
  const event = PalSupervisionEventSchema.parse(input)
  const deduplicationKey = providedDeduplicationKey ?? supervisionDeduplicationKey(event)
  const base = baseDisposition(event, deduplicationKey)

  switch (event.kind) {
    case 'routine_execution_verified':
      return { ...base, kind: 'no_action', reason: 'healthy_approved_routine' }
    case 'material_ambiguity':
      return { ...base, kind: 'human_attention', attention: 'clarification' }
    case 'authority_change':
      return { ...base, kind: 'human_attention', attention: 'approval' }
    case 'deviation_detected':
      return event.correctionScope === 'same_mission'
        ? {
            ...base,
            kind: 'resume_same_mission',
            reason: 'safe_correction',
            targetTopic: 'mission.resume',
          }
        : {
            ...base,
            kind: 'bounded_new_mission',
            reason: 'safe_correction',
            requiredAuthority: 'application_mission_bootstrap_and_human_approval',
          }
    case 'mission_resume':
      if (event.outcome === 'retry') {
        return {
          ...base,
          kind: 'resume_same_mission',
          reason: 'retry',
          targetTopic: 'mission.resume',
        }
      }
      if (event.outcome === 'paused') {
        return { ...base, kind: 'human_attention', attention: 'paused' }
      }
      return { ...base, kind: 'no_action', reason: 'completed_checkpoint' }
    case 'mission_verification':
      return event.status === 'passed'
        ? { ...base, kind: 'no_action', reason: 'verification_passed' }
        : { ...base, kind: 'human_attention', attention: 'verification_failure' }
  }
}

export function palMissionResumeEvent(input: {
  readonly eventId: string
  readonly organizationId: string
  readonly missionId: string
  readonly programKind: string
  readonly missionVersion: number
  readonly outcome: 'completed_checkpoint' | 'paused' | 'retry'
}): PalSupervisionEvent {
  return PalSupervisionEventSchema.parse({
    schemaVersion: 'pal-supervision-event@1',
    kind: 'mission_resume',
    ...input,
  })
}

export function palMissionVerificationEvent(input: {
  readonly eventId: string
  readonly organizationId: string
  readonly missionId: string
  readonly programKind: string
  readonly missionVersion: number
  readonly status: 'passed' | 'failed'
}): PalSupervisionEvent {
  return PalSupervisionEventSchema.parse({
    schemaVersion: 'pal-supervision-event@1',
    kind: 'mission_verification',
    ...input,
  })
}

function baseDisposition(event: PalSupervisionEvent, deduplicationKey: string): PalSupervisionBase {
  return {
    sourceEventId: event.eventId,
    deduplicationKey,
    supervisorModelCallCount: 0,
    createdMissionCount: 0,
    approvedByPal: false,
    verifiedByPal: false,
  }
}

function supervisionDeduplicationKey(event: PalSupervisionEvent): string {
  return `pal.supervision:${hashToolValue({
    organizationId: event.organizationId,
    missionId: event.missionId,
    programKind: event.programKind,
    missionVersion: event.missionVersion,
    kind: event.kind,
    semanticKey: semanticKey(event),
  })}`
}

function semanticKey(event: PalSupervisionEvent): string {
  switch (event.kind) {
    case 'material_ambiguity':
      return event.materialField
    case 'authority_change':
      return event.authorityScope
    case 'deviation_detected':
      return event.correctionKey
    case 'mission_resume':
      return `${event.outcome}:${event.eventId}`
    case 'mission_verification':
      return `${event.status}:${event.eventId}`
    case 'routine_execution_verified':
      return event.eventId
  }
}
