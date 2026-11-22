import { AGUI_TEXT, AGUI_TOOL } from '@zumibot/shared/agui'
import type { RunEvent } from '../chat/streamParser'
import { CODEX_TOOL_OUTPUT_MAX } from '../codex/codexEvents'
import type { AguiInterrupt } from './aguiInterrupts'
import type { AguiMessage } from './aguiMessages'

// Turns one AG-UI run's events (each SSE data payload) into the RunEvents the rest of ZumiBot reads. Pure: it keeps only
// what the next event needs (open messages and calls, the open chunk runs) and this run's transcript for a resume.
// The stream is a remote server's, so a known event with a field missing or of the wrong type ends the run (the spec requires
// it), while unknown events are ignored. See docs/architecture/protocol-engines.md, Message map (AG-UI 1.0 -> ZumiBot).

// A remote tool's row: it ran on the agent's server, never here. Shared, since the row's label reads it.
export { AGUI_TOOL }

const CUT = '\n[output cut]'
const ROW_INPUT_MAX = 20_000
const cap = (s: string): string => (s.length > CODEX_TOOL_OUTPUT_MAX ? s.slice(0, CODEX_TOOL_OUTPUT_MAX) + CUT : s)

/** One TokenUsage entry; an absent count is unknown, not 0. */
export interface AguiUsage {
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
}

export type AguiTerminal =
  | { kind: 'success'; pendingToolCallIds: string[]; usage: AguiUsage[] }
  | { kind: 'interrupt'; interrupts: AguiInterrupt[]; usage: AguiUsage[] }
  | { kind: 'cancelled'; usage: AguiUsage[] }
  /** `message` is the server's, raw: the runner cuts and scrubs it. */
  | { kind: 'error'; message: string; code: string | null; usage: AguiUsage[] }

/** A snapshot replaces the kept state; a delta goes through `applyPatch`. The runner keeps the state. */
export type AguiStateChange = { kind: 'snapshot'; snapshot: unknown } | { kind: 'delta'; delta: unknown[] }

/** What one event gave. `fatal` (a fixed sentence) ends the run: the mapper reads nothing more. */
export interface AguiMapped {
  events: RunEvent[]
  state?: AguiStateChange
  terminal?: AguiTerminal
  fatal?: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const none = (): AguiMapped => ({ events: [] })
// null stands for an absent optional field, as servers that serialise None send it.
const absent = (v: unknown): boolean => v === undefined || v === null

type Kind = 'string' | 'array' | 'any' | 'content'
interface Shape {
  req?: Record<string, Kind>
  opt?: Record<string, Kind>
}
const needs = (k: string): Shape => ({ req: { [k]: 'string' } })
// The fields each known event must carry, and the type of every optional one. Outcome and usage are read on their own.
const SHAPES = new Map<string, Shape>([
  ['RUN_STARTED', { req: { threadId: 'string', runId: 'string' }, opt: { protocolVersion: 'string', parentRunId: 'string' } }],
  ['RUN_FINISHED', { req: { threadId: 'string', runId: 'string' } }],
  ['RUN_ERROR', { req: { message: 'string' }, opt: { code: 'string' } }],
  ['TEXT_MESSAGE_START', { req: { messageId: 'string' }, opt: { role: 'string', name: 'string' } }],
  ['TEXT_MESSAGE_CONTENT', { req: { messageId: 'string', delta: 'string' } }],
  ['TEXT_MESSAGE_END', needs('messageId')],
  ['TEXT_MESSAGE_CHUNK', { opt: { messageId: 'string', role: 'string', delta: 'string', name: 'string' } }],
  ['REASONING_START', needs('messageId')],
  ['REASONING_END', needs('messageId')],
  ['REASONING_MESSAGE_START', { req: { messageId: 'string', role: 'string' } }],
  ['REASONING_MESSAGE_CONTENT', { req: { messageId: 'string', delta: 'string' } }],
  ['REASONING_MESSAGE_END', needs('messageId')],
  ['REASONING_MESSAGE_CHUNK', { opt: { messageId: 'string', delta: 'string' } }],
  ['THINKING_START', { opt: { title: 'string' } }],
  ['THINKING_END', {}],
  ['THINKING_TEXT_MESSAGE_START', {}],
  ['THINKING_TEXT_MESSAGE_CONTENT', needs('delta')],
  ['THINKING_TEXT_MESSAGE_END', {}],
  ['TOOL_CALL_START', { req: { toolCallId: 'string', toolCallName: 'string' }, opt: { parentMessageId: 'string' } }],
  ['TOOL_CALL_ARGS', { req: { toolCallId: 'string', delta: 'string' } }],
  ['TOOL_CALL_END', needs('toolCallId')],
  ['TOOL_CALL_CHUNK', { opt: { toolCallId: 'string', toolCallName: 'string', parentMessageId: 'string', delta: 'string' } }],
  ['TOOL_CALL_RESULT', { req: { messageId: 'string', toolCallId: 'string', content: 'content' }, opt: { role: 'string' } }],
  ['STATE_SNAPSHOT', { req: { snapshot: 'any' } }],
  ['STATE_DELTA', { req: { delta: 'array' } }]
])

// A result's content: text, or a list of parts each naming its type (a text part with its text).
const isContent = (v: unknown): boolean =>
  typeof v === 'string' ||
  (Array.isArray(v) && v.every((p) => isObj(p) && typeof p.type === 'string' && (p.type !== 'text' || typeof p.text === 'string')))

function is(v: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'string':
      return typeof v === 'string'
    case 'array':
      return Array.isArray(v)
    case 'content':
      return isContent(v)
    case 'any':
      return true
  }
}

