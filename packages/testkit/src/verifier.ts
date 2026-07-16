import {
  EvidenceSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  Sha256Schema,
  VerificationIdSchema,
  VerificationPredicateSchema,
  VerificationSchema,
  type Evidence,
  type Verification,
  type VerificationAssertion,
  type VerificationPredicate,
} from '@trash-palace/core'
import { z } from 'zod'

export const ApplicationVerifierInputSchema = z
  .object({
    verificationId: VerificationIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    palaceId: PalaceIdSchema,
    planHash: Sha256Schema,
    predicates: z.array(VerificationPredicateSchema).min(1),
    evidence: z.array(EvidenceSchema).min(1),
    completedAt: IsoDateTimeSchema,
  })
  .strict()

export type ApplicationVerifierInput = z.input<typeof ApplicationVerifierInputSchema>

interface PredicateResult {
  readonly passed: boolean
  readonly evidence: readonly Evidence[]
  readonly message: string
}

function millisecondsBetween(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right)
}

function byObservedAt(left: Evidence, right: Evidence): number {
  return Date.parse(left.observedAt) - Date.parse(right.observedAt)
}

function uniqueEvidence(input: readonly Evidence[]): Evidence[] {
  const byId = new Map<string, { readonly serialized: string; readonly evidence: Evidence }>()
  for (const evidence of input) {
    const serialized = JSON.stringify(evidence)
    const existing = byId.get(evidence.id)
    if (existing && existing.serialized !== serialized) {
      throw new Error(`Conflicting evidence payloads share ID ${evidence.id}`)
    }
    if (!existing) byId.set(evidence.id, { serialized, evidence })
  }
  return [...byId.values()].map((entry) => entry.evidence)
}

