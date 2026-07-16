import type { ManagementRoutes } from './management-routes.js'
import type { InternalIngressRoutes } from './internal-ingress-routes.js'
import type { HttpToolRouteDependencies } from './tool-route.js'
import { createHttpToolRoute } from './tool-route.js'
import { createMcpPostHandler, type McpServerDependencies } from '@trash-palace/mcp'

export interface HttpApiRuntime extends ManagementRoutes, InternalIngressRoutes {
  readonly invokeTool: (request: Request, toolName: string) => Promise<Response>
  readonly postMcp: (request: Request) => Promise<Response>
}

export function createHttpApiRuntime(input: {
  readonly management: ManagementRoutes
  readonly internalIngress: InternalIngressRoutes
  readonly mcp: McpServerDependencies
  readonly tools: HttpToolRouteDependencies
}): HttpApiRuntime {
  return {
    ...input.management,
    ...input.internalIngress,
    invokeTool: createHttpToolRoute(input.tools),
    postMcp: createMcpPostHandler(input.mcp),
  }
}
