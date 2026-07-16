import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  CommandReceiptSchema,
  DeviceCommandSchema,
  ExplicitDeviceMappingInputSchema,
  LogicalDeviceSchema,
  createLightingPlan,
  deriveLightingChildCommandId,
} from '../contracts.js'
import {
  secret,
  type ProviderDeviceMapping,
  type SmartThingsWebhookRequest,
  type WebhookReceiptPort,
} from '../ports.js'
import { SmartThingsConnector } from '../smartthings-connector.js'
import {
  FixedClock,
  InMemoryCommandJournal,
  InMemoryLightingPlans,
  InMemoryLogicalDevices,
  InMemoryMappings,
  InMemoryUnlockAuthority,
  InMemoryVault,
  InMemoryWebhookReceipts,
  ToggleWebhookVerifier,
} from './fakes.js'

const NOW = new Date('2026-07-15T12:00:00.000Z')
const CONFIG = {
  oauth: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://trash.example.test/integrations/smartthings/callback',
  },
  webhookPath: '/integrations/smartthings/webhook',
}

function credential(tenantId = 'tenant-a') {
  return {
    tenantId,
    provider: 'smartthings' as const,
    accessToken: secret(`access-${tenantId}`),
    refreshToken: secret(`refresh-${tenantId}`),
    installedAppId: secret(`installed-${tenantId}`),
    accessTokenExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    scopes: ['r:devices:device-one', 'x:devices:device-one'],
  }
}

function mapping(overrides: Partial<ProviderDeviceMapping> = {}): ProviderDeviceMapping {
  return {
    tenantId: 'tenant-a',
    provider: 'smartthings',
    slotId: 'light-1',
    displayName: 'Entry light',
    providerDeviceId: secret('provider-device-light'),
    providerComponentId: secret('main'),
    kind: 'light',
    capabilities: ['light.power', 'light.brightness'],
    ...overrides,
  }
}

function acceptedResponse(): Response {
  return Response.json(
    { results: [{ id: 'provider-command-id', status: 'ACCEPTED' }] },
    { status: 200 },
  )
}

function statusResponse(input: {
  readonly power?: 'on' | 'off'
  readonly brightness?: number
  readonly lock?: 'locked' | 'unlocked' | 'jammed'
  readonly mode?: 'off' | 'heat' | 'cool' | 'auto' | 'emergency heat'
  readonly temperature?: { readonly value: number; readonly unit: 'C' | 'F' }
  readonly heating?: { readonly value: number; readonly unit: 'C' | 'F' }
  readonly cooling?: { readonly value: number; readonly unit: 'C' | 'F' }
}): Response {
  return Response.json({
    components: {
      main: {
        ...(input.power === undefined
          ? {}
          : { switch: { switch: { value: input.power, timestamp: NOW.toISOString() } } }),
        ...(input.brightness === undefined
          ? {}
          : {
              switchLevel: {
                level: { value: input.brightness, unit: '%', timestamp: NOW.toISOString() },
              },
            }),
        ...(input.lock === undefined
          ? {}
          : { lock: { lock: { value: input.lock, timestamp: NOW.toISOString() } } }),
        ...(input.mode === undefined
          ? {}
          : {
              thermostatMode: {
                thermostatMode: { value: input.mode, timestamp: NOW.toISOString() },
              },
            }),
        ...(input.temperature === undefined
          ? {}
          : {
              temperatureMeasurement: {
                temperature: { ...input.temperature, timestamp: NOW.toISOString() },
              },
            }),
        ...(input.heating === undefined
          ? {}
          : {
              thermostatHeatingSetpoint: {
                heatingSetpoint: { ...input.heating, timestamp: NOW.toISOString() },
              },
            }),
        ...(input.cooling === undefined
          ? {}
          : {
              thermostatCoolingSetpoint: {
                coolingSetpoint: { ...input.cooling, timestamp: NOW.toISOString() },
              },
            }),
        'vendor.privateTelemetry': {
          account: { value: 'must-not-leave-adapter' },
        },
      },
    },
  })
}

