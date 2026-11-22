import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { isPipePath, usesPipes } from './core/ipc/ipcEndpoint'

export const CONTROL_SOCK = 'control.sock'

/**
 * The control channel's address for a data dir: `control.sock` in it, or on Windows (no socket files) a named pipe whose
 * name comes from the data dir, so the desktop, `busy` and a second server all find the same one.
 */
export function controlPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  if (!usesPipes(platform)) return join(dataDir, CONTROL_SOCK)
  const key = createHash('sha256').update(resolve(dataDir).toLowerCase()).digest('hex').slice(0, 24)
  return `\\\\.\\pipe\\zumibot-control-${key}`
}

/**
 * Local-only side channel: the desktop, deploy and sync ask how many replies are running (`busy`) before they stop the server,
 * and how many background processes a stop would end (`processes`, only ever a warning). An older server answers `error` to it.
 */
export async function serveControl(sockPath: string, o: { busy(): number; processes?(): number }): Promise<() => Promise<void>> {
  // The data lock is held, so a socket file still here is a crashed server's. A pipe ends with its server.
  const pipe = isPipePath(sockPath)
  if (!pipe) await fs.rm(sockPath, { force: true })
  const server = net.createServer((sock) => {
    sock.on('error', () => {})
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      if (buf.length > 64) return void sock.destroy()
      if (buf.includes('\n')) {
        const line = buf.split('\n')[0]
        sock.end(line === 'busy' ? `${o.busy()}\n` : line === 'processes' && o.processes ? `${o.processes()}\n` : 'error\n')
        buf = ''
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  if (!pipe) await fs.chmod(sockPath, 0o600)
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (!pipe) await fs.rm(sockPath, { force: true })
  }
}

/** Rejects when nothing answers, so "no server" and "server hung" both read as not running. */
export function queryBusy(sockPath: string, timeoutMs = 2000, what: 'busy' | 'processes' = 'busy'): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath)
    let buf = ''
    const finish = (err: Error | null, n?: number): void => {
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err)
      else resolve(n!)
    }
    const timer = setTimeout(() => finish(new Error('control socket timed out')), timeoutMs)
    sock.on('error', (err) => finish(err))
    sock.on('connect', () => sock.write(`${what}\n`))
    sock.on('data', (d) => (buf += d.toString('utf8')))
    sock.on('end', () => {
      const n = Number(buf.trim())
      if (/^\d+$/.test(buf.trim()) && Number.isSafeInteger(n)) finish(null, n)
      else finish(new Error('bad control reply'))
    })
  })
}

/** Set by the Windows desktop shell, which starts the server in WSL2 and cannot reach a socket file inside it. */
export const STDIN_CONTROL_ENV = 'ZUMIBOT_STDIN_CONTROL'

/**
 * The control channel over the process's own stdin/stdout: a `busy` or `processes` line is answered with
 * `CONTROL <what> <n>` (or `CONTROL <what> error`), and the end of stdin stops the server, so a shell that dies or is
 * killed takes its WSL server with it. Lines are capped like the socket's.
 */
export function serveStdinControl(
  input: Readable,
  o: { query(what: 'busy' | 'processes'): Promise<number>; out(line: string): void; stop(): void }
): void {
  const rl = createInterface({ input, crlfDelay: Infinity })
  rl.on('line', (raw) => {
    const line = raw.trim()
    if (line !== 'busy' && line !== 'processes') return
    o.query(line).then(
      (n) => o.out(`CONTROL ${line} ${n}`),
      () => o.out(`CONTROL ${line} error`)
    )
  })
  rl.once('close', () => o.stop())
}
