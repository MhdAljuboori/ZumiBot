import { decideClose, type CloseDecision } from './quitGuard'

export interface CloseFlowDeps {
  getState(): { editorDirty: boolean; runningCount: number; processCount?: number }
  askUnsaved(): Promise<'save' | 'discard' | 'cancel'>
  saveBeforeClose(): Promise<boolean>
  askRunning(n: number, processes: number): Promise<boolean> // true = Stop & Quit
  stopAll(): Promise<void>
  /** Brings getState() up to date (undefined when there is nothing to refresh). A failure keeps the cached state. */
  refreshState?(): Promise<void> | undefined
  closeWindow(): void // like BrowserWindow.close(): synchronously re-enters onClose
  isGone(): boolean
  onError(err: unknown): void
  /** Right before each dialog: the shell raises the window so the dialog is not hidden behind it. */
  onAsk?(): void
  /** A close attempt that ended with the window staying open (Cancel, a failed save or a failed ask). */
  onStay?(): void
}

type Outcome = 'stay' | 'recheck' | 'close'

export function createCloseFlow(d: CloseFlowDeps): { onClose(): boolean } {
  let approved = false
  let skipUnsaved = false
  let asking = false
  let fresh = false // the state was just refreshed for the close being re-run

  async function ask(kind: Exclude<CloseDecision, 'close'>): Promise<Outcome> {
    d.onAsk?.()
    if (kind === 'ask-unsaved') {
      const choice = await d.askUnsaved()
      if (d.isGone() || choice === 'cancel') return 'stay'
      if (choice === 'save' && !(await d.saveBeforeClose())) return 'stay'
      skipUnsaved = true
      return 'recheck' // running replies may still need confirming
    }
    const s = d.getState()
    if (!(await d.askRunning(s.runningCount, s.processCount ?? 0)) || d.isGone()) return 'stay'
    await d.stopAll()
    return d.isGone() ? 'stay' : 'close'
  }

  async function run(kind: Exclude<CloseDecision, 'close'>): Promise<void> {
    let outcome: Outcome
    try {
      outcome = await ask(kind)
    } catch (err) {
      d.onError(err)
      outcome = 'stay'
    }
    if (outcome === 'stay') {
      skipUnsaved = false
      d.onStay?.()
    }
    asking = false // before closeWindow(): it re-enters onClose, which may need to ask again
    if (outcome === 'close') approved = true
    if (outcome !== 'stay') d.closeWindow()
  }

  return {
    // Returns true when the window may close, false when the close event must be prevented.
    onClose(): boolean {
      if (approved) return true
      if (!fresh && !asking) {
        // The polled running count can be 2 s stale: a reply started since then must still be guarded.
        const pending = d.refreshState?.()
        if (pending) {
          asking = true
          void pending
            .catch(() => {})
            .then(() => {
              asking = false // before closeWindow(): it re-enters onClose
              if (d.isGone()) return
              fresh = true
              d.closeWindow()
            })
          return false
        }
      }
      fresh = false
      const s = d.getState()
      const decision = decideClose({
        editorDirty: s.editorDirty && !skipUnsaved,
        runningCount: s.runningCount,
        processCount: s.processCount
      })
      if (decision === 'close') return true
      if (!asking) {
        asking = true
        void run(decision)
      }
      return false
    }
  }
}