async function fixture(
  fetchMock: typeof fetch,
  input?: {
    readonly verifierValid?: boolean
    readonly clock?: FixedClock
    readonly webhookReceipts?: WebhookReceiptPort
  },
) {
  const vault = new InMemoryVault()
  await vault.create(credential())
  const clock = input?.clock ?? new FixedClock(NOW)
  const mappings = new InMemoryMappings()
  const unlockAuthority = new InMemoryUnlockAuthority()
  const lightingPlans = new InMemoryLightingPlans()
  const logicalDevices = new InMemoryLogicalDevices()
  const commandJournal = new InMemoryCommandJournal()
  const verifier = new ToggleWebhookVerifier(input?.verifierValid ?? true)
  const webhookReceipts = input?.webhookReceipts ?? new InMemoryWebhookReceipts()
  const connector = new SmartThingsConnector(CONFIG, {
    clock,
    commandJournal,
    fetch: fetchMock,
    lightingPlans,
    logicalDevices,
    mappings,
    unlockAuthority,
    vault,
    webhookReceipts,
    webhookVerifier: verifier,
  })
  return {
    connector,
    vault,
    clock,
    lightingPlans,
    logicalDevices,
    mappings,
    unlockAuthority,
    commandJournal,
    verifier,
    webhookReceipts,
  }
}

function webhookRequest(body: unknown): SmartThingsWebhookRequest {
  return {
    method: 'POST',
    path: CONFIG.webhookPath,
    authorization: 'Signature verified-at-port',
    digest: 'SHA256=verified-at-port',
    date: 'Wed, 15 Jul 2026 12:00:00 GMT',
    rawBody: JSON.stringify(body),
  }
}

function deviceWebhook(deviceId = 'provider-device-light'): unknown {
  return {
    messageType: 'EVENT',
    eventData: {
      installedApp: {
        installedAppId: 'installed-tenant-a',
        locationId: 'provider-location',
      },
      events: [
        {
          eventTime: NOW.toISOString(),
          eventType: 'DEVICE_EVENT',
          deviceEvent: {
            eventId: 'provider-event-id',
            locationId: 'provider-location',
            deviceId,
            componentId: 'main',
            capability: 'switch',
            attribute: 'switch',
            value: 'on',
            valueType: 'string',
            stateChange: true,
            subscriptionName: 'switchHandler',
          },
        },
      ],
    },
  }
}

