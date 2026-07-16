import { describe, expect, it } from 'vitest'

import {
  HttpBoundaryError,
  MAX_JSON_BODY_BYTES,
  SESSION_COOKIE_NAME,
  assertMutationOrigin,
  jsonResponse,
  problemResponse,
  readPresentedCredential,
  readStrictJson,
  readToolInvocationHeaders,
} from './http-boundary.js'

const session = 'signed.session.value_1234567890'
const bearer = 'delegated.token.value_1234567890'

describe('HTTP JSON boundary', () => {
  it('accepts strict JSON and rejects unsupported, malformed, and oversized bodies safely', async () => {
    await expect(readStrictJson(request('{"ok":true}'))).resolves.toEqual({ ok: true })
    await expect(readStrictJson(request('{}', 'text/plain'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
    })
    await expect(readStrictJson(request('{"private":"unterminated"'))).rejects.toMatchObject({
      code: 'INVALID_JSON',
      message: 'Request body contains invalid JSON.',
    })
    await expect(
      readStrictJson(request(JSON.stringify({ value: 'x'.repeat(MAX_JSON_BODY_BYTES) }))),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 })
  })

  it('rejects a declared oversized body before reading it', async () => {
    const headers = new Headers({
      'content-length': String(MAX_JSON_BODY_BYTES + 1),
      'content-type': 'application/json',
    })
    const input = new Request('http://trash-palace.local/api/v1/tools/palaces.get', {
      method: 'POST',
      headers,
      body: '{}',
    })

    await expect(readStrictJson(input)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' })
  })
})

describe('HTTP authentication boundary', () => {
  it('accepts exactly one session or bearer mechanism', () => {
    expect(
      readPresentedCredential(new Headers({ cookie: `${SESSION_COOKIE_NAME}=${session}` })),
    ).toEqual({ kind: 'session', value: session })
    expect(readPresentedCredential(new Headers({ authorization: `Bearer ${bearer}` }))).toEqual({
      kind: 'bearer',
      value: bearer,
    })
    expect(() =>
      readPresentedCredential(
        new Headers({
          authorization: `Bearer ${bearer}`,
          cookie: `${SESSION_COOKIE_NAME}=${session}`,
        }),
      ),
    ).toThrow(/exactly one authentication/i)
  })

  it('rejects duplicate cookies, malformed bearer values, and missing credentials', () => {
    expect(() =>
      readPresentedCredential(
        new Headers({
          cookie: `${SESSION_COOKIE_NAME}=${session}; ${SESSION_COOKIE_NAME}=${session}`,
        }),
      ),
    ).toThrow(HttpBoundaryError)
    expect(() => readPresentedCredential(new Headers({ authorization: 'Bearer short' }))).toThrow(
      /invalid/i,
    )
    expect(() => readPresentedCredential(new Headers())).toThrow(/required/i)
  })

  it('requires valid host-bound call and mission identifiers', () => {
    expect(
      readToolInvocationHeaders(
        new Headers({
          'idempotency-key': 'call_http_request_01',
          'x-trash-palace-mission': 'mis_http_mission_01',
        }),
      ),
    ).toEqual({ callId: 'call_http_request_01', missionId: 'mis_http_mission_01' })
    expect(() => readToolInvocationHeaders(new Headers())).toThrow(HttpBoundaryError)
  })

  it('checks both same-origin and CSRF state without echoing either value', () => {
    expect(() =>
      assertMutationOrigin({
        headers: new Headers({ origin: 'https://hostile.example', 'x-csrf-token': 'hostile' }),
        allowedOrigin: 'http://trash-palace.local',
        csrfToken: 'expected-csrf-token-value',
      }),
    ).toThrow('Mutation authentication is invalid.')
  })
})

describe('HTTP response boundary', () => {
  it('adds no-store and browser hardening headers', async () => {
    const response = jsonResponse({ status: 'ok' }, { status: 200 })

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('maps unknown exceptions to a stable problem without leaking their message', async () => {
    const response = problemResponse(new Error('private hostile payload'))

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
    const body = await response.text()
    expect(body).not.toContain('private hostile payload')
    expect(JSON.parse(body)).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 })
  })
})

function request(body: string, contentType = 'application/json'): Request {
  return new Request('http://trash-palace.local/api/v1/tools/palaces.get', {
    body,
    headers: { 'content-type': contentType },
    method: 'POST',
  })
}
