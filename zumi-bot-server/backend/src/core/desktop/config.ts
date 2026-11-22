import type { DesktopConfig } from '@zumibot/shared/desktop'

export type { DesktopConfig } from '@zumibot/shared/desktop'

const DAY_MS = 86400000

/** Spec defaults: idle is longer than the browser's, since stopping a desktop closes the agent's open apps. */
export function loadDesktopConfig(env: NodeJS.ProcessEnv): DesktopConfig {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const variable = `ZUMIBOT_DESKTOP_${name}`
    const raw = env[variable]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    // The message names the variable and its bounds only: a misplaced secret must not reach the log.
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${variable} must be an integer from ${min} to ${max}`)
    }
    return value
  }
  return {
    max: integer('MAX', 2, 1, 8),
    idleMs: integer('IDLE_MS', 900000, 1, DAY_MS),
    leaseIdleMs: integer('LEASE_IDLE_MS', 120000, 1, DAY_MS),
    handoffIdleMs: integer('HANDOFF_IDLE_MS', 600000, 1, DAY_MS),
    commandMs: integer('COMMAND_MS', 30000, 1, DAY_MS),
    queueMs: integer('QUEUE_MS', 120000, 1, DAY_MS),
    width: integer('WIDTH', 1280, 640, 1920),
    height: integer('HEIGHT', 800, 480, 1080)
  }
}
