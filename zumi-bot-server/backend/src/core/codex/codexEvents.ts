import { createHash } from 'node:crypto'
import type { RunEvent } from '../chat/streamParser'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import { SNAPSHOT_MAX_BYTES } from '../files/snapshotStore'
import { codexTurnCost } from './codexCost'
import type { UsageWindow } from '@zumibot/shared/types'
import { priceCodex, type CodexTokens } from '@zumibot/shared/pricing'
import type { RpcId } from './codexRpc'
import type { CodexRequestKind } from './codexAnswers'

// Turns Codex app-server notifications and server requests into the RunEvents the rest of ZumiBot already reads.
// Pure: it keeps only what the next message needs (started items, open requests, token sums).

export const CODEX_TOOL_OUTPUT_MAX = 30_000
const CUT = '\n[output cut]'

type Obj = Record<string, any>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const cap = (s: string): string => (s.length > CODEX_TOOL_OUTPUT_MAX ? s.slice(0, CODEX_TOOL_OUTPUT_MAX) + CUT : s)

/**
 * The row of a call a PreToolUse hook blocked. Codex makes no item for it (probe check 11): its text comes only in
 * `hook/completed`, so the row carries that text, the way a Claude hook's block becomes the call's error result.
 */
export const CODEX_BLOCKED_TOOL = 'Blocked'
const BLOCKED_NO_TEXT = 'Blocked by a hook'

/**
 * Subagents (probe check 13): a spawn shows only as a main-thread `subAgentActivity` item, and the child's own work streams on
 * the same connection under its thread id. Each child becomes an `Agent` dispatch, as Claude's do, so the Dispatched agents
 * panel, the Files panel and the pause read it unchanged. Codex sends no prompt on the main thread (the spawn's message is
 * sealed), so a dispatch is named by the last part of its `agentPath`.
 */
const SUBAGENT_TYPE = 'codex'
/** The row of a call on the subagents that is no spawn (a wait, a message to one, closing one). */
export const CODEX_AGENTS_TOOL = 'Subagents'
const NO_REPORT = 'The subagent finished without a report.'
const INTERRUPTED = 'The subagent was interrupted before it reported.'
/** What a subagent's approval card says about who asks. */
export const subagentLabel = (name: string): string => `From subagent ${name}`
const agentName = (path: string | null): string => path?.split('/').filter(Boolean).at(-1) ?? 'subagent'

// A child thread: its id, its dispatch's item id, the dispatch it runs under (a child's own subagent), its name, the model
// its start named (its requests are priced on it), and its last message.
type Child = {
  thread: string
  item: string
  parent: Child | null
  name: string
  model: string | null
  report: string | null
  tools: number
  ended: boolean
  turn: string | null
  turns: Set<string>
}

// Which answer a request codex sends gets, by method, for one declined with no card.
const REQUEST_KINDS = new Map<string, CodexRequestKind>([
  ['item/commandExecution/requestApproval', 'command'],
  ['item/fileChange/requestApproval', 'fileChange'],
  ['item/permissions/requestApproval', 'permissions'],
  ['mcpServer/elicitation/request', 'elicitation'],
  ['item/tool/requestUserInput', 'userInput']
])

// `pre-tool-use:<n>:<sourcePath>:<tool_use_id>`: the id the blocked call would have had is the only link to it.
function blockedCallId(run: Obj): string | null {
  const id = str(run.id)
  if (!id) return null
  const source = str(run.sourcePath)
  const at = source ? id.indexOf(`:${source}:`) : -1
  const rest = at >= 0 ? id.slice(at + source!.length + 2) : id.slice(id.lastIndexOf(':') + 1)
  return rest || null
}

// What an ApplyPatch card shows of each diff, and of all of them together.
export const CODEX_DIFF_MAX = 4_000
export const CODEX_CARD_DIFF_MAX = 20_000
const DIFF_CUT = '…[cut]'

export type Change = { path: string; kind: string; diff: string; movePath: string | null }
// thread: the thread the item runs on, so an approval only names a call of the thread that asked.
type Tracked = { type: string; thread: string; server?: string; tool?: string; changes?: Change[] }

const changesOf = (v: unknown): Change[] =>
  (Array.isArray(v) ? v : []).flatMap((c) => {
    const o = obj(c)
    const path = str(o?.path)
    const kind = obj(o?.kind)
    return path === null ? [] : [{ path, kind: str(kind?.type) ?? 'update', diff: str(o?.diff) ?? '', movePath: str(kind?.move_path) }]
  })

// Tool rows keep paths only: diffs would bloat every stored chat.
const rowChanges = (cs: Change[]) => cs.map(({ path, kind }) => ({ path, kind }))

