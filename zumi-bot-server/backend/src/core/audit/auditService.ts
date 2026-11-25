import type { AuditRecord } from '@zumibot/shared/audit'
import { AuditTap, type AuditRun, type AuditTapDeps } from './auditTap'

/** What a run hands the audit: its own facts, read lazily where they may change mid-run. */
export type AuditRunDeps = Pick<AuditTapDeps, 'agent' | 'scrub' | 'fillRow'>

/** The one place runs get a tap from (ChatService, side runs). */
export interface AuditSource {
  tap(run: AuditRun, d: AuditRunDeps): AuditTap
}

export class AuditService implements AuditSource {
  constructor(
    private o: {
      machine: string
      now(): number
      newId(): string
      write(record: Omit<AuditRecord, 'prev'>): void
      /** The routine whose run is active in a chat, for a routine run's link. */
      routineOf?(chatId: string): string | null
    }
  ) {}

  /** One record written outside a tool call (a Run button press): the caller supplies the facts, this fills the log's own. */
  async record(r: Omit<AuditRecord, 'v' | 'id' | 'machine' | 'prev'>): Promise<void> {
    this.o.write({ ...r, v: 1, id: this.o.newId(), machine: this.o.machine })
  }

  tap(run: AuditRun, d: AuditRunDeps): AuditTap {
    let link = run
    if (run.runKind === 'routine' && !run.routine && this.o.routineOf) {
      const id = this.o.routineOf(run.chatId)
      if (id) link = { ...run, routine: { id } }
    }
    return new AuditTap(link, { ...d, now: this.o.now, newId: this.o.newId, machine: this.o.machine, write: this.o.write })
  }
}
