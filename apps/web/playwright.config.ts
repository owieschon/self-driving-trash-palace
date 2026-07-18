import { defineConfig, devices } from '@playwright/test'

const port = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? '3210', 10)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new TypeError('PLAYWRIGHT_PORT must be a valid TCP port')

const palaceId = process.env.TRASH_PALACE_LOCAL_PALACE_ID ?? 'pal_e2e_workspace'
// Tests exercise a server-selected Palace; the browser never supplies this identifier.
process.env.TRASH_PALACE_LOCAL_PALACE_ID = palaceId

const runtimeEnvironment = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://trash_palace:test_only@127.0.0.1:1/trash_palace',
  SESSION_SIGNING_KEY: 'playwright-session-signing-key-at-least-32-bytes',
  TOOL_INVOCATION_SCOPE_KEY: 'playwright-tool-scope-key-at-least-32-bytes',
  GATEWAY_CALLBACK_SIGNING_KEY: 'playwright-gateway-callback-key-at-least-32-bytes',
  GATEWAY_CALLBACK_SIGNING_KEY_ID: 'gwk_playwright_test',
  IDENTITY_TELEMETRY_SIGNING_KEY: 'playwright-identity-telemetry-key-at-least-32-bytes',
  IDENTITY_TELEMETRY_SIGNING_KEY_ID: 'itk_playwright_test',
  IDENTITY_TELEMETRY_PRINCIPAL_ID: 'itp_playwright_test',
  TRASH_PALACE_LOCAL_ORGANIZATION_ID: 'org_e2e_workspace',
  TRASH_PALACE_LOCAL_PALACE_ID: palaceId,
  TRASH_PALACE_EVIDENCE_ALIAS_KEY: 'playwright-evidence-alias-key-at-least-32-bytes',
  TRASH_PALACE_EVIDENCE_SINK_PATH: '/tmp/trashpal-playwright-evidence.jsonl',
  TRASH_PALACE_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
  TRASH_PALACE_DEV_SESSION_ENABLED: 'false',
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm --filter @trash-palace/web build && pnpm --filter @trash-palace/web start --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: runtimeEnvironment,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
