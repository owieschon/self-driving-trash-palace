import { createHmac } from 'node:crypto'

import {
  AttemptIdSchema,
  EvidenceIdSchema,
  MissionIdSchema,
  PolicyViolationError,
  PrincipalSchema,
  ReceiptIdSchema,
  TOOL_REGISTRY,
  TOOL_REGISTRY_HASH,
  ToolCallChannelSchema,
  ToolCallIdSchema,
  ToolCallReceiptSchema,
  ToolNameSchema,
  ToolTenantScopeHashSchema,
  hashToolResultSchema,
  hashToolValue,
  parseToolInput,
  parseToolOutput,
  parseToolResult,
  principalHasPermission,
  projectToolSchema,
  type AttemptId,
  type EvidenceId,
  type Mission,
  type OrganizationId,
  type Sha256,
  type ToolCallChannel,
  type ToolInput,
  type ToolName,
  type ToolOutput,
  type ToolResult,
  type ToolResultError,
} from '@trash-palace/core'
import { z } from 'zod'

import { ApplicationError, AuthenticationError, ConflictError, NotFoundError } from './errors.js'
import { assertMissionExecutionContext, type MissionExecutionContext } from './mission-fence.js'
import type { AuthContext, DelegatedAuthContext } from './models.js'
import { CryptoEntropy, SYSTEM_CLOCK, addMilliseconds, iso } from './primitives.js'
import type { ClockPort, EntropyPort, ToolCallReceiptRepositoryPort } from './ports.js'
import {
  OpaqueToolInvocationClaimToken,
  ToolInvocationIdentityConflictError,
  type ToolInvocationBinding,
  type ToolInvocationClaimInput,
  type ToolInvocationClaimedRecord,
  type ToolInvocationCompletedRecord,
  type ToolInvocationExecutionClass,
  type ToolInvocationLedgerPort,
} from './tool-invocation-ledger.js'
import {
  ToolMissionPhaseDeniedError,
  type ToolInvocationPolicyPort,
} from './tool-invocation-policy.js'
import type { ToolInvocationReconciliationEvidencePort } from './tool-invocation-reconciliation-evidence-service.js'

export type AuthenticatedToolIdentity = AuthContext | DelegatedAuthContext | MissionExecutionContext

export interface AuthenticatedToolHostContext {
  readonly authentication: AuthenticatedToolIdentity
  readonly missionId: Mission['id']
  readonly channel: ToolCallChannel
  readonly signal: AbortSignal
  readonly browserMutation?: Readonly<{
    csrfToken: string
    origin: string
    allowedOrigin: string
  }>
}

export interface ToolInvocationRequest<Name extends ToolName = ToolName> {
  readonly callId: string
  readonly toolName: Name
  readonly input: unknown
}

type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value

type HandlerToolOutput<Name extends ToolName> = DeepReadonly<ToolOutput<Name>>

interface ToolHandlerOutcomeBase {
  readonly resourceVersion?: number | null
  readonly attemptId?: AttemptId | null
  readonly evidenceIds?: readonly EvidenceId[]
}

export type ToolHandlerOutcome<Name extends ToolName> =
  | (ToolHandlerOutcomeBase &
      Readonly<{
        status: 'succeeded'
        data: HandlerToolOutput<Name>
        retryable?: false
      }>)
  | (ToolHandlerOutcomeBase &
      Readonly<{
        status: 'pending' | 'unknown'
        data: HandlerToolOutput<Name> | null
        retryable?: boolean
        error?: ToolResultError | null
      }>)

export interface ToolHandlerRequest<Name extends ToolName> {
  readonly callId: ReturnType<typeof ToolCallIdSchema.parse>
  readonly host: AuthenticatedToolHostContext
  readonly mission: Mission
  readonly input: ToolInput<Name>
}

export type ToolHandler<Name extends ToolName> = (
  request: ToolHandlerRequest<Name>,
) => Promise<ToolHandlerOutcome<Name>>

export type ToolHandlerRegistry = {
  readonly [Name in ToolName]: ToolHandler<Name>
}

export class ToolHandlerFailure extends Error {
  public constructor(
    public readonly status: 'conflict' | 'denied' | 'failed',
    public readonly error: ToolResultError,
    public readonly retryable: boolean,
  ) {
    super(error.message)
    this.name = 'ToolHandlerFailure'
  }
}

export class ToolInvocationIntegrityError extends Error {
  override readonly name = 'ToolInvocationIntegrityError'
}

