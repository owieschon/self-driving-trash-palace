import { createHmac } from 'node:crypto'

import type {
  AnalyticsSessionId,
  AttemptId,
  EventId,
  ExecutionId,
  MissionId,
  OperationId,
  OrganizationId,
  PalaceId,
  PlanId,
  RoutineId,
  RunId,
  UserId,
} from '@trash-palace/core'
import { z } from 'zod'

const ALIAS_NAMESPACE = /^[a-z][a-z0-9_]{0,31}$/
const INSERT_EVENT_NAME = /^[a-z$][a-z0-9_$ ]{0,95}$/

export const AnalyticsAliasSchema = z
  .string()
  .regex(/^tpa_[a-z][a-z0-9_]{0,31}_v1_[A-Za-z0-9_-]{43}$/)

export const StableInsertIdSchema = z.string().regex(/^tpi_v1_[A-Za-z0-9_-]{43}$/)

export type AnalyticsAlias = z.infer<typeof AnalyticsAliasSchema>
export type StableInsertId = z.infer<typeof StableInsertIdSchema>

export type AnalyticsAliasKey = string | Uint8Array

export interface PrivateCorrelationInput {
  readonly distinctId: UserId
  readonly organizationId: OrganizationId
  readonly actorId?: UserId
  readonly palaceId?: PalaceId
  readonly browserSessionId?: AnalyticsSessionId
  readonly missionId?: MissionId
  readonly runId?: RunId
  readonly planId?: PlanId
  readonly operationId?: OperationId
  readonly attemptId?: AttemptId
  readonly resourceId?: RoutineId
  readonly executionId?: ExecutionId
}

export interface AnalyticsCorrelation {
  readonly distinctAlias: AnalyticsAlias
  readonly organizationAlias: AnalyticsAlias
  readonly actorAlias?: AnalyticsAlias
  readonly palaceAlias?: AnalyticsAlias
  readonly browserSessionAlias?: AnalyticsAlias
  readonly missionAlias?: AnalyticsAlias
  readonly runAlias?: AnalyticsAlias
  readonly planAlias?: AnalyticsAlias
  readonly operationAlias?: AnalyticsAlias
  readonly attemptAlias?: AnalyticsAlias
  readonly resourceAlias?: AnalyticsAlias
  readonly executionAlias?: AnalyticsAlias
}

function requirePrivateIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 2_048) {
    throw new Error(`${label} must contain between 1 and 2048 characters`)
  }
  return normalized
}

export class AnalyticsAliaser {
  readonly #key: Uint8Array

  public constructor(key: AnalyticsAliasKey) {
    const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : Uint8Array.from(key)
    if (bytes.byteLength < 32) {
      throw new Error('Analytics alias keys must contain at least 32 bytes')
    }
    this.#key = bytes
  }

  public alias(namespace: string, privateIdentifier: string): AnalyticsAlias {
    if (!ALIAS_NAMESPACE.test(namespace)) {
      throw new Error(`Invalid analytics alias namespace: ${namespace}`)
    }

    const value = requirePrivateIdentifier(privateIdentifier, 'Private identifier')
    const digest = this.#digest(`alias:${namespace}:v1\0${value}`)
    return AnalyticsAliasSchema.parse(`tpa_${namespace}_v1_${digest}`)
  }

  public insertId(eventName: string, logicalEventId: EventId): StableInsertId {
    if (!INSERT_EVENT_NAME.test(eventName)) {
      throw new Error(`Invalid evidence event name: ${eventName}`)
    }

    const source = requirePrivateIdentifier(logicalEventId, 'Logical event identifier')
    return StableInsertIdSchema.parse(
      `tpi_v1_${this.#digest(`insert:v1\0${eventName}\0${source}`)}`,
    )
  }

  /**
   * Binds durable evidence to one alias-key generation without exposing key material.
   * A rotated key must start a new evidence run rather than split an existing trace.
   */
  public configurationFingerprint(): string {
    return createHmac('sha256', this.#key)
      .update('trash-palace:analytics-alias-configuration:v1', 'utf8')
      .digest('hex')
  }

  #digest(value: string): string {
    return createHmac('sha256', this.#key).update(value, 'utf8').digest('base64url')
  }
}

export function createAnalyticsCorrelation(
  aliaser: AnalyticsAliaser,
  input: PrivateCorrelationInput,
): AnalyticsCorrelation {
  return {
    distinctAlias: aliaser.alias('person', input.distinctId),
    organizationAlias: aliaser.alias('organization', input.organizationId),
    ...(input.actorId === undefined ? {} : { actorAlias: aliaser.alias('actor', input.actorId) }),
    ...(input.palaceId === undefined
      ? {}
      : { palaceAlias: aliaser.alias('palace', input.palaceId) }),
    ...(input.browserSessionId === undefined
      ? {}
      : { browserSessionAlias: aliaser.alias('browser_session', input.browserSessionId) }),
    ...(input.missionId === undefined
      ? {}
      : { missionAlias: aliaser.alias('mission', input.missionId) }),
    ...(input.runId === undefined ? {} : { runAlias: aliaser.alias('run', input.runId) }),
    ...(input.planId === undefined ? {} : { planAlias: aliaser.alias('plan', input.planId) }),
    ...(input.operationId === undefined
      ? {}
      : { operationAlias: aliaser.alias('operation', input.operationId) }),
    ...(input.attemptId === undefined
      ? {}
      : { attemptAlias: aliaser.alias('attempt', input.attemptId) }),
    ...(input.resourceId === undefined
      ? {}
      : { resourceAlias: aliaser.alias('resource', input.resourceId) }),
    ...(input.executionId === undefined
      ? {}
      : { executionAlias: aliaser.alias('execution', input.executionId) }),
  }
}
