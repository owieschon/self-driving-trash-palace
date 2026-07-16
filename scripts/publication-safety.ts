import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, lstatSync } from 'node:fs'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { extname, resolve, sep } from 'node:path'

import {
  scrubForPublication,
  type RedactionReason,
} from '../packages/observability/src/redaction.js'

const ROOT_PUBLIC_FILES = new Set([
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
])
const PUBLIC_PREFIXES = [
  '.claude/skills/',
  'artifacts/public/',
  'docs/',
  'evals/reports/',
  'examples/',
  'generated/',
  'knowledge/',
  'skills/',
] as const
const STRICT_PREFIXES = [
  '.claude/skills/',
  'artifacts/public/',
  'evals/reports/',
  'examples/',
  'skills/',
] as const
const TEXT_EXTENSIONS = new Set([
  '',
  '.csv',
  '.css',
  '.html',
  '.json',
  '.jsonl',
  '.md',
  '.mdx',
  '.mjs',
  '.sh',
  '.sql',
  '.sha256',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
])
const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])
const ARCHIVE_EXTENSIONS = new Set(['.skill', '.tar', '.tgz', '.zip'])
const SOURCE_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.sh', '.sql', '.ts', '.tsx'])
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_ARCHIVE_ENTRY_BYTES = 5 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 2_000
const MAX_ARCHIVE_DEPTH = 2

const PRIVATE_NETWORK_URL =
  /https?:\/\/(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?(?:\/|\b)/gi
const PROMPT_FIELD =
  /["'](?:\$ai_input|\$ai_output_choices|chain_of_thought|raw_prompt|system_prompt|transcript|user_prompt)["']\s*:/gi
const TRACKED_CREDENTIAL_COMPONENT =
  /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|id_[^.]+|.*\.(?:key|pem|p12))$/i
const CREDENTIAL_TEST_SOURCE_COMPONENT = /^credentials?(?:\.[a-z0-9_-]+)*\.test\.(?:[cm]?[jt]sx?)$/i

export type PublicationFindingReason =
  | RedactionReason
  | 'archive_invalid'
  | 'archive_path_unsafe'
  | 'archive_too_large'
  | 'private_network_url'
  | 'prompt_content'
  | 'public_artifact_symlink'
  | 'tracked_credential_path'
  | 'unsupported_public_artifact_type'

export interface PublicationFinding {
  readonly path: string
  readonly reason: PublicationFindingReason
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized
      .split('/')
      .some((component) => component === '' || component === '.' || component === '..')
  ) {
    throw new Error('Publication paths must be normalized repository-relative paths')
  }
  return normalized
}

export function isPublicationArtifactPath(pathInput: string): boolean {
  const path = normalizeRepositoryPath(pathInput)
  return ROOT_PUBLIC_FILES.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export function isTrackedCredentialPath(pathInput: string): boolean {
  const path = normalizeRepositoryPath(pathInput)
  if (path === '.env.example' || path.endsWith('/.env.example')) return false
  return path
    .split('/')
    .some(
      (component) =>
        !CREDENTIAL_TEST_SOURCE_COMPONENT.test(component) &&
        TRACKED_CREDENTIAL_COMPONENT.test(component),
    )
}

function strictArtifact(path: string): boolean {
  return (
    STRICT_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    /(?:receipt|report|trace)/i.test(path)
  )
}

function uniqueFindings(findings: readonly PublicationFinding[]): PublicationFinding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = `${finding.path}\0${finding.reason}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function textChunks(text: string): string[] {
  const chunks: string[] = []
  const width = 1_800
  const overlap = 256
  for (let offset = 0; offset < text.length; offset += width - overlap) {
    chunks.push(text.slice(offset, offset + width))
  }
  return chunks.length === 0 ? [''] : chunks
}

function scanText(path: string, text: string, strict: boolean): PublicationFinding[] {
  const allowedReasons = strict
    ? new Set<RedactionReason>([
        'credential',
        'email',
        'home_path',
        'private_identifier',
        'private_posthog_link',
      ])
    : new Set<RedactionReason>(['credential', 'email', 'home_path', 'private_posthog_link'])
  const findings = textChunks(text).flatMap((chunk) =>
    scrubForPublication(chunk)
      .findings.filter((finding) => allowedReasons.has(finding.reason))
      .map((finding) => ({ path, reason: finding.reason })),
  )
  if (strict && PRIVATE_NETWORK_URL.test(text)) {
    findings.push({ path, reason: 'private_network_url' })
  }
  PRIVATE_NETWORK_URL.lastIndex = 0
  if (strict && PROMPT_FIELD.test(text)) {
    findings.push({ path, reason: 'prompt_content' })
  }
  PROMPT_FIELD.lastIndex = 0
  return uniqueFindings(findings)
}

function scanTrackedSource(path: string, text: string): PublicationFinding[] {
  const isTest = /(?:^|\/)[^/]+\.(?:integration\.)?(?:spec|test)\.[^.]+$/.test(path)
  const homePath = /\/(?:Users|home)\/(?!node(?:\/|\b))[A-Za-z0-9._-]+(?:\/[^\s"'`]+)*/
  const quotedCredential =
    /["'`](?:ph[ctx]_[A-Za-z0-9_-]{12,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})/
  const bearerValue = /["'`]Bearer\s+([A-Za-z0-9._~+/-]{12,}=*)/.exec(text)?.[1]
  const containsBearerCredential =
    bearerValue !== undefined && !/^(?:authentication|credential|token)$/i.test(bearerValue)
  const findings = scanText(path, text, false)
  return findings.filter((finding) => {
    if (finding.reason === 'credential')
      return !isTest && (quotedCredential.test(text) || containsBearerCredential)
    if (finding.reason === 'home_path') return !isTest && homePath.test(text)
    if (finding.reason === 'email' || finding.reason === 'private_posthog_link') return !isTest
    return false
  })
}

function printableStrings(bytes: Buffer): string {
  const strings: string[] = []
  let current = ''
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte)
      continue
    }
    if (current.length >= 4) strings.push(current)
    current = ''
  }
  if (current.length >= 4) strings.push(current)
  return strings.join('\n')
}

