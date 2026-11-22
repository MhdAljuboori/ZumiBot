import type {
  BrowserAdapter,
  BrowserCommand,
  BrowserConfig,
  BrowserFill,
  BrowserFrame,
  BrowserInput,
  BrowserInstance,
  BrowserResult,
  BrowserTab,
  BrowserViewport
} from '../../src/core/browser/types'
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
/** A real 1x1 PNG, so a saved shot has bytes a store can write and read back. */
export const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
export class FakeBrowser implements BrowserInstance {
  tabs: BrowserTab[] = [{ id: 'tab1', title: '', url: 'about:blank' }]
  activeTabId: string | null = 'tab1'
  commands: BrowserCommand[] = []
  inputs: BrowserInput[] = []
  viewports: BrowserViewport[] = []
  observations = 0
  closed = false
  frameCallback?: (frame: BrowserFrame) => void
  executeGate?: ReturnType<typeof deferred<BrowserResult>>
  invalidateGate?: ReturnType<typeof deferred<void>>
  closeGate?: ReturnType<typeof deferred<void>>
  stopFrameGate?: ReturnType<typeof deferred<void>>
  frameGate?: ReturnType<typeof deferred<void>>
  listeners = new Set<() => void>()
  fills: BrowserFill[] = []
  /** Answers for the next fills, in order; a fill with none left is filled. */
  fillResults: BrowserResult[] = []
  /** A result for a command instead of the default one. */
  respond?: (command: BrowserCommand) => BrowserResult | undefined
  constructor(
    readonly generation: string,
    readonly dir: string
  ) {}
  isClosed() {
    return this.closed
  }
  status() {
    return { tabs: this.tabs, activeTabId: this.activeTabId }
  }
  async execute(command: BrowserCommand, _signal: AbortSignal, _uploadPaths?: string[]): Promise<BrowserResult> {
    this.commands.push(command)
    if (this.executeGate) return this.executeGate.promise
    const answer = this.respond?.(command)
    if (answer) return answer
    if (command.op === 'newTab') {
      this.activeTabId = `tab${this.tabs.length + 1}`
      this.tabs.push({ id: this.activeTabId, title: '', url: command.url ?? 'about:blank' })
    }
    if (command.op === 'navigate') this.tabs.find((t) => t.id === this.activeTabId)!.url = command.url
    if (command.op === 'observe')
      return {
        ok: true,
        data: { stamp: { generation: this.generation, tabId: this.activeTabId, observationId: `obs${this.observations}` } }
      }
    // A page screenshot carries no stamp.
    if ('stamp' in command && command.stamp && command.stamp.observationId !== `obs${this.observations}`)
      return { ok: false, code: 'stale_ref', message: 'Stale reference' }
    if (command.op === 'saveScreenshot') return { ok: true, data: { mimeType: 'image/png', base64: FAKE_PNG, width: 1, height: 1 } }
    if (command.op === 'computedStyle')
      return {
        ok: true,
        data: {
          style: { color: 'rgb(0, 0, 0)', 'background-color': 'rgb(255, 255, 255)', 'font-size': '16px' },
          rect: { x: 0, y: 0, width: 100, height: 20 }
        }
      }
    if (command.op === 'hover') return { ok: true, data: { hovered: true } }
    this.listeners.forEach((fn) => fn())
    return { ok: true, data: null }
  }
  async fill(f: BrowserFill, _signal: AbortSignal): Promise<BrowserResult> {
    this.fills.push(structuredClone(f))
    return this.fillResults.shift() ?? { ok: true, data: { filled: true } }
  }
  async input(input: BrowserInput) {
    this.inputs.push(input)
  }
  async setViewport(viewport: BrowserViewport) {
    this.viewports.push(viewport)
  }
  async invalidateReferences() {
    if (this.invalidateGate) await this.invalidateGate.promise
    this.observations++
  }
  async startFrames(callback: (frame: BrowserFrame) => void) {
    if (this.frameGate) await this.frameGate.promise
    this.frameCallback = callback
  }
  async stopFrames() {
    if (this.stopFrameGate) await this.stopFrameGate.promise
    this.frameCallback = undefined
  }
  onChanged(callback: () => void) {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }
  async close() {
    if (this.closeGate) await this.closeGate.promise
    this.closed = true
    this.frameCallback = undefined
  }
}
export class FakeBrowserAdapter implements BrowserAdapter {
  instances: FakeBrowser[] = []
  launchGate?: ReturnType<typeof deferred<void>>
  launching = 0
  maxSlots = 0
  async launch(dir: string, _config: BrowserConfig) {
    this.launching++
    this.maxSlots = Math.max(this.maxSlots, this.launching + this.instances.filter((i) => !i.closed).length)
    const id = this.instances.length + 1
    if (this.launchGate) await this.launchGate.promise
    const instance = new FakeBrowser(`generation${id}`, dir)
    this.instances.push(instance)
    this.launching--
    return instance
  }
}
