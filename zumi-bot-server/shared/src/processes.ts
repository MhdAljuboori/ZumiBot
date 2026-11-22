/** Background processes an agent starts for its chat (see docs/architecture/processes.md). Pure rules, limits and wire types. */

export type ProcessState = 'running' | 'exited' | 'stopped' | 'lost' | 'failed'
export type ProcessStoppedBy = 'agent' | 'user' | 'archive' | 'remove' | 'lifetime' | 'shutdown'

/** A process as clients and agents see it: never its pid, group or the machine facts the server keeps beside it. */
export interface ProcessInfo {
  id: string
  chatId: string
  name: string
  command: string
  cwd: string
  startedBy: string
  startedAt: number
  endedAt: number | null
  state: ProcessState
  exitCode: number | null
  signal: string | null
  stoppedBy: ProcessStoppedBy | null
  /** A fixed note on how the record ended when the state alone does not say it (a spawn error code, "Ended at start"). */
  note: string | null
  restarts: number
  /** When the server ends it (startedAt of its latest start plus its lifetime). */
  until: number
  /** Bytes of output ever produced: the end of the cursor range. */
  out: number
  /** The rule that wakes the agent on this process's events (Phase 3), or null. */
  wake: ProcessWake | null
}

export type WakeOn = 'exit' | 'fail' | 'match'
/** What the agent asks for at start: wake me on any natural exit, on a failed one, or on an output line holding a pattern. */
export interface NotifyRule {
  on: WakeOn
  patterns?: string[]
  times?: number
}
/** The rule as kept on the record: how many events it may raise, how many it did, and why the last one did not wake the agent. */
export interface ProcessWake {
  on: WakeOn
  patterns: string[]
  times: number
  fired: number
  note: string | null
}

/** One event a rule raised, as the wake message says it. `tail` is already cut and scrubbed. */
export interface WakeEvent {
  chatId: string
  id: string
  name: string
  startedBy: string
  kind: 'exit' | 'match'
  exitCode: number | null
  signal: string | null
  line: string | null
  tail: string
  at: number
}

/** A read of a process's output: `text` covers bytes [from, to); `dropped` bytes before `from` were asked for but are gone. */
export interface ProcessLogRead {
  text: string
  from: number
  to: number
  dropped: number
  state: ProcessState
}

export const PROCESSES_PER_CHAT = 5
export const PROCESSES_TOTAL = 20
export const PROCESS_COMMAND_MAX = 4000
export const PROCESS_NAME_MAX = 40
export const PROCESS_LIFETIME_DEFAULT_MIN = 12 * 60
export const PROCESS_LIFETIME_MAX_MIN = 12 * 60
export const PROCESS_RING_BYTES = 256 * 1024
export const PROCESS_LOG_FILE_BYTES = 2 * 1024 * 1024
export const PROCESS_LOGS_TOTAL_BYTES = 200 * 1024 * 1024
export const PROCESS_ENDED_KEPT = 20
export const PROCESS_LINE_MAX = 2000
/** What one `logs` or `wait` answer may hold. */
export const PROCESS_TOOL_TEXT_MAX = 16 * 1024
export const PROCESS_TAIL_DEFAULT = 100
export const PROCESS_TAIL_MAX = 500
export const PROCESS_WAIT_DEFAULT_S = 30
export const PROCESS_WAIT_MAX_S = 120
export const PROCESS_PATTERNS_MAX = 5
export const PROCESS_PATTERN_MAX = 200
/** What one `processes:logs` read may hold. */
export const PROCESS_READ_MAX = 256 * 1024

/** Wake-ups: events a rule may raise per process, wake messages per chat and per server per hour, events joined in one. */
export const WAKE_TIMES_MAX = 5
export const WAKE_PER_CHAT_HOUR = 6
export const WAKE_PER_SERVER_HOUR = 30
export const WAKE_EVENTS_MAX = 10
export const WAKE_TAIL_LINES = 40
export const WAKE_TAIL_BYTES = 4096
export const WAKE_NOTES = {
  chatCap: `Wake-up skipped: this chat had ${WAKE_PER_CHAT_HOUR} in the last hour`,
  serverCap: `Wake-up skipped: the server had ${WAKE_PER_SERVER_HOUR} in the last hour`,
  spendCap: 'Wake-up skipped: daily spend cap',
  closed: 'Wake-up skipped: the chat is archived'
} as const

