import { describe, expect, it } from 'vitest'

import { FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE } from '@trash-palace/core'

import {
  WorkerConfigurationError,
  parseWorkerBootstrapConfiguration,
  parseWorkerServerConfiguration,
} from './server-configuration.js'

const VALID = Object.freeze({
  DATABASE_URL: 'postgresql://trash:fixture@postgres:5432/trash_palace',
  TRASH_PALACE_WORKER_ID: 'worker-local-1',
  TRASH_PALACE_WORKER_SERVICE_ACTOR_ID: 'usr_worker000001',
  TOOL_INVOCATION_SCOPE_KEY: 'tool-scope-test-key-that-is-at-least-32-bytes',
  TRASH_PALACE_EVIDENCE_ALIAS_KEY: 'evidence-alias-test-key-that-is-at-least-32-bytes',
  TRASH_PALACE_EVIDENCE_SINK_PATH: '/var/lib/trash-palace/evidence.jsonl',
  TRASH_PALACE_REPOSITORY_ROOT: '/app',
})

describe('worker server configuration', () => {
  it('parses a complete credential-free local configuration with typed defaults', () => {
    expect(parseWorkerServerConfiguration(VALID)).toMatchObject({
      databaseUrl: VALID.DATABASE_URL,
      workerId: 'worker-local-1',
      serviceActorId: 'usr_worker000001',
      applicationVersion: '0.0.0',
      evidenceEnvironment: 'local',
      evidenceOrigin: 'fixture',
      domainClock: { mode: 'system' },
      applicationTransportFault: { kind: 'none' },
      gatewayTimeoutMilliseconds: 10_000,
      leaseTtlMilliseconds: 30_000,
      outboxPumpIntervalMilliseconds: 250,
      healthHost: '0.0.0.0',
      healthPort: 4_320,
    })
  })

  it.each([
    ['missing database URL', { ...VALID, DATABASE_URL: undefined }],
    ['non-PostgreSQL URL', { ...VALID, DATABASE_URL: 'https://database.invalid/db' }],
    ['short scope key', { ...VALID, TOOL_INVOCATION_SCOPE_KEY: 'short' }],
    [
      'reused scope and alias keys',
      { ...VALID, TRASH_PALACE_EVIDENCE_ALIAS_KEY: VALID.TOOL_INVOCATION_SCOPE_KEY },
    ],
    ['relative evidence path', { ...VALID, TRASH_PALACE_EVIDENCE_SINK_PATH: 'evidence.jsonl' }],
    ['unnormalized repository root', { ...VALID, TRASH_PALACE_REPOSITORY_ROOT: '/app/../app' }],
    [
      'incompatible evidence origin',
      {
        ...VALID,
        TRASH_PALACE_ENVIRONMENT: 'local',
        TRASH_PALACE_EVIDENCE_ORIGIN: 'live',
      },
    ],
    ['privileged health port', { ...VALID, TRASH_PALACE_WORKER_HEALTH_PORT: '80' }],
    ['fixture clock without anchor', { ...VALID, TRASH_PALACE_CLOCK_MODE: 'fixture' }],
    [
      'fixture anchor in system mode',
      { ...VALID, TRASH_PALACE_FIXTURE_REAL_START_AT: '2026-08-14T05:44:00.000Z' },
    ],
    ['slow outbox pump', { ...VALID, TRASH_PALACE_OUTBOX_PUMP_INTERVAL_MS: '5001' }],
    ['malformed lab mode', { ...VALID, TRASH_PALACE_LAB_MODE: 'yes' }],
    [
      'dangling application fault organization',
      {
        ...VALID,
        TRASH_PALACE_APPLICATION_TRANSPORT_FAULT_ORGANIZATION_ID: 'org_rocky_roost',
      },
    ],
  ])('fails closed for %s', (_label, environment) => {
    expect(() => parseWorkerServerConfiguration(environment)).toThrow(WorkerConfigurationError)
  })

  it('selects the accelerated fixture clock and frequent outbox pump explicitly', () => {
    const configuration = parseWorkerServerConfiguration({
      ...VALID,
      TRASH_PALACE_CLOCK_MODE: 'fixture',
      TRASH_PALACE_FIXTURE_REAL_START_AT: '2026-08-14T05:44:00.000Z',
    })
    expect(configuration).toMatchObject({
      domainClock: {
        mode: 'fixture',
        realStartAt: '2026-08-14T05:44:00.000Z',
      },
      outboxPumpIntervalMilliseconds: 25,
    })
    expect(
      (configuration.outboxPumpIntervalMilliseconds /
        FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE) *
        60_000,
    ).toBe(500)
  })

  it('enables commit-then-response-lost only for an explicitly targeted local lab fixture', () => {
    expect(
      parseWorkerServerConfiguration({
        ...VALID,
        TRASH_PALACE_LAB_MODE: 'true',
        TRASH_PALACE_CLOCK_MODE: 'fixture',
        TRASH_PALACE_FIXTURE_REAL_START_AT: '2026-08-14T05:44:00.000Z',
        TRASH_PALACE_APPLICATION_TRANSPORT_FAULT: 'application_commit_then_response_lost',
        TRASH_PALACE_APPLICATION_TRANSPORT_FAULT_ORGANIZATION_ID: 'org_rocky_roost',
      }).applicationTransportFault,
    ).toEqual({
      kind: 'application_commit_then_response_lost',
      organizationId: 'org_rocky_roost',
    })
  })

  it.each([
    [
      'missing lab gate',
      {
        ...VALID,
        TRASH_PALACE_CLOCK_MODE: 'fixture',
        TRASH_PALACE_FIXTURE_REAL_START_AT: '2026-08-14T05:44:00.000Z',
      },
    ],
    [
      'system clock',
      {
        ...VALID,
        TRASH_PALACE_LAB_MODE: 'true',
      },
    ],
    [
      'hosted demo',
      {
        ...VALID,
        TRASH_PALACE_LAB_MODE: 'true',
        TRASH_PALACE_ENVIRONMENT: 'hosted_demo',
        TRASH_PALACE_EVIDENCE_ORIGIN: 'live',
        TRASH_PALACE_CLOCK_MODE: 'fixture',
        TRASH_PALACE_FIXTURE_REAL_START_AT: '2026-08-14T05:44:00.000Z',
      },
    ],
  ])('rejects the application fault in %s', (_label, base) => {
    expect(() =>
      parseWorkerServerConfiguration({
        ...base,
        TRASH_PALACE_APPLICATION_TRANSPORT_FAULT: 'application_commit_then_response_lost',
        TRASH_PALACE_APPLICATION_TRANSPORT_FAULT_ORGANIZATION_ID: 'org_rocky_roost',
      }),
    ).toThrow(WorkerConfigurationError)
  })

  it('never includes a supplied secret or database URL in configuration errors', () => {
    const secret = 'top-secret-value-that-must-never-appear-in-an-error'
    try {
      parseWorkerServerConfiguration({
        ...VALID,
        DATABASE_URL: secret,
        TOOL_INVOCATION_SCOPE_KEY: secret,
      })
      throw new Error('Expected configuration parsing to fail')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })
})

describe('worker bootstrap configuration', () => {
  it('requires only the database and repository inputs used by bootstrap', () => {
    expect(
      parseWorkerBootstrapConfiguration({
        TRASH_PALACE_BOOTSTRAP_PROFILE: 'local-fixture',
        DATABASE_URL: 'postgresql://localhost:5432/trash_palace',
        TRASH_PALACE_REPOSITORY_ROOT: '/srv/trash-palace',
      }),
    ).toEqual({
      profile: 'local-fixture',
      databaseUrl: 'postgresql://localhost:5432/trash_palace',
      repositoryRoot: '/srv/trash-palace',
      applicationVersion: '0.0.0',
    })
  })

  it('does not accept a relative repository root', () => {
    expect(() =>
      parseWorkerBootstrapConfiguration({
        TRASH_PALACE_BOOTSTRAP_PROFILE: 'local-fixture',
        DATABASE_URL: 'postgresql://localhost:5432/trash_palace',
        TRASH_PALACE_REPOSITORY_ROOT: './trash-palace',
      }),
    ).toThrow(WorkerConfigurationError)
  })

  it('requires an explicit local-fixture profile before writing canonical data', () => {
    expect(() =>
      parseWorkerBootstrapConfiguration({
        DATABASE_URL: 'postgresql://localhost:5432/trash_palace',
        TRASH_PALACE_REPOSITORY_ROOT: '/srv/trash-palace',
      }),
    ).toThrow('TRASH_PALACE_BOOTSTRAP_PROFILE is required')
  })
})
