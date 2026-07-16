import { describe, expect, it } from 'vitest'

import {
  CapabilitiesListOutputSchema,
  CrewsListOutputSchema,
  ExecutionSchema,
  GatewayDeliveryEvidenceSchema,
  OperationTransportEvidenceSchema,
  PersistedEvidenceRecordSchema,
  PlansActivateInputSchema,
  TOOL_REGISTRY,
  ToolNameSchema,
  ToolResultEnvelopeSchema,
  ToolInvocationReconciliationEvidenceSchema,
  VerificationSchema,
  computeToolInvocationReconciliationObservationHash,
  parseToolInput,
} from '../index.js'

const CREW_PROJECTION = {
  crew: [
    {
      id: 'crew_rocky_founder',
      organizationId: 'org_rocky_roost',
      palaceId: 'pal_sacred_dumpster',
      userId: 'usr_rocky_founder',
      displayName: 'Rocky',
      active: true,
    },
  ],
  identityTags: [
    {
      id: 'tag_rocky_verified',
      organizationId: 'org_rocky_roost',
      crewMemberId: 'crew_rocky_founder',
      label: "Rocky's verified tag",
      verified: true,
      active: true,
      version: 4,
    },
  ],
  schedules: [
    {
      id: 'sch_rocky_night_shift',
      organizationId: 'org_rocky_roost',
      palaceId: 'pal_sacred_dumpster',
      crewMemberId: 'crew_rocky_founder',
      active: true,
      version: 2,
      timezone: 'America/New_York',
      windowStart: '00:00',
      windowEnd: '03:00',
    },
  ],
  preferences: [
    {
      id: 'pref_rocky_homecoming',
      organizationId: 'org_rocky_roost',
      palaceId: 'pal_sacred_dumpster',
      crewMemberId: 'crew_rocky_founder',
      kind: 'homecoming_comfort',
      active: true,
      version: 4,
      targetCelsius: 22,
      pathwayLightingIntensityPercent: 60,
      pathwayLightingDurationSeconds: 1_800,
    },
  ],
} as const

const CAPABILITY_PROJECTION = {
  devices: [
    {
      id: 'dev_front_lock',
      organizationId: 'org_rocky_roost',
      palaceId: 'pal_sacred_dumpster',
      kind: 'lock',
      name: 'Front hatch lock',
      health: 'online',
      version: 9,
    },
  ],
  capabilities: [
    {
      id: 'cap_lock_state',
      organizationId: 'org_rocky_roost',
      deviceId: 'dev_front_lock',
      kind: 'lock_desired_state',
      enabled: true,
      constraints: { maxUnlockSeconds: 300, requiresVerifiedIdentity: true },
    },
  ],
} as const

const TOOL_NAMES = [
  'palaces.get',
  'crews.list',
  'capabilities.list',
  'routines.list',
  'routines.get',
  'executions.list',
  'knowledge.search',
  'plans.propose',
  'plans.validate',
  'plans.simulate',
  'plans.request_approval',
  'plans.activate',
  'operations.get',
  'verification.get_evidence',
  'missions.cancel',
] as const

describe('tool registry', () => {
  it('contains exactly the fifteen production tools', () => {
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual([...TOOL_NAMES].sort())
    expect(ToolNameSchema.options).toHaveLength(15)
    expect(Object.keys(TOOL_REGISTRY).some((name) => name.includes('legacy'))).toBe(false)
  })

  it('derives tenant and actor from the host instead of plans.activate input', () => {
    const input = {
      planId: 'pln_homecoming_energy',
      actionId: 'act_replace_homecoming',
      expectedVersion: 3,
    }
    expect(PlansActivateInputSchema.parse(input)).toEqual(input)
    expect(
      PlansActivateInputSchema.safeParse({
        ...input,
        organizationId: 'org_rocky_roost',
      }).success,
    ).toBe(false)
    expect(
      PlansActivateInputSchema.safeParse({
        ...input,
        actorId: 'usr_rocky_founder',
      }).success,
    ).toBe(false)
    expect(
      PlansActivateInputSchema.safeParse({
        ...input,
        faultProfile: 'application_commit_then_response_lost',
      }).success,
    ).toBe(false)
  })

  it('parses through the same registry used by transports', () => {
    expect(parseToolInput('operations.get', { operationId: 'op_homecoming_once' })).toEqual({
      operationId: 'op_homecoming_once',
    })
  })

  it('preserves unknown as a first-class result status', () => {
    const result = ToolResultEnvelopeSchema.parse({
      schemaVersion: 'tool-result@1',
      toolName: 'plans.activate',
      callId: 'call_activate_homecoming',
      status: 'unknown',
      retryable: true,
      data: null,
      receiptId: 'rcp_activate_unknown',
      resourceVersion: null,
      error: null,
    })
    expect(result.status).toBe('unknown')
  })

  it('does not flatten a denied result without a structured error', () => {
    expect(
      ToolResultEnvelopeSchema.safeParse({
        schemaVersion: 'tool-result@1',
        toolName: 'plans.activate',
        callId: 'call_activate_homecoming',
        status: 'denied',
        retryable: false,
        data: null,
        receiptId: 'rcp_activate_denied',
        resourceVersion: null,
        error: null,
      }).success,
    ).toBe(false)
  })
})

