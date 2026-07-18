import type { ManagementRoutes } from './management-routes.js'
import type { InternalIngressRoutes } from './internal-ingress-routes.js'
import type { MissionProgressRoutes } from './mission-progress-route.js'
import type { PalaceWorkspaceRoutes } from './palace-workspace-route.js'
import type { HttpToolRouteDependencies } from './tool-route.js'
import { createHttpToolRoute } from './tool-route.js'
import { createMcpPostHandler, type McpServerDependencies } from '@trash-palace/mcp'

export interface HttpApiRuntime
  extends ManagementRoutes, InternalIngressRoutes, MissionProgressRoutes, PalaceWorkspaceRoutes {
  readonly invokeTool: (request: Request, toolName: string) => Promise<Response>
  readonly postMcp: (request: Request) => Promise<Response>
}

export function createHttpApiRuntime(input: {
  readonly management: ManagementRoutes
  readonly internalIngress: InternalIngressRoutes
  readonly missionProgress: MissionProgressRoutes
  readonly palaceWorkspace: PalaceWorkspaceRoutes
  readonly mcp: McpServerDependencies
  readonly tools: HttpToolRouteDependencies
}): HttpApiRuntime {
  return {
    ...input.management,
    ...input.internalIngress,
    ...input.missionProgress,
    ...input.palaceWorkspace,
    invokeTool: createHttpToolRoute(input.tools),
    postMcp: createMcpPostHandler(input.mcp),
  }
}