export interface ToolCallReceiptRepositoryResolverPort {
  forTenant(input: {
    readonly organizationId: OrganizationId
    readonly tenantScopeHash: Sha256
  }): ToolCallReceiptRepositoryPort
}

export interface ToolInvocationScopeHasherPort {
  tenant(organizationId: OrganizationId): Sha256
  principal(authentication: AuthenticatedToolIdentity): Sha256
}

export class HmacToolInvocationScopeHasher implements ToolInvocationScopeHasherPort {
  readonly #key: Uint8Array

  public constructor(key: string | Uint8Array) {
    const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : key
    if (bytes.byteLength < 32) {
      throw new RangeError('Tool invocation scope keys must contain at least 32 bytes')
    }
    this.#key = Uint8Array.from(bytes)
  }

  public tenant(organizationId: OrganizationId): Sha256 {
    return ToolTenantScopeHashSchema.parse(this.#digest(`tenant@1.${organizationId}`))
  }

  public principal(authentication: AuthenticatedToolIdentity): Sha256 {
    const principal = PrincipalSchema.parse(authentication.principal)
    const identity =
      'sessionId' in authentication
        ? { kind: 'session', id: authentication.sessionId, principal }
        : 'tokenId' in authentication
          ? { kind: 'delegated', id: authentication.tokenId, principal }
          : {
              kind: 'mission_service',
              id: principal.actorId,
              principal,
            }
    return this.#digest(`principal@1.${hashToolValue(identity)}`)
  }

  #digest(value: string): Sha256 {
    return ToolTenantScopeHashSchema.parse(
      createHmac('sha256', this.#key).update(value, 'utf8').digest('hex'),
    )
  }
}

export interface ToolDispatcherDependencies {
  readonly ledger: ToolInvocationLedgerPort
  readonly receipts: ToolCallReceiptRepositoryResolverPort
  readonly policy: ToolInvocationPolicyPort
  readonly handlers: ToolHandlerRegistry
  readonly reconciliationEvidence: ToolInvocationReconciliationEvidencePort
  readonly scopes: ToolInvocationScopeHasherPort
  readonly clock?: ClockPort
  readonly entropy?: EntropyPort
  readonly claimTtlMilliseconds?: number
}

export class AuthenticatedToolDispatcher {
  readonly #clock: ClockPort
  readonly #entropy: EntropyPort
  readonly #claimTtlMilliseconds: number

  public constructor(private readonly dependencies: ToolDispatcherDependencies) {
    this.#clock = dependencies.clock ?? SYSTEM_CLOCK
    this.#entropy = dependencies.entropy ?? new CryptoEntropy()
    const ttl = dependencies.claimTtlMilliseconds ?? 30_000
    if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > 5 * 60_000) {
      throw new RangeError('Tool invocation claim TTL must be between one second and five minutes')
    }
    this.#claimTtlMilliseconds = ttl
  }

