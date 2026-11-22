import { parseBrowserPageState } from '@zumibot/shared/browser'
import { BrowserFileReceiver, type BrowserFilePacket } from './browserFileIpc'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { BrowserRuntime } from './browserRuntime'
import {
  canonicalProfile,
  cleanupOwned,
  clearBrowserDownloadScratch,
  identity,
  ownershipMarker,
  ownershipVariable,
  pause,
  readOwner,
  recoverProfile,
  removeOwner,
  writeOwner
} from './browserProcess'
import type { BrowserProcessOwner } from './browserProcess'
import type {
  BrowserAdapter,
  BrowserCommand,
  BrowserFileHooks,
  BrowserFill,
  BrowserFrame,
  BrowserInput,
  BrowserInstance,
  BrowserViewport
} from './types'
import { BrowserLaunchCleanupError } from './types'

type State = import('@zumibot/shared/browser').BrowserPageState
type Response =
  | BrowserFilePacket
  | { type: 'fileAbort'; transferId: string }
  | { type: 'result' | 'changed' | 'frame'; id?: number; result?: unknown; error?: string; state?: State; frame?: BrowserFrame }

// Playwright's DEBUG (pw:protocol logs every CDP call, a vault fill's value among its arguments) and DEBUG_FILE (writes that log
// to a file), PWDEBUG (headed inspector) and Node's NODE_DEBUG: none may reach the worker or the browser it starts.
const debugVariable = (name: string) => name === 'DEBUG' || name.startsWith('DEBUG_') || name.startsWith('PWDEBUG') || name === 'NODE_DEBUG'
/** The worker's env: the server's, without its secret, debug switches or Electron mode unless the runtime needs it. */
export function workerEnv(base: NodeJS.ProcessEnv, ownership: string, electronNode: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).filter(([name]) => !debugVariable(name) && name !== 'ZUMIBOT_LOCAL_SECRET' && name !== 'ELECTRON_RUN_AS_NODE')
  )
  env[ownershipVariable] = ownership
  if (electronNode) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export function createWorkerAdapter(runtime: BrowserRuntime): BrowserAdapter {
  return {
    async launch(path, config, files) {
      if (process.platform !== 'linux') throw new Error('Browser unavailable: Linux process ownership is required')
      const executablePath = config.executablePath ?? runtime.executablePath
      if (!executablePath) throw new Error('Browser unavailable')
      const profile = await canonicalProfile(path)
      await recoverProfile(profile)
      const token = randomUUID()
      const env = workerEnv(process.env, ownershipMarker({ profile, token }), runtime.electronNode)
      const child = fork(runtime.workerEntry, [], {
        execPath: runtime.node,
        execArgv: [],
        env,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced'
      })
      const adapter = new WorkerInstance(child, config.commandMs, files)
      try {
        const owner: BrowserProcessOwner = {
          version: 2,
          profile,
          token,
          state: 'launching',
          worker: await identity(child.pid!),
          parent: await identity(process.pid),
          processes: []
        }
        adapter.owner = owner
        await writeOwner(owner)
        await adapter.request('launch', { profile, config: { ...config, executablePath } })
        const launchedOwner = await readOwner(profile)
        if (!launchedOwner || launchedOwner.token !== token || !launchedOwner.processes.length)
          throw new Error('Browser ownership proof unavailable')
        adapter.owner = launchedOwner
        return adapter
      } catch {
        try {
          await adapter.close()
        } catch {
          throw new BrowserLaunchCleanupError(adapter)
        }
        throw new Error('Browser unavailable')
      }
    }
  }
}

