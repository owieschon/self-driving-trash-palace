import { describe, expect, it } from 'vitest'

import {
  ClarificationAnswerSchema,
  ClarificationRequestSchema,
  computeClarificationAnswerPayloadHash,
  computeClarificationRequestPayloadHash,
} from '../clarifications.js'

const requestPayload = {
  schemaVersion: 'clarification-request-payload@1' as const,
  organizationId: 'org_primary0001',
  missionId: 'mis_mission00001',
  requestedBy: 'usr_service0001',
  question: 'Which comfort constraint should take priority tonight?',
  choices: [
    {
      id: 'energy_first',
      label: 'Energy first',
      description: 'Stay within the battery ceiling and preheat later.',
    },
    {
      id: 'comfort_first',
      label: 'Comfort first',
      description: 'Preheat earlier and accept the projected battery tradeoff.',
    },
  ],
  evidenceRefs: ['evd_evidence0001'],
} as const

describe('clarification contracts', () => {
  it('binds bounded request and answer payloads to canonical hashes', () => {
    const request = ClarificationRequestSchema.parse({
      ...requestPayload,
      schemaVersion: 'clarification-request@1',
      id: 'clr_request00001',
      idempotencyKey: 'a'.repeat(64),
      payloadHash: computeClarificationRequestPayloadHash(requestPayload),
      status: 'pending',
      requestedAt: '2026-08-14T05:35:00.000Z',
      resolvedAt: null,
    })
    const answerPayload = {
      schemaVersion: 'clarification-answer-payload@1' as const,
      organizationId: request.organizationId,
      missionId: request.missionId,
      requestId: request.id,
      choiceId: request.choices[0]!.id,
      answeredBy: 'usr_owner000001',
      evidenceRefs: ['evd_evidence0001'],
    }
    expect(
      ClarificationAnswerSchema.parse({
        ...answerPayload,
        schemaVersion: 'clarification-answer@1',
        id: 'cla_answer000001',
        idempotencyKey: 'b'.repeat(64),
        payloadHash: computeClarificationAnswerPayloadHash(answerPayload),
        answeredAt: '2026-08-14T05:36:00.000Z',
      }),
    ).toMatchObject({ choiceId: 'energy_first' })
  })

  it.each([
    ['question', 'Use token=super-secret-value for this decision'],
    ['question', 'Read /Users/rocky/.config before answering this question'],
    ['question', 'Call http://127.0.0.1:3000/internal before deciding'],
  ] as const)('rejects unsafe %s content', (field, value) => {
    expect(() =>
      ClarificationRequestSchema.parse({
        ...requestPayload,
        [field]: value,
        schemaVersion: 'clarification-request@1',
        id: 'clr_request00001',
        idempotencyKey: 'a'.repeat(64),
        payloadHash: computeClarificationRequestPayloadHash({ ...requestPayload, [field]: value }),
        status: 'pending',
        requestedAt: '2026-08-14T05:35:00.000Z',
        resolvedAt: null,
      }),
    ).toThrow()
  })

  it('rejects duplicate choices, unbound hashes, free-form answer fields, and inconsistent status', () => {
    const base = {
      ...requestPayload,
      schemaVersion: 'clarification-request@1' as const,
      id: 'clr_request00001',
      idempotencyKey: 'a'.repeat(64),
      payloadHash: computeClarificationRequestPayloadHash(requestPayload),
      status: 'pending' as const,
      requestedAt: '2026-08-14T05:35:00.000Z',
      resolvedAt: null,
    }
    expect(() =>
      ClarificationRequestSchema.parse({ ...base, payloadHash: 'b'.repeat(64) }),
    ).toThrow(/bind/)
    expect(() =>
      ClarificationRequestSchema.parse({
        ...base,
        choices: [requestPayload.choices[0], requestPayload.choices[0]],
      }),
    ).toThrow(/unique/)
    expect(() =>
      ClarificationRequestSchema.parse({
        ...base,
        status: 'answered',
      }),
    ).toThrow(/resolution/)
    expect(() =>
      ClarificationAnswerSchema.parse({
        schemaVersion: 'clarification-answer@1',
        id: 'cla_answer000001',
        idempotencyKey: 'b'.repeat(64),
        payloadHash: 'c'.repeat(64),
        organizationId: requestPayload.organizationId,
        missionId: requestPayload.missionId,
        requestId: 'clr_request00001',
        choiceId: 'energy_first',
        answeredBy: 'usr_owner000001',
        evidenceRefs: [],
        answeredAt: '2026-08-14T05:36:00.000Z',
        answerText: 'Energy first',
      }),
    ).toThrow()
  })
})