function safeArchivePath(pathInput: string): string {
  const path = pathInput.replaceAll('\\', '/')
  const components = path.split('/').filter((component) => component.length > 0)
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    components.length === 0 ||
    components.some((component) => component === '.' || component === '..')
  ) {
    throw new Error('Archive entry path is unsafe')
  }
  return components.join('/')
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface ArchiveEntry {
  readonly path: string
  readonly bytes: Buffer
}

function zipEntries(archive: Buffer): ArchiveEntry[] {
  const minimumEocd = 22
  const searchStart = Math.max(0, archive.length - 65_557)
  let eocd = -1
  for (let offset = archive.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP end record is absent')
  const disk = archive.readUInt16LE(eocd + 4)
  const centralDisk = archive.readUInt16LE(eocd + 6)
  const entries = archive.readUInt16LE(eocd + 10)
  const centralSize = archive.readUInt32LE(eocd + 12)
  const centralOffset = archive.readUInt32LE(eocd + 16)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entries > MAX_ARCHIVE_ENTRIES ||
    centralOffset + centralSize > eocd
  ) {
    throw new Error('ZIP topology is unsupported or malformed')
  }

  const output: ArchiveEntry[] = []
  let offset = centralOffset
  let totalBytes = 0
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ZIP central directory is malformed')
    }
    const flags = archive.readUInt16LE(offset + 8)
    const method = archive.readUInt16LE(offset + 10)
    const expectedCrc = archive.readUInt32LE(offset + 16)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const externalAttributes = archive.readUInt32LE(offset + 38)
    const localOffset = archive.readUInt32LE(offset + 42)
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)) {
      throw new Error('Encrypted or unsupported ZIP entries are forbidden')
    }
    const unixMode = externalAttributes >>> 16
    if ((unixMode & 0o170000) === 0o120000) throw new Error('ZIP symlinks are forbidden')
    if (name.endsWith('/')) continue
    const path = safeArchivePath(name)
    if (
      uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES ||
      totalBytes + uncompressedSize > MAX_ARTIFACT_BYTES ||
      (compressedSize > 0 && uncompressedSize / compressedSize > 200)
    ) {
      throw new Error('ZIP expansion exceeds the publication boundary')
    }
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('ZIP local header is malformed')
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize)
    if (compressed.length !== compressedSize) throw new Error('ZIP entry is truncated')
    const bytes = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    if (bytes.length !== uncompressedSize || crc32(bytes) !== expectedCrc) {
      throw new Error('ZIP entry size or CRC does not match its directory')
    }
    output.push({ path, bytes })
    totalBytes += bytes.length
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP directory size is inconsistent')
  return output
}

function tarEntries(archive: Buffer): ArchiveEntry[] {
  const output: ArchiveEntry[] = []
  let offset = 0
  let totalBytes = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
    const type = String.fromCharCode(header[156] ?? 0)
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim()
    const size = Number.parseInt(sizeText || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('TAR entry size is invalid')
    const path = safeArchivePath(prefix.length > 0 ? `${prefix}/${name}` : name)
    offset += 512
    if (type === '2' || type === '1') throw new Error('TAR links are forbidden')
    if (type !== '\0' && type !== '0' && type !== '5')
      throw new Error('TAR entry type is unsupported')
    if (type !== '5') {
      if (
        size > MAX_ARCHIVE_ENTRY_BYTES ||
        totalBytes + size > MAX_ARTIFACT_BYTES ||
        output.length >= MAX_ARCHIVE_ENTRIES
      ) {
        throw new Error('TAR expansion exceeds the publication boundary')
      }
      const bytes = archive.subarray(offset, offset + size)
      if (bytes.length !== size) throw new Error('TAR entry is truncated')
      output.push({ path, bytes: Buffer.from(bytes) })
      totalBytes += size
    }
    offset += Math.ceil(size / 512) * 512
  }
  return output
}

