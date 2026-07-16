import { readFile, readdir } from 'node:fs/promises'

import {
  TOOL_REGISTRY_HASH,
  EvidenceIdSchema,
  MissionSchema,
  MembershipIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PersistedEvidenceRecordSchema,
  PrincipalSchema,
  ReceiptIdSchema,
  RunIdSchema,
  Sha256Schema,
  ToolCallReceiptSchema,
  ToolCallIdSchema,
  ToolTenantScopeHashSchema,
  UserIdSchema,
  hashToolResultSchema,
  hashToolValue,
  computeToolInvocationReconciliationObservationHash,
  projectToolSchema,
  type MissionId,
  type OrganizationId,
  type ToolName,
} from '@trash-palace/core'
import {
  ContextRequestSchema,
  InternalContextReceiptSchema,
  KnowledgeManifestSchema,
  KnowledgeSourceRecordSchema,
  PublicContextReceiptSchema,
  calculateContextBudgetUsage,
  createContextBundle,
  deriveContextBudget,
  deriveMandatoryContextSelection,
  hashHostPolicyContract,
  projectExactToolContracts,
  projectHostPolicy,
  sha256,
  sha256Text,
} from '@trash-palace/agent'
import {
  KnowledgeSearchService,
  OpaqueToolInvocationClaimToken,
  type ServiceContext,
  type ToolInvocationExecutionClass,
} from '@trash-palace/application'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import {
  PgBootstrapRepository,
  PgContextArtifactRepository,
  PgKnowledgeIndexRepository,
  PgToolCallReceiptRepository,
  PgToolInvocationLedger,
  createUnitOfWork,
} from './repositories.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const organizationId = OrganizationIdSchema.parse('org_m2adaptertenant')
const mirrorOrganizationId = OrganizationIdSchema.parse('org_m2adaptermirror')
const userId = UserIdSchema.parse('usr_m2adapterowner')
const palaceId = PalaceIdSchema.parse('pal_m2adapterhome')
const mirrorPalaceId = PalaceIdSchema.parse('pal_m2adaptermirror')
const membershipId = MembershipIdSchema.parse('mem_m2adapterowner')
const mirrorMembershipId = MembershipIdSchema.parse('mem_m2adaptermirror')
const missionId = 'mis_m2adaptermission' as MissionId
const otherMissionId = 'mis_m2adapterother1' as MissionId
const mirrorMissionId = 'mis_m2adaptermirror1' as MissionId
const runId = RunIdSchema.parse('run_m2adapterrun01')
const otherRunId = RunIdSchema.parse('run_m2adapterrun02')
const createdAt = '2026-07-15T00:00:00.000Z'
const bundleAt = '2026-07-15T00:00:01.000Z'
const receiptAt = '2026-07-15T00:00:02.000Z'
const publicReceiptAt = '2026-07-15T00:00:03.000Z'
const tenantScopeHash = ToolTenantScopeHashSchema.parse('1'.repeat(64))
const mirrorTenantScopeHash = ToolTenantScopeHashSchema.parse('2'.repeat(64))

function toolInvocationBinding(input: {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly callId: string
  readonly toolName: ToolName
  readonly input: unknown
  readonly principalScopeHash: string
  readonly executionClass: ToolInvocationExecutionClass
}) {
  const contract = projectToolSchema(input.toolName)
  return {
    organizationId: input.organizationId,
    missionId: input.missionId,
    principalScopeHash: Sha256Schema.parse(input.principalScopeHash),
    callId: ToolCallIdSchema.parse(input.callId),
    toolName: input.toolName,
    channel: 'mcp' as const,
    inputHash: hashToolValue(input.input),
    toolContractHash: contract.contractHash,
    toolRegistryHash: TOOL_REGISTRY_HASH,
    resultSchemaHash: hashToolResultSchema(input.toolName),
    executionClass: input.executionClass,
  }
}

function invocationReconciliationEvidence(input: {
  readonly evidenceId: ReturnType<typeof EvidenceIdSchema.parse>
  readonly receiptId: string
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly palaceId: ReturnType<typeof PalaceIdSchema.parse>
  readonly binding: ReturnType<typeof toolInvocationBinding>
  readonly toolCallId?: ReturnType<typeof ToolCallIdSchema.parse>
  readonly toolName?: ToolName
  readonly invocationBindingHash?: ReturnType<typeof Sha256Schema.parse>
  readonly abandonedClaimGeneration?: number
}) {
  const observation = {
    schemaVersion: 'tool-invocation-reconciliation-observation@1' as const,
    organizationId: input.organizationId,
    missionId: input.missionId,
    toolCallId: input.toolCallId ?? input.binding.callId,
    toolName: input.toolName ?? input.binding.toolName,
    invocationBindingHash: input.invocationBindingHash ?? hashToolValue(input.binding),
    abandonedClaimGeneration: input.abandonedClaimGeneration ?? 1,
    claimExpiredAt: '2026-07-15T00:02:01.000Z',
    source: 'tool_invocation_ledger' as const,
    observer: 'application_code' as const,
    durableObservation: 'expired_claim_without_terminal_result' as const,
    reconciledOutcome: 'still_unknown' as const,
    observedResultHash: null,
    observedAttemptId: null,
    observedAt: '2026-07-15T00:02:02.000Z',
  }
  return PersistedEvidenceRecordSchema.parse({
    evidence: {
      id: input.evidenceId,
      organizationId: input.organizationId,
      missionId: input.missionId,
      palaceId: input.palaceId,
      type: 'tool_invocation_reconciliation',
      toolCallId: observation.toolCallId,
      toolName: observation.toolName,
      invocationBindingHash: observation.invocationBindingHash,
      abandonedClaimGeneration: observation.abandonedClaimGeneration,
      claimExpiredAt: observation.claimExpiredAt,
      source: observation.source,
      observer: observation.observer,
      durableObservation: observation.durableObservation,
      reconciledOutcome: observation.reconciledOutcome,
      observedResultHash: observation.observedResultHash,
      observedAttemptId: observation.observedAttemptId,
      observationHash: computeToolInvocationReconciliationObservationHash(observation),
      observedAt: observation.observedAt,
    },
    authorityReceipt: {
      schemaVersion: 'evidence-authority-receipt@1',
      id: ReceiptIdSchema.parse(input.receiptId),
      evidenceId: input.evidenceId,
      organizationId: input.organizationId,
      missionId: input.missionId,
      palaceId: input.palaceId,
      authority: 'application',
      producer: 'application_code',
      ruleId: 'tool_invocation.abandoned_write',
      ruleVersion: 1,
      inputEvidenceIds: [],
      derivationVerified: true,
      verifiedAt: observation.observedAt,
    },
    persistedAt: observation.observedAt,
  })
}

