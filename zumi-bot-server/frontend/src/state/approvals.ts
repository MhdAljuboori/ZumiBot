import { prefixOfRule } from '@zumibot/shared/allowRules'
import { confirmOnly } from '@zumibot/shared/automations'
import { connectorById } from '@zumibot/shared/connectors'
import { PROCESS_START_TOOL } from '@zumibot/shared/processes'
import { connectorAction } from './approvalFields'
import { stepRuleFits, stepRuleOf, stepRuleRefused } from '@zumibot/shared/stepRules'
import {
  isGroup,
  type AgentRule,
  type ApprovalDecision,
  type ApprovalStatus,
  type ChatItem,
  type ChatMeta,
  type ChatPush,
  type QuestionAnswers
} from '@zumibot/shared/types'

export type ApprovalItem = Extract<ChatItem, { type: 'approval' }>

/** What the card sends back: a plain approval decision, a question card's answers (null = Skip), or a plan card's decision. */
export type ApprovalReply = ApprovalDecision | { answers: QuestionAnswers | null } | { plan: { approve: boolean; feedback?: string } }

/**
 * Which remembering choices a card offers: a confirm-only tool (a routine or workflow delete), or a card the server marked
 * `onceOnly` (an ACP call no rule may hold), is asked every time, so only Allow once and Deny. "Allow for this step" (a
 * workflow room's card only, `o.step`) is never offered for a question, a plan or a delete either, the tools a step rule
 * can't hold, nor for a call whose rule the workflow couldn't keep (a long command: `o.input` is the call, and the server
 * checks the 100-rule cap, which a card can't see). A connector write card (`o.connector`) offers Allow for this chat and
 * Allow always only while its service's Remember switch is on, and never a step (the server downgrades any answer the
 * switch does not allow, so this only hides buttons).
 */
export function approvalChoices(
  toolName: string,
  o?: { step?: boolean; input?: unknown; voice?: boolean; onceOnly?: boolean; connector?: { remember: boolean } }
): { chat: boolean; agent: boolean; step: boolean } {
  const every = !confirmOnly(toolName) && !o?.onceOnly && (!o?.connector || o.connector.remember)
  const step =
    every &&
    !o?.connector &&
    !!o?.step &&
    !stepRuleRefused(toolName) &&
    (o.input === undefined || stepRuleFits(stepRuleOf(toolName, o.input, ''), []))
  return { chat: every, agent: every, step }
}

/** A connector card's head: the service as the catalog names it and the tool in words (`Slack · Send message`); null for any other card. */
export function connectorSummary(item: ApprovalItem): string | null {
  if (!item.connector) return null
  // A card synced from a newer catalog may name a service this build lacks: show its id rather than crash the render.
  const name = (connectorById(item.connector.id) as { name: string } | undefined)?.name ?? item.connector.id
  return `${name} · ${connectorAction(item.connector.id, item.connector.tool)}`
}

/**
 * What a remembered answer covers, as the card's buttons say it, matching the server's keys (controlProtocol.ts): Bash and a
 * process start by exact command (a start also by folder), any other MCP tool by name. For this chat, a built-in tool needs the
 * identical input, which needs no line (null); for this agent or a step, any call of it.
 */
export function allowScope(toolName: string, by: 'chat' | 'agent'): string | null {
  if (toolName === 'Bash') return 'this exact command'
  if (toolName === PROCESS_START_TOOL) return 'this exact command in this folder'
  return toolName.startsWith('mcp__') || by === 'agent' ? `any call to ${toolName}` : null
}

/** A card shows "Allow for this step" only in a workflow's room copy, which is where a step's rules apply. */
export const stepChoiceFor = (chat: ChatMeta | undefined): boolean => !!chat?.workflow && isGroup(chat)

const LINES: Record<Exclude<ApprovalStatus, 'pending'>, string> = {
  'allowed-once': 'Allowed once',
  'allowed-chat': 'Allowed for this chat',
  'allowed-agent': 'Allowed always for this agent',
  'auto-allowed': 'Auto-allowed (earlier "Allow for this chat")',
  'auto-allowed-agent': 'Auto-allowed (remembered for this agent)',
  'auto-allowed-workflow': 'Allowed by the workflow',
  'allowed-step': 'Allowed for this workflow step',
  denied: 'Denied',
  unanswered: 'Not answered',
  answered: 'Answered',
  skipped: 'Skipped',
  approved: 'Approved',
  'sent-back': 'Sent back'
}

export function approvalLine(status: ApprovalStatus): string | null {
  return status === 'pending' ? null : LINES[status]
}

export function isActionable(item: ApprovalItem, chatRunning: boolean): boolean {
  return item.status === 'pending' && chatRunning
}

export function applyApprovalCount(prev: Record<string, number>, p: Extract<ChatPush, { kind: 'approvals' }>): Record<string, number> {
  const { [p.chatId]: _old, ...rest } = prev
  return p.pending > 0 ? { ...rest, [p.chatId]: p.pending } : rest
}

/**
 * The server's counts (`chats:pending`) over what the page holds. One socket carries the pushes and the answer in order,
 * so a push that came after the request was sent is at least as new as the answer: its chat keeps the pushed count, even
 * a 0 (already gone from `prev`). Every other chat takes the answer's, which is newer than anything held from before.
 */
export function mergeApprovalCounts(
  prev: Record<string, number>,
  counts: Record<string, number>,
  pushedSince: ReadonlySet<string>
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, n] of Object.entries(prev)) if (pushedSince.has(id)) out[id] = n
  for (const [id, n] of Object.entries(counts)) if (!pushedSince.has(id) && Number.isFinite(n) && n > 0) out[id] = n
  return out
}

export function agentHasPending(
  chats: ReadonlyArray<{ id: string; agentName: string }>,
  agentName: string,
  pendingByChat: Record<string, number>
): boolean {
  return chats.some((c) => c.agentName === agentName && (pendingByChat[c.id] ?? 0) > 0)
}

export function ruleLabel(rule: AgentRule): string {
  if (rule.toolName === PROCESS_START_TOOL && rule.command !== null) {
    // The key is [tool, command, folder as written] (controlProtocol.ts); the folder is read back from it.
    let cwd = ''
    try {
      const k: unknown = JSON.parse(rule.key)
      if (Array.isArray(k) && typeof k[2] === 'string') cwd = k[2]
    } catch {
      /* an odd key: the command alone */
    }
    return `Start process: ${rule.command}${cwd ? ` (in ${cwd})` : ''}`
  }
  // A rule given to the CLI (Allow on a refused call): its key never equals a request's, so it is not an "any Bash" rule.
  if (rule.cli !== undefined) {
    const prefix = prefixOfRule(rule.cli)
    return `Bash: ${prefix !== null ? `commands starting with ${prefix}` : rule.cli}`
  }
  return rule.toolName === 'Bash' && rule.command !== null ? `Bash: ${rule.command}` : rule.toolName
}
