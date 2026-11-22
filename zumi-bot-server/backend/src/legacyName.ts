import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

// The app was called ClaudeBot before 0.1.0. Its default folders are moved to the new names once, at start.
const OLD_PREFIX = 'CLAUDEBOT_'

const val = (env: NodeJS.ProcessEnv, name: string): string | undefined => (env[name] === '' ? undefined : env[name])

/** Pairs of [old, new] default folders: the data folder and the vault key's folder. */
export function legacyFolders(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const home = val(env, 'HOME') ?? homedir()
  const xdgData = val(env, 'XDG_DATA_HOME')
  const xdgConfig = val(env, 'XDG_CONFIG_HOME')
  const data = xdgData && isAbsolute(xdgData) ? xdgData : join(home, '.local', 'share')
  const config = xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(home, '.config')
  const pairs: Array<[string, string]> = []
  // Only a folder set to the default moves: one the user chose by hand is theirs to name.
  const dataDir = val(env, 'ZUMIBOT_DATA_DIR')
  if (!dataDir || resolve(dataDir) === join(data, 'zumibot')) pairs.push([join(data, 'claudebot'), join(data, 'zumibot')])
  const keyFile = val(env, 'ZUMIBOT_VAULT_KEY_FILE')
  if (!keyFile || resolve(keyFile) === join(config, 'zumibot-vault', 'vault.key')) {
    pairs.push([join(config, 'claudebot-vault'), join(config, 'zumibot-vault')])
  }
  return pairs
}

/**
 * Renames each old folder to its new name when only the old one exists, and names (never the values of) any
 * CLAUDEBOT_* settings still set, since the server now reads ZUMIBOT_* only. Never throws: a failed move is logged
 * and the server starts on an empty folder, as on a fresh install.
 */
export function migrateLegacyName(env: NodeJS.ProcessEnv, log: (line: string) => void): void {
  for (const [from, to] of legacyFolders(env)) {
    if (existsSync(to) || !existsSync(from)) continue
    try {
      renameSync(from, to)
      log(`Moved ${from} to ${to} (ClaudeBot is now ZumiBot).`)
    } catch (err) {
      log(`Could not move ${from} to ${to}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const stale = Object.keys(env).filter((k) => k.startsWith(OLD_PREFIX))
  if (stale.length) log(`Ignored ${stale.join(', ')}: rename them to ZUMIBOT_* (ClaudeBot is now ZumiBot).`)
}
