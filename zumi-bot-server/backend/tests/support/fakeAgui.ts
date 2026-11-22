import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Starts `fixtures/fake-agui-server.mjs` for a test and stops it again (see that file for the script's steps). Each server has
// its own folder for its script and log; `stopFakeAgui` ends every one still running, so call it in afterEach.

export const FAKE_AGUI = fileURLToPath(new URL('../fixtures/fake-agui-server.mjs', import.meta.url))

export type AguiStep = Record<string, unknown>

export interface FakeAgui {
  port: number
  /** `http://127.0.0.1:<port>/run`. */
  url: string
  origin: string
  /** Replaces the script; the server reads it again for each request. */
  script(requests: AguiStep[][]): void
  /** Every log entry: `{path, query, headers, body}` per request, `{abort: i}` per request its client left. */
  log(): any[]
  /** The request entries only. */
  requests(): any[]
  /** The raw log text, for a search of every place a value could be. */
  logText(): string
}

const running = new Set<{ stop(): Promise<void> }>()

export async function startFakeAgui(requests: AguiStep[][] = [[]]): Promise<FakeAgui> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-fake-agui-'))
  const scriptFile = join(dir, 'script.json')
  const logFile = join(dir, 'log.jsonl')
  const script = (r: AguiStep[][]) => writeFileSync(scriptFile, JSON.stringify({ requests: r }))
  script(requests)
  const child = spawn(process.execPath, [FAKE_AGUI], {
    env: { ...process.env, FAKE_AGUI_SCRIPT: scriptFile, FAKE_AGUI_LOG: logFile },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const stop = async () => {
    running.delete(entry)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
  const entry = { stop }
  running.add(entry)
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('the fake AG-UI server did not start')), 10_000)
    child.stdout!.on('data', (c: Buffer) => {
      out += c.toString('utf8')
      const m = /FAKE_AGUI_PORT=(\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('the fake AG-UI server exited before it started'))
    })
  })
  const logText = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
  const log = () =>
    logText()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/run`,
    script,
    log,
    requests: () => log().filter((e) => typeof e.path === 'string'),
    logText
  }
}

/** Stops every fake server a test started. */
export async function stopFakeAgui(): Promise<void> {
  await Promise.all([...running].map((r) => r.stop()))
}