/** A known event reads; an unknown one always does (it is ignored). */
function fits(e: Obj): boolean {
  const s = SHAPES.get(e.type as string)
  if (!s) return true
  for (const [k, kind] of Object.entries(s.req ?? {})) if (!Object.hasOwn(e, k) || !is(e[k], kind)) return false
  for (const [k, kind] of Object.entries(s.opt ?? {})) if (!absent(e[k]) && !is(e[k], kind)) return false
  return true
}

const COUNTS = ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheWriteInputTokens'] as const

// The usage list with only readable counts kept (a negative count reads as unknown), or null when it is malformed.
function usageOf(v: unknown): AguiUsage[] | null {
  if (absent(v)) return []
  if (!Array.isArray(v)) return null
  const out: AguiUsage[] = []
  for (const u of v) {
    if (!isObj(u)) return null
    const r: AguiUsage = {}
    for (const k of ['provider', 'model'] as const) {
      if (absent(u[k])) continue
      if (typeof u[k] !== 'string') return null
      r[k] = u[k] as string
    }
    for (const k of COUNTS) {
      const n = u[k]
      if (absent(n)) continue
      if (typeof n !== 'number') return null
      if (Number.isFinite(n) && n >= 0) r[k] = n
    }
    out.push(r)
  }
  return out
}

function interruptOf(v: unknown): AguiInterrupt | null {
  if (!isObj(v) || typeof v.id !== 'string' || v.id === '' || typeof v.reason !== 'string') return null
  const i: AguiInterrupt = { id: v.id, reason: v.reason }
  for (const k of ['message', 'toolCallId', 'expiresAt', 'subagentRunId'] as const) {
    if (absent(v[k])) continue
    if (typeof v[k] !== 'string') return null
    i[k] = v[k] as string
  }
  if (!absent(v.responseSchema)) {
    if (!isObj(v.responseSchema)) return null
    i.responseSchema = v.responseSchema
  }
  if (!absent(v.metadata)) i.metadata = v.metadata
  return i
}

type Outcome =
  { kind: 'success'; pendingToolCallIds: string[] } | { kind: 'interrupt'; interrupts: AguiInterrupt[] } | { kind: 'cancelled' }

