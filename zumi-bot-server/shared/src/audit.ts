// The audit log: one record per tool call any agent makes, with who decided it and how (docs/architecture/governance.md).
// Records are written by the server only; no agent tool reads or clears them.

import { DISPATCH_INPUT_MAX } from './dispatch'
import type { Engine } from './engine'
import type { IsolationLevel } from './isolation'

export const AUDIT_INPUT_MAX = DISPATCH_INPUT_MAX // a tool input, as JSON (dispatch's own cap)
export const AUDIT_ERROR_MAX = 2_000 // an error or denial text
export const AUDIT_ANSWER_MAX = 20_000 // a question card's answers or a plan's feedback, as JSON
export const AUDIT_FILE_MAX = 16 * 1024 * 1024 // one file is closed past this many bytes
export const AUDIT_CAPS = [128 * 1024 * 1024, 512 * 1024 * 1024, 2048 * 1024 * 1024] as const
export const AUDIT_CAP_DEFAULT = 512 * 1024 * 1024
export const AUDIT_PAGE_MAX = 200
export const AUDIT_SUMMARY_MAX = 200

/** Every engine: an ACP agent's calls go through the same approvals; a remote (AG-UI) agent's rows are `ranRemotely`. */
export type AuditEngine = Engine
export type AuditRunKind = 'chat' | 'room' | 'side' | 'routine' | 'workflow' | 'asked'
export type AuditOutcome = 'ok' | 'error' | 'denied' | 'interrupted' | 'noResult'
export type AuditHook = 'vaultGuard' | 'auditGuard' | 'pause' | 'spendCap' | 'sideGuard' | 'other'

export type AuditDecision =
  | { kind: 'allowedByMode' }
  | { kind: 'allowedByChatRule' }
  | { kind: 'allowedByAgentRule'; rule: string }
  | { kind: 'allowedByWorkflowRule' }
  | { kind: 'allowedByAllowlist'; host: string }
  | { kind: 'allowedByZumiBot'; why: 'todos' | 'vault' | 'automation' | 'ask' | 'sideAsk' | 'connectorRead' | 'recall' }
  | { kind: 'approvedByUser'; scope: 'once' | 'chat' | 'agent' | 'step' }
  | { kind: 'deniedByUser' }
  | { kind: 'deniedByRule' }
  | { kind: 'deniedBySandbox'; target: string | null }
  | { kind: 'deniedByHook'; hook: AuditHook }
  | {
      kind: 'deniedByZumiBot'
      why: 'writeRefused' | 'questionsDenied' | 'sideGuard' | 'unknownRequest' | 'connectorOff' | 'connectorUnattended' | 'remoteTools'
    }
  | { kind: 'unanswered' }
  // A remote (AG-UI) agent's tool, run by its own server: no approval reached ZumiBot, which neither ran nor could stop it.
  | { kind: 'ranRemotely' }
  // A shell block the user ran with its Run button: no agent call and no card, the click itself was the approval.
  | { kind: 'runByUser' }

export type AuditDecisionKind = AuditDecision['kind']
export const AUDIT_DECISION_KINDS: readonly AuditDecisionKind[] = [
  'allowedByMode',
  'allowedByChatRule',
  'allowedByAgentRule',
  'allowedByWorkflowRule',
  'allowedByAllowlist',
  'allowedByZumiBot',
  'approvedByUser',
  'deniedByUser',
  'deniedByRule',
  'deniedBySandbox',
  'deniedByHook',
  'deniedByZumiBot',
  'unanswered',
  'ranRemotely',
  'runByUser'
]
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['ok', 'error', 'denied', 'interrupted', 'noResult']

export interface AuditLink {
  routine?: { id: string }
  workflow?: { id: string; runId: string; stepId: string }
}

