import type { MissionExecutionContext } from '@trash-palace/application'
import {
  MissionIdSchema,
  ToolCallIdSchema,
  ToolNameSchema,
  parseToolInput,
  parseToolResult,
  type MissionId,
  type ToolInputPayload,
  type ToolName,
  type ToolResult,
} from '@trash-palace/core'

export interface InProcessDispatcherPort {
  invoke(
    request: Readonly<{ callId: string; toolName: ToolName; input: unknown }>,
    host: Readonly<{
      authentication: MissionExecutionContext
      missionId: MissionId
      channel: 'in_process'
      signal: AbortSignal
    }>,
  ): Promise<unknown>
}

export class InProcessToolAdapter {
  readonly #missionId: MissionId

  public constructor(
    private readonly dependencies: Readonly<{
      dispatcher: InProcessDispatcherPort
      authentication: MissionExecutionContext
      missionId: string
      signal?: AbortSignal
    }>,
  ) {
    this.#missionId = MissionIdSchema.parse(dependencies.missionId)
  }

  public async invoke<Name extends ToolName>(request: {
    readonly callId: string
    readonly toolName: Name
    readonly input: ToolInputPayload<Name>
  }): Promise<ToolResult<Name>> {
    const callId = ToolCallIdSchema.parse(request.callId)
    const toolName = ToolNameSchema.parse(request.toolName) as Name
    const input = parseToolInput(toolName, request.input)
    return parseToolResult(
      toolName,
      await this.dependencies.dispatcher.invoke(
        { callId, toolName, input },
        {
          authentication: this.dependencies.authentication,
          missionId: this.#missionId,
          channel: 'in_process',
          signal: this.dependencies.signal ?? new AbortController().signal,
        },
      ),
    )
  }
}
