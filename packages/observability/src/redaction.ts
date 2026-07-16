import type { JsonValue } from './canonical.js'

export type RedactionReason =
  | 'credential'
  | 'email'
  | 'home_path'
  | 'oversize_text'
  | 'private_field'
  | 'private_identifier'
  | 'private_posthog_link'
  | 'prompt_content'
  | 'unsupported_value'

export interface RedactionFinding {
  readonly path: string
  readonly reason: RedactionReason
}

export interface PublicationScrubResult {
  readonly value: JsonValue
  readonly findings: readonly RedactionFinding[]
  readonly counts: Readonly<Record<RedactionReason, number>>
}

const OMIT = Symbol('omit')
const MAX_DEPTH = 24
const MAX_PUBLIC_STRING_LENGTH = 2_048

const PROMPT_FIELDS = new Set([
  'ai_input',
  'ai_output',
  'ai_output_choices',
  'chain_of_thought',
  'completion',
  'conversation',
  'input',
  'messages',
  'model_input',
  'model_output',
  'output',
  'prompt',
  'raw_prompt',
  'reasoning',
  'request_body',
  'response',
  'response_body',
  'system_prompt',
  'transcript',
  'user_prompt',
])

const CREDENTIAL_FIELDS = new Set([
  'api_key',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'password',
  'private_key',
  'secret',
  'session_cookie',
  'token',
])

const PRIVATE_IDENTIFIER_FIELDS = new Set([
  'actor_id',
  'attempt_id',
  'browser_session_id',
  'distinct_id',
  'email',
  'execution_id',
  'mission_id',
  'operation_id',
  'organization_id',
  'palace_id',
  'plan_id',
  'resource_id',
  'run_id',
  'session_id',
  'span_id',
  'trace_id',
  'user_id',
])

const STRING_PATTERNS: readonly {
  readonly pattern: RegExp
  readonly reason: RedactionReason
  readonly replacement: string
}[] = [
  {
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    reason: 'credential',
    replacement: '[REDACTED:CREDENTIAL]',
  },
  {
    pattern:
      /\b(?:ph[ctx]_[A-Za-z0-9_-]{12,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/g,
    reason: 'credential',
    replacement: '[REDACTED:CREDENTIAL]',
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    reason: 'credential',
    replacement: '[REDACTED:CREDENTIAL]',
  },
  {
    pattern: /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;"']{6,}/gi,
    reason: 'credential',
    replacement: '[REDACTED:CREDENTIAL]',
  },
  {
    pattern: /\/(?:Users|home)\/[^/\s"'`]+(?:\/[^\s"'`]+)*/g,
    reason: 'home_path',
    replacement: '[REDACTED:HOME_PATH]',
  },
  {
    pattern: /[A-Za-z]:\\Users\\[^\\\s"']+(?:\\[^\s"']+)*/g,
    reason: 'home_path',
    replacement: '[REDACTED:HOME_PATH]',
  },
  {
    pattern: /https:\/\/(?:app|us|eu)\.posthog\.com\/(?:project|environment)\/[^\s"')]+/gi,
    reason: 'private_posthog_link',
    replacement: '[REDACTED:PRIVATE_POSTHOG_LINK]',
  },
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    reason: 'email',
    replacement: '[REDACTED:EMAIL]',
  },
  {
    pattern:
      /\b(?:act|actor|ais|ait|apr|att|attempt|call|cap|crew|ctx|dev|evd|event|exe|execution|gcb|gcmd|mem|mev|mis|mission|op|operation|org|pal|palace|plan|pln|rcp|resource|rtn|rtv|run|tag|user|usr|ver)_[A-Za-z0-9_-]{6,}\b/g,
    reason: 'private_identifier',
    replacement: '[REDACTED:PRIVATE_ID]',
  },
  {
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    reason: 'private_identifier',
    replacement: '[REDACTED:PRIVATE_ID]',
  },
]

function normalizeFieldName(field: string): string {
  return field
    .replace(/^\$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

function fieldReason(field: string): RedactionReason | undefined {
  const normalized = normalizeFieldName(field)
  if (
    PROMPT_FIELDS.has(normalized) ||
    normalized.endsWith('_prompt') ||
    normalized.endsWith('_transcript')
  ) {
    return 'prompt_content'
  }
  if (CREDENTIAL_FIELDS.has(normalized)) {
    return 'credential'
  }
  if (PRIVATE_IDENTIFIER_FIELDS.has(normalized) || normalized.endsWith('_private_id')) {
    return 'private_field'
  }
  return undefined
}

function emptyCounts(): Record<RedactionReason, number> {
  return {
    credential: 0,
    email: 0,
    home_path: 0,
    oversize_text: 0,
    private_field: 0,
    private_identifier: 0,
    private_posthog_link: 0,
    prompt_content: 0,
    unsupported_value: 0,
  }
}

export function scrubForPublication(input: unknown): PublicationScrubResult {
  const findings: RedactionFinding[] = []

  function record(path: string, reason: RedactionReason): void {
    findings.push({ path, reason })
  }

  function scrubString(inputValue: string, path: string): string {
    let value = inputValue
    for (const { pattern, reason, replacement } of STRING_PATTERNS) {
      value = value.replace(pattern, () => {
        record(path, reason)
        return replacement
      })
    }

    if (value.length > MAX_PUBLIC_STRING_LENGTH) {
      record(path, 'oversize_text')
      return `${value.slice(0, MAX_PUBLIC_STRING_LENGTH)}[TRUNCATED]`
    }

    return value
  }

  function visit(value: unknown, path: string, depth: number): JsonValue | typeof OMIT {
    if (depth > MAX_DEPTH) {
      record(path, 'unsupported_value')
      return '[REDACTED:MAX_DEPTH]'
    }

    if (value === null || typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'string') {
      return scrubString(value, path)
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        return value
      }
      record(path, 'unsupported_value')
      return '[REDACTED:NON_FINITE_NUMBER]'
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        const nested = visit(item, `${path}[${index}]`, depth + 1)
        return nested === OMIT ? null : nested
      })
    }
    if (value instanceof Date) {
      return value.toISOString()
    }
    if (typeof value === 'object') {
      const output: Record<string, JsonValue> = {}
      for (const [key, nestedValue] of Object.entries(value)) {
        const nestedPath = path === '$' ? `$.${key}` : `${path}.${key}`
        const reason = fieldReason(key)
        if (reason !== undefined) {
          record(nestedPath, reason)
          continue
        }
        const nested = visit(nestedValue, nestedPath, depth + 1)
        if (nested !== OMIT) {
          output[key] = nested
        }
      }
      return output
    }

    record(path, 'unsupported_value')
    return OMIT
  }

  const scrubbed = visit(input, '$', 0)
  const counts = emptyCounts()
  for (const finding of findings) {
    counts[finding.reason] += 1
  }

  return {
    value: scrubbed === OMIT ? null : scrubbed,
    findings,
    counts,
  }
}

export class UnsafePublicationError extends Error {
  public readonly findings: readonly RedactionFinding[]

  public constructor(findings: readonly RedactionFinding[]) {
    super(`Publication payload contains ${findings.length} unsafe value(s)`)
    this.name = 'UnsafePublicationError'
    this.findings = findings
  }
}

export function assertPublicationSafe(input: unknown): void {
  const { findings } = scrubForPublication(input)
  if (findings.length > 0) {
    throw new UnsafePublicationError(findings)
  }
}
