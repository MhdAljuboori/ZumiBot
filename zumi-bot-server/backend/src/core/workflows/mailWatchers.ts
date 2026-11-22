import type { Workflow, WorkflowTrigger } from '@zumibot/shared/workflows'
import { MAIL_PER_CHECK, MAIL_POLL_MS, type EventBodies, type WorkflowEvent } from '@zumibot/shared/workflowEvents'
import { ACCOUNT_MISSING, MAIL_HOST_MISSING } from './workflowRunner'

type EmailTrigger = Extract<WorkflowTrigger, { kind: 'email' }>

export interface MailClient {
  open(): Promise<{ uidValidity: string; uidNext: number; exists: number }>
  /** Messages with a UID past `uid`, at most `max`, in any order. */
  fetchSince(uid: number, max: number): Promise<{ uid: number; source: Buffer }[]>
  close(): Promise<void>
}

export interface MailDeps {
  /** imapflow over TLS, logger off, the folder opened read-only (`mailClient.ts`). */
  connect(o: { host: string; port: number; user: string; password: string; folder: string }): Promise<MailClient>
  parse(source: Buffer): Promise<EventBodies['email']>
  /** The Vault login a workflow may use, read per check: a switch turned off or a deleted login stops the next one. */
  account(id: string): { username: string; password: string } | null
  /** `<data>/workflow-mail.json`, 0600. */
  state: { read(): Promise<MailState>; write(s: MailState): Promise<void> }
  emit(e: Extract<WorkflowEvent, { kind: 'email' }>, workflowId: string): void
  setTimer(fn: () => void, ms: number): { clear(): void }
  log(line: string): void
  /** How many more runs of the workflow may start now (the active-run cap less its unfinished runs). */
  freeRuns(workflowId: string): number
}

/** Per workflow: which mailbox the UIDs belong to (`host|user|folder`), its UIDVALIDITY, and the last UID seen. */
export type MailState = Record<string, { key: string; uidValidity: string; lastUid: number }>

/** Check mailbox waits this long for the server before it answers. */
export const MAIL_CHECK_MS = 30_000
/** A poll's own limit, ending before the next tick: a server that never finishes costs one tick, not the trigger. */
export const MAIL_CHECK_DEADLINE_MS = MAIL_POLL_MS - 10_000
const LATE = 'The mail server did not answer in time.'
const ERROR_MAX = 500

