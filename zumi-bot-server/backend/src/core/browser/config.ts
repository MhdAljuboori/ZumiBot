import { isAbsolute } from 'node:path'
import type { BrowserConfig } from '@zumibot/shared/browser'

export type { BrowserConfig } from '@zumibot/shared/browser'

export function loadBrowserConfig(env: NodeJS.ProcessEnv): BrowserConfig {
  const integer = (name: string, fallback: number, max: number): number => {
    const variable = `ZUMIBOT_BROWSER_${name}`
    const raw = env[variable]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > max) {
      throw new Error(`${variable} must be a positive bounded integer`)
    }
    return value
  }
  const executablePath = env.ZUMIBOT_BROWSER_EXECUTABLE_PATH || null
  if (executablePath && (!isAbsolute(executablePath) || executablePath.length > 4096 || executablePath.includes('\0'))) {
    throw new Error('ZUMIBOT_BROWSER_EXECUTABLE_PATH must be an absolute executable path')
  }
  return {
    maxBrowsers: integer('MAX_BROWSERS', 2, 32),
    maxTabs: integer('MAX_TABS', 4, 32),
    idleMs: integer('IDLE_MS', 120000, 86400000),
    leaseIdleMs: integer('LEASE_IDLE_MS', 120000, 86400000),
    handoffIdleMs: integer('HANDOFF_IDLE_MS', 600000, 86400000),
    commandMs: integer('COMMAND_MS', 30000, 86400000),
    queueMs: integer('QUEUE_MS', 120000, 86400000),
    fps: integer('FPS', 10, 10),
    width: integer('WIDTH', 1280, 1920),
    height: integer('HEIGHT', 800, 1080),
    scale: integer('SCALE', 2, 2),
    executablePath
  }
}
