import { describe, expect, it } from 'vitest'

import { GATEWAY_FAULT_PROFILES } from '../../apps/gateway-simulator/src/index.js'
import {
  GatewayFaultDurableOutcomeCatalogSchema,
  GatewayFaultDurableOutcomeManifestSchema,
  GatewayFaultProfileNameSchema,
} from '../../packages/core/src/index.js'
import { GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG } from './gateway-fault-manifests/index.js'

interface MutableManifest {
  id: string
  faultProfile: string
  injection: Record<string, unknown>
  recoverability: Record<string, unknown>
  terminalOutcome: Record<string, unknown>
  expectedDurableState: {
    effect: Record<string, unknown>
    attempts: {
      activationTransport: Record<string, unknown>
      gatewayTransport: Record<string, unknown>
    }
    callback: Record<string, unknown>
    outbox: Record<string, unknown>
  }
}

interface MutableCatalog {
  manifests: MutableManifest[]
}

function mutableCatalog(): MutableCatalog {
  return structuredClone(GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG)
}

function manifestFor(catalog: MutableCatalog, profile: string): MutableManifest {
  const manifest = catalog.manifests.find((candidate) => candidate.faultProfile === profile)
  if (manifest === undefined) throw new Error(`Missing ${profile} manifest`)
  return manifest
}

describe('gateway fault durable outcome manifests', () => {
  it('covers the seven executable simulator profiles exactly once with their pinned injections', () => {
    const parsed = GatewayFaultDurableOutcomeCatalogSchema.parse(
      GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG,
    )
    const names = parsed.manifests.map((manifest) => manifest.faultProfile)
    expect(new Set(names)).toEqual(new Set(GatewayFaultProfileNameSchema.options))
    expect(new Set(names)).toEqual(new Set(Object.keys(GATEWAY_FAULT_PROFILES)))

    const injections = Object.fromEntries(
      parsed.manifests.map((manifest) => [manifest.faultProfile, manifest.injection]),
    )
    expect(injections).toEqual(GATEWAY_FAULT_PROFILES)
  })

  it('uses a unique derived ID for every manifest', () => {
    const ids = GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG.manifests.map((manifest) => manifest.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const manifest of GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG.manifests) {
      expect(manifest.id).toBe(`gateway-fault-${manifest.faultProfile}-post-preheat@1`)
    }
  })

  it('labels device-offline as a terminal effect failure without inventing a mission outcome', () => {
    const manifest = GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG.manifests.find(
      (candidate) => candidate.faultProfile === 'device_offline',
    )
    expect(manifest).toMatchObject({
      recoverability: {
        classification: 'unrecoverable_within_execution',
        outcomeAtObservationPoint: 'terminal_effect_failure',
      },
      terminalOutcome: { expected: null },
      expectedDurableState: {
        mission: { state: { status: 'running', phase: 'verify' }, terminal: false },
        verification: { presence: 'absent', count: 0 },
        effect: { status: 'failed', dispatchErrorCode: 'DEVICE_OFFLINE' },
      },
    })
  })

  it('rejects missing, duplicate, and unknown catalog entries', () => {
    const missing = mutableCatalog()
    missing.manifests.pop()
    expect(GatewayFaultDurableOutcomeCatalogSchema.safeParse(missing).success).toBe(false)

    const duplicate = mutableCatalog()
    duplicate.manifests[6] = structuredClone(duplicate.manifests[0]!)
    expect(GatewayFaultDurableOutcomeCatalogSchema.safeParse(duplicate).success).toBe(false)

    const unknownField = mutableCatalog()
    Object.assign(unknownField.manifests[0]!, { undocumentedExpectation: true })
    expect(GatewayFaultDurableOutcomeCatalogSchema.safeParse(unknownField).success).toBe(false)
  })

  it('fails closed when canonical injection, durable counts, or terminal scope mutate', () => {
    const injection = mutableCatalog()
    manifestFor(injection, 'delayed_callback').injection.delayVirtualMilliseconds = 4_001
    expect(GatewayFaultDurableOutcomeCatalogSchema.safeParse(injection).success).toBe(false)

    const outbox = mutableCatalog()
    manifestFor(outbox, 'lost_ack').expectedDurableState.outbox.totalCount = 5
    expect(GatewayFaultDurableOutcomeCatalogSchema.safeParse(outbox).success).toBe(false)

    const terminal = mutableCatalog()
    manifestFor(terminal, 'none').terminalOutcome.expected = 'verified_completion'
    expect(GatewayFaultDurableOutcomeCatalogSchema.safeParse(terminal).success).toBe(false)

    const missingState = mutableCatalog()
    Reflect.deleteProperty(manifestFor(missingState, 'none').expectedDurableState, 'callback')
    expect(GatewayFaultDurableOutcomeCatalogSchema.safeParse(missingState).success).toBe(false)
  })

  it('rejects coherent-looking changes that contradict the profile outcome', () => {
    const deviceRecovery = mutableCatalog()
    const device = manifestFor(deviceRecovery, 'device_offline')
    device.recoverability.classification = 'recoverable'
    device.recoverability.outcomeAtObservationPoint = 'recovered'
    expect(GatewayFaultDurableOutcomeManifestSchema.safeParse(device).success).toBe(false)

    const lostAckReason = mutableCatalog()
    const lostAck = manifestFor(lostAckReason, 'lost_ack')
    lostAck.expectedDurableState.effect.dispatchUnknownReason = 'timeout'
    lostAck.expectedDurableState.attempts.gatewayTransport.errorCode = 'GATEWAY_TIMEOUT'
    expect(GatewayFaultDurableOutcomeManifestSchema.safeParse(lostAck).success).toBe(false)

    const duplicateCount = mutableCatalog()
    const duplicate = manifestFor(duplicateCount, 'duplicate_callback')
    duplicate.expectedDurableState.callback.deliveredCount = 1
    duplicate.expectedDurableState.callback.duplicateDeliveryCount = 0
    duplicate.expectedDurableState.callback.ingestionResults = ['stored']
    expect(GatewayFaultDurableOutcomeManifestSchema.safeParse(duplicate).success).toBe(false)
  })
})
