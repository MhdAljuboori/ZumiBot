import type {
  BrowserCommand,
  BrowserConfig,
  BrowserFill,
  BrowserFrame,
  BrowserHandoff,
  BrowserInput,
  BrowserOwner,
  BrowserResult,
  BrowserStatus,
  BrowserTab,
  BrowserTarget,
  BrowserViewport
} from '@zumibot/shared/browser'
export type * from '@zumibot/shared/browser'

export interface BrowserDownloadSource extends AsyncIterable<Uint8Array> {
  readonly retainsSource?: true
  readonly sourceId?: string
}
export interface BrowserFileHooks {
  sourceClosed?(sourceId: string): Promise<void> | void
  download(
    source: BrowserDownloadSource,
    name: string,
    generation: string,
    signal?: AbortSignal
  ): Promise<{ id: string; name: string; size: number }>
}
export interface BrowserAdapter {
  launch(profileDir: string, config: BrowserConfig, files?: BrowserFileHooks): Promise<BrowserInstance>
}
export interface BrowserInstance {
  readonly generation: string
  isClosed(): boolean
  status(): {
    tabs: BrowserTab[]
    activeTabId: string | null
    dialog?: import('@zumibot/shared/browser').BrowserDialog | null
    fileChooser?: { tabId: string; multiple: boolean } | null
  }
  execute(command: BrowserCommand, signal: AbortSignal, uploadPaths?: string[]): Promise<BrowserResult>
  /** One vault value into one element, after the host and element checks; the result never holds the value. */
  fill(fill: BrowserFill, signal: AbortSignal): Promise<BrowserResult>
  input(input: BrowserInput, signal: AbortSignal): Promise<void>
  invalidateReferences(): Promise<void>
  /** Resize every tab to the viewer's surface; frames follow at that size and pixel density. */
  setViewport(viewport: BrowserViewport): Promise<void>
  startFrames(onFrame: (frame: BrowserFrame) => void): Promise<void>
  stopFrames(): Promise<void>
  onChanged(cb: () => void): () => void
  close(): Promise<void>
}
/** A failed launch still reserves capacity until this instance confirms teardown. */
export class BrowserLaunchCleanupError extends Error {
  constructor(readonly instance: BrowserInstance) {
    super('Browser launch cleanup could not be confirmed')
  }
}
export interface BrowserViewer {
  id: string
  sessionKey: string
  signal?: AbortSignal
  sendStatus(status: BrowserStatus): void
  sendFrame(frame: BrowserFrame): void
}
export interface BrowserSubscription {
  close(): Promise<void>
}
export interface BrowserManager {
  registerTurn(turnId: string, callback: (handoff: BrowserHandoff) => Promise<void>): () => void
  status(agent: string): Promise<BrowserStatus>
  run(owner: BrowserOwner, command: BrowserCommand, signal: AbortSignal): Promise<BrowserResult>
  watch(target: BrowserTarget, viewer: BrowserViewer): Promise<BrowserSubscription>
  connect(target: BrowserTarget, viewer: BrowserViewer, options: { frames: false }): Promise<BrowserSubscription>
  takeControl(viewerId: string): Promise<void>
  releaseControl(viewerId: string): Promise<void>
  input(viewerId: string, input: BrowserInput): Promise<void>
  /** A visible viewer's surface size; the controller's wins, then the latest, then the default. */
  resize(viewerId: string, viewport: BrowserViewport): Promise<void>
  navigate(viewerId: string, command: BrowserCommand, location?: Pick<BrowserInput, 'generation' | 'tabId'>): Promise<BrowserResult>
  stageUpload(
    viewerId: string,
    location: Pick<BrowserInput, 'generation' | 'tabId'>,
    source: AsyncIterable<Uint8Array>,
    name: string
  ): Promise<{ id: string; name: string; size: number }>
  answer(viewerId: string, requestId: string, decision: 'done' | 'cancel'): Promise<void>
  endTurn(turnId: string): Promise<void>
  clear(agent: string): Promise<void>
  renameAgent(from: string, to: string): Promise<void>
  removeAgents(names: readonly string[]): Promise<void>
  close(): Promise<void>
}