export const PROCESS_REFUSALS = {
  perChat: `This chat already runs ${PROCESSES_PER_CHAT} processes. Stop one first.`,
  total: `The server already runs ${PROCESSES_TOTAL} processes. Stop one first.`,
  command: 'The command is empty or too long.',
  name: `Names use letters, digits, space, dot, dash and underscore, up to ${PROCESS_NAME_MAX}.`,
  cwd: "The folder must exist inside this chat's folder.",
  closed: 'This chat is archived or deleted: it cannot start processes.',
  down: 'The server is shutting down.',
  notFound: 'No such process in this chat.',
  plan: 'Start processes after the plan is approved.',
  engine: "This agent's engine cannot start processes.",
  notRunning: 'That process is not running.'
} as const

export const sameNameRunning = (name: string, id: string): string =>
  `A process named ${name} is already running (${id}). Stop it or pick another name.`

/** Every tool name of the zumibot_processes server. */
export const PROCESS_TOOLS = ['start', 'list', 'logs', 'wait', 'stop'].map((t) => `mcp__zumibot_processes__${t}`)

/** An agent's `tools:` list needs the process tools by name (with --agent a list limits the agent to it); no list means every tool. */
export function withProcessTools(tools: string[] | null): string[] | null {
  if (tools === null) return null
  return [...tools.filter((t) => !PROCESS_TOOLS.includes(t)), ...PROCESS_TOOLS]
}

export const PROCESS_START_TOOL = 'mcp__zumibot_processes__start'

/** What a start card shows: the whole command, the folder as the agent wrote it (the chat folder when absent) and the name. */
export function processStartOf(toolName: string, input: unknown): { command: string; cwd: string | null; name: string | null } | null {
  if (toolName !== PROCESS_START_TOOL || !input || typeof input !== 'object') return null
  const i = input as { command?: unknown; cwd?: unknown; name?: unknown }
  if (typeof i.command !== 'string') return null
  return {
    command: i.command,
    cwd: typeof i.cwd === 'string' && i.cwd !== '' && i.cwd !== '.' ? i.cwd : null,
    name: typeof i.name === 'string' ? i.name : null
  }
}

const ID_RE = /^p_[0-9a-f]{10}$/
export const isProcessId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/
export const isProcessName = (v: string): boolean => NAME_RE.test(v) && v.trim() === v

/** The command's error sentence, or null. A NUL could never reach bash's argv anyway; it is refused by name. */
export function commandError(command: string): string | null {
  return command.trim() === '' || command.length > PROCESS_COMMAND_MAX || command.includes('\0') ? PROCESS_REFUSALS.command : null
}

/**
 * A name for a process the agent did not name: the command's first word that is not an env assignment or a path's folder,
 * cut to the name's rules, with -2, -3… when the chat already runs one by that name.
 */
export function deriveName(command: string, taken: ReadonlySet<string>): string {
  const words = command
    .trim()
    .split(/\s+/)
    .filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const first = (words[0] ?? '').split('/').pop() ?? ''
  const second = words[1] && !words[1].startsWith('-') ? words[1] : ''
  // "npm run dev" reads better as "npm dev" than as "npm"; one level is enough.
  const pick =
    ['npm', 'pnpm', 'yarn', 'bun', 'make', 'cargo', 'go', 'npx'].includes(first) && second
      ? `${first} ${second === 'run' && words[2] ? words[2] : second}`
      : first
  let base = pick
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, PROCESS_NAME_MAX - 3)
    .trim()
  if (!base) base = 'process'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

// CSI (colors, cursor moves), OSC (titles, links; BEL or ST ends it) and the two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g
/** Output as a reader sees it: no escapes, `\r\n` as `\n`, a bare `\r` (a progress bar redrawing) as a line end. */
export function cleanOutput(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Each line cut at `max` characters with an ellipsis. */
export function cutLines(text: string, max = PROCESS_LINE_MAX): string {
  return text
    .split('\n')
    .map((l) => (l.length > max ? `${l.slice(0, max)}…` : l))
    .join('\n')
}

/** The last `n` lines (a trailing newline is not a line). */
export function tailLines(text: string, n: number): string {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n).join('\n')
}

/** Literal, case-sensitive: no regex, so no pattern can stall the server. */
export const lineMatches = (line: string, patterns: readonly string[]): boolean => patterns.some((p) => p !== '' && line.includes(p))

