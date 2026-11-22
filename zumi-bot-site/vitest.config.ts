import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'zumi-bot-site',
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
