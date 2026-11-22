import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { clientIp, createGuard } from './auth/guard'
import { AuthStore } from './auth/authStore'
import { createLimiter } from './auth/rateLimit'
import { newSetupCode } from './auth/setupCode'
import { createSetupRoutes } from './auth/setupRoutes'
import { setupNeeded } from './auth/setupState'
import type { Config } from './config'
import { controlPath, serveControl } from './control'
import { probeClaude } from './core/claudeStatus'
import { SettingsStore } from './core/store/settingsStore'
import { acquireDataLock } from './lock'
import { ensureDataDir } from './dataDir'
import { applySecurityHeaders, sendJson } from './http/headers'
import { loginDir } from './http/loginDir'

export interface SetupServer {
  port: number
  origin: string
  /** Resolves once the wizard has finished; the caller then closes this and starts the real server. */
  finished: Promise<void>
  /** Synchronous, for a forced exit: removes the lock file if it is ours. */
  releaseLock(): void
  close(): Promise<void>
}

/**
 * A vps server with no password or TOTP yet serves only the setup wizard, on the same 127.0.0.1 port the app will
 * use. Nothing else is built: no hub, no agents, no chats, no schedulers, so there is nothing for an unauthenticated
 * caller to reach. Resolves null when setup is not needed, so the caller can always just ask.
 */
export async function startSetupServer(config: Config, io: { out?(line: string): void } = {}): Promise<SetupServer | null> {
  const out = io.out ?? ((l: string) => console.log(l))
  const { dataDir } = config
  await ensureDataDir(dataDir)
  const auth = new AuthStore(dataDir, Date.now)
  if (!setupNeeded(config.mode, await auth.configured())) return null

  // Held here too: two servers on one data folder would race on auth.json. Released in close(), just before the
  // real server takes it again.
  const releaseLock = await acquireDataLock(dataDir)
  // Unwound in reverse if anything below fails, so a half-started setup server leaves no listener, socket or lock.
  const undo: (() => Promise<void>)[] = [releaseLock]
  try {
    const { code, hash } = newSetupCode()
    const settings = new SettingsStore(dataDir)
    let done = false
    let resolveFinished!: () => void
    const finished = new Promise<void>((r) => (resolveFinished = r))
    const limiter = createLimiter({ now: Date.now })
    const routes = createSetupRoutes({
      auth,
      limiter,
      guard: createGuard({ config, auth }),
      codeHash: hash,
      ipOf: clientIp,
      now: Date.now,
      log: (l) => console.error(l),
      claudeStatus: async () => probeClaude({ claudePath: (await settings.get()).claudePath }),
      loginDir: loginDir(),
      onFinish: () => {
        if (done) return
        done = true
        resolveFinished()
      }
    })

    async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
      applySecurityHeaders(res)
      // Past the finish nothing here answers again: the app is starting on this port instead.
      if (done) return sendJson(res, 503, { error: 'Starting ZumiBot…' }, { 'Retry-After': '1' })
      if (await routes.handle(req, res)) return
      const method = req.method ?? 'GET'
      if (method === 'GET' || method === 'HEAD') {
        res.writeHead(302, { Location: '/setup', 'Content-Length': 0 })
        res.end()
        return
      }
      sendJson(res, 404, { error: 'Not found' })
    }

    const server = http.createServer((req, res) => {
      route(req, res).catch((err) => {
        console.error('setup request failed:', err instanceof Error ? err.message : err) // message only
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' })
        else res.destroy()
      })
    })
    // No hub exists yet, so there is nothing to attach a socket to.
    server.on('upgrade', (_req, socket) => socket.destroy())

    // 127.0.0.1 only, like the app: the proxy is still the one way in.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const port = (server.address() as AddressInfo).port
    undo.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    })
    // The deploy asks `zumibot-server busy` whether the service is up before it reports success, and nothing is
    // running here, so answer 0 rather than leave a first deploy to time out and dump the journal (which holds the
    // setup code) to the operator's own terminal.
    undo.push(await serveControl(controlPath(dataDir), { busy: () => 0 }))

    out(`LISTENING ${port}`)
    out(`ZumiBot is not set up yet. Open ${config.origin}/setup`)
    out(`Setup code: ${code}`)
    out('The code is only in this server’s memory: it is gone once setup finishes, or if the server restarts.')

    return {
      port,
      origin: config.origin,
      finished,
      releaseLock: releaseLock.sync,
      async close() {
        // Reverse order: the control socket and the lock go last, since the app takes both again right after.
        for (const fn of [...undo].reverse()) await fn()
      }
    }
  } catch (err) {
    for (const fn of [...undo].reverse()) await fn().catch(() => {})
    throw err
  }
}
