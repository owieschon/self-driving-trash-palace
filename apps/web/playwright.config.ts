import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:3210',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'pnpm --filter @trash-palace/web build && pnpm --filter @trash-palace/web start --port 3210',
    url: 'http://127.0.0.1:3210',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
