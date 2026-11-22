import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'shared',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // macOS: a slow Mac takes longer than the 5 s default for the tests that spawn node processes (backend/vitest.config.ts).
    ...(process.platform === 'darwin' ? { testTimeout: 30_000, hookTimeout: 30_000 } : {})
  }
})