describe('tenant-bound read projections', () => {
  it('returns crew with the tags, schedule, and versioned preference needed for planning', () => {
    const output = CrewsListOutputSchema.parse(CREW_PROJECTION)
    expect(output.identityTags).toHaveLength(1)
    expect(output.schedules[0]).toMatchObject({
      timezone: 'America/New_York',
      windowStart: '00:00',
      windowEnd: '03:00',
    })
    expect(output.preferences[0]).toMatchObject({
      targetCelsius: 22,
      pathwayLightingIntensityPercent: 60,
      pathwayLightingDurationSeconds: 1_800,
    })
  })

  it('rejects the former incomplete crews.list shape', () => {
    expect(CrewsListOutputSchema.safeParse({ crew: CREW_PROJECTION.crew }).success).toBe(false)
  })

  it('rejects foreign-tenant and foreign-palace crew metadata', () => {
    expect(
      CrewsListOutputSchema.safeParse({
        ...CREW_PROJECTION,
        preferences: CREW_PROJECTION.preferences.map((preference) => ({
          ...preference,
          organizationId: 'org_mirror_nest',
        })),
      }).success,
    ).toBe(false)
    expect(
      CrewsListOutputSchema.safeParse({
        ...CREW_PROJECTION,
        schedules: CREW_PROJECTION.schedules.map((schedule) => ({
          ...schedule,
          palaceId: 'pal_mirror_dumpster',
        })),
      }).success,
    ).toBe(false)
  })

  it('rejects crew metadata that is not linked to a projected crew member', () => {
    expect(
      CrewsListOutputSchema.safeParse({
        ...CREW_PROJECTION,
        crew: [],
      }).success,
    ).toBe(false)
    expect(
      CrewsListOutputSchema.safeParse({
        ...CREW_PROJECTION,
        identityTags: CREW_PROJECTION.identityTags.map((tag) => ({
          ...tag,
          crewMemberId: null,
        })),
      }).success,
    ).toBe(false)
  })

  it('returns device health alongside each device capability', () => {
    const output = CapabilitiesListOutputSchema.parse(CAPABILITY_PROJECTION)
    expect(output.devices[0]?.health).toBe('online')
    expect(output.capabilities[0]?.deviceId).toBe(output.devices[0]?.id)
  })

  it('rejects the former incomplete capabilities.list shape', () => {
    expect(
      CapabilitiesListOutputSchema.safeParse({
        capabilities: CAPABILITY_PROJECTION.capabilities,
      }).success,
    ).toBe(false)
  })

  it('rejects foreign-tenant and unlinked capabilities', () => {
    expect(
      CapabilitiesListOutputSchema.safeParse({
        ...CAPABILITY_PROJECTION,
        capabilities: CAPABILITY_PROJECTION.capabilities.map((capability) => ({
          ...capability,
          organizationId: 'org_mirror_nest',
        })),
      }).success,
    ).toBe(false)
    expect(
      CapabilitiesListOutputSchema.safeParse({
        ...CAPABILITY_PROJECTION,
        devices: [],
      }).success,
    ).toBe(false)
  })

  it('rejects a capability projection that combines palaces', () => {
    expect(
      CapabilitiesListOutputSchema.safeParse({
        ...CAPABILITY_PROJECTION,
        devices: [
          ...CAPABILITY_PROJECTION.devices,
          {
            id: 'dev_mirror_lock',
            organizationId: 'org_rocky_roost',
            palaceId: 'pal_mirror_dumpster',
            kind: 'lock',
            name: 'Wrong palace lock',
            health: 'online',
            version: 1,
          },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('verification ownership', () => {
  const passedVerification = {
    id: 'ver_homecoming_result',
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    source: 'application_code',
    status: 'passed',
    planHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    assertions: [
      {
        predicate: {
          id: 'battery_projection_within_bound',
          type: 'battery_projection_at_most',
          maximumPercentagePoints: 15,
        },
        passed: true,
        evidenceIds: ['evd_battery_projection'],
        message: 'Projected use is 13.2 percentage points.',
      },
    ],
    completedAt: '2026-08-14T02:00:00-04:00',
  } as const

  it('accepts application-code verification', () => {
    expect(VerificationSchema.parse(passedVerification).status).toBe('passed')
  })

  it('rejects a model-authored success claim', () => {
    expect(VerificationSchema.safeParse({ ...passedVerification, source: 'model' }).success).toBe(
      false,
    )
  })

  it('rejects passed status when any deterministic assertion fails', () => {
    const assertions = passedVerification.assertions.map((assertion) => ({
      ...assertion,
      passed: false,
    }))
    expect(VerificationSchema.safeParse({ ...passedVerification, assertions }).success).toBe(false)
  })
})

describe('tool invocation reconciliation evidence', () => {
  const observation = {
    schemaVersion: 'tool-invocation-reconciliation-observation@1' as const,
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    toolCallId: 'call_activate_homecoming',
    toolName: 'plans.activate' as const,
    invocationBindingHash: 'a'.repeat(64),
    abandonedClaimGeneration: 1,
    claimExpiredAt: '2026-08-14T05:39:59.000Z',
    source: 'tool_invocation_ledger' as const,
    observer: 'application_code' as const,
    durableObservation: 'expired_claim_without_terminal_result' as const,
    reconciledOutcome: 'still_unknown' as const,
    observedResultHash: null,
    observedAttemptId: null,
    observedAt: '2026-08-14T05:40:00.000Z',
  }
  const evidence = {
    id: 'evd_invocationunknown1',
    organizationId: observation.organizationId,
    missionId: observation.missionId,
    palaceId: 'pal_sacred_dumpster',
    observedAt: observation.observedAt,
    type: 'tool_invocation_reconciliation' as const,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    invocationBindingHash: observation.invocationBindingHash,
    abandonedClaimGeneration: observation.abandonedClaimGeneration,
    claimExpiredAt: observation.claimExpiredAt,
    source: observation.source,
    observer: observation.observer,
    durableObservation: observation.durableObservation,
    reconciledOutcome: observation.reconciledOutcome,
    observedResultHash: observation.observedResultHash,
    observedAttemptId: observation.observedAttemptId,
    observationHash: computeToolInvocationReconciliationObservationHash(observation),
  }

  it('binds an application observation to one expired call identity', () => {
    expect(ToolInvocationReconciliationEvidenceSchema.parse(evidence)).toEqual(evidence)
  })

  it('rejects tampered call bindings, unsupported outcomes, and pre-expiry observations', () => {
    expect(
      ToolInvocationReconciliationEvidenceSchema.safeParse({
        ...evidence,
        toolCallId: 'call_another_homecoming',
      }).success,
    ).toBe(false)
    expect(
      ToolInvocationReconciliationEvidenceSchema.safeParse({
        ...evidence,
        reconciledOutcome: 'committed',
      }).success,
    ).toBe(false)
    expect(
      ToolInvocationReconciliationEvidenceSchema.safeParse({
        ...evidence,
        claimExpiredAt: '2026-08-14T05:40:01.000Z',
      }).success,
    ).toBe(false)
  })
})

describe('application operation transport evidence', () => {
  const evidence = {
    id: 'evd_appresponselost1',
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    palaceId: 'pal_sacred_dumpster',
    observedAt: '2026-08-14T05:40:00.000Z',
    type: 'operation_transport' as const,
    operationId: 'op_homecoming_once',
    attemptId: 'att_homecoming_lost1',
    toolCallId: 'call_activate_homecoming',
    transport: 'worker' as const,
    status: 'unknown' as const,
    operationCommitted: true as const,
    errorCode: 'APPLICATION_RESPONSE_LOST' as const,
  }
  const receipt = {
    schemaVersion: 'evidence-authority-receipt@1' as const,
    id: 'rcp_appresponselost1',
    evidenceId: evidence.id,
    organizationId: evidence.organizationId,
    missionId: evidence.missionId,
    palaceId: evidence.palaceId,
    verifiedAt: evidence.observedAt,
    authority: 'application' as const,
    producer: 'application_code' as const,
    ruleId: 'operation.application_response_lost',
    ruleVersion: 1,
    inputEvidenceIds: [],
    derivationVerified: true as const,
  }

  it('records only the exact application-owned response-loss boundary', () => {
    expect(OperationTransportEvidenceSchema.parse(evidence)).toEqual(evidence)
    expect(
      PersistedEvidenceRecordSchema.parse({
        schemaVersion: 'persisted-evidence@1',
        evidence,
        authorityReceipt: receipt,
        persistedAt: evidence.observedAt,
      }),
    ).toMatchObject({ evidence, authorityReceipt: receipt })
  })

  it('rejects widened transport claims and receipts that do not bind the exact rule', () => {
    expect(
      OperationTransportEvidenceSchema.safeParse({ ...evidence, transport: 'mcp' }).success,
    ).toBe(false)
    expect(
      OperationTransportEvidenceSchema.safeParse({ ...evidence, reason: 'socket closed' }).success,
    ).toBe(false)
    expect(
      PersistedEvidenceRecordSchema.safeParse({
        schemaVersion: 'persisted-evidence@1',
        evidence,
        authorityReceipt: { ...receipt, ruleId: 'operation.response_unknown' },
        persistedAt: evidence.observedAt,
      }).success,
    ).toBe(false)
    expect(
      PersistedEvidenceRecordSchema.safeParse({
        schemaVersion: 'persisted-evidence@1',
        evidence,
        authorityReceipt: { ...receipt, inputEvidenceIds: ['evd_inventedinput1'] },
        persistedAt: evidence.observedAt,
      }).success,
    ).toBe(false)
  })
})

describe('execution lifecycle evidence', () => {
  const execution = {
    id: 'exe_homecoming_once',
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    routineId: 'rtn_night_shift_home',
    routineVersionId: 'rtv_night_shift_home_v1',
    status: 'observed',
    triggeredByEvidenceId: 'evd_rocky_arrival',
    evidenceIds: ['evd_rocky_arrival'],
    startedAt: '2026-08-14T01:58:00-04:00',
    completedAt: '2026-08-14T02:00:00-04:00',
  } as const

  it('requires terminal executions to carry a completion time', () => {
    expect(ExecutionSchema.safeParse({ ...execution, completedAt: null }).success).toBe(false)
  })

  it('keeps running executions open', () => {
    expect(ExecutionSchema.safeParse({ ...execution, status: 'running' }).success).toBe(false)
  })
})

describe('gateway delivery evidence', () => {
  const delivery = {
    id: 'evd_gateway_delivery',
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    palaceId: 'pal_sacred_dumpster',
    observedAt: '2026-08-14T01:58:01-04:00',
    type: 'gateway_delivery',
    gatewayCommandId: 'gcmd_unlock_homecoming',
    operationId: 'op_homecoming_once',
    status: 'failed',
    code: 'DEVICE_OFFLINE',
  } as const

  it('retains a structured downstream failure', () => {
    expect(GatewayDeliveryEvidenceSchema.parse(delivery).code).toBe('DEVICE_OFFLINE')
  })

  it('rejects an unexplained failure or an error on completion', () => {
    expect(GatewayDeliveryEvidenceSchema.safeParse({ ...delivery, code: null }).success).toBe(false)
    expect(
      GatewayDeliveryEvidenceSchema.safeParse({ ...delivery, status: 'completed' }).success,
    ).toBe(false)
  })
})
