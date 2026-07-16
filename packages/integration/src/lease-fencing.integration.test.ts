import { readFile, readdir } from 'node:fs/promises'

import {
  MembershipIdSchema,
  MissionIdSchema,
  MissionSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  UserIdSchema,
  type Mission,
  type MissionId,
} from '@trash-palace/core'
import {
  OpaqueMissionFenceToken,
  type MissionExecutionUnitOfWorkPort,
  type MissionFence,
  type UnitOfWorkPort,
} from '@trash-palace/application'
import {
  PgBootstrapRepository,
  createDatabase,
  createMissionExecutionUnitOfWork,
  createUnitOfWork,
  type Database,
} from '@trash-palace/db'
import { missionLeases, outboxMessages } from '@trash-palace/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const organizationId = OrganizationIdSchema.parse('org_leasefencing')
const userId = UserIdSchema.parse('usr_leasefencing')
const palaceId = PalaceIdSchema.parse('pal_leasefencing')
const createdAt = '2026-07-15T04:00:00.000Z'
const missionIds = {
  aba: MissionIdSchema.parse('mis_leaseaba001'),
  expiry: MissionIdSchema.parse('mis_leaseexpiry1'),
  takeover: MissionIdSchema.parse('mis_leasetakeover'),
  renewal: MissionIdSchema.parse('mis_leaserenewal'),
  ordering: MissionIdSchema.parse('mis_leaseordering'),
  rollback: MissionIdSchema.parse('mis_leaserollback'),
  scopeA: MissionIdSchema.parse('mis_leasescopea01'),
  scopeB: MissionIdSchema.parse('mis_leasescopeb01'),
  privacy: MissionIdSchema.parse('mis_leaseprivacy1'),
} as const

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve() {
      resolvePromise?.()
    },
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function mission(id: MissionId): Mission {
  return MissionSchema.parse({
    id,
    organizationId,
    palaceId,
    initiatedBy: userId,
    objective: `Exercise lease fencing for ${id}`,
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: ['single_writer'],
    state: { status: 'queued', phase: 'understand' },
    version: 0,
    runId: null,
    contextReceiptId: null,
    taskLedger: [],
    createdAt,
    updatedAt: createdAt,
  })
}

function token(entropy: string): OpaqueMissionFenceToken {
  return OpaqueMissionFenceToken.fromEntropy(`lease-token-${entropy}-1234567890`)
}

