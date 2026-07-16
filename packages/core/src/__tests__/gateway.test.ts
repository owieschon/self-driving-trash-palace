import { describe, expect, it } from 'vitest'

import {
  GatewayCallbackSchema,
  GatewayCommandSchema,
  GatewayDispatchStateSchema,
  GatewayDispatchResultSchema,
  GatewayEffectStateSchema,
  callbackDedupeInput,
  canonicalGatewayJson,
  classifyGatewayCallbackStatusTransition,
  computeGatewayPayloadHash,
  deriveGatewayCommandId,
  gatewayCallbackSignaturePayload,
  createGatewayCommand,
  validateGatewayCommandCallbackBinding,
} from '../index.js'

const AT = '2026-08-14T01:58:02-04:00'

function command() {
  return createGatewayCommand({
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    palaceId: 'pal_sacred_dumpster',
    operationId: 'op_gateway_contract',
    logicalKey: 'pathway-lighting',
    kind: 'set_lighting',
    payload: {
      deviceId: 'dev_pathway_lights',
      intensityPercent: 40,
      durationSeconds: 900,
      causedByEvidenceId: 'evd_rocky_arrival',
    },
    createdAt: AT,
  })
}

function callback() {
  const gatewayCommand = command()
  return GatewayCallbackSchema.parse({
    id: 'gcb_contract_callback',
    organizationId: gatewayCommand.organizationId,
    missionId: gatewayCommand.missionId,
    palaceId: gatewayCommand.palaceId,
    commandId: gatewayCommand.id,
    operationId: gatewayCommand.operationId,
    status: 'completed',
    occurredAt: AT,
    nonce: 'gwn_abcdefghijklmnopqrstuvwx',
    evidence: [
      {
        id: 'evd_lighting_command',
        organizationId: gatewayCommand.organizationId,
        missionId: gatewayCommand.missionId,
        palaceId: gatewayCommand.palaceId,
        observedAt: AT,
        type: 'device_command',
        deviceId: gatewayCommand.payload.deviceId,
        command: gatewayCommand.kind,
        causedByEvidenceId: gatewayCommand.payload.causedByEvidenceId,
      },
      {
        id: 'evd_lighting_observation',
        organizationId: gatewayCommand.organizationId,
        missionId: gatewayCommand.missionId,
        palaceId: gatewayCommand.palaceId,
        observedAt: AT,
        type: 'lighting_observation',
        deviceId: gatewayCommand.payload.deviceId,
        intensityPercent: 40,
        active: true,
      },
      {
        id: 'evd_gateway_delivery',
        organizationId: gatewayCommand.organizationId,
        missionId: gatewayCommand.missionId,
        palaceId: gatewayCommand.palaceId,
        observedAt: AT,
        type: 'gateway_delivery',
        gatewayCommandId: gatewayCommand.id,
        operationId: gatewayCommand.operationId,
        status: 'completed',
        code: null,
      },
    ],
  })
}