databaseDescribe('M2 PostgreSQL adapters', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_palace_m2_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      max: 5,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`SET search_path TO "${schemaName}", public`)
    const migrationDirectory = new URL('../migrations/', import.meta.url)
    const filenames = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort()
    if (filenames.length === 0) throw new Error('Database migration is absent')
    for (const filename of filenames) {
      const migration = (await readFile(new URL(filename, migrationDirectory), 'utf8')).replaceAll(
        '"public".',
        `"${schemaName}".`,
      )
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await pool.query(statement)
      }
    }
    database = createDatabase(pool)
    await seedTenant(database)
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('ranks phase-scoped knowledge while hiding foreign and ineligible sources', async () => {
    const publicContent =
      '# Reconcile unknown outcomes\n\nA timeout is unknown. Reconcile the same operation before retrying.'
    const tenantContent =
      '# Primary den schedule\n\nThe primary tenant calls its battery recovery window moon-snack.'
    const foreignContent =
      '# Mirror den schedule\n\nThe mirror tenant calls its private recovery window forbidden-acorn.'
    const developerOnlyContent =
      '# Internal compiler notes\n\nThe hidden compiler token is developer-only-context.'

    await new PgKnowledgeIndexRepository(database, null).replace({
      source: knowledgeSource({
        id: 'concept.reconcile-unknown',
        content: publicContent,
        visibility: 'public',
        sensitivity: 'public',
        tenantScoped: false,
        publishable: true,
        audiences: ['caretaker', 'developer'],
      }),
      title: 'Reconcile unknown outcomes',
      content: publicContent,
      phases: ['reconcile'],
      indexedAt: createdAt,
    })
    await new PgKnowledgeIndexRepository(database, organizationId).replace({
      source: knowledgeSource({
        id: 'tenant.primary-den-schedule',
        content: tenantContent,
        visibility: 'tenant',
        sensitivity: 'internal',
        tenantScoped: true,
        publishable: false,
        audiences: ['caretaker'],
      }),
      title: 'Primary den schedule',
      content: tenantContent,
      phases: ['understand', 'plan'],
      indexedAt: createdAt,
    })
    await new PgKnowledgeIndexRepository(database, mirrorOrganizationId).replace({
      source: knowledgeSource({
        id: 'tenant.mirror-den-schedule',
        content: foreignContent,
        visibility: 'tenant',
        sensitivity: 'internal',
        tenantScoped: true,
        publishable: false,
        audiences: ['caretaker'],
      }),
      title: 'Mirror den schedule',
      content: foreignContent,
      phases: ['understand'],
      indexedAt: createdAt,
    })
    await new PgKnowledgeIndexRepository(database, null).replace({
      source: knowledgeSource({
        id: 'internal.compiler-notes',
        content: developerOnlyContent,
        visibility: 'internal',
        sensitivity: 'internal',
        tenantScoped: false,
        publishable: false,
        audiences: ['developer'],
      }),
      title: 'Internal compiler notes',
      content: developerOnlyContent,
      phases: ['understand'],
      indexedAt: createdAt,
    })

    const service = new KnowledgeSearchService(createUnitOfWork(database))
    expect(
      await service.search({
        context: serviceContext(organizationId),
        query: 'timeout retry operation',
        phase: 'reconcile',
      }),
    ).toEqual({
      results: [
        expect.objectContaining({
          sourceId: 'concept.reconcile-unknown',
          version: '1.0.0',
          title: 'Reconcile unknown outcomes',
        }),
      ],
    })
    expect(
      await service.search({
        context: serviceContext(organizationId),
        query: 'moon-snack',
        phase: 'understand',
      }),
    ).toEqual({ results: [expect.objectContaining({ sourceId: 'tenant.primary-den-schedule' })] })
    expect(
      await service.search({
        context: serviceContext(organizationId),
        query: 'forbidden-acorn',
        phase: 'understand',
      }),
    ).toEqual({ results: [] })
    expect(
      await service.search({
        context: serviceContext(organizationId),
        query: 'developer-only-context',
        phase: 'understand',
      }),
    ).toEqual({ results: [] })
    expect(
      await service.search({
        context: serviceContext(organizationId),
        query: 'unknown outcomes',
        phase: 'plan',
      }),
    ).toEqual({ results: [] })

    expect(() =>
      service.search({
        context: {
          principal: PrincipalSchema.parse({
            organizationId,
            actorId: userId,
            role: 'delegated',
            operatorGrants: [],
            delegatedPermissions: [],
          }),
          source: 'system',
        },
        query: 'timeout',
        phase: 'reconcile',
      }),
    ).toThrow(/knowledge:read/)
    await expect(
      new PgKnowledgeIndexRepository(database, organizationId).replace({
        source: knowledgeSource({
          id: 'concept.invalid-global-scope',
          content: publicContent,
          visibility: 'public',
          sensitivity: 'public',
          tenantScoped: false,
          publishable: true,
          audiences: ['caretaker'],
        }),
        title: 'Invalid tenant scope',
        content: publicContent,
        phases: ['understand'],
        indexedAt: createdAt,
      }),
    ).rejects.toThrow(/scope/)
  })

  it('retains hash-only, tenant-bound tool receipts and rejects stale contracts', async () => {
    const receipt = ToolCallReceiptSchema.parse({
      schemaVersion: 'tool-call-receipt@1',
      id: 'rcp_toolreceipt01',
      callId: 'call_toolreceipt01',
      toolName: 'knowledge.search',
      status: 'succeeded',
      channel: 'mcp',
      tenantScopeHash,
      inputHash: '3'.repeat(64),
      resultHash: '4'.repeat(64),
      toolContractHash: projectToolSchema('knowledge.search').contractHash,
      toolRegistryHash: TOOL_REGISTRY_HASH,
      attemptId: null,
      evidenceIds: [],
      startedAt: createdAt,
      completedAt: bundleAt,
    })
    const repository = new PgToolCallReceiptRepository(database, organizationId, tenantScopeHash)
    await repository.append(receipt)
    await repository.append(receipt)
    expect(await repository.get(receipt.id)).toEqual(receipt)
    expect(await repository.findByCallId(receipt.callId)).toEqual(receipt)
    expect(
      await new PgToolCallReceiptRepository(
        database,
        mirrorOrganizationId,
        mirrorTenantScopeHash,
      ).get(receipt.id),
    ).toBeNull()

    await expect(
      repository.append(
        ToolCallReceiptSchema.parse({
          ...receipt,
          id: 'rcp_wrongscope001',
          callId: 'call_wrongscope001',
          tenantScopeHash: mirrorTenantScopeHash,
        }),
      ),
    ).rejects.toThrow(/tenant scope/)
    await expect(
      repository.append(
        ToolCallReceiptSchema.parse({
          ...receipt,
          id: 'rcp_stalecontract1',
          callId: 'call_stalecontract1',
          toolContractHash: '5'.repeat(64),
        }),
      ),
    ).rejects.toThrow(/contract hash/)
    await expect(
      repository.append(
        ToolCallReceiptSchema.parse({
          ...receipt,
          id: 'rcp_reusedcall001',
          resultHash: '6'.repeat(64),
        }),
      ),
    ).rejects.toThrow(/identity is already bound/)
    await expect(
      repository.append(
        ToolCallReceiptSchema.parse({
          ...receipt,
          id: 'rcp_missingevid01',
          callId: 'call_missingevid01',
          evidenceIds: ['evd_missingevid01'],
        }),
      ),
    ).rejects.toThrow(/invariant|foreign key/i)
    expect(await repository.get(ReceiptIdSchema.parse('rcp_missingevid01'))).toBeNull()

    await expect(
      pool.query(`UPDATE "${schemaName}"."tool_call_receipts" SET status = 'failed'`),
    ).rejects.toThrow(/append-only|immutable/)
    await expect(
      pool.query(`DELETE FROM "${schemaName}"."tool_call_receipts" WHERE id = $1`, [receipt.id]),
    ).rejects.toThrow(/append-only|immutable/)

    const [columns, stored] = await Promise.all([
      pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tool_call_receipts' ORDER BY column_name`,
        [schemaName],
      ),
      pool.query<{ input_hash: string; result_hash: string; tenant_scope_hash: string }>(
        `SELECT input_hash, result_hash, tenant_scope_hash FROM "${schemaName}"."tool_call_receipts" WHERE id = $1`,
        [receipt.id],
      ),
    ])
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['input', 'output', 'payload', 'actor_id']),
    )
    expect(stored.rows[0]).toEqual({
      input_hash: receipt.inputHash,
      result_hash: receipt.resultHash,
      tenant_scope_hash: receipt.tenantScopeHash,
    })
  })

  it('claims one private invocation owner and replays its exact validated result', async () => {
    const ledger = new PgToolInvocationLedger(database, organizationId)
    const firstOwner = OpaqueToolInvocationClaimToken.fromEntropy('first-owner-token-for-race')
    const secondOwner = OpaqueToolInvocationClaimToken.fromEntropy('second-owner-token-for-race')
    const binding = toolInvocationBinding({
      organizationId,
      missionId,
      callId: 'call_invocationrace1',
      toolName: 'knowledge.search',
      input: { query: 'homecoming', phase: 'understand' },
      principalScopeHash: 'a'.repeat(64),
      executionClass: 'read',
    })
    const contenders = [
      {
        ownerToken: firstOwner,
        proposedReceiptId: ReceiptIdSchema.parse('rcp_invocationrace1'),
      },
      {
        ownerToken: secondOwner,
        proposedReceiptId: ReceiptIdSchema.parse('rcp_invocationrace2'),
      },
    ] as const
    const claims = await Promise.all(
      contenders.map((contender) =>
        ledger.claim({
          ...binding,
          ...contender,
          startedAt: createdAt,
          claimExpiresAt: bundleAt,
        }),
      ),
    )
    expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1)
    expect(claims.filter((claim) => claim.kind === 'in_progress')).toHaveLength(1)
    const winnerIndex = claims.findIndex((claim) => claim.kind === 'claimed')
    const winner = claims[winnerIndex]!
    if (winner.kind !== 'claimed') throw new Error('Concurrent invocation claim had no winner')
    expect(winner.disposition).toBe('execute')

    const result = {
      schemaVersion: 'tool-result@1',
      toolName: 'knowledge.search',
      callId: binding.callId,
      status: 'succeeded',
      data: { results: [] },
      error: null,
      retryable: false,
      receiptId: winner.invocation.receiptId,
      resourceVersion: null,
    } as const
    const resultHash = hashToolValue(result)
    const completion = await ledger.complete({
      organizationId,
      callId: binding.callId,
      generation: winner.invocation.generation,
      ownerToken: contenders[winnerIndex]!.ownerToken,
      result,
      resultHash,
      attemptId: null,
      evidenceIds: [],
      completedAt: receiptAt,
    })
    expect(completion.kind).toBe('completed')
    if (completion.kind !== 'completed') throw new Error('Invocation completion lost its claim')
    expect(completion.invocation.result).toEqual(result)
    expect(completion.invocation.resultHash).toBe(resultHash)

    const replay = await ledger.claim({
      ...binding,
      proposedReceiptId: ReceiptIdSchema.parse('rcp_invocationrace3'),
      ownerToken: OpaqueToolInvocationClaimToken.fromEntropy('replay-owner-token-for-race'),
      startedAt: publicReceiptAt,
      claimExpiresAt: '2026-07-15T00:00:04.000Z',
    })
    expect(replay.kind).toBe('completed')
    if (replay.kind !== 'completed') throw new Error('Completed invocation did not replay')
    expect(replay.invocation.receiptId).toBe(winner.invocation.receiptId)
    expect(replay.invocation.result).toEqual(result)
    expect(replay.invocation.resultHash).toBe(resultHash)
    await expect(
      ledger.claim({
        ...binding,
        inputHash: hashToolValue({ query: 'different' }),
        proposedReceiptId: ReceiptIdSchema.parse('rcp_invocationrace4'),
        ownerToken: OpaqueToolInvocationClaimToken.fromEntropy('changed-input-owner-token'),
        startedAt: publicReceiptAt,
        claimExpiresAt: '2026-07-15T00:00:04.000Z',
      }),
    ).rejects.toThrow(/identity is already bound/)
    await expect(
      ledger.claim({
        ...binding,
        principalScopeHash: Sha256Schema.parse('b'.repeat(64)),
        proposedReceiptId: ReceiptIdSchema.parse('rcp_invocationrace5'),
        ownerToken: OpaqueToolInvocationClaimToken.fromEntropy('changed-principal-token'),
        startedAt: publicReceiptAt,
        claimExpiresAt: '2026-07-15T00:00:04.000Z',
      }),
    ).rejects.toThrow(/identity is already bound/)

    const mirrorLedger = new PgToolInvocationLedger(database, mirrorOrganizationId)
    const mirrorClaim = await mirrorLedger.claim({
      ...binding,
      organizationId: mirrorOrganizationId,
      missionId: mirrorMissionId,
      principalScopeHash: Sha256Schema.parse('c'.repeat(64)),
      proposedReceiptId: ReceiptIdSchema.parse('rcp_invocationmirror'),
      ownerToken: OpaqueToolInvocationClaimToken.fromEntropy('mirror-owner-token-for-race'),
      startedAt: createdAt,
      claimExpiresAt: bundleAt,
    })
    expect(mirrorClaim.kind).toBe('claimed')
    if (mirrorClaim.kind !== 'claimed') throw new Error('Mirror tenant did not claim its call')
    expect(mirrorClaim.disposition).toBe('execute')
    expect(mirrorClaim.invocation.organizationId).toBe(mirrorOrganizationId)

    const stored = await pool.query<{
      owner_token_hash: string
      result: unknown
      result_hash: string
    }>(
      `SELECT owner_token_hash, result, result_hash FROM "${schemaName}"."tool_invocations" WHERE organization_id = $1 AND call_id = $2`,
      [organizationId, binding.callId],
    )
    expect(stored.rows[0]).toEqual({
      owner_token_hash: contenders[winnerIndex]!.ownerToken.storageFingerprint(),
      result,
      result_hash: resultHash,
    })
  })

  it('reclaims reads but resolves abandoned writes as unknown without execution', async () => {
    const ledger = new PgToolInvocationLedger(database, organizationId)
    const expiredAt = '2026-07-15T00:01:01.000Z'
    const recoveryAt = '2026-07-15T00:01:02.000Z'
    const recoveryExpiresAt = '2026-07-15T00:01:03.000Z'
    const readBinding = toolInvocationBinding({
      organizationId,
      missionId,
      callId: 'call_expiredread001',
      toolName: 'knowledge.search',
      input: { query: 'recovery', phase: 'reconcile' },
      principalScopeHash: 'd'.repeat(64),
      executionClass: 'read',
    })
    const readFirstOwner = OpaqueToolInvocationClaimToken.fromEntropy('expired-read-first-owner')
    await ledger.claim({
      ...readBinding,
      proposedReceiptId: ReceiptIdSchema.parse('rcp_expiredread001'),
      ownerToken: readFirstOwner,
      startedAt: '2026-07-15T00:01:00.000Z',
      claimExpiresAt: expiredAt,
    })
    const readRecoveryOwner = OpaqueToolInvocationClaimToken.fromEntropy(
      'expired-read-recovery-owner',
    )
    const readRecovery = await ledger.claim({
      ...readBinding,
      proposedReceiptId: ReceiptIdSchema.parse('rcp_expiredread002'),
      ownerToken: readRecoveryOwner,
      startedAt: recoveryAt,
      claimExpiresAt: recoveryExpiresAt,
    })
    expect(readRecovery.kind).toBe('claimed')
    if (readRecovery.kind !== 'claimed') throw new Error('Expired read was not reclaimed')
    expect(readRecovery.disposition).toBe('execute')
    expect(readRecovery.invocation.generation).toBe(2)
    expect(readRecovery.invocation.receiptId).toBe('rcp_expiredread001')
    const staleReadResult = {
      schemaVersion: 'tool-result@1',
      toolName: 'knowledge.search',
      callId: readBinding.callId,
      status: 'succeeded',
      data: { results: [] },
      error: null,
      retryable: false,
      receiptId: 'rcp_expiredread001',
      resourceVersion: null,
    } as const
    expect(
      await ledger.complete({
        organizationId,
        callId: readBinding.callId,
        generation: 1,
        ownerToken: readFirstOwner,
        result: staleReadResult,
        resultHash: hashToolValue(staleReadResult),
        attemptId: null,
        evidenceIds: [],
        completedAt: recoveryAt,
      }),
    ).toEqual({ kind: 'lost_claim', current: 'in_progress' })

    const reconciliationEvidenceIds = [
      EvidenceIdSchema.parse('evd_invocationunknown1'),
      EvidenceIdSchema.parse('evd_invocationunknown2'),
      EvidenceIdSchema.parse('evd_invocationcrossmission'),
      EvidenceIdSchema.parse('evd_invocationwrongcall'),
      EvidenceIdSchema.parse('evd_invocationwrongtool'),
      EvidenceIdSchema.parse('evd_invocationwrongbinding'),
      EvidenceIdSchema.parse('evd_invocationwronggeneration'),
    ] as const
    for (const [index, tool] of (
      [
        ['plans.request_approval', 'non_idempotent'],
        ['plans.activate', 'consequential'],
      ] as const
    ).entries()) {
      const suffix = String(index + 1).padStart(3, '0')
      const binding = toolInvocationBinding({
        organizationId,
        missionId,
        callId: `call_expiredwrite${suffix}`,
        toolName: tool[0],
        input: { fixture: suffix },
        principalScopeHash: `${index + 5}`.repeat(64),
        executionClass: tool[1],
      })
      const evidenceRecords = [
        invocationReconciliationEvidence({
          evidenceId: reconciliationEvidenceIds[index]!,
          receiptId: `rcp_invocationevidence${index + 1}`,
          organizationId,
          missionId,
          palaceId,
          binding,
        }),
        ...(index === 0
          ? [
              invocationReconciliationEvidence({
                evidenceId: reconciliationEvidenceIds[2],
                receiptId: 'rcp_invocationevidence3',
                organizationId,
                missionId: otherMissionId,
                palaceId,
                binding,
              }),
              invocationReconciliationEvidence({
                evidenceId: reconciliationEvidenceIds[3],
                receiptId: 'rcp_invocationevidence4',
                organizationId,
                missionId,
                palaceId,
                binding,
                toolCallId: ToolCallIdSchema.parse('call_unrelatedwrite01'),
              }),
              invocationReconciliationEvidence({
                evidenceId: reconciliationEvidenceIds[4],
                receiptId: 'rcp_invocationevidence5',
                organizationId,
                missionId,
                palaceId,
                binding,
                toolName: 'plans.activate',
              }),
              invocationReconciliationEvidence({
                evidenceId: reconciliationEvidenceIds[5],
                receiptId: 'rcp_invocationevidence6',
                organizationId,
                missionId,
                palaceId,
                binding,
                invocationBindingHash: Sha256Schema.parse('f'.repeat(64)),
              }),
              invocationReconciliationEvidence({
                evidenceId: reconciliationEvidenceIds[6],
                receiptId: 'rcp_invocationevidence7',
                organizationId,
                missionId,
                palaceId,
                binding,
                abandonedClaimGeneration: 2,
              }),
            ]
          : []),
      ]
      await createUnitOfWork(database).run(organizationId, (repositories) =>
        repositories.evidence.appendMany(evidenceRecords),
      )
      await ledger.claim({
        ...binding,
        proposedReceiptId: ReceiptIdSchema.parse(`rcp_expiredwrite${suffix}`),
        ownerToken: OpaqueToolInvocationClaimToken.fromEntropy(`write-first-owner-${suffix}`),
        startedAt: '2026-07-15T00:02:00.000Z',
        claimExpiresAt: '2026-07-15T00:02:01.000Z',
      })
      const recoveryOwner = OpaqueToolInvocationClaimToken.fromEntropy(
        `write-recovery-owner-${suffix}`,
      )
      const recovery = await ledger.claim({
        ...binding,
        proposedReceiptId: ReceiptIdSchema.parse(`rcp_expiredretry${suffix}`),
        ownerToken: recoveryOwner,
        startedAt: '2026-07-15T00:02:02.000Z',
        claimExpiresAt: '2026-07-15T00:02:03.000Z',
      })
      expect(recovery.kind).toBe('claimed')
      if (recovery.kind !== 'claimed') throw new Error('Expired write was not reclaimed')
      expect(recovery.disposition).toBe('resolve_unknown')
      expect(recovery.invocation.generation).toBe(2)
      const result = {
        schemaVersion: 'tool-result@1',
        toolName: tool[0],
        callId: binding.callId,
        status: 'unknown',
        data: null,
        error: {
          code: 'OUTCOME_UNKNOWN',
          message: 'The abandoned write requires evidence-backed reconciliation.',
          details: {},
        },
        retryable: false,
        receiptId: recovery.invocation.receiptId,
        resourceVersion: null,
      } as const
      const resultHash = hashToolValue(result)
      if (index === 0) {
        await expect(
          ledger.complete({
            organizationId,
            callId: binding.callId,
            generation: recovery.invocation.generation,
            ownerToken: recoveryOwner,
            result,
            resultHash,
            attemptId: null,
            evidenceIds: [],
            completedAt: '2026-07-15T00:02:04.000Z',
          }),
        ).rejects.toThrow(/reconciliation evidence/)
        await expect(
          ledger.complete({
            organizationId,
            callId: binding.callId,
            generation: recovery.invocation.generation,
            ownerToken: recoveryOwner,
            result,
            resultHash,
            attemptId: null,
            evidenceIds: [reconciliationEvidenceIds[2]],
            completedAt: '2026-07-15T00:02:04.000Z',
          }),
        ).rejects.toThrow(/invocation mission/)
        for (const unrelatedEvidenceId of reconciliationEvidenceIds.slice(3)) {
          await expect(
            ledger.complete({
              organizationId,
              callId: binding.callId,
              generation: recovery.invocation.generation,
              ownerToken: recoveryOwner,
              result,
              resultHash,
              attemptId: null,
              evidenceIds: [unrelatedEvidenceId],
              completedAt: '2026-07-15T00:02:04.000Z',
            }),
          ).rejects.toThrow(/does not bind/)
        }
      }
      const completed = await ledger.complete({
        organizationId,
        callId: binding.callId,
        generation: recovery.invocation.generation,
        ownerToken: recoveryOwner,
        result,
        resultHash,
        attemptId: null,
        evidenceIds: [reconciliationEvidenceIds[index]!],
        completedAt: '2026-07-15T00:02:04.000Z',
      })
      expect(completed.kind).toBe('completed')
      if (completed.kind !== 'completed') throw new Error('Unknown resolution lost its claim')
      expect(completed.invocation.result).toEqual(result)
      expect(completed.invocation.resultHash).toBe(resultHash)
      expect(completed.invocation.evidenceIds).toEqual([reconciliationEvidenceIds[index]!])
      const replay = await ledger.claim({
        ...binding,
        proposedReceiptId: ReceiptIdSchema.parse(`rcp_expiredreplay${suffix}`),
        ownerToken: OpaqueToolInvocationClaimToken.fromEntropy(`write-replay-owner-${suffix}`),
        startedAt: '2026-07-15T00:02:05.000Z',
        claimExpiresAt: '2026-07-15T00:02:06.000Z',
      })
      expect(replay.kind).toBe('completed')
      if (replay.kind !== 'completed') throw new Error('Unknown resolution did not replay')
      expect(replay.invocation.receiptId).toBe(recovery.invocation.receiptId)
      expect(replay.invocation.result).toEqual(result)
      expect(replay.invocation.resultHash).toBe(resultHash)
      expect(replay.invocation.evidenceIds).toEqual([reconciliationEvidenceIds[index]!])
    }

    await expect(
      pool.query(
        `UPDATE "${schemaName}"."tool_invocations" SET principal_scope_hash = $1 WHERE organization_id = $2 AND call_id = $3`,
        ['f'.repeat(64), organizationId, 'call_expiredwrite001'],
      ),
    ).rejects.toThrow(/immutable/)
    await expect(
      pool.query(
        `DELETE FROM "${schemaName}"."tool_invocation_evidence" WHERE organization_id = $1 AND call_id = $2`,
        [organizationId, 'call_expiredwrite001'],
      ),
    ).rejects.toThrow(/append-only/)
  })

  it('freezes linked rich context artifacts under one tenant mission and run', async () => {
    const repository = new PgContextArtifactRepository(database, organizationId)
    const artifacts = contextArtifactsFixture(runId)

    await repository.insert({
      missionId,
      runId,
      value: { kind: 'request', artifact: artifacts.request },
    })
    await repository.insert({
      missionId,
      runId,
      value: { kind: 'manifest', artifact: artifacts.manifest },
    })
    await repository.insert({
      missionId,
      runId,
      value: { kind: 'bundle', artifact: artifacts.bundle },
    })
    await repository.insert({
      missionId,
      runId,
      value: { kind: 'internal_receipt', artifact: artifacts.internalReceipt },
    })
    await repository.insert({
      missionId,
      runId,
      value: { kind: 'public_receipt', artifact: artifacts.publicReceipt },
    })
    await repository.insert({
      missionId,
      runId,
      value: { kind: 'public_receipt', artifact: artifacts.publicReceipt },
    })

    const retained = await repository.listForRun(missionId, runId)
    expect(retained.map((item) => item.value.kind)).toEqual([
      'request',
      'bundle',
      'manifest',
      'internal_receipt',
      'public_receipt',
    ])
    expect(retained.every((item) => item.artifactHash === sha256(item.value.artifact))).toBe(true)
    expect(
      await new PgContextArtifactRepository(database, mirrorOrganizationId).get(
        'bundle',
        artifacts.bundle.bundleId,
      ),
    ).toBeNull()

    await expect(
      repository.insert({
        missionId: otherMissionId,
        runId,
        value: {
          kind: 'request',
          artifact: ContextRequestSchema.parse({
            ...artifacts.request,
            requestId: 'request_context_other1',
          }),
        },
      }),
    ).rejects.toThrow(/another mission/)

    const orphan = contextArtifactsFixture(otherRunId)
    await expect(
      repository.insert({
        missionId,
        runId: otherRunId,
        value: { kind: 'internal_receipt', artifact: orphan.internalReceipt },
      }),
    ).rejects.toThrow(/bound request/)
    expect(await repository.listForRun(missionId, otherRunId)).toEqual([])

    await repository.insert({
      missionId,
      runId: otherRunId,
      value: { kind: 'request', artifact: orphan.request },
    })
    expect((await repository.listForRun(missionId, otherRunId))[0]?.value.kind).toBe('request')

    await expect(
      pool.query(`UPDATE "${schemaName}"."context_artifacts" SET artifact_hash = $1`, [
        'f'.repeat(64),
      ]),
    ).rejects.toThrow(/append-only|immutable/)
    await expect(
      pool.query(`DELETE FROM "${schemaName}"."context_runs" WHERE run_id = $1`, [runId]),
    ).rejects.toThrow(/append-only|immutable/)
  })
})

