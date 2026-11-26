import type { UsageWindow } from '@zumibot/shared/types'
import { parseRunCost, type RunCost } from '../usage/runCost'
import { priceMessage, usageTokens } from '@zumibot/shared/pricing'

export interface Denial {
  toolUseId: string
  toolName: string
}
export type RunEvent =
  | { kind: 'init'; sessionId: string; version?: string }
  | { kind: 'entry'; uuid: string } // a session-log entry the CLI wrote; comes before that line's content events
  | { kind: 'userReplay'; uuid: string } // a stdin user message (a mid-turn steer) echoed as the CLI took it in (--replay-user-messages)
  | { kind: 'textDelta'; text: string }
  | { kind: 'assistantText'; text: string }
  // Thinking text comes only with --thinking-display summarized; without it every thinking block streams empty and none is sent.
  | { kind: 'thinkingDelta'; text: string }
  // One thinking block's whole summary, as the block ends. startedAt: Codex only, when its reasoning began (epoch ms); Claude's
  // are timed from their first delta.
  | { kind: 'thinking'; text: string; startedAt?: number }
  // message: the API response it came in. The CLI writes one line per content block, so parallel calls of one response share it.
  | { kind: 'toolUse'; id: string; name: string; input: unknown; message?: string }
  | { kind: 'toolResult'; toolUseId: string; content: string; isError: boolean; detail?: unknown } // detail: the line's tool_use_result, when an object
  // A subagent's own work, under the tool use that dispatched it: the Files panel reads its Edit/Write (and the Agent/Task
  // calls that nest more subagents), the Dispatched agents panel all of it.
  | { kind: 'subText'; parent: string; text: string }
  | { kind: 'subToolUse'; parent: string; id: string; name: string; input: unknown; subagent: string | null }
  | { kind: 'subToolResult'; parent: string; toolUseId: string; content: string; isError: boolean; detail?: unknown }
  // The CLI's own account of each dispatch. task_updated names only the task, so it is mapped through task_started.
  | {
      kind: 'taskStarted'
      toolUseId: string
      taskId: string
      description: string | null
      subagentType: string | null
      prompt: string | null
      restart?: true
    }
  | {
      kind: 'taskProgress'
      toolUseId: string
      description: string | null
      tokens: number | null
      toolUses: number | null
      durationMs: number | null
    }
  // cut: set only by the Codex mapper, for a subagent codex reports `interrupted`: it was cut off, not failed. Claude's never has it.
  | { kind: 'taskUpdated'; taskId: string; status: string | null; endTime: number | null; cut?: true }
  // windows: each model's context window, in tokens
  | {
      kind: 'result'
      subtype: string
      isError: boolean
      numTurns: number
      sessionId: string
      denials: Denial[]
      windows: Record<string, number>
      uuid: string | null
      cost: RunCost | null
    }
  | {
      kind: 'permissionRequest'
      requestId: string
      toolName: string
      input: unknown
      description: string | null
      reason: string | null
      toolUseId: string | null
    }
  | { kind: 'permissionCancel'; requestId: string }
  | { kind: 'controlUnknown'; requestId: string | null; subtype: string }
  // provider is set only by Codex runs (their plan, not Claude's); Claude's events never carry it.
  | { kind: 'rateLimit'; provider?: 'codex'; session: UsageWindow | null; weekly: UsageWindow | null }
  | { kind: 'limited'; resetsAt: number | null } // a request the usage limit rejected; resetsAt in epoch ms
  | { kind: 'context'; model: string | null; tokens: number } // how full the agent's context was at its latest request
  // What one model request has cost so far, the agent's or a subagent's, priced from its usage (spend caps). The CLI repeats a
  // message's usage on each of its content block lines, so `id` names the request and the reader keeps the highest.
  | { kind: 'spend'; id: string; usd: number }
  | { kind: 'denied'; toolUseId: string; reasonType: string } // the CLI refused a call before its result; reasonType 'classifier' = Auto mode's classifier
  | { kind: 'compacting'; on: boolean }
  | { kind: 'compacted'; pre: number; post: number } // post counts the summary only, not the system prompt and tools
  // A fixed sentence the chat shows as a notice. Only the AG-UI runner emits it; Claude and Codex never do.
  | { kind: 'notice'; text: string }