databaseDescribe('PostgreSQL mission lease fencing', () => {
  let pool: pg.Pool
  let database: Database
  let unitOfWork: UnitOfWorkPort
  let fencedUnitOfWork: MissionExecutionUnitOfWorkPort
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_palace_lease_fencing_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 10,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    const migrationDirectory = new URL('../../db/migrations/', import.meta.url)
    const filenames = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort()
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
    unitOfWork = createUnitOfWork(database)
    fencedUnitOfWork = createMissionExecutionUnitOfWork(database)
    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertOrganization({
      id: organizationId,
      slug: 'lease-fencing',
      name: 'Lease Fencing',
      labTenant: true,
      createdAt,
    })
    await bootstrap.insertUser({ id: userId, displayName: 'Rocky', createdAt })
    await createUnitOfWork(database).run(organizationId, async (repositories) => {
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_leasefencing'),
        organizationId,
        userId,
        role: 'owner',
        grants: [],
        createdAt,
        revokedAt: null,
      })
      await repositories.records.insertPalace({
        id: palaceId,
        organizationId,
        name: 'Lease Test Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 80,
        createdAt,
      })
      for (const id of Object.values(missionIds)) await repositories.missions.insert(mission(id))
    })
    await insertForeignOperation(pool)
  }, 30_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  async function acquire(input: {
    readonly missionId: MissionId
    readonly ownerId: string
    readonly token: OpaqueMissionFenceToken
    readonly ttlMilliseconds?: number
  }): Promise<MissionFence | null> {
    return unitOfWork.run(organizationId, (repositories) =>
      repositories.missionLeases.acquire({
        organizationId,
        missionId: input.missionId,
        ownerId: input.ownerId,
        token: input.token,
        ttlMilliseconds: input.ttlMilliseconds ?? 60_000,
      }),
    )
  }

  async function expire(missionId: MissionId): Promise<void> {
    await database
      .update(missionLeases)
      .set({
        renewedAt: sql`clock_timestamp() - interval '1 second'`,
        expiresAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(missionLeases.organizationId, organizationId),
          eq(missionLeases.missionId, missionId),
        ),
      )
  }

  it('increments the epoch across deterministic-token ABA and rejects every stale operation', async () => {
    const firstToken = token('deterministic-aba')
    const first = await acquire({
      missionId: missionIds.aba,
      ownerId: 'worker_same',
      token: firstToken,
    })
    expect(first?.epoch).toBe(1)
    await expect(
      unitOfWork.run(organizationId, (repositories) => repositories.missionLeases.release(first!)),
    ).resolves.toBe(true)

    const second = await acquire({
      missionId: missionIds.aba,
      ownerId: 'worker_same',
      token: token('deterministic-aba'),
    })
    expect(second?.epoch).toBe(2)
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.missionLeases.renew(first!, 60_000),
      ),
    ).resolves.toBeNull()
    await expect(
      unitOfWork.run(organizationId, (repositories) => repositories.missionLeases.release(first!)),
    ).resolves.toBe(false)
    let staleCallbackRan = false
    await expect(
      fencedUnitOfWork.runFenced(first!, async () => {
        staleCallbackRan = true
      }),
    ).rejects.toThrow(/active lease fence/)
    expect(staleCallbackRan).toBe(false)

    await expect(
      unitOfWork.run(organizationId, (repositories) => repositories.missionLeases.release(second!)),
    ).resolves.toBe(true)
    const [retained] = await database
      .select()
      .from(missionLeases)
      .where(
        and(
          eq(missionLeases.organizationId, organizationId),
          eq(missionLeases.missionId, missionIds.aba),
        ),
      )
    expect(retained).toMatchObject({ epoch: 2, ownerId: 'worker_same' })
    expect(retained?.releasedAt).not.toBeNull()
    expect(retained?.tokenFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('treats exact database expiry as stale for renew, release, and fenced work', async () => {
    const fence = await acquire({
      missionId: missionIds.expiry,
      ownerId: 'worker_expiry',
      token: token('expiry'),
    })
    await expire(missionIds.expiry)
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.missionLeases.renew(fence!, 60_000),
      ),
    ).resolves.toBeNull()
    await expect(
      unitOfWork.run(organizationId, (repositories) => repositories.missionLeases.release(fence!)),
    ).resolves.toBe(false)
    await expect(fencedUnitOfWork.runFenced(fence!, async () => undefined)).rejects.toThrow(
      /active lease fence/,
    )
  })

  it('admits exactly one concurrent takeover of an expired row', async () => {
    await acquire({
      missionId: missionIds.takeover,
      ownerId: 'worker_original',
      token: token('takeover-original'),
    })
    await expire(missionIds.takeover)
    const contenders = await Promise.allSettled([
      acquire({
        missionId: missionIds.takeover,
        ownerId: 'worker_contender_a',
        token: token('takeover-a'),
      }),
      acquire({
        missionId: missionIds.takeover,
        ownerId: 'worker_contender_b',
        token: token('takeover-b'),
      }),
    ])
    const winners = contenders.filter(
      (result): result is PromiseFulfilledResult<MissionFence> =>
        result.status === 'fulfilled' && result.value !== null,
    )
    expect(winners).toHaveLength(1)
    const [row] = await database
      .select({ epoch: missionLeases.epoch, ownerId: missionLeases.ownerId })
      .from(missionLeases)
      .where(
        and(
          eq(missionLeases.organizationId, organizationId),
          eq(missionLeases.missionId, missionIds.takeover),
        ),
      )
    expect(row?.epoch).toBe(2)
    expect(row?.ownerId).toBe(winners[0]!.value.ownerId)
  })

  it('uses post-lock database time so a blocked renewal cannot resurrect an expired lease', async () => {
    const fence = await acquire({
      missionId: missionIds.renewal,
      ownerId: 'worker_renewal',
      token: token('renewal'),
      ttlMilliseconds: 1_000,
    })
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT epoch FROM mission_leases WHERE organization_id = $1 AND mission_id = $2 FOR UPDATE',
        [organizationId, missionIds.renewal],
      )
      let settled = false
      const renewal = unitOfWork
        .run(organizationId, (repositories) => repositories.missionLeases.renew(fence!, 60_000))
        .finally(() => {
          settled = true
        })
      await wait(1_100)
      expect(settled).toBe(false)
      await blocker.query('COMMIT')
      await expect(renewal).resolves.toBeNull()
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }
  })

  it('orders a live fenced commit before takeover and rejects the old epoch afterward', async () => {
    const oldFence = await acquire({
      missionId: missionIds.ordering,
      ownerId: 'worker_ordering_old',
      token: token('ordering-old'),
      ttlMilliseconds: 1_000,
    })
    const entered = deferred()
    const finish = deferred()
    const oldWork = fencedUnitOfWork.runFenced(oldFence!, async (repositories) => {
      entered.resolve()
      await finish.promise
      const current = await repositories.missions.get(missionIds.ordering)
      if (!current) throw new Error('Ordering mission disappeared')
      const saved = await repositories.missions.save(
        MissionSchema.parse({
          ...current,
          version: current.version + 1,
          updatedAt: '2026-07-15T04:01:00.000Z',
        }),
        current.version,
      )
      expect(saved).toBe(true)
    })
    await entered.promise
    await wait(1_100)
    let takeoverSettled = false
    const takeover = acquire({
      missionId: missionIds.ordering,
      ownerId: 'worker_ordering_new',
      token: token('ordering-new'),
    }).finally(() => {
      takeoverSettled = true
    })
    await wait(50)
    expect(takeoverSettled).toBe(false)
    finish.resolve()
    await oldWork
    const newFence = await takeover
    expect(newFence?.epoch).toBe(2)

    let staleCallbackRan = false
    await expect(
      fencedUnitOfWork.runFenced(oldFence!, async () => {
        staleCallbackRan = true
      }),
    ).rejects.toThrow(/active lease fence/)
    expect(staleCallbackRan).toBe(false)
    const persisted = await unitOfWork.run(organizationId, (repositories) =>
      repositories.missions.get(missionIds.ordering),
    )
    expect(persisted?.version).toBe(1)
  })

  it('rolls back callback failures and rejects forged, cloned, cross-mission, and lease mutations', async () => {
    const rollbackFence = await acquire({
      missionId: missionIds.rollback,
      ownerId: 'worker_rollback',
      token: token('rollback'),
    })
    await expect(
      fencedUnitOfWork.runFenced(rollbackFence!, async (repositories) => {
        const current = await repositories.missions.get(missionIds.rollback)
        if (!current) throw new Error('Rollback mission disappeared')
        await repositories.missions.save(
          MissionSchema.parse({
            ...current,
            version: 1,
            updatedAt: '2026-07-15T04:02:00.000Z',
          }),
          0,
        )
        throw new Error('rollback sentinel')
      }),
    ).rejects.toThrow('rollback sentinel')
    const rolledBack = await unitOfWork.run(organizationId, (repositories) =>
      repositories.missions.get(missionIds.rollback),
    )
    expect(rolledBack?.version).toBe(0)

    const cloned = structuredClone(rollbackFence!)
    const forged = {
      ...rollbackFence,
      token: { storageFingerprint: () => rollbackFence!.token.storageFingerprint() },
    } as unknown as MissionFence
    for (const rejectedFence of [cloned, forged]) {
      let callbackRan = false
      await expect(
        fencedUnitOfWork.runFenced(rejectedFence, async () => {
          callbackRan = true
        }),
      ).rejects.toThrow(/active lease fence/)
      expect(callbackRan).toBe(false)
    }

    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.missionLeases.acquire({
          organizationId,
          missionId: missionIds.scopeA,
          ownerId: 'worker_forged',
          token: {
            storageFingerprint: () => rollbackFence!.token.storageFingerprint(),
          } as unknown as OpaqueMissionFenceToken,
          ttlMilliseconds: 60_000,
        }),
      ),
    ).rejects.toThrow(/active lease fence/)

    const scopeFence = await acquire({
      missionId: missionIds.scopeA,
      ownerId: 'worker_scope',
      token: token('scope'),
    })
    await expect(
      fencedUnitOfWork.runFenced(scopeFence!, async (repositories) => {
        const foreign = await repositories.missions.get(missionIds.scopeB)
        if (!foreign) throw new Error('Foreign mission disappeared')
        await repositories.missions.save(
          MissionSchema.parse({
            ...foreign,
            version: 1,
            updatedAt: '2026-07-15T04:03:00.000Z',
          }),
          0,
        )
      }),
    ).rejects.toThrow(/another mission/)
    await expect(
      fencedUnitOfWork.runFenced(scopeFence!, (repositories) =>
        repositories.outbox.insert({
          id: 'out_mixedrefs01',
          organizationId,
          topic: 'operation.reconcile',
          deduplicationKey: 'mixed-references',
          payload: {
            organizationId,
            operationId: 'op_foreignmission',
            attemptId: 'att_foreignmission',
          },
          status: 'pending',
          availableAt: createdAt,
          createdAt,
          claimedBy: null,
          claimExpiresAt: null,
          dispatchedAt: null,
          deliveryAttempts: 0,
          lastErrorCode: null,
        }),
      ),
    ).rejects.toThrow(/another mission/)
    await expect(
      fencedUnitOfWork.runFenced(scopeFence!, (repositories) =>
        repositories.missionLeases.release(scopeFence!),
      ),
    ).rejects.toThrow(/without a mission binding/)
    const foreignAfter = await unitOfWork.run(organizationId, (repositories) =>
      repositories.missions.get(missionIds.scopeB),
    )
    expect(foreignAfter?.version).toBe(0)
    const mixedOutbox = await database
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(eq(outboxMessages.id, 'out_mixedrefs01'))
    expect(mixedOutbox).toHaveLength(0)
  })

  it('keeps opaque token material and lease fingerprints out of durable delivery payloads', async () => {
    const rawEntropy = 'lease-token-privacy-1234567890'
    const opaque = OpaqueMissionFenceToken.fromEntropy(rawEntropy)
    const fence = await acquire({
      missionId: missionIds.privacy,
      ownerId: 'worker_privacy',
      token: opaque,
    })
    await fencedUnitOfWork.runFenced(fence!, (repositories) =>
      repositories.outbox.insert({
        id: 'out_privacy0001',
        organizationId,
        topic: 'mission.resume',
        deduplicationKey: 'privacy-receipt',
        payload: { organizationId, missionId: missionIds.privacy },
        status: 'pending',
        availableAt: createdAt,
        createdAt,
        claimedBy: null,
        claimExpiresAt: null,
        dispatchedAt: null,
        deliveryAttempts: 0,
        lastErrorCode: null,
      }),
    )
    const durablePayloads = await pool.query<{ body: string }>(`
      SELECT COALESCE(jsonb_agg(payload), '[]'::jsonb)::text AS body
      FROM (
        SELECT payload FROM outbox_messages WHERE organization_id = '${organizationId}'
        UNION ALL
        SELECT sources AS payload FROM context_receipts WHERE organization_id = '${organizationId}'
        UNION ALL
        SELECT payload FROM audit_events WHERE organization_id = '${organizationId}'
      ) AS durable_payloads
    `)
    const serialized = durablePayloads.rows[0]?.body ?? ''
    expect(serialized).not.toContain(rawEntropy)
    expect(serialized).not.toContain(opaque.storageFingerprint())
    expect(serialized).not.toContain('tokenFingerprint')
  })

  async function insertForeignOperation(client: pg.Pool): Promise<void> {
    const constraints = JSON.stringify(mission(missionIds.scopeB).constraints)
    const action = JSON.stringify({ id: 'act_foreignmission', type: 'replace_homecoming_routine' })
    await client.query(
      `INSERT INTO plans
        (id, organization_id, mission_id, palace_id, revision, hash, status, objective,
         constraints, success_criteria_ids, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, 'candidate', $6, $7::jsonb, $8, $9)`,
      [
        'pln_foreignmission',
        organizationId,
        missionIds.scopeB,
        palaceId,
        '1'.repeat(64),
        'Foreign mission plan',
        constraints,
        ['single_writer'],
        createdAt,
      ],
    )
    await client.query(
      `INSERT INTO plan_actions
        (id, organization_id, plan_id, position, type, payload, created_at)
       VALUES ($1, $2, $3, 0, 'replace_homecoming_routine', $4::jsonb, $5)`,
      ['act_foreignmission', organizationId, 'pln_foreignmission', action, createdAt],
    )
    await client.query(
      `INSERT INTO approvals
        (id, organization_id, mission_id, plan_id, plan_hash, status, requested_by, nonce,
         expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)`,
      [
        'apr_foreignmission',
        organizationId,
        missionIds.scopeB,
        'pln_foreignmission',
        '1'.repeat(64),
        userId,
        'foreign-mission-approval-nonce',
        '2026-07-15T04:10:00.000Z',
        createdAt,
      ],
    )
    await client.query(
      `INSERT INTO approval_actions (organization_id, approval_id, plan_id, action_id)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, 'apr_foreignmission', 'pln_foreignmission', 'act_foreignmission'],
    )
    await client.query(
      `INSERT INTO operations
        (id, organization_id, mission_id, plan_id, plan_action_id, approval_id, payload_hash,
         server_created, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'pending', $8)`,
      [
        'op_foreignmission',
        organizationId,
        missionIds.scopeB,
        'pln_foreignmission',
        'act_foreignmission',
        'apr_foreignmission',
        '2'.repeat(64),
        createdAt,
      ],
    )
  }
})
