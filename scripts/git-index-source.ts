import { spawn } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import {
  assertRegularSourcePath,
  gitInspectionEnvironment,
  isPublicReproducibilitySourcePath,
} from './reproducibility-boundary.js'

export interface GitIndexSourceEntry {
  readonly mode: '100644' | '100755'
  readonly objectId: string
  readonly path: string
}

export interface GitSnapshotIdentity {
  readonly commit: string
  readonly tree: string
}

function captureWithInput(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  input?: Buffer,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    const child = spawn(command, [...arguments_], {
      cwd,
      env: gitInspectionEnvironment(process.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'inherit'],
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
    child.stdin.end(input)
  })
}

async function captureGitLine(
  repositoryRoot: string,
  arguments_: readonly string[],
): Promise<string> {
  const value = (await captureWithInput('git', arguments_, repositoryRoot)).toString('ascii').trim()
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error('Git returned an invalid object ID')
  return value
}

export async function readGitSnapshotIdentity(
  repositoryRoot: string,
): Promise<GitSnapshotIdentity> {
  const [commit, tree] = await Promise.all([
    captureGitLine(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    captureGitLine(repositoryRoot, ['write-tree']),
  ])
  return { commit, tree }
}

export async function assertGitSnapshotIdentity(
  repositoryRoot: string,
  expected: GitSnapshotIdentity,
): Promise<void> {
  const actual = await readGitSnapshotIdentity(repositoryRoot)
  if (actual.commit !== expected.commit || actual.tree !== expected.tree) {
    throw new Error('Git commit or index tree changed during public reproducibility verification')
  }
}

export function parsePublicGitIndexEntries(output: Buffer): GitIndexSourceEntry[] {
  const entries: GitIndexSourceEntry[] = []
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record)
    if (match === null) throw new Error('Could not parse tracked Git index entry')
    const [, mode, objectId, stage, path] = match
    if (path === undefined || !isPublicReproducibilitySourcePath(path)) continue
    if (objectId === undefined || stage !== '0' || (mode !== '100644' && mode !== '100755')) {
      throw new Error(`Clean-copy source is not a stage-zero regular file: ${path}`)
    }
    entries.push({ mode, objectId, path })
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
}

export async function readPublicGitIndexEntries(
  repositoryRoot: string,
): Promise<GitIndexSourceEntry[]> {
  const output = await captureWithInput(
    'git',
    ['ls-files', '--cached', '--stage', '-z'],
    repositoryRoot,
  )
  return parsePublicGitIndexEntries(output)
}

function parseBatchBlobs(
  output: Buffer,
  entries: readonly GitIndexSourceEntry[],
): readonly Buffer[] {
  const blobs: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const lineEnd = output.indexOf(0x0a, offset)
    if (lineEnd < 0) throw new Error(`Git cat-file omitted a header for ${entry.path}`)
    const header = output.subarray(offset, lineEnd).toString('ascii')
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(header)
    if (match === null || match[1] !== entry.objectId) {
      throw new Error(`Git cat-file returned the wrong index object for ${entry.path}`)
    }
    const size = Number(match[2])
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Git cat-file returned an invalid blob size for ${entry.path}`)
    }
    const start = lineEnd + 1
    const end = start + size
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`Git cat-file truncated the index blob for ${entry.path}`)
    }
    blobs.push(Buffer.from(output.subarray(start, end)))
    offset = end + 1
  }
  if (offset !== output.length) throw new Error('Git cat-file returned unexpected trailing data')
  return blobs
}

export async function materializePublicGitIndex(
  repositoryRoot: string,
  destinationRoot: string,
  entries: readonly GitIndexSourceEntry[],
): Promise<void> {
  const request = Buffer.from(`${entries.map(({ objectId }) => objectId).join('\n')}\n`, 'ascii')
  const output = await captureWithInput('git', ['cat-file', '--batch'], repositoryRoot, request)
  const blobs = parseBatchBlobs(output, entries)
  const destinationPrefix = `${resolve(destinationRoot)}${sep}`
  for (const [index, entry] of entries.entries()) {
    await assertRegularSourcePath(repositoryRoot, entry.path)
    const destination = resolve(destinationRoot, entry.path)
    if (!destination.startsWith(destinationPrefix)) {
      throw new Error(`Clean-copy destination path escapes its root: ${entry.path}`)
    }
    const blob = blobs[index]
    if (blob === undefined) throw new Error(`Git index blob is missing for ${entry.path}`)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, blob, { flag: 'wx' })
    await chmod(destination, entry.mode === '100755' ? 0o755 : 0o644)
  }
}
