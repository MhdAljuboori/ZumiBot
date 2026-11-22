import type { DesktopConfig } from '@zumibot/shared/desktop'

export type { DesktopConfig } from '@zumibot/shared/desktop'

/** The content blocks ZumiBot keeps from a cua-driver tool result; other block types are dropped. */
export type CuaContent = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

/** `structuredContent` carries what the text does not: window lists, element tokens, error `code`. */
export interface CuaResult {
  content: CuaContent[]
  isError: boolean
  structuredContent: Record<string, unknown> | null
}

export interface DesktopInstance {
  readonly generation: string
  readonly vncSocket: string
  readonly display: number
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CuaResult>
  isClosed(): boolean
  /**
   * Fires once when the desktop dies on its own (any of its processes exited), after the cleanup
   * attempt, even when close() was called during that teardown. A stop that close() starts never fires it.
   */
  onExit(cb: () => void): () => void
  /** Rejects when cleanup cannot be confirmed (the display stays reserved); a later call runs it again. */
  close(): Promise<void>
}

export interface DesktopAdapter {
  launch(dir: string, config: DesktopConfig, signal: AbortSignal): Promise<DesktopInstance>
}

/** The host lacks a program the desktop needs; `missing` holds fixed human names, never paths. */
export class DesktopUnavailableError extends Error {
  constructor(readonly missing: string[]) {
    super(`Desktop unavailable: ${missing.join(', ')} not found`)
    this.name = 'DesktopUnavailableError'
  }
}

/** A failed launch still holds its display and processes until `instance.close()` confirms the cleanup. */
export class DesktopLaunchCleanupError extends Error {
  constructor(readonly instance: DesktopInstance) {
    super('Desktop launch cleanup could not be confirmed')
    this.name = 'DesktopLaunchCleanupError'
  }
}
