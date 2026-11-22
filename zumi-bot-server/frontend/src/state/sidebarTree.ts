import { displayName } from '@zumibot/shared/frontmatter'
import { isArchived } from '@zumibot/shared/archive'
import { sidebarFolder } from '@zumibot/shared/worktree'
import { NO_FOLDER_LABEL, isScratchFolder, isScratchRoot } from '@zumibot/shared/scratch'
import { isGroup, type AgentRename, type AgentSummary, type ChatMeta, type GroupInfo } from '@zumibot/shared/types'
import { friendlyText } from './agentNames'

/** Where a new chat runs: the agent's last folder (picker if none), always the picker, a given folder, or none (a scratch folder). */
export type NewChatFolder = 'last' | 'pick' | 'none' | { cwd: string }

export interface FolderGroup {
  cwd: string
  name: string
  chats: ChatMeta[] // newest first
}

export interface AgentNode {
  agent: AgentSummary
  folders: FolderGroup[]
  /** A search matched some of this agent's chats, so it shows expanded whatever the user's toggle says. */
  forceOpen: boolean
}

export const folderName = (cwd: string): string =>
  isScratchRoot(cwd) || isScratchFolder(cwd) ? NO_FOLDER_LABEL : (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd)

/** A chat's title as the UI shows it: agent handles in it read as display names. */
export const chatTitle = (chat: Pick<ChatMeta, 'title'>, agents: readonly { name: string }[]): string =>
  friendlyText(chat.title, agents) || 'New chat'

/** Whether a search finds the title: as shown, or by the handles it holds. */
export const titleMatches = (chat: Pick<ChatMeta, 'title'>, agents: readonly { name: string }[], q: string): boolean =>
  chatTitle(chat, agents).toLowerCase().includes(q) || chat.title.toLowerCase().includes(q)

export function groupByFolder(chats: readonly ChatMeta[]): FolderGroup[] {
  const byCwd = new Map<string, ChatMeta[]>()
  for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const folder = sidebarFolder(c)
    const list = byCwd.get(folder)
    if (list) list.push(c)
    else byCwd.set(folder, [c])
  }
  // Map keeps insertion order, and each folder was inserted at its newest chat.
  return [...byCwd].map(([cwd, list]) => ({ cwd, name: folderName(cwd), chats: list }))
}

/** Every chat across the folders, newest first: the built-in agent lists its chats without folder headers. */
export const flatChats = (folders: readonly FolderGroup[]): ChatMeta[] =>
  folders.flatMap((f) => f.chats).sort((a, b) => b.updatedAt - a.updatedAt)

/** Moves chats to their agent's new name after a rename; unaffected chats keep their identity. */
export function applyAgentRenames(chats: readonly ChatMeta[], renamed: readonly AgentRename[]): ChatMeta[] {
  const rn = (n: string): string => renamed.find((r) => r.from === n)?.to ?? n
  const hit = (n: string): boolean => renamed.some((r) => r.from === n)
  const touches = (g: GroupInfo): boolean =>
    g.members.some(hit) ||
    g.active.some((t) => hit(t.agent)) ||
    g.queue.some((e) => hit(e.agent) || e.after.some(hit)) ||
    Object.keys(g.sessions).some(hit) ||
    Object.keys(g.seen).some(hit)
  const rekey = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).map(([k, v]) => [rn(k), v]))
  const renameGroup = (g: GroupInfo): GroupInfo => ({
    ...g,
    members: g.members.map(rn),
    sessions: rekey(g.sessions),
    ...(g.sessionEngines ? { sessionEngines: rekey(g.sessionEngines) } : {}),
    seen: rekey(g.seen),
    active: g.active.map((t) => ({ ...t, agent: rn(t.agent) })),
    queue: g.queue.map((e) => ({ agent: rn(e.agent), after: e.after.map(rn) }))
  })
  return chats.map((c) => {
    if (isGroup(c)) return touches(c.group) ? { ...c, group: renameGroup(c.group) } : c
    return hit(c.agentName) ? { ...c, agentName: rn(c.agentName) } : c
  })
}

export function buildTree(agents: readonly AgentSummary[], chats: readonly ChatMeta[], query: string): AgentNode[] {
  const q = query.trim().toLowerCase()
  const nodes: AgentNode[] = []
  for (const agent of agents) {
    const own = chats.filter((c) => !isGroup(c) && c.agentName === agent.name)
    if (q === '') {
      nodes.push({ agent, folders: groupByFolder(own), forceOpen: false })
      continue
    }
    const nameMatch = agent.name.toLowerCase().includes(q) || displayName(agent.name).toLowerCase().includes(q)
    const matching = own.filter((c) => titleMatches(c, agents, q))
    if (!nameMatch && matching.length === 0) continue
    nodes.push({ agent, folders: groupByFolder(nameMatch ? own : matching), forceOpen: !nameMatch && matching.length > 0 })
  }
  return nodes
}

/** A chat for this agent and folder that never got a message, reopened instead of creating another empty one. `worktree` is whether the new chat would be isolated: a plain empty chat must not stand in for a worktree one, or the other way round. */
/** cwd null = no folder: any of the agent's scratch chats will do, as they share one sidebar group. */
export function reusableChat(chats: readonly ChatMeta[], agentName: string, cwd: string | null, worktree: boolean): ChatMeta | undefined {
  const inFolder = (c: ChatMeta): boolean => (cwd === null ? isScratchRoot(sidebarFolder(c)) : sidebarFolder(c) === cwd)
  // Not an archived one: the user put it away, and it would open outside the sidebar.
  return chats.find(
    (c) =>
      c.agentName === agentName && inFolder(c) && (c.worktree !== undefined) === worktree && c.title === '' && !c.inFlight && !isArchived(c)
  )
}

export interface GroupRow {
  chat: ChatMeta
  members: AgentSummary[] // missing agents left out
  folder: string
}

/** Group chats, newest first; a search matches the title or any member's name. */
export function groupRows(agents: readonly AgentSummary[], chats: readonly ChatMeta[], query: string): GroupRow[] {
  const q = query.trim().toLowerCase()
  const rows: GroupRow[] = []
  for (const chat of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!isGroup(chat)) continue
    const members = chat.group.members.flatMap((n) => agents.find((a) => a.name === n) ?? [])
    const match =
      q === '' ||
      titleMatches(chat, agents, q) ||
      members.some((m) => m.name.toLowerCase().includes(q) || displayName(m.name).toLowerCase().includes(q))
    if (match) rows.push({ chat, members, folder: sidebarFolder(chat) })
  }
  return rows
}
