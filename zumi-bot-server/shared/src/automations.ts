// Names and fixed texts of Zumi Bot's routine and workflow tools (the `zumibot_automations` MCP server).
export const AUTOMATIONS_SERVER = 'zumibot_automations'
export const AUTOMATION_PREFIX = `mcp__${AUTOMATIONS_SERVER}__`

export const AUTOMATION_TOOLS = [
  'routines_list',
  'routine_get',
  'routine_save',
  'routine_delete',
  'workflows_list',
  'workflow_get',
  'workflow_save',
  'workflow_delete',
  'chat_read'
] as const
export type AutomationToolName = (typeof AUTOMATION_TOOLS)[number]

export const automationTool = (fullName: string): boolean => fullName.startsWith(AUTOMATION_PREFIX)

// Deletes always ask the user, even in auto mode and with a remembered rule.
export const CONFIRM_ONLY_TOOLS: readonly string[] = [`${AUTOMATION_PREFIX}routine_delete`, `${AUTOMATION_PREFIX}workflow_delete`]
export const confirmOnly = (toolName: string): boolean => CONFIRM_ONLY_TOOLS.includes(toolName)

// The text of a delete's approval card: the exact target, from the call's own input.
export function automationSummary(toolName: string, input: unknown): string | null {
  const kind =
    toolName === `${AUTOMATION_PREFIX}routine_delete` ? 'routine' : toolName === `${AUTOMATION_PREFIX}workflow_delete` ? 'workflow' : null
  if (kind === null || typeof input !== 'object' || input === null) return null
  const name = (input as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? `Delete ${kind} “${name}”` : null
}

export const WRITE_REFUSED = 'Routines and workflows can only be changed from a message the user sends.'
export const STALE_REFUSED = 'It changed since you read it: read it again.'
export const CHAT_READ_MAX = 150_000
