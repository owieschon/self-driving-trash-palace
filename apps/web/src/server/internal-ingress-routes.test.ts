import { describe, expect, it, vi } from 'vitest'

import { OptimisticConcurrencyError } from '@trash-palace/application'

import {
  createInternalIngressRoutes,
  type InternalIngressDependencies,
} from './internal-ingress-routes.js'

const ORIGIN = 'http://web:3000'

function request(path: string, body: unknown, contentType = 'application/json'): Request {
  return new Request(new URL(path, ORIGIN), {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  })
}

describe('signed internal ingress routes', () => {
  it('projects a stored callback without reflecting the signed envelope', async () => {
    const callbacks = vi
      .fn<InternalIngressDependencies['callbacks']['ingest']>()
      .mockResolvedValue({
        status: 'stored',
        callback: { id: 'gcb_callback_0001' },
        mission: {
          id: 'mis_ingress_0001',
          state: { status: 'waiting_for_system', phase: 'observe' },
        },
        execution: null,
      } as never)
    const routes = createInternalIngressRoutes({
      callbacks: { ingest: callbacks },
      identityTelemetry: { ingest: vi.fn() },
    })
    const response = await routes.ingestGatewayCallback(
      request('/api/internal/v1/gateway/callbacks', { signature: 'private-signed-envelope' }),
    )

    expect(response.status).toBe(202)
    expect(callbacks).toHaveBeenCalledWith({ signature: 'private-signed-envelope' })
    const body = await response.text()
    expect(body).not.toContain('private-signed-envelope')
    expect(JSON.parse(body)).toEqual({
      status: 'stored',
      callbackId: 'gcb_callback_0001',
      mission: {
        id: 'mis_ingress_0001',
        state: { status: 'waiting_for_system', phase: 'observe' },
      },
      execution: null,
    })
  })

  it('projects duplicate identity telemetry as an idempotent success', async () => {
    const identityTelemetry = vi
      .fn<InternalIngressDependencies['identityTelemetry']['ingest']>()
      .mockResolvedValue({
        status: 'duplicate',
        event: { providerEventId: 'idt_provider_0001', missionId: 'mis_ingress_0001' },
        record: { evidence: { id: 'evd_ingress_0001' } },
        provenance: { identityVerified: true },
      } as never)
    const routes = createInternalIngressRoutes({
      callbacks: { ingest: vi.fn() },
      identityTelemetry: { ingest: identityTelemetry },
    })
    const response = await routes.ingestIdentityTelemetry(
      request('/api/internal/v1/identity/telemetry', { event: {}, signature: {} }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'duplicate',
      providerEventId: 'idt_provider_0001',
      missionId: 'mis_ingress_0001',
      evidenceId: 'evd_ingress_0001',
      identityVerified: true,
    })
  })

  it('fails closed before application ingress on media and signature errors', async () => {
    const callbacks = vi.fn<InternalIngressDependencies['callbacks']['ingest']>()
    const routes = createInternalIngressRoutes({
      callbacks: { ingest: callbacks },
      identityTelemetry: {
        ingest: vi.fn().mockRejectedValue({ code: 'SIGNATURE_MISMATCH', secret: 'do-not-echo' }),
      },
    })

    const media = await routes.ingestGatewayCallback(
      request('/api/internal/v1/gateway/callbacks', {}, 'text/plain'),
    )
    const signature = await routes.ingestIdentityTelemetry(
      request('/api/internal/v1/identity/telemetry', {}),
    )

    expect(media.status).toBe(415)
    expect(callbacks).not.toHaveBeenCalled()
    expect(signature.status).toBe(401)
    expect(await signature.text()).not.toContain('do-not-echo')
  })

  it('marks serialization conflicts as retryable for bounded gateway delivery', async () => {
    const routes = createInternalIngressRoutes({
      callbacks: {
        ingest: vi
          .fn<InternalIngressDependencies['callbacks']['ingest']>()
          .mockRejectedValue(new OptimisticConcurrencyError('Concurrent callback state changed')),
      },
      identityTelemetry: { ingest: vi.fn() },
    })

    const response = await routes.ingestGatewayCallback(
      request('/api/internal/v1/gateway/callbacks', { signature: 'private-signed-envelope' }),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: 'CONCURRENT_UPDATE',
    })
  })
})