// The card shows what will be written, and "Allow for this chat" keys on it: capped diffs, and for a cut one a digest of
// the whole text, so the rule never matches a patch that differs only past the cut. A move names where the file goes, which
// the user must see before allowing it; a plain change has no such key, so its card (and the rules keyed on it) stay as they were.
export function cardChanges(cs: Change[]): { path: string; kind: string; movePath?: string; diff: string; sha256?: string }[] {
  let left = CODEX_CARD_DIFF_MAX
  return cs.map(({ path, kind, movePath, diff }) => {
    const head = { path, kind, ...(movePath !== null ? { movePath } : {}) }
    const room = Math.min(CODEX_DIFF_MAX, left)
    if (diff.length <= room) {
      left -= diff.length
      return { ...head, diff }
    }
    left -= room
    return { ...head, diff: diff.slice(0, room) + DIFF_CUT, sha256: createHash('sha256').update(diff).digest('hex') }
  })
}

// The Files panel rebuilds the old file from these, so a diff is whole or marked cut, never silently short. The cut is the
// snapshot cap, so a diff is cut only when the copy it would give could not be kept anyway. The detail lives in memory for
// the tracker alone (never stored, pushed or logged), so a 1 MiB diff costs nothing past the result event.
function detailChanges(cs: Change[]) {
  return cs.map(({ path, kind, movePath, diff }) => {
    const buf = Buffer.from(diff)
    return buf.length <= SNAPSHOT_MAX_BYTES
      ? { path, kind, movePath, diff }
      : { path, kind, movePath, diff: buf.subarray(0, SNAPSHOT_MAX_BYTES).toString(), cut: true }
  })
}

// A question's text is its key in the card's answers, so it must be non-blank and unique within the call.
function cardQuestions(raw: unknown): Obj[] {
  const seen = new Set<string>()
  return (Array.isArray(raw) ? raw : []).flatMap((q) => {
    const o = obj(q)
    const id = str(o?.id)
    if (!o || !id) return []
    const header = str(o.header) ?? ''
    const base = str(o.question)?.trim() ? (o.question as string) : header.trim() ? header : null
    if (base === null) return []
    let text = base
    for (let n = 2; seen.has(text); n++) text = `${base} (${n})`
    seen.add(text)
    const options = (Array.isArray(o.options) ? o.options : []).flatMap((x) => {
      const label = str(obj(x)?.label)
      return label?.trim() ? [{ label, description: str(obj(x)?.description) }] : []
    })
    // No options: a free-text question. With options the card has its own Other field, which covers `isOther`.
    return [{ question: text, header, ...(options.length ? {} : { kind: 'text' }), multiSelect: false, options, codexId: id }]
  })
}

// The exhausted window's reset, else the later of the known ones; epoch ms.
function limitReset(snapshot: Obj | null): number | null {
  const windows = [obj(snapshot?.primary), obj(snapshot?.secondary)].filter(
    (w): w is Obj => !!w && typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)
  )
  const full = windows.filter((w) => typeof w.usedPercent === 'number' && w.usedPercent >= 100)
  const pool = full.length ? full : windows
  return pool.length ? Math.max(...pool.map((w) => w.resetsAt * 1000)) : null
}

// One snapshot window as the Usage popover's: percent used, reset in epoch ms (Codex sends seconds); null when unreadable.
function usageWindow(v: unknown): UsageWindow | null {
  const w = obj(v)
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null
  return { percent: w.usedPercent, resetsAt: typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null }
}

export class CodexEventMapper {
  private threadId = ''
  private modelName: string | null = null
  private errorText: string | null = null
  private errorInfo: string | null = null
  private items = new Map<string, Tracked>() // started and not yet completed
  private open = new Set<string>() // requests that showed a card and are not resolved yet
  private tokens = { input: 0, cachedInput: 0, output: 0 }
  private tokenUpdates = 0
  // What the turn's subagents spent, per model: paid for like the main thread's requests, though never its context.
  private childTokens = new Map<string | null, CodexTokens>()
  private childUpdates = 0
  private spends = 0 // numbers each request's spend event: Codex reports a request's tokens once, under no id of its own
  private window: number | null = null
  private lastContext = 0
  private snapshot: Obj | null = null
  // Codex reports one compaction as an item and as the older notice; each source skips one echo of the other. A flag
  // left over from one turn must not swallow the next turn's own compaction, so a turn boundary clears both.
  private skipItem = false
  private skipNotice = false
  // A blocked call's row, held until a notice about something else: every hook that blocked the call lands in one row.
  // A child's block is a row under its dispatch, and never one of the main thread's responses.
  private held: { id: string; texts: string[]; message: string; child: Child | null } | null = null
  // Child thread id -> its dispatch. Kept once it ends: its turn's end and idle notices still follow, and stay its own.
  private children = new Map<string, Child>()
  // Each subAgentActivity comes as item/started and again as item/completed: only the first is mapped.
  private activities = new Set<string>()
  // The model response the latest calls came in. Codex names none, so the main thread's next response starts after a call
  // at its token usage (one per model request, after that request's hooks: probe check 11), or at an agentMessage or
  // reasoning item or a turn. Calls of one response share its id, as Claude's share their API message id, so the pause's
  // safety cap counts one round per response, not one per call. A request of calls alone is still its own round.
  private response = 0
  private callSince = false
  // The main thread's reasoning items now open -> when each began (startedAtMs), so a kept thought is timed from its start:
  // its summary is written as the item ends, so the first summary delta comes late.
  private reasoning = new Map<string, number | null>()