/** The password, and its IMAP-quoted form (a LOGIN command echoed back), become `***`. */
export function scrubPassword(text: string, password: string): string {
  if (!password) return text
  const quoted = password.replace(/[\\"]/g, '\\$&')
  return text.split(quoted).join('***').split(password).join('***')
}

// imapflow's own messages are generic ("Authentication failed"); the server's reason is in responseText. A connect
// refused on every address of a host is an AggregateError with an empty message: its first cause says what happened.
function mailError(err: unknown, password: string): string {
  const e = err as { errors?: unknown; code?: unknown; responseText?: unknown } | null
  let message = err instanceof Error ? err.message : String(err)
  if (!message.trim()) {
    const first: unknown = Array.isArray(e?.errors) ? e.errors[0] : undefined
    const inner = first instanceof Error ? first.message.trim() : ''
    message = inner || (typeof e?.code === 'string' && e.code ? e.code : 'Could not connect to the mail server')
  }
  const reason = e?.responseText
  const text = typeof reason === 'string' && reason && !message.includes(reason) ? `${message}: ${reason}` : message
  return scrubPassword(text, password).slice(0, ERROR_MAX)
}

const keyOf = (host: string, t: EmailTrigger, user: string): string => `${host}|${user}|${t.folder}`
// What the poll depends on; anything else (name, filters, a run's progress) keeps the timer and the state.
const configOf = (w: Workflow): string =>
  w.enabled && w.trigger.kind === 'email' ? JSON.stringify([w.trigger.account, w.trigger.host, w.trigger.port, w.trigger.folder]) : ''

/** Signs in once and counts the folder's messages, for the inspector's Check mailbox. Never throws; errors carry no password. */
export async function checkMailbox(
  d: Pick<MailDeps, 'connect' | 'account'>,
  t: EmailTrigger,
  timeoutMs = MAIL_CHECK_MS
): Promise<{ messages: number } | { error: string }> {
  const account = d.account(t.account)
  if (!account) return { error: ACCOUNT_MISSING }
  // Trimmed: imapflow takes an empty host as localhost, and a pasted space would only fail the lookup.
  const host = t.host.trim()
  if (!host) return { error: MAIL_HOST_MISSING }
  const check = (async (): Promise<{ messages: number } | { error: string }> => {
    let client: MailClient | null = null
    try {
      client = await d.connect({ host, port: t.port, user: account.username, password: account.password, folder: t.folder })
      return { messages: (await client.open()).exists }
    } catch (err) {
      return { error: mailError(err, account.password) }
    } finally {
      await client?.close().catch(() => undefined)
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  // A server that accepts the connection and then says nothing must not hang the call; imapflow's own timeouts end it later.
  const late = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ error: LATE }), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([check, late])
  } finally {
    clearTimeout(timer)
  }
}

interface Watch {
  config: string
  timer: { clear(): void }
  running: Promise<void> | null
}

/** One check: its connection, so the deadline can close it, and whether the deadline already ended it. */
interface Run {
  client: MailClient | null
  over: boolean
}

/** Polls each enabled email workflow's folder every MAIL_POLL_MS and emits one event per new message, oldest first. */
export class MailWatchers {
  private readonly watches = new Map<string, Watch>() // by workflow id
  private current = new Map<string, Workflow>()
  private readonly failed = new Map<string, string>() // the last error logged per workflow, so a dead mailbox logs once
  private state: Promise<MailState> | null = null
  private writing: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: MailDeps) {}

  /** Called on every workflows change: keeps a workflow's timer unless what it polls changed. */
  sync(workflows: Workflow[]): void {
    this.current = new Map(workflows.map((w) => [w.id, w]))
    // Read at the first sync, keeping only the workflows on now: one turned off before a restart starts over when turned on.
    this.state ??= this.read(new Set(workflows.filter((w) => configOf(w)).map((w) => w.id)))
    const off: string[] = []
    for (const [id, watch] of this.watches) {
      const w = this.current.get(id)
      if (w && configOf(w) === watch.config) continue
      this.close(id)
      if (!w || !configOf(w)) off.push(id)
    }
    // Turned off or deleted: its place in the mailbox is forgotten, so turning it on again fires only mail from then on.
    if (off.length) void this.forget(off)
    for (const w of workflows) {
      const config = configOf(w)
      if (config && !this.watches.has(w.id)) this.open(w.id, config)
    }
  }

  /** One check now, unless one is already running for the workflow (then that one). Nothing for a workflow not watched. */
  checkNow(workflowId: string): Promise<void> {
    const watch = this.watches.get(workflowId)
    if (!watch) return Promise.resolve()
    watch.running ??= this.limited(workflowId, watch).finally(() => {
      watch.running = null
    })
    return watch.running
  }

  stop(): void {
    for (const id of [...this.watches.keys()]) this.close(id)
  }

  private open(id: string, config: string): void {
    const watch: Watch = { config, timer: { clear: () => undefined }, running: null }
    this.watches.set(id, watch)
    this.arm(id, watch)
    // At once: the first check records where the mailbox is now, and after a restart catches what came meanwhile.
    void this.checkNow(id)
  }

  // Re-armed at each tick, not after the check: a slow server skips ticks instead of drifting them.
  private arm(id: string, watch: Watch): void {
    watch.timer = this.d.setTimer(() => {
      if (this.watches.get(id) !== watch) return
      this.arm(id, watch)
      void this.checkNow(id)
    }, MAIL_POLL_MS)
  }

  private close(id: string): void {
    const watch = this.watches.get(id)
    if (!watch) return
    this.watches.delete(id)
    this.failed.delete(id)
    watch.timer.clear()
  }

  // imapflow's socket timeout ends a silent server, not one that keeps sending lines; this ends either, so the
  // workflow's `running` is freed and the next tick polls again. The check left behind writes, emits and logs nothing.
  private limited(id: string, watch: Watch): Promise<void> {
    const run: Run = { client: null, over: false }
    return new Promise<void>((resolve) => {
      const deadline = this.d.setTimer(() => {
        run.over = true
        void run.client?.close().catch(() => undefined)
        const w = this.current.get(id)
        if (w && this.watches.get(id) === watch) this.fail(id, w, LATE)
        resolve()
      }, MAIL_CHECK_DEADLINE_MS)
      const done = (): void => {
        deadline.clear()
        resolve()
      }
      this.check(id, watch, run).then(done, done)
    })
  }

  private async check(id: string, watch: Watch, run: Run): Promise<void> {
    const w = this.current.get(id)
    if (w?.trigger.kind !== 'email') return
    const t = w.trigger
    const account = this.d.account(t.account)
    if (!account) return this.fail(id, w, ACCOUNT_MISSING)
    // Trimmed, and never empty: imapflow would take an empty host as localhost.
    const host = t.host.trim()
    if (!host) return this.fail(id, w, MAIL_HOST_MISSING)
    // A message past the free run slots would start a run that is only skipped, and its UID passed for good: it waits
    // in the mailbox for a check with room instead, and with no room there is nothing to fetch.
    const max = Math.min(MAIL_PER_CHECK, this.d.freeRuns(id))
    if (max <= 0) return
    let client: MailClient | null = null
    try {
      client = await this.d.connect({ host, port: t.port, user: account.username, password: account.password, folder: t.folder })
      run.client = client
      if (run.over) return
      const box = await client.open()
      const key = keyOf(host, t, account.username)
      const prev = (await this.load())[id]
      let lastUid: number
      let found: { uid: number; source: Buffer }[] = []
      if (!prev || prev.key !== key || prev.uidValidity !== box.uidValidity) {
        // A new trigger, mailbox or UIDVALIDITY: the old UIDs mean nothing here, so start from now and fire nothing.
        lastUid = box.uidNext - 1
      } else if (box.uidNext - 1 <= prev.lastUid) {
        lastUid = prev.lastUid
      } else {
        found = (await client.fetchSince(prev.lastUid, max))
          .filter((m) => m.uid > prev.lastUid)
          .sort((a, b) => a.uid - b.uid)
          .slice(0, max)
        const top = found.at(-1)?.uid ?? prev.lastUid
        // Fewer than asked: nothing else is past the last one, so UIDs of mail deleted meanwhile are skipped too.
        lastUid = found.length < max ? Math.max(top, box.uidNext - 1) : top
      }
      const events: Extract<WorkflowEvent, { kind: 'email' }>[] = []
      for (const m of found) {
        try {
          events.push({ kind: 'email', body: await this.d.parse(m.source) })
        } catch (err) {
          this.d.log(`email check for ${w.name} skipped a message it could not read: ${mailError(err, account.password)}`)
        }
      }
      // Turned off or changed while this check ran (the next config's own check starts over), or past its deadline.
      if (run.over || this.watches.get(id) !== watch) return
      if (!prev || prev.key !== key || prev.uidValidity !== box.uidValidity || prev.lastUid !== lastUid) {
        await this.persist(id, { key, uidValidity: box.uidValidity, lastUid })
      }
      this.failed.delete(id)
      // After the state is written: a crash in between loses these messages rather than running them twice.
      for (const e of events) this.d.emit(e, id)
    } catch (err) {
      // Past the deadline the failure is the closed connection, already reported as late.
      if (!run.over) this.fail(id, w, mailError(err, account.password))
    } finally {
      await client?.close().catch(() => undefined)
    }
  }

  private fail(id: string, w: Workflow, message: string): void {
    if (this.failed.get(id) === message) return
    this.failed.set(id, message)
    this.d.log(`email check failed for ${w.name}: ${message}`)
  }

  /** `keep`: the workflows on at the first sync; null keeps every entry. */
  private read(keep: Set<string> | null): Promise<MailState> {
    return this.d.state.read().then(
      (state) => {
        if (keep) for (const k of Object.keys(state)) if (!keep.has(k)) delete state[k]
        return state
      },
      (err: unknown) => {
        this.d.log(
          `reading workflow-mail.json failed, every email trigger starts over: ${err instanceof Error ? err.message : String(err)}`
        )
        return {}
      }
    )
  }

  private load(): Promise<MailState> {
    this.state ??= this.read(null)
    return this.state
  }

  /** The whole state, kept only for the workflows watched now, written after any write before it. */
  private write(state: MailState): Promise<void> {
    for (const k of Object.keys(state)) if (!this.watches.has(k)) delete state[k]
    const snapshot = structuredClone(state)
    const write = this.writing.then(() => this.d.state.write(snapshot))
    this.writing = write.catch(() => undefined)
    return write
  }

  // Queued on the state's promise ahead of any check that re-enables the workflow, which reads its entry only after
  // connecting: so that check finds none and starts over.
  private async forget(ids: string[]): Promise<void> {
    try {
      const state = await this.load()
      if (!ids.some((id) => id in state)) return
      for (const id of ids) delete state[id]
      await this.write(state)
    } catch (err) {
      this.d.log(`writing workflow-mail.json failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Writes the whole state; on a failed write the entry goes back, so nothing is skipped. */
  private async persist(id: string, entry: MailState[string]): Promise<void> {
    const state = await this.load()
    const prev = state[id]
    state[id] = entry
    try {
      await this.write(state)
    } catch (err) {
      if (state[id] === entry) {
        if (prev) state[id] = prev
        else delete state[id]
      }
      throw err
    }
  }
}
