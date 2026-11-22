export type MentionSegment = { kind: 'text'; text: string } | { kind: 'mention'; name: string; raw: string }

/** `@everyone` addresses the whole group, even when a member is literally named so. */
export const EVERYONE = 'everyone'

interface Hit {
  start: number
  end: number
  name: string
}

// `@` not preceded by a word char, `@`, `.`, `/` or `-`, then a handle of [a-z0-9-].
const MENTION_RE = /(?<![\w@./-])@([a-z0-9-]+)/gi

function scan(text: string, members: readonly string[], everyone = false): Hit[] {
  const canon = new Map(members.map((m) => [m.toLowerCase(), m]))
  canon.delete(EVERYONE)
  const hits: Hit[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    const key = m[1].toLowerCase()
    const name = key === EVERYONE ? (everyone ? EVERYONE : undefined) : canon.get(key)
    if (name !== undefined) hits.push({ start: m.index, end: m.index + m[0].length, name })
  }
  return hits
}

// Blank out fenced code blocks and inline code spans, keeping offsets intact.
export function maskCode(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  return text.replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]*`/g, blank)
}

export function findMentions(text: string, members: readonly string[]): string[] {
  const out: string[] = []
  for (const h of scan(maskCode(text), members)) if (!out.includes(h.name)) out.push(h.name)
  return out
}

/** Whether the text addresses `@everyone` outside code. */
export function mentionsEveryone(text: string): boolean {
  return scan(maskCode(text), [], true).length > 0
}

export function splitMentions(text: string, members: readonly string[], everyone = false): MentionSegment[] {
  const segs: MentionSegment[] = []
  let pos = 0
  for (const h of scan(text, members, everyone)) {
    if (h.start > pos) segs.push({ kind: 'text', text: text.slice(pos, h.start) })
    segs.push({ kind: 'mention', name: h.name, raw: text.slice(h.start, h.end) })
    pos = h.end
  }
  if (pos < text.length) segs.push({ kind: 'text', text: text.slice(pos) })
  return segs
}

export function stripMentions(text: string, members: readonly string[]): string {
  return splitMentions(text, members, true)
    .map((s) => (s.kind === 'text' ? s.text : ' '))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}
