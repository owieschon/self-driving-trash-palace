import { AsyncLocalStorage } from 'node:async_hooks'
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

import {
  ConnectorCapabilitySchema,
  LogicalDeviceSchema,
  secret,
  type CredentialVaultPort,
  type DeviceMappingPort,
  type OAuthStateRecord,
  type OAuthStateStorePort,
  type ProviderCredential,
  type ProviderDeviceCandidate,
  type ProviderDeviceMapping,
  type SecretString,
} from '@trash-palace/connectors'
import { and, eq, gt, isNull } from 'drizzle-orm'

import type { Database, DatabaseExecutor, DatabaseTransaction } from './client.js'
import { DatabaseConflictError, translateDatabaseError } from './errors.js'
import {
  connectorCredentials,
  connectorDeviceCandidates,
  connectorDeviceMappings,
  connectorOAuthStates,
} from './schema.js'

type Sealed = Readonly<{ ciphertext: Buffer; nonce: Buffer; tag: Buffer }>

class ConnectorSecretCipher {
  readonly #key: Buffer

  public constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, 'base64')
    if (key.byteLength !== 32) {
      throw new TypeError('Connector encryption key must be 32 bytes encoded as base64')
    }
    this.#key = key
  }

  public seal(value: SecretString, aad: string): Sealed {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return { ciphertext, nonce, tag: cipher.getAuthTag() }
  }

  public open(value: Sealed, aad: string): SecretString {
    const decipher = createDecipheriv('aes-256-gcm', this.#key, value.nonce)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(value.tag)
    return secret(
      Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8'),
    )
  }

  public digest(value: SecretString, domain: string): string {
    return createHmac('sha256', this.#key).update(`${domain}\n${value}`).digest('hex')
  }
}

export class PgConnectorOAuthStateStore implements OAuthStateStorePort {
  public constructor(private readonly database: Database) {}

  public async put(record: OAuthStateRecord): Promise<void> {
    assertDigest(record.stateDigest, 'OAuth state')
    assertDigest(record.sessionBinding, 'OAuth session binding')
    try {
      await this.database.insert(connectorOAuthStates).values({
        organizationId: record.tenantId,
        provider: 'smartthings',
        sessionBindingHash: record.sessionBinding,
        stateDigest: record.stateDigest,
        redirectUri: record.redirectUri,
        expiresAt: record.expiresAt,
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }

  public consume(input: {
    tenantId: string
    sessionBinding: string
    stateDigest: string
    now: Date
  }): Promise<OAuthStateRecord | null> {
    assertDigest(input.stateDigest, 'OAuth state')
    assertDigest(input.sessionBinding, 'OAuth session binding')
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(connectorOAuthStates)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(connectorOAuthStates.organizationId, input.tenantId),
            eq(connectorOAuthStates.provider, 'smartthings'),
            eq(connectorOAuthStates.sessionBindingHash, input.sessionBinding),
            eq(connectorOAuthStates.stateDigest, input.stateDigest),
            isNull(connectorOAuthStates.consumedAt),
            gt(connectorOAuthStates.expiresAt, input.now),
          ),
        )
        .returning()
      return row === undefined
        ? null
        : {
            tenantId: row.organizationId,
            sessionBinding: row.sessionBindingHash,
            stateDigest: row.stateDigest,
            redirectUri: row.redirectUri,
            expiresAt: row.expiresAt,
          }
    })
  }
}

export class PgConnectorCredentialVault implements CredentialVaultPort {
  readonly #cipher: ConnectorSecretCipher
  readonly #transaction = new AsyncLocalStorage<DatabaseTransaction>()

  public constructor(
    private readonly database: Database,
    encodedEncryptionKey: string,
  ) {
    this.#cipher = new ConnectorSecretCipher(encodedEncryptionKey)
  }

  public async load(tenantId: string): Promise<ProviderCredential | null> {
    const [row] = await this.#executor()
      .select()
      .from(connectorCredentials)
      .where(
        and(
          eq(connectorCredentials.organizationId, tenantId),
          eq(connectorCredentials.provider, 'smartthings'),
          isNull(connectorCredentials.revokedAt),
        ),
      )
      .limit(1)
    return row === undefined ? null : this.#credential(row)
  }

