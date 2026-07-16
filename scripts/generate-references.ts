import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

import { WEB_API_SCHEMA_PROJECTIONS } from '../apps/web/src/server/api-contracts.js'
import { MAX_JSON_BODY_BYTES, SESSION_COOKIE_NAME } from '../apps/web/src/server/http-boundary.js'
import { projectMcpToolCatalog } from '../packages/mcp/src/contract.js'
import {
  GENERATED_PUBLIC_REFERENCE_DIRECTORY,
  GENERATED_REFERENCE_DIRECTORY,
  checkGeneratedReferences,
  readGeneratedSourceDateEpoch,
  writeGeneratedReferences,
  writePublicGeneratedReferences,
} from '../packages/agent/src/reference-generator.js'

function projectJsonSchema(schema: z.ZodType): z.infer<ReturnType<typeof z.json>> {
  return z.json().parse(z.toJSONSchema(schema))
}

const arguments_ = process.argv.slice(2)
const mode =
  arguments_.length === 0
    ? 'generate'
    : arguments_.length === 1 && arguments_[0] === '--check'
      ? 'check'
      : arguments_.length === 1 && arguments_[0] === '--public'
        ? 'public'
        : undefined
if (mode === undefined) {
  throw new Error('Usage: tsx scripts/generate-references.ts [--check|--public]')
}

const repositoryRoot = process.cwd()
const outputDirectory = resolve(
  repositoryRoot,
  mode === 'public' ? GENERATED_PUBLIC_REFERENCE_DIRECTORY : GENERATED_REFERENCE_DIRECTORY,
)
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
  version?: unknown
}
if (typeof packageJson.version !== 'string') throw new Error('package.json version is missing')

const sourceDateEpoch =
  process.env.SOURCE_DATE_EPOCH ??
  (mode === 'check'
    ? await readGeneratedSourceDateEpoch(outputDirectory)
    : (() => {
        throw new Error('SOURCE_DATE_EPOCH is required when generating references')
      })())
const input = {
  sourceDateEpoch,
  applicationVersion: packageJson.version,
  httpBoundary: {
    sessionCookieName: SESSION_COOKIE_NAME,
    maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
  },
  webApiOperations: WEB_API_SCHEMA_PROJECTIONS.map((operation) => ({
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    authentication: operation.authentication,
    successStatus: operation.successStatus,
    pathParameters: operation.pathParameters.map((parameter) => ({
      name: parameter.name,
      schema: projectJsonSchema(parameter.schema),
    })),
    requestBodySchema:
      operation.requestBodySchema === null ? null : projectJsonSchema(operation.requestBodySchema),
    responseBodySchema: projectJsonSchema(operation.responseBodySchema),
  })),
  mcpTools: projectMcpToolCatalog().map((tool) => z.json().parse(tool)),
}

if (mode === 'check') {
  const receipt = await checkGeneratedReferences(outputDirectory, input)
  process.stdout.write(
    `${JSON.stringify({ status: 'current', ...receipt, directory: GENERATED_REFERENCE_DIRECTORY })}\n`,
  )
} else if (mode === 'public') {
  const generated = await writePublicGeneratedReferences(outputDirectory, input)
  process.stdout.write(
    `${JSON.stringify({
      status: 'generated-public',
      files: generated.files.size,
      manifestHash: generated.manifestHash,
      sourceDateEpoch: generated.sourceDateEpoch,
      directory: GENERATED_PUBLIC_REFERENCE_DIRECTORY,
    })}\n`,
  )
} else {
  const generated = await writeGeneratedReferences(outputDirectory, input)
  process.stdout.write(
    `${JSON.stringify({
      status: 'generated',
      files: generated.files.size,
      manifestHash: generated.manifestHash,
      sourceDateEpoch: generated.sourceDateEpoch,
      directory: GENERATED_REFERENCE_DIRECTORY,
    })}\n`,
  )
}