export interface AuditRecord extends AuditLink {
  v: 1
  id: string
  ts: number
  durationMs: number | null
  machine: string
  chatId: string
  itemId: string | null // the chat item "Show in chat" lands on: the tool row, or a subagent's Agent row
  turnId: string | null
  agent: string
  subagent: string | null
  parentToolUseId: string | null
  engine: AuditEngine
  runKind: AuditRunKind
  mode: string
  isolation: IsolationLevel
  tool: string
  input: unknown
  inputCut: number | null // the input's JSON length before it was cut
  decision: AuditDecision
  answer?: unknown
  outcome: AuditOutcome
  error: string | null
  prev: string // sha256 of the previous line in the same file
}

/** One list row: the record without its input, and a one-line summary of it. */
export interface AuditRow {
  id: string
  at: string // where the record sits in the log (`<file>:<line>`), for audit:get
  ts: number
  durationMs: number | null
  chatId: string
  agent: string
  subagent: string | null
  engine: AuditEngine
  runKind: AuditRunKind
  tool: string
  summary: string
  decision: AuditDecision
  outcome: AuditOutcome
}

export interface AuditFilter {
  agent?: string
  chatId?: string
  tool?: string
  decision?: AuditDecisionKind
  outcome?: AuditOutcome
  from?: number
  to?: number
  q?: string // case-insensitive substring of the tool name or the input JSON
}

export interface AuditPage {
  rows: AuditRow[]
  next: string | null
}
export interface AuditFacets {
  agents: string[]
  tools: string[]
  chats: string[]
}
export interface AuditStatus {
  machine: string
  bytes: number
  cap: number
  failures: number
  records: number
}
export type AuditVerify = { ok: true; files: number } | { ok: false; file: string; line: number }

const FILTER_STR_MAX = 300

const optStr = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || v.length > FILTER_STR_MAX)
    throw new TypeError(`${name} must be a string of at most ${FILTER_STR_MAX} characters`)
  return v
}
const optTime = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`${name} must be a time in ms`)
  return v
}

/** Checks an untyped filter field by field; unknown fields are dropped. */
export function parseAuditFilter(v: unknown): AuditFilter {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new TypeError('filter must be an object')
  const o = v as Record<string, unknown>
  const out: AuditFilter = {}
  const agent = optStr(o.agent, 'agent')
  if (agent !== undefined) out.agent = agent
  const chatId = optStr(o.chatId, 'chatId')
  if (chatId !== undefined) out.chatId = chatId
  const tool = optStr(o.tool, 'tool')
  if (tool !== undefined) out.tool = tool
  const q = optStr(o.q, 'q')
  if (q !== undefined) out.q = q
  if (o.decision !== undefined && o.decision !== null && o.decision !== '') {
    if (!AUDIT_DECISION_KINDS.includes(o.decision as AuditDecisionKind)) throw new TypeError('decision is not a known kind')
    out.decision = o.decision as AuditDecisionKind
  }
  if (o.outcome !== undefined && o.outcome !== null && o.outcome !== '') {
    if (!AUDIT_OUTCOMES.includes(o.outcome as AuditOutcome)) throw new TypeError('outcome is not a known outcome')
    out.outcome = o.outcome as AuditOutcome
  }
  const from = optTime(o.from, 'from')
  if (from !== undefined) out.from = from
  const to = optTime(o.to, 'to')
  if (to !== undefined) out.to = to
  return out
}

/** Whether a record passes a filter. `q` is matched against the tool and the stored (redacted) input. */
export function matchesAudit(r: AuditRecord, f: AuditFilter): boolean {
  if (f.agent !== undefined && r.agent !== f.agent) return false
  if (f.chatId !== undefined && r.chatId !== f.chatId) return false
  if (f.tool !== undefined && r.tool !== f.tool) return false
  if (f.decision !== undefined && r.decision.kind !== f.decision) return false
  if (f.outcome !== undefined && r.outcome !== f.outcome) return false
  if (f.from !== undefined && r.ts < f.from) return false
  if (f.to !== undefined && r.ts > f.to) return false
  if (f.q !== undefined) {
    const q = f.q.toLowerCase()
    if (!r.tool.toLowerCase().includes(q) && !(JSON.stringify(r.input ?? null) ?? '').toLowerCase().includes(q)) return false
  }
  return true
}

