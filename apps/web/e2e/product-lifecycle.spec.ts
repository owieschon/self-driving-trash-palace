import { expect, test, type Page } from '@playwright/test'

test('keeps a mission pending until the user reviews a server-supplied approval', async ({
  page,
}) => {
  await mockApprovalLifecycle(page)

  await openHaulerAutomation(page)
  await expect(page.getByRole('button', { name: 'Prepare proposal' })).toBeVisible()
  await page.getByRole('button', { name: 'Prepare proposal' }).click()

  await expect(
    page.getByText('Allow the assigned collection team to use only the service hatch.'),
  ).toBeVisible()
  await expect(page.getByText('Residential Hatch Must Remain Locked')).toBeVisible()
  await expect(page.getByText('Service Hatch Relocked')).toBeVisible()
  await expect(page.getByText('Change recorded')).toHaveCount(0)
  await expect(page.getByText('Verified')).toHaveCount(0)
})

test('keeps a reachable check action while Pal is still preparing a proposal', async ({ page }) => {
  await mockApprovalLifecycle(page, [], [], { noTaskInitially: true })

  await openHaulerAutomation(page)
  await page.getByRole('button', { name: 'Prepare proposal' }).click()

  await expect(page.getByText('Pal is preparing the proposal')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check request' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop this request' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View activity' })).toBeVisible()
})

test('uses the stored approval nonce and keeps the result explicitly unverified', async ({
  page,
}) => {
  const decisionBodies: unknown[] = []
  await mockApprovalLifecycle(page, decisionBodies)

  await openHaulerAutomation(page)
  await page.getByRole('button', { name: 'Prepare proposal' }).click()
  await page.getByRole('button', { name: 'Approve proposal' }).click()

  await expect(page.getByText('Approval recorded. Checking the result.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View activity' })).toBeVisible()
  await expect(page.getByText('Change recorded')).toHaveCount(0)
  await expect(page.getByText('Verified')).toHaveCount(0)
  expect(decisionBodies).toEqual([{ nonce: 'nonce_from_server', decision: 'approve' }])
})

