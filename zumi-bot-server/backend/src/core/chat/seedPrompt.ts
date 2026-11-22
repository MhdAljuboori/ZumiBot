import type { ChatItem } from '@zumibot/shared/types'
import { displayName } from '@zumibot/shared/frontmatter'
import { toolSummary } from '@zumibot/shared/toolSummary'

export const SEED_MAX_CHARS = 100_000
export const OMITTED = '[Earlier messages omitted]'
const TITLE_MAX = 60

function entryOf(item: ChatItem): string | null {
  switch (item.type) {
    case 'user':
      return `User: ${item.text}`
    case 'assistant':
      return `${item.agent ? displayName(item.agent) : 'Assistant'}: ${item.text}`
    case 'tool': {
      const suffix = item.blocked ? ' — blocked' : item.isError ? ' — error' : ''
      return `[Tool] ${toolSummary(item.name, item.input)}${suffix}`
    }
    default:
      return null
  }
}

function render(entries: string[], newText: string): string {
  return (
    "[ZumiBot] This chat's earlier session expired, so the earlier conversation is restored below from saved history. Treat it as context only.\n\n" +
    `<earlier_conversation>\n${entries.join('\n\n')}\n</earlier_conversation>\n\n` +
    `<new_message>\n${newText}\n</new_message>`
  )
}

/** Seed prompt for continuing a chat whose CLI session expired. */
export function buildSeedPrompt(history: ChatItem[], newText: string, maxChars = SEED_MAX_CHARS): string {
  const entries = history.map(entryOf).filter((e): e is string => e !== null)
  const base = render([], newText).length
  const joined = entries.reduce((n, e) => n + e.length, 0) + 2 * Math.max(entries.length - 1, 0)
  if (base + joined <= maxChars) return render(entries, newText)
  // Over budget: the omission marker is an extra first entry, then the newest entries that still fit.
  let used = base + OMITTED.length
  let start = entries.length
  while (start > 0 && used + 2 + entries[start - 1].length <= maxChars) {
    used += 2 + entries[start - 1].length
    start--
  }
  return render(start === entries.length ? [] : [OMITTED, ...entries.slice(start)], newText)
}

export function makeTitle(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  if (chars.length <= TITLE_MAX) return chars.join('')
  return chars.slice(0, TITLE_MAX - 1).join('') + '…'
}
