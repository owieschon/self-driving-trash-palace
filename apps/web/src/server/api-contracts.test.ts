import { TOOL_REGISTRY } from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { TrashPalaceApiClient } from './api-client.js'
import {
  HelpCatalogEntryResponseSchema,
  MissionProgressResponseSchema,
  PalaceWorkspaceResponseSchema,
  WEB_API_ROUTES,
  WEB_API_SCHEMA_PROJECTIONS,
  toolApiPath,
} from './api-contracts.js'

describe('typed API registry', () => {
  it('keeps every management operation paired with an executable contract', () => {
    expect(WEB_API_SCHEMA_PROJECTIONS.map((operation) => operation.operationId)).toEqual([
      'getHealth',
      'getReadiness',
      'createDevSession',
      'rotateSession',
      'logoutSession',
      'createMission',
      'getMissionTasks',
      'getMissionProgress',
      'getPalaceWorkspace',
      'issueDelegatedToken',
      'revokeDelegatedToken',
      'getApproval',
      'decideApproval',
      'getClarification',
      'answerClarification',
    ])
    expect(
      WEB_API_SCHEMA_PROJECTIONS.filter((operation) => operation.authentication === 'none'),
    ).toHaveLength(3)
    expect(
      WEB_API_SCHEMA_PROJECTIONS.find((operation) => operation.method === 'DELETE')
        ?.requestBodySchema,
    ).toBeNull()
  })

  it('requires one tenant-bound Palace and server presentation context', () => {
    const workspace = palaceWorkspace()

    expect(PalaceWorkspaceResponseSchema.parse(workspace)).toMatchObject({
      palace: { id: 'pal_contract_01', timezone: 'America/New_York' },
      presentation: { dayPeriod: 'evening' },
    })
    expect(
      PalaceWorkspaceResponseSchema.safeParse({
        ...workspace,
        palace: { ...workspace.palace, organizationId: 'org_other_contract' },
      }).success,
    ).toBe(false)
  })

  it('requires a real human task or retained verification for derived mission progress', () => {
    const needsApproval = missionProgress()

    expect(MissionProgressResponseSchema.parse(needsApproval).displayState).toBe('needs_approval')
    expect(
      MissionProgressResponseSchema.safeParse({
        ...needsApproval,
        displayState: 'verified',
        pendingTask: null,
      }).success,
    ).toBe(false)
    expect(
      MissionProgressResponseSchema.parse({
        ...needsApproval,
        displayState: 'verified',
        pendingTask: null,
        mission: {
          ...needsApproval.mission,
          state: { status: 'succeeded', phase: 'verify' },
        },
        verification: {
          id: 'ver_contract_01',
          missionId: 'mis_contract_01',
          status: 'passed',
          completedAt: '2026-07-16T17:00:00.000Z',
          summary: 'All approved checks passed.',
        },
        allowedNextActions: ['view_activity'],
      }).displayState,
    ).toBe('verified')
  })

  it('keeps Help catalog metadata public and task-oriented', () => {
    expect(
      HelpCatalogEntryResponseSchema.parse({
        id: 'help.approve-proposal',
        audience: ['customer', 'developer'],
        task: 'Review and approve a proposal',
        track: 'automations',
        prerequisites: ['Understand your automation limits'],
        nextStep: { label: 'Understand Pal', publicRoute: '/help/understand-pal' },
        publicRoute: '/help/manage-automations/approve-a-proposal',
        searchLabel: 'Approve a Pal proposal',
      }),
    ).toMatchObject({ track: 'automations' })
    expect(
      HelpCatalogEntryResponseSchema.safeParse({
        id: 'help.private',
        audience: ['customer'],
        task: 'Read a guide',
        track: 'start',
        prerequisites: [],
        nextStep: null,
        publicRoute: '/private/guide',
        searchLabel: 'Private guide',
      }).success,
    ).toBe(false)
  })

  it('derives every typed tool client path from the core registry', () => {
    for (const [name, contract] of Object.entries(TOOL_REGISTRY)) {
      expect(toolApiPath(name)).toBe(contract.route.path)
      expect(WEB_API_ROUTES.tool.path(name)).toBe(contract.route.path)
    }
  })

  it('uses the registry path and response schema from the typed client', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        session: {
          organizationId: 'org_client_01',
          userId: 'usr_client_01',
          role: 'owner',
          csrfToken: 'csrf_client_value_1234567890',
          expiresAt: '2026-08-14T07:00:00.000Z',
        },
      }),
    )
    const client = new TrashPalaceApiClient('http://127.0.0.1', request)

    await expect(client.createDevSession()).resolves.toMatchObject({
      session: { role: 'owner' },
    })
    expect(request).toHaveBeenCalledWith(
      new URL('http://127.0.0.1/api/v1/auth/dev-session'),
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })

  it.each([
    'http://trash-palace.example',
    'http://192.0.2.10',
    'https://operator:secret@trash-palace.example',
    'https://trash-palace.example/path',
  ])('rejects an API origin that could expose credentials or misroute requests: %s', (origin) => {
    expect(() => new TrashPalaceApiClient(origin, vi.fn())).toThrow()
  })
})

function palaceWorkspace() {
  return {
    schemaVersion: 'palace-workspace@1' as const,
    member: {
      id: 'usr_contract_01',
      organizationId: 'org_contract_01',
      displayName: 'Ari Operator',
      role: 'owner' as const,
      grants: [],
    },
    palace: {
      id: 'pal_contract_01',
      organizationId: 'org_contract_01',
      name: 'North Yard Palace',
      timezone: 'America/New_York',
    },
    presentation: {
      observedAt: '2026-07-16T17:00:00.000Z',
      timezone: 'America/New_York',
      dayPeriod: 'evening' as const,
    },
    attention: [],
    capabilityIdeas: [
      {
        programKind: 'scheduled_hauler_access' as const,
        label: 'Scheduled Hauler Access',
        description: 'Open the service hatch only for an assigned collection window.',
        availability: 'ready' as const,
        requiredCapabilities: ['service_hatch_access'],
      },
    ],
    activeAutomations: [
      {
        routineId: 'rtn_contract_01',
        programKind: 'scheduled_hauler_access' as const,
        name: 'Wednesday service access',
        version: 1,
        activeSince: '2026-07-16T16:00:00.000Z',
      },
    ],
    activity: [],
  }
}

function missionProgress() {
  return {
    schemaVersion: 'mission-progress@1' as const,
    mission: {
      id: 'mis_contract_01',
      palaceId: 'pal_contract_01',
      organizationId: 'org_contract_01',
      programKind: 'scheduled_hauler_access' as const,
      objective: 'Open the service hatch only for an assigned collection window.',
      state: { status: 'waiting_for_user' as const, phase: 'approve' as const },
      version: 2,
    },
    displayState: 'needs_approval' as const,
    pendingTask: {
      kind: 'approval' as const,
      approvalId: 'apr_contract_01',
      planId: 'pln_contract_01',
      expiresAt: '2026-07-17T17:00:00.000Z',
    },
    operation: null,
    verification: null,
    allowedNextActions: ['approve_proposal' as const, 'reject_proposal' as const],
    observedAt: '2026-07-16T17:00:00.000Z',
  }
}
