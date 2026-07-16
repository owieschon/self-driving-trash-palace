import {
  parseFrozenApplicationProductEvidenceEnvelope,
  type ProductEvidenceDelivery,
  type ProductEvidenceEnqueueResult,
  type ProductEvidenceRepository,
  type SystemProductEvidenceDeliveryPort,
} from '@trash-palace/application'
import {
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  Sha256Schema,
  type MissionId,
} from '@trash-palace/core'
import { and, asc, eq } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from './client.js'
import { DatabaseConflictError, DatabaseNotFoundError, translateDatabaseError } from './errors.js'
import { productEvidenceDeliveries } from './schema.js'

type DeliveryRow = typeof productEvidenceDeliveries.$inferSelect

function iso(value: Date): string {
  return value.toISOString()
}

function envelopeFromRow(row: DeliveryRow) {
  let event: unknown
  try {
    event = JSON.parse(row.eventSerialized)
  } catch (error) {
    throw new DatabaseConflictError('Frozen application evidence contains invalid JSON', {
      cause: error,
    })
  }
  return parseFrozenApplicationProductEvidenceEnvelope({
    schemaVersion: 'application-product-evidence@1',
    logicalEventId: row.logicalEventId,
    semanticHash: row.semanticHash,
    eventHash: row.eventHash,
    eventSerialized: row.eventSerialized,
    event,
  })
}

function deliveryFromRow(row: DeliveryRow): ProductEvidenceDelivery {
  return {
    organizationId: OrganizationIdSchema.parse(row.organizationId),
    envelope: envelopeFromRow(row),
    status: row.status,
    createdAt: iso(row.createdAt),
    deliveredAt: row.deliveredAt === null ? null : iso(row.deliveredAt),
    captureStatus: row.captureStatus,
  }
}

/** Tenant-scoped writer used only inside the durable product transaction. */
export class PgProductEvidenceRepository implements ProductEvidenceRepository {
  readonly #organizationId: ReturnType<typeof OrganizationIdSchema.parse>

  public constructor(
    private readonly executor: DatabaseTransaction,
    organizationId: string,
    private readonly fencedMissionId: MissionId | null = null,
  ) {
    this.#organizationId = OrganizationIdSchema.parse(organizationId)
  }

  public async enqueue(
    input: Parameters<ProductEvidenceRepository['enqueue']>[0],
  ): Promise<ProductEvidenceEnqueueResult> {
    const missionId = MissionIdSchema.parse(input.missionId)
    if (this.fencedMissionId !== null && missionId !== this.fencedMissionId) {
      throw new DatabaseConflictError(
        'Mission fence cannot enqueue product evidence for another mission',
      )
    }
    const envelope = parseFrozenApplicationProductEvidenceEnvelope(input.envelope)
    try {
      const inserted = await this.executor
        .insert(productEvidenceDeliveries)
        .values({
          organizationId: this.#organizationId,
          logicalEventId: envelope.logicalEventId,
          semanticHash: envelope.semanticHash,
          eventInsertId: envelope.event.insertId,
          eventHash: envelope.eventHash,
          eventSerialized: envelope.eventSerialized,
        })
        .onConflictDoNothing()
        .returning({ logicalEventId: productEvidenceDeliveries.logicalEventId })
      if (inserted.length === 1) return { kind: 'enqueued', envelope }

      const [existing] = await this.executor
        .select()
        .from(productEvidenceDeliveries)
        .where(
          and(
            eq(productEvidenceDeliveries.organizationId, this.#organizationId),
            eq(productEvidenceDeliveries.logicalEventId, envelope.logicalEventId),
          ),
        )
        .limit(1)
      if (existing === undefined) {
        throw new DatabaseConflictError(
          'Application evidence insert identity was reused by another logical event',
        )
      }
      if (existing.semanticHash !== envelope.semanticHash) {
        throw new DatabaseConflictError(
          'Application evidence logical identity was reused with different semantics',
        )
      }
      return { kind: 'replayed', envelope: envelopeFromRow(existing) }
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

/** System-scoped, worker-only reader and acknowledgement writer. */
export class PgSystemProductEvidenceDeliveryRepository implements SystemProductEvidenceDeliveryPort {
  public constructor(private readonly database: Database) {}

  public async listPending(limit: number): Promise<readonly ProductEvidenceDelivery[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('Product evidence delivery limit must be between 1 and 500')
    }
    try {
      const rows = await this.database
        .select()
        .from(productEvidenceDeliveries)
        .where(eq(productEvidenceDeliveries.status, 'pending'))
        .orderBy(
          asc(productEvidenceDeliveries.createdAt),
          asc(productEvidenceDeliveries.logicalEventId),
        )
        .limit(limit)
      return rows.map(deliveryFromRow)
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }

  public async acknowledge(input: {
    readonly logicalEventId: string
    readonly eventHash: string
    readonly captureStatus: 'duplicate' | 'stored'
    readonly deliveredAt: string
  }): Promise<'acknowledged' | 'already_acknowledged'> {
    const eventHash = Sha256Schema.parse(input.eventHash)
    const deliveredAt = new Date(IsoDateTimeSchema.parse(input.deliveredAt))
    try {
      return await this.database.transaction(async (transaction) => {
        const [current] = await transaction
          .select()
          .from(productEvidenceDeliveries)
          .where(eq(productEvidenceDeliveries.logicalEventId, input.logicalEventId))
          .for('update')
          .limit(1)
        if (current === undefined) throw new DatabaseNotFoundError('Product evidence delivery')
        if (current.eventHash !== eventHash) {
          throw new DatabaseConflictError(
            'Product evidence acknowledgement changed its immutable event hash',
          )
        }
        if (current.status === 'delivered') return 'already_acknowledged'
        const [updated] = await transaction
          .update(productEvidenceDeliveries)
          .set({ status: 'delivered', deliveredAt, captureStatus: input.captureStatus })
          .where(eq(productEvidenceDeliveries.logicalEventId, current.logicalEventId))
          .returning({ logicalEventId: productEvidenceDeliveries.logicalEventId })
        if (updated === undefined) {
          throw new DatabaseConflictError('Product evidence acknowledgement was not persisted')
        }
        return 'acknowledged'
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

export function createSystemProductEvidenceDeliveryRepository(
  database: Database,
): PgSystemProductEvidenceDeliveryRepository {
  return new PgSystemProductEvidenceDeliveryRepository(database)
}
