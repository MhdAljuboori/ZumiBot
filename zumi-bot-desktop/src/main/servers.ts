import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isThemePref, type ThemePref } from '@zumibot/shared/types'

// Fixed so webhook URLs survive restarts.
export const DEFAULT_LOCAL_PORT = 4318

export type ServerChoice = { kind: 'local'; port: number } | { kind: 'vps'; url: string }

const LOOPBACK = new Set(['127.0.0.1', 'localhost'])

// Windows runs the server natively (named pipes, taskkill trees). ZUMIBOT_LOCAL_WSL=1 still starts it inside WSL2 instead
// (wslLaunch.ts), for a user whose agents and tools live there.
export const localRunsInWsl = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean =>
  platform === 'win32' && env['ZUMIBOT_LOCAL_WSL'] === '1'

type ParseOptions = { allowLoopbackHttp?: boolean }

/** A vps url is a bare origin: https, or http on loopback when allowLoopbackHttp (unpackaged dev only). */
export function parseServerChoice(raw: unknown, o: ParseOptions = {}): ServerChoice | null {
  if (!raw || typeof raw !== 'object') return null
  const { kind, url, port } = raw as { kind?: unknown; url?: unknown; port?: unknown }
  if (kind === 'local') {
    if (port === undefined) return { kind: 'local', port: DEFAULT_LOCAL_PORT }
    return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535 ? { kind: 'local', port } : null
  }
  if (kind !== 'vps' || typeof url !== 'string') return null
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  const loopbackHttp = o.allowLoopbackHttp === true && u.protocol === 'http:' && LOOPBACK.has(u.hostname)
  if (u.protocol !== 'https:' && !loopbackHttp) return null
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null
  return { kind: 'vps', url: u.origin }
}

// server.json holds the choice and the last theme; each save keeps the other's fields.
function readRaw(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeRaw(file: string, data: Record<string, unknown>): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  renameSync(tmp, file)
}

export function loadServerChoice(file: string, o: ParseOptions = {}): ServerChoice | null {
  const { kind, url, port } = readRaw(file)
  return parseServerChoice({ kind, url, port }, o)
}

export function saveServerChoice(file: string, c: ServerChoice): void {
  const { lastTheme } = readRaw(file)
  const next: Record<string, unknown> = { ...c }
  if (lastTheme !== undefined) next['lastTheme'] = lastTheme
  writeRaw(file, next)
}

export function loadLastTheme(file: string): ThemePref | null {
  const { lastTheme } = readRaw(file)
  return isThemePref(lastTheme) ? lastTheme : null
}

export function saveLastTheme(file: string, theme: ThemePref): void {
  writeRaw(file, { ...readRaw(file), lastTheme: theme })
}