// An absent or unrecognised outcome is success (the spec strips it); a recognised one that is malformed is null.
function outcomeOf(v: unknown): Outcome | null {
  if (!isObj(v)) return { kind: 'success', pendingToolCallIds: [] }
  switch (v.type) {
    case 'success': {
      const p = v.pendingToolCallIds
      if (absent(p)) return { kind: 'success', pendingToolCallIds: [] }
      return Array.isArray(p) && p.every((x) => typeof x === 'string') ? { kind: 'success', pendingToolCallIds: [...p] } : null
    }
    case 'interrupt': {
      if (!Array.isArray(v.interrupts) || v.interrupts.length === 0) return null
      const interrupts: AguiInterrupt[] = []
      for (const raw of v.interrupts) {
        const i = interruptOf(raw)
        if (i === null || interrupts.some((x) => x.id === i.id)) return null
        interrupts.push(i)
      }
      return { kind: 'interrupt', interrupts }
    }
    case 'cancelled':
      return { kind: 'cancelled' }
    default:
      return { kind: 'success', pendingToolCallIds: [] }
  }
}

// The row's input: the arguments parsed when they are JSON, else kept as text; over the row cap, cut text as ACP rows are.
function rowInput(tool: string, args: string): { tool: string; args: unknown; argsText?: string } {
  if (args.length > ROW_INPUT_MAX) return { tool, args: null, argsText: args.slice(0, ROW_INPUT_MAX) + CUT }
  try {
    return { tool, args: JSON.parse(args) }
  } catch {
    return { tool, args: null, argsText: args }
  }
}

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : (content as Obj[]).map((p) => (p.type === 'text' ? (p.text as string) : `[${p.type as string}]`)).join('\n')

// One assistant message of the transcript: its text (null when it has none) and the calls made under it.
interface Slot {
  id: string
  text: string | null
  calls: Call[]
}
interface Call {
  id: string
  name: string
  args: string
  ended: boolean
}
// slot is null for a role that is never shown (user, system, developer).
interface OpenText {
  slot: Slot | null
  text: string
}

// before: nothing of ours yet. replay: another run's events, dropped until its terminal. after: our terminal came.
type Phase = 'before' | 'ours' | 'replay' | 'after' | 'dead'

const LEGACY = 'legacy'
const thoughtKey = (messageId: string): string => `m:${messageId}`

export class AguiEventMapper {
  private phase: Phase = 'before'
  private seenOurs = false
  private readonly texts = new Map<string, OpenText>()
  private readonly thoughts = new Map<string, string>()
  private readonly calls = new Map<string, Call>()
  // The open chunk run of each kind (its message or call id): it ends at the first event that is not its own chunk.
  private textChunk: string | null = null
  private thoughtChunk: string | null = null
  private callChunk: string | null = null
  private readonly slots = new Map<string, Slot>()
  private readonly entries: ({ slot: Slot } | { tool: AguiMessage })[] = []

  constructor(private readonly run: { threadId: string; runId: string }) {}

