import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, type StdioOptions } from 'node:child_process'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ENV_PATH = resolve(REPOSITORY_ROOT, 'artifacts/private/local-stack.env')
const DEFAULT_START_DELAY_MILLISECONDS = 8 * 60_000
const ARMED_START_DELAY_MILLISECONDS = 30_000
const MINIMUM_START_DELAY_MILLISECONDS = 30_000
const MAXIMUM_START_DELAY_MILLISECONDS = 10 * 60_000

const SECRET_NAMES = [
  'SESSION_SIGNING_KEY',
  'TOOL_INVOCATION_SCOPE_KEY',
  'GATEWAY_CALLBACK_SIGNING_KEY',
  'IDENTITY_TELEMETRY_SIGNING_KEY',
  'TRASH_PALACE_EVIDENCE_ALIAS_KEY',
  'TRASH_PALACE_POSTGRES_PASSWORD',
] as const

export interface PreparedLocalStackEnvironment {
  readonly path: string
  readonly realStartAt: string
  readonly values: Readonly<Record<string, string>>
}

export interface ComposeCommand {
  readonly command: string
  readonly prefixArguments: readonly string[]
}

export type LocalStackCommand =
  'arm' | 'down' | 'logs' | 'prepare' | 'reset' | 'restart' | 'status' | 'up'

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  cwd: string,
  stdio?: StdioOptions,
) => Promise<void>

