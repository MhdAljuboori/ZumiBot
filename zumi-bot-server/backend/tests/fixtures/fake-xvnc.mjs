#!/usr/bin/env node
// Fake TigerVNC Xvnc for desktop tests. Reads the real flags (`:N`, -geometry, -rfbunixpath,
// -rfbunixmode, -desktop) and serves RFB 3.8, security None, a solid framebuffer in Raw encoding
// on the unix socket. Client input is appended as JSON lines to FAKE_XVNC_LOG.
//
// Env:
//   FAKE_XVNC_LOG       JSON lines: {type:'start'|'init'|'key'|'pointer'|'cut'|'close', ...}
//   FAKE_XVNC_BUSY      comma-separated display numbers that fail with "Server is already active"
//   FAKE_XVNC_LOCK_DIR  write `<dir>/.X<N>-lock` (the pid, like Xvnc) and fail if it exists
//   FAKE_XVNC_X11_DIR   listen on `<dir>/X<N>` like the X socket
//   FAKE_XVNC_DELAY_MS  wait this long before listening on the VNC socket
//   FAKE_XVNC_UPDATE_MS answer incremental update requests after this long with a small rect (a screen that keeps
//                       changing, so a watching viewer has steady traffic); unset, they wait forever
// A client that got past ClientInit logs {type:'init'} and, when it goes, {type:'close'} (a bare connect, like the
// adapter's readiness probe, logs nothing).
// SIGTERM removes the sockets and the lock, like the real server. SIGKILL leaves them behind.
import { appendFileSync, chmodSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const args = process.argv.slice(2)
const display = Number((args.find(a => /^:\d+$/.test(a)) ?? ':0').slice(1))
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const [width, height] = (opt('-geometry') ?? '1280x800').split('x').map(Number)
const unixPath = opt('-rfbunixpath')
const unixMode = parseInt(opt('-rfbunixmode') ?? '0600', 8)
const name = Buffer.from(opt('-desktop') ?? 'fake', 'utf8')
const log = (entry) => { if (process.env.FAKE_XVNC_LOG) appendFileSync(process.env.FAKE_XVNC_LOG, JSON.stringify(entry) + '\n') }
log({ type: 'start', display, args, pid: process.pid, env: Object.keys(process.env) })

const busy = () => {
  process.stderr.write(`\nFatal server error:\n(EE) Server is already active for display ${display}\n\tIf this server is no longer running, remove /tmp/.X${display}-lock\n\tand start again.\n`)
  process.exit(1)
}
if ((process.env.FAKE_XVNC_BUSY ?? '').split(',').filter(Boolean).map(Number).includes(display)) busy()

const lock = process.env.FAKE_XVNC_LOCK_DIR ? join(process.env.FAKE_XVNC_LOCK_DIR, `.X${display}-lock`) : null
const xSocket = process.env.FAKE_XVNC_X11_DIR ? join(process.env.FAKE_XVNC_X11_DIR, `X${display}`) : null
if (lock) { try { writeFileSync(lock, `${String(process.pid).padStart(10)}\n`, { flag: 'wx' }) } catch { busy() } }
const servers = []
if (xSocket) servers.push(createServer(s => s.on('error', () => {})).listen(xSocket))

process.on('SIGTERM', () => {
  for (const s of servers) s.close()
  for (const p of [unixPath, lock, xSocket]) if (p) rmSync(p, { force: true })
  process.exit(0)
})

function serverInit() {
  const b = Buffer.alloc(24 + name.length)
  b.writeUInt16BE(width, 0); b.writeUInt16BE(height, 2)
  // bpp 32, depth 24, little endian, true colour, max 255 each, shifts 16/8/0.
  b.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4)
  b.writeUInt32BE(name.length, 20); name.copy(b, 24)
  return b
}

function serve(sock) {
  let buf = Buffer.alloc(0), state = 'version', bpp = 32
  const updateMs = Number(process.env.FAKE_XVNC_UPDATE_MS ?? 0)
  sock.on('error', () => {})
  sock.on('close', () => { if (state === 'messages') log({ type: 'close' }) })
  sock.write('RFB 003.008\n')
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      const used = step()
      if (!used) break
      buf = buf.subarray(used)
    }
  })
  const sendRect = (x, y, w, h) => {
    w = Math.max(0, Math.min(w, width - x)); h = Math.max(0, Math.min(h, height - y))
    const head = Buffer.alloc(16)
    head.writeUInt16BE(1, 2)
    head.writeUInt16BE(x, 4); head.writeUInt16BE(y, 6); head.writeUInt16BE(w, 8); head.writeUInt16BE(h, 10)
    const px = Buffer.alloc(w * h * (bpp / 8), bpp === 32 ? 0 : 0x55)
    if (bpp === 32) for (let i = 0; i < px.length; i += 4) { px[i] = 0x90; px[i + 1] = 0x60; px[i + 2] = 0x30 }
    sock.write(Buffer.concat([head, px]))
  }
  function step() {
    const need = (n) => (buf.length >= n ? n : 0)
    if (state === 'version') {
      if (!need(12)) return 0
      state = 'security'; sock.write(Buffer.from([1, 1])); return 12
    }
    if (state === 'security') {
      if (!need(1)) return 0
      if (buf[0] !== 1) { sock.destroy(); return 0 }
      state = 'init'; sock.write(Buffer.alloc(4)); return 1
    }
    if (state === 'init') {
      if (!need(1)) return 0
      log({ type: 'init', shared: buf[0] })
      state = 'messages'; sock.write(serverInit()); return 1
    }
    if (!need(1)) return 0
    switch (buf[0]) {
      case 0: { const n = need(20); if (n) bpp = buf[4]; return n }
      case 2: return buf.length < 4 ? 0 : need(4 + 4 * buf.readUInt16BE(2))
      case 3: {
        const n = need(10)
        // Like a real server, an incremental request waits for a change, and nothing changes here unless asked to.
        if (n && !buf[1]) sendRect(buf.readUInt16BE(2), buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8))
        else if (n && updateMs > 0) setTimeout(() => { if (!sock.destroyed) sendRect(0, 0, 8, 8) }, updateMs)
        return n
      }
      case 4: { const n = need(8); if (n) log({ type: 'key', down: buf[1] === 1, key: buf.readUInt32BE(4) }); return n }
      case 5: { const n = need(6); if (n) log({ type: 'pointer', mask: buf[1], x: buf.readUInt16BE(2), y: buf.readUInt16BE(4) }); return n }
      case 6: {
        if (buf.length < 8) return 0
        const len = Math.abs(buf.readInt32BE(4)), n = need(8 + len)
        if (n) log({ type: 'cut', text: buf.subarray(8, 8 + len).toString('latin1') })
        return n
      }
      case 150: return need(10)
      case 248: return buf.length < 9 ? 0 : need(9 + buf[8])
      case 250: return need(4)
      case 251: return buf.length < 8 ? 0 : need(8 + 16 * buf[6])
      case 255: {
        if (buf.length < 2) return 0
        if (buf[1] !== 0) { sock.destroy(); return 0 }
        const n = need(12)
        if (n) log({ type: 'key', down: buf.readUInt16BE(2) === 1, key: buf.readUInt32BE(4), code: buf.readUInt32BE(8) })
        return n
      }
      default: sock.destroy(); return 0
    }
  }
}

setTimeout(() => {
  if (!unixPath) return
  const server = createServer(serve).listen(unixPath, () => chmodSync(unixPath, unixMode))
  servers.push(server)
}, Number(process.env.FAKE_XVNC_DELAY_MS ?? 0))
