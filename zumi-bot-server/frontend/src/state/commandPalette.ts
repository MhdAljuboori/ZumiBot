import { isArchived } from '@zumibot/shared/archive'
import { displayName } from '@zumibot/shared/frontmatter'
import { fold } from '@zumibot/shared/search'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import type { Routine } from '@zumibot/shared/routines'
import type { Workflow } from '@zumibot/shared/workflows'
import type { SettingsSection } from './route'
import { settingsLabel, visibleSections } from './settings'
import { engineTag } from './agentEngine'
import { chatTitle, folderName } from './sidebarTree'

/**
 * The Ctrl+K palette: every place the app can go (its views, each Settings section, every chat, agent, routine and
 * workflow) and a few things to create, matched by what the user types. Pure; the component draws it and App moves.
 */

export type PaletteView = 'agents' | 'routines' | 'workflows' | 'todos' | 'inbox' | 'archived'
export type PaletteAction = 'new-chat' | 'new-group' | 'new-agent' | 'new-routine' | 'new-workflow'

export type PaletteTarget =
  | { kind: 'view'; view: PaletteView }
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'chat'; chatId: string }
  | { kind: 'agent'; name: string; filePath: string; broken: boolean }
  | { kind: 'routine'; id: string }
  | { kind: 'workflow'; id: string }

/** What a row draws in front of its text; the component maps each to an icon. */
export type PaletteIcon = { kind: 'glyph'; name: string } | { kind: 'agent'; name: string } | { kind: 'room'; members: string[] }

export type PaletteGroup = 'recent' | 'goto' | 'create' | 'chats' | 'agents' | 'routines' | 'workflows'

export interface PaletteItem {
  key: string
  group: Exclude<PaletteGroup, 'recent'>
  label: string
  detail?: string
  tag?: string
  /** Words it also answers to, never shown ("theme" finds General). */
  keywords?: string
  /** Newer first among equal matches: a chat's last change. */
  rank: number
  icon: PaletteIcon
  target: PaletteTarget
}

export interface PaletteSection {
  group: PaletteGroup
  title: string
  items: PaletteItem[]
}

export interface PaletteSources {
  chats: readonly ChatMeta[]
  agents: readonly AgentSummary[]
  routines: readonly Routine[]
  workflows: readonly Workflow[]
  /** A server with a sign-in: only then is there an Account section. */
  vps: boolean
  /** The desktop shell, where Sync reads "Sync & server". */
  desktop: boolean
  /** A shell with the island: only then is there an Island & startup section. */
  island: boolean
}

export const GROUP_TITLES: Record<PaletteGroup, string> = {
  recent: 'Recent chats',
  goto: 'Go to',
  create: 'Create',
  chats: 'Chats',
  agents: 'Agents',
  routines: 'Routines',
  workflows: 'Workflows'
}

/** The order sections keep when their best matches tie, and on an empty query. */
const GROUP_ORDER: PaletteGroup[] = ['recent', 'goto', 'create', 'chats', 'agents', 'routines', 'workflows']

/** How many rows a section lists for a query; Go to and Create are short and list every match. */
export const GROUP_LIMITS: Record<PaletteGroup, number> = {
  recent: 6,
  goto: 20,
  create: 10,
  chats: 8,
  agents: 6,
  routines: 6,
  workflows: 6
}

const VIEWS: Array<{ view: PaletteView; label: string; keywords: string; icon: PaletteIcon }> = [
  { view: 'agents', label: 'Agents', keywords: 'chats home sidebar', icon: { kind: 'glyph', name: 'rail:agents' } },
  {
    view: 'routines',
    label: 'Routines',
    keywords: 'schedule scheduled webhook automation',
    icon: { kind: 'glyph', name: 'rail:routines' }
  },
  { view: 'workflows', label: 'Workflows', keywords: 'automation canvas runs steps', icon: { kind: 'glyph', name: 'rail:workflows' } },
  { view: 'todos', label: 'To-dos', keywords: 'todo todos tasks action items', icon: { kind: 'glyph', name: 'rail:todos' } },
  { view: 'inbox', label: 'Inbox', keywords: 'approvals waiting notify messages', icon: { kind: 'glyph', name: 'rail:inbox' } },
  { view: 'archived', label: 'Archived', keywords: 'archive', icon: { kind: 'glyph', name: 'archive' } }
]