export type ResultEvent = Extract<RunEvent, { kind: 'result' }>

export const APPROVAL_REQUIRED = 'This command requires approval'

export class LineSplitter {
  // The unfinished line as its chunks: a multi-megabyte line (a big tool result) arrives in many chunks, and joining and
  // rescanning the whole of it on each one would stall the event loop every chat shares.
  private partial: string[] = []
  push(chunk: string): string[] {
    const parts = chunk.split('\n')
    if (parts.length === 1) {
      if (chunk) this.partial.push(chunk)
      return []
    }
    this.partial.push(parts[0]!)
    parts[0] = this.partial.join('')
    const rest = parts.pop()!
    this.partial = rest ? [rest] : []
    return parts.map(stripCR)
  }
  flush(): string[] {
    const rest = stripCR(this.partial.join(''))
    this.partial = []
    return rest ? [rest] : []
  }
}

const stripCR = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)

type Obj = Record<string, any>

function normalizeContent(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : `[${p?.type ?? 'unknown'}]`)).join('\n')
  }
  return ''
}

// A rate_limit_event window: utilization is a 0–1 fraction, resetsAt is in epoch seconds.
function usageWindow(w: unknown): UsageWindow | null {
  if (!w || typeof w !== 'object') return null
  const { utilization, resetsAt } = w as Obj
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null
  return { percent: utilization * 100, resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt * 1000 : null }
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

// What the request sent plus what it wrote back: the context the next request starts from.
function contextOf(message: Obj): RunEvent[] {
  const u = message.usage
  if (!u || typeof u !== 'object' || message.model === '<synthetic>') return []
  const parts = [u.input_tokens, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.output_tokens ?? 0]
  if (!parts.every(count)) return []
  return [{ kind: 'context', model: typeof message.model === 'string' ? message.model : null, tokens: parts.reduce((a, b) => a + b, 0) }]
}

// A request's price from its usage line; nothing for an unpriced model, a synthetic message or no usage.
function spendOf(message: Obj): RunEvent[] {
  if (!message || typeof message.id !== 'string' || !message.id || typeof message.model !== 'string' || message.model === '<synthetic>')
    return []
  const tokens = usageTokens(message.usage)
  const usd = tokens ? priceMessage(message.model, tokens) : null
  return usd !== null && usd > 0 ? [{ kind: 'spend', id: message.id, usd }] : []
}

function windowsOf(modelUsage: unknown): Record<string, number> {
  if (!modelUsage || typeof modelUsage !== 'object') return {}
  return Object.fromEntries(
    Object.entries(modelUsage as Obj).flatMap(([model, m]) =>
      count(m?.contextWindow) && m.contextWindow > 0 ? [[model, m.contextWindow]] : []
    )
  )
}

// Subagent lines never get here (see subagentEvents), so only the agent's own log entries do.
const entryOf = (m: Obj): RunEvent[] => (typeof m.uuid === 'string' && m.uuid ? [{ kind: 'entry', uuid: m.uuid }] : [])

// A subagent's deltas, usage and entries are not the agent's reply and stay dropped; its prompt line is the dispatch's input.
function subagentEvents(m: Obj, parent: string): RunEvent[] {
  const content = m.message?.content
  // Its requests are paid for like the agent's own: priced for the spend caps, whatever their content.
  const out: RunEvent[] = m.type === 'assistant' && m.message && typeof m.message === 'object' ? spendOf(m.message) : []
  if (!Array.isArray(content)) return out
  const detail = m.tool_use_result && typeof m.tool_use_result === 'object' ? { detail: m.tool_use_result } : {}
  for (const b of content) {
    if (m.type === 'assistant' && b?.type === 'text' && typeof b.text === 'string') {
      out.push({ kind: 'subText', parent, text: b.text })
    } else if (m.type === 'assistant' && b?.type === 'tool_use' && typeof b.name === 'string') {
      out.push({
        kind: 'subToolUse',
        parent,
        id: b.id,
        name: b.name,
        input: b.input,
        subagent: typeof m.subagent_type === 'string' ? m.subagent_type : null
      })
    } else if (m.type === 'user' && b?.type === 'tool_result') {
      out.push({
        kind: 'subToolResult',
        parent,
        toolUseId: b.tool_use_id,
        content: normalizeContent(b.content),
        isError: b.is_error === true,
        ...detail
      })
    }
  }
  return out
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const countOrNull = (v: unknown): number | null => (count(v) ? v : null)
const idOf = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function taskEvents(m: Obj): RunEvent[] {
  if (m.subtype === 'task_started') {
    if (!idOf(m.tool_use_id) || !idOf(m.task_id)) return []
    return [
      {
        kind: 'taskStarted',
        toolUseId: m.tool_use_id,
        taskId: m.task_id,
        description: strOrNull(m.description),
        subagentType: strOrNull(m.subagent_type),
        prompt: strOrNull(m.prompt)
      }
    ]
  }
  if (m.subtype === 'task_progress') {
    if (!idOf(m.tool_use_id)) return []
    const u = m.usage && typeof m.usage === 'object' ? m.usage : {}
    return [
      {
        kind: 'taskProgress',
        toolUseId: m.tool_use_id,
        description: strOrNull(m.description),
        tokens: countOrNull(u.total_tokens),
        toolUses: countOrNull(u.tool_uses),
        durationMs: countOrNull(u.duration_ms)
      }
    ]
  }
  if (!idOf(m.task_id)) return []
  const patch = m.patch && typeof m.patch === 'object' ? m.patch : {}
  return [{ kind: 'taskUpdated', taskId: m.task_id, status: strOrNull(patch.status), endTime: countOrNull(patch.end_time) }]
}

export function parseLine(line: string): RunEvent[] {
  if (!line.trim()) return []
  let m: Obj
  try {
    m = JSON.parse(line)
  } catch {
    return []
  }
  if (!m || typeof m !== 'object') return []
  // Subagent (Task) traffic carries the id of the tool use that spawned it; it is not the agent's own reply.
  if ((m.type === 'assistant' || m.type === 'user' || m.type === 'stream_event') && (m.parent_tool_use_id ?? null) !== null) {
    return typeof m.parent_tool_use_id === 'string' ? subagentEvents(m, m.parent_tool_use_id) : []
  }
  switch (m.type) {
    case 'system':
      if (m.subtype === 'task_started' || m.subtype === 'task_progress' || m.subtype === 'task_updated') return taskEvents(m)
      if (m.subtype === 'status') {
        // A compaction ends with a status carrying its outcome; other statuses (requesting, ...) are not ours.
        if (m.status === 'compacting') return [{ kind: 'compacting', on: true }]
        return 'compact_result' in m ? [{ kind: 'compacting', on: false }] : []
      }
      if (m.subtype === 'compact_boundary') {
        const c = m.compact_metadata
        return count(c?.pre_tokens) && count(c?.post_tokens) ? [{ kind: 'compacted', pre: c.pre_tokens, post: c.post_tokens }] : []
      }
      if (m.subtype === 'permission_denied') {
        return typeof m.tool_use_id === 'string' ? [{ kind: 'denied', toolUseId: m.tool_use_id, reasonType: String(m.decision_reason_type ?? '') }] : []
      }
      if (m.subtype !== 'init' || typeof m.session_id !== 'string') return []
      return [
        typeof m.claude_code_version === 'string'
          ? { kind: 'init', sessionId: m.session_id, version: m.claude_code_version }
          : { kind: 'init', sessionId: m.session_id }
      ]
    case 'stream_event': {
      const e = m.event
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        return [{ kind: 'textDelta', text: e.delta.text }]
      }
      if (
        e?.type === 'content_block_delta' &&
        e.delta?.type === 'thinking_delta' &&
        typeof e.delta.thinking === 'string' &&
        e.delta.thinking !== ''
      ) {
        return [{ kind: 'thinkingDelta', text: e.delta.thinking }]
      }
      return []
    }
    case 'assistant': {
      const out: RunEvent[] = entryOf(m)
      const content = m.message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text') out.push({ kind: 'assistantText', text: b.text })
          else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim() !== '')
            out.push({ kind: 'thinking', text: b.thinking })
          else if (b?.type === 'tool_use')
            out.push({ kind: 'toolUse', id: b.id, name: b.name, input: b.input, ...(idOf(m.message.id) ? { message: m.message.id } : {}) })
        }
      }
      return m.message && typeof m.message === 'object' ? [...out, ...contextOf(m.message), ...spendOf(m.message)] : out
    }
    case 'user': {
      // Not an entry: a replay must never become the turn's tip, which cuts and end stamps read.
      if (m.isReplay === true) return typeof m.uuid === 'string' && m.uuid ? [{ kind: 'userReplay', uuid: m.uuid }] : []
      const out: RunEvent[] = entryOf(m)
      const content = m.message?.content
      if (!Array.isArray(content)) return out
      // A string tool_use_result is only the error text again, so just an object is kept.
      const tur = m.tool_use_result
      const detail = tur && typeof tur === 'object' && !Array.isArray(tur) ? { detail: tur } : {}
      for (const b of content) {
        if (b?.type === 'tool_result') {
          out.push({
            kind: 'toolResult',
            toolUseId: b.tool_use_id,
            content: normalizeContent(b.content),
            isError: b.is_error === true,
            ...detail
          })
        }
      }
      return out
    }
    case 'result':
      return [
        {
          kind: 'result',
          subtype: String(m.subtype ?? ''),
          isError: m.is_error === true,
          numTurns: typeof m.num_turns === 'number' ? m.num_turns : 0,
          sessionId: String(m.session_id ?? ''),
          denials: (Array.isArray(m.permission_denials) ? m.permission_denials : []).map((d: Obj | null) => ({
            toolUseId: d?.tool_use_id,
            toolName: d?.tool_name
          })),
          windows: windowsOf(m.modelUsage),
          uuid: typeof m.uuid === 'string' ? m.uuid : null,
          cost: parseRunCost(m)
        }
      ]
    case 'control_request': {
      const requestId = typeof m.request_id === 'string' && m.request_id ? m.request_id : null
      const r = m.request && typeof m.request === 'object' ? (m.request as Obj) : null
      const subtype = typeof r?.subtype === 'string' ? r.subtype : ''
      if (r && subtype === 'can_use_tool' && requestId && typeof r.tool_name === 'string' && r.tool_name) {
        return [
          {
            kind: 'permissionRequest',
            requestId,
            toolName: r.tool_name,
            input: r.input,
            description: typeof r.description === 'string' ? r.description : null,
            reason: typeof r.decision_reason === 'string' ? r.decision_reason : null,
            toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : null
          }
        ]
      }
      return [{ kind: 'controlUnknown', requestId, subtype }]
    }
    case 'rate_limit_event': {
      const w = m.rate_limit_info?.unifiedWindows
      const session = usageWindow(w?.five_hour)
      const weekly = usageWindow(w?.seven_day)
      const out: RunEvent[] = session || weekly ? [{ kind: 'rateLimit', session, weekly }] : []
      // A 429 turns the status to rejected; the reset is when a routine may try again.
      if (m.rate_limit_info?.status === 'rejected') {
        const at = m.rate_limit_info.resetsAt
        out.push({ kind: 'limited', resetsAt: typeof at === 'number' && Number.isFinite(at) ? at * 1000 : null })
      }
      return out
    }
    case 'control_cancel_request':
      return typeof m.request_id === 'string' && m.request_id ? [{ kind: 'permissionCancel', requestId: m.request_id }] : []
    default:
      return []
  }
}

/**
 * Whether the CLI refused a cut because what it would discard is not the turn the cut declared (`--resume-drops-turn`): a
 * queued message or a notification the session took in mid-turn that the caller had not seen. The refusal is deterministic, so
 * the same cut can never be retried; the caller starts a fresh session from the visible items instead (see
 * docs/architecture/edit-resend-fork.md). The result alone says only `error_during_execution`, so the reason is read here.
 */
export function isCutRefused(stderr: string): boolean {
  return stderr.includes('Resume rejected by --resume-drops-turn:')
}

export function isMissingSession(resumed: boolean, result: ResultEvent | null, stderr: string): boolean {
  return (
    resumed &&
    (stderr.includes('No conversation found with session ID') || (result?.subtype === 'error_during_execution' && result.numTurns === 0))
  )
}
