import type { BrowserFiles } from '../core/browser/browserFiles'
import { AUDIT_EXPORT_ROUTE, handleAuditExport, type AuditExportSource } from './auditExport'
import { serveBrowserFile } from './browserFiles'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { AttachmentStore } from '../core/attachments/attachmentStore'
import type { Hub } from '../rpc/hub'
import type { BrowserHub } from './browserSocket'
import { DESKTOP_FRAME_BYTES, type DesktopHub } from './desktopSocket'
import { CLOSE_SIGNED_OUT } from '@zumibot/shared/rpc'
import type { SnapshotStore } from '../core/files/snapshotStore'
import { parseAttachmentPath, serveAttachment } from './attachments'
import { parseFilePath, serveSnapshot } from './files'
import { parseExportPath, serveExport, type ExportSource } from './export'
import { applySecurityHeaders, sendJson } from './headers'
import { PUBLIC_FILES, serveStatic } from './static'
import { handleStage } from './upload'
import { handleTranscribe, type VoiceRoute } from './voice'
import { VOICE_ROUTE } from '@zumibot/shared/voice'

export interface Gate {
  authorize(req: IncomingMessage): Promise<boolean>
  // upgrade: the WebSocket handshake, which is a GET but must always carry our Origin.
  originOk(req: IncomingMessage, opts?: { upgrade?: boolean }): Promise<boolean>
  // Auth routes (/login, /api/login...); true = handled.
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

export interface AppServerOptions {
  gate: Gate
  hub: Hub
  browserHub?: BrowserHub
  desktopHub?: DesktopHub
  browserFiles?: BrowserFiles
  attachments: AttachmentStore
  // Whole-file copies of the files panel: absent = the path is a plain 404.
  snapshots?: Pick<SnapshotStore, 'pathOf'>
  webDir: string
  sessionKey(req: IncomingMessage): string
  // Webhook calls: authenticated by the routine's own secret header, not by a session.
  hooks?: (req: IncomingMessage, res: ServerResponse, id: string) => Promise<void>
  // Dictation: absent = the path is a plain 404.
  voice?: VoiceRoute
  // Chat export downloads: absent = the path is a plain 404.
  exports?: ExportSource
  // Settings › Audit log's export (POST, filter in the body): absent = the path is a plain 404.
  audit?: AuditExportSource
}

export function createAppServer(o: AppServerOptions): http.Server {
  const { gate, hub, attachments } = o
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  // RFB bytes: a 1 MiB clipboard paste with its cut-text header fits one frame; the hub caps JSON requests lower.
  const desktopWss = new WebSocketServer({ noServer: true, maxPayload: DESKTOP_FRAME_BYTES })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res)
    const pathname = (req.url ?? '/').split(/[?#]/)[0]!
    // Before the gate: callers are external services with no cookie, and the handler checks the secret itself.
    if (o.hooks && pathname.startsWith('/hooks/')) {
      let id: string
      try {
        id = decodeURIComponent(pathname.slice(7))
      } catch {
        id = '' // fails the id check, so it answers 401 like any unknown id
      }
      return o.hooks(req, res, id)
    }
    if (PUBLIC_FILES.has(pathname) && (req.method === 'GET' || req.method === 'HEAD'))
      return serveStatic(req, res, o.webDir, { fallback: false })
    if (await gate.handle(req, res)) return
    const method = req.method ?? 'GET'
    const isApi = pathname.startsWith('/api/')
    if (!(await gate.authorize(req))) {
      if (isApi || (method !== 'GET' && method !== 'HEAD')) return sendJson(res, 401, { error: 'Unauthorized' })
      res.writeHead(302, { Location: '/login', 'Content-Length': 0 })
      res.end()
      return
    }
    // Cookies ride along on cross-site writes, so every state-changing request must come from our own origin.
    if (method !== 'GET' && method !== 'HEAD' && !(await gate.originOk(req))) return sendJson(res, 403, { error: 'Bad origin' })
    if (isApi) {
      if (o.browserFiles && pathname.startsWith('/api/browser/files/'))
        return serveBrowserFile(req, res, o.browserFiles, o.browserHub, o.sessionKey(req), pathname)
      if (pathname === '/api/attachments/stage') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        return handleStage(req, res, attachments)
      }
      if (pathname === VOICE_ROUTE && o.voice) return handleTranscribe(req, res, o.voice)
      if (pathname === AUDIT_EXPORT_ROUTE && o.audit) return handleAuditExport(req, res, o.audit, Date.now())
      const parsed = parseAttachmentPath(pathname)
      if (parsed && (method === 'GET' || method === 'HEAD')) {
        const download = new URL(req.url ?? '/', 'http://localhost').searchParams.get('download') === '1'
        return serveAttachment(req, res, attachments, parsed, download)
      }
      const file = o.snapshots ? parseFilePath(pathname) : null
      if (file && (method === 'GET' || method === 'HEAD')) {
        return serveSnapshot(req, res, o.snapshots!, file, new URL(req.url ?? '/', 'http://localhost').searchParams.get('download'))
      }
      const exported = o.exports ? parseExportPath(pathname) : null
      if (exported !== null && (method === 'GET' || method === 'HEAD')) return serveExport(req, res, o.exports!, exported)
      return sendJson(res, 404, { error: 'Not found' })
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 })
      res.end()
      return
    }
    return serveStatic(req, res, o.webDir)
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error('request failed:', err instanceof Error ? err.message : err) // message only: never dump headers or bodies
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' })
      else res.destroy()
    })
  })

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const pathname = (req.url ?? '').split(/[?#]/)[0]
    const browser = pathname === '/ws/browser' && !!o.browserHub
    const desktop = pathname === '/ws/desktop' && !!o.desktopHub
    if (!browser && !desktop && pathname !== '/ws') {
      socket.destroy()
      return
    }
    const ok = (await gate.authorize(req)) && (await gate.originOk(req, { upgrade: true }))
    // Finish the handshake even when refused: a browser only sees the close code, not an HTTP status.
    const transport = browser ? browserWss : desktop ? desktopWss : wss
    transport.handleUpgrade(req, socket, head, (ws) => {
      if (ok) (browser ? o.browserHub! : desktop ? o.desktopHub! : hub).attach(ws, o.sessionKey(req))
      else ws.close(CLOSE_SIGNED_OUT)
    })
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    upgrade(req, socket, head).catch(() => socket.destroy())
  })

  return server
}
