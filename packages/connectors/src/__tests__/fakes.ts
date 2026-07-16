import { createHash, createHmac } from 'node:crypto'

import type { LightingPlan, LogicalDevice } from '../contracts.js'
import type {
  CommandClaimResult,
  CommandJournalPort,
  CommandJournalRecord,
  ConnectorClockPort,
  ConnectorEntropyPort,
  CredentialVaultPort,
  DeviceMappingPort,
  LightingPlanStorePort,
  LogicalDeviceCatalogPort,
  OAuthStateRecord,
  OAuthStateStorePort,
  ProviderCredential,
  ProviderDeviceCandidate,
  ProviderDeviceMapping,
  SecretString,
  SmartThingsWebhookRequest,
  UnlockAuthorityPort,
  WebhookReceiptPort,
  WebhookSignatureVerifierPort,
} from '../ports.js'

export class FixedClock implements ConnectorClockPort {
  constructor(public current: Date) {}

  now(): Date {
    return new Date(this.current)
  }
}

export class FixedEntropy implements ConnectorEntropyPort {
  constructor(readonly value = 'state_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG') {}

  randomToken(_bytes: number): string {
    return this.value
  }
}

export class InMemoryOAuthStateStore implements OAuthStateStorePort {
  readonly records = new Map<string, OAuthStateRecord>()

  async put(record: OAuthStateRecord): Promise<void> {
    this.records.set(record.stateDigest, record)
  }

  async consume(input: {
    readonly tenantId: string
    readonly sessionBinding: string
    readonly stateDigest: string
    readonly now: Date
  }): Promise<OAuthStateRecord | null> {
    const record = this.records.get(input.stateDigest)
    if (
      record === undefined ||
      record.tenantId !== input.tenantId ||
      record.sessionBinding !== input.sessionBinding
    ) {
      return null
    }
    this.records.delete(input.stateDigest)
    return record
  }
}

export class InMemoryVault implements CredentialVaultPort {
  readonly credentials = new Map<string, ProviderCredential>()
  readonly revocationTombstones = new Map<string, SecretString>()
  readonly revoked: string[] = []

  async load(tenantId: string): Promise<ProviderCredential | null> {
    return this.credentials.get(tenantId) ?? null
  }

  async create(credential: Omit<ProviderCredential, 'revision'>): Promise<void> {
    if (this.credentials.has(credential.tenantId)) {
      throw new Error('duplicate credential')
    }
    this.revocationTombstones.delete(credential.tenantId)
    this.credentials.set(credential.tenantId, { ...credential, revision: 1 })
  }

  async replace(
    expectedRevision: number,
    credential: Omit<ProviderCredential, 'revision'>,
  ): Promise<boolean> {
    const current = this.credentials.get(credential.tenantId)
    if (current?.revision !== expectedRevision) {
      return false
    }
    this.credentials.set(credential.tenantId, {
      ...credential,
      revision: expectedRevision + 1,
    })
    return true
  }

  async withRefreshLock<T>(_tenantId: string, task: () => Promise<T>): Promise<T> {
    return task()
  }

  async revoke(input: {
    readonly tenantId: string
    readonly installedAppId: SecretString
  }): Promise<boolean> {
    const current = this.credentials.get(input.tenantId)
    if (current?.installedAppId !== input.installedAppId) {
      return false
    }
    this.credentials.delete(input.tenantId)
    this.revocationTombstones.set(input.tenantId, input.installedAppId)
    this.revoked.push(input.tenantId)
    return true
  }

  async installationStatus(input: {
    readonly tenantId: string
    readonly installedAppId: SecretString
  }): Promise<'active' | 'revoked' | 'not_found'> {
    if (this.credentials.get(input.tenantId)?.installedAppId === input.installedAppId) {
      return 'active'
    }
    if (this.revocationTombstones.get(input.tenantId) === input.installedAppId) {
      return 'revoked'
    }
    return 'not_found'
  }

  async resolveInstallation(
    installedAppId: SecretString,
  ): Promise<{ readonly tenantId: string; readonly status: 'active' | 'revoked' } | null> {
    for (const [tenantId, credential] of this.credentials) {
      if (credential.installedAppId === installedAppId) {
        return { tenantId, status: 'active' }
      }
    }
    for (const [tenantId, revokedInstalledAppId] of this.revocationTombstones) {
      if (revokedInstalledAppId === installedAppId) {
        return { tenantId, status: 'revoked' }
      }
    }
    return null
  }
}

export class InMemoryMappings implements DeviceMappingPort {
  readonly candidates: ProviderDeviceCandidate[] = []
  readonly mappings: ProviderDeviceMapping[] = []

  seed(mapping: ProviderDeviceMapping): void {
    this.mappings.push(mapping)
  }