  public async create(credential: Omit<ProviderCredential, 'revision'>): Promise<void> {
    const revision = 1
    const sealed = this.#sealCredential(credential, revision)
    try {
      await this.#executor()
        .insert(connectorCredentials)
        .values({
          organizationId: credential.tenantId,
          provider: credential.provider,
          ...sealed,
          accessTokenExpiresAt: credential.accessTokenExpiresAt,
          scopes: [...credential.scopes],
          revision,
        })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }

  public async replace(
    expectedRevision: number,
    credential: Omit<ProviderCredential, 'revision'>,
  ): Promise<boolean> {
    const revision = expectedRevision + 1
    const sealed = this.#sealCredential(credential, revision)
    const updated = await this.#executor()
      .update(connectorCredentials)
      .set({
        ...sealed,
        accessTokenExpiresAt: credential.accessTokenExpiresAt,
        scopes: [...credential.scopes],
        revision,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connectorCredentials.organizationId, credential.tenantId),
          eq(connectorCredentials.provider, credential.provider),
          eq(connectorCredentials.revision, expectedRevision),
          isNull(connectorCredentials.revokedAt),
        ),
      )
      .returning({ revision: connectorCredentials.revision })
    return updated.length === 1
  }

  public withRefreshLock<T>(tenantId: string, task: () => Promise<T>): Promise<T> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ organizationId: connectorCredentials.organizationId })
        .from(connectorCredentials)
        .where(
          and(
            eq(connectorCredentials.organizationId, tenantId),
            eq(connectorCredentials.provider, 'smartthings'),
          ),
        )
        .for('update')
        .limit(1)
      if (row === undefined) throw new DatabaseConflictError('Connector credential is absent')
      return this.#transaction.run(transaction, task)
    })
  }

  public async revoke(input: { tenantId: string; installedAppId: SecretString }): Promise<boolean> {
    const updated = await this.#executor()
      .update(connectorCredentials)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(connectorCredentials.organizationId, input.tenantId),
          eq(connectorCredentials.provider, 'smartthings'),
          eq(
            connectorCredentials.installedAppIdDigest,
            this.#cipher.digest(input.installedAppId, 'installed-app'),
          ),
          isNull(connectorCredentials.revokedAt),
        ),
      )
      .returning({ organizationId: connectorCredentials.organizationId })
    return updated.length === 1
  }

  public async installationStatus(input: {
    tenantId: string
    installedAppId: SecretString
  }): Promise<'active' | 'revoked' | 'not_found'> {
    const [row] = await this.#executor()
      .select({ revokedAt: connectorCredentials.revokedAt })
      .from(connectorCredentials)
      .where(
        and(
          eq(connectorCredentials.organizationId, input.tenantId),
          eq(connectorCredentials.provider, 'smartthings'),
          eq(
            connectorCredentials.installedAppIdDigest,
            this.#cipher.digest(input.installedAppId, 'installed-app'),
          ),
        ),
      )
      .limit(1)
    return row === undefined ? 'not_found' : row.revokedAt === null ? 'active' : 'revoked'
  }

  public async resolveInstallation(
    installedAppId: SecretString,
  ): Promise<{ tenantId: string; status: 'active' | 'revoked' } | null> {
    const [row] = await this.#executor()
      .select({
        organizationId: connectorCredentials.organizationId,
        revokedAt: connectorCredentials.revokedAt,
      })
      .from(connectorCredentials)
      .where(
        and(
          eq(connectorCredentials.provider, 'smartthings'),
          eq(
            connectorCredentials.installedAppIdDigest,
            this.#cipher.digest(installedAppId, 'installed-app'),
          ),
        ),
      )
      .limit(1)
    return row === undefined
      ? null
      : { tenantId: row.organizationId, status: row.revokedAt === null ? 'active' : 'revoked' }
  }

  #executor(): DatabaseExecutor {
    return this.#transaction.getStore() ?? this.database
  }

  #sealCredential(credential: Omit<ProviderCredential, 'revision'>, revision: number) {
    const aad = `${credential.tenantId}:smartthings:${revision}`
    const access = this.#cipher.seal(credential.accessToken, `${aad}:access`)
    const refresh = this.#cipher.seal(credential.refreshToken, `${aad}:refresh`)
    const installation = this.#cipher.seal(credential.installedAppId, `${aad}:installation`)
    return {
      accessTokenCiphertext: access.ciphertext,
      accessTokenNonce: access.nonce,
      accessTokenTag: access.tag,
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenNonce: refresh.nonce,
      refreshTokenTag: refresh.tag,
      installedAppIdCiphertext: installation.ciphertext,
      installedAppIdNonce: installation.nonce,
      installedAppIdTag: installation.tag,
      installedAppIdDigest: this.#cipher.digest(credential.installedAppId, 'installed-app'),
    }
  }

  #credential(row: typeof connectorCredentials.$inferSelect): ProviderCredential {
    const aad = `${row.organizationId}:smartthings:${row.revision}`
    return {
      tenantId: row.organizationId,
      provider: row.provider,
      accessToken: this.#cipher.open(
        {
          ciphertext: row.accessTokenCiphertext,
          nonce: row.accessTokenNonce,
          tag: row.accessTokenTag,
        },
        `${aad}:access`,
      ),
      refreshToken: this.#cipher.open(
        {
          ciphertext: row.refreshTokenCiphertext,
          nonce: row.refreshTokenNonce,
          tag: row.refreshTokenTag,
        },
        `${aad}:refresh`,
      ),
      installedAppId: this.#cipher.open(
        {
          ciphertext: row.installedAppIdCiphertext,
          nonce: row.installedAppIdNonce,
          tag: row.installedAppIdTag,
        },
        `${aad}:installation`,
      ),
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      scopes: row.scopes,
      revision: row.revision,
    }
  }
}

