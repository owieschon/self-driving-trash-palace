import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

import {
  GENERATED_PUBLIC_REFERENCE_DIRECTORY,
  assertPublicGeneratedManifest,
} from '../packages/agent/src/reference-generator.js'
import {
  findHostPathLeak,
  findHostPathLeakInJson,
  gitInspectionEnvironment,
  publicReproducibilityHostPrefixes,
  publicReproducibilityEnvironment,
} from './reproducibility-boundary.js'
import {
  assertGitSnapshotIdentity,
  materializePublicGitIndex,
  readGitSnapshotIdentity,
  readPublicGitIndexEntries,
} from './git-index-source.js'

const repositoryRoot = process.cwd()
const gitEnvironment = gitInspectionEnvironment(process.env)
const requiredSourceFiles = [
  '.node-version',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/generate-references.ts',
] as const

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      env: environment,
      shell: false,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else {
        reject(
          new Error(
            `${command} ${arguments_.join(' ')} failed with ${signal === null ? `exit ${String(code)}` : `signal ${signal}`}`,
          ),
        )
      }
    })
  })
}

function capture(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    const child = spawn(command, [...arguments_], {
      cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks))
      else {
        reject(
          new Error(
            `${command} ${arguments_.join(' ')} failed with ${signal === null ? `exit ${String(code)}` : `signal ${signal}`}`,
          ),
        )
      }
    })
  })
}

async function assertCleanRepository(): Promise<void> {
  const status = await capture(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '-z'],
    repositoryRoot,
    gitEnvironment,
  )
  if (status.length > 0) {
    const changedPaths = status.toString('utf8').split('\0').filter(Boolean).length
    throw new Error(
      `Public reproducibility requires a clean tracked checkout; git reports ${String(changedPaths)} changed or untracked paths`,
    )
  }
}

async function sourceDateEpoch(commit: string): Promise<string> {
  const value =
    process.env.SOURCE_DATE_EPOCH ??
    (await capture('git', ['show', '-s', '--format=%ct', commit], repositoryRoot, gitEnvironment))
      .toString('utf8')
      .trim()
  if (!/^(?:0|[1-9][0-9]{0,11})$/.test(value)) {
    throw new Error('SOURCE_DATE_EPOCH must be an integer number of Unix seconds')
  }
  return value
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Public output cannot contain symlinks')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files.sort(compareText)
}

async function assertNoHostPaths(
  outputDirectories: readonly string[],
  hostPrefixes: readonly string[],
): Promise<void> {
  const prefixes = [...new Set(hostPrefixes)]
  for (const outputDirectory of outputDirectories) {
    for (const path of await listRegularFiles(outputDirectory)) {
      const bytes = await readFile(path)
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (error) {
        throw new Error('Public output host-path scan found invalid UTF-8', { cause: error })
      }
      let leaked = findHostPathLeak(content, prefixes)
      if (path.endsWith('.json')) {
        let parsed: unknown
        try {
          parsed = JSON.parse(content) as unknown
        } catch (error) {
          throw new Error('Public output host-path scan found invalid JSON', { cause: error })
        }
        leaked ??= findHostPathLeakInJson(parsed, prefixes)
      }
      if (leaked !== undefined) {
        throw new Error(
          `Public output contains a host path prefix in ${path.slice(outputDirectory.length + 1)}`,
        )
      }
    }
  }
}

await assertCleanRepository()
const sourceIdentity = await readGitSnapshotIdentity(repositoryRoot)
const sourceEntries = await readPublicGitIndexEntries(repositoryRoot)
await assertGitSnapshotIdentity(repositoryRoot, sourceIdentity)
const availableSourcePaths = new Set(sourceEntries.map(({ path }) => path))
for (const required of requiredSourceFiles) {
  if (!availableSourcePaths.has(required)) {
    throw new Error(`Clean-copy Git index is missing ${required}`)
  }
}
const epoch = await sourceDateEpoch(sourceIdentity.commit)
const sharedPnpmStore = (await capture('pnpm', ['store', 'path', '--silent'], repositoryRoot))
  .toString('utf8')
  .trim()
if (!isAbsolute(sharedPnpmStore) || !(await lstat(sharedPnpmStore)).isDirectory()) {
  throw new Error('pnpm store path must be an existing absolute directory')
}
const sharedCorepackHome =
  process.env.COREPACK_HOME ?? join(homedir(), '.cache', 'node', 'corepack')