  async recordCandidate(
    input: Omit<ProviderDeviceCandidate, 'candidateId'>,
  ): Promise<ProviderDeviceCandidate> {
    const existing = this.candidates.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.providerDeviceId === input.providerDeviceId &&
        candidate.providerComponentId === input.providerComponentId,
    )
    if (existing !== undefined) {
      return existing
    }
    const candidate: ProviderDeviceCandidate = {
      ...input,
      candidateId: `stcand_${createHmac('sha256', 'test-only-candidate-hmac-key')
        .update(`${input.tenantId}\n${input.providerDeviceId}\n${input.providerComponentId}`)
        .digest('hex')}`,
    }
    this.candidates.push(candidate)
    return candidate
  }

  async getCandidate(input: {
    readonly tenantId: string
    readonly provider: 'smartthings'
    readonly candidateId: string
  }): Promise<ProviderDeviceCandidate | null> {
    return (
      this.candidates.find(
        (candidate) =>
          candidate.tenantId === input.tenantId && candidate.candidateId === input.candidateId,
      ) ?? null
    )
  }

  async mapCandidate(input: {
    readonly candidate: ProviderDeviceCandidate
    readonly logicalDevice: LogicalDevice
    readonly confirmedBy: 'human'
  }): Promise<ProviderDeviceMapping> {
    const existing = this.mappings.find(
      (mapping) =>
        mapping.tenantId === input.candidate.tenantId &&
        mapping.slotId === input.logicalDevice.slotId,
    )
    if (existing !== undefined) return existing
    const mapping: ProviderDeviceMapping = {
      tenantId: input.candidate.tenantId,
      provider: input.candidate.provider,
      slotId: input.logicalDevice.slotId,
      displayName: input.logicalDevice.displayName,
      providerDeviceId: input.candidate.providerDeviceId,
      providerComponentId: input.candidate.providerComponentId,
      kind: input.logicalDevice.kind,
      capabilities: input.logicalDevice.capabilities,
    }
    this.mappings.push(mapping)
    return mapping
  }

  async getBySlot(input: {
    readonly tenantId: string
    readonly provider: 'smartthings'
    readonly slotId: string
  }): Promise<ProviderDeviceMapping | null> {
    return (
      this.mappings.find(
        (mapping) => mapping.tenantId === input.tenantId && mapping.slotId === input.slotId,
      ) ?? null
    )
  }

  async listByProviderDevice(input: {
    readonly tenantId: string
    readonly provider: 'smartthings'
    readonly providerDeviceId: SecretString
  }): Promise<readonly ProviderDeviceMapping[]> {
    return this.mappings.filter(
      (mapping) =>
        mapping.tenantId === input.tenantId && mapping.providerDeviceId === input.providerDeviceId,
    )
  }
}

export class InMemoryLogicalDevices implements LogicalDeviceCatalogPort {
  readonly devices = new Map<string, LogicalDevice>()

  seed(tenantId: string, device: LogicalDevice): void {
    this.devices.set(`${tenantId}:${device.slotId}`, device)
  }

  async get(input: {
    readonly tenantId: string
    readonly slotId: string
  }): Promise<LogicalDevice | null> {
    return this.devices.get(`${input.tenantId}:${input.slotId}`) ?? null
  }
}

export class InMemoryUnlockAuthority implements UnlockAuthorityPort {
  readonly confirmations = new Map<string, Date>()
  readonly grants = new Map<
    string,
    { readonly confirmationDigest: string; readonly confirmedAt: Date }
  >()

  add(id: string, confirmedAt: Date): void {
    this.confirmations.set(id, confirmedAt)
  }

  async authorize(input: {
    readonly tenantId: string
    readonly slotId: string
    readonly action: 'lock.unlock'
    readonly commandId: string
    readonly confirmationId: SecretString
    readonly now: Date
    readonly maximumAgeMs: number
  }): Promise<{ readonly confirmedAt: Date } | null> {
    const key = `${input.tenantId}:${input.commandId}`
    const digest = createHash('sha256').update(input.confirmationId).digest('hex')
    const existing = this.grants.get(key)
    if (existing !== undefined) {
      return existing.confirmationDigest === digest ? { confirmedAt: existing.confirmedAt } : null
    }
    const value = this.confirmations.get(input.confirmationId)
    if (value === undefined) return null
    const age = input.now.getTime() - value.getTime()
    if (age < 0 || age > input.maximumAgeMs) {
      this.confirmations.delete(input.confirmationId)
      return null
    }
    this.confirmations.delete(input.confirmationId)
    this.grants.set(key, { confirmationDigest: digest, confirmedAt: value })
    return { confirmedAt: value }
  }
}

export class InMemoryCommandJournal implements CommandJournalPort {
  readonly records = new Map<string, CommandJournalRecord>()