export async function prepareLocalStackEnvironment(
  options: {
    readonly path?: string
    readonly now?: Date
    readonly startDelayMilliseconds?: number
  } = {},
): Promise<PreparedLocalStackEnvironment> {
  const path = options.path ?? DEFAULT_ENV_PATH
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.valueOf())) throw new TypeError('Local stack clock is invalid')
  const delay = validateStartDelay(
    options.startDelayMilliseconds ?? DEFAULT_START_DELAY_MILLISECONDS,
  )
  const existing = await readEnvironmentIfPresent(path)
  const realStartAt = new Date(now.valueOf() + delay).toISOString()
  const values: Record<string, string> = {
    ...Object.fromEntries(
      SECRET_NAMES.map((name) => [name, existing[name] ?? generatedSecret(name)]),
    ),
    TRASH_PALACE_CLOCK_MODE: 'fixture',
    TRASH_PALACE_FIXTURE_REAL_START_AT: realStartAt,
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  await writeFile(
    path,
    `${Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  await chmod(path, 0o600)
  return Object.freeze({ path, realStartAt, values: Object.freeze(values) })
}

export async function runLocalStack(command: LocalStackCommand): Promise<void> {
  if (command === 'prepare') {
    const prepared = await prepareLocalStackEnvironment()
    process.stdout.write(
      `Prepared artifacts/private/local-stack.env; fixture starts at ${prepared.realStartAt}.\n`,
    )
    return
  }
  const compose = await resolveComposeCommand()
  if (command === 'arm') {
    const prepared = await prepareLocalStackEnvironment({
      startDelayMilliseconds: ARMED_START_DELAY_MILLISECONDS,
    })
    process.stdout.write(
      `Arming the shared fixture clock; fixture time begins at ${prepared.realStartAt}.\n`,
    )
    await runCompose(compose, prepared.path, composeArgumentsFor('arm'))
    return
  }
  if (command === 'up') {
    // Build before choosing the shared wall-clock anchor. A cold image build must not consume the
    // fixture's human-interaction window or make the gateway skip scheduled arrival events.
    const beforeBuild = await prepareLocalStackEnvironment()
    await runCompose(compose, beforeBuild.path, ['build'])
    const prepared = await prepareLocalStackEnvironment()
    process.stdout.write(
      `Starting the local stack; fixture time begins at ${prepared.realStartAt}.\n`,
    )
    await runCompose(compose, prepared.path, composeArgumentsFor('up'))
    return
  }
  const environmentPath = await requirePreparedEnvironment(DEFAULT_ENV_PATH)
  if (command === 'reset') {
    process.stdout.write(
      'Resetting only the self-driving-trash-palace containers and named data volumes.\n',
    )
  }
  await runCompose(compose, environmentPath, composeArgumentsFor(command))
}

export function composeArgumentsFor(
  command: Exclude<LocalStackCommand, 'prepare'>,
): readonly string[] {
  switch (command) {
    case 'down':
      return Object.freeze(['down', '--remove-orphans'])
    case 'arm':
      return Object.freeze([
        'up',
        '--detach',
        '--no-deps',
        '--force-recreate',
        '--wait',
        '--wait-timeout',
        '120',
        'web',
        'gateway-simulator',
        'worker',
      ])
    case 'logs':
      return Object.freeze(['logs', '--follow'])
    case 'reset':
      return Object.freeze(['down', '--volumes', '--remove-orphans'])
    case 'restart':
      return Object.freeze([
        'up',
        '--detach',
        '--no-deps',
        '--force-recreate',
        '--wait',
        '--wait-timeout',
        '60',
        'gateway-simulator',
        'worker',
      ])
    case 'status':
      return Object.freeze(['ps'])
    case 'up':
      return Object.freeze(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '120'])
  }
}

/** Prefers the Docker CLI plugin and falls back to a standalone Compose executable. */
export async function resolveComposeCommand(
  runner: CommandRunner = spawnChecked,
): Promise<ComposeCommand> {
  try {
    await runner('docker', ['compose', 'version'], REPOSITORY_ROOT, 'ignore')
    return Object.freeze({ command: 'docker', prefixArguments: Object.freeze(['compose']) })
  } catch (pluginError) {
    try {
      await runner('docker-compose', ['version'], REPOSITORY_ROOT, 'ignore')
      return Object.freeze({ command: 'docker-compose', prefixArguments: Object.freeze([]) })
    } catch (standaloneError) {
      throw new AggregateError(
        [pluginError, standaloneError],
        'Docker Compose is unavailable; install the Docker CLI plugin or docker-compose',
        { cause: standaloneError },
      )
    }
  }
}

async function runCompose(
  compose: ComposeCommand,
  environmentPath: string,
  arguments_: readonly string[],
): Promise<void> {
  await spawnChecked(
    compose.command,
    [...compose.prefixArguments, '--env-file', environmentPath, ...arguments_],
    REPOSITORY_ROOT,
  )
}

function validateStartDelay(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MINIMUM_START_DELAY_MILLISECONDS ||
    value > MAXIMUM_START_DELAY_MILLISECONDS
  ) {
    throw new RangeError('Fixture start delay must be between 30 seconds and 10 minutes')
  }
  return value
}

async function readEnvironmentIfPresent(path: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return {}
    throw error
  }
  const values: Record<string, string> = {}
  for (const [index, line] of text.split('\n').entries()) {
    if (line.length === 0) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`Local stack environment line ${index + 1} is malformed`)
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || value.length === 0 || name in values) {
      throw new Error(`Local stack environment line ${index + 1} is malformed`)
    }
    values[name] = value
  }
  return values
}

function generatedSecret(name: (typeof SECRET_NAMES)[number]): string {
  const prefix = name === 'TRASH_PALACE_POSTGRES_PASSWORD' ? 'pg_' : 'local_'
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

async function requirePreparedEnvironment(path: string): Promise<string> {
  await readFile(path, 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) {
      throw new Error('Run `pnpm local:prepare` or `pnpm local:up` before this command')
    }
    throw error
  })
  return path
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function spawnChecked(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  stdio: StdioOptions = 'inherit',
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(
        new Error(
          signal === null
            ? `${command} exited with status ${String(code)}`
            : `${command} exited after ${signal}`,
        ),
      )
    })
  })
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return entry !== undefined && pathToFileURL(resolve(entry)).href === moduleUrl
}

if (isMain(import.meta.url)) {
  const command = process.argv[2]
  if (
    !['arm', 'down', 'logs', 'prepare', 'reset', 'restart', 'status', 'up'].includes(command ?? '')
  ) {
    process.stderr.write(
      'Usage: tsx scripts/local-stack.ts <prepare|up|arm|status|logs|restart|down|reset>\n',
    )
    process.exitCode = 2
  } else {
    void runLocalStack(command as LocalStackCommand).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Local stack failed'}\n`)
      process.exitCode = 1
    })
  }
}