const root = await mkdtemp(join(tmpdir(), 'trash-palace-public-repro-'))
const runtimeBase = await mkdtemp(
  join(process.platform === 'win32' ? tmpdir() : '/tmp', 'tp-repro-runtime-'),
)
try {
  const copies = [
    { name: 'copy-a', timezone: 'UTC', locale: 'C' },
    { name: 'copy-b', timezone: 'Pacific/Honolulu', locale: 'en_US.UTF-8' },
  ].map((profile) => {
    const copyRoot = join(root, profile.name)
    const runtimeRoot = join(runtimeBase, profile.name)
    return {
      ...profile,
      copyRoot,
      sourceDirectory: join(copyRoot, 'source'),
      runtimeRoot,
      home: join(runtimeRoot, 'home'),
      temporaryDirectory: join(runtimeRoot, 'tmp'),
      xdgCacheHome: join(runtimeRoot, 'xdg', 'cache'),
      xdgConfigHome: join(runtimeRoot, 'xdg', 'config'),
      xdgDataHome: join(runtimeRoot, 'xdg', 'data'),
      npmCache: join(runtimeRoot, 'npm-cache'),
    }
  })

  for (const copy of copies) {
    await Promise.all(
      [
        copy.sourceDirectory,
        copy.home,
        copy.temporaryDirectory,
        copy.xdgCacheHome,
        copy.xdgConfigHome,
        copy.xdgDataHome,
        copy.npmCache,
      ].map((directory) => mkdir(directory, { recursive: true })),
    )
    await materializePublicGitIndex(repositoryRoot, copy.sourceDirectory, sourceEntries)
    const environment = publicReproducibilityEnvironment(process.env, {
      sourceDateEpoch: epoch,
      locale: copy.locale,
      timezone: copy.timezone,
      home: copy.home,
      temporaryDirectory: copy.temporaryDirectory,
      xdgCacheHome: copy.xdgCacheHome,
      xdgConfigHome: copy.xdgConfigHome,
      xdgDataHome: copy.xdgDataHome,
      corepackHome: sharedCorepackHome,
      npmCache: copy.npmCache,
      pnpmStore: sharedPnpmStore,
    })
    await run(
      'pnpm',
      [
        'install',
        '--frozen-lockfile',
        '--offline',
        '--ignore-scripts',
        '--store-dir',
        sharedPnpmStore,
      ],
      copy.sourceDirectory,
      environment,
    )
    await run('pnpm', ['references:generate:public'], copy.sourceDirectory, environment)
  }

  const outputDirectories = copies.map((copy) =>
    resolve(copy.sourceDirectory, GENERATED_PUBLIC_REFERENCE_DIRECTORY),
  )
  const integrity = await Promise.all(
    outputDirectories.map((directory) => assertPublicGeneratedManifest(directory)),
  )
  await assertNoHostPaths(
    outputDirectories,
    publicReproducibilityHostPrefixes({
      repositoryRoot: await realpath(repositoryRoot),
      home: homedir(),
      executable: process.execPath,
      path: process.env.PATH,
      packageManagerRoots: [sharedPnpmStore, sharedCorepackHome],
      runtimeRoots: [root, runtimeBase],
    }),
  )
  const manifests = await Promise.all(
    outputDirectories.map((directory) => readFile(join(directory, 'manifest.json'))),
  )
  const checksums = await Promise.all(
    outputDirectories.map((directory) => readFile(join(directory, 'manifest.sha256'))),
  )
  const [firstManifest, secondManifest] = manifests
  const [firstChecksum, secondChecksum] = checksums
  if (
    firstManifest === undefined ||
    secondManifest === undefined ||
    firstChecksum === undefined ||
    secondChecksum === undefined ||
    !firstManifest.equals(secondManifest) ||
    !firstChecksum.equals(secondChecksum)
  ) {
    throw new Error('Clean public-reference builds produced different SHA-256 manifests')
  }
  if (integrity[0]?.manifestHash !== integrity[1]?.manifestHash) {
    throw new Error('Clean public-reference manifest hashes differ')
  }
  await assertCleanRepository()
  await assertGitSnapshotIdentity(repositoryRoot, sourceIdentity)

  process.stdout.write(
    `${JSON.stringify({
      status: 'reproducible',
      sourceMode: 'clean-git-index',
      sourceCommit: sourceIdentity.commit,
      sourceTree: sourceIdentity.tree,
      cleanCopies: copies.length,
      sourceFiles: sourceEntries.length,
      artifactCount: integrity[0]?.artifactCount,
      manifestHash: integrity[0]?.manifestHash,
      sourceDateEpoch: epoch,
      profiles: copies.map(({ locale, timezone }) => ({ locale, timezone })),
      dependencyBoundary: 'pnpm-offline-explicit-store',
      generatorNetworkIsolation: 'not-os-enforced',
      hostPathScan: 'passed',
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        githubActions: process.env.GITHUB_ACTIONS === 'true',
        runnerOs: process.env.RUNNER_OS ?? null,
      },
    })}\n`,
  )
} finally {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(runtimeBase, { recursive: true, force: true }),
  ])
}
