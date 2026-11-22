import { join, basename } from 'node:path'
import type { FileChange, Workflow } from '@zumibot/shared/workflows'
import { FILE_BURST_MAX, FILE_BURST_MS, nameMatches, type WorkflowEvent } from '@zumibot/shared/workflowEvents'

export interface FileWatchDeps {
  /** fs.watch recursive in app.ts; `type` is fs.watch's own event type. */
  watch(dir: string, onChange: (relPath: string, type: 'rename' | 'change') => void, onError: (e: Error) => void): { close(): void }
  stat(path: string): Promise<'file' | 'dir' | null>
  emit(e: Extract<WorkflowEvent, { kind: 'file' }>, workflowId: string): void
  setTimer(fn: () => void, ms: number): { clear(): void }
  log(line: string): void
  /** A run of the workflow is unfinished or just ended (`fileBusy`): a change seen then is its own agent's write. */
  busy(workflowId: string): boolean
}

/**
 * Busy for the file guard: a run unfinished, or one that ended less than FILE_BURST_MS ago, since a write made just before
 * the end reaches the watch after it. Checked when a change is seen, not at the flush, which comes FILE_BURST_MS later.
 */
export const fileBusy =
  (runner: { busy(id: string): boolean; endedRecently(id: string, ms: number): boolean }) =>
  (workflowId: string): boolean =>
    runner.busy(workflowId) || runner.endedRecently(workflowId, FILE_BURST_MS)

interface Watch {
  path: string
  handle: { close(): void }
  timer: { clear(): void } | null
  pending: Map<string, boolean> // relative path -> a 'rename' was seen in this burst
}

// A repo's own churn (git, installs) would start a run for nothing the user is watching for.
const ignored = (rel: string): boolean => rel.split(/[\\/]/).some((s) => s === '.git' || s === 'node_modules')

/** One recursive folder watch per enabled `file` workflow; changes are debounced into one event per burst. */
export class FileWatchers {
  private readonly watches = new Map<string, Watch>() // by workflow id
  private current = new Map<string, Workflow>() // the last sync, read at flush so a pattern edit needs no reopen
  // The last failure logged per workflow: a dead folder fails again at every sync (each workflows change), so it logs once.
  private readonly failed = new Map<string, string>()

  constructor(private readonly d: FileWatchDeps) {}

  sync(workflows: Workflow[]): void {
    this.current = new Map(workflows.map((w) => [w.id, w]))
    for (const [id, w] of this.watches) {
      if (this.pathOf(id) !== w.path) this.close(id)
    }
    // Off, deleted or no longer a file trigger: turned on again, its first failure is news.
    for (const id of [...this.failed.keys()]) if (!this.pathOf(id)) this.failed.delete(id)
    for (const w of workflows) {
      const path = this.pathOf(w.id)
      if (path && !this.watches.has(w.id)) this.open(w, path)
    }
  }

  stop(): void {
    for (const id of [...this.watches.keys()]) this.close(id)
  }

  // Empty when the workflow is gone, disabled, or no longer a file trigger with a folder.
  private pathOf(id: string): string {
    const w = this.current.get(id)
    return w && w.enabled && w.trigger.kind === 'file' ? w.trigger.path : ''
  }

  private open(w: Workflow, path: string): void {
    const entry: Watch = { path, handle: { close: () => undefined }, timer: null, pending: new Map() }
    try {
      entry.handle = this.d.watch(
        path,
        (rel, type) => this.changed(w.id, entry, rel, type),
        (err) => {
          this.fail(w.id, err.message)
          if (this.watches.get(w.id) === entry) this.close(w.id) // forgotten: the next sync reopens it
        }
      )
    } catch (err) {
      this.fail(w.id, err instanceof Error ? err.message : String(err))
      return
    }
    this.watches.set(w.id, entry)
  }

  private close(id: string): void {
    const w = this.watches.get(id)
    if (!w) return
    this.watches.delete(id)
    w.timer?.clear()
    w.timer = null
    w.pending.clear()
    try {
      w.handle.close()
    } catch {
      /* already closed after an error */
    }
  }

  private changed(id: string, entry: Watch, rel: string, type: 'rename' | 'change'): void {
    if (this.watches.get(id) !== entry) return
    // It reports changes, so it works: its next failure is logged again. An open alone proves less, since an error can follow it.
    this.failed.delete(id)
    if (ignored(rel) || this.d.busy(id)) return
    entry.pending.set(rel, (entry.pending.get(rel) ?? false) || type === 'rename')
    // Armed once per quiet period, not on every change, so a steady stream still flushes every FILE_BURST_MS.
    entry.timer ??= this.d.setTimer(() => {
      void this.flush(id, entry)
    }, FILE_BURST_MS)
  }

  private async flush(id: string, entry: Watch): Promise<void> {
    const seen = [...entry.pending]
    entry.pending.clear()
    entry.timer = null
    try {
      const kinds = await Promise.all(seen.map(([rel]) => this.d.stat(join(entry.path, rel))))
      // Closed or replaced while statting: its folder is no longer the one this workflow watches.
      if (this.watches.get(id) !== entry) return
      const t = this.current.get(id)?.trigger
      if (t?.kind !== 'file') return
      const files: { path: string; name: string; change: FileChange }[] = []
      seen.forEach(([rel, renamed], i) => {
        const kind = kinds[i]
        if (kind === 'dir') return
        const path = join(entry.path, rel)
        const name = basename(path)
        // A rename is how fs.watch reports a create or a delete; a write through a temp file also reads as added.
        const change: FileChange = kind === null ? 'removed' : renamed ? 'added' : 'changed'
        if (!t.changes.includes(change) || !nameMatches(t.pattern, name)) return
        files.push({ path, name, change })
      })
      if (!files.length) return
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      // The whole count, so a workflow can tell a cut list from a burst of exactly FILE_BURST_MAX files.
      const capped = files.slice(0, FILE_BURST_MAX)
      this.d.emit(
        { kind: 'file', body: { folder: entry.path, count: files.length, truncated: files.length > FILE_BURST_MAX, files: capped } },
        id
      )
    } catch (err) {
      this.fail(id, err instanceof Error ? err.message : String(err))
    }
  }

  // Names the workflow and the error only; the same error again is not logged until the watch has worked.
  private fail(id: string, message: string): void {
    if (this.failed.get(id) === message) return
    this.failed.set(id, message)
    this.d.log(`file watch failed for ${this.current.get(id)?.name ?? id}: ${message}`)
  }
}
