import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  composeArgumentsFor,
  prepareLocalStackEnvironment,
  resolveComposeCommand,
  type CommandRunner,
} from './local-stack.js'

describe('local stack environment preparation', () => {
  it('creates independent local-only secrets and one shared future fixture anchor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trash-palace-stack-'))
    const path = join(directory, 'local-stack.env')
    const prepared = await prepareLocalStackEnvironment({
      path,
      now: new Date('2026-07-15T12:00:00.000Z'),
      startDelayMilliseconds: 30_000,
    })

    expect(prepared.realStartAt).toBe('2026-07-15T12:00:30.000Z')
    expect(prepared.values).toMatchObject({
      TRASH_PALACE_CLOCK_MODE: 'fixture',
      TRASH_PALACE_FIXTURE_REAL_START_AT: prepared.realStartAt,
    })
    const secrets = [
      prepared.values.SESSION_SIGNING_KEY,
      prepared.values.TOOL_INVOCATION_SCOPE_KEY,
      prepared.values.GATEWAY_CALLBACK_SIGNING_KEY,
      prepared.values.IDENTITY_TELEMETRY_SIGNING_KEY,
      prepared.values.TRASH_PALACE_EVIDENCE_ALIAS_KEY,
    ]
    expect(new Set(secrets).size).toBe(secrets.length)
    expect(secrets.every((value) => value !== undefined && value.length >= 32)).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain('replace-with-')
  })

  it('preserves generated identities across restarts while refreshing only the anchor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trash-palace-stack-'))
    const path = join(directory, 'local-stack.env')
    const first = await prepareLocalStackEnvironment({
      path,
      now: new Date('2026-07-15T12:00:00.000Z'),
      startDelayMilliseconds: 30_000,
    })
    const second = await prepareLocalStackEnvironment({
      path,
      now: new Date('2026-07-15T13:00:00.000Z'),
      startDelayMilliseconds: 30_000,
    })

    for (const name of [
      'SESSION_SIGNING_KEY',
      'TOOL_INVOCATION_SCOPE_KEY',
      'GATEWAY_CALLBACK_SIGNING_KEY',
      'IDENTITY_TELEMETRY_SIGNING_KEY',
      'TRASH_PALACE_EVIDENCE_ALIAS_KEY',
      'TRASH_PALACE_POSTGRES_PASSWORD',
    ]) {
      expect(second.values[name]).toBe(first.values[name])
    }
    expect(second.realStartAt).toBe('2026-07-15T13:00:30.000Z')
  })

  it('fails closed for unsafe delays and malformed retained files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trash-palace-stack-'))
    const path = join(directory, 'local-stack.env')

    await expect(
      prepareLocalStackEnvironment({ path, startDelayMilliseconds: 29_999 }),
    ).rejects.toThrow(/between 30 seconds/)
    await writeFile(path, 'BROKEN\nSESSION_SIGNING_KEY=one\nSESSION_SIGNING_KEY=two\n')
    await expect(prepareLocalStackEnvironment({ path })).rejects.toThrow(/line 1/)
  })
})

