import { IsoDateTimeSchema } from '@trash-palace/core'
import { z } from 'zod'

const PositiveFiniteMillisecondsSchema = z.number().positive()
const NonNegativeFiniteMillisecondsSchema = z.number().nonnegative()

export const VirtualClockOptionsSchema = z
  .object({
    startsAt: IsoDateTimeSchema,
    virtualMinuteMilliseconds: PositiveFiniteMillisecondsSchema,
    maximumScheduledTasks: z.number().int().positive().max(1_000_000).default(10_000),
  })
  .strict()

export type VirtualClockOptions = z.input<typeof VirtualClockOptionsSchema>

export interface VirtualClockTaskContext {
  readonly taskId: string
  readonly label: string
  readonly scheduledAt: string
  readonly sequence: number
}

export interface VirtualClockTaskHandle {
  readonly id: string
  readonly scheduledAt: string
  cancel(): boolean
}

interface ScheduledTask {
  readonly id: string
  readonly label: string
  readonly atEpochMilliseconds: number
  readonly sequence: number
  readonly callback: (context: VirtualClockTaskContext) => void
  cancelled: boolean
}

export interface RunUntilIdleOptions {
  readonly maximumTasks?: number
  readonly maximumVirtualMilliseconds?: number
}

function parseInstant(input: Date | number | string, label: string): number {
  const value =
    input instanceof Date ? input.valueOf() : typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a valid instant`)
  return value
}

export class VirtualClock {
  readonly #startsAtEpochMilliseconds: number
  readonly #virtualMinuteMilliseconds: number
  readonly #maximumScheduledTasks: number
  readonly #queue: ScheduledTask[] = []
  #nowEpochMilliseconds: number
  #sequence = 0

  public constructor(input: VirtualClockOptions) {
    const options = VirtualClockOptionsSchema.parse(input)
    this.#startsAtEpochMilliseconds = Date.parse(options.startsAt)
    this.#nowEpochMilliseconds = this.#startsAtEpochMilliseconds
    this.#virtualMinuteMilliseconds = options.virtualMinuteMilliseconds
    this.#maximumScheduledTasks = options.maximumScheduledTasks
  }

  public get startsAt(): string {
    return new Date(this.#startsAtEpochMilliseconds).toISOString()
  }

  public get now(): string {
    return new Date(this.#nowEpochMilliseconds).toISOString()
  }

  public get nowEpochMilliseconds(): number {
    return this.#nowEpochMilliseconds
  }

  public get pendingTaskCount(): number {
    return this.#queue.reduce((count, task) => count + (task.cancelled ? 0 : 1), 0)
  }

  public realMillisecondsForVirtual(virtualMilliseconds: number): number {
    const duration = NonNegativeFiniteMillisecondsSchema.parse(virtualMilliseconds)
    return (duration / 60_000) * this.#virtualMinuteMilliseconds
  }

  public virtualMillisecondsForReal(realMilliseconds: number): number {
    const duration = NonNegativeFiniteMillisecondsSchema.parse(realMilliseconds)
    return (duration / this.#virtualMinuteMilliseconds) * 60_000
  }

  public scheduleAt(
    at: Date | number | string,
    callback: (context: VirtualClockTaskContext) => void,
    label = 'scheduled-task',
  ): VirtualClockTaskHandle {
    const atEpochMilliseconds = parseInstant(at, 'Scheduled time')
    if (atEpochMilliseconds < this.#nowEpochMilliseconds) {
      throw new RangeError('Virtual clock cannot schedule work in the past')
    }
    if (this.pendingTaskCount >= this.#maximumScheduledTasks) {
      throw new RangeError('Virtual clock scheduled-task bound exceeded')
    }
    if (label.length < 1 || label.length > 160) {
      throw new RangeError('Virtual clock task labels must contain 1 to 160 characters')
    }

    const sequence = this.#sequence++
    const task: ScheduledTask = {
      id: `vclock_${sequence.toString(36).padStart(8, '0')}`,
      label,
      atEpochMilliseconds,
      sequence,
      callback,
      cancelled: false,
    }
    this.#queue.push(task)
    this.#queue.sort(
      (left, right) =>
        left.atEpochMilliseconds - right.atEpochMilliseconds || left.sequence - right.sequence,
    )

    return Object.freeze({
      id: task.id,
      scheduledAt: new Date(task.atEpochMilliseconds).toISOString(),
      cancel: () => {
        if (task.cancelled || !this.#queue.includes(task)) return false
        task.cancelled = true
        return true
      },
    })
  }

  public scheduleAfter(
    virtualDelayMilliseconds: number,
    callback: (context: VirtualClockTaskContext) => void,
    label?: string,
  ): VirtualClockTaskHandle {
    const delay = NonNegativeFiniteMillisecondsSchema.parse(virtualDelayMilliseconds)
    return this.scheduleAt(this.#nowEpochMilliseconds + delay, callback, label)
  }

  public flushCurrent(): number {
    return this.advanceTo(this.#nowEpochMilliseconds)
  }

  public advanceBy(virtualMilliseconds: number): number {
    const duration = NonNegativeFiniteMillisecondsSchema.parse(virtualMilliseconds)
    return this.advanceTo(this.#nowEpochMilliseconds + duration)
  }

  public advanceTo(target: Date | number | string): number {
    const targetEpochMilliseconds = parseInstant(target, 'Advance target')
    return this.#advanceTo(targetEpochMilliseconds, this.#maximumScheduledTasks)
  }

  #advanceTo(targetEpochMilliseconds: number, maximumTasks: number): number {
    if (targetEpochMilliseconds < this.#nowEpochMilliseconds) {
      throw new RangeError('Virtual clock cannot move backwards')
    }

    let executed = 0
    while (this.#queue.length > 0) {
      while (this.#queue[0]?.cancelled) this.#queue.shift()
      const next = this.#queue[0]
      if (!next || next.atEpochMilliseconds > targetEpochMilliseconds) break
      if (executed >= maximumTasks) {
        throw new RangeError('Virtual clock advance exceeded its task bound')
      }
      this.#queue.shift()
      this.#nowEpochMilliseconds = next.atEpochMilliseconds
      next.callback({
        taskId: next.id,
        label: next.label,
        scheduledAt: new Date(next.atEpochMilliseconds).toISOString(),
        sequence: next.sequence,
      })
      executed += 1
    }
    this.#nowEpochMilliseconds = targetEpochMilliseconds
    return executed
  }

  public runUntilIdle(options: RunUntilIdleOptions = {}): number {
    const maximumTasks = options.maximumTasks ?? this.#maximumScheduledTasks
    const maximumVirtualMilliseconds = options.maximumVirtualMilliseconds ?? 24 * 60 * 60 * 1_000
    z.number().int().positive().parse(maximumTasks)
    NonNegativeFiniteMillisecondsSchema.parse(maximumVirtualMilliseconds)
    const deadline = this.#nowEpochMilliseconds + maximumVirtualMilliseconds
    let executed = 0

    while (this.pendingTaskCount > 0) {
      while (this.#queue[0]?.cancelled) this.#queue.shift()
      const next = this.#queue[0]
      if (!next) break
      if (next.atEpochMilliseconds > deadline) {
        throw new RangeError('Virtual clock run exceeded its virtual-time bound')
      }
      if (executed >= maximumTasks) {
        throw new RangeError('Virtual clock run exceeded its task bound')
      }
      executed += this.#advanceTo(next.atEpochMilliseconds, maximumTasks - executed)
    }
    return executed
  }
}