  public async invoke<Name extends ToolName>(
    requestInput: ToolInvocationRequest<Name>,
    hostInput: AuthenticatedToolHostContext,
  ): Promise<ToolResult<Name>> {
    const toolName = ToolNameSchema.parse(requestInput.toolName) as Name
    const callId = ToolCallIdSchema.parse(requestInput.callId)
    const missionId = MissionIdSchema.parse(hostInput.missionId)
    const channel = ToolCallChannelSchema.parse(hostInput.channel)
    const host = { ...hostInput, missionId, channel }
    const principal = this.#assertAuthenticatedHost(host)
    const organizationId = principal.organizationId
    const rawInput = z.json().parse(requestInput.input)
    const inputHash = hashToolValue(rawInput)
    const tenantScopeHash = this.dependencies.scopes.tenant(organizationId)
    const binding: ToolInvocationBinding = {
      organizationId,
      missionId,
      principalScopeHash: this.dependencies.scopes.principal(host.authentication),
      callId,
      toolName,
      channel,
      inputHash,
      toolContractHash: projectToolSchema(toolName).contractHash,
      toolRegistryHash: TOOL_REGISTRY_HASH,
      resultSchemaHash: hashToolResultSchema(toolName),
      executionClass: executionClassFor(toolName),
    }
    const ownerToken = OpaqueToolInvocationClaimToken.fromEntropy(this.#entropy.token(32))
    const startedAt = iso(this.#clock.now())
    const claimInput: ToolInvocationClaimInput = {
      ...binding,
      proposedReceiptId: this.#receiptId(),
      ownerToken,
      startedAt,
      claimExpiresAt: iso(addMilliseconds(this.#clock.now(), this.#claimTtlMilliseconds)),
    }
    const claim = await this.dependencies.ledger.claim(claimInput)

    if (claim.kind === 'completed') {
      return this.#replayCompleted(toolName, tenantScopeHash, claim.invocation)
    }
    if (claim.kind === 'in_progress') {
      return this.#pendingResult(toolName, callId, claim.invocation.receiptId)
    }
    if (claim.disposition === 'resolve_unknown') {
      let evidenceId: EvidenceId
      try {
        const record = await this.dependencies.reconciliationEvidence.recordStillUnknown({
          organizationId,
          missionId,
          callId,
          toolName,
          invocationBindingHash: hashToolValue(binding),
          abandonedClaimGeneration: claim.abandonedClaim.generation,
          claimExpiredAt: claim.abandonedClaim.claimExpiresAt,
        })
        evidenceId = record.evidence.id
      } catch {
        return this.#reconciliationPendingResult(toolName, callId, claim.invocation.receiptId)
      }
      const result = failureResult(toolName, callId, claim.invocation.receiptId, {
        status: 'unknown',
        retryable: false,
        error: safeError(
          'OUTCOME_UNKNOWN',
          'The earlier write may have completed. Durable reconciliation is required before a new call.',
        ),
      })
      return this.#complete(toolName, tenantScopeHash, claimInput, claim.invocation, result, null, [
        evidenceId,
      ])
    }

    const execution = await this.#execute(
      toolName,
      rawInput,
      host,
      principal,
      callId,
      claim.invocation.receiptId,
    )
    return this.#complete(
      toolName,
      tenantScopeHash,
      claimInput,
      claim.invocation,
      execution.result,
      execution.attemptId,
      execution.evidenceIds,
    )
  }

