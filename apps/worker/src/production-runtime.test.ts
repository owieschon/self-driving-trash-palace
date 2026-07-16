import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  UserIdSchema,
} from '@trash-palace/core'

import {
  composeProductionWorker,
  createApplicationTransportFaultPolicy,
} from './production-runtime.js'
import { parseWorkerServerConfiguration } from './server-configuration.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('production worker composition', () => {
  it('selects the lab fault only for the target tenant through a mission lease', () => {
    const target = OrganizationIdSchema.parse('org_rocky_roost')
    const other = OrganizationIdSchema.parse('org_other_palace')
    const policy = createApplicationTransportFaultPolicy({
      applicationTransportFault: {
        kind: 'application_commit_then_response_lost',
        organizationId: target,
      },
    })

    expect(
      policy.shouldLoseCommittedResponse({
        organizationId: target,
        authorization: 'mission_lease',
      }),
    ).toBe(true)
    expect(
      policy.shouldLoseCommittedResponse({ organizationId: target, authorization: 'manual' }),
    ).toBe(false)
    expect(
      policy.shouldLoseCommittedResponse({
        organizationId: other,
        authorization: 'mission_lease',
      }),
    ).toBe(false)
    expect(
      createApplicationTransportFaultPolicy({
        applicationTransportFault: { kind: 'none' },
      }).shouldLoseCommittedResponse({
        organizationId: target,
        authorization: 'mission_lease',
      }),
    ).toBe(false)
  })

  it('constructs the complete graph without a database connection or gateway credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trash-palace-worker-composition-'))
    temporaryDirectories.push(directory)
    const configuration = parseWorkerServerConfiguration({
      DATABASE_URL: 'postgresql://127.0.0.1:1/not-contacted',
      TRASH_PALACE_WORKER_ID: 'worker-composition-test',
      TRASH_PALACE_WORKER_SERVICE_ACTOR_ID: 'usr_worker000001',
      TOOL_INVOCATION_SCOPE_KEY: 'tool-scope-test-key-that-is-at-least-32-bytes',
      TRASH_PALACE_EVIDENCE_ALIAS_KEY: 'evidence-alias-test-key-that-is-at-least-32-bytes',
      TRASH_PALACE_EVIDENCE_SINK_PATH: join(directory, 'evidence.jsonl'),
      TRASH_PALACE_REPOSITORY_ROOT: resolve(import.meta.dirname, '../../..'),
    })

    const resources = await composeProductionWorker(configuration)
    try {
      expect(resources.graph.runtime).toBeDefined()
      expect(resources.graph.queue).toBeDefined()
      expect(resources.evidence).toBeDefined()
      const frozen = resources.observability.freezeProduct({
        event: 'mission created',
        logicalEventId: EventIdSchema.parse('evt_worker_runtime01'),
        occurredAt: '2026-07-15T02:00:00.000Z',
        correlation: {
          distinctId: UserIdSchema.parse('usr_worker000001'),
          actorId: UserIdSchema.parse('usr_worker000001'),
          organizationId: OrganizationIdSchema.parse('org_worker_runtime01'),
          palaceId: PalaceIdSchema.parse('pal_worker_runtime01'),
          missionId: MissionIdSchema.parse('mis_worker_runtime01'),
        },
        properties: {
          source_surface: 'fixture',
          objective_class: 'homecoming_routine',
        },
      })
      expect(frozen.event.event).toBe('mission created')
      await expect(resources.evidenceSink.all()).resolves.toHaveLength(0)
    } finally {
      await resources.closeDatabase()
    }
  })
})
