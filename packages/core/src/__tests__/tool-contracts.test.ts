import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  TOOL_REGISTRY,
  TOOL_REGISTRY_HASH,
  TOOL_SCHEMA_PROJECTIONS,
  ToolCallReceiptSchema,
  type ToolInput,
  type ToolInputPayload,
  type ToolOutput,
  type ToolResult,
  hashToolResultSchema,
  hashToolValue,
  parseToolInput,
  parseToolOutput,
  parseToolResult,
  projectToolRegistry,
  projectToolResultSchema,
  projectToolSchema,
} from '../index.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const HASH_E = 'e'.repeat(64)

describe('typed tool contracts', () => {
  it('returns the selected normalized input type and applies schema defaults', () => {
    const payload: ToolInputPayload<'knowledge.search'> = {
      query: 'safe homecoming routine',
      phase: 'understand',
    }
    const parsed = parseToolInput('knowledge.search', payload)

    expectTypeOf(parsed).toEqualTypeOf<ToolInput<'knowledge.search'>>()
    expectTypeOf(parsed.limit).toEqualTypeOf<number>()
    expect(parsed.limit).toBe(6)
  })

  it('returns the selected exact output type and rejects extra output fields', () => {
    const output = parseToolOutput('plans.validate', {
      valid: true,
      checks: [
        {
          type: 'hard_invariant',
          passed: true,
          message: 'The verified-arrival condition remains mandatory.',
        },
      ],
    })

    expectTypeOf(output).toEqualTypeOf<ToolOutput<'plans.validate'>>()
    expectTypeOf<ToolOutput<'plans.validate'>>().not.toEqualTypeOf<Record<string, unknown>>()
    expect(() =>
      parseToolOutput('plans.validate', {
        ...output,
        narration: 'Trust me, this passed.',
      }),
    ).toThrow()
  })

  it('binds each result to the selected tool output at runtime and compile time', () => {
    const result = parseToolResult('plans.validate', {
      schemaVersion: 'tool-result@1',
      toolName: 'plans.validate',
      callId: 'call_validate_homecoming',
      status: 'succeeded',
      retryable: false,
      data: { valid: true, checks: [] },
      receiptId: 'rcp_validate_homecoming',
      resourceVersion: 3,
      error: null,
    })

    expectTypeOf(result).toEqualTypeOf<ToolResult<'plans.validate'>>()
    if (result.status === 'succeeded') {
      expectTypeOf(result.data).toEqualTypeOf<ToolOutput<'plans.validate'>>()
      expect(result.data.valid).toBe(true)
    }

    expect(() =>
      parseToolResult('plans.validate', {
        schemaVersion: 'tool-result@1',
        toolName: 'plans.validate',
        callId: 'call_validate_homecoming',
        status: 'succeeded',
        retryable: false,
        data: { arbitrary: 'model-authored output' },
        receiptId: 'rcp_validate_homecoming',
        resourceVersion: null,
        error: null,
      }),
    ).toThrow()
    expect(() =>
      parseToolResult('plans.validate', {
        schemaVersion: 'tool-result@1',
        toolName: 'palaces.get',
        callId: 'call_validate_homecoming',
        status: 'unknown',
        retryable: false,
        data: null,
        receiptId: 'rcp_validate_homecoming',
        resourceVersion: null,
        error: null,
      }),
    ).toThrow()
  })

  it('publishes route and MCP hints from the same permission-bearing contract', () => {
    expect(TOOL_REGISTRY['palaces.get']).toMatchObject({
      permission: 'palace:read',
      route: {
        method: 'POST',
        path: '/api/v1/tools/palaces.get',
        authentication: 'session_or_bearer',
      },
      mcp: {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    })
    expect(TOOL_REGISTRY['plans.activate'].mcp.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(TOOL_REGISTRY['plans.validate'].mcp.annotations.readOnlyHint).toBe(false)
    expect(TOOL_REGISTRY['plans.simulate'].mcp.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    })
  })
})

describe('deterministic tool projections', () => {
  it('freezes a stable registry hash over sorted schema and transport projections', () => {
    const regenerated = projectToolRegistry()

    expect(regenerated).toEqual(TOOL_SCHEMA_PROJECTIONS)
    expect(regenerated.map((contract) => contract.name)).toEqual(
      regenerated.map((contract) => contract.name).toSorted(),
    )
    expect(regenerated).toHaveLength(15)
    expect(TOOL_REGISTRY_HASH).toBe(
      'dbef1bf6f07ff52178b334e27584a13aabc737a93fe5aafc1bd334b6f96f0797',
    )
    expect(regenerated.every((contract) => contract.inputSchemaHash.length === 64)).toBe(true)
    expect(regenerated.every((contract) => contract.outputSchemaHash.length === 64)).toBe(true)
    expect(new Set(regenerated.map((contract) => contract.contractHash))).toHaveLength(15)
  })

  it('hashes canonical tool values independently of object insertion order', () => {
    expect(hashToolValue({ name: 'plans.validate', revision: 3 })).toBe(
      hashToolValue({ revision: 3, name: 'plans.validate' }),
    )
    expect(() => hashToolValue({ unsafe: undefined })).toThrow()
  })

  it('projects strict JSON Schemas without executable Zod objects', () => {
    const validation = TOOL_SCHEMA_PROJECTIONS.find(
      (contract) => contract.name === 'plans.validate',
    )

    expect(validation).toBeDefined()
    expect(validation?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
    expect(validation?.outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
    expect(JSON.stringify(validation)).not.toContain('_zod')
  })

  it('pins the complete result envelope independently from the output schema', () => {
    const schema = projectToolResultSchema('plans.validate')
    const oneOf =
      typeof schema === 'object' && schema !== null && !Array.isArray(schema) ? schema.oneOf : null

    expect(Array.isArray(oneOf)).toBe(true)
    expect(JSON.stringify(schema)).toContain('tool-result@1')
    expect(hashToolResultSchema('plans.validate')).toHaveLength(64)
    expect(hashToolResultSchema('plans.validate')).not.toBe(
      projectToolSchema('plans.validate').outputSchemaHash,
    )
  })
})

describe('safe tool receipts', () => {
  const receipt = {
    schemaVersion: 'tool-call-receipt@1',
    id: 'rcp_validate_homecoming',
    callId: 'call_validate_homecoming',
    toolName: 'plans.validate',
    status: 'succeeded',
    channel: 'mcp',
    tenantScopeHash: HASH_A,
    inputHash: HASH_B,
    resultHash: HASH_C,
    toolContractHash: HASH_D,
    toolRegistryHash: HASH_E,
    attemptId: null,
    evidenceIds: ['evd_validation_record'],
    startedAt: '2026-07-15T07:30:00Z',
    completedAt: '2026-07-15T07:30:00.125Z',
  } as const

  it('retains hashes, status, channel, references, and ordered timestamps without raw tenant data', () => {
    const parsed = ToolCallReceiptSchema.parse(receipt)

    expect(parsed).toEqual(receipt)
    expect(parsed).not.toHaveProperty('organizationId')
    expect(parsed).not.toHaveProperty('actorId')
    expect(parsed).not.toHaveProperty('input')
    expect(parsed).not.toHaveProperty('output')
  })

  it('rejects raw tenant fields, duplicate evidence references, and reversed timestamps', () => {
    expect(
      ToolCallReceiptSchema.safeParse({ ...receipt, organizationId: 'org_rocky_roost' }).success,
    ).toBe(false)
    expect(
      ToolCallReceiptSchema.safeParse({
        ...receipt,
        evidenceIds: ['evd_validation_record', 'evd_validation_record'],
      }).success,
    ).toBe(false)
    expect(
      ToolCallReceiptSchema.safeParse({
        ...receipt,
        completedAt: '2026-07-15T07:29:59Z',
      }).success,
    ).toBe(false)
  })
})