  async #execute<Name extends ToolName>(
    toolName: Name,
    rawInput: z.infer<ReturnType<typeof z.json>>,
    host: AuthenticatedToolHostContext,
    principal: ReturnType<typeof PrincipalSchema.parse>,
    callId: ReturnType<typeof ToolCallIdSchema.parse>,
    receiptId: ReturnType<typeof ReceiptIdSchema.parse>,
  ): Promise<{
    readonly result: ToolResult<Name>
    readonly attemptId: AttemptId | null
    readonly evidenceIds: readonly EvidenceId[]
  }> {
    if (!principalHasPermission(principal, TOOL_REGISTRY[toolName].permission)) {
      return {
        result: failureResult(toolName, callId, receiptId, {
          status: 'denied',
          retryable: false,
          error: safeError('PERMISSION_DENIED', 'The authenticated principal lacks this scope.'),
        }),
        attemptId: null,
        evidenceIds: [],
      }
    }

    let input: ToolInput<Name>
    try {
      input = parseToolInput(toolName, rawInput)
    } catch {
      return {
        result: failureResult(toolName, callId, receiptId, {
          status: 'failed',
          retryable: false,
          error: safeError('INVALID_INPUT', 'The tool input does not match its exact schema.'),
        }),
        attemptId: null,
        evidenceIds: [],
      }
    }

    let mission: Mission
    try {
      mission = await this.dependencies.policy.authorize({
        organizationId: principal.organizationId,
        missionId: host.missionId,
        toolName,
        toolInput: input,
      })
    } catch (error) {
      return {
        result: mapThrownError(toolName, callId, receiptId, error),
        attemptId: null,
        evidenceIds: [],
      }
    }

    let outcome: ToolHandlerOutcome<Name>
    try {
      const handler = this.dependencies.handlers[toolName] as ToolHandler<Name>
      outcome = await handler({ callId, host, mission, input })
    } catch (error) {
      return {
        result: mapThrownError(toolName, callId, receiptId, error),
        attemptId: null,
        evidenceIds: [],
      }
    }

    try {
      const attemptId = AttemptIdSchema.nullable().parse(outcome.attemptId ?? null)
      const evidenceIds = z.array(EvidenceIdSchema).parse([...(outcome.evidenceIds ?? [])])
      if (new Set(evidenceIds).size !== evidenceIds.length) {
        throw new TypeError('Tool handler returned duplicate evidence references')
      }
      if (outcome.status === 'unknown' && attemptId === null && evidenceIds.length === 0) {
        throw new TypeError('Unknown tool outcomes require an attempt or evidence reference')
      }
      return {
        result: handlerResult(toolName, callId, receiptId, outcome),
        attemptId,
        evidenceIds,
      }
    } catch {
      return {
        result: failureResult(toolName, callId, receiptId, {
          status: 'failed',
          retryable: false,
          error: safeError(
            'MALFORMED_HANDLER_OUTPUT',
            'The service returned an output that failed the tool contract.',
          ),
        }),
        attemptId: null,
        evidenceIds: [],
      }
    }
  }

  async #complete<Name extends ToolName>(
    toolName: Name,
    tenantScopeHash: Sha256,
    claimInput: ToolInvocationClaimInput,
    claimed: ToolInvocationClaimedRecord,
    result: ToolResult<Name>,
    attemptId: AttemptId | null,
    evidenceIds: readonly EvidenceId[],
  ): Promise<ToolResult<Name>> {
    const resultHash = hashToolValue(result)
    const completion = await this.dependencies.ledger.complete({
      organizationId: claimInput.organizationId,
      callId: claimInput.callId,
      generation: claimed.generation,
      ownerToken: claimInput.ownerToken,
      result,
      resultHash,
      attemptId,
      evidenceIds,
      completedAt: iso(this.#clock.now()),
    })
    if (completion.kind === 'lost_claim') {
      return this.#pendingResult(toolName, claimInput.callId, claimed.receiptId)
    }
    return this.#replayCompleted(toolName, tenantScopeHash, completion.invocation)
  }

  async #replayCompleted<Name extends ToolName>(
    toolName: Name,
    tenantScopeHash: Sha256,
    invocation: ToolInvocationCompletedRecord,
  ): Promise<ToolResult<Name>> {
    const result = parseToolResult(toolName, invocation.result)
    if (
      result.callId !== invocation.callId ||
      result.receiptId !== invocation.receiptId ||
      invocation.resultHash !== hashToolValue(result)
    ) {
      throw new ToolInvocationIntegrityError('Stored tool result does not match its invocation')
    }
    await this.#appendReceipt(tenantScopeHash, invocation)
    return result
  }

  async #appendReceipt(
    tenantScopeHash: Sha256,
    invocation: ToolInvocationCompletedRecord,
  ): Promise<void> {
    const receipt = ToolCallReceiptSchema.parse({
      schemaVersion: 'tool-call-receipt@1',
      id: invocation.receiptId,
      callId: invocation.callId,
      toolName: invocation.toolName,
      status: parseToolResult(invocation.toolName, invocation.result).status,
      channel: invocation.channel,
      tenantScopeHash,
      inputHash: invocation.inputHash,
      resultHash: invocation.resultHash,
      toolContractHash: invocation.toolContractHash,
      toolRegistryHash: invocation.toolRegistryHash,
      attemptId: invocation.attemptId,
      evidenceIds: invocation.evidenceIds,
      startedAt: invocation.startedAt,
      completedAt: invocation.completedAt,
    })
    await this.dependencies.receipts
      .forTenant({ organizationId: invocation.organizationId, tenantScopeHash })
      .append(receipt)
  }

  #pendingResult<Name extends ToolName>(
    toolName: Name,
    callId: ReturnType<typeof ToolCallIdSchema.parse>,
    receiptId: ReturnType<typeof ReceiptIdSchema.parse>,
  ): ToolResult<Name> {
    return failureResult(toolName, callId, receiptId, {
      status: 'pending',
      retryable: true,
      error: safeError('CALL_IN_PROGRESS', 'The same tool call is still in progress.'),
    })
  }

  #reconciliationPendingResult<Name extends ToolName>(
    toolName: Name,
    callId: ReturnType<typeof ToolCallIdSchema.parse>,
    receiptId: ReturnType<typeof ReceiptIdSchema.parse>,
  ): ToolResult<Name> {
    return failureResult(toolName, callId, receiptId, {
      status: 'pending',
      retryable: true,
      error: safeError(
        'RECONCILIATION_PENDING',
        'The abandoned write is waiting for durable reconciliation evidence.',
      ),
    })
  }

  #assertAuthenticatedHost(
    host: AuthenticatedToolHostContext,
  ): ReturnType<typeof PrincipalSchema.parse> {
    const principal = PrincipalSchema.parse(host.authentication.principal)
    const now = this.#clock.now().getTime()
    if ('sessionId' in host.authentication || 'tokenId' in host.authentication) {
      if (now >= Date.parse(host.authentication.expiresAt)) {
        throw new AuthenticationError('Authenticated tool identity has expired')
      }
    } else {
      assertMissionExecutionContext(host.authentication, {
        organizationId: principal.organizationId,
        missionId: host.missionId,
      })
    }
    host.signal.throwIfAborted()
    return principal
  }

  #receiptId(): ReturnType<typeof ReceiptIdSchema.parse> {
    const suffix = this.#entropy
      .token(18)
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]/g, '_')
    return ReceiptIdSchema.parse(`rcp_x${suffix}`)
  }
}

