import { describe, expect, it, vi } from 'vitest'
import {
  ProductApiError,
  answerClarification,
  cancelMission,
  createMission,
  decideApproval,
  pollMissionProgress,
  pollMissionTasks,
  type ProductSession,
} from './product-api'

const session = { csrfToken: 'csrf_test' } satisfies ProductSession

describe('TrashPal product API', () => {
  it('creates Scheduled Hauler Access as a mission, not as an approval', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          result: 'created',
          mission: {
            id: 'mis_hauler',
            palaceId: 'pal_sacred_dumpster',
            state: { status: 'queued' },
            version: 0,
          },
        }),
      )

    await expect(
      createMission('scheduled_hauler_access', 'hauler_request_01', 'pal_test_workspace', request),
    ).resolves.toMatchObject({
      mission: { id: 'mis_hauler', state: { status: 'queued' } },
    })

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/auth/dev-session',
      '/api/v1/missions',
    ])
    const body = request.mock.calls[1]?.[1]?.body
    if (typeof body !== 'string') throw new Error('Mission request body was not serialized JSON')
    expect(JSON.parse(body)).toMatchObject({
      palaceId: 'pal_test_workspace',
      constraints: { serviceHatchOnly: true },
    })
  })

  it('reuses an already-issued browser session instead of replacing its CSRF token', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        result: 'created',
        mission: {
          id: 'mis_hauler',
          palaceId: 'pal_sacred_dumpster',
          state: { status: 'queued' },
          version: 0,
        },
      }),
    )

    await createMission(
      'scheduled_hauler_access',
      'hauler_request_02',
      'pal_test_workspace',
      undefined,
      request,
      session,
    )

    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/v1/missions'])
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-csrf-token': 'csrf_test' })
  })

  it('uses the same idempotency key only when a caller explicitly replays a lost create response', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockRejectedValueOnce(new TypeError('network lost'))

    const error = await createMission(
      'scheduled_hauler_access',
      'hauler_request_01',
      'pal_test_workspace',
      request,
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ProductApiError)
    expect((error as ProductApiError).outcome).toBe('unknown')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('serializes only the selected program’s bounded settings', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          result: 'created',
          mission: {
            id: 'mis_homecoming',
            palaceId: 'pal_test_workspace',
            state: { status: 'queued' },
            version: 0,
          },
        }),
      )

    await createMission(
      'night_shift_homecoming',
      'homecoming_request_02',
      'pal_test_workspace',
      {
        kind: 'night_shift_homecoming',
        preheatBy: '01:30',
        projectedBatteryUseMaxPercentagePoints: 12,
      },
      request,
    )

    expect(parseJsonRequestBody(request.mock.calls[1]?.[1]?.body)).toMatchObject({
      objective:
        'Prepare the Palace by 01:30, light the path only after verified arrival, keep projected battery use within 12 percentage points, and never unlock for an unverified identity.',
      constraints: {
        preheatBy: '01:30',
        projectedBatteryUseMaxPercentagePoints: 12,
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
      },
    })
  })

  it('polls the task inbox with a bounded, abortable wait and stops when approval is real', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          mission: { id: 'mis_hauler', state: { status: 'understand' }, version: 1 },
          clarification: null,
          approval: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          mission: { id: 'mis_hauler', state: { status: 'awaiting_human' }, version: 2 },
          clarification: null,
          approval: {
            id: 'apr_hauler',
            planId: 'pln_hauler',
            status: 'pending',
            expiresAt: '2026-07-16T12:00:00.000Z',
          },
        }),
      )
    const wait = vi.fn(async () => undefined)

    await expect(
      pollMissionTasks('mis_hauler', { request, wait, delayMilliseconds: 1, maxAttempts: 3 }),
    ).resolves.toMatchObject({ approval: { id: 'apr_hauler' } })

    expect(wait).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('stops progress polling at checking_result instead of claiming a verified outcome', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(progressResponse('working'))
      .mockResolvedValueOnce(progressResponse('checking_result'))
    const wait = vi.fn(async () => undefined)

    await expect(
      pollMissionProgress('mis_hauler', {
        request,
        wait,
        delayMilliseconds: 1,
        maxAttempts: 3,
      }),
    ).resolves.toMatchObject({ displayState: 'checking_result', verification: null })

    expect(wait).toHaveBeenCalledOnce()
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/missions/mis_hauler/progress',
      '/api/v1/missions/mis_hauler/progress',
    ])
  })

  it('posts the stored approval nonce to the decision endpoint', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        decision: 'approved',
        approval: { id: 'apr_hauler', status: 'approved' },
        operations: [{ id: 'op_hauler', status: 'pending' }],
        mission: { id: 'mis_hauler', state: { status: 'execute' } },
      }),
    )

    await expect(
      decideApproval(
        {
          approvalId: 'apr_hauler',
          nonce: 'nonce_01234567890123456789',
          decision: 'approve',
          session,
        },
        request,
      ),
    ).resolves.toMatchObject({ decision: 'approved', operations: [{ id: 'op_hauler' }] })

    expect(request.mock.calls[0]?.[0]).toBe('/api/v1/approvals/apr_hauler/decision')
    expect(parseJsonRequestBody(request.mock.calls[0]?.[1]?.body)).toEqual({
      nonce: 'nonce_01234567890123456789',
      decision: 'approve',
    })
  })

  it('keeps a lost approval decision response explicitly unknown for reconciliation', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network lost'))

    const error = await decideApproval(
      {
        approvalId: 'apr_hauler',
        nonce: 'nonce_01234567890123456789',
        decision: 'reject',
        session,
      },
      request,
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ProductApiError)
    expect((error as ProductApiError).outcome).toBe('unknown')
  })

  it('answers a server-supplied clarification at its observed mission version', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        result: 'answered',
        request: { id: 'clr_hauler', status: 'answered' },
        answer: { choiceId: 'energy_first' },
        mission: { id: 'mis_hauler', state: { status: 'understand' }, version: 3 },
      }),
    )

    await expect(
      answerClarification(
        {
          requestId: 'clr_hauler',
          choiceId: 'energy_first',
          expectedMissionVersion: 2,
          session,
        },
        request,
      ),
    ).resolves.toMatchObject({ mission: { id: 'mis_hauler', version: 3 } })

    expect(request.mock.calls[0]?.[0]).toBe('/api/v1/clarifications/clr_hauler/answer')
    expect(parseJsonRequestBody(request.mock.calls[0]?.[1]?.body)).toEqual({
      choiceId: 'energy_first',
      expectedMissionVersion: 2,
    })
  })

  it('keeps a lost clarification-answer response explicitly unknown for reconciliation', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network lost'))

    const error = await answerClarification(
      {
        requestId: 'clr_hauler',
        choiceId: 'energy_first',
        expectedMissionVersion: 2,
        session,
      },
      request,
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ProductApiError)
    expect((error as ProductApiError).outcome).toBe('unknown')
  })

  it('uses the authenticated, idempotent cancellation tool instead of a browser-only state change', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        schemaVersion: 'tool-result@1',
        toolName: 'missions.cancel',
        callId: 'call_cancel_test_001',
        status: 'pending',
        retryable: true,
        receiptId: 'rcp_cancel_test_001',
        resourceVersion: 2,
        error: null,
        data: { missionId: 'mis_hauler', state: { status: 'cancelling', phase: 'reconcile' } },
      }),
    )

    await expect(
      cancelMission({ missionId: 'mis_hauler', session, callId: 'call_cancel_test_001' }, request),
    ).resolves.toMatchObject({ status: 'pending', mission: { id: 'mis_hauler' } })

    expect(request.mock.calls[0]?.[0]).toBe('/api/v1/tools/missions.cancel')
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-csrf-token': 'csrf_test',
      'idempotency-key': 'call_cancel_test_001',
      'x-trash-palace-mission': 'mis_hauler',
    })
    expect(parseJsonRequestBody(request.mock.calls[0]?.[1]?.body)).toMatchObject({
      missionId: 'mis_hauler',
    })
  })
})

function sessionResponse() {
  return jsonResponse({ session })
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function parseJsonRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON string request body')
  return JSON.parse(body) as unknown
}

function progressResponse(displayState: 'working' | 'checking_result') {
  return jsonResponse({
    schemaVersion: 'mission-progress@1',
    mission: {
      id: 'mis_hauler',
      palaceId: 'pal_test_workspace',
      organizationId: 'org_test_workspace',
      programKind: 'scheduled_hauler_access',
      objective: 'Allow the assigned collection team to use only the service hatch.',
      state: {
        status: displayState === 'working' ? 'running' : 'waiting_for_system',
        phase: displayState === 'working' ? 'plan' : 'observe',
      },
      version: 2,
    },
    displayState,
    pendingTask: null,
    operation: null,
    verification: null,
    allowedNextActions: ['view_activity'],
    observedAt: '2026-07-16T12:00:00.000Z',
  })
}
