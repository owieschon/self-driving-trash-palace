import { createHash } from 'node:crypto'

import { Sha256Schema, TOOL_REGISTRY_HASH } from '@trash-palace/core'
import { z } from 'zod'

import { canonicalJson, type JsonValue } from './canonical.js'
import {
  EVIDENCE_EVENT_REGISTRY_HASH,
  EvidenceEnvironmentSchema,
  EvidenceOriginSchema,
  parseSafeEvidenceEvent,
  type SafeEvidenceEvent,
} from './contracts.js'
import { AnalyticsAliasSchema } from './identifiers.js'

const SafeLabelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]*$/)

const FeatureFlagsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,95}$/), z.union([z.boolean(), SafeLabelSchema]))
  .optional()

export const CARETAKER_EVIDENCE_RENDERER_VERSION = 'caretaker-evidence-renderer@3' as const

export const CaretakerEvidenceByteConfigurationSchema = z
  .object({
    rendererVersion: z.literal(CARETAKER_EVIDENCE_RENDERER_VERSION),
    aliasConfigurationFingerprint: Sha256Schema,
    environment: EvidenceEnvironmentSchema,
    dataOrigin: EvidenceOriginSchema,
    appVersion: SafeLabelSchema,
    harnessVersion: SafeLabelSchema,
    modelConfigVersion: SafeLabelSchema,
    toolRegistryHash: z.literal(TOOL_REGISTRY_HASH),
    evidenceEventRegistryHash: z.literal(EVIDENCE_EVENT_REGISTRY_HASH),
    featureFlags: FeatureFlagsSchema,
  })
  .strict()

export type CaretakerEvidenceByteConfiguration = z.output<
  typeof CaretakerEvidenceByteConfigurationSchema
>

export const CaretakerEvidenceCorrelationAliasesSchema = z
  .object({
    distinctAlias: AnalyticsAliasSchema,
    organizationAlias: AnalyticsAliasSchema,
    initiatorAlias: AnalyticsAliasSchema,
    palaceAlias: AnalyticsAliasSchema,
    missionAlias: AnalyticsAliasSchema,
    runAlias: AnalyticsAliasSchema,
  })
  .strict()

export type CaretakerEvidenceCorrelationAliases = z.output<
  typeof CaretakerEvidenceCorrelationAliasesSchema
>

function sha256(value: JsonValue): z.output<typeof Sha256Schema> {
  return Sha256Schema.parse(createHash('sha256').update(canonicalJson(value)).digest('hex'))
}

export function hashCaretakerEvidenceByteConfiguration(
  input: CaretakerEvidenceByteConfiguration,
): z.output<typeof Sha256Schema> {
  return sha256(CaretakerEvidenceByteConfigurationSchema.parse(input) as unknown as JsonValue)
}

const CaretakerEvidenceProfileShapeSchema = z
  .object({
    schemaVersion: z.literal('caretaker-evidence-profile@1'),
    configuration: CaretakerEvidenceByteConfigurationSchema,
    configurationHash: Sha256Schema,
    contextManifestHash: Sha256Schema,
    correlationAliases: CaretakerEvidenceCorrelationAliasesSchema,
  })
  .strict()

export const CaretakerEvidenceProfileSchema = CaretakerEvidenceProfileShapeSchema.extend({
  profileHash: Sha256Schema,
})
  .strict()
  .superRefine((profile, context) => {
    if (
      hashCaretakerEvidenceByteConfiguration(profile.configuration) !== profile.configurationHash
    ) {
      context.addIssue({
        code: 'custom',
        path: ['configurationHash'],
        message: 'Caretaker evidence configuration hash must bind every byte-affecting setting',
      })
    }
    const { profileHash: _profileHash, ...shape } = profile
    const expectedProfileHash = sha256(
      CaretakerEvidenceProfileShapeSchema.parse(shape) as unknown as JsonValue,
    )
    if (profile.profileHash !== expectedProfileHash) {
      context.addIssue({
        code: 'custom',
        path: ['profileHash'],
        message: 'Caretaker evidence profile hash must bind its configuration and aliases',
      })
    }
  })

export type CaretakerEvidenceProfile = z.output<typeof CaretakerEvidenceProfileSchema>

export function createCaretakerEvidenceProfile(
  input: z.input<typeof CaretakerEvidenceProfileShapeSchema>,
): CaretakerEvidenceProfile {
  const profile = CaretakerEvidenceProfileShapeSchema.parse(input)
  return CaretakerEvidenceProfileSchema.parse({
    ...profile,
    profileHash: sha256(profile as unknown as JsonValue),
  })
}

function eventHash(event: SafeEvidenceEvent): z.output<typeof Sha256Schema> {
  return sha256(event as unknown as JsonValue)
}

export type CaretakerTerminalEvidenceEnvelope = Readonly<{
  schemaVersion: 'caretaker-terminal-evidence@1'
  eventHash: z.output<typeof Sha256Schema>
  event: SafeEvidenceEvent
}>

export const CaretakerTerminalEvidenceEnvelopeSchema: z.ZodType<CaretakerTerminalEvidenceEnvelope> =
  z
    .object({
      schemaVersion: z.literal('caretaker-terminal-evidence@1'),
      eventHash: Sha256Schema,
      event: z.unknown().transform((value) => parseSafeEvidenceEvent(value)),
    })
    .strict()
    .superRefine((envelope, context) => {
      if (envelope.event.event !== '$ai_trace') {
        context.addIssue({
          code: 'custom',
          path: ['event', 'event'],
          message: 'Caretaker terminal evidence must contain exactly one AI trace event',
        })
      }
      if (envelope.eventHash !== eventHash(envelope.event)) {
        context.addIssue({
          code: 'custom',
          path: ['eventHash'],
          message: 'Caretaker terminal evidence hash must bind the canonical event bytes',
        })
      }
    })

export function createCaretakerTerminalEvidenceEnvelope(
  input: SafeEvidenceEvent,
): CaretakerTerminalEvidenceEnvelope {
  const event = parseSafeEvidenceEvent(input)
  return CaretakerTerminalEvidenceEnvelopeSchema.parse({
    schemaVersion: 'caretaker-terminal-evidence@1',
    eventHash: eventHash(event),
    event,
  })
}