async function seedTenant(database: Database): Promise<void> {
  const bootstrap = new PgBootstrapRepository(database)
  await bootstrap.insertOrganization({
    id: organizationId,
    slug: 'm2-adapter-tenant',
    name: 'M2 Adapter Tenant',
    labTenant: true,
    createdAt,
  })
  await bootstrap.insertOrganization({
    id: mirrorOrganizationId,
    slug: 'm2-adapter-mirror',
    name: 'M2 Adapter Mirror',
    labTenant: true,
    createdAt,
  })
  await bootstrap.insertUser({ id: userId, displayName: 'Rocky', createdAt })
  const unitOfWork = createUnitOfWork(database)
  for (const tenantId of [organizationId, mirrorOrganizationId]) {
    await unitOfWork.run(tenantId, async (repositories) => {
      await repositories.records.insertMembership({
        id: tenantId === organizationId ? membershipId : mirrorMembershipId,
        organizationId: tenantId,
        userId,
        role: 'owner',
        grants: [],
        createdAt,
        revokedAt: null,
      })
      await repositories.records.insertPalace({
        id: tenantId === organizationId ? palaceId : mirrorPalaceId,
        organizationId: tenantId,
        name: tenantId === organizationId ? 'Primary Trash Palace' : 'Mirror Trash Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 75,
        createdAt,
      })
    })
  }
  await unitOfWork.run(organizationId, async (repositories) => {
    await repositories.missions.insert(mission(missionId, palaceId))
    await repositories.missions.insert(mission(otherMissionId, palaceId))
  })
  await unitOfWork.run(mirrorOrganizationId, async (repositories) => {
    await repositories.missions.insert(
      mission(mirrorMissionId, mirrorPalaceId, mirrorOrganizationId),
    )
  })
}

