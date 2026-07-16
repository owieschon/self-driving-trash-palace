import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { scrubForPublication } from '@trash-palace/observability'
import { z } from 'zod'

export const SCHEMA_VERSION = '1.0.0' as const

export const StableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)

export const ClaimIdSchema = z.string().regex(/^TP-[A-Z0-9]+-[0-9]{3}$/)

export const SemverSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/)

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const IsoDateSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)

export const IsoDateTimeSchema = z.iso.datetime({ offset: true })

export const OpaqueRefSchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^(?:bundle|evidence|mission|receipt|request|run|trace)_[a-z0-9][a-z0-9_-]+$/)

export function uniqueArray<T extends z.ZodType>(itemSchema: T, label: string) {
  return z.array(itemSchema).superRefine((items, context) => {
    const seen = new Set<unknown>()

    items.forEach((item, index) => {
      if (seen.has(item)) {
        context.addIssue({
          code: 'custom',
          message: `${label} must be unique`,
          path: [index],
        })
      }
      seen.add(item)
    })
  })
}

export const RepoRelativeUriSchema = z.string().superRefine((value, context) => {
  const hasParentSegment = value.split('/').includes('..')
  const invalid =
    value.length === 0 ||
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value) ||
    hasParentSegment ||
    /\s/.test(value)

  if (invalid) {
    context.addIssue({ code: 'custom', message: 'URI must be a safe repository-relative path' })
  }
})

function parseHttpsUri(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) {
      return undefined
    }
    return url
  } catch {
    return undefined
  }
}

export const HttpsUriSchema = z.string().superRefine((value, context) => {
  if (!parseHttpsUri(value)) {
    context.addIssue({ code: 'custom', message: 'URI must use HTTPS without embedded credentials' })
  }
})

export const CanonicalUriSchema = z.union([RepoRelativeUriSchema, HttpsUriSchema])

const PRIVATE_HOSTS = new Set(['app.posthog.com', 'eu.posthog.com', 'localhost', 'us.posthog.com'])

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '').toLowerCase()
}

function isNonPublicIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return true
  }
  const [first = 0, second = 0] = octets

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && [0, 2, 168].includes(second)) ||
    (first === 198 && [18, 19, 51].includes(second)) ||
    (first === 203 && second === 0) ||
    first >= 224
  )
}

function isNonPublicIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('::ffff:')) {
    return true
  }

  const firstHextet = Number.parseInt(normalized.split(':')[0] ?? '', 16)
  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
    (firstHextet >= 0xff00 && firstHextet <= 0xffff) ||
    normalized.startsWith('2001:db8:')
  )
}

function isPrivateOrReservedHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (
    PRIVATE_HOSTS.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true
  }

  const ipVersion = isIP(normalized)
  return ipVersion === 4
    ? isNonPublicIpv4(normalized)
    : ipVersion === 6
      ? isNonPublicIpv6(normalized)
      : false
}

export const PublicCitationUriSchema = z.string().superRefine((value, context) => {
  if (!value.startsWith('https://')) {
    const parsed = RepoRelativeUriSchema.safeParse(value)
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        message: 'Public URI must be repository-relative or HTTPS',
      })
    }
    return
  }

  const url = parseHttpsUri(value)
  if (
    !url ||
    url.search.length > 0 ||
    url.port.length > 0 ||
    isPrivateOrReservedHost(url.hostname)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Public URI cannot expose a private or credentialed location',
    })
  }
})

export const PublicSafeTextSchema = z
  .string()
  .min(1)
  .max(320)
  .superRefine((value, context) => {
    if (scrubForPublication(value).findings.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Public text contains private or credential-like data',
      })
    }
  })

function canonicalizeValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`).join(',')}}`
  }
  throw new TypeError('Only JSON-compatible values can be canonicalized')
}

export function canonicalJson(value: unknown): string {
  return canonicalizeValue(value)
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
