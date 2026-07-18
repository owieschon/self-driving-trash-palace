import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { SmartThingsWebhookRequest } from '../ports.js'
import { SmartThingsWebhookSignatureVerifier } from '../smartthings-webhook-verifier.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PUBLIC_KEY = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const KEY_ID = '/pl/useast1/trashpal-test-key'

function signedRequest(
  overrides: Partial<SmartThingsWebhookRequest> = {},
): SmartThingsWebhookRequest {
  const rawBody = overrides.rawBody ?? JSON.stringify({ messageType: 'EVENT' })
  const digest =
    overrides.digest ?? `SHA256=${createHash('sha256').update(rawBody).digest('base64')}`
  const request = {
    method: 'POST' as const,
    path: '/integrations/smartthings/webhook',
    date: 'Wed, 15 Jul 2026 12:00:00 GMT',
    rawBody,
    digest,
    ...overrides,
  }
  const signingString = `(request-target): post ${request.path}\ndigest: ${request.digest}\ndate: ${request.date}`
  const signature = sign('RSA-SHA256', Buffer.from(signingString), privateKey).toString('base64')
  return {
    ...request,
    authorization: `Signature keyId="${KEY_ID}",signature="${signature}",headers="(request-target) digest date",algorithm="rsa-sha256"`,
  }
}

describe('SmartThingsWebhookSignatureVerifier', () => {
  it('validates the provider digest and RSA HTTP signature using a fixed key origin', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(PUBLIC_KEY))
    const verifier = new SmartThingsWebhookSignatureVerifier({
      fetch: fetchMock,
      now: () => new Date('2026-07-15T12:00:00Z'),
    })

    await expect(verifier.verify(signedRequest())).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `https://key.smartthings.com/key${KEY_ID}`,
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('rejects a body changed after signing before it accepts the callback', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(PUBLIC_KEY))
    const verifier = new SmartThingsWebhookSignatureVerifier({
      fetch: fetchMock,
      now: () => new Date('2026-07-15T12:00:00Z'),
    })
    const request = signedRequest()

    await expect(
      verifier.verify({ ...request, rawBody: '{"messageType":"ALTERED"}' }),
    ).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a key identifier that could change the trusted key origin', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const verifier = new SmartThingsWebhookSignatureVerifier({
      fetch: fetchMock,
      now: () => new Date('2026-07-15T12:00:00Z'),
    })
    const request = signedRequest().authorization.replace(KEY_ID, '/../../outside')

    await expect(verifier.verify({ ...signedRequest(), authorization: request })).resolves.toBe(
      false,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a valid signature outside the replay window', async () => {
    const verifier = new SmartThingsWebhookSignatureVerifier({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(PUBLIC_KEY)),
      now: () => new Date('2026-07-15T12:10:00Z'),
    })

    await expect(verifier.verify(signedRequest())).resolves.toBe(false)
  })

  it('rejects an unparseable signed date', async () => {
    const verifier = new SmartThingsWebhookSignatureVerifier({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(PUBLIC_KEY)),
      now: () => new Date('2026-07-15T12:00:00Z'),
    })

    await expect(verifier.verify(signedRequest({ date: 'not-a-date' }))).resolves.toBe(false)
  })
})