function scanArchive(path: string, bytes: Buffer, depth: number): PublicationFinding[] {
  if (depth >= MAX_ARCHIVE_DEPTH) return [{ path, reason: 'archive_invalid' }]
  let entries: ArchiveEntry[]
  try {
    const extension = extname(path).toLowerCase()
    if (extension === '.zip' || extension === '.skill') {
      entries = zipEntries(bytes)
    } else {
      const tar = extension === '.tgz' ? gunzipSync(bytes) : bytes
      entries = tarEntries(tar)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const reason: PublicationFindingReason =
      message.includes('path') || message.includes('link')
        ? 'archive_path_unsafe'
        : message.includes('exceed')
          ? 'archive_too_large'
          : 'archive_invalid'
    return [{ path, reason }]
  }
  return entries.flatMap((entry) =>
    scanPublicationArtifact(`${path}!/${entry.path}`, entry.bytes, depth + 1, true),
  )
}

export function scanPublicationArtifact(
  pathInput: string,
  bytes: Buffer,
  archiveDepth = 0,
  forceStrict = false,
): PublicationFinding[] {
  const path = pathInput.includes('!/') ? pathInput : normalizeRepositoryPath(pathInput)
  if (bytes.length > MAX_ARTIFACT_BYTES) return [{ path, reason: 'archive_too_large' }]
  const outerPath = path.split('!/').at(-1) ?? path
  const extension = extname(outerPath).toLowerCase()
  if (ARCHIVE_EXTENSIONS.has(extension)) return scanArchive(path, bytes, archiveDepth)
  const strict = forceStrict || strictArtifact(path)
  if (TEXT_EXTENSIONS.has(extension)) return scanText(path, bytes.toString('utf8'), strict)
  if (IMAGE_EXTENSIONS.has(extension)) return scanText(path, printableStrings(bytes), true)
  if (extension === '.gz') {
    try {
      return scanPublicationArtifact(path.slice(0, -3), gunzipSync(bytes), archiveDepth + 1, true)
    } catch {
      return [{ path, reason: 'archive_invalid' }]
    }
  }
  return [{ path, reason: 'unsupported_public_artifact_type' }]
}

function gitPaths(repositoryRoot: string, mode: '--cached' | '--others'): string[] {
  const arguments_ = ['ls-files', '-z', mode]
  if (mode === '--others') arguments_.push('--exclude-standard')
  const output = execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'buffer',
    env: {
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: process.env.PATH,
    },
  })
  return output
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0)
    .map(normalizeRepositoryPath)
}

export function verifyPublicationSafety(repositoryRootInput: string): PublicationFinding[] {
  const repositoryRoot = resolve(repositoryRootInput)
  const tracked = gitPaths(repositoryRoot, '--cached')
  const trackedSet = new Set(tracked)
  const candidates = [...new Set([...tracked, ...gitPaths(repositoryRoot, '--others')])]
  const findings: PublicationFinding[] = tracked
    .filter(isTrackedCredentialPath)
    .map((path) => ({ path, reason: 'tracked_credential_path' }))

  for (const path of candidates
    .filter((path) => trackedSet.has(path) || isPublicationArtifactPath(path))
    .sort()) {
    const absolute = resolve(repositoryRoot, path)
    if (!absolute.startsWith(`${repositoryRoot}${sep}`)) {
      findings.push({ path, reason: 'archive_path_unsafe' })
      continue
    }
    // A tracked file deleted in the working tree is not a publication candidate. The index will
    // remove it at commit time, and trying to inspect it would make safety checks order-dependent.
    if (!existsSync(absolute)) continue
    const metadata = lstatSync(absolute)
    if (metadata.isSymbolicLink()) {
      findings.push({ path, reason: 'public_artifact_symlink' })
      continue
    }
    if (!metadata.isFile()) continue
    const extension = extname(path).toLowerCase()
    const scannable =
      TEXT_EXTENSIONS.has(extension) ||
      IMAGE_EXTENSIONS.has(extension) ||
      ARCHIVE_EXTENSIONS.has(extension) ||
      extension === '.gz'
    if (!scannable && !isPublicationArtifactPath(path)) continue
    const bytes = readFileSync(absolute)
    if (
      trackedSet.has(path) &&
      !isPublicationArtifactPath(path) &&
      (SOURCE_EXTENSIONS.has(extension) || path === 'Dockerfile')
    ) {
      findings.push(...scanTrackedSource(path, bytes.toString('utf8')))
      continue
    }
    findings.push(...scanPublicationArtifact(path, bytes))
  }
  return uniqueFindings(findings)
}
