import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerMode } from '@zumibot/shared/types'

export interface Config {
  mode: ServerMode
  port: number
  dataDir: string
  // Outside dataDir on purpose: a copy or sync of the data folder must not carry the key with it.
  vaultKeyFile: string
  agentsDir: string
  webDir: string
  // vps: the public https origin. local: '' until the server is listening, then http://127.0.0.1:<port>.
  origin: string
  localSecret: string | null
  migrateFrom: string | null
}

const LOCAL_SECRET_MIN = 32

// Errors name the variable, never its value: a bad value may be a secret.
function fail(name: string, problem: string): never {
  throw new Error(`${name} ${problem}`)
}

const val = (env: NodeJS.ProcessEnv, name: string): string | undefined => (env[name] === '' ? undefined : env[name])

/** Also used by the CLI, which needs the data dir but no origin. */
export function resolveDataDir(env: NodeJS.ProcessEnv): string {
  const explicit = val(env, 'ZUMIBOT_DATA_DIR')
  if (explicit) return explicit
  const home = val(env, 'HOME') ?? homedir()
  const xdg = val(env, 'XDG_DATA_HOME')
  // The XDG spec says a relative XDG_DATA_HOME must be ignored.
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share'), 'zumibot')
}

// Mirrored in deploy/config.mjs (sync.test.ts checks both give the same answer).
const VAULT_KEY_DIR_PROBLEM =
  'must be in a folder of its own, since agents are denied that whole folder: use a folder only for the vault key, with "vault" in its name, such as ~/.config/zumibot-vault'
const SHARED_DIRS = ['/', '/etc', '/tmp', '/var/tmp']

/**
 * The vault guard denies agents the key's whole folder (vaultGuard.ts), so a shared one would lock them out of it:
 * a home or anything above it, a temp or system folder, one holding the data folder (each chat's CLI temp folder is in it),
 * or any folder whose name does not say it is for the vault or the app.
 */
function dedicatedKeyDir(dir: string, home: string, data: string): boolean {
  const holds = (outer: string, inner: string) => inner === outer || inner.startsWith(outer === sep ? sep : outer + sep)
  if ([...SHARED_DIRS, tmpdir()].some((d) => resolve(d) === dir)) return false
  if (holds(dir, home) || holds(dir, data)) return false
  return /vault|zumibot/i.test(basename(dir))
}

/** Also used by the CLI. Never inside the data dir: the key must not travel with a copy of the vault. */
export function resolveVaultKeyFile(env: NodeJS.ProcessEnv, home: string, dataDir: string): string {
  const explicit = val(env, 'ZUMIBOT_VAULT_KEY_FILE')
  if (explicit !== undefined && !isAbsolute(explicit)) fail('ZUMIBOT_VAULT_KEY_FILE', 'must be an absolute path')
  const xdg = val(env, 'XDG_CONFIG_HOME')
  const file = explicit ?? join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'zumibot-vault', 'vault.key')
  const data = resolve(dataDir)
  const full = resolve(file)
  if (full === data || full.startsWith(data + sep)) fail('ZUMIBOT_VAULT_KEY_FILE', 'must be outside the data folder')
  if (!dedicatedKeyDir(dirname(full), resolve(home), data)) fail('ZUMIBOT_VAULT_KEY_FILE', VAULT_KEY_DIR_PROBLEM)
  return full
}

function parseOrigin(raw: string, allowLoopbackHttp: boolean): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail('ZUMIBOT_ORIGIN', 'must be an https URL such as https://zumibot.example.com')
  }
  const loopback = allowLoopbackHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !loopback) fail('ZUMIBOT_ORIGIN', 'must start with https://')
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    fail('ZUMIBOT_ORIGIN', 'must be an origin only, with no path, query or credentials')
  }
  return url.origin
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const mode = val(env, 'ZUMIBOT_MODE') ?? 'vps'
  if (mode !== 'vps' && mode !== 'local') fail('ZUMIBOT_MODE', 'must be "vps" or "local"')

  const portRaw = val(env, 'ZUMIBOT_PORT')
  const port = portRaw === undefined ? (mode === 'vps' ? 4317 : 0) : Number(portRaw)
  if (!/^\d+$/.test(portRaw ?? '0') || !Number.isInteger(port) || port < 0 || port > 65535) {
    fail('ZUMIBOT_PORT', 'must be a port number from 0 to 65535')
  }

  const home = val(env, 'HOME') ?? homedir()
  let origin = ''
  let localSecret: string | null = null
  let migrateFrom: string | null = null
  if (mode === 'vps') {
    const raw = val(env, 'ZUMIBOT_ORIGIN')
    if (!raw) fail('ZUMIBOT_ORIGIN', 'is required in vps mode')
    // http://127.0.0.1 only for the e2e harness, which has no TLS.
    origin = parseOrigin(raw, env.NODE_ENV === 'test')
    if (val(env, 'ZUMIBOT_MIGRATE_FROM')) fail('ZUMIBOT_MIGRATE_FROM', 'is only allowed in local mode')
  } else {
    const secret = val(env, 'ZUMIBOT_LOCAL_SECRET')
    if (!secret) fail('ZUMIBOT_LOCAL_SECRET', 'is required in local mode')
    if (secret.length < LOCAL_SECRET_MIN) fail('ZUMIBOT_LOCAL_SECRET', `must be at least ${LOCAL_SECRET_MIN} characters`)
    localSecret = secret
    migrateFrom = val(env, 'ZUMIBOT_MIGRATE_FROM') ?? null
  }

  const dataDir = resolveDataDir(env)
  return {
    mode,
    port,
    dataDir,
    vaultKeyFile: resolveVaultKeyFile(env, home, dataDir),
    agentsDir: val(env, 'ZUMIBOT_AGENTS_DIR') ?? join(home, '.claude', 'agents'),
    webDir: val(env, 'ZUMIBOT_WEB_DIR') ?? join(dirname(fileURLToPath(import.meta.url)), 'web'),
    origin,
    localSecret,
    migrateFrom
  }
}