describe('gateway wire contracts', () => {
  it('hashes canonical JSON independently of object key order', () => {
    const left = canonicalGatewayJson({ payload: { beta: 2, alpha: 1 }, kind: 'example' })
    const right = canonicalGatewayJson({ kind: 'example', payload: { alpha: 1, beta: 2 } })

    expect(left).toBe(right)
    expect(computeGatewayPayloadHash({ kind: 'example', payload: { beta: 2, alpha: 1 } })).toBe(
      computeGatewayPayloadHash({ kind: 'example', payload: { alpha: 1, beta: 2 } }),
    )
  })

  it('rejects values that JSON would silently erase or coerce', () => {
    expect(() => canonicalGatewayJson({ omitted: undefined })).toThrow(/undefined/)
    expect(() => canonicalGatewayJson({ invalid: Number.POSITIVE_INFINITY })).toThrow(/non-finite/)
    expect(() => canonicalGatewayJson({ date: new Date(AT) })).toThrow(/plain objects/)
  })

  it('binds each command hash to its exact kind and payload', () => {
    const valid = command()

    expect(GatewayCommandSchema.parse(valid)).toEqual(valid)
    expect(
      GatewayCommandSchema.safeParse({
        ...valid,
        payload: { ...valid.payload, intensityPercent: 41 },
      }).success,
    ).toBe(false)
  })

  it('derives one stable command identity and body across transport retries', () => {
    const first = command()
    const second = command()

    expect(first).toEqual(second)
    expect(first.id).toBe(deriveGatewayCommandId(first.operationId, first.logicalKey))
    expect(canonicalGatewayJson(first)).toBe(canonicalGatewayJson(second))
    expect('attemptId' in first).toBe(false)
    expect(
      GatewayCommandSchema.safeParse({
        ...first,
        id: 'gcmd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }).success,
    ).toBe(false)
  })

  it('rejects noncanonical logical keys and transport data in a command', () => {
    const valid = command()

    expect(() => deriveGatewayCommandId(valid.operationId, 'Pathway lighting')).toThrow()
    expect(
      GatewayCommandSchema.safeParse({ ...valid, attemptId: 'att_gateway_retry' }).success,
    ).toBe(false)
  })

  it('requires one matching delivery record on a terminal callback', () => {
    const valid = callback()

    expect(valid.evidence).toHaveLength(3)
    expect(
      GatewayCallbackSchema.safeParse({
        ...valid,
        evidence: [{ ...valid.evidence[0], operationId: 'op_different_operation' }],
      }).success,
    ).toBe(false)
    expect(GatewayCallbackSchema.safeParse({ ...valid, evidence: [] }).success).toBe(false)
  })

  it('accepts only gateway-owned wire evidence', () => {
    const valid = callback()
    const identityArrival = {
      id: 'evd_forged_arrival',
      organizationId: valid.organizationId,
      missionId: valid.missionId,
      palaceId: valid.palaceId,
      observedAt: AT,
      type: 'identity_arrival',
      identityTagId: 'tag_rocky_verified',
      verified: true,
    }

    expect(
      GatewayCallbackSchema.safeParse({
        ...valid,
        evidence: [...valid.evidence, identityArrival],
      }).success,
    ).toBe(false)
    expect(
      GatewayCallbackSchema.safeParse({
        ...valid,
        status: 'executing',
        evidence: [
          {
            id: 'evd_early_lighting',
            organizationId: valid.organizationId,
            missionId: valid.missionId,
            palaceId: valid.palaceId,
            observedAt: AT,
            type: 'lighting_observation',
            deviceId: 'dev_pathway_lights',
            intensityPercent: 40,
            active: true,
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      GatewayCallbackSchema.safeParse({
        ...valid,
        evidence: valid.evidence.map((evidence, index) =>
          index === 1 ? { ...evidence, authority: 'gateway_callback' } : evidence,
        ),
      }).success,
    ).toBe(false)
  })

  it('validates callback command, device, kind, cause, and requested state bindings', () => {
    const gatewayCommand = command()
    const valid = callback()
    const lightingIndex = valid.evidence.findIndex(
      (evidence) => evidence.type === 'lighting_observation',
    )
    const lightingEvidence = valid.evidence[lightingIndex]
    if (lightingEvidence?.type !== 'lighting_observation')
      throw new Error('missing fixture evidence')

    expect(validateGatewayCommandCallbackBinding(gatewayCommand, valid).callback).toEqual(valid)
    expect(() =>
      validateGatewayCommandCallbackBinding(
        gatewayCommand,
        GatewayCallbackSchema.parse({
          ...valid,
          evidence: valid.evidence.map((evidence, index) =>
            index === lightingIndex
              ? { ...lightingEvidence, deviceId: 'dev_foreign_lighting' }
              : evidence,
          ),
        }),
      ),
    ).toThrow(/command device/)
    expect(() =>
      validateGatewayCommandCallbackBinding(
        gatewayCommand,
        GatewayCallbackSchema.parse({
          ...valid,
          evidence: valid.evidence.map((evidence, index) =>
            index === lightingIndex
              ? {
                  id: lightingEvidence.id,
                  organizationId: lightingEvidence.organizationId,
                  missionId: lightingEvidence.missionId,
                  palaceId: lightingEvidence.palaceId,
                  observedAt: lightingEvidence.observedAt,
                  type: 'temperature_observation',
                  deviceId: lightingEvidence.deviceId,
                  celsius: 20,
                }
              : evidence,
          ),
        }),
      ),
    ).toThrow(/command kind/)

    const deliveryOnly = GatewayCallbackSchema.parse({
      ...valid,
      evidence: valid.evidence.filter((evidence) => evidence.type === 'gateway_delivery'),
    })
    expect(() => validateGatewayCommandCallbackBinding(gatewayCommand, deliveryOnly)).toThrow(
      /device command.*observation/,
    )
  })

  it('rejects a lock observation that contradicts the requested state', () => {
    const unlock = createGatewayCommand({
      organizationId: 'org_rocky_roost',
      missionId: 'mis_night_shift_home',
      palaceId: 'pal_sacred_dumpster',
      operationId: 'op_gateway_contract',
      logicalKey: 'unlock',
      kind: 'unlock',
      payload: {
        deviceId: 'dev_front_lock',
        identityTagId: 'tag_rocky_verified',
        durationSeconds: 120,
        causedByEvidenceId: 'evd_rocky_arrival',
      },
      createdAt: AT,
    })
    const contradictory = GatewayCallbackSchema.parse({
      id: 'gcb_unlock_contradiction',
      organizationId: unlock.organizationId,
      missionId: unlock.missionId,
      palaceId: unlock.palaceId,
      commandId: unlock.id,
      operationId: unlock.operationId,
      status: 'completed',
      occurredAt: AT,
      nonce: 'gwn_unlock_contradiction_123456',
      evidence: [
        {
          id: 'evd_unlock_command',
          organizationId: unlock.organizationId,
          missionId: unlock.missionId,
          palaceId: unlock.palaceId,
          observedAt: AT,
          type: 'device_command',
          deviceId: unlock.payload.deviceId,
          command: 'unlock',
          causedByEvidenceId: unlock.payload.causedByEvidenceId,
        },
        {
          id: 'evd_lock_still_locked',
          organizationId: unlock.organizationId,
          missionId: unlock.missionId,
          palaceId: unlock.palaceId,
          observedAt: AT,
          type: 'lock_observation',
          deviceId: unlock.payload.deviceId,
          desiredState: 'locked',
        },
        {
          id: 'evd_unlock_delivery',
          organizationId: unlock.organizationId,
          missionId: unlock.missionId,
          palaceId: unlock.palaceId,
          observedAt: AT,
          type: 'gateway_delivery',
          gatewayCommandId: unlock.id,
          operationId: unlock.operationId,
          status: 'completed',
          code: null,
        },
      ],
    })

    expect(() => validateGatewayCommandCallbackBinding(unlock, contradictory)).toThrow(
      /requested command state/,
    )
  })

  it('classifies monotonic callback transitions and rejects terminal contradictions', () => {
    expect(classifyGatewayCallbackStatusTransition(null, 'completed')).toBe('advance')
    expect(classifyGatewayCallbackStatusTransition('acknowledged', 'executing')).toBe('advance')
    expect(classifyGatewayCallbackStatusTransition('executing', 'executing')).toBe('replay')
    expect(classifyGatewayCallbackStatusTransition('executing', 'acknowledged')).toBe(
      'reject_regression',
    )
    expect(classifyGatewayCallbackStatusTransition('completed', 'failed')).toBe(
      'reject_terminal_contradiction',
    )
    expect(classifyGatewayCallbackStatusTransition('failed', 'completed')).toBe(
      'reject_terminal_contradiction',
    )
    expect(classifyGatewayCallbackStatusTransition('completed', 'executing')).toBe(
      'reject_regression',
    )
  })

  it('derives a stable callback dedupe digest from the full callback', () => {
    expect(callbackDedupeInput(callback())).toEqual(callbackDedupeInput(callback()))
    expect(callbackDedupeInput(callback()).payloadHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('defines one signature preimage for every gateway adapter', () => {
    expect(gatewayCallbackSignaturePayload(callback(), 'gwk_primary_2026', AT)).toContain(
      'gateway-callback:v1\ngwk_primary_2026\n',
    )
  })

  it('keeps ambiguous delivery distinct from a definite gateway failure', () => {
    expect(
      GatewayDispatchResultSchema.parse({
        status: 'unknown',
        retryable: true,
        reason: 'lost_ack',
      }),
    ).toEqual({ status: 'unknown', retryable: true, reason: 'lost_ack' })
    expect(
      GatewayDispatchResultSchema.safeParse({
        status: 'unknown',
        retryable: false,
        reason: 'lost_ack',
      }).success,
    ).toBe(false)
  })

  it('keeps transport dispatch and callback-owned effect state separate', () => {
    const gatewayCommand = command()
    const cancelledDispatch = GatewayDispatchStateSchema.parse({
      commandId: gatewayCommand.id,
      generation: 1,
      status: 'cancelled',
      attemptId: null,
      reason: 'mission_cancelled_before_dispatch',
      cancelledAt: AT,
      updatedAt: AT,
    })
    const cancellationRequested = GatewayEffectStateSchema.parse({
      commandId: gatewayCommand.id,
      status: 'cancellation_requested',
      callbackId: 'gcb_contract_callback',
      evidenceIds: [],
      requestedAt: AT,
      updatedAt: AT,
    })

    expect(cancelledDispatch.status).toBe('cancelled')
    expect(cancellationRequested.status).toBe('cancellation_requested')
    expect(
      GatewayDispatchStateSchema.safeParse({
        ...cancelledDispatch,
        acknowledgementId: 'gack_should_not_exist',
      }).success,
    ).toBe(false)
    expect(
      GatewayEffectStateSchema.safeParse({
        commandId: gatewayCommand.id,
        status: 'completed',
        callbackId: 'gcb_contract_callback',
        evidenceIds: ['evd_only_delivery'],
        updatedAt: AT,
      }).success,
    ).toBe(false)
  })
})
