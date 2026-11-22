/** The app version from package.json, put in by vite.config.ts at build time. */
declare const __APP_VERSION__: string

/** noVNC 1.7.0 ships no types: only what DesktopPanel uses. */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    /** A string is a URL; anything else is a WebSocket-like channel noVNC attaches to. */
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: { shared?: boolean })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    showDotCursor: boolean
    focusOnClick: boolean
    background: string
    disconnect(): void
    /** Sends the text as the desktop's clipboard (ClientCutText); a no-op while view-only. */
    clipboardPasteFrom(text: string): void
    focus(options?: FocusOptions): void
    blur(): void
  }
}
