import { spawn } from 'node:child_process'
import type { SyncConfig } from './syncConfig'

interface Options {
  node: string
  entry: string
  config: SyncConfig
  home: string
  log(line: string): void
}

/** The worker keeps synchronous file copying off Electron's UI thread. Config never comes from a renderer. */
export function runSyncProcess(o: Options): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.node, [o.entry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true // its own process group, so the runner can stop ssh/rsync with it if the app dies
    })
    child.on('message', (message: unknown) => {
      const m = message as { type?: unknown; line?: unknown } | null
      if (m?.type === 'log' && typeof m.line === 'string') o.log(m.line)
    })
    child.stdout!.on('data', (data) => o.log(String(data).trimEnd()))
    child.stderr!.on('data', (data) => o.log(String(data).trimEnd()))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal) o.log(`Sync process stopped (${signal}).`)
      resolve(code ?? 1)
    })
    child.once('spawn', () => {
      child.send({ config: o.config, home: o.home }, (err) => {
        if (err) o.log(`Could not start sync: ${err.message}`)
      })
    })
  })
}
