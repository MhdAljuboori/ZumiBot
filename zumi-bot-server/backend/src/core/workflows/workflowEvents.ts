import type { ChatMeta } from '@zumibot/shared/types'
import type { Workflow, WorkflowRun } from '@zumibot/shared/workflows'
import { filtersMatch } from '@zumibot/shared/workflowTemplate'
import { EVENT_RUNS_PER_MINUTE, INBOX_CHAIN_MAX, eventCall, eventText, type WorkflowEvent } from '@zumibot/shared/workflowEvents'
import type { WorkflowRunner } from './workflowRunner'

export interface EventDispatcherDeps {
  workflows(): Promise<Workflow[]>
  run: WorkflowRunner['run']
  chatMeta(chatId: string): Promise<ChatMeta | null>
  getRun(runId: string): Promise<WorkflowRun | null>
  busy(workflowId: string): boolean // a run of it is unfinished (the file guard)
  activeDepths(exceptWorkflowId: string): number[] // the event depth of every other workflow's unfinished run (0 = none)
  now(): number
  log(line: string): void
}

const WINDOW_MS = 60_000
const PARENT_HOPS_MAX = 10

/** A chat a workflow, a step test or an A→B ask made: its replies and to-dos never start workflows, or they would loop. */
export const workflowChat = (m: ChatMeta): boolean => !!m.workflow || m.workflowTest !== undefined || !!m.asked

export class WorkflowEventDispatcher {
  private readonly starts = new Map<string, number[]>() // per workflow: start times in the last minute

  constructor(private readonly d: EventDispatcherDeps) {}

  /** `only`: one workflow id, for the file and email watchers, which fire per workflow. Never throws. */
  async emit(e: WorkflowEvent, o: { only?: string } = {}): Promise<void> {
    try {
      const listening = (await this.d.workflows()).filter((w) => w.enabled && w.trigger.kind === e.kind && (!o.only || w.id === o.only))
      if (!listening.length) return
      if ((e.kind === 'reply' || e.kind === 'todo') && !(await this.normalChat(e.body.chat.id))) return
      const inboxDepth = e.kind === 'inbox' ? await this.inboxDepth(e.body.runId) : 0
      if (inboxDepth > INBOX_CHAIN_MAX) return
      const input = eventText(e)
      const runs: Promise<unknown>[] = []
      // No await from here to the last run() call, so two emits cannot both take the same slot of the cap.
      for (const w of listening) {
        if (e.kind === 'inbox' && w.id === e.body.workflow.id) continue
        if (!('filters' in w.trigger) || !filtersMatch(w.trigger.filters, eventCall(e.body, this.d.now()))) continue
        // A file run's own agent writes into the watched folder. The watcher already dropped what it saw while busy
        // (fileBusy); checked again here, since a run may have started between the change and this flush.
        if (e.kind === 'file' && this.d.busy(w.id)) continue
        // A file change may be another workflow's write (an Inbox-started run filing notes into the folder), so the chain
        // goes on through it: past INBOX_CHAIN_MAX it stops, as an Inbox chain does.
        const depth = e.kind === 'file' ? this.fileDepth(w.id) : inboxDepth
        if (depth > INBOX_CHAIN_MAX) continue
        if (!this.take(w.id)) {
          this.d.log(`workflow event dropped: ${w.id} passed ${EVENT_RUNS_PER_MINUTE} runs in a minute`)
          continue
        }
        const at = this.d.now()
        runs.push(this.d.run(w, 'event', { call: eventCall(e.body, at), input, event: { kind: e.kind, ...(depth ? { depth } : {}) } }))
      }
      const done = await Promise.allSettled(runs)
      for (const r of done)
        if (r.status === 'rejected')
          this.d.log(`workflow event run failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
    } catch (err) {
      this.d.log(`workflow event failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // A deleted chat has nothing left to report on, so it fires nothing.
  private async normalChat(chatId: string): Promise<boolean> {
    const m = await this.d.chatMeta(chatId)
    return !!m && !workflowChat(m)
  }

  /**
   * The depth a run started by this Inbox message would get: 1 more than the chain that made the message, whatever event
   * started its root (a file change, a reply, another Inbox message; no depth stored = 1).
   */
  private async inboxDepth(runId: string): Promise<number> {
    let root = await this.d.getRun(runId)
    for (let hops = 0; root?.parent && hops < PARENT_HOPS_MAX; hops++) {
      const up = await this.d.getRun(root.parent.runId)
      if (!up) break
      root = up
    }
    const base = root?.via === 'event' ? (root.event?.depth ?? 1) : 0
    return base + 1
  }

  /** A file run's depth: 1 more than the deepest unfinished run of another workflow (none = 1), any of which may have written the file. */
  private fileDepth(workflowId: string): number {
    return 1 + Math.max(0, ...this.d.activeDepths(workflowId))
  }

  /** Books a start in the workflow's last minute; false when it already has the cap. */
  private take(workflowId: string): boolean {
    const t = this.d.now()
    const recent = (this.starts.get(workflowId) ?? []).filter((s) => t - s <= WINDOW_MS)
    if (recent.length >= EVENT_RUNS_PER_MINUTE) {
      this.starts.set(workflowId, recent)
      return false
    }
    recent.push(t)
    this.starts.set(workflowId, recent)
    return true
  }
}