function evaluatePredicate(
  predicate: VerificationPredicate,
  evidence: readonly Evidence[],
  allEvidence: readonly Evidence[],
  scopeContaminated: boolean,
): PredicateResult {
  switch (predicate.type) {
    case 'no_unlock_for_unverified_identity': {
      const arrival = evidence.find(
        (item) =>
          item.type === 'identity_arrival' && item.id === predicate.unverifiedArrivalEvidenceId,
      )
      const unlocks = evidence.filter(
        (item) => item.type === 'device_command' && item.command === 'unlock',
      )
      const nextVerifiedArrivalAt = evidence
        .filter(
          (item) =>
            item.type === 'identity_arrival' &&
            item.verified &&
            arrival !== undefined &&
            Date.parse(item.observedAt) > Date.parse(arrival.observedAt),
        )
        .map((item) => Date.parse(item.observedAt))
        .sort((left, right) => left - right)[0]
      const unsafeUnlocks = unlocks.filter((unlock) => {
        if (unlock.type !== 'device_command') return false
        if (unlock.causedByEvidenceId === predicate.unverifiedArrivalEvidenceId) return true
        if (!arrival) return false
        const occurredAt = Date.parse(unlock.observedAt)
        return (
          occurredAt >= Date.parse(arrival.observedAt) &&
          (nextVerifiedArrivalAt === undefined || occurredAt < nextVerifiedArrivalAt)
        )
      })
      const passed =
        arrival?.type === 'identity_arrival' && !arrival.verified && unsafeUnlocks.length === 0
      return {
        passed,
        evidence: [...(arrival ? [arrival] : []), ...unsafeUnlocks],
        message: passed
          ? 'No unlock command was caused by the unverified arrival.'
          : arrival
            ? 'An unlock occurred in the unverified-arrival window.'
            : 'The required unverified-arrival evidence is missing.',
      }
    }
    case 'active_routine_count': {
      const states = evidence.filter(
        (item) => item.type === 'routine_state' && item.planId === predicate.planId,
      )
      const active = states.filter((state) => state.type === 'routine_state' && state.active)
      const passed = states.length > 0 && active.length === predicate.expected
      return {
        passed,
        evidence: states,
        message: `Found ${active.length} active routine(s) for the approved plan; expected ${predicate.expected}.`,
      }
    }
    case 'routine_inactive': {
      const states = evidence.filter(
        (item) => item.type === 'routine_state' && item.routineId === predicate.routineId,
      )
      const latest = [...states].sort(byObservedAt).at(-1)
      const passed = latest?.type === 'routine_state' && !latest.active
      return {
        passed,
        evidence: states,
        message: passed
          ? 'The protected routine is inactive.'
          : 'The protected routine is active or its state is missing.',
      }
    }
    case 'routine_matches_plan': {
      const states = evidence.filter(
        (item) => item.type === 'routine_state' && item.routineId === predicate.routineId,
      )
      const latest = [...states].sort(byObservedAt).at(-1)
      const passed =
        latest?.type === 'routine_state' &&
        latest.active &&
        latest.planId === predicate.planId &&
        latest.planHash === predicate.planHash
      return {
        passed,
        evidence: states,
        message: passed
          ? 'The active routine is bound to the approved plan and hash.'
          : 'The active routine does not match the approved plan and hash.',
      }
    }
    case 'temperature_at_least_by': {
      const observations = evidence.filter(
        (item) =>
          item.type === 'temperature_observation' &&
          Date.parse(item.observedAt) <= Date.parse(predicate.deadline),
      )
      const passing = observations.find(
        (item) =>
          item.type === 'temperature_observation' && item.celsius >= predicate.minimumCelsius,
      )
      return {
        passed: passing !== undefined,
        evidence: observations,
        message: passing
          ? `Temperature reached at least ${predicate.minimumCelsius}°C by the deadline.`
          : `Temperature did not reach ${predicate.minimumCelsius}°C by the deadline.`,
      }
    }
    case 'lighting_after_arrival_within':
    case 'unlock_after_arrival_within': {
      const expectedCommand =
        predicate.type === 'lighting_after_arrival_within' ? 'set_lighting' : 'unlock'
      const arrival = evidence.find(
        (item) => item.type === 'identity_arrival' && item.id === predicate.arrivalEvidenceId,
      )
      const commands = evidence.filter(
        (item) =>
          item.type === 'device_command' &&
          item.command === expectedCommand &&
          item.causedByEvidenceId === predicate.arrivalEvidenceId,
      )
      const passing =
        arrival?.type === 'identity_arrival' &&
        arrival.verified &&
        commands.find((command) => {
          const delay = millisecondsBetween(command.observedAt, arrival.observedAt)
          return delay >= 0 && delay <= predicate.maximumDelaySeconds * 1_000
        })
      return {
        passed: passing !== undefined,
        evidence: [...(arrival ? [arrival] : []), ...commands],
        message: passing
          ? `${expectedCommand} followed verified-arrival evidence within ${predicate.maximumDelaySeconds} seconds.`
          : `${expectedCommand} did not follow verified-arrival evidence within ${predicate.maximumDelaySeconds} seconds.`,
      }
    }
    case 'lock_after_unlock_elapsed': {
      const unlocks = evidence.filter(
        (item) => item.type === 'device_command' && item.command === 'unlock',
      )
      const locks = evidence.filter(
        (item) => item.type === 'device_command' && item.command === 'locked_desired_state',
      )
      const expectedMilliseconds = predicate.expectedSeconds * 1_000
      const toleranceMilliseconds = predicate.toleranceSeconds * 1_000
      const passing = unlocks.some((unlock) =>
        locks.some((lock) => {
          if (
            unlock.type !== 'device_command' ||
            lock.type !== 'device_command' ||
            unlock.deviceId !== lock.deviceId
          ) {
            return false
          }
          const elapsed = millisecondsBetween(lock.observedAt, unlock.observedAt)
          return Math.abs(elapsed - expectedMilliseconds) <= toleranceMilliseconds
        }),
      )
      return {
        passed: passing,
        evidence: [...unlocks, ...locks],
        message: passing
          ? `Locked desired state followed unlock after ${predicate.expectedSeconds} seconds within tolerance.`
          : `Locked desired state did not follow unlock after ${predicate.expectedSeconds} seconds within tolerance.`,
      }
    }
    case 'battery_projection_at_most': {
      const projections = evidence.filter((item) => item.type === 'battery_projection')
      const latestAt = projections.reduce(
        (latest, projection) => Math.max(latest, Date.parse(projection.observedAt)),
        Number.NEGATIVE_INFINITY,
      )
      const latest = projections.filter(
        (projection) => Date.parse(projection.observedAt) === latestAt,
      )
      const passed =
        latest.length > 0 &&
        latest.every(
          (projection) =>
            projection.projectedUsePercentagePoints <= predicate.maximumPercentagePoints,
        )
      return {
        passed,
        evidence: projections,
        message: passed
          ? `Projected use is at or below ${predicate.maximumPercentagePoints} percentage points.`
          : `Projected use exceeds ${predicate.maximumPercentagePoints} percentage points or is missing.`,
      }
    }
    case 'no_cross_tenant_access': {
      const audits = allEvidence.filter((item) => item.type === 'tenant_access_audit')
      const contaminated =
        scopeContaminated ||
        allEvidence.some((item) => item.organizationId !== predicate.organizationId)
      const allowedCrossTenant = audits.some(
        (audit) => audit.attemptedOrganizationId !== predicate.organizationId && audit.allowed,
      )
      const passed = audits.length > 0 && !contaminated && !allowedCrossTenant
      return {
        passed,
        evidence: audits,
        message: passed
          ? 'The operation and retained evidence remain bound to the approved tenant.'
          : 'The operation lacks its tenant binding, contains foreign evidence, or records an allowed foreign access.',
      }
    }
  }
}

export function verifyApplicationEvidence(input: ApplicationVerifierInput): Verification {
  const parsed = ApplicationVerifierInputSchema.parse(input)
  const evidence = uniqueEvidence(parsed.evidence)
  const fallback = evidence[0]
  if (!fallback) throw new Error('Application verification requires evidence')
  const scopeContaminated = evidence.some(
    (item) =>
      item.organizationId !== parsed.organizationId ||
      item.missionId !== parsed.missionId ||
      item.palaceId !== parsed.palaceId,
  )
  const scopedEvidence = evidence.filter(
    (item) =>
      item.organizationId === parsed.organizationId &&
      item.missionId === parsed.missionId &&
      item.palaceId === parsed.palaceId,
  )

  const assertions: VerificationAssertion[] = parsed.predicates.map((predicate) => {
    const result = evaluatePredicate(predicate, scopedEvidence, evidence, scopeContaminated)
    const referenced = result.evidence.length > 0 ? result.evidence : [fallback]
    return {
      predicate,
      passed: result.passed,
      evidenceIds: [...new Set(referenced.map((item) => item.id))],
      message: result.message,
    }
  })

  return VerificationSchema.parse({
    id: parsed.verificationId,
    organizationId: parsed.organizationId,
    missionId: parsed.missionId,
    source: 'application_code',
    status: assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed',
    planHash: parsed.planHash,
    assertions,
    completedAt: parsed.completedAt,
  })
}