test('stops a durable request through the cancellation tool and waits for its final state', async ({
  page,
}) => {
  const cancellationBodies: unknown[] = []
  await mockApprovalLifecycle(page, [], [], { cancellationBodies })

  await openHaulerAutomation(page)
  await page.getByRole('button', { name: 'Prepare proposal' }).click()
  await page.getByRole('button', { name: 'Stop this request' }).click()

  await expect(page.getByText('Proposal cancelled')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to automations' })).toBeVisible()
  expect(cancellationBodies).toEqual([
    expect.objectContaining({
      missionId: 'mis_hauler',
      reason: expect.stringContaining('Stopped'),
    }),
  ])
})

test('does not rotate the browser session after creating a request with a stop control', async ({
  page,
}) => {
  const postMissionWorkspaceReads = { count: 0 }
  await mockApprovalLifecycle(page, [], [], {
    enforceLatestSessionForCancellation: true,
    postMissionWorkspaceReads,
  })

  await openHaulerAutomation(page)
  await page.getByRole('button', { name: 'Prepare proposal' }).click()
  await expect.poll(() => postMissionWorkspaceReads.count).toBeGreaterThanOrEqual(1)
  await page.getByRole('button', { name: 'Stop this request' }).click()

  await expect(page.getByText('Proposal cancelled')).toBeVisible()
})

test('does not describe a failed stop as an approval result', async ({ page }) => {
  await mockApprovalLifecycle(page, [], [], { failCancellation: true })

  await openHaulerAutomation(page)
  await page.getByRole('button', { name: 'Prepare proposal' }).click()
  await page.getByRole('button', { name: 'Stop this request' }).click()

  await expect(page.getByText('Stop request needs confirmation')).toBeVisible()
  await expect(page.getByText('Approval recorded. Checking the result.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Check request' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try stop again' })).toBeVisible()
})

test('turns supported settings into a bounded new proposal request', async ({ page }) => {
  const decisionBodies: unknown[] = []
  const requestBodies: unknown[] = []
  await mockApprovalLifecycle(page, decisionBodies, requestBodies)

  await openHaulerAutomation(page)
  await page.getByLabel('Access starts').fill('09:00')
  await expect(page.getByLabel('Access starts')).toHaveValue('09:00')
  await page.getByLabel('Access ends').fill('09:25')
  await expect(page.getByLabel('Access ends')).toHaveValue('09:25')
  await page.getByRole('button', { name: 'Prepare proposal' }).click()

  await expect.poll(() => requestBodies).toHaveLength(1)
  expect(requestBodies[0]).toMatchObject({
    constraints: {
      accessWindowStart: '09:00',
      accessWindowEnd: '09:25',
      serviceHatchOnly: true,
      residentialHatchMustRemainLocked: true,
      finalServiceHatchState: 'locked',
    },
  })
  await expect(
    page.getByRole('button', { name: 'Reject proposal and edit settings' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Reject proposal and edit settings' }).click()
  await expect
    .poll(() => decisionBodies)
    .toEqual([{ nonce: 'nonce_from_server', decision: 'reject' }])
  await expect(page.getByLabel('Access starts')).toHaveValue('09:00')
  await expect(page.getByText('Choose the outcome. Review the plan before Pal acts.')).toBeVisible()
})

test('replays a lost proposal response only with the original request ID', async ({ page }) => {
  const missionBodies: unknown[] = []
  await mockApprovalLifecycle(page, [], missionBodies, { failFirstMissionCreate: true })

  await openHaulerAutomation(page)
  await page.getByRole('button', { name: 'Prepare proposal' }).click()

  await expect(page.getByText('Outcome unknown')).toBeVisible()
  await page.getByRole('button', { name: 'Retry the same request' }).click()
  await expect(page.getByRole('button', { name: 'Approve proposal' })).toBeVisible()
  expect(missionBodies).toHaveLength(2)
  expect((missionBodies[0] as { requestId: string }).requestId).toBe(
    (missionBodies[1] as { requestId: string }).requestId,
  )
})

test('reconciles a lost rejection response before offering another decision', async ({ page }) => {
  const decisionBodies: unknown[] = []
  await mockApprovalLifecycle(page, decisionBodies, [], {
    abortApprovalDecision: true,
    failFirstProgressRead: true,
  })

  await openHaulerAutomation(page)
  await page.getByRole('button', { name: 'Prepare proposal' }).click()
  await page.getByRole('button', { name: 'Reject proposal', exact: true }).click()

  await expect(page.getByText('Outcome unknown')).toBeVisible()
  await expect(page.getByText('Proposal could not continue')).toHaveCount(0)
  await page.getByRole('button', { name: 'Check the current request' }).click()
  await expect(page.getByRole('button', { name: 'Approve proposal' })).toBeVisible()
  expect(decisionBodies).toEqual([{ nonce: 'nonce_from_server', decision: 'reject' }])
})

test('reconciles a lost clarification-answer response before asking again', async ({ page }) => {
  const answerBodies: unknown[] = []
  await mockApprovalLifecycle(page, [], [], {
    taskKind: 'clarification',
    abortClarificationAnswer: true,
    failFirstProgressRead: true,
    answerBodies,
  })

  await openHaulerAutomation(page)
  await page.getByRole('button', { name: 'Prepare proposal' }).click()
  await page.getByRole('button', { name: 'Energy first' }).click()

  await expect(page.getByText('Outcome unknown')).toBeVisible()
  await expect(page.getByText('Proposal could not continue')).toHaveCount(0)
  await page.getByRole('button', { name: 'Check the current request' }).click()
  await expect(page.getByText('Pal needs one decision')).toBeVisible()
  expect(answerBodies).toEqual([{ choiceId: 'energy_first', expectedMissionVersion: 1 }])
})

test('reopens a durable review from the Palace workspace without creating another request', async ({
  page,
}) => {
  const missionBodies: unknown[] = []
  await mockApprovalLifecycle(page, [], missionBodies, {
    attention: [
      {
        kind: 'approval',
        missionId: 'mis_hauler',
        label: 'A Scheduled Hauler Access proposal is ready for your review.',
        createdAt: '2026-07-16T12:00:00.000Z',
      },
    ],
    resumePending: true,
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Review proposal' }).click()

  await expect(page).toHaveURL(/\/automations\/scheduled_hauler_access\?mission=mis_hauler$/)
  await expect(page.getByRole('button', { name: 'Approve proposal' })).toBeVisible()
  expect(missionBodies).toEqual([])
})

test('opens a durable request from Activity instead of leaving its row as display-only', async ({
  page,
}) => {
  await mockApprovalLifecycle(page, [], [], {
    activity: [
      {
        id: 'act_hauler',
        missionId: 'mis_hauler',
        summary: 'Scheduled Hauler Access is checking the service hatch.',
        status: 'checking_result',
        occurredAt: '2026-07-16T12:00:00.000Z',
      },
    ],
  })

  await page.goto('/activity')
  await page
    .getByRole('button', {
      name: 'View request: Scheduled Hauler Access is checking the service hatch.',
    })
    .click()

  await expect(page).toHaveURL(/\/automations\/scheduled_hauler_access\?mission=mis_hauler$/)
  await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop this request' })).toBeVisible()
})

async function openHaulerAutomation(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Review and customize Scheduled Hauler Access' }).click()
  await expect(page).toHaveURL(/\/automations\/scheduled_hauler_access$/)
}

async function mockApprovalLifecycle(
  page: Page,
  decisionBodies: unknown[] = [],
  missionBodies: unknown[] = [],
  options: {
    readonly attention?: readonly unknown[]
    readonly activity?: readonly unknown[]
    readonly resumePending?: boolean
    readonly noTaskInitially?: boolean
    readonly taskKind?: 'approval' | 'clarification'
    readonly failFirstMissionCreate?: boolean
    readonly abortApprovalDecision?: boolean
    readonly abortClarificationAnswer?: boolean
    readonly failFirstProgressRead?: boolean
    readonly answerBodies?: unknown[]
    readonly cancellationBodies?: unknown[]
    readonly enforceLatestSessionForCancellation?: boolean
    readonly failCancellation?: boolean
    readonly postMissionWorkspaceReads?: { count: number }
  } = {},
) {
  const taskKind = options.taskKind ?? 'approval'
  let missionCreateRequests = 0
  await page.route('**/api/v1/palaces/**/workspace', async (route) => {
    if (missionCreateRequests > 0 && options.postMissionWorkspaceReads !== undefined) {
      options.postMissionWorkspaceReads.count += 1
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 'palace-workspace@1',
        member: {
          id: 'usr_e2e_workspace',
          organizationId: 'org_e2e_workspace',
          displayName: 'Rocky',
          role: 'owner',
          grants: [],
        },
        palace: {
          id: 'pal_e2e_workspace',
          organizationId: 'org_e2e_workspace',
          name: 'Rocky’s Palace',
          timezone: 'America/New_York',
        },
        presentation: {
          observedAt: '2026-07-16T12:00:00.000Z',
          timezone: 'America/New_York',
          dayPeriod: 'morning',
        },
        attention: options.attention ?? [],
        capabilityIdeas: [
          {
            programKind: 'night_shift_homecoming',
            label: 'Night Shift Homecoming',
            description: 'Prepare the Palace for a verified arrival.',
            availability: 'ready',
            requiredCapabilities: ['temperature_target'],
          },
          {
            programKind: 'scheduled_hauler_access',
            label: 'Scheduled Hauler Access',
            description: 'Give an assigned hauler limited service access.',
            availability: 'ready',
            requiredCapabilities: ['service_hatch'],
          },
        ],
        activeAutomations: [],
        activity: options.activity ?? [],
      }),
    })
  })
  let latestSessionToken = 'csrf_test'
  let issuedSessions = 0
  await page.route('**/api/v1/auth/dev-session', async (route) => {
    issuedSessions += 1
    latestSessionToken =
      options.enforceLatestSessionForCancellation === true
        ? `csrf_test_${issuedSessions}`
        : 'csrf_test'
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ session: { csrfToken: latestSessionToken } }),
    })
  })
  await page.route('**/api/v1/missions', async (route) => {
    missionCreateRequests += 1
    missionBodies.push(route.request().postDataJSON())
    if (options.failFirstMissionCreate === true && missionCreateRequests === 1) {
      await route.abort('failed')
      return
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        result: 'created',
        mission: {
          id: 'mis_hauler',
          palaceId: 'pal_test',
          objective: 'Allow the assigned collection team to use only the service hatch.',
          state: { status: 'queued' },
          version: 0,
          createdAt: '2026-07-16T12:00:00.000Z',
        },
      }),
    })
  })
  await page.route('**/api/v1/missions/mis_hauler/tasks', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mission: { id: 'mis_hauler', state: { status: 'awaiting_human' }, version: 1 },
        clarification:
          options.noTaskInitially === true
            ? null
            : taskKind === 'clarification'
              ? { id: 'clr_hauler', status: 'pending' }
              : null,
        approval:
          options.noTaskInitially !== true && taskKind === 'approval'
            ? {
                id: 'apr_hauler',
                planId: 'pln_hauler',
                status: 'pending',
                expiresAt: '2026-07-17T12:00:00.000Z',
              }
            : null,
      }),
    }),
  )
  let progressReads = 0
  let stopped = false
  await page.route('**/api/v1/missions/mis_hauler/progress', async (route) => {
    progressReads += 1
    if (options.failFirstProgressRead === true && progressReads === 1) {
      await route.abort('failed')
      return
    }
    const pending =
      !stopped && (options.resumePending === true || options.failFirstProgressRead === true)
    const pendingTask =
      taskKind === 'approval'
        ? {
            kind: 'approval' as const,
            approvalId: 'apr_hauler',
            planId: 'pln_hauler',
            expiresAt: '2026-07-17T12:00:00.000Z',
          }
        : { kind: 'clarification' as const, requestId: 'clr_hauler' }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 'mission-progress@1',
        mission: {
          id: 'mis_hauler',
          palaceId: 'pal_test',
          organizationId: 'org_test',
          programKind: 'scheduled_hauler_access',
          objective: 'Allow the assigned collection team to use only the service hatch.',
          state: pending
            ? { status: 'waiting_for_user', phase: taskKind === 'approval' ? 'approve' : 'clarify' }
            : { status: 'waiting_for_system', phase: 'observe' },
          version: pending ? 1 : 2,
        },
        displayState: stopped
          ? 'cancelled'
          : pending
            ? taskKind === 'approval'
              ? 'needs_approval'
              : 'needs_input'
            : 'checking_result',
        pendingTask: pending ? pendingTask : null,
        operation:
          pending || stopped
            ? null
            : { id: 'op_hauler', missionId: 'mis_hauler', status: 'pending' },
        verification: null,
        allowedNextActions: pending
          ? taskKind === 'approval'
            ? ['approve_proposal', 'reject_proposal']
            : ['answer_clarification']
          : ['view_activity'],
        observedAt: '2026-07-16T12:00:01.000Z',
      }),
    })
  })
  await page.route('**/api/v1/tools/missions.cancel', async (route) => {
    options.cancellationBodies?.push(route.request().postDataJSON())
    if (
      options.enforceLatestSessionForCancellation === true &&
      route.request().headers()['x-csrf-token'] !== latestSessionToken
    ) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'MUTATION_GUARD_REJECTED' }),
      })
      return
    }
    if (options.failCancellation === true) {
      await route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: JSON.stringify({ code: 'CANCELLATION_UNAVAILABLE' }),
      })
      return
    }
    stopped = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 'tool-result@1',
        toolName: 'missions.cancel',
        callId: route.request().headers()['idempotency-key'],
        status: 'succeeded',
        retryable: false,
        receiptId: 'rcp_cancel_e2e_001',
        resourceVersion: 2,
        error: null,
        data: { missionId: 'mis_hauler', state: { status: 'cancelled', phase: 'cancelled' } },
      }),
    })
  })
  await page.route('**/api/v1/approvals/apr_hauler/decision', async (route) => {
    const body = route.request().postDataJSON()
    decisionBodies.push(body)
    if (options.abortApprovalDecision === true) {
      await route.abort('failed')
      return
    }
    const rejected = body.decision === 'reject'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        decision: rejected ? 'rejected' : 'approved',
        approval: { id: 'apr_hauler', status: rejected ? 'rejected' : 'approved' },
        operations: rejected ? [] : [{ id: 'op_hauler', status: 'pending' }],
        mission: { id: 'mis_hauler', state: { status: rejected ? 'cancelled' : 'execute' } },
      }),
    })
  })
  await page.route('**/api/v1/approvals/apr_hauler', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        approval: {
          id: 'apr_hauler',
          missionId: 'mis_hauler',
          planId: 'pln_hauler',
          status: 'pending',
          nonce: 'nonce_from_server',
          protectedResources: ['device:residential-hatch'],
          expiresAt: '2026-07-17T12:00:00.000Z',
        },
        plan: {
          id: 'pln_hauler',
          revision: 4,
          hash: 'a'.repeat(64),
          status: 'proposed',
          objective: 'Allow the assigned collection team to use only the service hatch.',
          constraints: {
            serviceHatchOnly: true,
            residentialHatchMustRemainLocked: true,
          },
          actions: [],
          successCriteriaIds: ['service-hatch-relocked'],
        },
        mission: { id: 'mis_hauler', state: { status: 'awaiting_human' }, version: 1 },
      }),
    })
  })
  await page.route('**/api/v1/clarifications/clr_hauler/answer', async (route) => {
    options.answerBodies?.push(route.request().postDataJSON())
    if (options.abortClarificationAnswer === true) {
      await route.abort('failed')
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result: 'answered',
        request: { id: 'clr_hauler', status: 'answered' },
        answer: { choiceId: 'energy_first' },
        mission: { id: 'mis_hauler', state: { status: 'understand' }, version: 2 },
      }),
    })
  })
  await page.route('**/api/v1/clarifications/clr_hauler', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        request: {
          id: 'clr_hauler',
          missionId: 'mis_hauler',
          question: 'Which priority should Pal use for this request?',
          choices: [
            {
              id: 'energy_first',
              label: 'Energy first',
              description: 'Keep the energy budget ahead of arrival comfort.',
            },
          ],
          status: 'pending',
        },
        mission: { id: 'mis_hauler', state: { status: 'awaiting_human' }, version: 1 },
      }),
    })
  })
}
