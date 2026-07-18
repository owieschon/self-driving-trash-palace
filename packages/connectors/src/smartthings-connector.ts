import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  CommandReceiptSchema,
  ConnectorCommandIdSchema,
  DeviceCommandSchema,
  DiscoveryCandidateSchema,
  ExplicitDeviceMappingInputSchema,
  LightingPlanRequestSchema,
  LightingPlanSchema,
  LogicalDeviceSchema,
  LogicalDeviceStateSchema,
  LogicalSlotIdSchema,
  PersistedDeviceCommandSchema,
  TenantIdSchema,
  WebhookResultSchema,
  createLightingPlan,
  type CommandReceipt,
  type ConnectorCapability,
  type DeviceCommand,
  type DeviceConnectorPort,
  type DiscoveryCandidate,
  type ExplicitDeviceMappingInput,
  type LightingPlan,
  type LightingPlanRequest,
  type LogicalDevice,
  type LogicalDeviceState,
  type PersistedDeviceCommand,
  type WebhookResult,
} from './contracts.js'
import { ConnectorError } from './errors.js'
import type {
  CommandJournalPort,
  ConnectorClockPort,
  CredentialVaultPort,
  DeviceMappingPort,
  LightingPlanStorePort,
  LogicalDeviceCatalogPort,
  ProviderDeviceMapping,
  ProviderCredential,
  SecretString,
  SmartThingsWebhookRequest,
  UnlockAuthorityPort,
  WebhookReceiptPort,
  WebhookSignatureVerifierPort,
} from './ports.js'
import { secret } from './ports.js'
import { SmartThingsTokenManager, type SmartThingsOAuthConfig } from './smartthings-oauth.js'
import { SmartThingsWebhookSignatureVerifier } from './smartthings-webhook-verifier.js'
import {
  SmartThingsCommandResponseSchema,
  SmartThingsDevicePageSchema,
  SmartThingsDeviceStatusSchema,
  SmartThingsWebhookEventSchema,
  type SmartThingsDevice,
  type SmartThingsDeviceStatus,
  type SmartThingsWebhookEvent,
} from './smartthings-schemas.js'

const SMARTTHINGS_API_ORIGIN = 'https://api.smartthings.com'
const FIRST_DEVICE_PAGE = `${SMARTTHINGS_API_ORIGIN}/v1/devices?max=200`
const MAX_DEVICE_PAGES = 100
const MAX_UNLOCK_CONFIRMATION_AGE_MS = 2 * 60 * 1000
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000
const MAX_WEBHOOK_FUTURE_SKEW_MS = 60 * 1000
const WEBHOOK_PROCESSING_LEASE_MS = 60 * 1000
const CELSIUS_AMBIENT_TOLERANCE = 0.5
const FAHRENHEIT_AMBIENT_TOLERANCE = 1

const SmartThingsConnectorConfigSchema = z
  .object({
    oauth: z
      .object({
        clientId: z.string().min(1).max(512),
        clientSecret: z.string().min(1).max(4096),
        redirectUri: z.url().refine((value) => new URL(value).protocol === 'https:'),
      })
      .strict(),
    webhookPath: z
      .string()
      .min(1)
      .max(512)
      .regex(/^\/(?:[a-zA-Z0-9._~-]+\/?)+$/),
  })
  .strict()

const SmartThingsWebhookRequestSchema = z
  .object({
    method: z.literal('POST'),
    path: z.string().min(1).max(512),
    authorization: z.string().min(1).max(16_384),
    digest: z.string().min(1).max(1024),
    date: z.string().min(1).max(256),
    rawBody: z.string().min(1).max(1_048_576),
  })
  .strict()

const ReadDeviceInputSchema = z
  .object({
    tenantId: TenantIdSchema,
    slotId: LogicalSlotIdSchema,
  })
  .strict()

const ReconcileInputSchema = z
  .object({
    tenantId: TenantIdSchema,
    commandId: ConnectorCommandIdSchema,
  })
  .strict()

export interface SmartThingsConnectorConfig {
  readonly oauth: SmartThingsOAuthConfig
  readonly webhookPath: string
}

interface SmartThingsConnectorDependencies {
  readonly clock: ConnectorClockPort
  readonly commandJournal: CommandJournalPort
  readonly fetch: typeof fetch
  readonly lightingPlans: LightingPlanStorePort
  readonly logicalDevices: LogicalDeviceCatalogPort
  readonly mappings: DeviceMappingPort
  readonly unlockAuthority: UnlockAuthorityPort
  readonly vault: CredentialVaultPort
  readonly webhookReceipts: WebhookReceiptPort
  readonly webhookVerifier?: WebhookSignatureVerifierPort
}

interface ProviderCommand {
  readonly component: string
  readonly capability: string
  readonly command: string
  readonly arguments: readonly (number | string)[]
}

