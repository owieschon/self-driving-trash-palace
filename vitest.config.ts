import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: false,
    },
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.{ts,tsx}',
      'evals/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    passWithNoTests: false,
  },
})
