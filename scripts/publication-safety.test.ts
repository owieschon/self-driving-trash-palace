import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  isPublicationArtifactPath,
  isTrackedCredentialPath,
  scanPublicationArtifact,
  verifyPublicationSafety,
} from './publication-safety.js'

function git(repository: string, arguments_: readonly string[]): void {
  execFileSync('git', arguments_, {
    cwd: repository,
    env: {
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      PATH: process.env.PATH,
    },
  })
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(path: string, contents: string): Buffer {
  const name = Buffer.from(path, 'utf8')
  const data = Buffer.from(contents, 'utf8')
  const compressed = deflateRawSync(data)
  const checksum = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  const centralOffset = local.length + name.length + compressed.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + name.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, name, compressed, central, name, eocd])
}

describe('public artifact boundary', () => {
  it('selects reader-facing surfaces without reading ignored local credentials', () => {
    expect(isPublicationArtifactPath('docs/guide.md')).toBe(true)
    expect(isPublicationArtifactPath('artifacts/public/run.json')).toBe(true)
    expect(isPublicationArtifactPath('evals/reports/baseline.json')).toBe(true)
    expect(isPublicationArtifactPath('.env')).toBe(false)
    expect(isPublicationArtifactPath('artifacts/private/trace.json')).toBe(false)
    expect(isTrackedCredentialPath('.env')).toBe(true)
    expect(isTrackedCredentialPath('.env.example')).toBe(false)
    expect(isTrackedCredentialPath('docs/client.pem')).toBe(true)
    expect(isTrackedCredentialPath('packages/db/src/credentials.integration.test.ts')).toBe(false)
    expect(isTrackedCredentialPath('packages/app/src/credential.test.tsx')).toBe(false)
    expect(isTrackedCredentialPath('config/credentials.json')).toBe(true)
    expect(isTrackedCredentialPath('config/credentials.production.yaml')).toBe(true)
  })

  it('derives the public surface from Git without opening an ignored credential file', () => {
    const repository = mkdtempSync(join(tmpdir(), 'trash-palace-publication-'))
    mkdirSync(join(repository, 'docs'))
    writeFileSync(join(repository, '.gitignore'), '.env\n')
    writeFileSync(join(repository, 'docs', 'guide.md'), '# Safe guide\n')
    writeFileSync(join(repository, '.env'), 'api_key=synthetic-ignored-secret\n')
    chmodSync(join(repository, '.env'), 0o000)
    git(repository, ['init', '--quiet'])
    git(repository, ['add', '.gitignore', 'docs/guide.md'])

    expect(verifyPublicationSafety(repository)).toEqual([])
  })

  it('fails closed when a credential-shaped path is tracked', () => {
    const repository = mkdtempSync(join(tmpdir(), 'trash-palace-publication-'))
    writeFileSync(join(repository, '.env'), 'SAFE_PLACEHOLDER=true\n')
    git(repository, ['init', '--quiet'])
    git(repository, ['add', '-f', '.env'])

    expect(verifyPublicationSafety(repository)).toContainEqual({
      path: '.env',
      reason: 'tracked_credential_path',
    })
  })

  it('scans residue in every tracked text surface, not only reader-facing directories', () => {
    const repository = mkdtempSync(join(tmpdir(), 'trash-palace-publication-'))
    mkdirSync(join(repository, '.beads'))
    mkdirSync(join(repository, 'apps'))
    writeFileSync(join(repository, '.beads', 'issues.jsonl'), '/Users/alice/private/issue.json\n')
    writeFileSync(join(repository, 'HANDOFF.md'), 'Bearer synthetic-publication-token-123456\n')
    writeFileSync(
      join(repository, 'apps', 'worker.ts'),
      "const leaked = 'phc_unsanitizedvalue1234'\n",
    )
    git(repository, ['init', '--quiet'])
    git(repository, ['add', '.beads/issues.jsonl', 'HANDOFF.md', 'apps/worker.ts'])

    expect(verifyPublicationSafety(repository)).toEqual(
      expect.arrayContaining([
        { path: '.beads/issues.jsonl', reason: 'home_path' },
        { path: 'HANDOFF.md', reason: 'credential' },
        { path: 'apps/worker.ts', reason: 'credential' },
      ]),
    )
  })

  it.each([
    ['docs/guide.md', 'Bearer synthetic-publication-token-123456', 'credential'],
    ['generated/reference.json', '/Users/alice/private/report.json', 'home_path'],
    ['examples/request.json', '{"mission":"mis_private123"}', 'private_identifier'],
    ['artifacts/public/run-receipt.json', '{"raw_prompt":"private"}', 'prompt_content'],
    [
      'evals/reports/live.json',
      'https://us.posthog.com/project/12345/ai/traces/private',
      'private_posthog_link',
    ],
    ['artifacts/public/run.json', 'http://127.0.0.1:8000/private', 'private_network_url'],
  ])('rejects a seeded leak in %s', (path, contents, reason) => {
    expect(scanPublicationArtifact(path, Buffer.from(contents))).toContainEqual({ path, reason })
  })

  it('rejects metadata leaks embedded in a screenshot', () => {
    const screenshot = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('profile=/Users/alice/Desktop/trace.png'),
    ])
    expect(scanPublicationArtifact('artifacts/public/screenshot.png', screenshot)).toContainEqual({
      path: 'artifacts/public/screenshot.png',
      reason: 'home_path',
    })
  })

  it('opens skill archives and rejects unsafe paths and retained secrets', () => {
    const leaked = storedZip('references/runbook.md', 'api_key=synthetic-secret-value')
    expect(scanPublicationArtifact('skills/caretaker.skill', leaked)).toContainEqual({
      path: 'skills/caretaker.skill!/references/runbook.md',
      reason: 'credential',
    })
    const escaped = storedZip('../outside.txt', 'safe')
    expect(scanPublicationArtifact('skills/caretaker.skill', escaped)).toContainEqual({
      path: 'skills/caretaker.skill',
      reason: 'archive_path_unsafe',
    })
  })

  it('accepts placeholders and repository-relative public guidance', () => {
    const safe = [
      '# Export evidence',
      '',
      'Set `TRASH_PALACE_POSTHOG_PROJECT_TOKEN` in your ignored local environment.',
      'Write the sanitized receipt to `artifacts/public/example.json`.',
    ].join('\n')
    expect(scanPublicationArtifact('docs/export.md', Buffer.from(safe))).toEqual([])
  })
})