const SETTINGS: Record<SettingsSection, { keywords: string; icon: string }> = {
  general: { keywords: 'theme dark light easy to read replies keep warm tokens', icon: 'sliders' },
  notifications: { keywords: 'push alerts devices', icon: 'bell' },
  vault: { keywords: 'passwords logins cards api keys secrets 2fa', icon: 'lock' },
  'claude-code': { keywords: 'mcp servers plugins skills hooks tools extensions', icon: 'settings' },
  connectors: { keywords: 'gmail google calendar drive notion github slack linear claude.ai accounts services connect', icon: 'plug' },
  channels: { keywords: 'telegram slack bot chat phone pair messaging channel', icon: 'messagePlus' },
  audit: { keywords: 'audit log tool calls approvals denials governance history', icon: 'fileText' },
  voice: { keywords: 'dictation microphone mic speech', icon: 'mic' },
  jev: { keywords: 'decisions openrouter risk', icon: 'sparkles' },
  usage: { keywords: 'cost spending tokens limits', icon: 'chart' },
  sync: { keywords: 'server vps switch server', icon: 'sync' },
  island: { keywords: 'dynamic island strip tray start at login startup autostart', icon: 'bot' },
  account: { keywords: 'sign out log out logout', icon: 'user' },
  about: { keywords: 'version', icon: 'info' }
}

const ACTIONS: Array<{ action: PaletteAction; label: string; keywords: string; icon: string }> = [
  { action: 'new-chat', label: 'New chat', keywords: 'start conversation', icon: 'messagePlus' },
  { action: 'new-group', label: 'New group chat', keywords: 'room team members', icon: 'users' },
  { action: 'new-agent', label: 'New agent', keywords: 'create agent studio', icon: 'bot' },
  { action: 'new-routine', label: 'New routine', keywords: 'schedule webhook', icon: 'rail:routines' },
  { action: 'new-workflow', label: 'New workflow', keywords: 'canvas', icon: 'rail:workflows' }
]

const firstLine = (s: string): string => s.split('\n', 1)[0].trim()

/** Every place and action the palette offers, before any matching. */
export function paletteItems(s: PaletteSources): PaletteItem[] {
  const items: PaletteItem[] = []
  for (const v of VIEWS)
    items.push({
      key: `view:${v.view}`,
      group: 'goto',
      label: v.label,
      keywords: v.keywords,
      rank: 0,
      icon: v.icon,
      target: { kind: 'view', view: v.view }
    })
  for (const section of visibleSections(s.vps, s.island)) {
    const meta = SETTINGS[section]
    items.push({
      key: `settings:${section}`,
      group: 'goto',
      label: settingsLabel(section, s.desktop),
      detail: 'Settings',
      keywords: meta.keywords,
      rank: 0,
      icon: { kind: 'glyph', name: meta.icon },
      target: { kind: 'settings', section }
    })
  }
  for (const a of ACTIONS)
    items.push({
      key: `action:${a.action}`,
      group: 'create',
      label: a.label,
      keywords: a.keywords,
      rank: 0,
      icon: { kind: 'glyph', name: a.icon },
      target: { kind: 'action', action: a.action }
    })
  const agentNames = new Set(s.agents.map((a) => a.name))
  for (const c of s.chats) {
    // As the sidebar: a single chat whose agent is gone could not open.
    if (!isGroup(c) && !agentNames.has(c.agentName)) continue
    const who = isGroup(c) ? c.group.members.map(displayName).join(', ') : displayName(c.agentName)
    items.push({
      key: `chat:${c.id}`,
      group: 'chats',
      label: chatTitle(c, s.agents),
      detail: `${who} · ${folderName(c.cwd)}`,
      ...(isArchived(c) ? { tag: 'Archived' } : {}),
      keywords: isGroup(c) ? c.group.members.join(' ') : c.agentName,
      rank: c.updatedAt,
      icon: isGroup(c) ? { kind: 'room', members: c.group.members } : { kind: 'agent', name: c.agentName },
      target: { kind: 'chat', chatId: c.id }
    })
  }
  for (const a of s.agents) {
    const broken = a.error !== null
    items.push({
      key: `agent:${a.name}`,
      group: 'agents',
      label: displayName(a.name),
      detail: broken ? 'Has an error · opens Agent Studio' : firstLine(a.description),
      ...(engineTag(a) ? { tag: engineTag(a)! } : {}),
      keywords: `${a.name} agent`,
      rank: 0,
      icon: { kind: 'agent', name: a.name },
      target: { kind: 'agent', name: a.name, filePath: a.filePath, broken }
    })
  }
  for (const r of s.routines) {
    items.push({
      key: `routine:${r.id}`,
      group: 'routines',
      label: r.name,
      ...(r.enabled ? {} : { tag: 'Off' }),
      keywords: 'routine',
      rank: 0,
      icon: { kind: 'glyph', name: 'rail:routines' },
      target: { kind: 'routine', id: r.id }
    })
  }
  for (const w of s.workflows) {
    items.push({
      key: `workflow:${w.id}`,
      group: 'workflows',
      label: w.name,
      ...(w.enabled ? {} : { tag: 'Off' }),
      keywords: 'workflow',
      rank: 0,
      icon: { kind: 'glyph', name: 'rail:workflows' },
      target: { kind: 'workflow', id: w.id }
    })
  }
  return items
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/** Where `word` starts a word of `text` (both folded), or -1. */
function wordStart(text: string, word: string): number {
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (i === 0 || !WORD_CHAR.test(text[i - 1])) return i
  }
  return -1
}

