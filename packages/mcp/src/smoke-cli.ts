import { runMcpSmoke } from './client.js'

try {
  await main()
} catch {
  process.stderr.write(
    'MCP smoke failed. Check the local endpoint, mission, token scope, and server logs.\n',
  )
  process.exitCode = 1
}

async function main(): Promise<void> {
  const receipt = await runMcpSmoke({
    endpoint: requiredEnvironment('TRASH_PALACE_MCP_URL'),
    accessToken: requiredEnvironment('TRASH_PALACE_MCP_TOKEN'),
    missionId: requiredEnvironment('TRASH_PALACE_MISSION_ID'),
    invoke: {
      toolName: 'knowledge.search',
      input: { query: 'reconcile an unknown operation outcome', phase: 'reconcile' },
    },
  })
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new TypeError(`Set ${name} before running the MCP smoke client`)
  }
  return value
}
