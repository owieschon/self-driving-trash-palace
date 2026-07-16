export interface OutboxPumpPort {
  start(input: {
    readonly intervalMilliseconds: number
    readonly sweep: () => Promise<void>
  }): Promise<void>
  stop(): Promise<void>
}

/** Runs non-overlapping outbox sweeps and lets an in-flight sweep finish during shutdown. */
export class TimerOutboxPump implements OutboxPumpPort {
  #running = false
  #timer: NodeJS.Timeout | null = null
  #inFlight: Promise<void> | null = null
  #sweep: (() => Promise<void>) | null = null
  #intervalMilliseconds = 0

  public async start(input: {
    readonly intervalMilliseconds: number
    readonly sweep: () => Promise<void>
  }): Promise<void> {
    if (this.#running) throw new Error('Outbox pump is already running')
    if (!Number.isInteger(input.intervalMilliseconds) || input.intervalMilliseconds < 1) {
      throw new RangeError('Outbox pump interval must be a positive integer')
    }
    this.#running = true
    this.#sweep = input.sweep
    this.#intervalMilliseconds = input.intervalMilliseconds
    this.#schedule()
  }

  public async stop(): Promise<void> {
    this.#running = false
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const inFlight = this.#inFlight
    if (inFlight) await inFlight
    this.#sweep = null
  }

  #schedule(): void {
    if (!this.#running) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (!this.#running || !this.#sweep) return
      const inFlight = Promise.resolve()
        .then(() => this.#sweep?.())
        // The durable minute schedule remains the retry path; shutdown runs one surfaced sweep.
        .catch(() => undefined)
        .finally(() => {
          if (this.#inFlight === inFlight) this.#inFlight = null
          this.#schedule()
        })
      this.#inFlight = inFlight
    }, this.#intervalMilliseconds)
    this.#timer.unref()
  }
}