  #key(tenantId: string, commandId: string): string {
    return `${tenantId}:${commandId}`
  }

  async claim(input: Omit<CommandJournalRecord, 'receipt'>): Promise<CommandClaimResult> {
    const key = this.#key(input.tenantId, input.commandId)
    const existing = this.records.get(key)
    if (existing !== undefined) {
      return existing.commandDigest === input.commandDigest
        ? { kind: 'existing', record: existing }
        : { kind: 'conflict' }
    }
    this.records.set(key, { ...input, receipt: null })
    return { kind: 'claimed' }
  }

  async abandon(input: {
    readonly tenantId: string
    readonly commandId: string
    readonly commandDigest: string
  }): Promise<void> {
    const key = this.#key(input.tenantId, input.commandId)
    const current = this.records.get(key)
    if (current?.commandDigest === input.commandDigest) {
      this.records.delete(key)
    }
  }

  async saveReceipt(input: {
    readonly tenantId: string
    readonly commandId: string
    readonly commandDigest: string
    readonly receipt: NonNullable<CommandJournalRecord['receipt']>
  }): Promise<void> {
    const key = this.#key(input.tenantId, input.commandId)
    const current = this.records.get(key)
    if (current === undefined || current.commandDigest !== input.commandDigest) {
      throw new Error('journal write without matching claim')
    }
    this.records.set(key, { ...current, receipt: input.receipt })
  }

  async get(input: {
    readonly tenantId: string
    readonly commandId: string
  }): Promise<CommandJournalRecord | null> {
    return this.records.get(this.#key(input.tenantId, input.commandId)) ?? null
  }

  async listPendingForSlot(input: {
    readonly tenantId: string
    readonly slotId: string
  }): Promise<readonly CommandJournalRecord[]> {
    return [...this.records.values()].filter(
      (record) =>
        record.tenantId === input.tenantId &&
        record.slotId === input.slotId &&
        record.receipt?.status !== 'verified',
    )
  }
}

export class InMemoryLightingPlans implements LightingPlanStorePort {
  readonly plans = new Map<string, LightingPlan>()

  #key(tenantId: string, parentCommandId: string): string {
    return `${tenantId}:${parentCommandId}`
  }

  async claim(
    plan: LightingPlan,
  ): Promise<
    | { readonly kind: 'created'; readonly plan: LightingPlan }
    | { readonly kind: 'existing'; readonly plan: LightingPlan }
    | { readonly kind: 'conflict' }
  > {
    const key = this.#key(plan.tenantId, plan.parentCommandId)
    const existing = this.plans.get(key)
    if (existing !== undefined) {
      return JSON.stringify(existing) === JSON.stringify(plan)
        ? { kind: 'existing', plan: existing }
        : { kind: 'conflict' }
    }
    this.plans.set(key, plan)
    return { kind: 'created', plan }
  }

  async getByParent(input: {
    readonly tenantId: string
    readonly parentCommandId: string
  }): Promise<LightingPlan | null> {
    return this.plans.get(this.#key(input.tenantId, input.parentCommandId)) ?? null
  }

  async getByChild(input: {
    readonly tenantId: string
    readonly commandId: string
  }): Promise<LightingPlan | null> {
    return (
      [...this.plans.values()].find(
        (plan) =>
          plan.tenantId === input.tenantId &&
          plan.steps.some((step) => step.commandId === input.commandId),
      ) ?? null
    )
  }
}

export class InMemoryWebhookReceipts implements WebhookReceiptPort {
  readonly digests = new Map<
    string,
    | { readonly status: 'in_progress'; readonly claimToken: string; readonly leaseExpiresAt: Date }
    | { readonly status: 'completed' }
  >()
  #counter = 0

  async claim(input: {
    readonly tenantId: string
    readonly eventDigest: string
    readonly now: Date
    readonly leaseExpiresAt: Date
  }): Promise<
    | { readonly kind: 'claimed'; readonly claimToken: string }
    | { readonly kind: 'completed' }
    | { readonly kind: 'in_progress' }
  > {
    const key = `${input.tenantId}:${input.eventDigest}`
    const existing = this.digests.get(key)
    if (existing?.status === 'completed') {
      return { kind: 'completed' }
    }
    if (existing?.status === 'in_progress' && existing.leaseExpiresAt > input.now) {
      return { kind: 'in_progress' }
    }
    this.#counter += 1
    const claimToken = `webhook-claim-${this.#counter}`
    this.digests.set(key, {
      status: 'in_progress',
      claimToken,
      leaseExpiresAt: input.leaseExpiresAt,
    })
    return { kind: 'claimed', claimToken }
  }

  async complete(input: {
    readonly tenantId: string
    readonly eventDigest: string
    readonly claimToken: string
  }): Promise<void> {
    const key = `${input.tenantId}:${input.eventDigest}`
    const existing = this.digests.get(key)
    if (existing?.status !== 'in_progress' || existing.claimToken !== input.claimToken) {
      throw new Error('webhook completion without claim')
    }
    this.digests.set(key, { status: 'completed' })
  }

  async release(input: {
    readonly tenantId: string
    readonly eventDigest: string
    readonly claimToken: string
  }): Promise<void> {
    const key = `${input.tenantId}:${input.eventDigest}`
    const existing = this.digests.get(key)
    if (existing?.status === 'in_progress' && existing.claimToken === input.claimToken) {
      this.digests.delete(key)
    }
  }
}

export class ToggleWebhookVerifier implements WebhookSignatureVerifierPort {
  constructor(public valid = true) {}

  async verify(_request: SmartThingsWebhookRequest): Promise<boolean> {
    return this.valid
  }
}