  get lastError(): string | null {
    return this.errorText
  }
  // The `codexErrorInfo` code of the last error notice (or the failed turn's), so the runner can tell `unauthorized`.
  get lastErrorInfo(): string | null {
    return this.errorInfo
  }
  get model(): string | null {
    return this.modelName
  }

  started(threadId: string, model: string | null, version: string | null): RunEvent[] {
    this.threadId = threadId
    this.modelName = model
    return [{ kind: 'init', sessionId: threadId, ...(version ? { version } : {}) }]
  }

  // The runner answered this request itself, so the resolved notice that follows is no cancellation.
  answered(id: RpcId): void {
    this.open.delete(String(id))
  }

  /** The blocked call's row still held, if any. The runner calls it before a server request and when the process ends. */
  flush(): RunEvent[] {
    const h = this.held
    if (!h) return []
    this.held = null
    const content = cap(h.texts.join('\n') || BLOCKED_NO_TEXT)
    if (h.child)
      return [
        { kind: 'subToolUse', parent: h.child.item, id: h.id, name: CODEX_BLOCKED_TOOL, input: {}, subagent: h.child.name },
        { kind: 'subToolResult', parent: h.child.item, toolUseId: h.id, content, isError: true }
      ]
    return [
      { kind: 'toolUse', id: h.id, name: CODEX_BLOCKED_TOOL, input: {}, message: h.message },
      { kind: 'toolResult', toolUseId: h.id, content, isError: true }
    ]
  }

  notification(method: string, params: any): RunEvent[] {
    const p = obj(params)
    const threadId = str(p?.threadId)
    const child = this.childOf(threadId)
    if (method === 'hook/started' || method === 'hook/completed') return this.hookNotice(method, p, child)
    // R23: request ids are the process's, so a resolved notice counts whoever names it; anything else from a stranger is dropped.
    if (method !== 'serverRequest/resolved' && this.stranger(threadId)) return []
    return [...this.flush(), ...(child ? this.childNotice(method, p, child) : this.mapped(method, p))]
  }

  // The dispatch a notice of a started child belongs to; null for the main thread and any thread nobody started.
  private childOf(threadId: string | null): Child | null {
    return threadId !== null && threadId !== this.threadId ? (this.children.get(threadId) ?? null) : null
  }

  // A thread no started activity announced, once the main one is known (a child resumed in a later process, say). Taken as the
  // main thread's, its rows, text, context, cost and turn end would land in the chat, and its end would end the run.
  private stranger(threadId: string | null): boolean {
    return threadId !== null && this.threadId !== '' && threadId !== this.threadId && !this.children.has(threadId)
  }

  // The main thread's and a started child's; any other thread's hooks are left alone.
  private hookNotice(method: string, p: Obj | null, child: Child | null): RunEvent[] {
    const run = obj(p?.run)
    if (!run || (!child && str(p?.threadId) !== this.threadId) || run.eventName !== 'preToolUse') return []
    const id = blockedCallId(run)
    const out = this.held && this.held.id !== id ? this.flush() : []
    if (method !== 'hook/completed' || run.status !== 'blocked' || !id) return out
    const texts = (Array.isArray(run.entries) ? run.entries : []).flatMap((e) => {
      const o = obj(e)
      return o?.kind === 'feedback' && typeof o.text === 'string' ? [o.text] : []
    })
    // The response the block came in, even though its row goes out as the next one starts. A child's is none of the main thread's.
    if (this.held) this.held.texts.push(...texts)
    else this.held = { id, texts, message: child ? '' : this.callIn(), child }
    return out
  }

