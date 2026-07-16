import {
  ApplicationError,
  ConflictError,
  NotFoundError,
  OptimisticConcurrencyError,
  type CallbackIngestionResult,
  type IdentityTelemetryIngestionResult,
} from '@trash-palace/application'
import { z } from 'zod'

import {
  HttpBoundaryError,
  assertNoQuery,
  jsonResponse,
  problemResponse,
  readStrictJson,
} from './http-boundary.js'

export interface InternalIngressDependencies {
  readonly callbacks: { ingest(raw: unknown): Promise<CallbackIngestionResult> }
  readonly identityTelemetry: { ingest(raw: unknown): Promise<IdentityTelemetryIngestionResult> }
}

export interface InternalIngressRoutes {
  readonly ingestGatewayCallback: (request: Request) => Promise<Response>
  readonly ingestIdentityTelemetry: (request: Request) => Promise<Response>
}

/** Signature verifiers inside the application services are the authentication boundary. */
export function createInternalIngressRoutes(
  dependencies: InternalIngressDependencies,
): InternalIngressRoutes {
  return {
    ingestGatewayCallback: (request) =>
      boundary(async () => {
        assertNoQuery(request)
        const result = await dependencies.callbacks.ingest(await readStrictJson(request))
        return jsonResponse(
          {
            status: result.status,
            callbackId: result.callback.id,
            mission: { id: result.mission.id, state: result.mission.state },
            execution:
              result.execution === null
                ? null
                : { id: result.execution.id, status: result.execution.status },
          },
          { status: result.status === 'stored' ? 202 : 200 },
        )
      }),
    ingestIdentityTelemetry: (request) =>
      boundary(async () => {
        assertNoQuery(request)
        const result = await dependencies.identityTelemetry.ingest(await readStrictJson(request))
        return jsonResponse(
          {
            status: result.status,
            providerEventId: result.event.providerEventId,
            missionId: result.event.missionId,
            evidenceId: result.record.evidence.id,
            identityVerified: result.provenance.identityVerified,
          },
          { status: result.status === 'stored' ? 202 : 200 },
        )
      }),
  }
}

function boundary(work: () => Promise<Response>): Promise<Response> {
  return work().catch((error: unknown) => problemResponse(mapError(error)))
}

function mapError(error: unknown): unknown {
  if (error instanceof HttpBoundaryError) return error
  if (isOptimisticConcurrencyError(error)) {
    return new HttpBoundaryError(
      503,
      'CONCURRENT_UPDATE',
      'Ingress could not be recorded during a concurrent state change. Retry the same envelope.',
    )
  }
  if (error instanceof NotFoundError) {
    return new HttpBoundaryError(404, 'NOT_FOUND', 'The referenced resource is unavailable.')
  }
  if (error instanceof ConflictError) {
    return new HttpBoundaryError(409, 'CONFLICT', 'Ingress conflicts with durable state.')
  }
  if (error instanceof z.ZodError || error instanceof RangeError) {
    return new HttpBoundaryError(422, 'INVALID_INGRESS', 'The signed ingress is invalid.')
  }
  if (error instanceof ApplicationError || hasVerifierCode(error)) {
    return new HttpBoundaryError(
      401,
      'INGRESS_AUTHENTICATION_FAILED',
      'Signature verification failed.',
    )
  }
  return error
}

function isOptimisticConcurrencyError(error: unknown): boolean {
  return (
    error instanceof OptimisticConcurrencyError ||
    (error instanceof Error && error.name === 'OptimisticConcurrencyError')
  )
}

function hasVerifierCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /(?:SIGNATURE|PRINCIPAL|KEY|ENVELOPE|TENANT|NONCE)/.test(error.code)
  )
}
