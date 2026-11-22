import { agentKey, groupKey, type SidebarLayout, type SidebarSection } from '@zumibot/shared/sidebarLayout'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { buildTree, groupRows, type AgentNode, type GroupRow } from './sidebarTree'

/** One row the user can place: an agent (its chats under it) or a group chat. */
export type Entry = { key: string; kind: 'agent'; node: AgentNode } | { key: string; kind: 'group'; row: GroupRow }

export interface SectionView {
  section: SidebarSection
  entries: Entry[]
}

export interface SidebarView {
  sections: SectionView[]
  unassigned: Entry[]
}

/** Where a dragged or moved item lands: a section (null for none), before an item (null for last). */
export interface Spot {
  section: string | null
  before: string | null
}

/** Every item the sidebar lists, in the order items never placed anywhere take: group chats newest first, then agents. */
export function itemKeys(agents: readonly AgentSummary[], chats: readonly ChatMeta[]): string[] {
  const keys = [...groupRows(agents, chats, '').map((r) => groupKey(r.chat.id)), ...agents.map((a) => agentKey(a.name))]
  return [...new Set(keys)]
}

/** The items in no section, in order: those never placed anywhere first (newly made ones show up top), then the stored order. */
export function unassignedOrder(layout: SidebarLayout, keys: readonly string[]): string[] {
  const placed = new Set(layout.sections.flatMap((s) => s.items))
  const stored = layout.unassigned.filter((k) => !placed.has(k))
  const listed = new Set(stored)
  return [...keys.filter((k) => !placed.has(k) && !listed.has(k)), ...stored]
}

/** The sections and the unassigned items, each with the rows a search keeps. Keys with nothing behind them are skipped. */
export function sidebarView(
  layout: SidebarLayout,
  agents: readonly AgentSummary[],
  chats: readonly ChatMeta[],
  query: string
): SidebarView {
  const byKey = new Map<string, Entry[]>()
  const add = (e: Entry): void => {
    byKey.set(e.key, [...(byKey.get(e.key) ?? []), e])
  }
  for (const row of groupRows(agents, chats, query)) add({ key: groupKey(row.chat.id), kind: 'group', row })
  for (const node of buildTree(agents, chats, query)) add({ key: agentKey(node.agent.name), kind: 'agent', node })
  const pick = (keys: readonly string[]): Entry[] => keys.flatMap((k) => byKey.get(k) ?? [])
  return {
    sections: layout.sections.map((section) => ({ section, entries: pick(section.items) })),
    unassigned: pick(unassignedOrder(layout, itemKeys(agents, chats)))
  }
}

const insertBefore = (list: readonly string[], item: string, before: string | null): string[] => {
  const at = before === null ? -1 : list.indexOf(before)
  return at === -1 ? [...list, item] : [...list.slice(0, at), item, ...list.slice(at)]
}

/** The layout with `key` taken from wherever it is and put at `to`. The unassigned order is written out in full. */
export function moveItem(layout: SidebarLayout, keys: readonly string[], key: string, to: Spot): SidebarLayout {
  if (to.before === key) return layout
  const strip = (list: readonly string[]): string[] => list.filter((k) => k !== key)
  const unassigned = strip(unassignedOrder(layout, keys))
  const sections = layout.sections.map((s) => ({ ...s, items: strip(s.items) }))
  if (to.section === null) return { ...layout, sections, unassigned: insertBefore(unassigned, key, to.before) }
  return {
    ...layout,
    unassigned,
    sections: sections.map((s) => (s.id === to.section ? { ...s, items: insertBefore(s.items, key, to.before) } : s))
  }
}

/** `key` put right after `afterKey`, in the same section or unassigned list. Unchanged when the anchor is unknown. */
export function placeAfter(layout: SidebarLayout, keys: readonly string[], key: string, afterKey: string): SidebarLayout {
  if (key === afterKey || !keys.includes(afterKey)) return layout
  const section = sectionOf(layout, afterKey)
  const list = section === null ? unassignedOrder(layout, keys) : (layout.sections.find((s) => s.id === section)?.items ?? [])
  const next = list.slice(list.indexOf(afterKey) + 1).find((k) => k !== key)
  return moveItem(layout, keys, key, { section, before: next ?? null })
}

export const addSection = (layout: SidebarLayout, id: string, name: string): SidebarLayout => ({
  ...layout,
  sections: [...layout.sections, { id, name, collapsed: false, items: [] }]
})

const editSection = (layout: SidebarLayout, id: string, patch: Partial<SidebarSection>): SidebarLayout => ({
  ...layout,
  sections: layout.sections.map((s) => (s.id === id ? { ...s, ...patch } : s))
})

export const renameSection = (layout: SidebarLayout, id: string, name: string): SidebarLayout => editSection(layout, id, { name })

export const setSectionCollapsed = (layout: SidebarLayout, id: string, collapsed: boolean): SidebarLayout =>
  editSection(layout, id, { collapsed })

/** A deleted section's items go to the top of the unassigned ones, in their order: nothing is lost. */
export function removeSection(layout: SidebarLayout, keys: readonly string[], id: string): SidebarLayout {
  const gone = layout.sections.find((s) => s.id === id)
  if (!gone) return layout
  const rest = { ...layout, sections: layout.sections.filter((s) => s.id !== id) }
  const moved = new Set(gone.items)
  return { ...rest, unassigned: [...gone.items, ...unassignedOrder(rest, keys).filter((k) => !moved.has(k))] }
}

/** The section `id` placed just before the section `before`, or last. */
export function moveSection(layout: SidebarLayout, id: string, before: string | null): SidebarLayout {
  const moving = layout.sections.find((s) => s.id === id)
  if (!moving || id === before) return layout
  const rest = layout.sections.filter((s) => s.id !== id)
  const at = before === null ? -1 : rest.findIndex((s) => s.id === before)
  return { ...layout, sections: at === -1 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)] }
}

/** The section an item is in, or null. */
export const sectionOf = (layout: SidebarLayout, key: string): string | null =>
  layout.sections.find((s) => s.items.includes(key))?.id ?? null
