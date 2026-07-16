import { createHash, randomBytes } from 'node:crypto'

import { Sha256Schema, type Sha256 } from '@trash-palace/core'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(',')}}`
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`)
}

export function hashCanonical(value: unknown): Sha256 {
  return Sha256Schema.parse(createHash('sha256').update(canonicalJson(value)).digest('hex'))
}

export function hashSecret(secret: string): Sha256 {
  if (secret.length < 24) throw new TypeError('Secrets must contain at least 24 characters')
  return Sha256Schema.parse(createHash('sha256').update(secret).digest('hex'))
}

export function createDatabaseId(prefix: string): string {
  if (!/^[a-z][a-z0-9]{1,7}$/.test(prefix)) throw new TypeError('Invalid identifier prefix')
  return `${prefix}_${randomBytes(16).toString('hex')}`
}
