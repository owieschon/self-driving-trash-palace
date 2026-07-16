import type {
  CommandReceipt,
  ConnectorCapability,
  LightingPlan,
  LogicalDevice,
  PersistedDeviceCommand,
} from './contracts.js'

declare const secretBrand: unique symbol
export type SecretString = string & { readonly [secretBrand]: true }

export function secret(value: string): SecretString {
  return value as SecretString
}

export interface ConnectorClockPort {
  now(): Date
}

export interface ConnectorEntropyPort {
  randomToken(bytes: number): string
}

export interface OAuthStateRecord {
  readonly tenantId: string
  readonly sessionBinding: string
  readonly stateDigest: string
  readonly redirectUri: string
  readonly expiresAt: Date
}

export interface OAuthStateStorePort {
  put(record: OAuthStateRecord): Promise<void>
  consume(input: {
    readonly tenantId: string
    readonly sessionBinding: string
    readonly stateDigest: string
    readonly now: Date
  }): Promise<OAuthStateRecord | null>
}

export interface ProviderCredential {
  readonly tenantId: string
  readonly provider: 'smartthings'
  readonly accessToken: SecretString
  readonly refreshToken: SecretString
  readonly installedAppId: SecretString
  readonly accessTokenExpiresAt: Date
  readonly scopes: readonly string[]
  readonly revision: number
}

export interface CredentialVaultPort {
  load(tenantId: string): Promise<ProviderCredential | null>
  create(credential: Omit<ProviderCredential, 'revision'>): Promise<void>
  replace(
    expectedRevision: number,
    credential: Omit<ProviderCredential, 'revision'>,
  ): Promise<boolean>
  withRefreshLock<T>(tenantId: string, task: () => Promise<T>): Promise<T>
  revoke(input: {
    readonly tenantId: string
    readonly installedAppId: SecretString
  }): Promise<boolean>
  installationStatus(input: {
    readonly tenantId: string
    readonly installedAppId: SecretString
  }): Promise<'active' | 'revoked' | 'not_found'>
  resolveInstallation(
    installedAppId: SecretString,
  ): Promise<{ readonly tenantId: string; readonly status: 'active' | 'revoked' } | null>
}

export interface ProviderDeviceCandidate {
  readonly tenantId: string
  readonly provider: 'smartthings'
  readonly candidateId: string
  readonly providerDeviceId: SecretString
  readonly providerComponentId: SecretString
  readonly capabilities: readonly ConnectorCapability[]
}

export interface ProviderDeviceMapping {
  readonly tenantId: string
  readonly provider: 'smartthings'
  readonly slotId: string
  readonly displayName: string
  readonly providerDeviceId: SecretString
  readonly providerComponentId: SecretString
  readonly kind: LogicalDevice['kind']
  readonly capabilities: readonly ConnectorCapability[]
}

export interface DeviceMappingPort {
  /** Implementations assign a keyed opaque candidate ID; raw provider IDs are never public IDs. */
  recordCandidate(
    input: Omit<ProviderDeviceCandidate, 'candidateId'>,
  ): Promise<ProviderDeviceCandidate>
  getCandidate(input: {
    readonly tenantId: string
    readonly provider: 'smartthings'
    readonly candidateId: string
  }): Promise<ProviderDeviceCandidate | null>
  mapCandidate(input: {
    readonly candidate: ProviderDeviceCandidate
    readonly logicalDevice: LogicalDevice
    readonly confirmedBy: 'human'
  }): Promise<ProviderDeviceMapping>
  getBySlot(input: {
    readonly tenantId: string
    readonly provider: 'smartthings'
    readonly slotId: string
  }): Promise<ProviderDeviceMapping | null>
  listByProviderDevice(input: {
    readonly tenantId: string
    readonly provider: 'smartthings'
    readonly providerDeviceId: SecretString
  }): Promise<readonly ProviderDeviceMapping[]>
}

export interface LogicalDeviceCatalogPort {
  get(input: { readonly tenantId: string; readonly slotId: string }): Promise<LogicalDevice | null>
}

export interface UnlockAuthorityPort {
  /**
   * Atomically returns an existing grant for the same connector command or consumes
   * the supplied confirmation and binds a digest of it to that command. Implementations
   * must never persist the raw confirmation value.
   */
  authorize(input: {
    readonly tenantId: string
    readonly slotId: string
    readonly action: 'lock.unlock'
    readonly commandId: string
    readonly confirmationId: SecretString
    readonly now: Date
    readonly maximumAgeMs: number
  }): Promise<{ readonly confirmedAt: Date } | null>
}

export interface CommandJournalRecord {
  readonly tenantId: string
  readonly commandId: string
  readonly slotId: string
  readonly commandDigest: string
  readonly command: PersistedDeviceCommand
  readonly receipt: CommandReceipt | null
}

export type CommandClaimResult =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'existing'; readonly record: CommandJournalRecord }
  | { readonly kind: 'conflict' }

export interface CommandJournalPort {
  claim(input: Omit<CommandJournalRecord, 'receipt'>): Promise<CommandClaimResult>
  abandon(input: {
    readonly tenantId: string
    readonly commandId: string
    readonly commandDigest: string
  }): Promise<void>
  saveReceipt(input: {
    readonly tenantId: string
    readonly commandId: string
    readonly commandDigest: string
    readonly receipt: CommandReceipt
  }): Promise<void>
  get(input: {
    readonly tenantId: string
    readonly commandId: string
  }): Promise<CommandJournalRecord | null>
  listPendingForSlot(input: {
    readonly tenantId: string
    readonly slotId: string
  }): Promise<readonly CommandJournalRecord[]>
}

export interface LightingPlanStorePort {
  claim(
    plan: LightingPlan,
  ): Promise<
    | { readonly kind: 'created'; readonly plan: LightingPlan }
    | { readonly kind: 'existing'; readonly plan: LightingPlan }
    | { readonly kind: 'conflict' }
  >
  getByParent(input: {
    readonly tenantId: string
    readonly parentCommandId: string
  }): Promise<LightingPlan | null>
  getByChild(input: {
    readonly tenantId: string
    readonly commandId: string
  }): Promise<LightingPlan | null>
}

export interface SmartThingsWebhookRequest {
  readonly method: 'POST'
  readonly path: string
  readonly authorization: string
  readonly digest: string
  readonly date: string
  readonly rawBody: string
}

export interface WebhookSignatureVerifierPort {
  verify(request: SmartThingsWebhookRequest): Promise<boolean>
}

export interface WebhookReceiptPort {
  claim(input: {
    readonly tenantId: string
    readonly eventDigest: string
    readonly now: Date
    readonly leaseExpiresAt: Date
  }): Promise<
    | { readonly kind: 'claimed'; readonly claimToken: string }
    | { readonly kind: 'completed' }
    | { readonly kind: 'in_progress' }
  >
  complete(input: {
    readonly tenantId: string
    readonly eventDigest: string
    readonly claimToken: string
  }): Promise<void>
  release(input: {
    readonly tenantId: string
    readonly eventDigest: string
    readonly claimToken: string
  }): Promise<void>
}
