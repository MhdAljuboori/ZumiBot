export interface SwitchDeps {
  isDirty(): boolean // the agent editor has unsaved edits
  askUnsaved(): Promise<'save' | 'discard' | 'cancel'>
  saveBeforeClose(): Promise<boolean>
  isLocal(): boolean
  busy(): Promise<number>
  /** Background processes the local server ends when it stops; absent or failing reads as none. */
  processes?(): Promise<number>
  askRunning(n: number, processes: number): Promise<boolean> // true = Stop & Switch
  stopLocal(): Promise<void>
  showPicker(): void
  onError(err: unknown): void
}

/** "Switch server…": unsaved edits first, then running replies and background processes, then stop the local server and open the picker. */
export function createSwitchServer(d: SwitchDeps): () => Promise<void> {
  let switching = false
  return async () => {
    if (switching) return
    switching = true
    try {
      if (d.isDirty()) {
        const choice = await d.askUnsaved()
        if (choice === 'cancel') return
        if (choice === 'save' && !(await d.saveBeforeClose())) return
      }
      if (d.isLocal()) {
        const n = await d.busy().catch(() => 0) // no answer from the control socket reads as idle
        // An older server has no processes line: it reads as none.
        const p = (await d.processes?.().catch(() => 0)) ?? 0
        if ((n > 0 || p > 0) && !(await d.askRunning(n, p))) return
        await d.stopLocal()
      }
      d.showPicker()
    } catch (err) {
      d.onError(err)
    } finally {
      switching = false
    }
  }
}
