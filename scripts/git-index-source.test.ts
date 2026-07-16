import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from 'vitest'

import {
  assertGitSnapshotIdentity,
  materializePublicGitIndex,
  readGitSnapshotIdentity,
  readPublicGitIndexEntries,
} from './git-index-source.js'

const execFileAsync = promisify(execFile)

it('materializes the stage-zero index blob when skip-worktree hides divergent bytes', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'trash-palace-index-source-'))
  const destination = await mkdtemp(join(tmpdir(), 'trash-palace-index-copy-'))
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.name', 'Index Fixture'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.email', 'index@example.invalid'], {
      cwd: repository,
    })
    await mkdir(join(repository, 'src'), { recursive: true })
    await writeFile(join(repository, 'src', 'contract.ts'), 'index bytes\n', 'utf8')
    await execFileAsync('git', ['add', 'src/contract.ts'], { cwd: repository })
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository })
    await execFileAsync('git', ['update-index', '--skip-worktree', 'src/contract.ts'], {
      cwd: repository,
    })
    await writeFile(join(repository, 'src', 'contract.ts'), 'hidden worktree bytes\n', 'utf8')

    const status = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repository },
    )
    expect(status.stdout).toBe('')

    const entries = await readPublicGitIndexEntries(repository)
    await materializePublicGitIndex(repository, destination, entries)
    await expect(readFile(join(destination, 'src', 'contract.ts'), 'utf8')).resolves.toBe(
      'index bytes\n',
    )
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(destination, { recursive: true, force: true })
  }
})

it('rejects an index tree change after snapshot identity is bound', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'trash-palace-index-identity-'))
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.name', 'Identity Fixture'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.email', 'identity@example.invalid'], {
      cwd: repository,
    })
    await writeFile(join(repository, 'contract.ts'), 'first tree\n', 'utf8')
    await execFileAsync('git', ['add', 'contract.ts'], { cwd: repository })
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository })
    const identity = await readGitSnapshotIdentity(repository)

    await writeFile(join(repository, 'contract.ts'), 'second tree\n', 'utf8')
    await execFileAsync('git', ['add', 'contract.ts'], { cwd: repository })
    await expect(assertGitSnapshotIdentity(repository, identity)).rejects.toThrow(
      /changed during public reproducibility verification/,
    )
    await execFileAsync('git', ['commit', '--quiet', '-m', 'changed fixture'], { cwd: repository })
    await expect(assertGitSnapshotIdentity(repository, identity)).rejects.toThrow(
      /changed during public reproducibility verification/,
    )
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})
