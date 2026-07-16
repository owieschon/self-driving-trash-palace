import { describe, expect, it } from 'vitest'

import { parseWebServerConfiguration } from './server-configuration.js'

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/trash_palace',
  SESSION_SIGNING_KEY: 'session-signing-key-at-least-32-bytes',
  TOOL_INVOCATION_SCOPE_KEY: 'tool-scope-hmac-key-at-least-32-bytes',
  GATEWAY_CALLBACK_SIGNING_KEY: 'gateway-callback-key-at-least-32-bytes',
  GATEWAY_CALLBACK_SIGNING_KEY_ID: 'gwk_local_gateway',
  IDENTITY_TELEMETRY_SIGNING_KEY: 'identity-telemetry-key-at-least-32-bytes',
  IDENTITY_TELEMETRY_SIGNING_KEY_ID: 'itk_local_identity',
  IDENTITY_TELEMETRY_PRINCIPAL_ID: 'itp_local_identity',
  TRASH_PALACE_EVIDENCE_ALIAS_KEY: 'evidence-alias-key-at-least-32-bytes',
  TRASH_PALACE_EVIDENCE_SINK_PATH: '/var/lib/trash-palace/evidence/runtime.jsonl',
  TRASH_PALACE_LOCAL_ORGANIZATION_ID: 'org_rocky_roost',
  TRASH_PALACE_LOCAL_PALACE_ID: 'pal_sacred_dumpster',
  TRASH_PALACE_ALLOWED_ORIGIN: 'http://127.0.0.1:3000',
  TRASH_PALACE_DEV_SESSION_ENABLED: 'true',
  TRASH_PALACE_DEV_ORGANIZATION_ID: 'org_rocky_roost',
  TRASH_PALACE_DEV_USER_ID: 'usr_rocky_founder',
  TRASH_PALACE_DEV_MEMBERSHIP_ID: 'mem_rocky_founder',
} as const

describe('web server configuration', () => {
  it('permits bootstrap only for an explicit development loopback configuration', () => {
    expect(parseWebServerConfiguration(base)).toMatchObject({
      applicationVersion: '0.0.0',
      evidenceEnvironment: 'local',
      evidenceOrigin: 'fixture',
      devBootstrap: {
        enabled: true,
        principal: {
          actorId: 'usr_rocky_founder',
          organizationId: 'org_rocky_roost',
          role: 'owner',
        },
      },
    })
  })

  it.each([
    [{ ...base, NODE_ENV: 'production' }, /development.*loopback/i],
    [
      { ...base, TRASH_PALACE_ALLOWED_ORIGIN: 'https://trash-palace.example' },
      /development.*loopback/i,
    ],
    [{ ...base, TRASH_PALACE_ALLOWED_ORIGIN: 'http://localhost.example:3000' }, /HTTPS.*loopback/i],
  ])(
    'rejects enabled bootstrap outside the local development boundary',
    (environment, expected) => {
      expect(() => parseWebServerConfiguration(environment)).toThrow(expected)
    },
  )

  it('defaults bootstrap off and does not require seeded identity settings', () => {
    expect(
      parseWebServerConfiguration({
        ...base,
        NODE_ENV: 'production',
        TRASH_PALACE_ALLOWED_ORIGIN: 'https://trash-palace.example',
        TRASH_PALACE_DEV_SESSION_ENABLED: 'false',
        TRASH_PALACE_DEV_ORGANIZATION_ID: undefined,
        TRASH_PALACE_DEV_USER_ID: undefined,
        TRASH_PALACE_DEV_MEMBERSHIP_ID: undefined,
      }).devBootstrap,
    ).toEqual({ enabled: false })
  })

  it('requires one shared real anchor only in fixture clock mode', () => {
    expect(() =>
      parseWebServerConfiguration({ ...base, TRASH_PALACE_CLOCK_MODE: 'fixture' }),
    ).toThrow(/shared real start instant/)

    expect(
      parseWebServerConfiguration({
        ...base,
        TRASH_PALACE_CLOCK_MODE: 'fixture',
        TRASH_PALACE_FIXTURE_REAL_START_AT: '2026-07-15T12:00:00.000Z',
      }).domainClock,
    ).toEqual({ mode: 'fixture', realStartAt: '2026-07-15T12:00:00.000Z' })

    expect(() =>
      parseWebServerConfiguration({
        ...base,
        TRASH_PALACE_CLOCK_MODE: 'system',
        TRASH_PALACE_FIXTURE_REAL_START_AT: '2026-07-15T12:00:00.000Z',
      }),
    ).toThrow(/must not retain/)
  })

  it('rejects malformed origins, non-PostgreSQL URLs, and weak secrets', () => {
    expect(() =>
      parseWebServerConfiguration({
        ...base,
        TRASH_PALACE_ALLOWED_ORIGIN: 'http://localhost:3000/',
      }),
    ).toThrow(/exact/i)
    expect(() => parseWebServerConfiguration({ ...base, DATABASE_URL: 'file:///tmp/db' })).toThrow(
      /PostgreSQL/i,
    )
    expect(() =>
      parseWebServerConfiguration({ ...base, SESSION_SIGNING_KEY: 'too-short' }),
    ).toThrow()
    expect(() =>
      parseWebServerConfiguration({
        ...base,
        TRASH_PALACE_EVIDENCE_SINK_PATH: 'evidence.jsonl',
      }),
    ).toThrow(/absolute JSONL/)
    expect(() =>
      parseWebServerConfiguration({
        ...base,
        TRASH_PALACE_DEV_SESSION_ENABLED: 'false',
        TRASH_PALACE_ALLOWED_ORIGIN: 'http://trash-palace.example',
      }),
    ).toThrow(/HTTPS.*loopback/i)
  })

  it('rejects every example placeholder secret before opening the database', () => {
    for (const key of [
      'SESSION_SIGNING_KEY',
      'TOOL_INVOCATION_SCOPE_KEY',
      'GATEWAY_CALLBACK_SIGNING_KEY',
      'IDENTITY_TELEMETRY_SIGNING_KEY',
      'TRASH_PALACE_EVIDENCE_ALIAS_KEY',
    ] as const) {
      expect(() =>
        parseWebServerConfiguration({ ...base, [key]: 'replace-with-a-random-32-byte-value' }),
      ).toThrow(/placeholder/)
    }
  })

  it('requires independent keys for signing, scoping, telemetry, and evidence purposes', () => {
    expect(() =>
      parseWebServerConfiguration({
        ...base,
        IDENTITY_TELEMETRY_SIGNING_KEY: base.GATEWAY_CALLBACK_SIGNING_KEY,
      }),
    ).toThrow(/independent secret/)
    expect(() =>
      parseWebServerConfiguration({
        ...base,
        TRASH_PALACE_EVIDENCE_ALIAS_KEY: base.TOOL_INVOCATION_SCOPE_KEY,
      }),
    ).toThrow(/independent secret/)
  })

  it('fails closed on incompatible evidence provenance and malformed app versions', () => {
    expect(() =>
      parseWebServerConfiguration({
        ...base,
        TRASH_PALACE_ENVIRONMENT: 'local',
        TRASH_PALACE_EVIDENCE_ORIGIN: 'live',
      }),
    ).toThrow(/origin/i)
    expect(() =>
      parseWebServerConfiguration({ ...base, TRASH_PALACE_APP_VERSION: 'latest' }),
    ).toThrow(/semantic version/)
  })
})
