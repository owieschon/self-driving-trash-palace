import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  TOOL_REGISTRY,
  ToolNameSchema,
  projectToolResultSchema,
  projectToolSchema,
  type ToolName,
} from '@trash-palace/core'

export const MCP_MISSION_HEADER = 'x-trash-palace-mission'

export function projectMcpOutputSchema(name: ToolName): NonNullable<Tool['outputSchema']> {
  return asObjectSchema({ ...asJsonRecord(projectToolResultSchema(name)), type: 'object' })
}

export function projectMcpToolCatalog(): Tool[] {
  return [...ToolNameSchema.options]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => {
      const contract = TOOL_REGISTRY[name]
      return {
        name,
        title: contract.mcp.title,
        description: contract.mcp.description,
        inputSchema: asObjectSchema(projectToolSchema(name).inputSchema),
        outputSchema: projectMcpOutputSchema(name),
        annotations: contract.mcp.annotations,
      }
    })
}

function asObjectSchema(value: unknown): Tool['inputSchema'] {
  const record = asJsonRecord(value)
  if (record.type !== 'object') throw new TypeError('MCP tool schemas must describe objects')
  return record as Tool['inputSchema']
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('JSON Schema must be an object')
  }
  return value as Record<string, unknown>
}
