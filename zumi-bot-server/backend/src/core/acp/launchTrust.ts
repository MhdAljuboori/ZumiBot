import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { launchRecord, parseAcpLaunch, type AcpLaunch } from '@zumibot/shared/acp'
import { aguiLaunchRecord, parseAguiLaunch, type AguiLaunch } from '@zumibot/shared/agui'
import { assertNever } from '@zumibot/shared/engine'
import { writeFileAtomic } from '../fsutil'

// Launch trust (docs/architecture/protocol-engines.md): the agent file is plain text that Zumi Bot, any agent with Write and a
// sync can change, so a run only starts the launch the user last saved in Agent Studio on this machine: an ACP agent's command,
// or a remote agent's endpoint and key. Per machine on purpose (the same `command: gemini` may be another binary elsewhere), so
// the file is never synced; the rename pipeline moves entries.

/** What Agent Studio's Save confirmed: the launch itself, not a hash, so Agent Studio can show it beside the file's. */
export type LaunchRecord = ({ provider: 'acp' } & AcpLaunch) | ({ provider: 'ag-ui' } & AguiLaunch)

export type LaunchCheck = 'ok' | 'changed' | 'none'

const FILE = 'protocol-launch.json'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)

// A stored entry is only ever read whole: anything that is not exactly a launch of its own provider is no confirmation.
function recordOf(v: unknown): LaunchRecord | null {
  const o = obj(v)
  switch (o?.provider) {
    case 'acp': {
      const l = parseAcpLaunch(o)
      return l ? { provider: 'acp', ...l } : null
    }
    case 'ag-ui': {
      const l = parseAguiLaunch(o)
      return l ? { provider: 'ag-ui', ...l } : null
    }
    default:
      return null
  }
}

// One provider's record never matches another's, whatever its fields hold.
function same(a: LaunchRecord, b: LaunchRecord): boolean {
  switch (a.provider) {
    case 'acp':
      return b.provider === 'acp' && launchRecord(a) === launchRecord(b)
    case 'ag-ui':
      return b.provider === 'ag-ui' && aguiLaunchRecord(a) === aguiLaunchRecord(b)
    default:
      return assertNever(a)
  }
}

// The stored copy: only the record's own fields, in a fixed order, so the file is stable JSON and a caller's later change never reaches it.
function copyOf(r: LaunchRecord): LaunchRecord {
  switch (r.provider) {
    case 'acp':
      return { provider: 'acp', command: r.command, args: [...r.args], authEnv: [...r.authEnv] }
    case 'ag-ui':
      return { provider: 'ag-ui', endpoint: r.endpoint, authKey: r.authKey, authHeader: r.authHeader }
    default:
      return assertNever(r)
  }
}

export class LaunchTrust {
  private readonly file: string
  // Raw entries by agent name: a Map, so a name such as `__proto__` is only a name.
  private entries = new Map<string, unknown>()
  private queue: Promise<unknown> = Promise.resolve()
  // The file could not be read: nothing is trusted, and no write may replace it until a read succeeds.
  private unread = false

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, FILE)
  }

  async load(): Promise<void> {
    const stored = await this.read()
    this.unread = stored === null
    this.entries = stored ?? new Map()
  }

  /**
   * The stored entries: none for a missing file, none for one that is not JSON (moved aside), null if it can't be read. `quiet`:
   * a write's retry, which says nothing itself (one that needed the file fails, and its caller logs that).
   */
  private async read(quiet = false): Promise<Map<string, unknown> | null> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return new Map()
      // The code only: the file holds commands and arguments, which never reach a log.
      if (!quiet) console.error(`launch trust: ${FILE} could not be read (${code ?? 'error'}), so no ACP or remote agent runs until it can`)
      return null
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      try {
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        return null // still in place: it must not be overwritten either
      }
      // Losing the entries fails closed: each ACP or remote agent is confirmed again by its next Save.
      console.error(`launch trust: ${FILE} is not valid JSON, moved aside`)
      return new Map()
    }
    return new Map(Object.entries(obj(obj(raw)?.agents) ?? {}))
  }

  // Each write sees the one before it, so calls take effect in the order made; memory changes only once its file is written, so
  // a check never trusts what a failed write could not keep. `change` says whether it changed anything (else no write). While
  // the file cannot be read, a change with nothing to do (the remove of a Save that is neither ACP nor remote) is no failure.
  private write(change: (next: Map<string, unknown>) => boolean): Promise<void> {
    const op = async () => {
      if (this.unread) {
        const stored = await this.read(true)
        if (stored) {
          this.entries = stored
          this.unread = false
        }
      }
      const next = new Map(this.entries)
      if (!change(next)) return
      if (this.unread) throw new Error(`${FILE} could not be read, so the launch was not saved`)
      await fs.mkdir(this.dataDir, { recursive: true })
      await writeFileAtomic(this.file, JSON.stringify({ agents: Object.fromEntries(next) }, null, 2) + '\n', 0o600)
      this.entries = next
    }
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Whether `record` is the launch confirmed for `agent` on this machine. */
  check(agent: string, record: LaunchRecord): LaunchCheck {
    if (!this.entries.has(agent)) return 'none'
    const stored = recordOf(this.entries.get(agent))
    return stored !== null && same(stored, record) ? 'ok' : 'changed'
  }

  /** The confirmed launch, for Agent Studio to show beside the file's; null when there is none (or it is unreadable). */
  confirmed(agent: string): LaunchRecord | null {
    return this.entries.has(agent) ? recordOf(this.entries.get(agent)) : null
  }

  /** The agent names that hold an entry. */
  agents(): string[] {
    return [...this.entries.keys()]
  }

  /** Agent Studio's Save: the launch the user saw and saved. */
  confirm(agent: string, record: LaunchRecord): Promise<void> {
    const kept = copyOf(record)
    return this.write((next) => {
      next.set(agent, kept)
      return true
    })
  }

  /**
   * The rename pipeline: the entry follows the agent, replacing whatever the new name held. With no entry under the old name it
   * changes nothing: Agent Studio's Save may have confirmed the new name already, and the agents-folder watcher's rename of the
   * same file comes after it.
   */
  rename(from: string, to: string): Promise<void> {
    if (from === to) return Promise.resolve()
    return this.write((next) => {
      if (!next.has(from)) return false
      const moving = next.get(from)
      next.delete(from)
      next.set(to, moving)
      return true
    })
  }

  /** The removal pipeline: agents whose file is gone. */
  remove(names: readonly string[]): Promise<void> {
    if (names.length === 0) return Promise.resolve()
    return this.write((next) => {
      let changed = false
      for (const n of names) changed = next.delete(n) || changed
      return changed
    })
  }
}

/** The record an agent file's launch is checked and confirmed as. */
export const acpRecord = (launch: AcpLaunch): LaunchRecord => ({ provider: 'acp', ...launch })
/** The same for a remote agent's endpoint, auth key name and auth header. */
export const aguiRecord = (launch: AguiLaunch): LaunchRecord => ({ provider: 'ag-ui', ...launch })
