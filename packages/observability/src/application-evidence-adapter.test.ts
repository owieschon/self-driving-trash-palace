import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  UserIdSchema,
} from '@trash-palace/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AnalyticsAliaser,
  InMemoryEvidenceSink,
  LocalJsonlEvidenceSink,
  SafeApplicationEvidenceAdapter,
  UnsafeRuntimeEvidenceInputError,
  type CompleteApplicationProductObservation,
  type RuntimeEvidenceDiagnostic,
  type RuntimeProductEvidenceInput,
  type EvidenceSink,
} from './index.js'

const ALIAS_KEY = 'application-evidence-test-key-with-at-least-32-bytes'
const privateCorrelation = {
  distinctId: UserIdSchema.parse('usr_runtimeperson001'),
  actorId: UserIdSchema.parse('usr_runtimeactor0001'),
  organizationId: OrganizationIdSchema.parse('org_runtimeorg00001'),
  palaceId: PalaceIdSchema.parse('pal_runtimepalace01'),
  missionId: MissionIdSchema.parse('mis_runtimemission01'),
} as const

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function input(
  logicalEventId = 'evt_runtimeevent0001',
  occurredAt = '2026-07-15T02:00:00.000Z',
): RuntimeProductEvidenceInput {
  return {
    event: 'mission created',
    logicalEventId: EventIdSchema.parse(logicalEventId),
    occurredAt,
    correlation: privateCorrelation,
    properties: {
      source_surface: 'fixture',
      objective_class: 'homecoming_routine',
    },
  }
}

function observation(evidence = input()): CompleteApplicationProductObservation {
  return {
    name: 'evidence.product',
    occurredAt: evidence.occurredAt,
    correlation: {
      organizationId: evidence.correlation.organizationId,
      ...(evidence.correlation.missionId === undefined
        ? {}
        : { missionId: evidence.correlation.missionId }),
    },
    evidence,
  }
}

function adapter(
  sink: InMemoryEvidenceSink | LocalJsonlEvidenceSink,
  onDiagnostic?: (diagnostic: RuntimeEvidenceDiagnostic) => void,
): SafeApplicationEvidenceAdapter {
  return new SafeApplicationEvidenceAdapter({
    sink,
    aliaser: new AnalyticsAliaser(ALIAS_KEY),
    environment: 'test',
    dataOrigin: 'fixture',
    appVersion: '0.0.0-test',
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  })
}

async function temporaryEvidencePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'trash-palace-application-evidence-'))
  temporaryDirectories.push(directory)
  return join(directory, 'runtime.jsonl')
}

