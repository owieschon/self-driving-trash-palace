import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertRegularSourcePath,
  findHostPathLeak,
  findHostPathLeakInJson,
  gitInspectionEnvironment,
  isPublicReproducibilitySourcePath,
  publicReproducibilityHostPrefixes,
  publicReproducibilityEnvironment,
} from './reproducibility-boundary.js'

describe('public reproducibility boundary', () => {
  it.each(['package.json', 'packages/agent/src/context.ts', '.github/workflows/ci.yml'])(
    'admits source file %s',
    (path) => {
      expect(isPublicReproducibilitySourcePath(path)).toBe(true)
    },
  )

  it.each([
    '.env',
    '.env.example',
    'apps/web/.env.production',
    'apps/.env.example/schema.json',
    'packages/.env-vault/fixture.ts',
    'generated/reference/openapi.json',
    'artifacts/public/context.json',
    'artifacts/private/trace.json',
    'apps/web/.next/routes.json',
    'packages/agent/dist/index.js',
    'packages/core/node_modules/zod/index.js',
    'coverage/results.json',
    '.beads/issues.jsonl',
    '.dolt/config.json',
    '../outside.txt',
    '/absolute.txt',
    'windows\\path.txt',
  ])('rejects non-source or environment path %s', (path) => {
    expect(isPublicReproducibilitySourcePath(path)).toBe(false)
  })

  it('passes only build paths and fixed deterministic values to child processes', () => {
    const seededSecrets = {
      ANTHROPIC_API_KEY: 'seeded-agent-key',
      DATABASE_URL: 'postgres://seeded-private-database',
      NEXT_PUBLIC_POSTHOG_KEY: 'seeded-browser-key',
      NODE_AUTH_TOKEN: 'seeded-registry-token',
      POSTHOG_API_KEY: 'seeded-posthog-key',
    }
    const environment = publicReproducibilityEnvironment(
      {
        ...seededSecrets,
        NODE_OPTIONS: '--require=/private/inject.js',
        PATH: '/safe/bin',
      },
      {
        sourceDateEpoch: '1784073600',
        locale: 'C',
        timezone: 'UTC',
        home: '/synthetic/a/home',
        temporaryDirectory: '/synthetic/a/tmp',
        xdgCacheHome: '/synthetic/a/xdg/cache',
        xdgConfigHome: '/synthetic/a/xdg/config',
        xdgDataHome: '/synthetic/a/xdg/data',
        corepackHome: '/synthetic/a/corepack',
        npmCache: '/synthetic/a/npm',
        pnpmStore: '/shared/pnpm/store',
      },
    )

    expect(environment).toMatchObject({
      CI: 'true',
      COREPACK_HOME: '/synthetic/a/corepack',
      HOME: '/synthetic/a/home',
      LANG: 'C',
      LC_ALL: 'C',
      NPM_CONFIG_CACHE: '/synthetic/a/npm',
      PATH: '/safe/bin',
      PNPM_STORE_DIR: '/shared/pnpm/store',
      SOURCE_DATE_EPOCH: '1784073600',
      TEMP: '/synthetic/a/tmp',
      TMP: '/synthetic/a/tmp',
      TMPDIR: '/synthetic/a/tmp',
      TZ: 'UTC',
      XDG_CACHE_HOME: '/synthetic/a/xdg/cache',
      XDG_CONFIG_HOME: '/synthetic/a/xdg/config',
      XDG_DATA_HOME: '/synthetic/a/xdg/data',
    })
    expect(Object.keys(environment).sort()).toEqual(
      [
        'CI',
        'COREPACK_ENABLE_DOWNLOAD_PROMPT',
        'COREPACK_HOME',
        'HOME',
        'LANG',
        'LC_ALL',
        'NPM_CONFIG_CACHE',
        'NPM_CONFIG_GLOBALCONFIG',
        'NPM_CONFIG_IGNORE_SCRIPTS',
        'NPM_CONFIG_USERCONFIG',
        'PATH',
        'PNPM_STORE_DIR',
        'SOURCE_DATE_EPOCH',
        'TEMP',
        'TMP',
        'TMPDIR',
        'TZ',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
      ].sort(),
    )
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    for (const name of Object.keys(seededSecrets)) expect(environment).not.toHaveProperty(name)
  })

  it('walks source ancestors and rejects a symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trash-palace-source-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'trash-palace-source-outside-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'safe.ts'), 'export {}\n', 'utf8')
      await writeFile(join(outside, 'escaped.ts'), 'throw new Error()\n', 'utf8')
      await symlink(outside, join(root, 'escaped'), 'dir')

      await expect(assertRegularSourcePath(root, 'src/safe.ts')).resolves.toMatch(/safe\.ts$/)
      await expect(assertRegularSourcePath(root, 'escaped/escaped.ts')).rejects.toThrow(
        /cannot use symlinks/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('detects raw and JSON-escaped host paths for POSIX and Windows prefixes', () => {
    const windowsPrefix = 'C:\\Users\\rocky\\trash-palace'
    const posixPrefix = '/home/rocky/trash-palace'

    expect(findHostPathLeak(`trace=${windowsPrefix}\\generated`, [windowsPrefix])).toBe(
      windowsPrefix,
    )
    expect(
      findHostPathLeak(JSON.stringify({ trace: `${windowsPrefix}\\generated` }), [windowsPrefix]),
    ).toBe(windowsPrefix)
    expect(findHostPathLeak(`trace=${posixPrefix}/generated`, [posixPrefix])).toBe(posixPrefix)
    expect(
      findHostPathLeak(`{"trace":"\\/home\\/rocky\\/trash-palace\\/generated"}`, [posixPrefix]),
    ).toBe(posixPrefix)
    expect(
      findHostPathLeak('generated/public-reference/openapi.json', [windowsPrefix, posixPrefix]),
    ).toBeUndefined()
    const unicodeWindowsJson = String.raw`{"trace":"c:\u005cusers\u005cROCKY\u005ctrash-palace\u005cout.json"}`
    expect(findHostPathLeakInJson(JSON.parse(unicodeWindowsJson), [windowsPrefix])).toBe(
      windowsPrefix,
    )
    expect(findHostPathLeak('{"note":"/usr/binary is not a /usr/bin path"}', ['/usr/bin'])).toBe(
      '/usr/bin',
    )
    expect(findHostPathLeak('{"note":"/usr/binary"}', ['/usr/bin'])).toBeUndefined()
  })

  it('scrubs ambient Git repository and index overrides', () => {
    const environment = gitInspectionEnvironment({
      PATH: '/safe/bin',
      GIT_DIR: '/attacker/repository',
      GIT_INDEX_FILE: '/attacker/index',
      GIT_OBJECT_DIRECTORY: '/attacker/objects',
      GIT_WORK_TREE: '/attacker/worktree',
    })

    expect(environment).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/safe/bin',
    })
    expect(
      Object.keys(environment)
        .filter((key) => key.startsWith('GIT_'))
        .sort(),
    ).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'])
  })

  it('includes executable, PATH, package-manager, and runtime roots in the leak boundary', () => {
    const prefixes = publicReproducibilityHostPrefixes({
      repositoryRoot: '/workspace/trash-palace',
      home: '/home/rocky',
      executable: '/runtime/node/bin/node',
      path: ['/runtime/node/bin', '/runtime/tools/bin'].join(
        process.platform === 'win32' ? ';' : ':',
      ),
      packageManagerRoots: ['/stores/pnpm', '/stores/corepack'],
      runtimeRoots: ['/tmp/repro/source', '/tmp/repro/runtime'],
    })

    expect(prefixes).toEqual(
      expect.arrayContaining([
        '/runtime/node/bin/node',
        '/runtime/node/bin',
        '/runtime/tools/bin',
        '/stores/pnpm',
        '/stores/corepack',
        '/tmp/repro/source',
        '/tmp/repro/runtime',
      ]),
    )
  })
})
