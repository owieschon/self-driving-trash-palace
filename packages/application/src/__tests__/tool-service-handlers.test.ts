import { describe, expect, it, vi } from 'vitest'

import {
  createToolServiceHandlers,
  type ToolServiceHandlerDependencies,
} from '../tool-service-handlers.js'
import { IDS, authContext, makeMission, makeOperation, makePlan } from './fixtures.js'

describe('tool service handler result contracts', () => {
  it('returns an evidence-backed non-retryable unknown result when activation response is lost', async () => {
    const operation = makeOperation(makePlan(), 'committed')
    const activate = vi.fn(async () => ({
      status: 'committed' as const,
      operation,
      replayed: false,
      delivery: {
        status: 'unknown' as const,
        attemptId: IDS.attempt,
        evidenceIds: [IDS.evidence],
      },
    }))
    const handlers = createToolServiceHandlers({
      operations: { activate },
    } as unknown as ToolServiceHandlerDependencies)

    const result = await handlers['plans.activate']({
      callId: IDS.toolCall,
      host: {
        authentication: authContext,
        missionId: IDS.mission,
        channel: 'http',
        signal: new AbortController().signal,
      },
      mission: makeMission(),
      input: { planId: IDS.plan, actionId: IDS.action, expectedVersion: 3 },
    })

    expect(activate).toHaveBeenCalledWith({
      authorization: 'manual',
      context: authContext,
      planId: IDS.plan,
      actionId: IDS.action,
      expectedVersion: 3,
      toolCallId: IDS.toolCall,
    })
    expect(result).toEqual({
      status: 'unknown',
      retryable: false,
      data: null,
      error: {
        code: 'APPLICATION_RESPONSE_LOST',
        message:
          'The operation committed, but its application response was lost. Reconcile the same operation before continuing.',
        details: {},
      },
      attemptId: IDS.attempt,
      evidenceIds: [IDS.evidence],
    })
  })
})