describe('safe application evidence adapter', () => {
  it('derives deterministic aliases and insert identity without retaining private IDs', async () => {
    const firstSink = new InMemoryEvidenceSink()
    const secondSink = new InMemoryEvidenceSink()
    const first = adapter(firstSink)
    const second = adapter(secondSink)

    await first.record(observation())
    await second.record(observation())

    const [firstEvent] = await firstSink.all()
    const [secondEvent] = await secondSink.all()
    expect(firstEvent).toEqual(secondEvent)
    expect(first.aliasConfigurationFingerprint()).toBe(second.aliasConfigurationFingerprint())
    expect(firstEvent?.insertId).toMatch(/^tpi_v1_/)
    expect(firstEvent?.distinctId).toMatch(/^tpa_person_v1_/)
    const serialized = JSON.stringify(firstEvent)
    for (const privateId of Object.values(privateCorrelation)) {
      expect(serialized).not.toContain(privateId)
    }
  })

  it('deduplicates the same durable observation after a sink and adapter restart', async () => {
    const filePath = await temporaryEvidencePath()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Runtime evidence must not use the network')
    })

    await expect(
      adapter(new LocalJsonlEvidenceSink(filePath)).captureProduct(input()),
    ).resolves.toEqual(expect.objectContaining({ status: 'stored' }))
    await expect(
      adapter(new LocalJsonlEvidenceSink(filePath)).captureProduct(input()),
    ).resolves.toEqual(expect.objectContaining({ status: 'duplicate' }))

    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('projects frozen bytes without consulting restarted app or alias configuration', async () => {
    const original = adapter(new InMemoryEvidenceSink())
    const frozen = original.freezeProduct(input())
    const restartedSink = new InMemoryEvidenceSink()
    const restarted = new SafeApplicationEvidenceAdapter({
      sink: restartedSink,
      aliaser: new AnalyticsAliaser('rotated-application-evidence-key-is-at-least-32-bytes'),
      environment: 'test',
      dataOrigin: 'fixture',
      appVersion: '9.9.9',
    })
    const rerendered = restarted.freezeProduct(input())

    expect(rerendered.semanticHash).toBe(frozen.semanticHash)
    expect(rerendered.eventHash).not.toBe(frozen.eventHash)
    await expect(restarted.captureFrozen(frozen)).resolves.toMatchObject({ status: 'stored' })
    const [delivered] = await restartedSink.all()
    expect(delivered).toEqual(frozen.event)
    expect(delivered?.properties.app_version).toBe('0.0.0-test')
  })

  it('shares one JSONL source of truth across independently constructed process adapters', async () => {
    const filePath = await temporaryEvidencePath()
    const first = adapter(new LocalJsonlEvidenceSink(filePath))
    const second = adapter(new LocalJsonlEvidenceSink(filePath))

    await Promise.all([
      first.captureProduct(input('evt_runtimeevent0001')),
      second.captureProduct(input('evt_runtimeevent0002', '2026-07-15T02:00:01.000Z')),
    ])

    await expect(new LocalJsonlEvidenceSink(filePath).all()).resolves.toHaveLength(2)
  })

  it('does not turn spans or incomplete observations into product events', async () => {
    const sink = new InMemoryEvidenceSink()
    const diagnostics: RuntimeEvidenceDiagnostic[] = []
    const observability = adapter(sink, (diagnostic) => diagnostics.push(diagnostic))

    await expect(
      observability.trace(
        {
          name: 'domain.plan.propose',
          kind: 'domain',
          correlation: {
            organizationId: privateCorrelation.organizationId,
            missionId: privateCorrelation.missionId,
          },
        },
        async () => 'result',
      ),
    ).resolves.toBe('result')
    await observability.record({
      name: 'mission.transitioned',
      occurredAt: '2026-07-15T02:00:01.000Z',
      correlation: {
        organizationId: privateCorrelation.organizationId,
        missionId: privateCorrelation.missionId,
      },
      attributes: { event: 'verification_passed', status: 'succeeded' },
    })

    await expect(sink.all()).resolves.toHaveLength(0)
    expect(diagnostics).toEqual([
      {
        code: 'application_observation_not_event_complete',
        observationName: 'mission.transitioned',
      },
    ])
  })

  it('does not let a delivery failure turn a valid domain observation into a product failure', async () => {
    const diagnostics: RuntimeEvidenceDiagnostic[] = []
    const failingSink: EvidenceSink = {
      capture: async () => {
        throw new Error('analytics transport unavailable')
      },
      all: async () => [],
    }
    const observability = new SafeApplicationEvidenceAdapter({
      sink: failingSink,
      aliaser: new AnalyticsAliaser(ALIAS_KEY),
      environment: 'test',
      dataOrigin: 'fixture',
      appVersion: '0.0.0-test',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    await expect(observability.record(observation())).resolves.toBeUndefined()
    expect(diagnostics).toEqual([
      { code: 'application_evidence_delivery_failed', observationName: 'evidence.product' },
    ])
  })

  it('sanitizes diagnostic names rather than echoing paths or credentials', async () => {
    const diagnostics: RuntimeEvidenceDiagnostic[] = []
    const observability = adapter(new InMemoryEvidenceSink(), (diagnostic) =>
      diagnostics.push(diagnostic),
    )

    await observability.record({
      name: 'phx_1234567890abcdefghijkl',
      occurredAt: '2026-07-15T02:00:00.000Z',
      correlation: { organizationId: privateCorrelation.organizationId },
    })

    expect(diagnostics[0]?.observationName).toBe('unrecognized')
  })

  it('fails closed on generated-property overrides, extra properties, and correlation drift', async () => {
    const sink = new InMemoryEvidenceSink()
    const observability = adapter(sink)
    const generatedOverride = {
      ...input(),
      properties: {
        ...input().properties,
        organization_alias: 'tpa_organization_v1_unsafe',
      },
    } as unknown as RuntimeProductEvidenceInput
    const extraProperty = {
      ...input(),
      properties: { ...input().properties, prompt: 'private model input' },
    } as unknown as RuntimeProductEvidenceInput
    const drifted = {
      ...observation(),
      correlation: { organizationId: 'org_differenttenant01' },
    } as CompleteApplicationProductObservation

    await expect(observability.captureProduct(generatedOverride)).rejects.toBeInstanceOf(
      UnsafeRuntimeEvidenceInputError,
    )
    await expect(observability.captureProduct(extraProperty)).rejects.toThrow()
    await expect(observability.record(drifted)).rejects.toBeInstanceOf(
      UnsafeRuntimeEvidenceInputError,
    )
    await expect(sink.all()).resolves.toHaveLength(0)
  })
})
