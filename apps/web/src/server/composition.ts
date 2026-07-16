import 'server-only'

import { createLazyRuntime } from './lazy-runtime.js'
import type { ManagedHttpApiRuntime } from './managed-runtime.js'

const productionRuntime = createLazyRuntime<ManagedHttpApiRuntime>(async () => {
  const { createProductionHttpApiRuntime } = await import('./production-runtime.js')
  return createProductionHttpApiRuntime(process.env)
})
let shutdownHooksInstalled = false

export function getHttpApiRuntime(): Promise<ManagedHttpApiRuntime> {
  installShutdownHooks()
  return productionRuntime.get()
}

export async function shutdownHttpApiRuntime(): Promise<void> {
  const current = productionRuntime.current()
  if (current === undefined) return
  await (await current).close()
}

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return
  shutdownHooksInstalled = true
  const shutdown = (): void => {
    void shutdownHttpApiRuntime().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
