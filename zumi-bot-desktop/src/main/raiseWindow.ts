/**
 * How the main window comes up when the user asks for it.
 * - `go`: to the window, as a dock or tray click does for any other app (the dock icon's second launch, tray Open, a
 *   notification click): on another workspace, the window manager switches the user there.
 * - `bring`: onto the workspace the user is on (the island's Open in ZumiBot: the island is the way to stay where
 *   you work).
 */
export type RaiseMode = 'go' | 'bring'

export interface RaisableWindow {
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  focus(): void
  setVisibleOnAllWorkspaces(on: boolean): void
}

/**
 * Never hide() then show() a visible window to move it: the window manager's withdraw clean-up deletes _NET_WM_STATE
 * after Chromium wrote it back for the new map, so the window came back unmaximized, at another size.
 */
export function raiseWindow(w: RaisableWindow, mode: RaiseMode, showHidden: () => void): void {
  if (w.isMinimized()) w.restore()
  // Hidden to the tray: mapped on the current workspace; showHidden brings back a maximized one maximized (see
  // showHiddenWindow).
  if (!w.isVisible()) showHidden()
  // Off every workspace means _NET_WM_DESKTOP = the current one: the window moves here, still mapped, size kept.
  else if (mode === 'bring') w.setVisibleOnAllWorkspaces(false)
  // _NET_ACTIVE_WINDOW with a fresh server time: Mutter focuses it, switching to its workspace when it is elsewhere.
  w.focus()
}