function mission(
  id: MissionId,
  inputPalaceId: typeof palaceId,
  inputOrganizationId: OrganizationId = organizationId,
) {
  return MissionSchema.parse({
    id,
    organizationId: inputOrganizationId,
    palaceId: inputPalaceId,
    initiatedBy: userId,
    objective: 'Prepare the trash palace for a verified homecoming',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: ['routine_matches_plan'],
    state: { status: 'running', phase: 'understand' },
    version: 0,
    runId: null,
    contextReceiptId: null,
    taskLedger: [],
    createdAt,
    updatedAt: createdAt,
  })
}

function serviceContext(inputOrganizationId: OrganizationId): ServiceContext {
  return {
    principal: PrincipalSchema.parse({
      organizationId: inputOrganizationId,
      actorId: userId,
      role: 'service',
      operatorGrants: [],
      delegatedPermissions: [],
    }),
    source: 'system',
  }
}

function knowledgeSource(input: {
  id: string
  content: string
  visibility: 'public' | 'internal' | 'tenant'
  sensitivity: 'public' | 'internal' | 'confidential'
  tenantScoped: boolean
  publishable: boolean
  audiences: readonly ('caretaker' | 'developer')[]
}) {
  return KnowledgeSourceRecordSchema.parse({
    id: input.id,
    owner: 'Trash Palace maintainers',
    claimIds: [],
    dependsOn: [],
    audiences: input.audiences,
    tasks: ['recover one homecoming operation'],
    risk: 'read',
    visibility: input.visibility,
    sensitivity: input.sensitivity,
    tenantScoped: input.tenantScoped,
    publishable: input.publishable,
    instructionRole: 'reference',
    retention: 'versioned',
    verifiedAgainst: { toolRegistry: '1.0.0' },
    version: '1.0.0',
    canonicalUri: `knowledge/index/${input.id}.md`,
    sha256: sha256Text(input.content),
  })
}

