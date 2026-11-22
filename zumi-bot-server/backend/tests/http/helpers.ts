import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { rm } from 'node:fs/promises'
import { AuthStore } from '../../src/auth/authStore'
import { hashPassword } from '../../src/auth/password'
import type { Config } from '../../src/config'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { SnapshotStore } from '../../src/core/files/snapshotStore'
import { createHub, type ConnHandlers, type Hub } from '../../src/rpc/hub'
import { createAppServer, type AppServerOptions, type Gate } from '../../src/http/server'
import type { Handlers } from '../../src/rpc/handlers'
import { startSetupServer, type SetupServer } from '../../src/setupServer'

export const allowGate = (allow = true): Gate => ({
  authorize: async () => allow,
  originOk: async () => allow,
  handle: async () => false
})

export interface Rig {
  server: Server
  hub: Hub
  store: AttachmentStore
  snapshots: SnapshotStore
  webDir: string
  root: string
  port: number
  base: string
  close(): Promise<void>
}

let n = 0

export async function startRig(
  o: {
    gate?: Gate
    handlers?: Handlers
    pingMs?: number
    isValid?(k: string): Promise<boolean>
    closeGraceMs?: number
    connHandlers?: ConnHandlers
    onDisconnect?(id: string): void
    hooks?: AppServerOptions['hooks']
    browserHub?: AppServerOptions['browserHub']
    desktopHub?: AppServerOptions['desktopHub']
    browserFiles?: AppServerOptions['browserFiles']
    sessionKey?: AppServerOptions['sessionKey']
    voice?: AppServerOptions['voice']
    exports?: AppServerOptions['exports']
  } = {}
): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'cb-http-'))
  const webDir = join(root, 'web')
  await mkdir(join(webDir, 'assets'), { recursive: true })
  await writeFile(join(webDir, 'index.html'), '<html>app</html>')
  await writeFile(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  await writeFile(join(root, 'secret.txt'), 'secret')
  const store = new AttachmentStore(join(root, 'att'), () => `id-${++n}`)
  const snapshots = new SnapshotStore(join(root, 'snap'))
  const hub = createHub(o.handlers ?? {}, {
    pingMs: o.pingMs,
    isValid: o.isValid,
    closeGraceMs: o.closeGraceMs,
    connHandlers: o.connHandlers,
    onDisconnect: o.onDisconnect
  })
  const server = createAppServer({
    gate: o.gate ?? allowGate(),
    hub,
    attachments: store,
    snapshots,
    webDir,
    hooks: o.hooks,
    browserHub: o.browserHub,
    desktopHub: o.desktopHub,
    browserFiles: o.browserFiles,
    voice: o.voice,
    exports: o.exports,
    sessionKey: o.sessionKey ?? ((req) => String(req.headers['x-session'] ?? 'k1'))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    hub,
    store,
    snapshots,
    webDir,
    root,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => {
      hub.closeSession('all')
      hub.dispose()
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    }
  }
}

export type { IncomingMessage }

// --- the first-run setup server -------------------------------------------------------------------------------------

export const SETUP_ORIGIN = 'https://zumibot.test'
/** The password `startSetupRig({ configure: 'password' })` has already stored. */
export const SEEDED_PASSWORD = 'seeded password for tests'

/** A vps config pointing at `dir`; the vault key is never touched here, only named. */
export function setupTestConfig(dir: string, port = 0): Config {
  return {
    mode: 'vps',
    port,
    dataDir: dir,
    vaultKeyFile: join(dir, '..', 'zumibot-vault', 'vault.key'),
    agentsDir: join(dir, 'agents'),
    webDir: join(dir, 'web'),
    origin: SETUP_ORIGIN,
    localSecret: null,
    migrateFrom: null
  }
}

export interface SetupRig {
  base: string
  port: number
  dataDir: string
  auth: AuthStore
  /** Everything the server printed to stdout. */
  lines: string[]
  /** The one-time code, as the server printed it. */
  code: string
  server: SetupServer
  get(path: string, init?: RequestInit): Promise<Response>
  /** A setup call: our own Origin and the right code unless the test overrides them. */
  post(path: string, body?: Record<string, unknown>, o?: { origin?: string | null; code?: string }): Promise<Response>
  close(): Promise<void>
}

/** Starts the real setup server on a fresh temp data folder. `configure` seeds what is already set. */
export async function startSetupRig(o: { configure?: 'password' } = {}): Promise<SetupRig> {
  const dataDir = await mkdtemp(join(tmpdir(), 'cb-setup-'))
  const auth = new AuthStore(dataDir, Date.now)
  if (o.configure === 'password') await auth.setPassword(await hashPassword(SEEDED_PASSWORD))
  const lines: string[] = []
  const server = await startSetupServer(setupTestConfig(dataDir), { out: (l) => lines.push(l) })
  if (!server) throw new Error('startSetupServer returned null: this data folder is already set up')
  const base = `http://127.0.0.1:${server.port}`
  const code = /Setup code: (\S+)/.exec(lines.join('\n'))?.[1] ?? ''
  return {
    base,
    port: server.port,
    dataDir,
    auth,
    lines,
    code,
    server,
    get: (path, init) => fetch(`${base}${path}`, { redirect: 'manual', ...init }),
    post: (path, body = {}, opts = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          ...(opts.origin === null ? {} : { origin: opts.origin ?? SETUP_ORIGIN })
        },
        body: JSON.stringify({ code: opts.code ?? code, ...body })
      }),
    close: async () => {
      await server.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  }
}
