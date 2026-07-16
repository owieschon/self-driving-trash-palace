import { createHash } from 'node:crypto'

import { EventIdSchema, Sha256Schema, TOOL_REGISTRY_HASH } from '@trash-palace/core'
import {
  AnalyticsAliaser,
  CARETAKER_EVIDENCE_RENDERER_VERSION,
  EVIDENCE_EVENT_REGISTRY_HASH,
  createAiEvidenceEvent,
  createCaretakerEvidenceProfile,
  createCaretakerTerminalEvidenceEnvelope,
  hashCaretakerEvidenceByteConfiguration,
  type CaretakerEvidenceProfile,
  type CaretakerTerminalEvidenceEnvelope,
} from '@trash-palace/observability'

const aliaser = new AnalyticsAliaser('test-only-durable-evidence-fixture-key-32-bytes')

function digest(label: string): ReturnType<typeof Sha256Schema.parse> {
  return Sha256Schema.parse(createHash('sha256').update(label, 'utf8').digest('hex'))
}

/** Deterministic fixture for repository tests that do not construct the agent evidence recorder. */
export function testCaretakerEvidenceProfile(
  runId: string,
  contextManifestHash = digest('test-caretaker-context'),
): CaretakerEvidenceProfile {
  const configuration = {
    rendererVersion: CARETAKER_EVIDENCE_RENDERER_VERSION,
    aliasConfigurationFingerprint: Sha256Schema.parse(aliaser.configurationFingerprint()),
    environment: 'test' as const,
    dataOrigin: 'fixture' as const,
    appVersion: '0.0.0-test',
    harnessVersion: 'repository-test@1',
    modelConfigVersion: 'deterministic-test@1',
    toolRegistryHash: TOOL_REGISTRY_HASH,
    evidenceEventRegistryHash: EVIDENCE_EVENT_REGISTRY_HASH,
  }
  return createCaretakerEvidenceProfile({
    schemaVersion: 'caretaker-evidence-profile@1',
    configuration,
    configurationHash: hashCaretakerEvidenceByteConfiguration(configuration),
    contextManifestHash,
    correlationAliases: {
      distinctAlias: aliaser.alias('person', 'usr_repositorytest'),
      organizationAlias: aliaser.alias('organization', 'org_repositorytest'),
      initiatorAlias: aliaser.alias('actor', 'usr_repositorytest'),
      palaceAlias: aliaser.alias('palace', 'pal_repositorytest'),
      missionAlias: aliaser.alias('mission', 'mis_repositorytest'),
      runAlias: aliaser.alias('run', runId),
    },
  })
}

export function testCaretakerTerminalEvidence(
  profile: CaretakerEvidenceProfile,
  occurredAt: string,
): CaretakerTerminalEvidenceEnvelope {
  const aliases = profile.correlationAliases
  const event = '$ai_trace' as const
  const logicalId = EventIdSchema.parse(
    `evt_${digest(`terminal:${aliases.runAlias}`).slice(0, 40)}`,
  )
  return createCaretakerTerminalEvidenceEnvelope(
    createAiEvidenceEvent({
      event,
      insertId: aliaser.insertId(event, logicalId),
      occurredAt,
      distinctId: aliases.distinctAlias,
      properties: {
        schema_version: '1',
        environment: profile.configuration.environment,
        data_origin: profile.configuration.dataOrigin,
        privacy_classification: 'analytics_safe',
        app_version: profile.configuration.appVersion,
        organization_alias: aliases.organizationAlias,
        palace_alias: aliases.palaceAlias,
        mission_alias: aliases.missionAlias,
        run_alias: aliases.runAlias,
        context_manifest_hash: profile.contextManifestHash,
        tool_registry_hash: TOOL_REGISTRY_HASH,
        model_config_version: profile.configuration.modelConfigVersion,
        harness_version: profile.configuration.harnessVersion,
        $ai_session_id: aliases.missionAlias,
        $ai_trace_id: aliases.runAlias,
        $ai_span_name: 'caretaker.run',
        $ai_latency: 0,
        $ai_is_error: true,
        outcome: 'failed',
        generation_count: 0,
        tool_call_count: 0,
        plan_revision_count: 0,
        clarification_pause_count: 0,
        reconciliation_poll_count: 0,
        active_runtime_ms: 0,
        budget_exhausted: false,
        error_code: 'test_terminal',
      },
    }),
  )
}
