import { parseToolResult, type ToolInput, type ToolName, type ToolResult } from '@trash-palace/core'

import {
  ApprovalDecisionResponseSchema,
  ApprovalTaskResponseSchema,
  BrowserSessionResponseSchema,
  DelegatedTokenResponseSchema,
  ClarificationAnswerResponseSchema,
  ClarificationTaskResponseSchema,
  CreateMissionResponseSchema,
  MissionTaskInboxResponseSchema,
  WEB_API_ROUTES,
  type ApprovalDecisionBody,
  type ClarificationAnswerBody,
  type CreateMissionBody,
  type IssueDelegatedTokenBody,
} from './api-contracts.js'
import { parseTrustedHttpOrigin } from './trusted-origin.js'

export interface BrowserRequestCredentials {
  readonly csrfToken: string
}

export class TrashPalaceApiClient {
  public constructor(
    origin: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.origin = parseTrustedHttpOrigin(origin, 'API origin')
  }

  private readonly origin: string

  public async createDevSession() {
    return BrowserSessionResponseSchema.parse(
      await this.#json(WEB_API_ROUTES.devSession.path, {
        method: WEB_API_ROUTES.devSession.method,
        body: '{}',
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  public async rotateSession(credentials: BrowserRequestCredentials) {
    return BrowserSessionResponseSchema.parse(
      await this.#browserJson(WEB_API_ROUTES.rotateSession.path, credentials, '{}'),
    )
  }

  public async logoutSession(credentials: BrowserRequestCredentials): Promise<void> {
    await this.#browserJson(WEB_API_ROUTES.logoutSession.path, credentials, '{}')
  }

  public async issueDelegatedToken(
    credentials: BrowserRequestCredentials,
    body: IssueDelegatedTokenBody,
  ) {
    return DelegatedTokenResponseSchema.parse(
      await this.#browserJson(
        WEB_API_ROUTES.issueDelegatedToken.path,
        credentials,
        JSON.stringify(body),
      ),
    )
  }

  public async createMission(credentials: BrowserRequestCredentials, body: CreateMissionBody) {
    return CreateMissionResponseSchema.parse(
      await this.#browserJson(WEB_API_ROUTES.createMission.path, credentials, JSON.stringify(body)),
    )
  }

  public async getMissionTasks(missionId: string) {
    return MissionTaskInboxResponseSchema.parse(
      await this.#json(WEB_API_ROUTES.getMissionTasks.path(missionId), {
        method: WEB_API_ROUTES.getMissionTasks.method,
      }),
    )
  }

  public async revokeDelegatedToken(
    credentials: BrowserRequestCredentials,
    tokenId: string,
  ): Promise<void> {
    await this.#json(WEB_API_ROUTES.revokeDelegatedToken.path(tokenId), {
      method: WEB_API_ROUTES.revokeDelegatedToken.method,
      headers: this.#browserHeaders(credentials),
    })
  }

  public async decideApproval(
    credentials: BrowserRequestCredentials,
    approvalId: string,
    body: ApprovalDecisionBody,
  ) {
    return ApprovalDecisionResponseSchema.parse(
      await this.#browserJson(
        WEB_API_ROUTES.decideApproval.path(approvalId),
        credentials,
        JSON.stringify(body),
      ),
    )
  }

  public async getApproval(approvalId: string) {
    return ApprovalTaskResponseSchema.parse(
      await this.#json(WEB_API_ROUTES.getApproval.path(approvalId), {
        method: WEB_API_ROUTES.getApproval.method,
      }),
    )
  }

  public async getClarification(requestId: string) {
    return ClarificationTaskResponseSchema.parse(
      await this.#json(WEB_API_ROUTES.getClarification.path(requestId), {
        method: WEB_API_ROUTES.getClarification.method,
      }),
    )
  }

  public async answerClarification(
    credentials: BrowserRequestCredentials,
    requestId: string,
    body: ClarificationAnswerBody,
  ) {
    return ClarificationAnswerResponseSchema.parse(
      await this.#browserJson(
        WEB_API_ROUTES.answerClarification.path(requestId),
        credentials,
        JSON.stringify(body),
      ),
    )
  }

  public async invokeTool<Name extends ToolName>(input: {
    readonly toolName: Name
    readonly callId: string
    readonly missionId: string
    readonly body: ToolInput<Name>
    readonly bearerToken?: string
    readonly csrfToken?: string
  }): Promise<ToolResult<Name>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': input.callId,
      'x-trash-palace-mission': input.missionId,
    }
    if (input.bearerToken !== undefined) headers.authorization = `Bearer ${input.bearerToken}`
    if (input.csrfToken !== undefined) {
      headers.origin = this.origin
      headers['x-csrf-token'] = input.csrfToken
    }
    return parseToolResult(
      input.toolName,
      await this.#json(WEB_API_ROUTES.tool.path(input.toolName), {
        method: WEB_API_ROUTES.tool.method,
        body: JSON.stringify(input.body),
        headers,
      }),
    )
  }

  #browserJson(
    path: string,
    credentials: BrowserRequestCredentials,
    body: string,
  ): Promise<unknown> {
    return this.#json(path, {
      method: 'POST',
      body,
      headers: { ...this.#browserHeaders(credentials), 'content-type': 'application/json' },
    })
  }

  #browserHeaders(credentials: BrowserRequestCredentials): Record<string, string> {
    // Browsers own the Origin header. The server validates that browser-supplied value.
    return { 'x-csrf-token': credentials.csrfToken }
  }

  async #json(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(new URL(path, this.origin), {
      ...init,
      credentials: 'same-origin',
    })
    const body = (await response.json()) as unknown
    if (!response.ok) throw new TrashPalaceApiError(response.status, body)
    return body
  }
}

export class TrashPalaceApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly problem: unknown,
  ) {
    super(`Trash Palace API request failed with status ${status}`)
    this.name = 'TrashPalaceApiError'
  }
}