function executionClassFor(toolName: ToolName): ToolInvocationExecutionClass {
  const contract = TOOL_REGISTRY[toolName]
  if (contract.readOnly) return 'read'
  if (contract.risk === 'consequential') return 'consequential'
  return contract.idempotent ? 'write_idempotent' : 'non_idempotent'
}

function safeError(code: string, message: string): ToolResultError {
  return { code, message, details: {} }
}

function handlerResult<Name extends ToolName>(
  toolName: Name,
  callId: ReturnType<typeof ToolCallIdSchema.parse>,
  receiptId: ReturnType<typeof ReceiptIdSchema.parse>,
  outcome: ToolHandlerOutcome<Name>,
): ToolResult<Name> {
  const data = outcome.data === null ? null : parseToolOutput(toolName, outcome.data)
  return parseToolResult(toolName, {
    schemaVersion: 'tool-result@1',
    toolName,
    callId,
    status: outcome.status,
    retryable: outcome.retryable ?? outcome.status !== 'succeeded',
    data,
    receiptId,
    resourceVersion: outcome.resourceVersion ?? null,
    error: outcome.status === 'succeeded' ? null : (outcome.error ?? null),
  })
}

function failureResult<Name extends ToolName>(
  toolName: Name,
  callId: ReturnType<typeof ToolCallIdSchema.parse>,
  receiptId: ReturnType<typeof ReceiptIdSchema.parse> | undefined,
  failure: Readonly<{
    status: 'conflict' | 'denied' | 'failed' | 'pending' | 'unknown'
    retryable: boolean
    error: ToolResultError
  }>,
): ToolResult<Name> {
  if (receiptId === undefined) {
    throw new ToolInvocationIntegrityError('Tool failure requires a reserved receipt ID')
  }
  return parseToolResult(toolName, {
    schemaVersion: 'tool-result@1',
    toolName,
    callId,
    status: failure.status,
    retryable: failure.retryable,
    data: null,
    receiptId,
    resourceVersion: null,
    error: failure.error,
  })
}

function mapThrownError<Name extends ToolName>(
  toolName: Name,
  callId: ReturnType<typeof ToolCallIdSchema.parse>,
  receiptId: ReturnType<typeof ReceiptIdSchema.parse>,
  error: unknown,
): ToolResult<Name> {
  if (error instanceof ToolHandlerFailure) {
    return failureResult(toolName, callId, receiptId, error)
  }
  if (error instanceof ToolMissionPhaseDeniedError) {
    return failureResult(toolName, callId, receiptId, {
      status: 'denied',
      retryable: false,
      error: safeError('MISSION_PHASE_DENIED', 'The tool is unavailable at this mission phase.'),
    })
  }
  if (error instanceof NotFoundError) {
    return failureResult(toolName, callId, receiptId, {
      status: 'failed',
      retryable: false,
      error: safeError('RESOURCE_NOT_FOUND', 'The requested resource is unavailable.'),
    })
  }
  if (error instanceof AuthenticationError) {
    return failureResult(toolName, callId, receiptId, {
      status: 'denied',
      retryable: false,
      error: safeError('AUTHENTICATION_REQUIRED', 'Current authentication is required.'),
    })
  }
  if (error instanceof ConflictError || error instanceof ApplicationError) {
    return failureResult(toolName, callId, receiptId, {
      status: 'conflict',
      retryable: false,
      error: safeError('CURRENT_STATE_CONFLICT', 'The request conflicts with current state.'),
    })
  }
  if (error instanceof PolicyViolationError) {
    return failureResult(toolName, callId, receiptId, {
      status: 'conflict',
      retryable: false,
      error: safeError('POLICY_CONFLICT', 'The request conflicts with enforced policy.'),
    })
  }
  return failureResult(toolName, callId, receiptId, {
    status: 'failed',
    retryable: false,
    error: safeError('INTERNAL_ERROR', 'The tool invocation failed without a safe result.'),
  })
}

export { ToolInvocationIdentityConflictError }