function contextArtifactsFixture(inputRunId: typeof runId) {
  const policyHash = hashHostPolicyContract()
  const phase = 'plan' as const
  const risk = 'consequential-write' as const
  const mandatory = deriveMandatoryContextSelection(phase, risk)
  const contractPins = {
    app: { version: '1.0.0', sha256: 'a'.repeat(64) },
    api: { version: '1.0.0', sha256: 'b'.repeat(64) },
    toolRegistry: { version: '1.0.0', sha256: TOOL_REGISTRY_HASH },
    policy: { version: '1.0.0', sha256: policyHash },
  }
  const request = ContextRequestSchema.parse({
    schemaVersion: '1.0.0',
    requestId: `request_context_${inputRunId.slice(-8)}`,
    missionRef: 'mission_m2adaptermission',
    runRef: inputRunId,
    audience: 'caretaker',
    phase,
    risk,
    publicOnly: false,
    mandatorySourceIds: mandatory.sourceIds,
    requiredToolNames: mandatory.toolNames,
    optionalSourceIds: ['concept.evidence-improvement'],
    contractPins,
    createdAt,
  })
  const hostPolicy = projectHostPolicy(policyHash)
  const exactContracts = projectExactToolContracts(mandatory.toolNames)
  const sections = mandatory.sourceIds.map((sourceId) => {
    const content = `Pinned context for ${sourceId}.`
    return {
      sourceId,
      sourceVersion: '1.0.0',
      sourceHash: sha256Text(content),
      canonicalUri: `knowledge/generated/${sourceId}.md`,
      claimIds: [],
      instructionRole: sourceId.startsWith('skill.')
        ? ('procedure' as const)
        : ('reference' as const),
      selectionReason: sourceId.startsWith('skill.')
        ? ('homecoming-skill' as const)
        : ('mandatory-dependency' as const),
      content,
    }
  })
  const runtimeSnapshots = [] as const
  const budget = deriveContextBudget(risk)
  const usage = calculateContextBudgetUsage({
    hostPolicy,
    exactContracts,
    sections,
    runtimeSnapshots,
  })
  const bundle = createContextBundle({
    schemaVersion: '1.0.0',
    bundleId: `bundle_context_${inputRunId.slice(-8)}`,
    requestId: request.requestId,
    createdAt: bundleAt,
    frozenAt: bundleAt,
    phase: request.phase,
    risk: request.risk,
    contractPins,
    hostPolicy,
    exactContracts,
    sections,
    runtimeSnapshots,
    budget,
    usage,
  })
  const namedPin = (id: string, hash = 'd'.repeat(64)) => ({
    id,
    version: '1.0.0',
    sha256: hash,
  })
  const manifest = KnowledgeManifestSchema.parse({
    schemaVersion: '1.0.0',
    manifestId: `manifest.context-${inputRunId.slice(-8)}`,
    schema: namedPin('schema.context'),
    bundle: namedPin('bundle.context', bundle.bundleHash),
    compiler: namedPin('compiler.context'),
    app: namedPin('app.trash-palace'),
    api: namedPin('api.v1'),
    toolRegistry: namedPin('registry.tools', TOOL_REGISTRY_HASH),
    policy: namedPin('policy.caretaker', policyHash),
    sources: [
      {
        ...namedPin('procedure.homecoming'),
        canonicalUri: 'knowledge/guides/create-approve-and-verify-a-routine.md',
      },
    ],
    artifacts: [
      {
        ...namedPin('skill.homecoming'),
        canonicalUri: 'packages/agent/skills/operating-homecoming-missions/SKILL.md',
      },
    ],
    createdAt: bundleAt,
  })
  const internalReceipt = InternalContextReceiptSchema.parse({
    schemaVersion: '1.0.0',
    receiptId: `receipt_internal_${inputRunId.slice(-8)}`,
    requestId: request.requestId,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    manifestHash: sha256(manifest),
    createdAt: receiptAt,
    selectedSources: sections.map((section) => ({
      id: section.sourceId,
      sha256: section.sourceHash,
      reason: section.selectionReason,
    })),
    excludedSources: [{ id: 'tenant.notes', reason: 'cross-tenant' }],
    runtimeVersions: {
      app: '1.0.0',
      api: '1.0.0',
      compiler: '1.0.0',
      toolRegistry: '1.0.0',
      policy: '1.0.0',
    },
    redactionCounts: { credential: 0 },
    privateTraceCorrelation: `trace_context_${inputRunId.slice(-8)}`,
    internalEvidenceUri: 'artifacts/internal/context.json',
  })
  const publicReceipt = PublicContextReceiptSchema.parse({
    schemaVersion: '1.0.0',
    receiptId: `receipt_public_${inputRunId.slice(-8)}`,
    createdAt: publicReceiptAt,
    safeVersions: [
      { component: 'app', version: '1.0.0' },
      { component: 'context', version: '1.0.0' },
    ],
    citations: [
      {
        title: 'Unknown outcomes are not failures',
        uri: 'knowledge/concepts/unknown-outcomes.md',
        claimIds: ['TP-RELIABILITY-001'],
      },
    ],
    selectionRationale: ['Selected the recovery reference for an unknown operation outcome.'],
    evidenceUri: 'artifacts/public/context.json',
    redactionSummary: { fieldsRemoved: 2, valuesMasked: 1 },
  })
  return { request, bundle, manifest, internalReceipt, publicReceipt }
}