describe('Docker Compose command selection', () => {
  it('prefers the Docker CLI plugin when it is available', async () => {
    const calls: string[] = []
    const runner: CommandRunner = async (command, arguments_) => {
      calls.push([command, ...arguments_].join(' '))
    }

    await expect(resolveComposeCommand(runner)).resolves.toEqual({
      command: 'docker',
      prefixArguments: ['compose'],
    })
    expect(calls).toEqual(['docker compose version'])
  })

  it('uses the standalone executable when the Docker CLI plugin is unavailable', async () => {
    const calls: string[] = []
    const runner: CommandRunner = async (command, arguments_) => {
      calls.push([command, ...arguments_].join(' '))
      if (command === 'docker') throw new Error('compose is not a docker command')
    }

    await expect(resolveComposeCommand(runner)).resolves.toEqual({
      command: 'docker-compose',
      prefixArguments: [],
    })
    expect(calls).toEqual(['docker compose version', 'docker-compose version'])
  })

  it('reports both failed probes when neither Compose form is installed', async () => {
    const runner: CommandRunner = async (command) => {
      throw new Error(`${command} unavailable`)
    }

    try {
      await resolveComposeCommand(runner)
      expect.unreachable('Compose selection should fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      if (!(error instanceof AggregateError)) return
      expect(error.message).toContain('Docker Compose is unavailable')
      const errors = error.errors as readonly unknown[]
      expect(errors).toHaveLength(2)
      expect(errors[0]).toMatchObject({ message: 'docker unavailable' })
      expect(errors[1]).toMatchObject({ message: 'docker-compose unavailable' })
    }
  })
})

describe('local stack lifecycle commands', () => {
  it('arms one shared near-future fixture clock by recreating every domain-clock process', () => {
    expect(composeArgumentsFor('arm')).toEqual([
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
  })

  it('waits for every local service to become healthy before returning from startup', () => {
    expect(composeArgumentsFor('up')).toEqual([
      'up',
      '--detach',
      '--no-build',
      '--wait',
      '--wait-timeout',
      '120',
    ])
  })

  it('recreates only the gateway and worker and waits for both to become healthy', () => {
    expect(composeArgumentsFor('restart')).toEqual([
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
  })

  it("removes only this Compose project's declared volumes during a destructive reset", () => {
    expect(composeArgumentsFor('reset')).toEqual(['down', '--volumes', '--remove-orphans'])
  })
})

describe('local stack composition contract', () => {
  it('serves the built web application instead of a development HMR server', async () => {
    const compose = await readFile(resolve(import.meta.dirname, '../compose.yaml'), 'utf8')
    const web = serviceBlock(compose, 'web', 'gateway-simulator')
    const dockerfile = await readFile(resolve(import.meta.dirname, '../Dockerfile'), 'utf8')

    expect(dockerfile).toContain('pnpm --filter @trash-palace/web build')
    expect(web).toContain("'@trash-palace/web',")
    expect(web).toContain('start,')
    expect(web).toContain('NODE_ENV: development')
    expect(web).toContain('loopback-only fixture login')
    expect(web).toContain('TRASH_PALACE_RUNTIME_ENVIRONMENT:-local')
    expect(web).toContain('TRASH_PALACE_RUNTIME_EVIDENCE_ORIGIN:-fixture')
    expect(web).not.toContain('dev,')
  })

  it('shares one protected evidence sink across web and worker without seeding from either', async () => {
    const compose = await readFile(resolve(import.meta.dirname, '../compose.yaml'), 'utf8')
    const web = serviceBlock(compose, 'web', 'gateway-simulator')
    const worker = serviceBlock(compose, 'worker', 'networks', 0)
    const evidenceBindings = [
      'TRASH_PALACE_EVIDENCE_ALIAS_KEY: ${TRASH_PALACE_EVIDENCE_ALIAS_KEY:?Run pnpm local:prepare}',
      'TRASH_PALACE_EVIDENCE_SINK_PATH: /var/lib/trash-palace/evidence/caretaker.jsonl',
      'TRASH_PALACE_ENVIRONMENT: ${TRASH_PALACE_RUNTIME_ENVIRONMENT:-local}',
      'TRASH_PALACE_EVIDENCE_ORIGIN: ${TRASH_PALACE_RUNTIME_EVIDENCE_ORIGIN:-fixture}',
      '- trash-palace-evidence:/var/lib/trash-palace/evidence',
    ]

    for (const binding of evidenceBindings) {
      expect(web).toContain(binding)
      expect(worker).toContain(binding)
    }
    expect(compose.match(/TRASH_PALACE_BOOTSTRAP_PROFILE:/g)).toHaveLength(1)
    expect(serviceBlock(compose, 'bootstrap', 'web')).toContain(
      'TRASH_PALACE_BOOTSTRAP_PROFILE: local-fixture',
    )
  })
})

function serviceBlock(
  source: string,
  service: string,
  nextSection: string,
  nextIndent = 2,
): string {
  const start = source.indexOf(`\n  ${service}:`)
  const end = source.indexOf(`\n${' '.repeat(nextIndent)}${nextSection}:`, start + 1)
  if (start < 0 || end < 0) throw new Error(`Compose service block ${service} is missing`)
  return source.slice(start, end)
}
