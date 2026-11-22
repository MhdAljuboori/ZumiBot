import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { ChatMode, Effort } from '@zumibot/shared/chatRun'
import { GROUP_MIN_MEMBERS, type AgentRename, AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { sidebarFolder } from '@zumibot/shared/worktree'
import { isScratchFolder } from '@zumibot/shared/scratch'
import type { NewChatFolder } from './sidebarTree'

/** What the no-chat-open screen holds until it is sent: nothing is picked up front. */
export interface NewChatDraft {
  agentName: string | null
  cwd: string | null
  text: string
  mode: 'single' | 'group'
  members: string[] // group mode: the agents picked so far
  role: string // group mode: the group's role text; '' = none
  model?: string // single mode: a model picked here by hand; absent = the agent's own (Default)
  permissionMode?: ChatMode // single mode: the new chat's own mode; absent = the server's (Auto)
  effort?: Effort // single mode: the new chat's own effort; absent = Medium
}

export const emptyNewChatDraft: NewChatDraft = { agentName: null, cwd: null, text: '', mode: 'single', members: [], role: '' }

/** Folders of past chats, most recently used first; built-in agents run in a fixed folder, so theirs are left out. */
export function recentFolders(agents: readonly AgentSummary[], chats: readonly ChatMeta[], limit = 8): string[] {
  const builtIn = new Set(agents.filter((a) => a.builtIn).map((a) => a.name))
  const seen = new Set<string>()
  for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    // A scratch chat's folder is its own; offering it would put a new chat in someone else's scratch.
    if (builtIn.has(c.agentName) || isScratchFolder(c.cwd)) continue
    seen.add(sidebarFolder(c))
    if (seen.size === limit) break
  }
  return [...seen]
}

/** Where Send starts the chat, or null while something is missing. */
export function newChatTarget(draft: NewChatDraft, agents: readonly AgentSummary[]): { agentName: string; folder: NewChatFolder } | null {
  const agent = agents.find((a) => a.name === draft.agentName && a.error === null)
  if (!agent) return null
  // Main answers a built-in agent's "last folder" with its fixed one.
  if (agent.builtIn) return { agentName: agent.name, folder: 'last' }
  // No folder picked: the chat runs in a scratch folder of its own.
  return { agentName: agent.name, folder: draft.cwd === null ? 'none' : { cwd: draft.cwd } }
}

/** Shown for a typed `/run-workflow` on the new-chat screen: a workflow starts from a chat, and no chat is made for it. */
export const NEW_CHAT_RUN_WORKFLOW_NOTICE = 'Open a chat first'

/** The folder a path sits in, shown next to its name in the folder menu. */
export const parentPath = (cwd: string): string => cwd.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

export function renameDraftAgent(draft: NewChatDraft, renamed: readonly AgentRename[]): NewChatDraft {
  const rn = (n: string): string => renamed.find((r) => r.from === n)?.to ?? n
  const agentName = draft.agentName === null ? null : rn(draft.agentName)
  const members = draft.members.map(rn)
  const same = agentName === draft.agentName && members.every((m, i) => m === draft.members[i])
  return same ? draft : { ...draft, agentName, members }
}

/** Where Send starts the group, or null while something is missing. */
export function newGroupTarget(
  draft: NewChatDraft,
  agents: readonly AgentSummary[]
): { members: string[]; cwd: string | null; role: string } | null {
  if (draft.mode !== 'group') return null
  const members = [...new Set(draft.members)]
  if (members.length < GROUP_MIN_MEMBERS) return null
  if (!members.every((m) => m !== ZUMI_BOT_NAME && agents.some((a) => a.name === m))) return null
  return { members, cwd: draft.cwd, role: draft.role }
}

/** Why Send is disabled in group mode, or null when the group can start. */
export function groupBlockedReason(draft: NewChatDraft, agents: readonly AgentSummary[]): string | null {
  if (newGroupTarget(draft, agents) !== null) return null
  return 'Pick at least 2 agents first'
}
