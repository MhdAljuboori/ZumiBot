import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import type { CodexInfo } from '@zumibot/shared/engine'
import { LineSplitter } from '../chat/streamParser'
import { CodexRpc } from './codexRpc'

const LIST_TIMEOUT_MS = 15_000
const PAGES_MAX = 5

export interface CodexInfoDeps {
  locate(): Promise<string | null>
  list(bin: string): Promise<string[]>
}

/**
 * What Codex reports on this machine. The first non-empty model list is kept for the server's life; a failed, timed out or
 * empty one is not, so the next call asks again. Calls made together share one listing.
 */
export function createCodexInfo(d: CodexInfoDeps): () => Promise<CodexInfo> {
  let models: string[] | null = null
  let inflight: Promise<string[]> | null = null
  return async () => {
    const bin = await d.locate().catch(() => null)
    if (!bin) return { found: false, models: [] }
    if (models) return { found: true, models: [...models] }
    const run = (inflight ??= d.list(bin).finally(() => {
      inflight = null
    }))
    try {
      const list = await run
      if (list.length > 0) models = list
      return { found: true, models: [...list] }
    } catch {
      return { found: true, models: [] }
    }
  }
}

// Only names the client; codex echoes it in its userAgent.
const CLIENT_INFO = { name: 'zumibot', title: null, version: '1.0.0' }

/** The visible models `codex app-server` offers: initialize, model/list (a few pages at most), then the process is killed. */
export function listCodexModels(bin: string, o: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    let child: ChildProcess | null = null
    let done = false
    const rpc = new CodexRpc((line) => {
      const inp = child?.stdin
      if (!inp || inp.destroyed || inp.writableEnded) return false
      inp.write(line)
      return true
    })
    // Fixed messages only: never the process's own text.
    const finish = (err: Error | null, list?: string[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      rpc.close(new Error('Codex listing ended'))
      try {
        child?.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      if (err) reject(err)
      else resolve(list ?? [])
    }
    const timer = setTimeout(() => finish(new Error('Codex did not answer')), o.timeoutMs ?? LIST_TIMEOUT_MS)
    try {
      // The home folder, not the server's: codex reads project config from its cwd.
      child = spawn(bin, ['app-server', '--listen', 'stdio://', '--disable', 'multi_agent'], {
        cwd: homedir(),
        env: o.env ?? process.env,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      return finish(new Error('Codex could not start'))
    }
    child.on('error', () => finish(new Error('Codex could not start')))
    child.on('exit', () => finish(new Error('Codex exited')))
    child.stdin!.on('error', () => {
      /* EPIPE when it dies early */
    })
    const split = new LineSplitter()
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (c: string) => {
      for (const l of split.push(c)) rpc.receive(l)
    })
    void (async () => {
      await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
      rpc.notify('initialized')
      const found = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < PAGES_MAX; page++) {
        const res: { data?: unknown; nextCursor?: unknown } | null = await rpc.request('model/list', cursor === null ? {} : { cursor })
        if (Array.isArray(res?.data)) {
          for (const m of res.data)
            if (m && typeof m === 'object' && m.hidden === false && typeof m.model === 'string' && m.model) found.add(m.model)
        }
        cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null
        if (cursor === null) break
      }
      finish(null, [...found])
    })().catch(() => finish(new Error('Codex model list failed')))
  })
}
