import type { RunEvent } from '../chat/streamParser'
import { CODEX_TOOL_OUTPUT_MAX } from '../codex/codexEvents'
import { classifyTool, diffsOf, type AcpDiff, type AcpToolCall } from './acpTools'

// Turns ACP `session/update` updates into the RunEvents the rest of ZumiBot already reads.
// Pure: it keeps only what the next update needs (open tool calls, the open text or thought run, the context size).
// A tool call's row waits until the call can be named: real agents (claude-agent-acp) announce a call with an empty
// `rawInput` and send what it does only in later updates, and a row's name is fixed once shown.

const CUT = '\n[output cut]'
const ROW_INPUT_MAX = 20_000

type Obj = Record<string, any>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const cap = (s: string): string => (s.length > CODEX_TOOL_OUTPUT_MAX ? s.slice(0, CODEX_TOOL_OUTPUT_MAX) + CUT : s)

// A text block's text; images, audio and resources give nothing.
const textOf = (block: unknown): string | null => {
  const b = obj(block)
  return b?.type === 'text' ? str(b.text) : null
}

interface Tracked {
  kind: unknown
  title: unknown
  rawInput: unknown
  content: unknown
  locations: unknown
  // The row's name, fixed when it is shown: the result never disagrees with its row. Null while the row waits.
  name: string | null
  done: boolean
}

const FIELDS = ['kind', 'title', 'rawInput', 'content', 'locations'] as const

// What the call does has arrived (some input, a path, or a diff; an empty `{}` is how a call is first announced) and names a
// classified tool. claude-agent-acp sends `rawInput` one top-level field at a time, so an unclassified call (`AcpCall`: an MCP
// tool, Task, an execute whose first field is not the command) is never opened on input: its row waits for a status, a card
// or the turn's end, and then shows the input as it stands.
function nameable(t: Tracked): boolean {
  const raw = obj(t.rawInput)
  const input =
    raw !== null
      ? Object.keys(raw).length > 0
      : Array.isArray(t.rawInput)
        ? t.rawInput.length > 0
        : t.rawInput !== undefined && t.rawInput !== null && t.rawInput !== ''
  if (!input && !(Array.isArray(t.locations) && t.locations.length > 0) && diffsOf(t.content).length === 0) return false
  return classifyTool(t, '').toolName !== 'AcpCall'
}

// The result row's text: text content as sent, a diff as its path. Terminals are never created (none advertised).
function resultText(content: unknown): string {
  const parts: string[] = []
  for (const c of Array.isArray(content) ? content : []) {
    const o = obj(c)
    if (o?.type === 'content') {
      const t = textOf(o.content)
      if (t !== null && t !== '') parts.push(t)
    } else if (o?.type === 'diff' && typeof o.path === 'string') parts.push(o.path)
  }
  return cap(parts.join('\n'))
}

const checklist = (entries: unknown[]): string =>
  entries
    .map((e) => {
      const o = obj(e)!
      const status = o.status === 'completed' ? '[x]' : '[ ]'
      return `- ${status} ${o.content}${o.status === 'in_progress' ? ' (in progress)' : ''}`
    })
    .join('\n')

/**
 * What a `current_mode_update` or `config_option_update` reports: the current mode id, and each `mode`-category option's
 * value by its option id. Nothing for any other update.
 */
export function modeReport(u: unknown): { mode: string | null; options: Array<[string, string]> } {
  const up = obj(u)
  const options: Array<[string, string]> = []
  if (up?.sessionUpdate === 'current_mode_update') return { mode: str(up.currentModeId), options }
  if (up?.sessionUpdate === 'config_option_update') {
    for (const o of Array.isArray(up.configOptions) ? up.configOptions : []) {
      const opt = obj(o)
      if (opt?.category === 'mode' && typeof opt.currentValue === 'string') options.push([str(opt.id) ?? '', opt.currentValue])
    }
  }
  return { mode: null, options }
}

/** Every mode id a report names. */
export const reportedModes = (r: ReturnType<typeof modeReport>): string[] => [
  ...(r.mode === null ? [] : [r.mode]),
  ...r.options.map(([, v]) => v)
]

export class AcpEventMapper {
  private text = ''
  private thought = ''
  private tools = new Map<string, Tracked>()
  private plans = 0
  private window: number | null = null

  // onMode: a mode id the agent reports. The runner decides (the refused-mode check), the mapper only reports.
  constructor(private readonly opts: { onMode?: (id: string) => void } = {}) {}

  /**
   * A tool call as the stream has told it so far (merged), or undefined for an id not seen. The runner merges a
   * permission request's `toolCall` over this before it classifies.
   */
  toolCall(id: string): { kind: unknown; title: unknown; rawInput: unknown; content: unknown; locations: unknown } | undefined {
    const t = this.tools.get(id)
    return t && { kind: t.kind, title: t.title, rawInput: t.rawInput, content: t.content, locations: t.locations }
  }

  /** The context window from the latest `usage_update` size, for the result's `windows`. */
  get contextWindow(): number | null {
    return this.window
  }

