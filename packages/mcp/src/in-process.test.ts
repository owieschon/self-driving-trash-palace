import { OpaqueMissionFenceToken, type MissionExecutionContext } from '@trash-palace/application'
import {
  MissionIdSchema,
  OrganizationIdSchema,
  PrincipalSchema,
  parseToolResult,
} from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { InProcessToolAdapter, type InProcessDispatcherPort } from './in-process.js'

const organizationId = OrganizationIdSchema.parse('org_in_process_01')
const missionId = MissionIdSchema.parse('mis_in_process_01')
const authentication: MissionExecutionContext = {
  principal: PrincipalSchema.parse({
    organizationId,
    actorId: 'usr_in_process_01',
    role: 'service',
    operatorGrants: [],
    delegatedPermissions: [],
  }),
  fence: {
    organizationId,
    missionId,
    ownerId: 'worker_in_process_01',
    token: OpaqueMissionFenceToken.fromEntropy('opaque_fence_token_1234567890'),
    epoch: 1,
  },
  signal: new AbortController().signal,
}

describe('in-process tool adapter', () => {
  it('uses the shared dispatcher and canonical result envelope without a transport shortcut', async () => {
    const invoke = vi.fn<InProcessDispatcherPort['invoke']>().mockImplementation(async (request) =>
      parseToolResult('knowledge.search', {
        schemaVersion: 'tool-result@1',
        toolName: 'knowledge.search',
        callId: request.callId,
        status: 'succeeded',
        retryable: false,
        data: { results: [] },
        receiptId: 'rcp_in_process_01',
        resourceVersion: null,
        error: null,
      }),
    )
    const adapter = new InProcessToolAdapter({
      dispatcher: { invoke },
      authentication,
      missionId: 'mis_in_process_01',
    })

    const result = await adapter.invoke({
      callId: 'call_in_process_01',
      toolName: 'knowledge.search',
      input: { query: 'mission evidence', phase: 'understand' },
    })

    expect(result.status).toBe('succeeded')
    expect(invoke).toHaveBeenCalledWith(
      {
        callId: 'call_in_process_01',
        toolName: 'knowledge.search',
        input: { query: 'mission evidence', phase: 'understand', limit: 6 },
      },
      expect.objectContaining({
        authentication,
        channel: 'in_process',
        missionId: 'mis_in_process_01',
      }),
    )
  })
})
