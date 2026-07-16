import {
  CaretakerTerminalEvidenceDeliverySchema,
  type CaretakerTerminalEvidenceDelivery,
  type SystemCaretakerEvidenceDeliveryPort,
} from '@trash-palace/application'
import { IsoDateTimeSchema, RunIdSchema, Sha256Schema } from '@trash-palace/core'
import { asc, eq } from 'drizzle-orm'

import type { Database } from './client.js'
import { DatabaseConflictError, DatabaseNotFoundError, translateDatabaseError } from './errors.js'
import { caretakerTerminalEvidenceDeliveries } from './schema.js'

type DeliveryRow = typeof caretakerTerminalEvidenceDeliveries.$inferSelect

function iso(value: Date): string {
  return value.toISOString()
}

function mapDelivery(row: DeliveryRow): CaretakerTerminalEvidenceDelivery {
  return CaretakerTerminalEvidenceDeliverySchema.parse({
    organizationId: row.organizationId,
    missionId: row.missionId,
    runId: row.runId,
    envelope: row.envelope,
    status: row.status,
    createdAt: iso(row.createdAt),
    deliveredAt: row.deliveredAt === null ? null : iso(row.deliveredAt),
    captureStatus: row.captureStatus,
  })
}

/** System-scoped delivery ledger. It never acquires or mutates a mission lease. */
export class PgCaretakerEvidenceDeliveryRepository implements SystemCaretakerEvidenceDeliveryPort {
  public constructor(private readonly database: Database) {}

  public async get(inputRunId: string): Promise<CaretakerTerminalEvidenceDelivery | null> {
    const runId = RunIdSchema.parse(inputRunId)
    try {
      const [row] = await this.database
        .select()
        .from(caretakerTerminalEvidenceDeliveries)
        .where(eq(caretakerTerminalEvidenceDeliveries.runId, runId))
        .limit(1)
      return row === undefined ? null : mapDelivery(row)
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }

  public async listPending(limit: number): Promise<readonly CaretakerTerminalEvidenceDelivery[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('Caretaker evidence delivery limit must be between 1 and 500')
    }
    try {
      const rows = await this.database
        .select()
        .from(caretakerTerminalEvidenceDeliveries)
        .where(eq(caretakerTerminalEvidenceDeliveries.status, 'pending'))
        .orderBy(
          asc(caretakerTerminalEvidenceDeliveries.createdAt),
          asc(caretakerTerminalEvidenceDeliveries.runId),
        )
        .limit(limit)
      return rows.map(mapDelivery)
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }

  public async acknowledge(input: {
    readonly runId: string
    readonly eventHash: string
    readonly captureStatus: 'stored' | 'duplicate'
    readonly deliveredAt: string
  }): Promise<'acknowledged' | 'already_acknowledged'> {
    const runId = RunIdSchema.parse(input.runId)
    const eventHash = Sha256Schema.parse(input.eventHash)
    const deliveredAt = new Date(IsoDateTimeSchema.parse(input.deliveredAt))
    try {
      return await this.database.transaction(async (transaction) => {
        const [current] = await transaction
          .select()
          .from(caretakerTerminalEvidenceDeliveries)
          .where(eq(caretakerTerminalEvidenceDeliveries.runId, runId))
          .for('update')
          .limit(1)
        if (current === undefined) throw new DatabaseNotFoundError('Caretaker evidence delivery')
        if (current.eventHash !== eventHash) {
          throw new DatabaseConflictError(
            'Caretaker evidence acknowledgement changed its immutable event hash',
          )
        }
        if (current.status === 'delivered') return 'already_acknowledged'
        const [updated] = await transaction
          .update(caretakerTerminalEvidenceDeliveries)
          .set({ status: 'delivered', deliveredAt, captureStatus: input.captureStatus })
          .where(eq(caretakerTerminalEvidenceDeliveries.runId, runId))
          .returning({ runId: caretakerTerminalEvidenceDeliveries.runId })
        if (updated === undefined) {
          throw new DatabaseConflictError('Caretaker evidence acknowledgement was not persisted')
        }
        return 'acknowledged'
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

export function createCaretakerEvidenceDeliveryRepository(
  database: Database,
): PgCaretakerEvidenceDeliveryRepository {
  return new PgCaretakerEvidenceDeliveryRepository(database)
}