  // The id of the response a call comes in, marking that a call came.
  private callIn(): string {
    this.callSince = true
    return `${this.threadId}:response-${this.response}`
  }

  // A child thread's items, usage and turns are its own responses, not the main thread's; a notice naming no thread is the main one's.
  private responseStarts(threadId: string | null): void {
    if (!this.callSince || (threadId !== null && threadId !== this.threadId)) return
    this.response++
    this.callSince = false
  }

  private mapped(method: string, p: Obj | null): RunEvent[] {
    switch (method) {
      case 'turn/started':
        this.responseStarts(str(p?.threadId))
        this.tokens = { input: 0, cachedInput: 0, output: 0 }
        this.tokenUpdates = 0
        this.childTokens = new Map()
        this.childUpdates = 0
        this.skipItem = this.skipNotice = false
        return []
      case 'item/agentMessage/delta': {
        const text = str(p?.delta)
        return text ? [{ kind: 'textDelta', text }] : []
      }
      case 'item/started':
        return this.itemStarted(obj(p?.item), str(p?.threadId), p?.startedAtMs)
      // The reasoning summary (thread config model_reasoning_summary), never the raw reasoning (item/reasoning/textDelta).
      // A new part after the first is a new paragraph, as the kept item's parts are joined.
      case 'item/reasoning/summaryPartAdded':
        return typeof p?.summaryIndex === 'number' && p.summaryIndex > 0 ? [{ kind: 'thinkingDelta', text: '\n\n' }] : []
      case 'item/reasoning/summaryTextDelta': {
        const text = str(p?.delta)
        return text ? [{ kind: 'thinkingDelta', text }] : []
      }
      case 'item/completed':
        return this.itemCompleted(obj(p?.item), null)
      case 'thread/tokenUsage/updated':
        this.responseStarts(str(p?.threadId))
        return this.tokenUsage(obj(p?.tokenUsage))
      case 'account/rateLimits/updated':
        // Kept for `limited`, and sent on as Codex's own reading (tagged, so it never replaces Claude's numbers).
        this.snapshot = obj(p?.rateLimits) ?? this.snapshot
        return this.planReading(obj(p?.rateLimits))
      case 'error':
        return this.errorNotice(obj(p?.error))
      case 'thread/compacted':
        if (this.skipNotice) {
          this.skipNotice = false
          return []
        }
        this.skipItem = true
        return [this.compacted()]
      case 'serverRequest/resolved': {
        if (p?.requestId === undefined || p?.requestId === null) return []
        const id = String(p.requestId)
        if (!this.open.delete(id)) return []
        return [{ kind: 'permissionCancel', requestId: id }]
      }
      case 'turn/completed':
        return this.turnCompleted(obj(p?.turn))
      // Plans, diffs, approval reviews and the rest are not shown.
      default:
        return []
    }
  }

  // A started child's own notices: its work goes under its dispatch, never into the main thread's reply, context, cost,
  // responses or result. A fresh turn reactivates its dispatch; its text deltas, errors and status changes show nothing.
  private childNotice(method: string, p: Obj | null, child: Child): RunEvent[] {
    // Old items for a completed turn must not mutate a newer task. Late usage still belongs in the main turn's cost.
    const noticeTurn = str(p?.turnId)
    if (method.startsWith('item/') && noticeTurn && child.turns.has(noticeTurn) && noticeTurn !== child.turn) return []
    switch (method) {
      case 'turn/started': {
        const turn = str(obj(p?.turn)?.id)
        if (!turn || child.turns.has(turn)) return []
        const restart = child.ended || child.turn !== null
        child.turns.add(turn)
        child.turn = turn
        return restart ? this.reactivate(child) : []
      }
      case 'item/started': {
        const item = obj(p?.item)
        const id = str(item?.id)
        if (!item || !id) return []
        if (item.type === 'subAgentActivity') return this.activity(item, child)
        const row = this.toolRow(item, id, child.thread)
        return row ? [this.subUse(row, child)] : []
      }
      case 'item/completed':
        return this.itemCompleted(obj(p?.item), child)
      case 'thread/tokenUsage/updated': {
        const usage = obj(p?.tokenUsage)
        // Its request is paid for: added to the turn's cost on the child's model (the main one's when its start named none).
        const last = obj(usage?.last)
        if (last) {
          const model = child.model ?? this.modelName
          const t = this.childTokens.get(model) ?? { input: 0, cachedInput: 0, output: 0 }
          this.childTokens.set(model, {
            input: t.input + num(last.inputTokens),
            cachedInput: t.cachedInput + num(last.cachedInputTokens),
            output: t.output + num(last.outputTokens)
          })
          this.childUpdates++
        }
        const spend = last ? this.spend(child.model ?? this.modelName, last) : []
        // Its own running total is its dispatch's size in the panel, never the main thread's context.
        const tokens = obj(usage?.total)?.totalTokens
        if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return spend
        return [
          ...spend,
          { kind: 'taskProgress', toolUseId: child.item, description: null, tokens, toolUses: child.tools, durationMs: null }
        ]
      }
      // Request ids are the process's, whichever thread asked.
      case 'serverRequest/resolved':
        return this.mapped(method, p)
      default:
        return []
    }
  }