describe('SmartThingsConnector discovery and status', () => {
  it('follows every provider page and returns opaque candidates without auto-mapping', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              deviceId: 'raw-device-id-one',
              name: 'private-model-name',
              label: "Rocky's private room label",
              components: [
                {
                  id: 'main',
                  capabilities: [
                    { id: 'switch', version: 1 },
                    { id: 'switchLevel', version: 1 },
                  ],
                  categories: [{ name: 'Light' }],
                },
              ],
            },
          ],
          _links: { next: { href: 'https://api.smartthings.com/v1/devices?max=200&page=2' } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              deviceId: 'raw-device-id-two',
              label: 'Private lock label',
              components: [{ id: 'main', capabilities: [{ id: 'lock', version: 1 }] }],
            },
          ],
          _links: {},
        }),
      )
    const { connector, logicalDevices, mappings } = await fixture(fetchMock)

    const candidates = await connector.discoverDevices('tenant-a')
    expect(candidates).toHaveLength(2)
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilities: ['light.power', 'light.brightness'] }),
        expect.objectContaining({ capabilities: ['lock.state'] }),
      ]),
    )
    expect(
      candidates.every((candidate) => /^stcand_[a-f0-9]{64}$/u.test(candidate.candidateId)),
    ).toBe(true)
    expect(mappings.mappings).toEqual([])
    expect(JSON.stringify(candidates)).not.toMatch(/raw-device|private|Rocky|kind|slotId/u)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const lightCandidate = candidates.find((candidate) =>
      candidate.capabilities.includes('light.power'),
    )
    if (lightCandidate === undefined) throw new Error('expected light candidate')
    const logicalLight = LogicalDeviceSchema.parse({
      slotId: 'entry-light',
      displayName: 'Entry light',
      kind: 'light',
      capabilities: ['light.power', 'light.brightness'],
    })
    logicalDevices.seed('tenant-a', logicalLight)
    await expect(
      connector.mapDiscoveredDevice({
        tenantId: 'tenant-a',
        candidateId: lightCandidate.candidateId,
        slotId: logicalLight.slotId,
        confirmedBy: 'human',
      }),
    ).resolves.toEqual(logicalLight)
    expect(mappings.mappings).toHaveLength(1)
  })

  it('rejects automatic, ambiguous, or non-existing logical-device mapping', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        items: [
          {
            deviceId: 'ambiguous-provider-device',
            components: [
              {
                id: 'main',
                capabilities: [
                  { id: 'switch', version: 1 },
                  { id: 'switchLevel', version: 1 },
                ],
                categories: [{ name: 'Light' }],
              },
            ],
          },
        ],
        _links: {},
      }),
    )
    const { connector, mappings } = await fixture(fetchMock)
    const [candidate] = await connector.discoverDevices('tenant-a')
    if (candidate === undefined) throw new Error('expected candidate')
    await expect(
      connector.mapDiscoveredDevice({
        tenantId: 'tenant-a',
        candidateId: candidate.candidateId,
        slotId: 'guessed-light',
        confirmedBy: 'human',
      }),
    ).rejects.toMatchObject({ code: 'provider_not_found' })
    expect(mappings.mappings).toEqual([])
    expect(
      ExplicitDeviceMappingInputSchema.safeParse({
        tenantId: 'tenant-a',
        candidateId: candidate.candidateId,
        slotId: 'guessed-light',
        confirmedBy: 'agent',
      }).success,
    ).toBe(false)
  })

  it('rejects a cross-origin pagination link before sending credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        items: [],
        _links: { next: { href: 'https://attacker.invalid/v1/devices?page=2' } },
      }),
    )
    const { connector } = await fixture(fetchMock)
    await expect(connector.discoverDevices('tenant-a')).rejects.toMatchObject({
      code: 'invalid_provider_response',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('projects allowlisted state and drops raw provider payload fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      statusResponse({ power: 'on', brightness: 37 }),
    )
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(mapping())

    const state = await connector.readDeviceState({ tenantId: 'tenant-a', slotId: 'light-1' })
    expect(state).toEqual({
      slotId: 'light-1',
      observedAt: NOW.toISOString(),
      source: 'provider_read',
      power: 'on',
      brightness: 37,
    })
    expect(JSON.stringify(state)).not.toContain('must-not-leave-adapter')
  })

  it('projects thermostat mode and ambient temperature as separate state', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      statusResponse({
        temperature: { value: 19.5, unit: 'C' },
        mode: 'emergency heat',
        heating: { value: 21, unit: 'C' },
      }),
    )
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(
      mapping({
        slotId: 'thermostat-1',
        displayName: 'Main thermostat',
        providerDeviceId: secret('provider-device-thermostat'),
        kind: 'thermostat',
        capabilities: ['thermostat.temperature', 'thermostat.mode', 'thermostat.heatingSetpoint'],
      }),
    )

    await expect(
      connector.readDeviceState({ tenantId: 'tenant-a', slotId: 'thermostat-1' }),
    ).resolves.toMatchObject({
      temperature: { value: 19.5, unit: 'C' },
      thermostatMode: 'emergency_heat',
      heatingSetpoint: { value: 21, unit: 'C' },
    })
  })

  it('rejects a mapping returned across a tenant boundary', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const { connector, mappings } = await fixture(fetchMock)
    mappings.getBySlot = async () => mapping({ tenantId: 'tenant-b' })
    await expect(
      connector.readDeviceState({ tenantId: 'tenant-a', slotId: 'light-1' }),
    ).rejects.toMatchObject({ code: 'tenant_boundary_violation' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies throttling from the documented reset header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        { private: 'provider detail' },
        { status: 429, headers: { 'x-ratelimit-reset': '1700' } },
      ),
    )
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(mapping())
    await expect(
      connector.readDeviceState({ tenantId: 'tenant-a', slotId: 'light-1' }),
    ).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
      retryAfterMs: 1700,
      message: 'provider_rate_limited',
    })
  })
})