  /** One SSE data payload. */
  event(raw: string): AguiMapped {
    if (this.phase === 'dead') return none()
    let e: unknown
    try {
      e = JSON.parse(raw)
    } catch {
      return this.fail(AGUI_TEXT.unreadable)
    }
    if (!isObj(e) || typeof e.type !== 'string') return this.fail(AGUI_TEXT.unreadable)
    switch (this.phase) {
      // A stream begins with RUN_STARTED or RUN_ERROR.
      case 'before':
        return e.type === 'RUN_STARTED' ? this.start(e) : e.type === 'RUN_ERROR' ? this.error(e) : this.fail(AGUI_TEXT.unreadable)
      case 'replay':
        if (e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR') this.phase = this.seenOurs ? 'after' : 'before'
        return none()
      case 'ours':
        return this.ours(e)
      case 'after':
        // Only a late RUN_ERROR (our run failed after all) or a later run may follow; anything else is dropped.
        if (subagent(e)) return none()
        return e.type === 'RUN_ERROR' ? this.error(e) : e.type === 'RUN_STARTED' ? this.start(e) : none()
      default:
        return none()
    }
  }

  /** The run is over without its terminal event (a cut, Stop): closes every open message and shows every call not ended. */
  close(): RunEvent[] {
    const out = this.flush()
    this.phase = 'dead'
    return out
  }

  /** This run's assistant and tool messages, by the server's ids, in the order they began: a resume run sends them back. */
  transcript(): AguiMessage[] {
    return this.entries.map((e): AguiMessage =>
      'tool' in e
        ? { ...e.tool }
        : {
            id: e.slot.id,
            role: 'assistant',
            ...(e.slot.text !== null ? { content: e.slot.text } : {}),
            ...(e.slot.calls.length > 0
              ? {
                  toolCalls: e.slot.calls.map((c) => ({
                    id: c.id,
                    type: 'function' as const,
                    function: { name: c.name, arguments: c.args }
                  }))
                }
              : {})
          }
    )
  }

  private fail(text: string, events: RunEvent[] = []): AguiMapped {
    this.phase = 'dead'
    return { events, fatal: text }
  }

  private start(e: Obj): AguiMapped {
    // Checked first: a newer major may have changed the fields too, and this sentence says why.
    if (typeof e.protocolVersion === 'string' && !/^1(\.|$)/.test(e.protocolVersion)) return this.fail(AGUI_TEXT.protocol)
    if (!fits(e) || e.threadId !== this.run.threadId) return this.fail(AGUI_TEXT.unreadable)
    if (e.runId !== this.run.runId) {
      this.phase = 'replay'
      return none()
    }
    if (this.seenOurs) return this.fail(AGUI_TEXT.unreadable)
    this.seenOurs = true
    this.phase = 'ours'
    // The entry stamps the turn's end with this run, and so with the engine that ran it.
    return {
      events: [
        { kind: 'init', sessionId: this.run.threadId },
        { kind: 'entry', uuid: this.run.runId }
      ]
    }
  }

  private error(e: Obj): AguiMapped {
    const usage = fits(e) ? usageOf(e.usage) : null
    if (usage === null) return this.fail(AGUI_TEXT.unreadable)
    const events = this.flush()
    this.phase = 'dead'
    return { events, terminal: { kind: 'error', message: e.message as string, code: typeof e.code === 'string' ? e.code : null, usage } }
  }

  private finish(e: Obj): AguiMapped {
    if (e.runId !== this.run.runId || e.threadId !== this.run.threadId) return this.fail(AGUI_TEXT.unreadable)
    const usage = usageOf(e.usage)
    const outcome = outcomeOf(e.outcome)
    if (usage === null || outcome === null) return this.fail(AGUI_TEXT.unreadable)
    const events = this.flush()
    this.phase = 'after'
    return { events, terminal: { ...outcome, usage } }
  }

  private ours(e: Obj): AguiMapped {
    // A subagent's events are its own: its words never mix into the reply (Rulings 6).
    if (subagent(e)) return none()
    if (!fits(e)) return this.fail(AGUI_TEXT.unreadable)
    switch (e.type) {
      case 'RUN_STARTED':
        return this.fail(AGUI_TEXT.unreadable) // a run never starts inside one
      case 'RUN_FINISHED':
        return this.finish(e)
      case 'RUN_ERROR':
        return this.error(e)
    }
    const events = this.endChunks(e)
    const s = (k: string): string => e[k] as string
    switch (e.type) {
      case 'TEXT_MESSAGE_START':
        this.openText(s('messageId'), typeof e.role === 'string' ? e.role : 'assistant')
        break
      case 'TEXT_MESSAGE_CONTENT':
        events.push(...this.textDelta(s('messageId'), s('delta')))
        break
      case 'TEXT_MESSAGE_END':
        events.push(...this.endText(s('messageId')))
        break
      case 'TEXT_MESSAGE_CHUNK':
        if (this.textChunk === null) {
          if (typeof e.messageId !== 'string') return this.fail(AGUI_TEXT.unreadable, events)
          this.openText(e.messageId, typeof e.role === 'string' ? e.role : 'assistant')
          this.textChunk = e.messageId
        }
        if (typeof e.delta === 'string') events.push(...this.textDelta(this.textChunk, e.delta))
        break
      case 'REASONING_MESSAGE_START':
        this.openThought(thoughtKey(s('messageId')))
        break
      case 'REASONING_MESSAGE_CONTENT':
        events.push(...this.thoughtDelta(thoughtKey(s('messageId')), s('delta')))
        break
      case 'REASONING_MESSAGE_END':
        events.push(...this.endThought(thoughtKey(s('messageId'))))
        break
      case 'REASONING_MESSAGE_CHUNK':
        if (this.thoughtChunk === null) {
          if (typeof e.messageId !== 'string') return this.fail(AGUI_TEXT.unreadable, events)
          this.thoughtChunk = e.messageId
          this.openThought(thoughtKey(e.messageId))
        }
        if (typeof e.delta === 'string') events.push(...this.thoughtDelta(thoughtKey(this.thoughtChunk), e.delta))
        break
      // The legacy 0.x thinking events, read as the reasoning ones (as @ag-ui/client translates them).
      case 'THINKING_TEXT_MESSAGE_START':
        this.openThought(LEGACY)
        break
      case 'THINKING_TEXT_MESSAGE_CONTENT':
        events.push(...this.thoughtDelta(LEGACY, s('delta')))
        break
      case 'THINKING_TEXT_MESSAGE_END':
        events.push(...this.endThought(LEGACY))
        break
      case 'TOOL_CALL_START':
        this.startCall(s('toolCallId'), s('toolCallName'), e.parentMessageId)
        break
      case 'TOOL_CALL_ARGS': {
        const c = this.calls.get(s('toolCallId'))
        if (c && !c.ended) c.args += s('delta')
        break
      }
      case 'TOOL_CALL_END': {
        const c = this.calls.get(s('toolCallId'))
        if (c && !c.ended) events.push(this.endCall(c))
        break
      }
      case 'TOOL_CALL_CHUNK':
        if (this.callChunk === null) {
          if (typeof e.toolCallId !== 'string' || typeof e.toolCallName !== 'string') return this.fail(AGUI_TEXT.unreadable, events)
          this.startCall(e.toolCallId, e.toolCallName, e.parentMessageId)
          this.callChunk = e.toolCallId
        }
        if (typeof e.delta === 'string') {
          const c = this.calls.get(this.callChunk)
          if (c && !c.ended) c.args += e.delta
        }
        break
      case 'TOOL_CALL_RESULT': {
        // A result for a call still open ends it first; one for a call an earlier run made (a resumed approval) is kept too.
        const c = this.calls.get(s('toolCallId'))
        if (c && !c.ended) events.push(this.endCall(c))
        const content = resultText(e.content)
        this.entries.push({ tool: { id: s('messageId'), role: 'tool', toolCallId: s('toolCallId'), content } })
        events.push({ kind: 'toolResult', toolUseId: s('toolCallId'), content: cap(content), isError: false })
        break
      }
      case 'STATE_SNAPSHOT':
        return { events, state: { kind: 'snapshot', snapshot: e.snapshot } }
      case 'STATE_DELTA':
        return { events, state: { kind: 'delta', delta: e.delta as unknown[] } }
      // REASONING_START/END, THINKING_START/END and REASONING_ENCRYPTED_VALUE (not round-tripped) give nothing, and so does
      // every ignored event: MESSAGES_SNAPSHOT, ACTIVITY_*, STEP_*, SUBAGENT_*, RAW, CUSTOM and anything unknown.
    }
    return { events }
  }

  // Ends each open chunk run this event does not continue.
  private endChunks(e: Obj): RunEvent[] {
    const out: RunEvent[] = []
    const goesOn = (type: string, field: string, open: string) => e.type === type && (absent(e[field]) || e[field] === open)
    if (this.textChunk !== null && !goesOn('TEXT_MESSAGE_CHUNK', 'messageId', this.textChunk)) {
      out.push(...this.endText(this.textChunk))
      this.textChunk = null
    }
    if (this.thoughtChunk !== null && !goesOn('REASONING_MESSAGE_CHUNK', 'messageId', this.thoughtChunk)) {
      out.push(...this.endThought(thoughtKey(this.thoughtChunk)))
      this.thoughtChunk = null
    }
    if (this.callChunk !== null && !goesOn('TOOL_CALL_CHUNK', 'toolCallId', this.callChunk)) {
      const c = this.calls.get(this.callChunk)
      if (c && !c.ended) out.push(this.endCall(c))
      this.callChunk = null
    }
    return out
  }

  // Ends everything still open, in the order thought, text, calls.
  private flush(): RunEvent[] {
    this.textChunk = this.thoughtChunk = this.callChunk = null
    const out: RunEvent[] = []
    for (const k of [...this.thoughts.keys()]) out.push(...this.endThought(k))
    for (const k of [...this.texts.keys()]) out.push(...this.endText(k))
    for (const c of this.calls.values()) if (!c.ended) out.push(this.endCall(c))
    return out
  }

  // The transcript's assistant message by its id, made where it first appears.
  private slot(messageId: string): Slot {
    let s = this.slots.get(messageId)
    if (!s) {
      s = { id: messageId, text: null, calls: [] }
      this.slots.set(messageId, s)
      this.entries.push({ slot: s })
    }
    return s
  }

  private openText(messageId: string, role: string): OpenText {
    let t = this.texts.get(messageId)
    if (!t) {
      const slot = role === 'assistant' ? this.slot(messageId) : null
      if (slot !== null && slot.text === null) slot.text = ''
      t = { slot, text: '' }
      this.texts.set(messageId, t)
    }
    return t
  }

  // Content for a message never started is read as an assistant message's, the default role.
  private textDelta(messageId: string, delta: string): RunEvent[] {
    const t = this.texts.get(messageId) ?? this.openText(messageId, 'assistant')
    if (t.slot === null || delta === '') return []
    t.text += delta
    t.slot.text = (t.slot.text ?? '') + delta
    return [{ kind: 'textDelta', text: delta }]
  }

  private endText(messageId: string): RunEvent[] {
    const t = this.texts.get(messageId)
    if (!t) return []
    this.texts.delete(messageId)
    return t.slot !== null && t.text.trim() !== '' ? [{ kind: 'assistantText', text: t.text }] : []
  }

  private openThought(key: string): void {
    if (!this.thoughts.has(key)) this.thoughts.set(key, '')
  }

  private thoughtDelta(key: string, delta: string): RunEvent[] {
    if (delta === '') return []
    this.thoughts.set(key, (this.thoughts.get(key) ?? '') + delta)
    return [{ kind: 'thinkingDelta', text: delta }]
  }

  private endThought(key: string): RunEvent[] {
    const t = this.thoughts.get(key)
    if (t === undefined) return []
    this.thoughts.delete(key)
    return t.trim() === '' ? [] : [{ kind: 'thinking', text: t }]
  }

  // A call joins its parent message in the transcript, or gets an assistant message of its own (as @ag-ui/client does).
  private startCall(toolCallId: string, name: string, parent: unknown): void {
    if (this.calls.has(toolCallId)) return
    const call: Call = { id: toolCallId, name, args: '', ended: false }
    this.calls.set(toolCallId, call)
    let slot: Slot
    if (typeof parent === 'string') slot = this.slot(parent)
    else {
      slot = { id: `calls-${toolCallId}`, text: null, calls: [] }
      this.entries.push({ slot })
    }
    slot.calls.push(call)
  }

  private endCall(c: Call): RunEvent {
    c.ended = true
    return { kind: 'toolUse', id: c.id, name: AGUI_TOOL, input: rowInput(c.name, c.args) }
  }
}

const subagent = (e: Obj): boolean => !absent(e.subagentRunId)
