import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  STRIP_AFTER_MS,
  pruneMessages,
  type InboxMessages,
  type NewWorkflowMessage,
  type WorkflowMessage,
  type WorkflowMessagesFile
} from '@zumibot/shared/inbox'
import { writeFileAtomic } from '../fsutil'

export const MESSAGE_NOT_FOUND = 'Message not found'
export const TOO_LATE = 'Too late to undo'

const empty = (): WorkflowMessagesFile => ({ v: 1, seenAt: 0, messages: [] })

/** workflow-messages.json: what Notify steps sent, kept as the Inbox's Messages. Written 0600, since it holds step text. */
export class WorkflowMessages {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number,
    // Told of each message stored for the first time (the Inbox trigger); a throw never fails the add.
    private readonly onAdded?: (m: WorkflowMessage) => void
  ) {
    this.file = join(dataDir, 'workflow-messages.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<WorkflowMessagesFile> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<WorkflowMessagesFile>
      if (!raw || !Array.isArray(raw.messages)) return empty()
      return {
        v: 1,
        seenAt: typeof raw.seenAt === 'number' ? raw.seenAt : 0,
        messages: raw.messages.filter((m): m is WorkflowMessage => !!m && typeof m.id === 'string')
      }
    } catch {
      return empty()
    }
  }

  private async write(f: WorkflowMessagesFile): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.file, JSON.stringify(pruneMessages(f, this.now()), null, 2), 0o600)
  }

  add(m: NewWorkflowMessage): Promise<boolean> {
    return this.run(async () => {
      const f = await this.read()
      if (f.messages.some((x) => x.id === m.id)) return false
      const stored: WorkflowMessage = { ...m, updatedAt: this.now() }
      f.messages.push(stored)
      await this.write(f)
      try {
        this.onAdded?.(stored)
      } catch {
        /* the message is stored */
      }
      return true
    })
  }

  has(id: string): Promise<boolean> {
    return this.run(async () => (await this.read()).messages.some((x) => x.id === id))
  }

  list(): Promise<InboxMessages> {
    return this.run(async () => {
      const f = await this.read()
      return { messages: f.messages.filter((m) => m.deletedAt === undefined), seenAt: f.seenAt }
    })
  }

  // A tombstone counts as missing for archive: a deleted message is gone from the user's view.
  private change(id: string, edit: (m: WorkflowMessage, now: number) => void): Promise<void> {
    return this.run(async () => {
      const f = await this.read()
      const m = f.messages.find((x) => x.id === id)
      if (!m) throw new Error(MESSAGE_NOT_FOUND)
      edit(m, this.now())
      await this.write(f)
    })
  }

  setArchived(id: string, on: boolean): Promise<void> {
    return this.change(id, (m, now) => {
      if (m.deletedAt !== undefined) throw new Error(MESSAGE_NOT_FOUND)
      if (on) m.archivedAt = now
      else delete m.archivedAt
      m.updatedAt = now
    })
  }

  remove(id: string): Promise<void> {
    return this.change(id, (m, now) => {
      if (m.deletedAt !== undefined) return
      m.deletedAt = now
      m.updatedAt = now
    })
  }

  restore(id: string): Promise<void> {
    return this.change(id, (m, now) => {
      if (m.deletedAt === undefined) return
      // The text is gone from the file only at the next write, so the window is judged by time.
      if (now - m.deletedAt > STRIP_AFTER_MS || m.title === '') throw new Error(TOO_LATE)
      delete m.deletedAt
      m.updatedAt = now
    })
  }

  markSeen(at: number): Promise<void> {
    return this.run(async () => {
      const f = await this.read()
      if (at <= f.seenAt) return
      f.seenAt = at
      await this.write(f)
    })
  }
}