/** One line for a list row: the command, path, url or pattern a call is about, else its input JSON. */
export function auditSummary(tool: string, input: unknown): string {
  const o = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  const pick = o
    ? ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description']
        .map((k) => o[k])
        .find((x) => typeof x === 'string' && x !== '')
    : undefined
  const text = typeof pick === 'string' ? pick : tool === '' ? '' : (JSON.stringify(input ?? null) ?? '')
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > AUDIT_SUMMARY_MAX ? `${line.slice(0, AUDIT_SUMMARY_MAX - 1)}…` : line
}

export function auditRowOf(r: AuditRecord, at: string): AuditRow {
  return {
    id: r.id,
    at,
    ts: r.ts,
    durationMs: r.durationMs,
    chatId: r.chatId,
    agent: r.agent,
    subagent: r.subagent,
    engine: r.engine,
    runKind: r.runKind,
    tool: r.tool,
    summary: auditSummary(r.tool, r.input),
    decision: r.decision,
    outcome: r.outcome
  }
}

const SCOPE_WORDS = { once: 'once', chat: 'for this chat', agent: 'always for this agent', step: 'for this workflow step' } as const
const HOOK_WORDS: Record<AuditHook, string> = {
  vaultGuard: 'the vault guard',
  auditGuard: 'the audit guard',
  pause: 'the pause hook',
  spendCap: 'the spend cap',
  sideGuard: 'the side-question guard',
  other: 'a hook'
}

/** The decision in words, for the list chip and the record view. */
export function decisionLabel(d: AuditDecision): string {
  switch (d.kind) {
    case 'allowedByMode':
      return 'Allowed by mode'
    case 'allowedByChatRule':
      return 'Allowed for this chat'
    case 'allowedByAgentRule':
      return 'Allowed by agent rule'
    case 'allowedByWorkflowRule':
      return 'Allowed by workflow step rule'
    case 'allowedByAllowlist':
      return `Allowed: ${d.host} is on the network list`
    case 'allowedByZumiBot':
      return d.why === 'sideAsk'
        ? 'Allowed (side ask)'
        : d.why === 'connectorRead'
          ? 'Allowed: connector read'
          : `Allowed by ZumiBot (${d.why})`
    case 'approvedByUser':
      return `Approved by you ${SCOPE_WORDS[d.scope]}`
    case 'deniedByUser':
      return 'Denied by you'
    case 'deniedByRule':
      return 'Denied by a rule'
    case 'deniedBySandbox':
      return d.target === null ? 'Blocked by the sandbox' : `Blocked by the sandbox: ${d.target}`
    case 'deniedByHook':
      return `Denied by ${HOOK_WORDS[d.hook]}`
    case 'deniedByZumiBot':
      return d.why === 'connectorOff'
        ? 'Refused: connector off'
        : d.why === 'connectorUnattended'
          ? 'Refused: connector change in an unattended run'
          : d.why === 'writeRefused'
            ? 'Refused: not your message'
            : d.why === 'questionsDenied'
              ? 'Question sent back'
              : d.why === 'sideGuard'
                ? 'Denied: side answer'
                : d.why === 'remoteTools'
                  ? 'Refused: ZumiBot runs no tools for a remote agent'
                  : 'Refused: unknown request'
    case 'unanswered':
      return 'Unanswered'
    case 'ranRemotely':
      return 'Ran on the remote server'
    case 'runByUser':
      return 'Run by you'
  }
}

export const isDenied = (d: AuditDecision): boolean => d.kind.startsWith('denied') || d.kind === 'unanswered'
