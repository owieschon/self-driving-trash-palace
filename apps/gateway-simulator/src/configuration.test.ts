import { describe, expect, it } from 'vitest'

import { parseGatewaySimulatorConfiguration } from './configuration.js'

const KEY = 'local-gateway-signing-key-at-least-32-bytes'
const IDENTITY_KEY = 'local-identity-signing-key-at-least-32-bytes'
const BASE_ENVIRONMENT = {
  GATEWAY_CALLBACK_SIGNING_KEY: KEY,
  IDENTITY_TELEMETRY_SIGNING_KEY_ID: 'itk_local_identity',
  IDENTITY_TELEMETRY_SIGNING_KEY: IDENTITY_KEY,
} as const

describe('gateway simulator configuration', () => {
  it('parses a complete, bounded configuration without accepting a callback URL', () => {
    expect(
      parseGatewaySimulatorConfiguration({
        ...BASE_ENVIRONMENT,
        GATEWAY_CALLBACK_MAX_ATTEMPTS: '5',
        GATEWAY_CALLBACK_INITIAL_BACKOFF_MS: '20',
        GATEWAY_CALLBACK_MAX_BACKOFF_MS: '160',
        GATEWAY_SHUTDOWN_TIMEOUT_MS: '11000',
      }),
    ).toEqual({
      bindHost: '0.0.0.0',
      port: 4319,
      faultProfile: { kind: 'none' },
      signingKeyId: 'gwk_local_gateway_2026',
      signingKey: KEY,
      identitySigningKeyId: 'itk_local_identity',
      identitySigningKey: IDENTITY_KEY,
      callbackDelivery: {
        maximumAttempts: 5,
        initialBackoffMilliseconds: 20,
        maximumBackoffMilliseconds: 160,
        requestTimeoutMilliseconds: 2_000,
        readinessIntervalMilliseconds: 1_000,
        maximumTrackedCallbacks: 512,
      },
      identityDelivery: {
        maximumAttempts: 4,
        initialBackoffMilliseconds: 100,
        maximumBackoffMilliseconds: 2_000,
        requestTimeoutMilliseconds: 2_000,
        readinessIntervalMilliseconds: 1_000,
        maximumTrackedEvents: 128,
      },
      clock: { mode: 'immediate' },
      shutdownTimeoutMilliseconds: 11_000,
    })
  })

  it('requires the shared fixture anchor only for the production parser mode', () => {
    expect(
      parseGatewaySimulatorConfiguration(
        {
          ...BASE_ENVIRONMENT,
          TRASH_PALACE_FIXTURE_REAL_START_AT: '2026-07-15T12:00:00.000Z',
        },
        { requireSharedFixtureStart: true },
      ).clock,
    ).toEqual({ mode: 'anchored', realStartAt: '2026-07-15T12:00:00.000Z' })
    expect(() =>
      parseGatewaySimulatorConfiguration(BASE_ENVIRONMENT, { requireSharedFixtureStart: true }),
    ).toThrow('TRASH_PALACE_FIXTURE_REAL_START_AT')
  })

  it('requires independent callback and identity signing keys', () => {
    expect(() =>
      parseGatewaySimulatorConfiguration({
        ...BASE_ENVIRONMENT,
        IDENTITY_TELEMETRY_SIGNING_KEY: KEY,
      }),
    ).toThrow('IDENTITY_TELEMETRY_SIGNING_KEY')
  })

  it('enables lost-ack injection only behind explicit lab mode', () => {
    expect(() =>
      parseGatewaySimulatorConfiguration({
        ...BASE_ENVIRONMENT,
        GATEWAY_SIMULATOR_FAULT_PROFILE: 'lost_ack',
      }),
    ).toThrow('GATEWAY_SIMULATOR_FAULT_PROFILE')

    expect(
      parseGatewaySimulatorConfiguration({
        ...BASE_ENVIRONMENT,
        GATEWAY_SIMULATOR_LAB_MODE: 'true',
        GATEWAY_SIMULATOR_FAULT_PROFILE: 'lost_ack',
      }).faultProfile,
    ).toEqual({ kind: 'lost_ack', callbackDelayVirtualMilliseconds: 0 })
  })

  it.each([
    [
      {
        IDENTITY_TELEMETRY_SIGNING_KEY_ID: BASE_ENVIRONMENT.IDENTITY_TELEMETRY_SIGNING_KEY_ID,
        IDENTITY_TELEMETRY_SIGNING_KEY: IDENTITY_KEY,
      },
      'GATEWAY_CALLBACK_SIGNING_KEY',
    ],
    [
      { ...BASE_ENVIRONMENT, GATEWAY_CALLBACK_SIGNING_KEY: 'short' },
      'GATEWAY_CALLBACK_SIGNING_KEY',
    ],
    [
      {
        ...BASE_ENVIRONMENT,
        GATEWAY_CALLBACK_SIGNING_KEY: 'replace-with-a-different-random-32-byte-value',
      },
      'GATEWAY_CALLBACK_SIGNING_KEY',
    ],
    [{ ...BASE_ENVIRONMENT, GATEWAY_SIMULATOR_PORT: '0' }, 'GATEWAY_SIMULATOR_PORT'],
    [
      {
        ...BASE_ENVIRONMENT,
        GATEWAY_CALLBACK_INITIAL_BACKOFF_MS: '500',
        GATEWAY_CALLBACK_MAX_BACKOFF_MS: '100',
      },
      'GATEWAY_CALLBACK_MAX_BACKOFF_MS',
    ],
    [
      {
        ...BASE_ENVIRONMENT,
        GATEWAY_CALLBACK_MAX_ATTEMPTS: '8',
        GATEWAY_CALLBACK_REQUEST_TIMEOUT_MS: '30000',
      },
      'GATEWAY_SHUTDOWN_TIMEOUT_MS',
    ],
  ] as const)('fails fast for invalid environment input %#', (environment, path) => {
    expect(() => parseGatewaySimulatorConfiguration(environment)).toThrow(path)
  })
})
