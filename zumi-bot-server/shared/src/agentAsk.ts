import type { AskedFrom, ChatMeta } from './types'

// The MCP server that carries the `ask` tool. Its name is fixed so the tool is always `mcp__zumibot_agents__ask`.
export const ASK_SERVER = 'zumibot_agents'
export const ASK_TOOL = `mcp__${ASK_SERVER}__ask`
// The read-only variant: it asks another agent a question without letting it change anything.
export const ASK_SIDE_NAME = 'side_question'
export const ASK_SIDE_TOOL = `mcp__${ASK_SERVER}__${ASK_SIDE_NAME}`
export const ASK_SIDE_QUESTION_MAX = 4000
export const ASK_MESSAGE_MAX = 20_000
export const ASK_REPLY_MAX = 50_000
// A chain of asks stops here, so two agents cannot keep each other busy.
export const ASK_MAX_HOPS = 3
export const ASK_PER_TURN = 10
export const ASK_PARALLEL = 3

/** Normalises what the user or an agent typed as an agent handle: no spaces, no leading @, lower case. */
export function askHandle(raw: string): string {
  const t = raw.trim()
  return (t.startsWith('@') ? t.slice(1) : t).toLowerCase()
}

/** The agent a handle names, matched case-insensitively by name; null when there is none. */
export function findAskTarget<T extends { name: string }>(agents: readonly T[], raw: string): T | null {
  const handle = askHandle(raw)
  return agents.find((a) => a.name.toLowerCase() === handle) ?? null
}

/** The sidebar title of an asked chat. */
export function askedTitle(by: string, fromTitle: string): string {
  return `@${by} · ${fromTitle || 'New chat'}`
}

export function isAsked(c: Pick<ChatMeta, 'asked'>): c is ChatMeta & { asked: AskedFrom } {
  return c.asked !== undefined
}

/** True for either tool of the agents bridge: `ask` and `side_question`. */
export function isAskTool(name: string): boolean {
  return name === ASK_TOOL || name === ASK_SIDE_TOOL
}

/** An agent's `tools:` list needs both ask tools by name (with --agent a list limits the agent to what it names); no list (null) already means every tool. */
export function withAskTool(tools: string[] | null): string[] | null {
  if (tools === null) return null
  return [...tools.filter((t) => !isAskTool(t)), ASK_TOOL, ASK_SIDE_TOOL]
}