describe('SmartThingsConnector command safety', () => {
  it('records ACCEPTED as non-terminal and deduplicates the connector command locally', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => acceptedResponse())
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(mapping())
    const plan = await connector.scheduleLighting({
      tenantId: 'tenant-a',
      parentCommandId: 'gcmd_light-0001',
      slotId: 'light-1',
      brightness: 42,
      durationSeconds: 120,
      startsAt: NOW.toISOString(),
    })
    const command = plan.steps[0]

    const first = await connector.dispatchCommand(command)
    const duplicate = await connector.dispatchCommand(command)
    expect(first).toEqual({
      commandId: command.commandId,
      slotId: command.slotId,
      status: 'accepted_non_terminal',
      reconciliationRequired: true,
    })
    expect(duplicate).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]?.[1]
    if (typeof init?.body !== 'string') {
      throw new Error('expected JSON command body')
    }
    expect(init.body).toBe(
      JSON.stringify({
        commands: [
          {
            component: 'main',
            capability: 'switch',
            command: 'on',
            arguments: [],
          },
        ],
      }),
    )
  })

  it('persists an unknown outcome after a command transport loss and never resends it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('socket closed after write')
    })
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(mapping())
    const plan = await connector.scheduleLighting({
      tenantId: 'tenant-a',
      parentCommandId: 'gcmd_light-0002',
      slotId: 'light-1',
      brightness: 20,
      durationSeconds: 120,
      startsAt: NOW.toISOString(),
    })
    const command = plan.steps[0]
    const first = await connector.dispatchCommand(command)
    const duplicate = await connector.dispatchCommand(command)
    expect(first.status).toBe('outcome_unknown')
    expect(duplicate).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not mark a command unknown when the provider definitively rejects refreshed auth', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'rotated-access',
          token_type: 'bearer',
          refresh_token: 'rotated-refresh',
          expires_in: 86_399,
          scope: 'r:devices:device-one x:devices:device-one',
          installed_app_id: 'installed-tenant-a',
        }),
      )
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    const { connector, mappings, commandJournal } = await fixture(fetchMock)
    mappings.seed(mapping())
    const plan = await connector.scheduleLighting({
      tenantId: 'tenant-a',
      parentCommandId: 'gcmd_auth-0001',
      slotId: 'light-1',
      brightness: 20,
      durationSeconds: 120,
      startsAt: NOW.toISOString(),
    })
    await expect(connector.dispatchCommand(plan.steps[0])).rejects.toMatchObject({
      code: 'authentication_required',
    })
    expect(
      await commandJournal.get({ tenantId: 'tenant-a', commandId: plan.steps[0].commandId }),
    ).toBeNull()
  })

  it('persists all deterministic lighting children before allowing the first step', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const { connector, lightingPlans, mappings } = await fixture(fetchMock)
    mappings.seed(mapping())
    const plan = await connector.scheduleLighting({
      tenantId: 'tenant-a',
      parentCommandId: 'gcmd_lighting-parent-01',
      slotId: 'light-1',
      brightness: 73,
      durationSeconds: 300,
      startsAt: NOW.toISOString(),
    })

    expect(plan.steps.map(({ lightingStep }) => lightingStep)).toEqual([
      'power_on',
      'set_brightness',
      'scheduled_power_off',
    ])
    expect(new Set(plan.steps.map(({ commandId }) => commandId)).size).toBe(3)
    expect(plan.steps[0].commandId).toBe(
      deriveLightingChildCommandId(plan.parentCommandId, 'power_on'),
    )
    expect(
      await lightingPlans.getByParent({
        tenantId: 'tenant-a',
        parentCommandId: plan.parentCommandId,
      }),
    ).toEqual(plan)
    await expect(connector.dispatchCommand(plan.steps[1])).rejects.toMatchObject({
      code: 'command_not_ready',
    })
    await expect(connector.dispatchCommand(plan.steps[2])).rejects.toMatchObject({
      code: 'command_not_ready',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a lighting child that was not atomically persisted with its siblings', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(mapping())
    const unpersisted = createLightingPlan({
      tenantId: 'tenant-a',
      parentCommandId: 'gcmd_unpersisted-light-01',
      slotId: 'light-1',
      brightness: 40,
      durationSeconds: 60,
      startsAt: NOW.toISOString(),
    })
    await expect(connector.dispatchCommand(unpersisted.steps[0])).rejects.toMatchObject({
      code: 'command_not_ready',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a core operation identifier where a unique gateway command is required', () => {
    expect(
      DeviceCommandSchema.safeParse({
        tenantId: 'tenant-a',
        operationId: 'op_parent-operation-01',
        slotId: 'lock-1',
        action: 'lock.lock',
      }).success,
    ).toBe(false)
  })

  it('conflicts when one gateway command ID is reused for a different provider command', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => acceptedResponse())
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(
      mapping({
        slotId: 'lock-1',
        displayName: 'Entry lock',
        providerDeviceId: secret('provider-device-lock'),
        kind: 'lock',
        capabilities: ['lock.state'],
      }),
    )
    const commandId = 'gcmd_unique-provider-call-01'
    await connector.dispatchCommand({
      tenantId: 'tenant-a',
      commandId,
      slotId: 'lock-1',
      action: 'lock.lock',
    })
    await expect(
      connector.dispatchCommand({
        tenantId: 'tenant-a',
        commandId,
        slotId: 'lock-1',
        action: 'lock.unlock',
        confirmationId: 'confirmation_0123456789abcdef',
      }),
    ).rejects.toMatchObject({ code: 'command_conflict' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('binds fresh unlock authority idempotently to one connector command without journaling it', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 403 }))
      .mockResolvedValueOnce(acceptedResponse())
    const { connector, commandJournal, mappings, unlockAuthority } = await fixture(fetchMock)
    mappings.seed(
      mapping({
        slotId: 'lock-1',
        displayName: 'Entry lock',
        providerDeviceId: secret('provider-device-lock'),
        kind: 'lock',
        capabilities: ['lock.state'],
      }),
    )
    const confirmationId = 'confirmation_0123456789abcdef'
    unlockAuthority.add(confirmationId, new Date(NOW.getTime() - 2 * 60 * 1000 - 1))
    await expect(
      connector.dispatchCommand({
        tenantId: 'tenant-a',
        commandId: 'gcmd_unlock-0001',
        slotId: 'lock-1',
        action: 'lock.unlock',
        confirmationId,
      }),
    ).rejects.toMatchObject({ code: 'human_confirmation_required' })
    expect(fetchMock).not.toHaveBeenCalled()

    unlockAuthority.add(confirmationId, new Date(NOW.getTime() - 30_000))
    const retryableCommand = {
      tenantId: 'tenant-a',
      commandId: 'gcmd_unlock-retry-01',
      slotId: 'lock-1',
      action: 'lock.unlock' as const,
      confirmationId,
    }
    await expect(connector.dispatchCommand(retryableCommand)).rejects.toMatchObject({
      code: 'provider_access_denied',
    })
    const accepted = await connector.dispatchCommand(retryableCommand)
    expect(accepted.status).toBe('accepted_non_terminal')
    const journaled = await commandJournal.get({
      tenantId: 'tenant-a',
      commandId: retryableCommand.commandId,
    })
    expect(journaled?.command).toEqual({
      tenantId: 'tenant-a',
      commandId: retryableCommand.commandId,
      slotId: 'lock-1',
      action: 'lock.unlock',
    })
    expect(JSON.stringify(journaled)).not.toContain(confirmationId)
    expect(JSON.stringify([...unlockAuthority.grants.values()])).not.toContain(confirmationId)
    await expect(
      connector.dispatchCommand({
        tenantId: 'tenant-a',
        commandId: 'gcmd_unlock-0003',
        slotId: 'lock-1',
        action: 'lock.unlock',
        confirmationId,
      }),
    ).rejects.toMatchObject({ code: 'human_confirmation_required' })
  })

  it('enforces product setpoint bounds and the device-reported temperature unit', async () => {
    expect(
      DeviceCommandSchema.safeParse({
        tenantId: 'tenant-a',
        commandId: 'gcmd_heat-0001',
        slotId: 'thermostat-1',
        action: 'thermostat.setHeatingSetpoint',
        value: 31,
        unit: 'C',
      }).success,
    ).toBe(false)
    expect(
      DeviceCommandSchema.safeParse({
        tenantId: 'tenant-a',
        commandId: 'gcmd_heat-0002',
        slotId: 'thermostat-1',
        action: 'thermostat.setHeatingSetpoint',
        value: 49,
        unit: 'F',
      }).success,
    ).toBe(false)

    const fetchMock = vi.fn<typeof fetch>(async () =>
      statusResponse({
        temperature: { value: 19, unit: 'C' },
        mode: 'heat',
        heating: { value: 21, unit: 'C' },
      }),
    )
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(
      mapping({
        slotId: 'thermostat-1',
        displayName: 'Main thermostat',
        providerDeviceId: secret('provider-device-thermostat'),
        kind: 'thermostat',
        capabilities: ['thermostat.temperature', 'thermostat.mode', 'thermostat.heatingSetpoint'],
      }),
    )
    await expect(
      connector.dispatchCommand({
        tenantId: 'tenant-a',
        commandId: 'gcmd_heat-0003',
        slotId: 'thermostat-1',
        action: 'thermostat.setHeatingSetpoint',
        value: 68,
        unit: 'F',
      }),
    ).rejects.toMatchObject({ code: 'thermostat_unit_mismatch' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('dispatches an in-range setpoint only after a matching-unit provider read', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        statusResponse({
          temperature: { value: 18, unit: 'C' },
          mode: 'heat',
          heating: { value: 19, unit: 'C' },
        }),
      )
      .mockResolvedValueOnce(acceptedResponse())
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(
      mapping({
        slotId: 'thermostat-1',
        displayName: 'Main thermostat',
        providerDeviceId: secret('provider-device-thermostat'),
        kind: 'thermostat',
        capabilities: ['thermostat.temperature', 'thermostat.mode', 'thermostat.heatingSetpoint'],
      }),
    )
    const receipt = await connector.dispatchCommand({
      tenantId: 'tenant-a',
      commandId: 'gcmd_heat-0004',
      slotId: 'thermostat-1',
      action: 'thermostat.setHeatingSetpoint',
      value: 20.5,
      unit: 'C',
    })
    expect(receipt.status).toBe('accepted_non_terminal')
    const commandRequest = fetchMock.mock.calls[1]?.[1]
    if (typeof commandRequest?.body !== 'string') {
      throw new Error('expected JSON command body')
    }
    expect(commandRequest.body).toContain('setHeatingSetpoint')
    expect(commandRequest.body).toContain('20.5')
  })

  it('does not verify a setpoint echo before the active-mode ambient temperature converges', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        statusResponse({
          temperature: { value: 18, unit: 'C' },
          mode: 'heat',
          heating: { value: 19, unit: 'C' },
        }),
      )
      .mockResolvedValueOnce(acceptedResponse())
      .mockResolvedValueOnce(
        statusResponse({
          temperature: { value: 18.2, unit: 'C' },
          mode: 'heat',
          heating: { value: 20.5, unit: 'C' },
        }),
      )
      .mockResolvedValueOnce(
        statusResponse({
          temperature: { value: 20.2, unit: 'C' },
          mode: 'heat',
          heating: { value: 20.5, unit: 'C' },
        }),
      )
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(
      mapping({
        slotId: 'thermostat-1',
        displayName: 'Main thermostat',
        providerDeviceId: secret('provider-device-thermostat'),
        kind: 'thermostat',
        capabilities: ['thermostat.temperature', 'thermostat.mode', 'thermostat.heatingSetpoint'],
      }),
    )
    const command = {
      tenantId: 'tenant-a',
      commandId: 'gcmd_heat-converge-01',
      slotId: 'thermostat-1',
      action: 'thermostat.setHeatingSetpoint' as const,
      value: 20.5,
      unit: 'C' as const,
    }
    const accepted = await connector.dispatchCommand(command)
    expect(accepted.status).toBe('accepted_non_terminal')
    const premature = await connector.reconcileCommand({
      tenantId: 'tenant-a',
      commandId: command.commandId,
    })
    expect(premature.status).toBe('accepted_non_terminal')
    const converged = await connector.reconcileCommand({
      tenantId: 'tenant-a',
      commandId: command.commandId,
    })
    expect(converged.status).toBe('verified')
  })

  it('rejects a setpoint command when the thermostat mode cannot drive toward it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      statusResponse({
        temperature: { value: 19, unit: 'C' },
        mode: 'off',
        heating: { value: 19, unit: 'C' },
      }),
    )
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(
      mapping({
        slotId: 'thermostat-1',
        displayName: 'Main thermostat',
        providerDeviceId: secret('provider-device-thermostat'),
        kind: 'thermostat',
        capabilities: ['thermostat.temperature', 'thermostat.mode', 'thermostat.heatingSetpoint'],
      }),
    )
    await expect(
      connector.dispatchCommand({
        tenantId: 'tenant-a',
        commandId: 'gcmd_heat-mode-off-01',
        slotId: 'thermostat-1',
        action: 'thermostat.setHeatingSetpoint',
        value: 20,
        unit: 'C',
      }),
    ).rejects.toMatchObject({ code: 'thermostat_mode_mismatch' })
  })

  it.each([
    { action: 'light.setBrightness', brightness: -1 },
    { action: 'light.setBrightness', brightness: 101 },
    { action: 'lock.open' },
    { action: 'light.setPower', power: 'toggle' },
    { action: 'light.setPower', power: 'on', providerDeviceId: 'injection' },
  ])('rejects malformed or non-allowlisted command %#', (mutation) => {
    expect(
      DeviceCommandSchema.safeParse({
        tenantId: 'tenant-a',
        commandId: 'gcmd_mutation-0001',
        slotId: 'light-1',
        ...mutation,
      }).success,
    ).toBe(false)
  })

  it('rejects contradictory public device and receipt projections', () => {
    expect(
      LogicalDeviceSchema.safeParse({
        slotId: 'lock-1',
        displayName: 'Entry lock',
        kind: 'lock',
        capabilities: ['light.power'],
      }).success,
    ).toBe(false)
    expect(
      CommandReceiptSchema.safeParse({
        commandId: 'gcmd_invalid-0001',
        slotId: 'light-1',
        status: 'verified',
        reconciliationRequired: true,
      }).success,
    ).toBe(false)
  })
})

