import { resolve } from 'node:path'
import { gitBashPath } from '../vault/vaultGuard'

const TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob'] as const

/**
 * The --settings JSON that keeps agents' file tools off connectors.json: only the user flips a connector switch (a speed
 * bump, not a wall, like the vault's). The CLI's //absolute form, as `vaultGuardSettings`.
 */
export function connectorsGuardSettings(file: string): string {
  // Claude Code matches Windows paths in their POSIX form (`C:\x` is `/c/x`), so the rule is `//c/x` there.
  const abs = process.platform === 'win32' ? gitBashPath(resolve(file)) : resolve(file)
  return JSON.stringify({ permissions: { deny: TOOLS.map((tool) => `${tool}(/${abs})`) } })
}