/** How long ago or how long, for agents and rows: "45s", "12m", "3h 5m". */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** One plain line for a state: what the agent's `list` and the panel say. */
export function stateText(p: Pick<ProcessInfo, 'state' | 'exitCode' | 'signal' | 'stoppedBy' | 'note'>): string {
  switch (p.state) {
    case 'running':
      return 'running'
    case 'exited':
      return p.exitCode !== null ? `exited with code ${p.exitCode}` : `ended by ${p.signal ?? 'a signal'}`
    case 'stopped':
      return p.stoppedBy === 'user'
        ? 'stopped by the user'
        : p.stoppedBy === 'agent'
          ? 'stopped by an agent'
          : p.stoppedBy === 'archive'
            ? 'stopped when the chat was archived'
            : p.stoppedBy === 'lifetime'
              ? 'stopped at its time limit'
              : p.stoppedBy === 'shutdown'
                ? 'stopped when the server stopped'
                : 'stopped'
    case 'lost':
      return p.note ? `lost at a server restart (${p.note})` : 'lost at a server restart'
    case 'failed':
      return p.note ? `failed to start (${p.note})` : 'failed to start'
  }
}

/** Whether a natural end raises the rule's event: `exit` on any, `fail` on a non-zero code or a signal; `match` never. */
export function exitFires(on: WakeOn, exitCode: number | null, signal: string | null): boolean {
  if (on === 'exit') return true
  return on === 'fail' && (exitCode !== 0 || signal !== null)
}

/** The rule as stored, or a sentence for the agent. `match` needs patterns, which only it takes. */
export function parseNotify(n: NotifyRule): { rule: ProcessWake } | { error: string } {
  if (n.on !== 'exit' && n.on !== 'fail' && n.on !== 'match') return { error: 'notify.on must be exit, fail or match.' }
  const patterns = n.patterns ?? []
  if (n.on === 'match' && patterns.length === 0) return { error: 'notify with on: match needs patterns.' }
  if (n.on !== 'match' && patterns.length > 0) return { error: 'notify.patterns go only with on: match.' }
  const times = n.times ?? 1
  if (!Number.isInteger(times) || times < 1 || times > WAKE_TIMES_MAX)
    return { error: `notify.times must be a whole number from 1 to ${WAKE_TIMES_MAX}.` }
  return { rule: { on: n.on, patterns: [...patterns], times, fired: 0, note: null } }
}

/** One event in the wake message's words. */
export function wakeLine(e: Pick<WakeEvent, 'name' | 'id' | 'kind' | 'exitCode' | 'signal' | 'line'>): string {
  const who = `"${e.name}" (${e.id})`
  if (e.kind === 'match') return `${who} printed a line you asked to hear about: ${e.line ?? ''}`
  return e.exitCode !== null ? `${who} exited with code ${e.exitCode}.` : `${who} was ended by ${e.signal ?? 'a signal'}.`
}

const FENCE = '`'.repeat(3)

/**
 * The message a wake-up posts: who sends it, each event (the newest WAKE_EVENTS_MAX), the newest log tail of each process, and
 * what is expected. In a room it leads with the starters' @mentions, so the moderator hands it to them.
 */
export function wakeMessage(events: readonly WakeEvent[], mentions: readonly string[] = []): string {
  const shown = events.slice(-WAKE_EVENTS_MAX)
  const lines = [
    ...(mentions.length ? [mentions.map((m) => `@${m}`).join(' ')] : []),
    "Background process update (sent by ZumiBot for a process's notify rule, not typed by the user):",
    ...(events.length > shown.length ? [`(${events.length - shown.length} earlier events left out)`] : []),
    ...shown.map((e) => `- ${wakeLine(e)}`)
  ]
  // The newest tail of each process once, in the order its last event came.
  const lastOf = new Map<string, WakeEvent>()
  for (const e of shown) {
    lastOf.delete(e.id)
    lastOf.set(e.id, e)
  }
  for (const e of lastOf.values()) {
    if (!e.tail) continue
    // A fence inside the output would end the block early.
    lines.push('', `Last lines of "${e.name}":`, FENCE, e.tail.split(FENCE).join("'''"), FENCE)
  }
  lines.push('', 'Act on it if it needs you (read more with logs, restart or stop with the process tools); the user may not be watching.')
  return lines.join('\n')
}
