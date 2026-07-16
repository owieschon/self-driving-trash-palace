import type { OutboxMessage } from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { SYSTEM_CLOCK, addMilliseconds, iso } from './primitives.js'
import type { ClockPort, QueuePort, SystemOutboxPort, UnitOfWorkPort } from './ports.js'

export interface OutboxDispatchItemResult {
  readonly messageId: string
  readonly status: 'dispatched' | 'released' | 'stale_claim'
  readonly errorCode?: string
}

export class OutboxDispatcher {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly systemOutbox: SystemOutboxPort,
    private readonly queue: QueuePort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
  ) {}

  public async dispatchBatch(input: {
    readonly ownerId: string
    readonly limit?: number
    readonly claimTtlMilliseconds?: number
  }): Promise<readonly OutboxDispatchItemResult[]> {
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Outbox batch limit must be between 1 and 100')
    }
    const claimTtl = input.claimTtlMilliseconds ?? 30_000
    const now = this.clock.now()
    const messages = await this.systemOutbox.claimDue({
      ownerId: input.ownerId,
      now: iso(now),
      claimExpiresAt: iso(addMilliseconds(now, claimTtl)),
      limit,
    })
    const results: OutboxDispatchItemResult[] = []
    for (const message of messages) {
      results.push(await this.#dispatchOne(input.ownerId, message))
    }
    return results
  }

  async #dispatchOne(ownerId: string, message: OutboxMessage): Promise<OutboxDispatchItemResult> {
    return this.observability.trace(
      {
        name: 'outbox.dispatch',
        kind: 'worker',
        correlation: { organizationId: message.organizationId },
        attributes: { topic: message.topic, delivery_attempt: message.deliveryAttempts },
      },
      async () => {
        try {
          // claimDue is the sole scheduler. Passing the historical application timestamp into a
          // second wall-clock scheduler can defer already-due work when the clocks differ.
          await this.queue.publish(message.topic, message.payload, {
            deduplicationKey: message.deduplicationKey,
          })
          const marked = await this.unitOfWork.run(message.organizationId, (repositories) =>
            repositories.outbox.markDispatched(message.id, ownerId, iso(this.clock.now())),
          )
          return { messageId: message.id, status: marked ? 'dispatched' : 'stale_claim' }
        } catch (error) {
          const errorCode = normalizeErrorCode(error)
          const backoffMilliseconds = Math.min(60_000, 1_000 * 2 ** message.deliveryAttempts)
          const released = await this.unitOfWork.run(message.organizationId, (repositories) =>
            repositories.outbox.release(
              message.id,
              ownerId,
              iso(addMilliseconds(this.clock.now(), backoffMilliseconds)),
              errorCode,
            ),
          )
          return {
            messageId: message.id,
            status: released ? 'released' : 'stale_claim',
            errorCode,
          }
        }
      },
    )
  }
}

function normalizeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String(error.code)
      .toUpperCase()
      .replaceAll(/[^A-Z0-9_]/g, '_')
    if (/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return code
  }
  return 'QUEUE_DELIVERY_FAILED'
}
