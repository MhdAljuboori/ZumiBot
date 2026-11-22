import {
  AUDIT_DECISION_KINDS,
  type AuditDecision,
  type AuditDecisionKind,
  type AuditFilter,
  type AuditOutcome,
  type AuditRecord
} from '@zumibot/shared/audit'

// Settings › Audit log's pure rules: the filter the controls make, and the words rows and the record view show.

export type AuditRange = 'all' | 'hour' | 'day' | 'week' | 'custom'

export interface AuditControls {
  agent: string
  chatId: string
  tool: string
  decision: AuditDecisionKind | ''
  outcome: AuditOutcome | ''
  range: AuditRange
  /** Custom range bounds as the date inputs give them (YYYY-MM-DD), local time; '' = open. */
  fromDay: string
  toDay: string
  q: string
}

export const EMPTY_CONTROLS: AuditControls = {
  agent: '',
  chatId: '',
  tool: '',
  decision: '',
  outcome: '',
  range: 'all',
  fromDay: '',
  toDay: '',
  q: ''
}

const HOUR = 3_600_000
const RANGE_MS: Record<'hour' | 'day' | 'week', number> = { hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR }

/** A YYYY-MM-DD day's start (or, with `end`, its last millisecond) in local time; null when it does not parse. */
export function dayBound(day: string, end: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return null
  return end ? d.getTime() + 24 * HOUR - 1 : d.getTime()
}

/** The filter the server takes: empty controls are left out, the search is trimmed. */
export function filterOf(c: AuditControls, now: number): AuditFilter {
  const f: AuditFilter = {}
  if (c.agent) f.agent = c.agent
  if (c.chatId) f.chatId = c.chatId
  if (c.tool) f.tool = c.tool
  if (c.decision) f.decision = c.decision
  if (c.outcome) f.outcome = c.outcome
  const q = c.q.trim()
  if (q) f.q = q.slice(0, 300)
  if (c.range === 'hour' || c.range === 'day' || c.range === 'week') f.from = now - RANGE_MS[c.range]
  if (c.range === 'custom') {
    const from = dayBound(c.fromDay, false)
    const to = dayBound(c.toDay, true)
    if (from !== null) f.from = from
    if (to !== null) f.to = to
  }
  return f
}

export const DECISION_KIND_LABELS: Record<AuditDecisionKind, string> = {
  allowedByMode: 'Allowed by mode',
  allowedByChatRule: 'Allowed for the chat',
  allowedByAgentRule: 'Allowed by agent rule',
  allowedByWorkflowRule: 'Allowed by workflow rule',
  allowedByAllowlist: 'Allowed by network list',
  allowedByZumiBot: 'Allowed by ZumiBot',
  approvedByUser: 'Approved by you',
  deniedByUser: 'Denied by you',
  deniedByRule: 'Denied by a rule',
  deniedBySandbox: 'Blocked by the sandbox',
  deniedByHook: 'Denied by a hook',
  deniedByZumiBot: 'Refused by ZumiBot',
  unanswered: 'Unanswered',
  ranRemotely: 'Ran on a remote server'
}

export const DECISION_OPTIONS: { value: AuditDecisionKind; label: string }[] = AUDIT_DECISION_KINDS.map((k) => ({
  value: k,
  label: DECISION_KIND_LABELS[k]
}))

export const OUTCOME_LABELS: Record<AuditOutcome, string> = {
  ok: 'Ran',
  error: 'Failed',
  denied: 'Did not run',
  interrupted: 'Interrupted',
  noResult: 'No result'
}

/** The chip's colour: green for allowed, red for denied, muted for the rest. */
export function decisionTone(d: AuditDecision): 'ok' | 'bad' | 'muted' {
  if (d.kind.startsWith('allowed') || d.kind === 'approvedByUser') return 'ok'
  if (d.kind.startsWith('denied')) return 'bad'
  return 'muted'
}

/** One sentence on why the call ran or did not, for the record view. */
export function decisionWhy(d: AuditDecision, mode: string): string {
  switch (d.kind) {
    case 'allowedByMode':
      return `No approval reached ZumiBot: the CLI allowed it under the run's mode (${mode}), its own allow rules, or the auto-mode classifier.`
    case 'allowedByChatRule':
      return 'You chose "Allow for this chat" earlier for this call.'
    case 'allowedByAgentRule':
      return `A rule you saved with "Allow always for this agent" matched: ${d.rule}.`
    case 'allowedByWorkflowRule':
      return 'A rule of this workflow step allowed it.'
    case 'allowedByAllowlist':
      return `The agent is sandboxed and ${d.host} is on its network list, so the fetch ran without a card (auto mode).`
    case 'allowedByZumiBot':
      return d.why === 'sideAsk'
        ? "A side answer's one allowed tool (asking another agent)."
        : d.why === 'connectorRead'
          ? 'A claude.ai connector read, which runs without a card while the connector is on for the agent.'
          : `ZumiBot's own ${d.why} tool, which it answers without a card.`
    case 'approvedByUser':
      return d.scope === 'once'
        ? 'You approved it on its card.'
        : `You approved it on its card, ${d.scope === 'chat' ? 'for the rest of this chat' : d.scope === 'agent' ? 'always for this agent' : 'for this workflow step'}.`
    case 'deniedByUser':
      return 'You denied it on its card (or skipped the question, or sent the plan back).'
    case 'deniedByRule':
      return "A deny rule refused it before any card (your settings, the agent's tools, or the vault guard)."
    case 'deniedBySandbox':
      return `The agent is sandboxed and the sandbox refused it${d.target === null ? '' : ` (${d.target})`}: a folder outside its own, or a host off its network list.`
    case 'deniedByHook':
      return `A PreToolUse hook blocked it (${d.hook === 'other' ? 'a hook of yours' : d.hook}).`
    case 'deniedByZumiBot':
      return d.why === 'connectorOff'
        ? 'That claude.ai connector is off for this agent on the Connectors page.'
        : d.why === 'connectorUnattended'
          ? 'A claude.ai connector change in a run started by a routine or workflow, which may only read.'
          : d.why === 'writeRefused'
            ? 'Refused: a change you did not ask for in this turn.'
            : d.why === 'questionsDenied'
              ? 'The question went back to whoever asked.'
              : d.why === 'sideGuard'
                ? 'Side answers run no tools.'
                : d.why === 'remoteTools'
                  ? 'The remote agent asked ZumiBot to run it, and ZumiBot runs no tools for a remote agent.'
                  : 'ZumiBot does not handle this request.'
    case 'unanswered':
      return 'Its card was never answered (the run stopped first).'
    case 'ranRemotely':
      return "The remote (AG-UI) agent's own server ran it: no approval reached ZumiBot, which could neither see it before it ran nor stop it."
  }
}

export function durationText(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.round(ms / 60_000)} min`
}

export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** "Agent" or "Agent › subagent". */
export const whoText = (agent: string, subagent: string | null): string => (subagent ? `${agent} › ${subagent}` : agent)

/** The record as the view shows it: pretty JSON with keys in the stored order. */
export const recordJson = (r: AuditRecord): string => JSON.stringify(r, null, 2)
