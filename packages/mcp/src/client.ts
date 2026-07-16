import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  MissionIdSchema,
  TOOL_REGISTRY_HASH,
  ToolNameSchema,
  hashToolValue,
  parseToolInput,
  parseToolResult,
  type ToolName,
} from '@trash-palace/core'
import { z } from 'zod'

import { MCP_MISSION_HEADER, projectMcpToolCatalog } from './contract.js'

const ACCESS_TOKEN = /^[A-Za-z0-9._~-]{20,4096}$/

export interface McpSmokeInput {
  readonly endpoint: string | URL
  readonly accessToken: string
  readonly missionId: string
  readonly invoke?: Readonly<{ toolName: ToolName; input: unknown }>
  readonly fetch?: typeof globalThis.fetch
}

export interface McpSmokeReceipt {
  readonly schemaVersion: 'mcp-smoke-receipt@1'
  readonly toolCount: 15
  readonly toolRegistryHash: typeof TOOL_REGISTRY_HASH
  readonly invokedTool: ToolName | null
  readonly resultHash: ReturnType<typeof hashToolValue> | null
  readonly resultDataHash: ReturnType<typeof hashToolValue> | null
}

export class McpClientContractError extends Error {
  override readonly name = 'McpClientContractError'
}

export async function runMcpSmoke(input: McpSmokeInput): Promise<McpSmokeReceipt> {
  const endpoint = parseEndpoint(input.endpoint)
  const missionId = MissionIdSchema.parse(input.missionId)
  if (!ACCESS_TOKEN.test(input.accessToken)) throw new TypeError('MCP access token is invalid')
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        [MCP_MISSION_HEADER]: missionId,
      },
    },
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  })
  const client = new Client({ name: 'trash-palace-smoke-client', version: '0.0.0' })

  try {
    // SDK 1.29 declares sessionId differently on the concrete and base transport under exact optionals.
    await client.connect(transport as Transport)
    const listing = await client.listTools()
    assertExactToolCatalog(listing.tools)

    let invokedTool: ToolName | null = null
    let resultHash: ReturnType<typeof hashToolValue> | null = null
    let resultDataHash: ReturnType<typeof hashToolValue> | null = null
    if (input.invoke !== undefined) {
      invokedTool = ToolNameSchema.parse(input.invoke.toolName)
      const toolInput = parseToolInput(invokedTool, input.invoke.input)
      const response = CallToolResultSchema.parse(
        await client.callTool({
          name: invokedTool,
          arguments: z.record(z.string(), z.unknown()).parse(toolInput),
        }),
      )
      const result = parseToolResult(invokedTool, response.structuredContent)
      resultHash = hashToolValue(result)
      resultDataHash = hashToolValue(result.data)
    }

    return {
      schemaVersion: 'mcp-smoke-receipt@1',
      toolCount: 15,
      toolRegistryHash: TOOL_REGISTRY_HASH,
      invokedTool,
      resultHash,
      resultDataHash,
    }
  } finally {
    await client.close()
  }
}

function assertExactToolCatalog(tools: readonly unknown[]): void {
  const catalog = z
    .array(
      z
        .object({
          name: ToolNameSchema,
          title: z.string(),
          description: z.string(),
          inputSchema: z.record(z.string(), z.unknown()),
          outputSchema: z.record(z.string(), z.unknown()),
          annotations: z
            .object({
              readOnlyHint: z.boolean(),
              destructiveHint: z.boolean(),
              idempotentHint: z.boolean(),
              openWorldHint: z.boolean(),
            })
            .strict(),
        })
        .loose(),
    )
    .parse(tools)
  const expectedNames = [...ToolNameSchema.options].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  const expectedCatalog = projectMcpToolCatalog()
  if (catalog.length !== expectedNames.length) throw catalogMismatch()

  for (const [index, name] of expectedNames.entries()) {
    const actual = catalog[index]
    const expected = expectedCatalog[index]
    if (
      actual === undefined ||
      expected === undefined ||
      actual.name !== name ||
      actual.title !== expected.title ||
      actual.description !== expected.description ||
      hashToolValue(actual.inputSchema) !== hashToolValue(expected.inputSchema) ||
      hashToolValue(actual.outputSchema) !== hashToolValue(expected.outputSchema) ||
      hashToolValue(actual.annotations) !== hashToolValue(expected.annotations)
    ) {
      throw catalogMismatch()
    }
  }
}

function catalogMismatch(): McpClientContractError {
  return new McpClientContractError('MCP tool catalog does not match the canonical registry')
}

function parseEndpoint(input: string | URL): URL {
  const endpoint = new URL(input)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hash !== '' ||
    endpoint.search !== ''
  ) {
    throw new TypeError('MCP endpoint must be an HTTP URL without credentials, query, or fragment')
  }
  if (endpoint.protocol === 'http:' && !isLoopbackHostname(endpoint.hostname)) {
    throw new TypeError('Plain HTTP MCP endpoints must use a loopback host; use HTTPS otherwise')
  }
  return endpoint
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255)
  )
}
