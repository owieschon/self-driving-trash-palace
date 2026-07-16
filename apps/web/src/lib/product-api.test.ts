import { describe, expect, it, vi } from 'vitest'
import { activateAutomation, ProductApiError } from './product-api'

describe('TrashPal product API', () => {
  it('uses the authenticated mission route for Scheduled Hauler Access', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { csrfToken: 'csrf_test' } }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mission: { id: 'mis_test', state: { status: 'queued' } } }), {
          status: 201,
        }),
      )
    await expect(
      activateAutomation('scheduled_hauler_access', 'hauler_request_01', request),
    ).resolves.toMatchObject({ mission: { id: 'mis_test' } })
    const body = request.mock.calls[1]?.[1]?.body
    if (typeof body !== 'string') throw new Error('Mission request body was not serialized JSON')
    const payload = JSON.parse(body) as { constraints: Record<string, unknown> }
    expect(payload).toMatchObject({
      constraints: { serviceHatchOnly: true },
    })
  })

  it('scopes a Homecoming approval to the reviewed Homecoming contract', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { csrfToken: 'csrf_test' } }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mission: { id: 'mis_test', state: { status: 'queued' } } }), {
          status: 201,
        }),
      )

    await activateAutomation('night_shift_homecoming', 'homecoming_request_01', request)

    const body = request.mock.calls[1]?.[1]?.body
    if (typeof body !== 'string') throw new Error('Mission request body was not serialized JSON')
    const payload = JSON.parse(body) as { constraints: Record<string, unknown> }
    expect(payload).toMatchObject({
      constraints: {
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
      },
    })
    expect(payload.constraints).not.toHaveProperty('serviceHatchOnly')
  })

  it('classifies a lost response as unknown and never retries', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { csrfToken: 'csrf_test' } }), { status: 201 }),
      )
      .mockRejectedValueOnce(new TypeError('network lost'))
    const error = await activateAutomation(
      'scheduled_hauler_access',
      'hauler_request_01',
      request,
    ).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ProductApiError)
    expect((error as ProductApiError).outcome).toBe('unknown')
    expect(request).toHaveBeenCalledTimes(2)
  })
})