  /** `u` is the `update` object of a `session/update`. Unknown kinds and odd fields give nothing. */
  update(u: unknown): RunEvent[] {
    const up = obj(u)
    if (!up) return []
    switch (up.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = textOf(up.content)
        if (t === null || t === '') return []
        const out = this.endThought()
        this.text += t
        out.push({ kind: 'textDelta', text: t })
        return out
      }
      case 'agent_thought_chunk': {
        const t = textOf(up.content)
        if (t === null || t === '') return []
        const out = this.endText()
        this.thought += t
        out.push({ kind: 'thinkingDelta', text: t })
        return out
      }
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(up)
      case 'plan':
        return this.plan(up)
      case 'usage_update': {
        const out: RunEvent[] = []
        if (typeof up.size === 'number' && Number.isFinite(up.size) && up.size > 0) this.window = up.size
        // No cost, no spend: cost stays out of 1b.
        if (typeof up.used === 'number' && Number.isFinite(up.used) && up.used >= 0)
          out.push({ kind: 'context', model: null, tokens: up.used })
        return out
      }
      case 'current_mode_update':
      case 'config_option_update':
        for (const id of reportedModes(modeReport(up))) this.mode(id)
        return []
      default:
        return [] // user_message_chunk, available_commands_update, session_info_update, anything newer
    }
  }

  /** The turn ended: close the open text or thought run, then show every row still waiting, so the runner can close it. */
  turnEnd(): RunEvent[] {
    const out = this.endRuns()
    for (const [id, t] of this.tools) if (t.name === null) out.push(...this.open(id, t))
    return out
  }

  /**
   * Shows a call's row now if it still waits: a permission request names it, and its card must land after the row. The
   * request's own fields win in naming it, as they do for the card; for a call the stream never announced they are the call.
   */
  show(id: string, request: AcpToolCall): RunEvent[] {
    const out: RunEvent[] = []
    let t = this.tools.get(id)
    if (!t) {
      out.push(...this.endRuns())
      t = {
        kind: request.kind,
        title: request.title,
        rawInput: request.rawInput,
        content: request.content,
        locations: request.locations,
        name: null,
        done: false
      }
      this.tools.set(id, t)
    }
    if (t.name === null) out.push(...this.open(id, t, request))
    return out
  }

  private mode(id: string): void {
    try {
      this.opts.onMode?.(id)
    } catch {
      /* a runner callback must not break the stream */
    }
  }

  private endRuns(): RunEvent[] {
    return [...this.endThought(), ...this.endText()]
  }

  private endText(): RunEvent[] {
    const t = this.text
    this.text = ''
    return t.trim() === '' ? [] : [{ kind: 'assistantText', text: t }]
  }

  private endThought(): RunEvent[] {
    const t = this.thought
    this.thought = ''
    return t.trim() === '' ? [] : [{ kind: 'thinking', text: t }]
  }

  private plan(up: Obj): RunEvent[] {
    const entries = (Array.isArray(up.entries) ? up.entries : []).filter((e) => typeof obj(e)?.content === 'string')
    if (entries.length === 0) return []
    const id = `acp-plan-${++this.plans}`
    return [
      ...this.endRuns(),
      { kind: 'toolUse', id, name: 'Plan', input: { entries } },
      { kind: 'toolResult', toolUseId: id, content: checklist(entries), isError: false }
    ]
  }

  // tool_call and tool_call_update share a path: a repeated tool_call is an update, an update for an unseen id starts the call.
  // The row shows on the first update that names the call (input, a path, a diff) or that says it runs or ended.
  private tool(up: Obj): RunEvent[] {
    const id = str(up.toolCallId)
    if (id === null || id === '') return []
    const out: RunEvent[] = []
    let t = this.tools.get(id)
    if (!t) {
      // The call breaks the text run where it arrives, whenever its row shows.
      out.push(...this.endRuns())
      t = { kind: up.kind, title: up.title, rawInput: up.rawInput, content: up.content, locations: up.locations, name: null, done: false }
      this.tools.set(id, t)
    } else {
      // Content and locations replace; the rest only change when sent.
      for (const k of FIELDS) if (up[k] !== undefined) t[k] = up[k]
    }
    const ended = up.status === 'completed' || up.status === 'failed'
    if (t.name === null && (ended || up.status === 'in_progress' || nameable(t))) out.push(...this.open(id, t))
    if (!t.done && ended) {
      t.done = true
      out.push(this.result(id, t, up.status === 'failed'))
    }
    return out
  }

  // Shows the row, its name and input fixed from here on; `request` (a permission's fields) wins over the stream's.
  private open(id: string, t: Tracked, request: AcpToolCall = {}): RunEvent[] {
    const merged: AcpToolCall = { kind: t.kind, title: t.title, rawInput: t.rawInput, content: t.content, locations: t.locations }
    for (const k of FIELDS) if (request[k] !== undefined) merged[k] = request[k]
    const row = this.row(merged)
    t.name = row.name
    return [...this.endRuns(), { kind: 'toolUse', id, name: row.name, input: row.input }]
  }

  // The stored row. Edits keep paths only (diffs would bloat every stored chat), and a big rawInput is cut.
  private row(t: AcpToolCall): { name: string; input: unknown } {
    const c = classifyTool(t, '')
    if (c.toolName === 'AcpEdit') return { name: c.toolName, input: { paths: (c.input as { paths: string[] }).paths } }
    if (c.toolName === 'AcpCall') {
      const raw = (c.input as { rawInput: unknown }).rawInput
      const json = JSON.stringify(raw) ?? ''
      if (json.length > ROW_INPUT_MAX)
        return { name: c.toolName, input: { title: (c.input as { title: string }).title, rawInput: json.slice(0, ROW_INPUT_MAX) + CUT } }
    }
    return { name: c.toolName, input: c.input }
  }

  private result(id: string, t: Tracked, failed: boolean): RunEvent {
    const ev: RunEvent = { kind: 'toolResult', toolUseId: id, content: resultText(t.content), isError: failed }
    if (!failed && t.name === 'AcpEdit') {
      const acpDiffs: AcpDiff[] = diffsOf(t.content)
      if (acpDiffs.length) ev.detail = { acpDiffs }
    }
    return ev
  }
}
