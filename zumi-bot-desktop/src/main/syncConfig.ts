import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveDataDir } from '@zumibot/backend/config'
// @ts-expect-error shared with the plain Node deployment scripts
import { parseEnvFile, SAFE_HOST, SAFE_DIR, safeKeyFile } from '../../../zumi-bot-server/deploy/config.mjs'

// VPS_VAULT_KEY_FILE is only where the VPS keeps its vault key, never the key itself.
export interface SyncConfig {
  VPS_HOST: string
  VPS_USER: string
  VPS_DIR: string
  VPS_VAULT_KEY_FILE?: string
}

export function parseSyncConfig(text: string): SyncConfig {
  const env = parseEnvFile(text) as Record<string, string>
  const { VPS_HOST = '', VPS_USER = '' } = env
  const VPS_DIR = env.VPS_DIR || `/home/${VPS_USER}/zumibot`
  if (!SAFE_HOST.test(VPS_HOST) || !SAFE_HOST.test(VPS_USER) || !SAFE_DIR.test(VPS_DIR)) {
    throw new Error('Choose a deploy.env with valid VPS_HOST, VPS_USER, and an absolute VPS_DIR.')
  }
  if (!env.VPS_VAULT_KEY_FILE) return { VPS_HOST, VPS_USER, VPS_DIR }
  if (!safeKeyFile(env.VPS_VAULT_KEY_FILE))
    throw new Error('Choose a deploy.env whose VPS_VAULT_KEY_FILE is a file under ~/ or an absolute path.')
  return { VPS_HOST, VPS_USER, VPS_DIR, VPS_VAULT_KEY_FILE: env.VPS_VAULT_KEY_FILE }
}

export function readSyncConfig(file: string): SyncConfig {
  return parseSyncConfig(readFileSync(file, 'utf8'))
}

export function saveSyncConfig(file: string, config: SyncConfig): void {
  const text = `VPS_HOST=${config.VPS_HOST}\nVPS_USER=${config.VPS_USER}\nVPS_DIR=${config.VPS_DIR}\n${config.VPS_VAULT_KEY_FILE ? `VPS_VAULT_KEY_FILE=${config.VPS_VAULT_KEY_FILE}\n` : ''}`
  parseSyncConfig(text)
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, file)
}

/** The CLI sync deliberately uses the default data folder; don't silently sync a different local installation. */
export function validateSyncDataDir(env: NodeJS.ProcessEnv): void {
  const home = env.HOME || homedir()
  if (resolve(resolveDataDir(env)) !== resolve(home, '.local/share/zumibot')) {
    throw new Error(
      'Sync uses ~/.local/share/zumibot, but this app uses another data folder. Start it with the default data folder to sync.'
    )
  }
}
