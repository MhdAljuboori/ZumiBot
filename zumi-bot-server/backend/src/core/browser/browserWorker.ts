import { randomUUID } from 'node:crypto'
import type { BrowserFile } from './browserFiles'
import { fitBrowserViewport, sameBrowserViewport } from '@zumibot/shared/browser'
import type {
  BrowserCommand,
  BrowserConfig,
  BrowserFill,
  BrowserFrame,
  BrowserInput,
  BrowserInstance,
  BrowserDownloadSource,
  BrowserViewport
} from './types'
import { cleanupOwned, markOwnerState, pause, readOwner } from './browserProcess'

type Request = {
  id: number
  op: 'launch' | 'execute' | 'fill' | 'input' | 'invalidate' | 'viewport' | 'startFrames' | 'stopFrames' | 'close' | 'cancel'
  profile?: string
  config?: BrowserConfig
  command?: BrowserCommand
  fill?: BrowserFill
  input?: BrowserInput
  viewport?: BrowserViewport
  cancelId?: number
  uploadPaths?: string[]
}
let instance: BrowserInstance | null = null
let launching: Promise<BrowserInstance> | null = null
let profile: string | null = null
let shuttingDown = false
let framePending = false
let nextFrame: BrowserFrame | null = null
const pending = new Map<number, AbortController>()
const fileAcks = new Map<string, { resolve: (value: unknown) => void; reject: () => void }>()
async function fileMessage(transferId: string, sequence: number, phase: string, data: object = {}) {
  const key = transferId + ':' + sequence
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<unknown>((resolve, reject) => {
      fileAcks.set(key, { resolve, reject: () => reject(new Error('Browser file unavailable')) })
      timer = setTimeout(() => reject(new Error('Browser file unavailable')), 5000)
      send({ type: 'file', transferId, sequence, phase, ...data })
    })
  } finally {
    clearTimeout(timer)
    fileAcks.delete(key)
  }
}
const fileHooks = {
  async sourceClosed(sourceId: string) {
    await fileMessage(sourceId, -1, 'cleanup')
  },
  async download(source: BrowserDownloadSource, name: string, generation: string, signal?: AbortSignal) {
    const transferId = source.sourceId ?? randomUUID()
    let sequence = 0
    const abort = () => {
      send({ type: 'fileAbort', transferId })
      for (const [key, ack] of fileAcks) if (key.startsWith(transferId + ':')) ack.reject()
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await fileMessage(transferId, sequence++, 'begin', { name, generation })
      for await (const bytes of source) await fileMessage(transferId, sequence++, 'chunk', { bytes })
      const file = (await fileMessage(transferId, sequence++, 'end')) as BrowserFile
      if (
        !file ||
        typeof file.id !== 'string' ||
        !/^[A-Za-z0-9-]{1,128}$/.test(file.id) ||
        typeof file.name !== 'string' ||
        file.name.length > 180 ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > 26214400
      )
        throw new Error('Browser file unavailable')
      return file
    } catch {
      void fileMessage(transferId, sequence++, 'error').catch(() => {})
      throw new Error('Browser file unavailable')
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
}
const send = (message: unknown, cb?: () => void) => {
  if (!process.connected) {
    cb?.()
    return
  }
  try {
    process.send?.(message, (error) => {
      cb?.()
      if (error) void shutdown()
    })
  } catch {
    cb?.()
    void shutdown()
  }
}
const state = () => (instance ? { generation: instance.generation, ...instance.status() } : null)
/** One frame in flight; the newest one waiting replaces older ones, so the final paint always arrives. */
function frame(next: BrowserFrame) {
  if (shuttingDown || !process.connected) return
  if (framePending) {
    nextFrame = next
    return
  }
  framePending = true
  send({ type: 'frame', frame: next }, () => {
    framePending = false
    const waiting = nextFrame
    nextFrame = null
    if (waiting) frame(waiting)
  })
}
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  for (const ack of fileAcks.values()) ack.reject()
  fileAcks.clear()
  for (const controller of pending.values()) controller.abort()
  let failed = false
  try {
    const owner = profile ? await readOwner(profile) : null
    await Promise.race([
      (async () => {
        const launched = await launching?.catch(() => null)
        await (instance ?? launched)?.close()
      })(),
      pause(1500).then(async () => {
        if (owner) await cleanupOwned(owner, false)
        else throw new Error('Browser cleanup unavailable')
      })
    ])
    if (owner) {
      await cleanupOwned(owner, false)
      await markOwnerState(owner, 'stopped')
    }
  } catch {
    failed = true
    const owner = profile ? await readOwner(profile) : null
    if (owner) await markOwnerState(owner, 'unconfirmed').catch(() => {})
  } finally {
    process.exit(failed ? 1 : 0)
  }
}
process.on('disconnect', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown()
})
process.on('uncaughtException', () => {
  void shutdown()
})
process.on('unhandledRejection', () => {
  void shutdown()
})
process.on('message', (request: Request) => {
  const ack = request as unknown as { type?: string; transferId: string; sequence: number; error?: boolean; value?: unknown }
  if (ack.type === 'fileAck') {
    const pending = fileAcks.get(ack.transferId + ':' + ack.sequence)
    if (ack.error) pending?.reject()
    else pending?.resolve(ack.value)
    return
  }
  if (shuttingDown || !Number.isSafeInteger(request.id)) return
  if (request.op === 'cancel') {
    pending.get(request.cancelId!)?.abort()
    return
  }
  const controller = new AbortController()
  pending.set(request.id, controller)
  void (async () => {
    let result: unknown
    switch (request.op) {
      case 'launch': {
        if (launching || instance || !request.profile || !request.config) throw new Error('Browser unavailable')
        profile = request.profile
        // This is the only runtime import of Playwright; the server never traverses it.
        const { createChromiumAdapter } = await import('./chromiumAdapter')
        launching = createChromiumAdapter().launch(profile, request.config, fileHooks)
        instance = await launching
        instance.onChanged(() => {
          send({ type: 'changed', state: state() })
          if (instance?.isClosed()) void shutdown()
        })
        result = state()
        break
      }
      case 'execute':
        result = await instance!.execute(request.command!, controller.signal, request.uploadPaths)
        break
      case 'fill':
        result = await instance!.fill(request.fill!, controller.signal)
        break
      case 'input':
        result = await instance!.input(request.input!, controller.signal)
        break
      case 'invalidate':
        result = await instance!.invalidateReferences()
        break
      case 'viewport': {
        const v = request.viewport
        if (!v || !sameBrowserViewport(v, fitBrowserViewport(v.width, v.height, v.scale))) throw new Error('Browser unavailable')
        result = await instance!.setViewport(v)
        break
      }
      case 'startFrames':
        result = await instance!.startFrames(frame)
        break
      case 'stopFrames':
        nextFrame = null
        result = await instance!.stopFrames()
        break
      case 'close':
        await shutdown()
        return
      default:
        throw new Error('Browser unavailable')
    }
    send({ type: 'result', id: request.id, result, state: state() })
  })()
    .catch(() => {
      send({ type: 'result', id: request.id, error: 'Browser command did not complete' })
      if (request.op === 'launch') void shutdown()
    })
    .finally(() => pending.delete(request.id))
})
// A standalone orphan must not start Chromium while waiting for a nonexistent parent.
if (!process.connected) void shutdown()
