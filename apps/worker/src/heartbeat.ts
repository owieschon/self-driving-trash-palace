import { LeaseLostError } from '@trash-palace/application'

export interface HeartbeatPort {
  run<Result>(input: {
    readonly intervalMilliseconds: number
    readonly renewalTimeoutMilliseconds?: number
    readonly signal?: AbortSignal
    readonly heartbeat: (signal: AbortSignal) => Promise<boolean>
    readonly work: (signal: AbortSignal) => Promise<Result>
  }): Promise<Result>
}

export class TimerHeartbeat implements HeartbeatPort {
  public async run<Result>(input: {
    readonly intervalMilliseconds: number
    readonly renewalTimeoutMilliseconds?: number
    readonly signal?: AbortSignal
    readonly heartbeat: (signal: AbortSignal) => Promise<boolean>
    readonly work: (signal: AbortSignal) => Promise<Result>
  }): Promise<Result> {
    const interval = positiveInteger(input.intervalMilliseconds, 'Heartbeat interval')
    const renewalTimeout = positiveInteger(
      input.renewalTimeoutMilliseconds ?? interval,
      'Heartbeat renewal timeout',
    )
    if (input.signal?.aborted === true) throw abortReason(input.signal)
    const workAbort = new AbortController()
    let stopped = false
    let renewalInFlight: Promise<void> | null = null
    const pendingRenewal = (): Promise<void> | null => renewalInFlight
    let renewalAbort: AbortController | null = null
    let failure: { readonly error: unknown } | null = null
    let rejectFailure: (error: unknown) => void = () => undefined
    const failed = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject
    })

    let timer: NodeJS.Timeout | null = null
    const stopTimer = (): void => {
      stopped = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const fail = (error: unknown): void => {
      if (failure !== null) return
      failure = { error }
      stopTimer()
      renewalAbort?.abort(error)
      workAbort.abort(error)
      rejectFailure(error)
    }
    const loseLease = (cause?: unknown): void => {
      fail(cause instanceof LeaseLostError ? cause : new LeaseLostError(cause))
    }
    const renew = (): void => {
      if (stopped || renewalInFlight !== null) return
      const controller = new AbortController()
      renewalAbort = controller
      const renewal = this.#renew({
        heartbeat: input.heartbeat,
        controller,
        timeoutMilliseconds: renewalTimeout,
        loseLease,
      })
      renewalInFlight = renewal
      void renewal.finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null
        if (renewalAbort === controller) renewalAbort = null
      })
    }
    const abortFromParent = (): void => {
      fail(abortReason(input.signal))
    }

    input.signal?.addEventListener('abort', abortFromParent, { once: true })
    timer = setInterval(renew, interval)
    timer.unref()

    const work = Promise.resolve().then(() => input.work(workAbort.signal))
    void work.catch(() => undefined)
    let outcome:
      | { readonly status: 'fulfilled'; readonly value: Result }
      | { readonly status: 'rejected'; readonly reason: unknown }
    try {
      outcome = {
        status: 'fulfilled',
        value: await Promise.race([work, failed]),
      }
    } catch (error) {
      outcome = { status: 'rejected', reason: error }
    } finally {
      stopTimer()
      input.signal?.removeEventListener('abort', abortFromParent)
      const pending = pendingRenewal()
      if (pending !== null) await pending
    }
    const terminalFailure = failure as { readonly error: unknown } | null
    if (terminalFailure !== null) throw terminalFailure.error
    if (outcome.status === 'rejected') throw outcome.reason
    return outcome.value
  }

  async #renew(input: {
    readonly heartbeat: (signal: AbortSignal) => Promise<boolean>
    readonly controller: AbortController
    readonly timeoutMilliseconds: number
    readonly loseLease: (cause?: unknown) => void
  }): Promise<void> {
    const renewal = Promise.resolve().then(() => input.heartbeat(input.controller.signal))
    void renewal.catch(() => undefined)
    let cancelTimeout = (): void => undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error('Mission lease renewal timed out'))
      }, input.timeoutMilliseconds)
      deadline.unref()
      cancelTimeout = () => clearTimeout(deadline)
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      input.controller.signal.addEventListener(
        'abort',
        () => reject(abortReason(input.controller.signal)),
        { once: true },
      )
    })
    try {
      if (!(await Promise.race([renewal, timedOut, aborted]))) input.loseLease()
    } catch (error) {
      input.loseLease(error)
    } finally {
      cancelTimeout()
    }
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`)
  }
  return value
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new Error('Worker job was aborted')
}