/** Every character of `word` in order in `text`, the gaps between them at most a few characters each. */
function inOrder(text: string, word: string): boolean {
  let at = -1
  for (const ch of word) {
    const next = text.indexOf(ch, at + 1)
    if (next < 0 || (at >= 0 && next - at > 4)) return false
    at = next
  }
  return true
}

/** How well one folded word matches an item's folded label and other text; null when it does not. */
function wordScore(word: string, label: string, rest: string): number | null {
  if (label.startsWith(word)) return 100
  if (wordStart(label, word) >= 0) return 75
  if (label.includes(word)) return 50
  if (wordStart(rest, word) >= 0) return 35
  // Inside a word of the hidden text only from three letters: "re" would find "secrets".
  if (word.length >= 3 && rest.includes(word)) return 20
  if (word.length >= 2 && inOrder(label, word)) return 10
  return null
}

/** The query's words, folded as message search folds them; none for a blank query. */
export const queryWords = (query: string): string[] => fold(query).trim().split(/\s+/).filter(Boolean)

/** How well an item matches every word (each must match somewhere); null when one does not. */
export function itemScore(words: readonly string[], item: PaletteItem): number | null {
  const label = fold(item.label)
  const rest = fold(`${item.detail ?? ''} ${item.tag ?? ''} ${item.keywords ?? ''}`)
  let total = 0
  for (const w of words) {
    const s = wordScore(w, label, rest)
    if (s === null) return null
    total += s
  }
  // The whole label typed as is wins over a longer label that only starts with it.
  if (label === words.join(' ')) total += 50
  return total
}

/**
 * The rows for a query, by section. A blank query lists the newest live chats, the places to go and what to create; a
 * query lists each section's best matches (every word must match), the section with the best match first.
 */
export function paletteSections(items: readonly PaletteItem[], query: string): PaletteSection[] {
  const words = queryWords(query)
  if (words.length === 0) {
    const recent = items
      .filter((i) => i.group === 'chats' && i.tag !== 'Archived')
      .sort((a, b) => b.rank - a.rank)
      .slice(0, GROUP_LIMITS.recent)
    const sections: PaletteSection[] = [
      { group: 'recent', title: GROUP_TITLES.recent, items: recent },
      { group: 'goto', title: GROUP_TITLES.goto, items: items.filter((i) => i.group === 'goto') },
      { group: 'create', title: GROUP_TITLES.create, items: items.filter((i) => i.group === 'create') }
    ]
    return sections.filter((s) => s.items.length > 0)
  }
  const scored = new Map<PaletteGroup, Array<{ item: PaletteItem; score: number }>>()
  for (const item of items) {
    const score = itemScore(words, item)
    if (score === null) continue
    const list = scored.get(item.group) ?? []
    list.push({ item, score })
    scored.set(item.group, list)
  }
  const sections = [...scored].map(([group, list]) => {
    list.sort((a, b) => b.score - a.score || b.item.rank - a.item.rank || a.item.label.length - b.item.label.length)
    return { group, best: list[0].score, items: list.slice(0, GROUP_LIMITS[group]).map((x) => x.item) }
  })
  sections.sort((a, b) => b.best - a.best || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  return sections.map(({ group, items: rows }) => ({ group, title: GROUP_TITLES[group], items: rows }))
}

/** The next row from `index` by `delta` among `count`, wrapping at either end; -1 when there are none. */
export function moveActive(index: number, delta: number, count: number): number {
  if (count === 0) return -1
  if (index < 0) return delta > 0 ? 0 : count - 1
  return (((index + delta) % count) + count) % count
}

/** Message hits are asked for once the query holds this many characters, so a first letter does not search history. */
export const PALETTE_MESSAGES_MIN = 2
/** How many message hits the palette lists; the sidebar's search shows all. */
export const PALETTE_HITS = 6

/** The query the palette's message search asks: the text once it is long enough, else none. */
export const messageQuery = (query: string): string => (query.trim().length >= PALETTE_MESSAGES_MIN ? query.trim() : '')
