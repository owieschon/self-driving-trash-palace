import { lstat, realpath } from 'node:fs/promises'
import { devNull } from 'node:os'
import { delimiter, join, posix, resolve, sep, win32 } from 'node:path'

const excludedComponents = new Set(['.next', 'coverage', 'dist', 'node_modules'])
const excludedPrefixes = ['.beads/', '.dolt/', 'artifacts/', 'generated/'] as const
export function isPublicReproducibilitySourcePath(path: string): boolean {
  const components = path.split('/')
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    components.some((component) => component === '' || component === '.' || component === '..') ||
    components.some((component) => component.startsWith('.env')) ||
    components.some((component) => excludedComponents.has(component)) ||
    excludedPrefixes.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))
  ) {
    return false
  }
  return true
}

export interface PublicReproducibilityEnvironmentInput {
  readonly sourceDateEpoch: string
  readonly locale: string
  readonly timezone: string
  readonly home: string
  readonly temporaryDirectory: string
  readonly xdgCacheHome: string
  readonly xdgConfigHome: string
  readonly xdgDataHome: string
  readonly corepackHome: string
  readonly npmCache: string
  readonly pnpmStore: string
}

export function publicReproducibilityEnvironment(
  host: Readonly<Record<string, string | undefined>>,
  input: PublicReproducibilityEnvironmentInput,
): NodeJS.ProcessEnv {
  if (host.PATH === undefined) throw new Error('PATH is required for reproducibility commands')
  return {
    CI: 'true',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_HOME: input.corepackHome,
    HOME: input.home,
    LANG: input.locale,
    LC_ALL: input.locale,
    NPM_CONFIG_CACHE: input.npmCache,
    NPM_CONFIG_GLOBALCONFIG: devNull,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_USERCONFIG: devNull,
    PATH: host.PATH,
    PNPM_STORE_DIR: input.pnpmStore,
    SOURCE_DATE_EPOCH: input.sourceDateEpoch,
    TEMP: input.temporaryDirectory,
    TMP: input.temporaryDirectory,
    TMPDIR: input.temporaryDirectory,
    TZ: input.timezone,
    XDG_CACHE_HOME: input.xdgCacheHome,
    XDG_CONFIG_HOME: input.xdgConfigHome,
    XDG_DATA_HOME: input.xdgDataHome,
  }
}

export function gitInspectionEnvironment(
  host: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  if (host.PATH === undefined) throw new Error('PATH is required for Git inspection commands')
  return {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: host.PATH,
    ...(host.SystemRoot === undefined ? {} : { SystemRoot: host.SystemRoot }),
  }
}

export function findHostPathLeak(
  content: string,
  hostPrefixes: readonly string[],
): string | undefined {
  for (const prefix of hostPrefixes) {
    const absolute = posix.isAbsolute(prefix) || win32.isAbsolute(prefix)
    const pathRoot = posix.isAbsolute(prefix) ? posix.parse(prefix).root : win32.parse(prefix).root
    if (!absolute || prefix === pathRoot) continue
    const normalized = new Set([prefix, prefix.replaceAll('\\', '/'), prefix.replaceAll('/', '\\')])
    const representations = new Set<string>()
    for (const value of normalized) {
      representations.add(value)
      representations.add(JSON.stringify(value).slice(1, -1))
      representations.add(value.replaceAll('/', '\\/'))
    }
    const caseFold = win32.isAbsolute(prefix)
    const haystack = caseFold ? content.toLowerCase() : content
    for (const representation of representations) {
      const candidate = caseFold ? representation.toLowerCase() : representation
      let offset = 0
      while (offset <= haystack.length - candidate.length) {
        const index = haystack.indexOf(candidate, offset)
        if (index < 0) break
        const before = index === 0 ? undefined : haystack[index - 1]
        const after = haystack[index + candidate.length]
        const startsAtBoundary = before === undefined || !/[0-9A-Za-z_.-]/.test(before)
        const endsAtBoundary = after === undefined || /[\\/"'\s,:;()[\]{}?#]/.test(after)
        if (startsAtBoundary && endsAtBoundary) return prefix
        offset = index + 1
      }
    }
  }
  return undefined
}

export function findHostPathLeakInJson(
  value: unknown,
  hostPrefixes: readonly string[],
): string | undefined {
  if (typeof value === 'string') return findHostPathLeak(value, hostPrefixes)
  if (Array.isArray(value)) {
    for (const entry of value) {
      const leaked = findHostPathLeakInJson(entry, hostPrefixes)
      if (leaked !== undefined) return leaked
    }
    return undefined
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const leaked =
        findHostPathLeak(key, hostPrefixes) ?? findHostPathLeakInJson(entry, hostPrefixes)
      if (leaked !== undefined) return leaked
    }
  }
  return undefined
}

export function publicReproducibilityHostPrefixes(input: {
  readonly repositoryRoot: string
  readonly home: string
  readonly executable: string
  readonly path: string | undefined
  readonly packageManagerRoots: readonly string[]
  readonly runtimeRoots: readonly string[]
}): string[] {
  return [
    ...new Set(
      [
        input.repositoryRoot,
        input.home,
        input.executable,
        ...(input.path?.split(delimiter) ?? []),
        ...input.packageManagerRoots,
        ...input.runtimeRoots,
      ].filter((value) => value.length > 0),
    ),
  ]
}

export async function assertRegularSourcePath(
  repositoryRoot: string,
  path: string,
): Promise<string> {
  if (!isPublicReproducibilitySourcePath(path)) {
    throw new Error(`Clean-copy source path is outside the public source boundary: ${path}`)
  }
  if ((await lstat(repositoryRoot)).isSymbolicLink()) {
    throw new Error('Clean-copy repository root cannot be a symlink')
  }
  const canonicalRoot = await realpath(repositoryRoot)
  let current = canonicalRoot
  const components = path.split('/')
  for (const [index, component] of components.entries()) {
    current = join(current, component)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Clean-copy source path cannot use symlinks: ${path}`)
    }
    const final = index === components.length - 1
    if ((final && !metadata.isFile()) || (!final && !metadata.isDirectory())) {
      throw new Error(
        `Clean-copy source must resolve through directories to a regular file: ${path}`,
      )
    }
  }
  const canonicalSource = await realpath(current)
  if (
    !canonicalSource.startsWith(`${canonicalRoot}${sep}`) ||
    resolve(current) !== canonicalSource
  ) {
    throw new Error(`Clean-copy source path escapes the repository: ${path}`)
  }
  return canonicalSource
}
