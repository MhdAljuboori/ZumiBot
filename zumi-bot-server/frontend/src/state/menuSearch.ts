/** The search box at the top of every dropdown: what it matches, and the options a select shows for a query. */

/** Lowercase words of a query; blank means no filter. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Every word of the query appears somewhere in the text, in any order and case. */
export function matchesSearch(text: string, query: string): boolean {
  const words = searchWords(query)
  if (words.length === 0) return true
  const hay = text.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** One choice of a select. `group` is its optgroup's label, if any. */
export interface SelectOption {
  value: string
  label: string
  disabled: boolean
  group?: string
}

/** The options that match the query; a group's label matches all of its options. */
export function filterOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  if (searchWords(query).length === 0) return [...options]
  return options.filter((o) => matchesSearch(o.group ? `${o.label} ${o.group}` : o.label, query))
}

/** The label a select shows for its value: the matching option's, else the first option's (as a native select does). */
export function selectedLabel(options: readonly SelectOption[], value: string): string {
  return (options.find((o) => o.value === value) ?? options[0])?.label ?? ''
}

/** Where the arrow keys go in a list of `count` items when focus is at `at` (-1: the search box). -1 again means the box. */
export function stepFocus(at: number, count: number, down: boolean): number {
  if (count === 0) return -1
  if (down) return at >= count - 1 ? at : at + 1
  return at <= 0 ? -1 : at - 1
}
