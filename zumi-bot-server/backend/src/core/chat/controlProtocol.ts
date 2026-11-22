import type { AgentRule, ApprovalDecision } from '@zumibot/shared/types'
import type { RunMode } from '@zumibot/shared/chatRun'

// Wire format of the CLI's stdio permission protocol (control_request / control_response lines).
export const DENIED_BY_USER = 'Denied by the user'
export const UNKNOWN_REQUEST_ERROR = 'ZumiBot does not handle this request'
export const SKIPPED_BY_USER = 'The user chose not to answer these questions.'

// The deny message of "Keep planning": the CLI keeps the agent in plan mode, so it revises and calls ExitPlanMode again.
export function planSentBack(feedback: string | null): string {
  return feedback === null
    ? 'The user did not approve the plan yet. Stay in plan mode, and end your reply so the user can say what to change.'
    : `The user did not approve the plan yet. Stay in plan mode, revise the plan based on their feedback, then call ExitPlanMode again.\n\nFeedback: ${feedback}`
}

export type Decision = ApprovalDecision

export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
export type ContentBlock = { type: 'text'; text: string } | ImageBlock
export type UserContent = string | ContentBlock[]

/**
 * One JSON line; JSON.stringify escapes every newline and U+2028, so the line stays a single line. `uuid` is the id the CLI
 * then writes the prompt's own session entry under, which a later cut declares as the turn it discards (`--resume-drops-turn`).
 */
export function encodeUserMessage(content: UserContent, uuid?: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, ...(uuid ? { uuid } : {}) }) + '\n'
}

/** A permission change the CLI applies with an allow, such as the mode a run goes on in once its plan is approved. */
export type PermissionUpdate = { type: 'setMode'; mode: RunMode; destination: 'session' }

export function allowResponse(requestId: string, input: unknown, updatedPermissions?: PermissionUpdate[]): object {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: 'allow', updatedInput: input, ...(updatedPermissions ? { updatedPermissions } : {}) }
    }
  }
}

export function denyResponse(requestId: string, message: string): object {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } } }
}

export function errorResponse(requestId: string, error: string): object {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }
}

function stableJson(v: unknown): string {
  return (
    JSON.stringify(v, (_k, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      }
      return val
    }) ?? 'undefined'
  )
}

const PROCESS_START = 'mcp__zumibot_processes__start'
// A process start runs a command as Bash does, outside its sandbox: kept per exact command and folder as written, never by name
// alone (one "Allow always" would run any command), and never equal to a Bash key.
function startKey(input: unknown): string {
  const i = input as { command?: unknown; cwd?: unknown } | null
  return JSON.stringify([
    PROCESS_START,
    typeof i?.command === 'string' ? i.command : stableJson(input),
    typeof i?.cwd === 'string' ? i.cwd : ''
  ])
}

// Match key for "Allow for this chat": Bash and a process start by exact command, MCP tools by name, the rest by identical input.
export function allowKey(toolName: string, input: unknown): string {
  if (toolName === PROCESS_START) return startKey(input)
  if (toolName.startsWith('mcp__')) return JSON.stringify([toolName])
  if (toolName === 'Bash') {
    const cmd = (input as { command?: unknown } | null)?.command
    return JSON.stringify([toolName, typeof cmd === 'string' ? cmd : stableJson(input)])
  }
  return JSON.stringify([toolName, stableJson(input)])
}

function bashCommand(input: unknown): string | null {
  const cmd = (input as { command?: unknown } | null)?.command
  return typeof cmd === 'string' ? cmd : null
}

// Match key for "Allow always for this agent": any call of the tool, except Bash and a process start, which stay per exact command.
export function agentAllowKey(toolName: string, input: unknown): string {
  if (toolName === PROCESS_START) return startKey(input)
  if (toolName === 'Bash') {
    const key = [toolName, bashCommand(input) ?? stableJson(input)]
    // A command allowed inside the sandbox is not allowed outside it, nor the other way round.
    if ((input as { dangerouslyDisableSandbox?: unknown } | null)?.dangerouslyDisableSandbox === true) key.push('unsandboxed')
    return JSON.stringify(key)
  }
  return JSON.stringify([toolName])
}

export function ruleOf(toolName: string, input: unknown): AgentRule {
  return {
    key: agentAllowKey(toolName, input),
    toolName,
    command: toolName === 'Bash' || toolName === PROCESS_START ? bashCommand(input) : null
  }
}

export function parseDecision(v: unknown): Decision {
  if (v === 'allow-once' || v === 'allow-chat' || v === 'allow-agent' || v === 'allow-step' || v === 'deny') return v
  throw new TypeError('decision must be allow-once, allow-chat, allow-agent, allow-step or deny')
}
