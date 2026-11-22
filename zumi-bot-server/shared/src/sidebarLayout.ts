/**
 * How the user arranged the sidebar, kept on the server so every device shows the same: their own sections and the
 * order of what sits outside them. Items are keyed `agent:<name>` or `group:<chatId>`.
 */
export interface SidebarSection {
  id: string
  name: string
  collapsed: boolean
  items: string[]
}

export interface SidebarLayout {
  sections: SidebarSection[]
  /** The order of items in no section; an item never placed anywhere is missing here and shows first. */
  unassigned: string[]
}

export const SECTION_NAME_MAX = 60
const SECTIONS_MAX = 100
export const SECTION_ID_MAX = 64

export const emptyLayout = (): SidebarLayout => ({ sections: [], unassigned: [] })

export const agentKey = (name: string): string => `agent:${name}`
export const groupKey = (chatId: string): string => `group:${chatId}`

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)

/**
 * The layout in `v`, or null when its shape is wrong. Repeats are dropped (an item stays in the first place it is
 * listed, sections before the unassigned list), names are trimmed and cut, and anything else is left out (pins, from
 * before they were dropped), so a stored layout is always clean.
 */
export function parseLayout(v: unknown): SidebarLayout | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const unassigned = strings(o.unassigned)
  if (!Array.isArray(o.sections) || o.sections.length > SECTIONS_MAX || !unassigned) return null
  const seen = new Set<string>()
  const fresh = (k: string): boolean => !seen.has(k) && (seen.add(k), true)
  const ids = new Set<string>()
  const sections: SidebarSection[] = []
  for (const raw of o.sections as unknown[]) {
    if (!raw || typeof raw !== 'object') return null
    const s = raw as Record<string, unknown>
    const items = strings(s.items)
    if (
      typeof s.id !== 'string' ||
      s.id === '' ||
      s.id.length > SECTION_ID_MAX ||
      typeof s.name !== 'string' ||
      typeof s.collapsed !== 'boolean' ||
      !items
    )
      return null
    if (ids.has(s.id)) continue
    ids.add(s.id)
    sections.push({ id: s.id, name: s.name.trim().slice(0, SECTION_NAME_MAX), collapsed: s.collapsed, items: items.filter(fresh) })
  }
  return { sections, unassigned: unassigned.filter(fresh) }
}

const mapKeys = (l: SidebarLayout, fn: (k: string) => string): SidebarLayout => ({
  ...l,
  sections: l.sections.map((s) => ({ ...s, items: s.items.map(fn) })),
  unassigned: l.unassigned.map(fn)
})

/** The agent keeps its place under its new name. */
export function renameAgentInLayout(l: SidebarLayout, from: string, to: string): SidebarLayout {
  const old = agentKey(from)
  return mapKeys(l, (k) => (k === old ? agentKey(to) : k))
}

/** A deleted group leaves its place. */
export function forgetChatInLayout(l: SidebarLayout, chatId: string): SidebarLayout {
  const key = groupKey(chatId)
  return {
    sections: l.sections.map((s) => ({ ...s, items: s.items.filter((k) => k !== key) })),
    unassigned: l.unassigned.filter((k) => k !== key)
  }
}

/** `key` taken from wherever it is and put first in the section. Unchanged when no section has that id (deleted since). */
export function placeFirstInSection(l: SidebarLayout, sectionId: string, key: string): SidebarLayout {
  if (!l.sections.some((s) => s.id === sectionId)) return l
  const strip = (list: readonly string[]): string[] => list.filter((k) => k !== key)
  return {
    sections: l.sections.map((s) => ({ ...s, items: s.id === sectionId ? [key, ...strip(s.items)] : strip(s.items) })),
    unassigned: strip(l.unassigned)
  }
}
