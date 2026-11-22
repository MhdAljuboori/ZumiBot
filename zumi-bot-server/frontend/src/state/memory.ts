import { MEMORY_TYPES, type MemoryEntry, type MemoryInput, type MemoryList } from '@zumibot/shared/memory'

export type MemoryGroupKey = 'user' | 'feedback' | 'project' | 'reference' | 'other'

const GROUPS: { key: MemoryGroupKey; label: string }[] = [
  { key: 'user', label: 'User' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'project', label: 'Project' },
  { key: 'reference', label: 'Reference' },
  { key: 'other', label: 'Other' }
]

/** Every word of the query must appear in some field. */
export function matchesMemory(e: MemoryEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = `${e.title}\n${e.description}\n${e.name}\n${e.body}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** The search filters the list, but the row being edited stays so its draft is never hidden. */
export function visibleMemories(entries: MemoryEntry[], query: string, openFile: string | null): MemoryEntry[] {
  return entries.filter((e) => e.file === openFile || matchesMemory(e, query))
}

export function groupMemories(entries: MemoryEntry[]): { key: MemoryGroupKey; label: string; entries: MemoryEntry[] }[] {
  const known = new Set<string>(MEMORY_TYPES)
  const keyOf = (e: MemoryEntry): MemoryGroupKey => (e.type !== null && known.has(e.type) ? (e.type as MemoryGroupKey) : 'other')
  return GROUPS.map((g) => ({
    ...g,
    entries: entries.filter((e) => keyOf(e) === g.key).sort((a, b) => b.modified - a.modified)
  })).filter((g) => g.entries.length > 0)
}

export function limitState(count: number, limit: number): 'room' | 'full' | 'over' {
  return count > limit ? 'over' : count === limit ? 'full' : 'room'
}

/** A non-standard type already on the file stays selectable so saving never rewrites it. */
export function typeChoices(current: string | null): (string | null)[] {
  const base: (string | null)[] = [...MEMORY_TYPES]
  if (current === null) return [...base, null] // a typeless file shows as Other, not as the first type
  return !base.includes(current) ? [...base, current] : base
}

/** On a save conflict, show the fresh file but never throw away what the user typed. */
export function keepDraftOnConflict(
  draft: MemoryInput,
  fresh: MemoryList,
  file: string
): { entry: MemoryEntry | null; draft: MemoryInput } {
  return { entry: fresh.entries.find((x) => x.file === file) ?? null, draft }
}