export class PgConnectorDeviceMappingRepository implements DeviceMappingPort {
  readonly #cipher: ConnectorSecretCipher

  public constructor(
    private readonly database: Database,
    encodedEncryptionKey: string,
  ) {
    this.#cipher = new ConnectorSecretCipher(encodedEncryptionKey)
  }

  public async recordCandidate(
    input: Omit<ProviderDeviceCandidate, 'candidateId'>,
  ): Promise<ProviderDeviceCandidate> {
    const deviceDigest = this.#cipher.digest(input.providerDeviceId, 'provider-device')
    const componentDigest = this.#cipher.digest(input.providerComponentId, 'provider-component')
    const candidateId = `stcand_${createHmac('sha256', Buffer.from('trashpal-candidate-v1'))
      .update(`${input.tenantId}\n${input.provider}\n${deviceDigest}\n${componentDigest}`)
      .digest('hex')}`
    const device = this.#cipher.seal(
      input.providerDeviceId,
      `${input.tenantId}:${candidateId}:device`,
    )
    const component = this.#cipher.seal(
      input.providerComponentId,
      `${input.tenantId}:${candidateId}:component`,
    )
    await this.database
      .insert(connectorDeviceCandidates)
      .values({
        organizationId: input.tenantId,
        provider: input.provider,
        candidateId,
        providerDeviceIdCiphertext: device.ciphertext,
        providerDeviceIdNonce: device.nonce,
        providerDeviceIdTag: device.tag,
        providerDeviceIdDigest: deviceDigest,
        providerComponentIdCiphertext: component.ciphertext,
        providerComponentIdNonce: component.nonce,
        providerComponentIdTag: component.tag,
        providerComponentIdDigest: componentDigest,
        capabilities: [...input.capabilities],
      })
      .onConflictDoNothing()
    const candidate = await this.getCandidate({
      tenantId: input.tenantId,
      provider: input.provider,
      candidateId,
    })
    if (candidate === null) throw new DatabaseConflictError('Connector candidate was not retained')
    return candidate
  }

  public async getCandidate(input: {
    tenantId: string
    provider: 'smartthings'
    candidateId: string
  }): Promise<ProviderDeviceCandidate | null> {
    const [row] = await this.database
      .select()
      .from(connectorDeviceCandidates)
      .where(
        and(
          eq(connectorDeviceCandidates.organizationId, input.tenantId),
          eq(connectorDeviceCandidates.provider, input.provider),
          eq(connectorDeviceCandidates.candidateId, input.candidateId),
        ),
      )
      .limit(1)
    return row === undefined ? null : this.#candidate(row)
  }

  public async mapCandidate(input: {
    candidate: ProviderDeviceCandidate
    logicalDevice: Parameters<DeviceMappingPort['mapCandidate']>[0]['logicalDevice']
    confirmedBy: 'human'
  }): Promise<ProviderDeviceMapping> {
    const logical = LogicalDeviceSchema.parse(input.logicalDevice)
    const retained = await this.getCandidate({
      tenantId: input.candidate.tenantId,
      provider: input.candidate.provider,
      candidateId: input.candidate.candidateId,
    })
    if (
      retained === null ||
      retained.providerDeviceId !== input.candidate.providerDeviceId ||
      retained.providerComponentId !== input.candidate.providerComponentId
    ) {
      throw new DatabaseConflictError('Connector candidate does not match its tenant record')
    }
    await this.database.insert(connectorDeviceMappings).values({
      organizationId: input.candidate.tenantId,
      provider: input.candidate.provider,
      slotId: logical.slotId,
      candidateId: input.candidate.candidateId,
      displayName: logical.displayName,
      kind: logical.kind,
      capabilities: [...logical.capabilities],
      confirmedBy: input.confirmedBy,
    })
    return this.getBySlot({
      tenantId: input.candidate.tenantId,
      provider: input.candidate.provider,
      slotId: logical.slotId,
    }).then((mapping) => {
      if (mapping === null) throw new DatabaseConflictError('Connector mapping was not retained')
      return mapping
    })
  }

  public async getBySlot(input: {
    tenantId: string
    provider: 'smartthings'
    slotId: string
  }): Promise<ProviderDeviceMapping | null> {
    const [row] = await this.database
      .select({ mapping: connectorDeviceMappings, candidate: connectorDeviceCandidates })
      .from(connectorDeviceMappings)
      .innerJoin(
        connectorDeviceCandidates,
        and(
          eq(connectorDeviceCandidates.organizationId, connectorDeviceMappings.organizationId),
          eq(connectorDeviceCandidates.provider, connectorDeviceMappings.provider),
          eq(connectorDeviceCandidates.candidateId, connectorDeviceMappings.candidateId),
        ),
      )
      .where(
        and(
          eq(connectorDeviceMappings.organizationId, input.tenantId),
          eq(connectorDeviceMappings.provider, input.provider),
          eq(connectorDeviceMappings.slotId, input.slotId),
        ),
      )
      .limit(1)
    return row === undefined ? null : this.#mapping(row.mapping, this.#candidate(row.candidate))
  }

  public async listByProviderDevice(input: {
    tenantId: string
    provider: 'smartthings'
    providerDeviceId: SecretString
  }): Promise<readonly ProviderDeviceMapping[]> {
    const rows = await this.database
      .select({ mapping: connectorDeviceMappings, candidate: connectorDeviceCandidates })
      .from(connectorDeviceMappings)
      .innerJoin(
        connectorDeviceCandidates,
        and(
          eq(connectorDeviceCandidates.organizationId, connectorDeviceMappings.organizationId),
          eq(connectorDeviceCandidates.provider, connectorDeviceMappings.provider),
          eq(connectorDeviceCandidates.candidateId, connectorDeviceMappings.candidateId),
        ),
      )
      .where(
        and(
          eq(connectorDeviceMappings.organizationId, input.tenantId),
          eq(connectorDeviceMappings.provider, input.provider),
          eq(
            connectorDeviceCandidates.providerDeviceIdDigest,
            this.#cipher.digest(input.providerDeviceId, 'provider-device'),
          ),
        ),
      )
    return rows.map((row) => this.#mapping(row.mapping, this.#candidate(row.candidate)))
  }

  #candidate(row: typeof connectorDeviceCandidates.$inferSelect): ProviderDeviceCandidate {
    return {
      tenantId: row.organizationId,
      provider: row.provider,
      candidateId: row.candidateId,
      providerDeviceId: this.#cipher.open(
        {
          ciphertext: row.providerDeviceIdCiphertext,
          nonce: row.providerDeviceIdNonce,
          tag: row.providerDeviceIdTag,
        },
        `${row.organizationId}:${row.candidateId}:device`,
      ),
      providerComponentId: this.#cipher.open(
        {
          ciphertext: row.providerComponentIdCiphertext,
          nonce: row.providerComponentIdNonce,
          tag: row.providerComponentIdTag,
        },
        `${row.organizationId}:${row.candidateId}:component`,
      ),
      capabilities: row.capabilities.map((capability) =>
        ConnectorCapabilitySchema.parse(capability),
      ),
    }
  }

  #mapping(
    row: typeof connectorDeviceMappings.$inferSelect,
    candidate: ProviderDeviceCandidate,
  ): ProviderDeviceMapping {
    return {
      tenantId: row.organizationId,
      provider: row.provider,
      slotId: row.slotId,
      displayName: row.displayName,
      providerDeviceId: candidate.providerDeviceId,
      providerComponentId: candidate.providerComponentId,
      kind: LogicalDeviceSchema.shape.kind.parse(row.kind),
      capabilities: row.capabilities.map((capability) =>
        ConnectorCapabilitySchema.parse(capability),
      ),
    }
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} digest is invalid`)
}