  private subUse(row: Extract<RunEvent, { kind: 'toolUse' }>, child: Child): RunEvent {
    child.tools++
    return { kind: 'subToolUse', parent: child.item, id: row.id, name: row.name, input: row.input, subagent: child.name }
  }

  // A subAgentActivity, on the main thread (parent null) or a child's (its own subagent).
  private activity(item: Obj, parent: Child | null): RunEvent[] {
    const id = str(item.id)
    const threadId = str(item.agentThreadId)
    if (!id || !threadId || this.activities.has(id)) return []
    this.activities.add(id)
    if (item.kind === 'started') return this.dispatchStarted(id, threadId, str(item.agentPath), str(item.model), parent)
    if (item.kind === 'completed' || item.kind === 'interrupted') {
      const child = this.children.get(threadId)
      // Recorded terminal activity ids name the child's turn, while the enclosing turnId is the parent's.
      const turn = id.startsWith(`subagent-${item.kind}-`) ? id.slice(`subagent-${item.kind}-`.length) : null
      if (child && turn && child.turns.has(turn) && turn !== child.turn) return []
      return this.dispatchEnded(threadId, item.kind === 'interrupted')
    }
    return []
  }

  private dispatchStarted(id: string, threadId: string, path: string | null, model: string | null, parent: Child | null): RunEvent[] {
    const known = this.children.get(threadId)
    if (known) {
      if (!known.ended) return []
      known.turn = null // the next fresh turn/started binds the activity to its child turn
      return this.reactivate(known)
    }
    const name = agentName(path)
    this.children.set(threadId, {
      thread: threadId,
      item: id,
      parent,
      name,
      model,
      report: null,
      tools: 0,
      ended: false,
      turn: null,
      turns: new Set()
    })
    const input = { description: name, subagent_type: SUBAGENT_TYPE }
    const use: RunEvent = parent
      ? this.subUse({ kind: 'toolUse', id, name: 'Agent', input }, parent)
      : { kind: 'toolUse', id, name: 'Agent', input, message: this.callIn() }
    return [use, { kind: 'taskStarted', toolUseId: id, taskId: threadId, description: name, subagentType: SUBAGENT_TYPE, prompt: null }]
  }

  // Reuse the announced dispatch and task id. Only Codex emits restart; ordinary Claude task_started stays unchanged.
  private reactivate(child: Child): RunEvent[] {
    child.ended = false
    child.report = null
    child.tools = 0
    return [
      {
        kind: 'taskStarted',
        toolUseId: child.item,
        taskId: child.thread,
        description: child.name,
        subagentType: SUBAGENT_TYPE,
        prompt: null,
        restart: true
      }
    ]
  }

  // The report is the child's last message. An interrupted child was cut off, not failed (`cut`). Codex sends no end for a child
  // its process exit killed: the recorder ends that one.
  private dispatchEnded(threadId: string, interrupted: boolean): RunEvent[] {
    const child = this.children.get(threadId)
    if (!child || child.ended) return []
    child.ended = true
    const content = cap(child.report ?? (interrupted ? INTERRUPTED : NO_REPORT))
    const detail = child.report !== null ? { detail: { content: child.report } } : {}
    const end: RunEvent = child.parent
      ? { kind: 'subToolResult', parent: child.parent.item, toolUseId: child.item, content, isError: interrupted, ...detail }
      : { kind: 'toolResult', toolUseId: child.item, content, isError: interrupted, ...detail }
    return [
      {
        kind: 'taskUpdated',
        taskId: threadId,
        status: interrupted ? 'interrupted' : 'completed',
        endTime: null,
        ...(interrupted ? { cut: true as const } : {})
      },
      end
    ]
  }

