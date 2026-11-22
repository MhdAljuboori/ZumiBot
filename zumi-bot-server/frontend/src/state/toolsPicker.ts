import { TODO_TOOLS } from '@zumibot/shared/todos'

const hidden: readonly string[] = TODO_TOOLS

/** What the tools picker shows: the to-do tools are ZumiBot's own and never pickable. */
export const visibleTools = (tools: readonly string[]): string[] => tools.filter((t) => !hidden.includes(t))

/**
 * The tools list to store after the picker changed the visible ones. The hidden to-do tools stay, so editing
 * never drops them; nothing visible left means "all tools" (null), never a list of to-do tools alone.
 */
export function pickedTools(current: readonly string[], nextVisible: readonly string[]): string[] | null {
  if (nextVisible.length === 0) return null
  return [...nextVisible, ...current.filter((t) => hidden.includes(t))]
}
