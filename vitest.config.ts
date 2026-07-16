import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