describe('SmartThingsConnector webhook reconciliation', () => {
  it('rejects unsigned callbacks before parsing or reading devices', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const { connector, vault } = await fixture(fetchMock, { verifierValid: false })
    const resolveInstallation = vi.spyOn(vault, 'resolveInstallation')
    await expect(
      connector.handleWebhook(webhookRequest('not parsed before signature verification')),
    ).rejects.toMatchObject({ code: 'webhook_verification_failed' })
    expect(resolveInstallation).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses a provider read after a webhook and marks matching operations verified', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(acceptedResponse())
      .mockResolvedValueOnce(statusResponse({ power: 'on' }))
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(mapping())
    const plan = await connector.scheduleLighting({
      tenantId: 'tenant-a',
      parentCommandId: 'gcmd_webhook-0001',
      slotId: 'light-1',
      brightness: 60,
      durationSeconds: 120,
      startsAt: NOW.toISOString(),
    })
    await connector.dispatchCommand(plan.steps[0])

    const request = webhookRequest(deviceWebhook())
    const result = await connector.handleWebhook(request)
    expect(result).toEqual({
      kind: 'device_updates',
      states: [
        {
          slotId: 'light-1',
          observedAt: NOW.toISOString(),
          source: 'webhook_then_provider_read',
          power: 'on',
        },
      ],
      verifiedCommandIds: [plan.steps[0].commandId],
    })
    expect(JSON.stringify(result)).not.toMatch(/provider-device|provider-event|installed-/u)
    expect(await connector.handleWebhook(request)).toEqual({ kind: 'duplicate' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('releases a failed webhook claim so a provider-read retry can succeed', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce(statusResponse({ power: 'off' }))
    const { connector, mappings } = await fixture(fetchMock)
    mappings.seed(mapping())
    const request = webhookRequest(deviceWebhook())

    await expect(connector.handleWebhook(request)).rejects.toMatchObject({
      code: 'provider_temporarily_unavailable',
      retryable: true,
    })
    await expect(connector.handleWebhook(request)).resolves.toMatchObject({
      kind: 'device_updates',
      states: [{ slotId: 'light-1', power: 'off' }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns a retryable busy result while the same webhook lease is active', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const receipts = new InMemoryWebhookReceipts()
    const { connector } = await fixture(fetchMock, { webhookReceipts: receipts })
    const request = webhookRequest(deviceWebhook())
    await receipts.claim({
      tenantId: 'tenant-a',
      eventDigest: createHash('sha256').update(request.rawBody).digest('hex'),
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    })

    await expect(connector.handleWebhook(request)).rejects.toMatchObject({
      code: 'provider_temporarily_unavailable',
      retryable: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an installed-app identifier from another tenant', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const { connector } = await fixture(fetchMock)
    const body = deviceWebhook() as {
      eventData: { installedApp: { installedAppId: string } }
    }
    body.eventData.installedApp.installedAppId = 'installed-tenant-b'
    await expect(connector.handleWebhook(webhookRequest(body))).rejects.toMatchObject({
      code: 'tenant_boundary_violation',
    })
  })

  it('revokes the tenant credential on a verified SmartThings DELETE lifecycle event', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const { connector, vault } = await fixture(fetchMock)
    const result = await connector.handleWebhook(
      webhookRequest({
        messageType: 'EVENT',
        eventData: {
          installedApp: {
            installedAppId: 'installed-tenant-a',
            locationId: 'provider-location',
          },
          events: [
            {
              eventTime: NOW.toISOString(),
              eventType: 'INSTALLED_APP_LIFECYCLE_EVENT',
              installedAppLifecycleEvent: {
                eventId: 'provider-delete-event',
                locationId: 'provider-location',
                installedAppId: 'installed-tenant-a',
                appId: 'provider-app-id',
                lifecycle: 'DELETE',
                delete: {},
              },
            },
          ],
        },
      }),
    )
    expect(result).toEqual({ kind: 'disconnected' })
    expect(await vault.load('tenant-a')).toBeNull()
    expect(vault.revoked).toEqual(['tenant-a'])
  })

  it('releases a DELETE claim when credential revocation fails, then retries safely', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const { connector, vault } = await fixture(fetchMock)
    const originalRevoke = vault.revoke.bind(vault)
    let fail = true
    vault.revoke = async (input) => {
      if (fail) {
        fail = false
        return false
      }
      return originalRevoke(input)
    }
    const request = webhookRequest(deleteWebhook())

    await expect(connector.handleWebhook(request)).rejects.toMatchObject({
      code: 'tenant_boundary_violation',
    })
    await expect(connector.handleWebhook(request)).resolves.toEqual({
      kind: 'disconnected',
    })
    expect(await vault.load('tenant-a')).toBeNull()
  })

  it('recovers an expired claim after credentials were already revoked before completion', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const clock = new FixedClock(NOW)
    const receipts = new InMemoryWebhookReceipts()
    const { connector, vault } = await fixture(fetchMock, {
      clock,
      webhookReceipts: receipts,
    })
    const request = webhookRequest(deleteWebhook())
    const eventDigest = createHash('sha256').update(request.rawBody).digest('hex')
    await receipts.claim({
      tenantId: 'tenant-a',
      eventDigest,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 1),
    })
    expect(
      await vault.revoke({
        tenantId: 'tenant-a',
        installedAppId: secret('installed-tenant-a'),
      }),
    ).toBe(true)
    clock.current = new Date(NOW.getTime() + 2)

    await expect(connector.handleWebhook(request)).resolves.toEqual({
      kind: 'disconnected',
    })
    expect(
      await vault.installationStatus({
        tenantId: 'tenant-a',
        installedAppId: secret('installed-tenant-a'),
      }),
    ).toBe('revoked')
  })
})

function deleteWebhook(): unknown {
  return {
    messageType: 'EVENT',
    eventData: {
      installedApp: {
        installedAppId: 'installed-tenant-a',
        locationId: 'provider-location',
      },
      events: [
        {
          eventTime: NOW.toISOString(),
          eventType: 'INSTALLED_APP_LIFECYCLE_EVENT',
          installedAppLifecycleEvent: {
            eventId: 'provider-delete-event',
            locationId: 'provider-location',
            installedAppId: 'installed-tenant-a',
            appId: 'provider-app-id',
            lifecycle: 'DELETE',
            delete: {},
          },
        },
      ],
    },
  }
}