  serverRequest(id: RpcId, method: string, params: any): { events: RunEvent[]; kind: CodexRequestKind | null } {
    const p = obj(params) ?? {}
    const requestId = String(id)
    // A child's request is a card like any other, saying which subagent asks. A stranger's (R23) is declined at once, with no
    // card: nothing this run shows asked it, and codex must not wait on an answer nobody can give.
    const asker = str(p.threadId)
    if (this.stranger(asker)) return { kind: REQUEST_KINDS.get(method) ?? null, events: [] }
    const child = this.childOf(asker)
    const ask = (toolName: string, input: unknown, reason: string | null, toolUseId: string | null): RunEvent[] => {
      this.open.add(requestId)
      return [
        { kind: 'permissionRequest', requestId, toolName, input, description: child ? subagentLabel(child.name) : null, reason, toolUseId }
      ]
    }
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return { kind: 'command', events: ask('Bash', { command: p.command ?? null, cwd: p.cwd ?? null }, str(p.reason), str(p.itemId)) }
      case 'item/fileChange/requestApproval': {
        const itemId = str(p.itemId)
        const changes = (itemId && this.items.get(itemId)?.changes) || []
        // A card with nothing to read would be a blind yes: no card, and the runner declines it. So is a grantRoot: accepting
        // it allows writes under that root for the rest of the session, which neither the card nor an ApplyPatch rule shows.
        // Anything but none (null, absent or '') counts as one, so an odd value fails closed too.
        const grantRoot = p.grantRoot
        if (changes.length === 0 || (grantRoot !== undefined && grantRoot !== null && grantRoot !== ''))
          return { kind: 'fileChange', events: [] }
        return { kind: 'fileChange', events: ask('ApplyPatch', { changes: cardChanges(changes) }, str(p.reason), itemId) }
      }
      case 'item/permissions/requestApproval':
        return {
          kind: 'permissions',
          events: ask('SandboxPermissions', { permissions: p.permissions ?? null, cwd: p.cwd ?? null }, str(p.reason), str(p.itemId))
        }
      case 'mcpServer/elicitation/request':
        return { kind: 'elicitation', events: this.elicitation(p, asker ?? this.threadId, ask) }
      // Only arrives when the run passed the question feature flag. No usable question: no card, the runner declines.
      case 'item/tool/requestUserInput': {
        const questions = cardQuestions(p.questions)
        return { kind: 'userInput', events: questions.length ? ask(QUESTION_TOOL, { questions }, null, str(p.itemId)) : [] }
      }
      default:
        return { kind: null, events: [{ kind: 'controlUnknown', requestId, subtype: method }] }
    }
  }

  // Only a tool-call approval becomes a card. It names no item, and calls of one server run in parallel, so the quoted
  // name wins: a card (and a remembered rule) labelled with another running tool would allow a call the user never saw.
  // Only the asking thread's calls: the main thread and a child may run the same tool at once.
  private elicitation(p: Obj, thread: string, ask: (n: string, i: unknown, r: string | null, t: string | null) => RunEvent[]): RunEvent[] {
    const meta = obj(p._meta)
    const server = str(p.serverName)
    if (!server || meta?.codex_approval_kind !== 'mcp_tool_call') return []
    const running = [...this.items].filter(([, t]) => t.type === 'mcpToolCall' && t.server === server && t.thread === thread)
    const quoted = /tool "([^"]+)"/.exec(str(p.message) ?? '')?.[1] ?? null
    const pool = quoted === null ? running : running.filter(([, t]) => t.tool === quoted)
    // Unquoted with no or several candidates: the tool is a guess, so no card and the runner declines.
    if (quoted === null && pool.length !== 1) return []
    const tool = quoted ?? pool[0][1].tool
    if (!tool) return []
    return ask(`mcp__${server}__${tool}`, meta.tool_params ?? {}, null, pool.length === 1 ? pool[0][0] : null)
  }

  private itemStarted(item: Obj | null, threadId: string | null, startedAtMs?: unknown): RunEvent[] {
    if (item?.type === 'agentMessage' || item?.type === 'reasoning') this.responseStarts(threadId)
    if (item?.type === 'reasoning' && str(item.id)) {
      this.reasoning.set(str(item.id)!, typeof startedAtMs === 'number' && Number.isFinite(startedAtMs) ? startedAtMs : null)
      return []
    }
    if (item?.type === 'subAgentActivity') return this.activity(item, null)
    const id = str(item?.id)
    if (!item || !id) return []
    const use = this.toolUse(item, id)
    return use ? [use] : []
  }

  // The main thread's tool row for a tool-like item, with the response it came in; null for items that are not tools.
  private toolUse(item: Obj, id: string): RunEvent | null {
    const row = this.toolRow(item, id, this.threadId)
    return row && { ...row, message: this.callIn() }
  }

  // Builds the tool row for a tool-like item on `thread` and remembers it; null for items that are not tools.
  private toolRow(item: Obj, id: string, thread: string): Extract<RunEvent, { kind: 'toolUse' }> | null {
    switch (item.type) {
      case 'commandExecution':
        this.items.set(id, { type: 'commandExecution', thread })
        return { kind: 'toolUse', id, name: 'Bash', input: { command: item.command ?? null, cwd: item.cwd ?? null } }
      case 'fileChange': {
        const changes = changesOf(item.changes)
        this.items.set(id, { type: 'fileChange', thread, changes })
        return { kind: 'toolUse', id, name: 'ApplyPatch', input: { changes: rowChanges(changes) } }
      }
      case 'mcpToolCall': {
        const server = str(item.server)
        const tool = str(item.tool)
        if (!server || !tool) return null
        this.items.set(id, { type: 'mcpToolCall', thread, server, tool })
        return { kind: 'toolUse', id, name: `mcp__${server}__${tool}`, input: item.arguments ?? {} }
      }
      case 'webSearch':
        this.items.set(id, { type: 'webSearch', thread })
        return { kind: 'toolUse', id, name: 'WebSearch', input: { query: str(item.query) ?? '' } }
      // Waiting for subagents, messaging or closing one: a plain row naming the children it reaches. Never a dispatch: a
      // spawn shows as subAgentActivity (check 13 saw no spawnAgent call item).
      case 'collabAgentToolCall': {
        this.items.set(id, { type: 'collabAgentToolCall', thread })
        const agents = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).flatMap((t) =>
          typeof t === 'string' ? [this.children.get(t)?.name ?? t] : []
        )
        const prompt = str(item.prompt)
        return {
          kind: 'toolUse',
          id,
          name: CODEX_AGENTS_TOOL,
          input: { tool: str(item.tool) ?? 'unknown', ...(agents.length ? { agents } : {}), ...(prompt !== null ? { prompt } : {}) }
        }
      }
      default:
        return null
    }
  }

  // child: the started child whose item this is (its rows go under its dispatch), else null for the main thread.
  private itemCompleted(item: Obj | null, child: Child | null): RunEvent[] {
    if (!item) return []
    const id = str(item.id)
    switch (item.type) {
      // A child's reasoning is its own, as a Claude subagent's thinking is; childNotice drops its summary deltas too.
      case 'reasoning': {
        if (child) return []
        const startedAt = id ? (this.reasoning.get(id) ?? null) : null
        if (id) this.reasoning.delete(id)
        const text = (Array.isArray(item.summary) ? item.summary : [])
          .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
          .join('\n\n')
        return text ? [{ kind: 'thinking', text, ...(startedAt !== null ? { startedAt } : {}) }] : []
      }
      case 'agentMessage': {
        const text = str(item.text)
        if (!text) return []
        if (!child) return [{ kind: 'assistantText', text }]
        child.report = text
        return [{ kind: 'subText', parent: child.item, text }]
      }
      case 'contextCompaction':
        if (child) return []
        if (this.skipItem) {
          this.skipItem = false
          return []
        }
        this.skipNotice = true
        return [this.compacted()]
      case 'subAgentActivity':
        return this.activity(item, child)
      case 'commandExecution':
      case 'fileChange':
      case 'mcpToolCall':
      case 'webSearch':
      case 'collabAgentToolCall': {
        if (!id) return []
        const out: RunEvent[] = []
        if (!this.items.has(id)) {
          const row = child ? this.toolRow(item, id, child.thread) : null
          const use = child ? row && this.subUse(row, child) : this.toolUse(item, id)
          if (!use) return []
          out.push(use)
        }
        this.items.delete(id)
        const outcome = this.toolOutcome(item)
        const detail =
          item.type === 'fileChange' && !outcome.isError ? { detail: { codexChanges: detailChanges(changesOf(item.changes)) } } : {}
        out.push(
          child
            ? { kind: 'subToolResult', parent: child.item, toolUseId: id, ...outcome, ...detail }
            : { kind: 'toolResult', toolUseId: id, ...outcome, ...detail }
        )
        return out
      }
      default:
        return []
    }
  }

  private toolOutcome(item: Obj): { content: string; isError: boolean } {
    switch (item.type) {
      case 'commandExecution': {
        const code = item.exitCode
        const failed = item.status === 'failed' || item.status === 'declined' || (typeof code === 'number' && code !== 0)
        return { content: cap(str(item.aggregatedOutput) ?? ''), isError: failed }
      }
      case 'fileChange': {
        const changes = changesOf(item.changes)
        const done = item.status === 'completed'
        return {
          content: cap(done ? changes.map((c) => `${c.kind} ${c.path}`).join('\n') : `Patch ${str(item.status) ?? 'failed'}`),
          isError: !done
        }
      }
      case 'mcpToolCall': {
        const error = str(obj(item.error)?.message)
        if (error !== null) return { content: cap(error), isError: true }
        const parts = Array.isArray(obj(item.result)?.content) ? (item.result.content as unknown[]) : []
        const text = parts
          .map((c) => {
            const o = obj(c)
            return o?.type === 'text' && typeof o.text === 'string' ? o.text : `[${str(o?.type) ?? 'unknown'}]`
          })
          .join('\n')
        return { content: cap(text), isError: item.status === 'failed' }
      }
      case 'collabAgentToolCall': {
        // What it reported of each child it reached, by name.
        const states = Object.entries(obj(item.agentsStates) ?? {}).map(
          ([t, s]) => `${this.children.get(t)?.name ?? t}: ${str(obj(s)?.status) ?? str(s) ?? 'unknown'}`
        )
        return { content: cap(states.join('\n')), isError: item.status === 'failed' }
      }
      default: // webSearch: the results stay opaque, the row shows what was searched
        return { content: cap(`Searched: ${str(item.query) ?? ''}`), isError: item.status === 'failed' }
    }
  }

  private tokenUsage(usage: Obj | null): RunEvent[] {
    const last = obj(usage?.last)
    if (!last) return []
    // OpenAI counts cached input inside inputTokens, so the context is input + output.
    const input = num(last.inputTokens)
    const output = num(last.outputTokens)
    this.tokens.input += input
    this.tokens.cachedInput += num(last.cachedInputTokens)
    this.tokens.output += output
    this.tokenUpdates++
    if (typeof usage?.modelContextWindow === 'number' && usage.modelContextWindow > 0) this.window = usage.modelContextWindow
    this.lastContext = input + output
    return [{ kind: 'context', model: this.modelName, tokens: this.lastContext }, ...this.spend(this.modelName, last)]
  }

  // One request's price for the spend caps, as the turn's cost will price it; nothing for an unpriced or unnamed model.
  private spend(model: string | null, last: Obj): RunEvent[] {
    const usd = model
      ? priceCodex(model, { input: num(last.inputTokens), cachedInput: num(last.cachedInputTokens), output: num(last.outputTokens) })
      : null
    return usd !== null && usd > 0 ? [{ kind: 'spend', id: `codex:${++this.spends}`, usd }] : []
  }

  private compacted(): RunEvent {
    return { kind: 'compacted', pre: this.lastContext, post: 0 }
  }

  private planReading(snapshot: Obj | null): RunEvent[] {
    const session = usageWindow(snapshot?.primary)
    const weekly = usageWindow(snapshot?.secondary)
    return session || weekly ? [{ kind: 'rateLimit', provider: 'codex', session, weekly }] : []
  }

  private errorNotice(error: Obj | null): RunEvent[] {
    if (!error) return []
    const message = str(error.message)
    if (message !== null) this.errorText = message
    const info = str(error.codexErrorInfo)
    if (info !== null) this.errorInfo = info
    if (error.codexErrorInfo !== 'usageLimitExceeded' && !this.snapshot?.rateLimitReachedType) return []
    return [{ kind: 'limited', resetsAt: limitReset(this.snapshot) }]
  }

  private turnCompleted(turn: Obj | null): RunEvent[] {
    if (!turn) return []
    const status = str(turn.status) ?? 'completed'
    if (this.errorText === null) this.errorText = str(obj(turn.error)?.message)
    if (this.errorInfo === null) this.errorInfo = str(obj(turn.error)?.codexErrorInfo)
    this.skipItem = this.skipNotice = false
    const id = str(turn.id)
    // The turn's id is the only cut point Codex has (thread/fork keeps whole turns), so the entry comes only here, at the end.
    return [
      ...(id ? [{ kind: 'entry' as const, uuid: id }] : []),
      {
        kind: 'result',
        subtype: status,
        isError: status === 'failed',
        numTurns: 1,
        sessionId: this.threadId,
        denials: [],
        windows: this.modelName && this.window ? { [this.modelName]: this.window } : {},
        uuid: str(turn.id),
        // The main thread's requests and its subagents', each on its own model; none reported, no cost.
        cost:
          this.tokenUpdates || this.childUpdates
            ? codexTurnCost([
                ...(this.tokenUpdates ? [{ model: this.modelName, tokens: this.tokens }] : []),
                ...[...this.childTokens].map(([model, tokens]) => ({ model, tokens }))
              ])
            : null
      }
    ]
  }
}
