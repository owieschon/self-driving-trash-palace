import { describe, expect, it } from 'vitest'

import { TrashPalaceApiError } from './api-client.js'

describe('TrashPalaceApiError', () => {
  it('uses the public TrashPal name in an API failure', () => {
    const error = new TrashPalaceApiError(503, { code: 'UNAVAILABLE' })

    expect(error).toMatchObject({
      name: 'TrashPalaceApiError',
      message: 'TrashPal API request failed with status 503',
    })
  })
})
