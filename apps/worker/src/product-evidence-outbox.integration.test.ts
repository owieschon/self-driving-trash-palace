import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProductEvidenceProjector,
  type SystemProductEvidenceDeliveryPort,
} from '@trash-palace/application'
import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  UserIdSchema,
} from '@trash-palace/core'
import {
  DatabaseConflictError,
  PgBootstrapRepository,
  createDatabase,
  createDatabasePool,
  createSystemProductEvidenceDeliveryRepository,
  createUnitOfWork,
} from '@trash-palace/db'
import {
  AnalyticsAliaser,
  LocalJsonlEvidenceSink,
  SafeApplicationEvidenceAdapter,
  parseSafeEvidenceEvent,
} from '@trash-palace/observability'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip
const organizationId = OrganizationIdSchema.parse('org_productevidence')
const occurredAt = '2026-07-15T04:00:00.000Z'

function runtimeInput(sourceSurface: 'api' | 'fixture' = 'api') {
  return {
    event: 'mission created' as const,
    logicalEventId: EventIdSchema.parse('evt_application_0123456789abcdef0123456789abcdef'),
    occurredAt,
    correlation: {
      distinctId: UserIdSchema.parse('usr_productevidence'),
      actorId: UserIdSchema.parse('usr_productevidence'),
      organizationId,
      palaceId: PalaceIdSchema.parse('pal_productevidence'),
      missionId: MissionIdSchema.parse('mis_productevidence'),
    },
    properties: {
      source_surface: sourceSurface,
      objective_class: 'homecoming_routine' as const,
    },
  }
}

function adapter(key: string, appVersion: string, sink?: LocalJsonlEvidenceSink) {
  return new SafeApplicationEvidenceAdapter({
    ...(sink === undefined ? {} : { sink }),
    aliaser: new AnalyticsAliaser(key),
    environment: 'test',
    dataOrigin: 'fixture',
    appVersion,
  })
}

databaseDescribe('transactional product evidence outbox', () => {
  let pool: ReturnType<typeof createDatabasePool>
  let database: ReturnType<typeof createDatabase>
  let schemaName: string
  let directory: string

  beforeAll(async () => {
    schemaName = `trash_product_evidence_${process.pid}_${Date.now()}`
    pool = createDatabasePool({
      connectionString: process.env.TEST_DATABASE_URL!,
      max: 4,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await applyMigrations(pool, schemaName)
    database = createDatabase(pool)
    await new PgBootstrapRepository(database).insertOrganization({
      id: organizationId,
      slug: 'product-evidence',
      name: 'Product evidence',
      labTenant: true,
      createdAt: occurredAt,
    })
    directory = await mkdtemp(join(tmpdir(), 'trash-palace-product-evidence-'))
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  }, 30_000)

  it('rolls back, replays frozen bytes across config drift, and recovers a sink-to-ack crash', async () => {
    const unitOfWork = createUnitOfWork(database)
    const originalAdapter = adapter('original-product-evidence-key-is-at-least-32-bytes', '1.2.3')
    const frozen = originalAdapter.freezeProduct(runtimeInput())

    await expect(
      unitOfWork.run(organizationId, async (repositories) => {
        await repositories.productEvidence.enqueue({
          missionId: runtimeInput().correlation.missionId,
          envelope: frozen,
        })
        throw new Error('roll back durable fact')
      }),
    ).rejects.toThrow('roll back durable fact')
    const system = createSystemProductEvidenceDeliveryRepository(database)
    await expect(system.listPending(100)).resolves.toHaveLength(0)

    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.productEvidence.enqueue({
          missionId: runtimeInput().correlation.missionId,
          envelope: frozen,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'enqueued' })

    const restartedAdapter = adapter('rotated-product-evidence-key-is-at-least-32-bytes', '9.9.9')
    const rerendered = restartedAdapter.freezeProduct(runtimeInput())
    expect(rerendered.semanticHash).toBe(frozen.semanticHash)
    expect(rerendered.eventHash).not.toBe(frozen.eventHash)
    const replay = await unitOfWork.run(organizationId, (repositories) =>
      repositories.productEvidence.enqueue({
        missionId: runtimeInput().correlation.missionId,
        envelope: rerendered,
      }),
    )
    expect(replay.kind).toBe('replayed')
    expect(replay.envelope.eventSerialized).toBe(frozen.eventSerialized)

    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.productEvidence.enqueue({
          missionId: runtimeInput().correlation.missionId,
          envelope: originalAdapter.freezeProduct(runtimeInput('fixture')),
        }),
      ),
    ).rejects.toBeInstanceOf(DatabaseConflictError)

    const filePath = join(directory, 'evidence.jsonl')
    const sink = new LocalJsonlEvidenceSink(filePath, { exclusiveWriter: true })
    let failAcknowledgement = true
    const crashAfterCapture: SystemProductEvidenceDeliveryPort = {
      listPending: (limit) => system.listPending(limit),
      acknowledge: async (input) => {
        if (failAcknowledgement) {
          failAcknowledgement = false
          throw new Error('simulated worker crash before acknowledgement')
        }
        return system.acknowledge(input)
      },
    }
    const firstProjector = new ProductEvidenceProjector(
      crashAfterCapture,
      adapter('worker-product-evidence-key-is-at-least-32-bytes', '7.7.7', sink),
    )
    await expect(firstProjector.deliverPending(100)).rejects.toThrow(
      'simulated worker crash before acknowledgement',
    )
    await expect(system.listPending(100)).resolves.toHaveLength(1)

    const restartedProjector = new ProductEvidenceProjector(
      createSystemProductEvidenceDeliveryRepository(database),
      adapter('another-worker-product-evidence-key-is-at-least-32-bytes', '8.8.8', sink),
    )
    await expect(restartedProjector.deliverPending(100)).resolves.toBe(1)
    await expect(system.listPending(100)).resolves.toHaveLength(0)
    await expect(restartedProjector.deliverPending(100)).resolves.toBe(0)

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(parseSafeEvidenceEvent(JSON.parse(lines[0]!))).toEqual(frozen.event)
  })
})

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new TypeError('Unsafe SQL identifier')
  return `"${value}"`
}

async function applyMigrations(
  pool: ReturnType<typeof createDatabasePool>,
  schema: string,
): Promise<void> {
  const migrationDirectory = new URL('../../../packages/db/migrations/', import.meta.url)
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
  for (const filename of filenames) {
    const migration = (await readFile(new URL(filename, migrationDirectory), 'utf8')).replaceAll(
      '"public".',
      `${quotedIdentifier(schema)}.`,
    )
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await pool.query(statement)
    }
  }
}
