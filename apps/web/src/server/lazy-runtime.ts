export interface LazyRuntime<Runtime> {
  get(): Promise<Runtime>
  current(): Promise<Runtime> | undefined
}

export function createLazyRuntime<Runtime>(factory: () => Promise<Runtime>): LazyRuntime<Runtime> {
  let runtime: Promise<Runtime> | undefined
  return {
    get() {
      runtime ??= factory().catch((error: unknown) => {
        runtime = undefined
        throw error
      })
      return runtime
    },
    current() {
      return runtime
    },
  }
}
