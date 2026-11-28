import type { ChatMeta } from './types'

/**
 * Hive recall (docs/architecture/recall.md): an agent's read-only search over past chats. `agent` = its own single chats and the
 * rooms it is a member of; `folder` = every chat of the same folder, whatever agent ran it. Absent = off.
 */
export type RecallScope = 'agent' | 'folder'

/** The MCP server that carries the recall tools; its tools are `mcp__zumibot_recall__search` and `__read`. */
export const RECALL_SERVER = 'zumibot_recall'
export const RECALL_TOOL_PREFIX = `mcp__${RECALL_SERVER}__`
/** The recall tools by name, for an agent's `tools:` list. */
export const RECALL_TOOLS = ['search', 'read'].map((t) => `${RECALL_TOOL_PREFIX}${t}`)

/** An agent's `tools:` list needs the recall tools by name (with --agent a list limits the agent to it); no list means every tool. */
export function withRecallTools(tools: string[] | null): string[] | null {
  if (tools === null) return null
  return [...tools.filter((t) => !RECALL_TOOLS.includes(t)), ...RECALL_TOOLS]
}

/** Hits per search call: an agent reads them all, so fewer than the sidebar's page. */
export const RECALL_PAGE = 10

/** Strict, like `computerUse`: only the two exact words turn recall on. */
export function parseRecall(v: unknown): RecallScope | null {
  return v === 'agent' || v === 'folder' ? v : null
}

/** The folder a chat belongs to: the one the user picked for a worktree chat, so its chats meet the folder's other chats. */
export const recallFolderOf = (c: Pick<ChatMeta, 'cwd' | 'worktree'>): string => c.worktree?.folder ?? c.cwd

/** Whether `c` is in an agent's recall scope when it calls from `from`. The calling chat is never in it: its history is the agent's already. */
export function inRecallScope(scope: RecallScope, agent: string, from: ChatMeta, c: ChatMeta): boolean {
  if (c.id === from.id) return false
  if (scope === 'folder') return recallFolderOf(c) === recallFolderOf(from)
  return c.group ? c.group.members.includes(agent) : c.agentName === agent
}
