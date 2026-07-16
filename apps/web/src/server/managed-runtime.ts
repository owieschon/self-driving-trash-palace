import type { HttpApiRuntime } from './api-runtime.js'

export interface DatabaseLifecyclePort {
  query(text: string): Promise<unknown>
  end(): Promise<void>
}

export interface ManagedHttpApiRuntime extends HttpApiRuntime {
  readonly isReady: () => Promise<boolean>
  readonly close: () => Promise<void>
}

/** Adds bounded database readiness and an idempotent close boundary to route handlers. */
export function createManagedHttpApiRuntime(
  routes: HttpApiRuntime,
  database: DatabaseLifecyclePort,
): ManagedHttpApiRuntime {
  let closePromise: Promise<void> | undefined
  const lifecycle = { closing: false }

  return {
    ...routes,
    async isReady(): Promise<boolean> {
      if (lifecycle.closing) return false
      try {
        await database.query('select 1')
        return !lifecycle.closing
      } catch {
        return false
      }
    },
    close(): Promise<void> {
      lifecycle.closing = true
      closePromise ??= database.end()
      return closePromise
    },
  }
}