class WorkerInstance implements BrowserInstance {
  owner: BrowserProcessOwner | null = null
  private fileReceiver: BrowserFileReceiver
  private current: State = { generation: '', tabs: [], activeTabId: null }
  get generation() {
    return this.current.generation
  }
  private dead = false
  private closing: Promise<void> | null = null
  private exited: Promise<void>
  private exitResolve!: () => void
  private sequence = 0
  private requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private listeners = new Set<() => void>()
  private onFrame: ((frame: BrowserFrame) => void) | null = null
  constructor(
    private child: ChildProcess,
    private commandMs: number,
    files?: BrowserFileHooks
  ) {
    this.fileReceiver = new BrowserFileReceiver(files, () => this.generation)
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve
    })
    child.on('message', (message: Response) => {
      if (this.dead) return
      if (message.type === 'fileAbort') {
        this.fileReceiver.cancel(message.transferId)
        return
      }
      if (message.type === 'file') {
        this.fileReceiver.receive(message, (value, error) => {
          if (child.connected)
            child.send({ type: 'fileAck', transferId: message.transferId, sequence: message.sequence, value, error }, () => {})
        })
        return
      }
      if (message.state) {
        try {
          this.current = parseBrowserPageState(message.state)
        } catch {
          void this.close()
          return
        }
      }
      if (message.type === 'result' && message.id) {
        const request = this.requests.get(message.id)
        this.requests.delete(message.id)
        if (message.error) request?.reject(new Error('Browser command did not complete'))
        else request?.resolve(message.result)
      }
      if (message.type === 'changed') for (const listener of this.listeners) listener()
      if (message.type === 'frame' && message.frame && this.onFrame && !this.closing) this.onFrame(message.frame)
    })
    const exit = () => {
      this.fileReceiver.close()
      this.exitResolve()
      for (const pending of this.requests.values()) pending.reject(new Error('Browser unavailable'))
      this.requests.clear()
      // Retirement is published only after verified descendant cleanup.
      void this.close()
        .then(() => {
          for (const listener of this.listeners) listener()
        })
        .catch(() => {})
    }
    child.once('exit', exit)
    child.once('error', exit)
  }
  isClosed() {
    return this.dead
  }
  status() {
    return {
      tabs: this.current.tabs.map((tab) => ({ ...tab })),
      activeTabId: this.current.activeTabId,
      dialog: this.current.dialog,
      fileChooser: this.current.fileChooser
    }
  }
  onChanged(cb: () => void) {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  async request(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.dead || this.closing || !this.child.connected || signal?.aborted) throw new Error('Browser unavailable')
    const id = ++this.sequence
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    try {
      return await new Promise((resolve, reject) => {
        this.requests.set(id, { resolve, reject })
        abort = () => {
          if (this.child.connected) this.child.send({ id: ++this.sequence, op: 'cancel', cancelId: id }, () => {})
          void this.close().then(
            () => reject(new Error('Browser command did not complete')),
            () => reject(new Error('Browser cleanup did not complete'))
          )
        }
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, this.commandMs + 1000)
        this.child.send({ id, op, ...args }, (error) => {
          if (error) abort()
        })
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      this.requests.delete(id)
    }
  }
  execute(command: BrowserCommand, signal: AbortSignal, uploadPaths?: string[]) {
    return this.request('execute', { command, uploadPaths }, signal) as ReturnType<BrowserInstance['execute']>
  }
  // Its own op, never `execute`: the value goes to the worker in this message only, and the worker answers with codes.
  fill(fill: BrowserFill, signal: AbortSignal) {
    return this.request('fill', { fill }, signal) as ReturnType<BrowserInstance['fill']>
  }
  async input(input: BrowserInput, signal: AbortSignal) {
    await this.request('input', { input }, signal)
  }
  async invalidateReferences() {
    await this.request('invalidate')
  }
  async setViewport(viewport: BrowserViewport) {
    await this.request('viewport', { viewport })
  }
  async startFrames(cb: (frame: BrowserFrame) => void) {
    this.onFrame = cb
    await this.request('startFrames')
  }
  async stopFrames() {
    this.onFrame = null
    if (!this.dead && !this.closing) await this.request('stopFrames')
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    const work = (async () => {
      this.onFrame = null
      this.fileReceiver.close()
      if (this.child.connected) {
        try {
          this.child.send({ id: ++this.sequence, op: 'close' }, () => {})
        } catch {
          /* exited */
        }
      }
      await Promise.race([this.exited, pause(1500)])
      if (this.owner) {
        await cleanupOwned(this.owner, true)
        await removeOwner(this.owner)
      }
      await this.exited
      if (this.owner) {
        await clearBrowserDownloadScratch(this.owner.profile)
        await this.fileReceiver.confirmClosed()
      }
      this.dead = true
      this.current = { ...this.current, tabs: [], activeTabId: null }
      for (const pending of this.requests.values()) pending.reject(new Error('Browser unavailable'))
      this.requests.clear()
    })()
    this.closing = work
    void work.catch(() => {
      if (this.closing === work) this.closing = null
    })
    return work
  }
}
