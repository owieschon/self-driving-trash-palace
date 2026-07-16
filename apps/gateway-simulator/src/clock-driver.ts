import type { VirtualClock } from '@trash-palace/testkit'

export interface VirtualClockDriverOptions {
  readonly realMillisecondsPerVirtualMinute: number
  /** Shared wall-clock instant at which accelerated fixture time begins. */
  readonly requiredRealStartAt?: string
  /** Virtual instant to jump to immediately before accelerated ticking begins. */
  readonly advanceToOnStart?: string
  readonly maximumShutdownTasks?: number
  readonly maximumShutdownVirtualMilliseconds?: number
  readonly onFailure?: (error: unknown) => void
}

export class VirtualClockDriver {
  readonly #clock: VirtualClock
  readonly #options: Required<
    Pick<
      VirtualClockDriverOptions,
      | 'maximumShutdownTasks'
      | 'maximumShutdownVirtualMilliseconds'
      | 'realMillisecondsPerVirtualMinute'
    >
  > &
    Pick<VirtualClockDriverOptions, 'advanceToOnStart' | 'onFailure' | 'requiredRealStartAt'>
  #timer: NodeJS.Timeout | undefined
  #startTimer: NodeJS.Timeout | undefined
  #startRequested = false
  #failure: unknown

  public constructor(clock: VirtualClock, options: VirtualClockDriverOptions) {
    if (
      !Number.isInteger(options.realMillisecondsPerVirtualMinute) ||
      options.realMillisecondsPerVirtualMinute < 1 ||
      options.realMillisecondsPerVirtualMinute > 60_000
    ) {
      throw new RangeError('Virtual clock real-minute interval must be 1 to 60000 milliseconds')
    }
    this.#clock = clock
    if (
      options.requiredRealStartAt !== undefined &&
      !Number.isFinite(Date.parse(options.requiredRealStartAt))
    ) {
      throw new TypeError('Virtual clock shared real start must be a valid instant')
    }
    if (
      options.advanceToOnStart !== undefined &&
      !Number.isFinite(Date.parse(options.advanceToOnStart))
    ) {
      throw new TypeError('Virtual clock activation time must be a valid instant')
    }
    this.#options = {
      realMillisecondsPerVirtualMinute: options.realMillisecondsPerVirtualMinute,
      maximumShutdownTasks: options.maximumShutdownTasks ?? 10_000,
      maximumShutdownVirtualMilliseconds:
        options.maximumShutdownVirtualMilliseconds ?? 24 * 60 * 60 * 1_000,
      ...(options.requiredRealStartAt === undefined
        ? {}
        : { requiredRealStartAt: options.requiredRealStartAt }),
      ...(options.advanceToOnStart === undefined
        ? {}
        : { advanceToOnStart: options.advanceToOnStart }),
      ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    }
  }

  public get isHealthy(): boolean {
    return (
      (this.#startTimer !== undefined || this.#timer !== undefined) && this.#failure === undefined
    )
  }

  public get failure(): unknown {
    return this.#failure
  }

  public get isWaitingForStart(): boolean {
    return this.#startTimer !== undefined && this.#failure === undefined
  }

  public start(): void {
    if (this.#startRequested) return
    if (this.#failure !== undefined) {
      throw new Error('A failed virtual clock driver cannot be restarted')
    }
    this.#startRequested = true
    const requiredRealStartAt = this.#options.requiredRealStartAt
    const delay =
      requiredRealStartAt === undefined
        ? 0
        : Math.max(0, Date.parse(requiredRealStartAt) - Date.now())
    if (delay === 0) {
      this.#beginAcceleratedTime()
      return
    }
    this.#startTimer = setTimeout(() => {
      this.#startTimer = undefined
      this.#beginAcceleratedTime()
    }, delay)
    this.#startTimer.unref()
  }

  public advanceOneVirtualMinute(): void {
    if (this.#failure !== undefined) return
    try {
      this.#clock.advanceBy(60_000)
    } catch (error) {
      this.#failure = error
      this.stop()
      this.#options.onFailure?.(error)
    }
  }

  public stop(): void {
    if (this.#startTimer !== undefined) clearTimeout(this.#startTimer)
    this.#startTimer = undefined
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  public flushAndStop(): number {
    this.stop()
    if (this.#failure !== undefined) {
      if (this.#failure instanceof Error) throw this.#failure
      throw new Error('Virtual clock driver failed with a non-error value', {
        cause: this.#failure,
      })
    }
    return this.#clock.runUntilIdle({
      maximumTasks: this.#options.maximumShutdownTasks,
      maximumVirtualMilliseconds: this.#options.maximumShutdownVirtualMilliseconds,
    })
  }

  #beginAcceleratedTime(): void {
    if (this.#failure !== undefined || this.#timer !== undefined) return
    try {
      if (this.#options.advanceToOnStart !== undefined) {
        const activationAt = Date.parse(this.#options.advanceToOnStart)
        const realStartAt = this.#options.requiredRealStartAt
        const elapsedRealMilliseconds =
          realStartAt === undefined ? 0 : Math.max(0, Date.now() - Date.parse(realStartAt))
        const elapsedVirtualMilliseconds =
          (elapsedRealMilliseconds / this.#options.realMillisecondsPerVirtualMinute) * 60_000
        this.#clock.advanceTo(Math.floor(activationAt + elapsedVirtualMilliseconds))
      }
      this.#timer = setInterval(
        () => this.advanceOneVirtualMinute(),
        this.#options.realMillisecondsPerVirtualMinute,
      )
      this.#timer.unref()
    } catch (error) {
      this.#failure = error
      this.stop()
      this.#options.onFailure?.(error)
    }
  }
}
