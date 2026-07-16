import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ClockPort } from '@trash-palace/application'
import {
  FLAGSHIP_CLOCK_PAUSED_AT,
  FLAGSHIP_CLOCK_RUNNING_AT,
  FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  UserIdSchema,
} from '@trash-palace/core'

import { createProductionHttpApiRuntime, createWebRuntimeClocks } from './production-runtime.js'

class MutableSecurityClock implements ClockPort {
  public constructor(public current: string) {}

  public now(): Date {
    return new Date(this.current)
  }
}

const REAL_START_AT = '2026-07-15T12:00:00.000Z'

describe('production web runtime clocks', () => {
  it('uses one accelerated domain clock without accelerating security time', () => {
    const security = new MutableSecurityClock('2026-07-15T11:59:59.999Z')
    const clocks = createWebRuntimeClocks({ mode: 'fixture', realStartAt: REAL_START_AT }, security)

    expect(clocks.security).toBe(security)
    expect(clocks.domain).not.toBe(security)
    expect(clocks.domain.now().toISOString()).toBe(new Date(FLAGSHIP_CLOCK_PAUSED_AT).toISOString())

    security.current = new Date(
      Date.parse(REAL_START_AT) + FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
    ).toISOString()

    expect(clocks.security.now().toISOString()).toBe(
      new Date(
        Date.parse(REAL_START_AT) + FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
      ).toISOString(),
    )
    expect(clocks.domain.now().toISOString()).toBe(
      new Date(Date.parse(FLAGSHIP_CLOCK_RUNNING_AT) + 60_000).toISOString(),
    )
    expect(clocks.domain).toBe(clocks.domain)
  })

  it('uses the security clock unchanged when fixture mode is disabled', () => {
    const security = new MutableSecurityClock(REAL_START_AT)

    expect(createWebRuntimeClocks({ mode: 'system' }, security)).toEqual({
      security,
      domain: security,
    })
  })

  it('composes the complete fixture runtime before any dependency is contacted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trash-palace-web-runtime-'))
    const runtime = createProductionHttpApiRuntime({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://trash:palace@127.0.0.1:1/trash_palace',
      SESSION_SIGNING_KEY: 'session-purpose-secret-is-at-least-32-bytes',
      TOOL_INVOCATION_SCOPE_KEY: 'tool-scope-purpose-secret-is-at-least-32-bytes',
      GATEWAY_CALLBACK_SIGNING_KEY: 'callback-purpose-secret-is-at-least-32-bytes',
      GATEWAY_CALLBACK_SIGNING_KEY_ID: 'gwk_local_gateway',
      IDENTITY_TELEMETRY_SIGNING_KEY: 'identity-purpose-secret-is-at-least-32-bytes',
      IDENTITY_TELEMETRY_SIGNING_KEY_ID: 'itk_local_identity',
      IDENTITY_TELEMETRY_PRINCIPAL_ID: 'itp_local_identity',
      TRASH_PALACE_EVIDENCE_ALIAS_KEY: 'evidence-purpose-secret-is-at-least-32-bytes',
      TRASH_PALACE_EVIDENCE_SINK_PATH: join(directory, 'evidence.jsonl'),
      TRASH_PALACE_LOCAL_ORGANIZATION_ID: 'org_rocky_roost',
      TRASH_PALACE_LOCAL_PALACE_ID: 'pal_sacred_dumpster',
      TRASH_PALACE_CLOCK_MODE: 'fixture',
      TRASH_PALACE_FIXTURE_REAL_START_AT: REAL_START_AT,
      TRASH_PALACE_ALLOWED_ORIGIN: 'https://trash-palace.example',
      TRASH_PALACE_DEV_SESSION_ENABLED: 'false',
    })

    try {
      const frozen = runtime.observability.freezeProduct({
        event: 'mission created',
        logicalEventId: EventIdSchema.parse('evt_web_runtime_001'),
        occurredAt: '2026-07-15T02:00:00.000Z',
        correlation: {
          distinctId: UserIdSchema.parse('usr_web_runtime01'),
          actorId: UserIdSchema.parse('usr_web_runtime01'),
          organizationId: OrganizationIdSchema.parse('org_rocky_roost'),
          palaceId: PalaceIdSchema.parse('pal_sacred_dumpster'),
          missionId: MissionIdSchema.parse('mis_web_runtime01'),
        },
        properties: {
          source_surface: 'fixture',
          objective_class: 'homecoming_routine',
        },
      })
      expect(frozen.event.event).toBe('mission created')
      await expect(access(join(directory, 'evidence.jsonl'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await runtime.close()
      await expect(runtime.isReady()).resolves.toBe(false)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