interface SmartThingsAttribute {
  readonly value: string | number | boolean | null
  readonly unit?: string | undefined
  readonly timestamp?: string | undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function commandDigest(command: PersistedDeviceCommand): string {
  return sha256(JSON.stringify(command))
}

function rateLimitDelay(response: Response): number | undefined {
  const raw = response.headers.get('x-ratelimit-reset')
  if (raw === null || !/^\d+$/u.test(raw)) {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? Math.min(value, 86_400_000) : undefined
}

function assertSafeNextPage(href: string): string {
  const next = new URL(href)
  if (
    next.origin !== SMARTTHINGS_API_ORIGIN ||
    next.pathname !== '/v1/devices' ||
    next.username !== '' ||
    next.password !== '' ||
    next.hash !== ''
  ) {
    throw new ConnectorError({ code: 'invalid_provider_response' })
  }
  return next.toString()
}

function publicCapabilities(
  input: readonly string[],
  categories: readonly string[],
): readonly ConnectorCapability[] {
  const capabilities = new Set(input)
  const projected: ConnectorCapability[] = []
  if (capabilities.has('lock')) {
    projected.push('lock.state')
  }

  if (
    capabilities.has('thermostatHeatingSetpoint') ||
    capabilities.has('thermostatCoolingSetpoint')
  ) {
    if (capabilities.has('temperatureMeasurement')) {
      projected.push('thermostat.temperature')
    }
    if (capabilities.has('thermostatMode')) {
      projected.push('thermostat.mode')
    }
    if (capabilities.has('thermostatHeatingSetpoint')) {
      projected.push('thermostat.heatingSetpoint')
    }
    if (capabilities.has('thermostatCoolingSetpoint')) {
      projected.push('thermostat.coolingSetpoint')
    }
  }

  if (capabilities.has('switch') && categories.includes('Light')) {
    projected.push('light.power')
    if (capabilities.has('switchLevel')) {
      projected.push('light.brightness')
    }
  }

  return [...new Set(projected)]
}

function projectComponents(device: SmartThingsDevice): readonly {
  readonly providerDeviceId: SecretString
  readonly providerComponentId: SecretString
  readonly capabilities: readonly ConnectorCapability[]
}[] {
  const projected: {
    providerDeviceId: SecretString
    providerComponentId: SecretString
    capabilities: readonly ConnectorCapability[]
  }[] = []

  for (const component of device.components) {
    const capabilities = publicCapabilities(
      component.capabilities.map(({ id }) => id),
      (component.categories ?? []).map(({ name }) => name),
    )
    if (capabilities.length > 0) {
      projected.push({
        providerDeviceId: secret(device.deviceId),
        providerComponentId: secret(component.id),
        capabilities,
      })
    }
  }
  return projected
}

function assertMapping(
  mapping: ProviderDeviceMapping,
  expected: { readonly tenantId: string; readonly slotId?: string },
): void {
  if (
    mapping.tenantId !== expected.tenantId ||
    (expected.slotId !== undefined && mapping.slotId !== expected.slotId)
  ) {
    throw new ConnectorError({ code: 'tenant_boundary_violation' })
  }
}

function attribute(
  status: SmartThingsDeviceStatus,
  componentId: string,
  capability: string,
  name: string,
): SmartThingsAttribute | undefined {
  return status.components[componentId]?.[capability]?.[name]
}

function temperatureValue(
  value: SmartThingsAttribute | undefined,
): { readonly value: number; readonly unit: 'C' | 'F' } | undefined {
  if (
    value === undefined ||
    typeof value.value !== 'number' ||
    (value.unit !== 'C' && value.unit !== 'F')
  ) {
    return undefined
  }
  return { value: value.value, unit: value.unit }
}

function thermostatMode(
  value: SmartThingsAttribute | undefined,
): 'off' | 'heat' | 'cool' | 'auto' | 'emergency_heat' | undefined {
  if (value?.value === 'emergency heat') return 'emergency_heat'
  if (
    value?.value === 'off' ||
    value?.value === 'heat' ||
    value?.value === 'cool' ||
    value?.value === 'auto'
  ) {
    return value.value
  }
  return undefined
}

function projectStatus(input: {
  readonly mapping: ProviderDeviceMapping
  readonly status: SmartThingsDeviceStatus
  readonly observedAt: Date
  readonly source: 'provider_read' | 'webhook_then_provider_read'
}): LogicalDeviceState {
  const componentId = input.mapping.providerComponentId
  const power = attribute(input.status, componentId, 'switch', 'switch')?.value
  const brightness = attribute(input.status, componentId, 'switchLevel', 'level')?.value
  const lock = attribute(input.status, componentId, 'lock', 'lock')?.value
  const mode = thermostatMode(
    attribute(input.status, componentId, 'thermostatMode', 'thermostatMode'),
  )
  const state = {
    slotId: input.mapping.slotId,
    observedAt: input.observedAt.toISOString(),
    source: input.source,
    ...(power === 'on' || power === 'off' ? { power } : {}),
    ...(typeof brightness === 'number' && Number.isInteger(brightness) ? { brightness } : {}),
    ...(lock === 'locked' || lock === 'unlocked' || lock === 'jammed'
      ? { lock }
      : input.mapping.kind === 'lock'
        ? { lock: 'unknown' as const }
        : {}),
    ...(mode === undefined ? {} : { thermostatMode: mode }),
    ...(temperatureValue(
      attribute(input.status, componentId, 'temperatureMeasurement', 'temperature'),
    ) === undefined
      ? {}
      : {
          temperature: temperatureValue(
            attribute(input.status, componentId, 'temperatureMeasurement', 'temperature'),
          ),
        }),
    ...(temperatureValue(
      attribute(input.status, componentId, 'thermostatHeatingSetpoint', 'heatingSetpoint'),
    ) === undefined
      ? {}
      : {
          heatingSetpoint: temperatureValue(
            attribute(input.status, componentId, 'thermostatHeatingSetpoint', 'heatingSetpoint'),
          ),
        }),
    ...(temperatureValue(
      attribute(input.status, componentId, 'thermostatCoolingSetpoint', 'coolingSetpoint'),
    ) === undefined
      ? {}
      : {
          coolingSetpoint: temperatureValue(
            attribute(input.status, componentId, 'thermostatCoolingSetpoint', 'coolingSetpoint'),
          ),
        }),
  }
  return LogicalDeviceStateSchema.parse(state)
}

function requiredCapability(command: DeviceCommand): ConnectorCapability {
  switch (command.action) {
    case 'light.setPower':
      return 'light.power'
    case 'light.setBrightness':
      return 'light.brightness'
    case 'lock.lock':
    case 'lock.unlock':
      return 'lock.state'
    case 'thermostat.setHeatingSetpoint':
      return 'thermostat.heatingSetpoint'
    case 'thermostat.setCoolingSetpoint':
      return 'thermostat.coolingSetpoint'
  }
}

function toProviderCommand(command: DeviceCommand, component: SecretString): ProviderCommand {
  switch (command.action) {
    case 'light.setPower':
      return {
        component,
        capability: 'switch',
        command: command.power,
        arguments: [],
      }
    case 'light.setBrightness':
      return {
        component,
        capability: 'switchLevel',
        command: 'setLevel',
        arguments: [command.brightness],
      }
    case 'lock.lock':
      return { component, capability: 'lock', command: 'lock', arguments: [] }
    case 'lock.unlock':
      return { component, capability: 'lock', command: 'unlock', arguments: [] }
    case 'thermostat.setHeatingSetpoint':
      return {
        component,
        capability: 'thermostatHeatingSetpoint',
        command: 'setHeatingSetpoint',
        arguments: [command.value],
      }
    case 'thermostat.setCoolingSetpoint':
      return {
        component,
        capability: 'thermostatCoolingSetpoint',
        command: 'setCoolingSetpoint',
        arguments: [command.value],
      }
  }
}

function ambientMatchesSetpoint(
  state: LogicalDeviceState,
  command: Extract<
    PersistedDeviceCommand,
    {
      readonly action: 'thermostat.setHeatingSetpoint' | 'thermostat.setCoolingSetpoint'
    }
  >,
): boolean {
  if (state.temperature?.unit !== command.unit) return false
  const tolerance = command.unit === 'C' ? CELSIUS_AMBIENT_TOLERANCE : FAHRENHEIT_AMBIENT_TOLERANCE
  return Math.abs(state.temperature.value - command.value) <= tolerance
}

function commandMatchesState(command: PersistedDeviceCommand, state: LogicalDeviceState): boolean {
  switch (command.action) {
    case 'light.setPower':
      return state.power === command.power
    case 'light.setBrightness':
      return state.brightness === command.brightness
    case 'lock.lock':
      return state.lock === 'locked'
    case 'lock.unlock':
      return state.lock === 'unlocked'
    case 'thermostat.setHeatingSetpoint':
      return (
        state.heatingSetpoint?.value === command.value &&
        state.heatingSetpoint.unit === command.unit &&
        (state.thermostatMode === 'heat' ||
          state.thermostatMode === 'auto' ||
          state.thermostatMode === 'emergency_heat') &&
        ambientMatchesSetpoint(state, command)
      )
    case 'thermostat.setCoolingSetpoint':
      return (
        state.coolingSetpoint?.value === command.value &&
        state.coolingSetpoint.unit === command.unit &&
        (state.thermostatMode === 'cool' || state.thermostatMode === 'auto') &&
        ambientMatchesSetpoint(state, command)
      )
  }
}

function sanitizeCommand(command: DeviceCommand): PersistedDeviceCommand {
  if (command.action !== 'lock.unlock') {
    return PersistedDeviceCommandSchema.parse(command)
  }
  const { confirmationId: _confirmationId, ...persisted } = command
  return PersistedDeviceCommandSchema.parse(persisted)
}

export class SmartThingsConnector implements DeviceConnectorPort {
  readonly #config: z.infer<typeof SmartThingsConnectorConfigSchema>
  readonly #dependencies: SmartThingsConnectorDependencies & {
    readonly webhookVerifier: WebhookSignatureVerifierPort
  }
  readonly #tokens: SmartThingsTokenManager

  constructor(config: SmartThingsConnectorConfig, dependencies: SmartThingsConnectorDependencies) {
    this.#config = SmartThingsConnectorConfigSchema.parse(config)
    this.#dependencies = {
      ...dependencies,
      webhookVerifier: dependencies.webhookVerifier ?? new SmartThingsWebhookSignatureVerifier(),
    }
    this.#tokens = new SmartThingsTokenManager(config.oauth, {
      clock: dependencies.clock,
      fetch: dependencies.fetch,
      vault: dependencies.vault,
    })
  }

  async discoverDevices(tenantId: string): Promise<readonly DiscoveryCandidate[]> {
    const tenant = TenantIdSchema.parse(tenantId)
    const projected = new Map<string, DiscoveryCandidate>()
    const visited = new Set<string>()
    let nextPage: string | undefined = FIRST_DEVICE_PAGE
    let pages = 0

    while (nextPage !== undefined) {
      if (pages >= MAX_DEVICE_PAGES || visited.has(nextPage)) {
        throw new ConnectorError({ code: 'invalid_provider_response' })
      }
      visited.add(nextPage)
      pages += 1
      const response = await this.authorizedFetch(tenant, nextPage, { method: 'GET' })
      const page = await this.parseReadResponse(response, SmartThingsDevicePageSchema)
      for (const device of page.items) {
        for (const component of projectComponents(device)) {
          const candidate = await this.#dependencies.mappings.recordCandidate({
            tenantId: tenant,
            provider: 'smartthings',
            ...component,
          })
          if (candidate.tenantId !== tenant) {
            throw new ConnectorError({ code: 'tenant_boundary_violation' })
          }
          if (
            candidate.providerDeviceId !== component.providerDeviceId ||
            candidate.providerComponentId !== component.providerComponentId ||
            JSON.stringify(candidate.capabilities) !== JSON.stringify(component.capabilities)
          ) {
            throw new ConnectorError({ code: 'tenant_boundary_violation' })
          }
          const publicCandidate = DiscoveryCandidateSchema.parse({
            candidateId: candidate.candidateId,
            capabilities: candidate.capabilities,
          })
          projected.set(publicCandidate.candidateId, publicCandidate)
        }
      }
      nextPage = page._links.next?.href
      if (nextPage !== undefined) {
        nextPage = assertSafeNextPage(nextPage)
      }
    }

    return [...projected.values()].sort((left, right) =>
      left.candidateId.localeCompare(right.candidateId),
    )
  }

  async mapDiscoveredDevice(input: ExplicitDeviceMappingInput): Promise<LogicalDevice> {
    const parsed = ExplicitDeviceMappingInputSchema.parse(input)
    const candidate = await this.#dependencies.mappings.getCandidate({
      tenantId: parsed.tenantId,
      provider: 'smartthings',
      candidateId: parsed.candidateId,
    })
    if (candidate === null) {
      throw new ConnectorError({ code: 'provider_not_found' })
    }
    if (candidate.tenantId !== parsed.tenantId || candidate.candidateId !== parsed.candidateId) {
      throw new ConnectorError({ code: 'tenant_boundary_violation' })
    }
    const logicalDevice = await this.#dependencies.logicalDevices.get({
      tenantId: parsed.tenantId,
      slotId: parsed.slotId,
    })
    if (logicalDevice === null) {
      throw new ConnectorError({ code: 'provider_not_found' })
    }
    const existing = LogicalDeviceSchema.parse(logicalDevice)
    if (!existing.capabilities.every((capability) => candidate.capabilities.includes(capability))) {
      throw new ConnectorError({ code: 'unsupported_capability' })
    }
    const mapping = await this.#dependencies.mappings.mapCandidate({
      candidate,
      logicalDevice: existing,
      confirmedBy: parsed.confirmedBy,
    })
    assertMapping(mapping, { tenantId: parsed.tenantId, slotId: parsed.slotId })
    if (
      mapping.providerDeviceId !== candidate.providerDeviceId ||
      mapping.providerComponentId !== candidate.providerComponentId ||
      mapping.kind !== existing.kind ||
      mapping.displayName !== existing.displayName ||
      JSON.stringify(mapping.capabilities) !== JSON.stringify(existing.capabilities)
    ) {
      throw new ConnectorError({ code: 'tenant_boundary_violation' })
    }
    return existing
  }

  async scheduleLighting(input: LightingPlanRequest): Promise<LightingPlan> {
    const parsed = LightingPlanRequestSchema.parse(input)
    const mapping = await this.mappingForSlot(parsed.tenantId, parsed.slotId)
    if (
      mapping.kind !== 'light' ||
      !mapping.capabilities.includes('light.power') ||
      !mapping.capabilities.includes('light.brightness')
    ) {
      throw new ConnectorError({ code: 'unsupported_capability' })
    }
    const plan = createLightingPlan(parsed)
    const claim = await this.#dependencies.lightingPlans.claim(plan)
    if (claim.kind === 'conflict') {
      throw new ConnectorError({ code: 'command_conflict' })
    }
    return LightingPlanSchema.parse(claim.plan)
  }

  async readDeviceState(input: {
    readonly tenantId: string
    readonly slotId: string
  }): Promise<LogicalDeviceState> {
    const parsed = ReadDeviceInputSchema.parse(input)
    const mapping = await this.mappingForSlot(parsed.tenantId, parsed.slotId)
    return this.readMappedDevice(mapping, 'provider_read')
  }

  async dispatchCommand(input: DeviceCommand): Promise<CommandReceipt> {
    const command = DeviceCommandSchema.parse(input)
    const persistedCommand = sanitizeCommand(command)
    const digest = commandDigest(persistedCommand)
    const mapping = await this.mappingForSlot(command.tenantId, command.slotId)
    if (!mapping.capabilities.includes(requiredCapability(command))) {
      throw new ConnectorError({ code: 'unsupported_capability' })
    }
    await this.assertLightingStepReady(command)

    const claimed = await this.#dependencies.commandJournal.claim({
      tenantId: command.tenantId,
      commandId: command.commandId,
      slotId: command.slotId,
      commandDigest: digest,
      command: persistedCommand,
    })
    if (claimed.kind === 'conflict') {
      throw new ConnectorError({ code: 'command_conflict' })
    }
    if (claimed.kind === 'existing') {
      return (
        claimed.record.receipt ??
        CommandReceiptSchema.parse({
          commandId: command.commandId,
          slotId: command.slotId,
          status: 'outcome_unknown',
          reconciliationRequired: true,
        })
      )
    }

    try {
      await this.assertCommandSafety(command, mapping)
    } catch (error) {
      await this.#dependencies.commandJournal.abandon({
        tenantId: command.tenantId,
        commandId: command.commandId,
        commandDigest: digest,
      })
      throw error
    }

    const providerCommand = toProviderCommand(command, mapping.providerComponentId)
    const commandUrl = `${SMARTTHINGS_API_ORIGIN}/v1/devices/${encodeURIComponent(
      mapping.providerDeviceId,
    )}/commands`
    let response: Response
    try {
      response = await this.authorizedFetch(
        command.tenantId,
        commandUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json;charset=utf-8' },
          body: JSON.stringify({ commands: [providerCommand] }),
        },
        true,
      )
    } catch (error) {
      const receipt = CommandReceiptSchema.parse({
        commandId: command.commandId,
        slotId: command.slotId,
        status: 'outcome_unknown',
        reconciliationRequired: true,
      })
      await this.#dependencies.commandJournal.saveReceipt({
        tenantId: command.tenantId,
        commandId: command.commandId,
        commandDigest: digest,
        receipt,
      })
      if (error instanceof ConnectorError && error.outcome === 'definitely_not_sent') {
        await this.#dependencies.commandJournal.abandon({
          tenantId: command.tenantId,
          commandId: command.commandId,
          commandDigest: digest,
        })
        throw error
      }
      return receipt
    }

    if (
      response.status === 401 ||
      response.status === 429 ||
      response.status === 400 ||
      response.status === 403 ||
      response.status === 404
    ) {
      await this.#dependencies.commandJournal.abandon({
        tenantId: command.tenantId,
        commandId: command.commandId,
        commandDigest: digest,
      })
      this.throwForReadResponse(response)
    }
    if (!response.ok) {
      const receipt = CommandReceiptSchema.parse({
        commandId: command.commandId,
        slotId: command.slotId,
        status: 'outcome_unknown',
        reconciliationRequired: true,
      })
      await this.#dependencies.commandJournal.saveReceipt({
        tenantId: command.tenantId,
        commandId: command.commandId,
        commandDigest: digest,
        receipt,
      })
      return receipt
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = null
    }
    const parsedResponse = SmartThingsCommandResponseSchema.safeParse(body)
    if (!parsedResponse.success || parsedResponse.data.results.length !== 1) {
      const receipt = CommandReceiptSchema.parse({
        commandId: command.commandId,
        slotId: command.slotId,
        status: 'outcome_unknown',
        reconciliationRequired: true,
      })
      await this.#dependencies.commandJournal.saveReceipt({
        tenantId: command.tenantId,
        commandId: command.commandId,
        commandDigest: digest,
        receipt,
      })
      return receipt
    }

    const receipt = CommandReceiptSchema.parse({
      commandId: command.commandId,
      slotId: command.slotId,
      status: 'accepted_non_terminal',
      reconciliationRequired: true,
    })
    await this.#dependencies.commandJournal.saveReceipt({
      tenantId: command.tenantId,
      commandId: command.commandId,
      commandDigest: digest,
      receipt,
    })
    return receipt
  }

  async reconcileCommand(input: {
    readonly tenantId: string
    readonly commandId: string
  }): Promise<CommandReceipt> {
    const parsed = ReconcileInputSchema.parse(input)
    const record = await this.#dependencies.commandJournal.get(parsed)
    if (record === null || record.tenantId !== parsed.tenantId) {
      throw new ConnectorError({ code: 'provider_not_found' })
    }
    if (record.receipt?.status === 'verified') {
      return record.receipt
    }
    const state = await this.readDeviceState({
      tenantId: record.tenantId,
      slotId: record.slotId,
    })
    return this.reconcileRecord(record, state)
  }

  async handleWebhook(request: SmartThingsWebhookRequest): Promise<WebhookResult> {
    const parsedRequest = SmartThingsWebhookRequestSchema.parse(request)
    if (parsedRequest.path !== this.#config.webhookPath) {
      throw new ConnectorError({ code: 'webhook_verification_failed' })
    }
    const requestDate = Date.parse(parsedRequest.date)
    const now = this.#dependencies.clock.now().getTime()
    if (
      !Number.isFinite(requestDate) ||
      now - requestDate > MAX_WEBHOOK_AGE_MS ||
      requestDate - now > MAX_WEBHOOK_FUTURE_SKEW_MS
    ) {
      throw new ConnectorError({ code: 'webhook_verification_failed' })
    }
    if (!(await this.#dependencies.webhookVerifier.verify(parsedRequest))) {
      throw new ConnectorError({ code: 'webhook_verification_failed' })
    }

    let raw: unknown
    try {
      raw = JSON.parse(parsedRequest.rawBody) as unknown
    } catch {
      throw new ConnectorError({ code: 'invalid_provider_response' })
    }
    const parsed = SmartThingsWebhookEventSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ConnectorError({ code: 'invalid_provider_response' })
    }

    const installedAppId = secret(parsed.data.eventData.installedApp.installedAppId)
    const installation = await this.#dependencies.vault.resolveInstallation(installedAppId)
    if (installation === null) {
      throw new ConnectorError({ code: 'tenant_boundary_violation' })
    }
    const tenant = TenantIdSchema.parse(installation.tenantId)
    const credential = await this.#dependencies.vault.load(tenant)
    if (
      (installation.status === 'active' && credential?.installedAppId !== installedAppId) ||
      (installation.status === 'revoked' && credential !== null)
    ) {
      throw new ConnectorError({ code: 'tenant_boundary_violation' })
    }
    const hasDeleteEvent = parsed.data.eventData.events.some(
      (event) => event.eventType === 'INSTALLED_APP_LIFECYCLE_EVENT',
    )
    if (installation.status === 'revoked' && !hasDeleteEvent) {
      throw new ConnectorError({ code: 'tenant_boundary_violation' })
    }
    const receiptNow = this.#dependencies.clock.now()
    const receiptIdentity = {
      tenantId: tenant,
      eventDigest: sha256(parsedRequest.rawBody),
      now: receiptNow,
      leaseExpiresAt: new Date(receiptNow.getTime() + WEBHOOK_PROCESSING_LEASE_MS),
    }
    const claim = await this.#dependencies.webhookReceipts.claim(receiptIdentity)
    if (claim.kind === 'completed') {
      return WebhookResultSchema.parse({ kind: 'duplicate' })
    }
    if (claim.kind === 'in_progress') {
      throw new ConnectorError({ code: 'provider_temporarily_unavailable', retryable: true })
    }

    try {
      const result = await this.processVerifiedWebhook(tenant, parsed.data, credential)
      await this.#dependencies.webhookReceipts.complete({
        tenantId: receiptIdentity.tenantId,
        eventDigest: receiptIdentity.eventDigest,
        claimToken: claim.claimToken,
      })
      return result
    } catch (error) {
      await this.#dependencies.webhookReceipts.release({
        tenantId: receiptIdentity.tenantId,
        eventDigest: receiptIdentity.eventDigest,
        claimToken: claim.claimToken,
      })
      throw error
    }
  }

  private async processVerifiedWebhook(
    tenant: string,
    event: SmartThingsWebhookEvent,
    credential: ProviderCredential | null,
  ): Promise<WebhookResult> {
    const deleteEvent = event.eventData.events.find(
      (event) => event.eventType === 'INSTALLED_APP_LIFECYCLE_EVENT',
    )
    if (deleteEvent !== undefined) {
      if (
        deleteEvent.installedAppLifecycleEvent.installedAppId !==
        event.eventData.installedApp.installedAppId
      ) {
        throw new ConnectorError({ code: 'tenant_boundary_violation' })
      }
      if (credential !== null) {
        const revoked = await this.#dependencies.vault.revoke({
          tenantId: tenant,
          installedAppId: credential.installedAppId,
        })
        if (!revoked) {
          throw new ConnectorError({ code: 'tenant_boundary_violation' })
        }
      }
      return WebhookResultSchema.parse({ kind: 'disconnected' })
    }

    if (credential === null) {
      throw new ConnectorError({ code: 'tenant_boundary_violation' })
    }

    const providerDeviceIds = new Set(
      event.eventData.events
        .filter((event) => event.eventType === 'DEVICE_EVENT')
        .map((event) => event.deviceEvent.deviceId),
    )
    const states: LogicalDeviceState[] = []
    const verifiedCommandIds = new Set<string>()
    for (const providerDeviceId of providerDeviceIds) {
      const mappings = await this.#dependencies.mappings.listByProviderDevice({
        tenantId: tenant,
        provider: 'smartthings',
        providerDeviceId: secret(providerDeviceId),
      })
      for (const mapping of mappings) {
        assertMapping(mapping, { tenantId: tenant })
        if (mapping.providerDeviceId !== providerDeviceId) {
          throw new ConnectorError({ code: 'tenant_boundary_violation' })
        }
        const state = await this.readMappedDevice(mapping, 'webhook_then_provider_read')
        states.push(state)
        const pending = await this.#dependencies.commandJournal.listPendingForSlot({
          tenantId: tenant,
          slotId: mapping.slotId,
        })
        for (const record of pending) {
          const receipt = await this.reconcileRecord(record, state)
          if (receipt.status === 'verified') {
            verifiedCommandIds.add(receipt.commandId)
          }
        }
      }
    }

    return WebhookResultSchema.parse({
      kind: 'device_updates',
      states: states.sort((left, right) => left.slotId.localeCompare(right.slotId)),
      verifiedCommandIds: [...verifiedCommandIds].sort(),
    })
  }

  private async mappingForSlot(tenantId: string, slotId: string): Promise<ProviderDeviceMapping> {
    const mapping = await this.#dependencies.mappings.getBySlot({
      tenantId,
      provider: 'smartthings',
      slotId,
    })
    if (mapping === null) {
      throw new ConnectorError({ code: 'provider_not_found' })
    }
    assertMapping(mapping, { tenantId, slotId })
    return mapping
  }

  private async readMappedDevice(
    mapping: ProviderDeviceMapping,
    source: 'provider_read' | 'webhook_then_provider_read',
  ): Promise<LogicalDeviceState> {
    const url = `${SMARTTHINGS_API_ORIGIN}/v1/devices/${encodeURIComponent(
      mapping.providerDeviceId,
    )}/status`
    const response = await this.authorizedFetch(mapping.tenantId, url, { method: 'GET' })
    const status = await this.parseReadResponse(response, SmartThingsDeviceStatusSchema)
    return projectStatus({
      mapping,
      status,
      observedAt: this.#dependencies.clock.now(),
      source,
    })
  }

  private async assertLightingStepReady(command: DeviceCommand): Promise<void> {
    if (!('lightingStep' in command)) return
    const plan = await this.#dependencies.lightingPlans.getByChild({
      tenantId: command.tenantId,
      commandId: command.commandId,
    })
    if (plan === null) {
      throw new ConnectorError({ code: 'command_not_ready' })
    }
    const stepIndex = plan.steps.findIndex((step) => step.commandId === command.commandId)
    const persisted = sanitizeCommand(command)
    if (
      stepIndex < 0 ||
      commandDigest(plan.steps[stepIndex] as PersistedDeviceCommand) !== commandDigest(persisted)
    ) {
      throw new ConnectorError({ code: 'command_conflict' })
    }
    if (Date.parse(command.notBefore) > this.#dependencies.clock.now().getTime()) {
      throw new ConnectorError({ code: 'command_not_ready' })
    }
    if (stepIndex > 0) {
      const predecessor = plan.steps[stepIndex - 1]
      if (predecessor === undefined) {
        throw new ConnectorError({ code: 'command_not_ready' })
      }
      const record = await this.#dependencies.commandJournal.get({
        tenantId: command.tenantId,
        commandId: predecessor.commandId,
      })
      if (record?.receipt?.status !== 'verified') {
        throw new ConnectorError({ code: 'command_not_ready' })
      }
    }
  }

  private async assertCommandSafety(
    command: DeviceCommand,
    mapping: ProviderDeviceMapping,
  ): Promise<void> {
    if (command.action === 'lock.unlock') {
      const confirmation = await this.#dependencies.unlockAuthority.authorize({
        tenantId: command.tenantId,
        slotId: command.slotId,
        action: command.action,
        commandId: command.commandId,
        confirmationId: secret(command.confirmationId),
        now: this.#dependencies.clock.now(),
        maximumAgeMs: MAX_UNLOCK_CONFIRMATION_AGE_MS,
      })
      if (confirmation === null) {
        throw new ConnectorError({ code: 'human_confirmation_required' })
      }
    }

    if (
      command.action === 'thermostat.setHeatingSetpoint' ||
      command.action === 'thermostat.setCoolingSetpoint'
    ) {
      if (
        !mapping.capabilities.includes('thermostat.temperature') ||
        !mapping.capabilities.includes('thermostat.mode')
      ) {
        throw new ConnectorError({ code: 'unsupported_capability' })
      }
      const state = await this.readMappedDevice(mapping, 'provider_read')
      const setpoint =
        command.action === 'thermostat.setHeatingSetpoint'
          ? state.heatingSetpoint
          : state.coolingSetpoint
      if (
        state.temperature === undefined ||
        state.temperature.unit !== command.unit ||
        (setpoint !== undefined && setpoint.unit !== command.unit)
      ) {
        throw new ConnectorError({ code: 'thermostat_unit_mismatch' })
      }
      const modeMatches =
        command.action === 'thermostat.setHeatingSetpoint'
          ? state.thermostatMode === 'heat' ||
            state.thermostatMode === 'auto' ||
            state.thermostatMode === 'emergency_heat'
          : state.thermostatMode === 'cool' || state.thermostatMode === 'auto'
      if (!modeMatches) {
        throw new ConnectorError({ code: 'thermostat_mode_mismatch' })
      }
    }
  }

  private async reconcileRecord(
    record: {
      readonly tenantId: string
      readonly commandId: string
      readonly slotId: string
      readonly commandDigest: string
      readonly command: PersistedDeviceCommand
      readonly receipt: CommandReceipt | null
    },
    state: LogicalDeviceState,
  ): Promise<CommandReceipt> {
    if (!commandMatchesState(record.command, state)) {
      return (
        record.receipt ??
        CommandReceiptSchema.parse({
          commandId: record.commandId,
          slotId: record.slotId,
          status: 'outcome_unknown',
          reconciliationRequired: true,
        })
      )
    }
    const receipt = CommandReceiptSchema.parse({
      commandId: record.commandId,
      slotId: record.slotId,
      status: 'verified',
      reconciliationRequired: false,
    })
    await this.#dependencies.commandJournal.saveReceipt({
      tenantId: record.tenantId,
      commandId: record.commandId,
      commandDigest: record.commandDigest,
      receipt,
    })
    return receipt
  }

  private async authorizedFetch(
    tenantId: string,
    url: string,
    init: RequestInit,
    command = false,
  ): Promise<Response> {
    let token = await this.#tokens.accessToken(tenantId)
    const request = async (): Promise<Response> => {
      const headers = new Headers(init.headers)
      headers.set('accept', 'application/json')
      headers.set('authorization', `Bearer ${token}`)
      return this.#dependencies.fetch(url, {
        ...init,
        headers,
      })
    }

    let response: Response
    try {
      response = await request()
    } catch {
      throw new ConnectorError({
        code: command ? 'provider_transport_unknown' : 'provider_temporarily_unavailable',
        retryable: !command,
        outcome: command ? 'unknown' : 'definitely_not_sent',
      })
    }
    if (response.status !== 401) {
      return response
    }

    token = await this.#tokens.refreshAfterUnauthorized(tenantId, token)
    try {
      return await request()
    } catch {
      throw new ConnectorError({
        code: command ? 'provider_transport_unknown' : 'provider_temporarily_unavailable',
        retryable: !command,
        outcome: command ? 'unknown' : 'definitely_not_sent',
      })
    }
  }

  private async parseReadResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    this.throwForReadResponse(response)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ConnectorError({ code: 'invalid_provider_response' })
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new ConnectorError({ code: 'invalid_provider_response' })
    }
    return parsed.data
  }

  private throwForReadResponse(response: Response): void {
    if (response.ok) {
      return
    }
    if (response.status === 429) {
      const retryAfterMs = rateLimitDelay(response)
      throw new ConnectorError({
        code: 'provider_rate_limited',
        retryable: true,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })
    }
    if (response.status === 401) {
      throw new ConnectorError({ code: 'authentication_required' })
    }
    if (response.status === 403) {
      throw new ConnectorError({ code: 'provider_access_denied' })
    }
    if (response.status === 404) {
      throw new ConnectorError({ code: 'provider_not_found' })
    }
    if (response.status >= 500 || response.status === 408 || response.status === 425) {
      throw new ConnectorError({ code: 'provider_temporarily_unavailable', retryable: true })
    }
    throw new ConnectorError({ code: 'invalid_provider_response' })
  }
}
