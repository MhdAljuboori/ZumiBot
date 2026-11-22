/**
 * Message search: the folding, tokens and query rules the server's index and the client's highlights share, so a hit
 * lights exactly what matched. Pure.
 *
 * A query is words and "quoted phrases". Every word must match (AND); a word of PREFIX_MIN characters or more matches
 * the start of a word ("deplo" finds "deployment"), a shorter one or a quoted one a whole word. A chunk whose words are
 * joined by punctuation (`foo.bar`, `v8.6.5`, a CJK run) and a quoted phrase must also appear as typed, from a word's
 * start and spaces aside; a closed quote also ends at a word's end.
 */

/** The longest query the server takes. */
export const SEARCH_QUERY_MAX = 200
/** Words past this many are ignored. */
export const SEARCH_TERMS_MAX = 8
/** Phrases past this many are ignored. */
export const SEARCH_PHRASES_MAX = 4
/** Hits per page. */
export const SEARCH_PAGE = 30
/** The furthest page a client may ask for (by offset): past it, a narrower query is the way. */
export const SEARCH_OFFSET_MAX = 990
/** A word shorter than this matches whole words only: one letter would match half the history. */
export const PREFIX_MIN = 2
/** Tokens are cut here (hashes, base64 runs); a term that long then matches as a prefix. */
export const TOKEN_MAX = 40
/** Only a message's first this many characters are searchable (a huge paste stays cheap). */
export const SEARCH_TEXT_MAX = 100_000
/** About how long a hit's snippet is. */
export const SNIPPET_CHARS = 180

export type SearchRole = 'user' | 'assistant'

/** A message that matched. `marks` are [start, end) ranges of the snippet that matched. */
export interface SearchHit {
  chatId: string
  itemId: string
  role: SearchRole
  agent: string | null // an agent message's room member (null in a single chat: the chat's agent), or the agent that asked a user message
  ts: number
  snippet: string
  marks: Array<[number, number]>
}

/**
 * One page of hits, newest first. `total` counts every match (a lower bound when `capped`: a phrase was checked only
 * against the newest matches). `indexing`: the index is still being built at start, so older chats may be missing.
 */
export interface SearchResult {
  hits: SearchHit[]
  total: number
  capped: boolean
  more: boolean
  indexing: boolean
}

export const emptyResult = (indexing = false): SearchResult => ({ hits: [], total: 0, capped: false, more: false, indexing })

export interface QueryTerm {
  token: string
  prefix: boolean
}

/**
 * Words that must stand together, folded with their spaces collapsed to one. `whole`: a closed quote, which ends at a
 * word's end; a phrase still being typed (an unclosed quote, a joined chunk) may end inside a word.
 */
export interface Phrase {
  text: string
  whole: boolean
}

export interface SearchQuery {
  terms: QueryTerm[]
  phrases: Phrase[]
}

const MARKS = /\p{M}/gu
// Arabic as Arabic search folds it (tatweel dropped, alef wasla, alef maqsura and ta marbuta to their plain letters; the
// hamza and madda forms of alef come apart under NFKD already), and Greek final sigma, which a whole-string lowercase
// writes only at a word's end.
const EXTRA = /[ـٱىةς]/g
const EXTRA_TO: Record<string, string> = { ـ: '', ٱ: 'ا', ى: 'ي', ة: 'ه', ς: 'σ' }
const extra = (c: string): string => EXTRA_TO[c] ?? c

/** Case, accents and compatibility forms folded away: "Café ﬁle" and "cafe file" fold the same. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(MARKS, '').replace(EXTRA, extra)
}

/**
 * `fold`, keeping where each folded unit came from: `at[i]` is the index in `text` of the character folded unit `i`
 * came from, and `at[folded.length]` is `text.length`. Folds one character at a time, which is what `fold` does to a
 * whole string too (NFKD decomposes each character on its own, and the marks it might reorder are dropped).
 */
export function foldMap(text: string): { folded: string; at: number[] } {
  const parts: string[] = []
  const at: number[] = []
  let i = 0
  while (i < text.length) {
    const c = text.charCodeAt(i)
    if (c < 0x80) {
      // ASCII folds to itself, lowercased: the common case, kept off normalize().
      parts.push(c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : text[i])
      at.push(i)
      i++
      continue
    }
    const wide = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length
    const ch = wide ? text.slice(i, i + 2) : text[i]
    const f = fold(ch)
    parts.push(f)
    for (let k = 0; k < f.length; k++) at.push(i)
    i += ch.length
  }
  at.push(text.length)
  return { folded: parts.join(''), at }
}

const WORD = /[\p{L}\p{N}]+/gu
const CJK_ONE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u
// Scripts written without spaces: each character is a token of its own, and a run of them is matched as a phrase.
const CJK_SPLIT = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]|[^\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+/gu
const WORD_CHAR = /[\p{L}\p{N}]/u
// From the first word character to the last: a chunk without the punctuation around it.
const WORDS_SPAN = /[\p{L}\p{N}](?:.*[\p{L}\p{N}])?/su

/** The tokens of an already folded text, in order (repeats kept). */
export function tokensOf(folded: string): string[] {
  const out: string[] = []
  for (const m of folded.matchAll(WORD)) {
    const w = m[0]
    if (!CJK_ONE.test(w)) out.push(w.length > TOKEN_MAX ? w.slice(0, TOKEN_MAX) : w)
    else for (const p of w.match(CJK_SPLIT) ?? []) out.push(p.length > TOKEN_MAX ? p.slice(0, TOKEN_MAX) : p)
  }
  return out
}

// Arabic writes the article and a few particles onto the word ("المستشفى", "والكتاب", "للبيت"): a word is also found
// without them, as Arabic search's light stemming does. Longest first; `rest` is the least the word keeps after it.
const AR_PREFIXES: ReadonlyArray<{ p: string; rest: number }> = [
  { p: '\u0648\u0627\u0644', rest: 2 }, // وال
  { p: '\u0648\u0644\u0644', rest: 2 }, // ولل
  { p: '\u0628\u0627\u0644', rest: 2 }, // بال
  { p: '\u0643\u0627\u0644', rest: 2 }, // كال
  { p: '\u0641\u0627\u0644', rest: 2 }, // فال
  { p: '\u0644\u0644', rest: 2 }, // لل
  { p: '\u0627\u0644', rest: 2 }, // ال
  { p: '\u0648', rest: 3 } // و
]

/** A folded token without its Arabic article or particle, or null when it has none. */
export function arabicStem(token: string): string | null {
  for (const { p, rest } of AR_PREFIXES) if (token.startsWith(p) && token.length - p.length >= rest) return token.slice(p.length)
  return null
}

/** Each distinct token of a raw text, and each Arabic word without its article: what the index stores for a message. */
export function textTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of tokensOf(fold(text.length > SEARCH_TEXT_MAX ? text.slice(0, SEARCH_TEXT_MAX) : text))) {
    out.add(t)
    const stem = arabicStem(t)
    if (stem !== null) out.add(stem)
  }
  return out
}

const spaced = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The query a search box's text asks for, or null when it holds no word. */
export function parseQuery(raw: string): SearchQuery | null {
  const text = raw.slice(0, SEARCH_QUERY_MAX)
  // token -> prefix; an exact use of a token wins over a prefix one
  const terms = new Map<string, boolean>()
  const phrases: Phrase[] = []
  const addTerm = (token: string, prefix: boolean): void => {
    const p = prefix && token.length >= PREFIX_MIN && !CJK_ONE.test(token) ? true : token.length >= TOKEN_MAX
    terms.set(token, (terms.get(token) ?? true) && p)
  }
  const addPhrase = (folded: string, whole: boolean): void => {
    const text = spaced(folded)
    const same = phrases.find((p) => p.text === text)
    if (same) same.whole ||= whole
    else if (text !== '') phrases.push({ text, whole })
  }
  // An unclosed quote runs to the end, so a phrase is searched while it is still being typed.
  const quoted = /"([^"]*)("|$)/g
  let rest = ''
  let last = 0
  for (const m of text.matchAll(quoted)) {
    rest += text.slice(last, m.index) + ' '
    last = m.index + m[0].length
    const folded = fold(m[1])
    const toks = tokensOf(folded)
    if (toks.length === 0) continue
    const closed = m[2] === '"'
    // A quoted word is that word, not words starting with it (once the quote is closed); a longer phrase is checked as typed.
    if (toks.length === 1 && !CJK_ONE.test(toks[0])) addTerm(toks[0], !closed)
    else {
      for (const t of toks) addTerm(t, true)
      addPhrase(folded.match(WORDS_SPAN)?.[0] ?? folded, closed)
    }
  }
  rest += text.slice(last)
  for (const chunk of rest.split(/\s+/)) {
    if (chunk === '') continue
    const folded = fold(chunk)
    const toks = tokensOf(folded)
    for (const t of toks) addTerm(t, true)
    // `foo.bar`, `v8.6.5` or a CJK run: its words must also stand together. The chunk is trimmed to its words, so
    // `(deploy)` or `deploy,` asks for no phrase.
    if (toks.length > 1) addPhrase(folded.match(WORDS_SPAN)?.[0] ?? folded, false)
  }
  if (terms.size === 0) return null
  return {
    terms: [...terms].slice(0, SEARCH_TERMS_MAX).map(([token, prefix]) => ({ token, prefix })),
    phrases: phrases.slice(0, SEARCH_PHRASES_MAX)
  }
}

/** What `hasPhrases` reads for a message: its words as the snippet shows them (Markdown marks dropped), folded. */
export const phraseText = (text: string): string =>
  spaced(fold(plainText(text.length > SEARCH_TEXT_MAX ? text.slice(0, SEARCH_TEXT_MAX) : text)))

function charBefore(s: string, i: number): string {
  if (i <= 0) return ''
  const c = s.charCodeAt(i - 1)
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s[i - 1]
}

function charAt(s: string, i: number): string {
  if (i >= s.length) return ''
  const c = s.charCodeAt(i)
  return c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? s.slice(i, i + 2) : s[i]
}

// A token starts where the character before is no word character, or where either side is CJK (one token each).
const plainStart = (s: string, i: number): boolean => {
  const before = charBefore(s, i)
  return before === '' || !WORD_CHAR.test(before) || CJK_ONE.test(before) || CJK_ONE.test(charAt(s, i))
}

// Where the word that runs on from `i` ends.
function wordEnd(s: string, i: number): number {
  let j = i
  while (j < s.length && WORD_CHAR.test(charAt(s, j))) j += charAt(s, j).length
  return j
}

// Also right after an Arabic article or particle at a token's start, where the index has the word without it.
const startsToken = (s: string, i: number): boolean =>
  plainStart(s, i) ||
  AR_PREFIXES.some(
    ({ p, rest }) => i >= p.length && s.startsWith(p, i - p.length) && plainStart(s, i - p.length) && wordEnd(s, i) - i >= rest
  )
const endsToken = (s: string, end: number): boolean => {
  const after = charAt(s, end)
  return after === '' || !WORD_CHAR.test(after) || CJK_ONE.test(after) || CJK_ONE.test(charBefore(s, end))
}

/** Whether every phrase stands in the text (a folded text with its spaces collapsed, as `phraseText` makes it), from a word's start. */
export function hasPhrases(phraseText: string, q: SearchQuery): boolean {
  return q.phrases.every((p) => {
    for (let i = phraseText.indexOf(p.text); i >= 0; i = phraseText.indexOf(p.text, i + 1)) {
      if (startsToken(phraseText, i) && (!p.whole || endsToken(phraseText, i + p.text.length))) return true
    }
    return false
  })
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The most ranges a text gets: a highlight past that adds nothing a reader can use. */
const RANGES_MAX = 300

/** Where the query matches in `text`, as sorted, merged [start, end) ranges of `text` itself. */
export function matchRanges(text: string, q: SearchQuery): Array<[number, number]> {
  const capped = text.length > SEARCH_TEXT_MAX ? text.slice(0, SEARCH_TEXT_MAX) : text
  const { folded, at } = foldMap(capped)
  const found: Array<[number, number]> = []
  for (const t of q.terms) {
    let i = folded.indexOf(t.token)
    while (i >= 0 && found.length < RANGES_MAX) {
      const end = i + t.token.length
      if (startsToken(folded, i) && (t.prefix || endsToken(folded, end))) found.push([at[i], at[end]])
      i = folded.indexOf(t.token, i + 1)
    }
  }
  for (const p of q.phrases) {
    const re = new RegExp(p.text.split(' ').map(escape).join('\\s+'), 'g')
    for (const m of folded.matchAll(re)) {
      if (found.length >= RANGES_MAX) break
      const end = m.index + m[0].length
      if (startsToken(folded, m.index) && (!p.whole || endsToken(folded, end))) found.push([at[m.index], at[end]])
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = []
  for (const r of found) {
    const prev = merged[merged.length - 1]
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

/**
 * A reply's Markdown as a snippet reads it: links and images as their text, emphasis, code and strike marks, heading,
 * quote and fence markers dropped. Words stay in order, so the snippet's marks still fall on the words that matched;
 * single `*` and `_` stay, since identifiers hold them.
 */
export function plainText(md: string): string {
  return md
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, '')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?)+/gm, '')
    .replace(/\*\*|__|~~|`+/g, '')
}

/** How much of the snippet comes before its first match. */
const LEAD = 40

/** A short window of `text` around its first match, with the matches in it marked; whitespace runs read as one space. */
export function snippet(text: string, q: SearchQuery, width = SNIPPET_CHARS): { snippet: string; marks: Array<[number, number]> } {
  const ranges = matchRanges(text, q)
  const first = ranges[0]?.[0] ?? 0
  let start = Math.max(0, first - LEAD)
  // Starts at a word, unless that word is long or is the match itself.
  if (start > 0) {
    const space = text.slice(start, first).search(/\s/)
    if (space >= 0 && space < LEAD / 2) start += space + 1
  }
  let end = Math.min(text.length, start + width)
  if (end < text.length) {
    const back = text.slice(start, end).search(/\s\S*$/)
    if (back > width / 2 && start + back > first) end = start + back
  }
  // Never half a surrogate pair at either edge.
  if (start > 0 && /[\udc00-\udfff]/.test(text[start])) start++
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--
  // The window with its whitespace collapsed; `pos` maps each kept index of the window to the snippet's.
  const head = start > 0 ? '…' : ''
  let out = head
  const pos = new Map<number, number>()
  let lastSpace = true
  for (let i = start; i < end; i++) {
    const c = text[i]
    pos.set(i, out.length)
    if (/\s/.test(c)) {
      if (!lastSpace) out += ' '
      lastSpace = true
    } else {
      out += c
      lastSpace = false
    }
  }
  pos.set(end, out.length)
  out = out.replace(/ $/, '')
  const body = out.length
  if (end < text.length) out += '…'
  const marks: Array<[number, number]> = []
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue
    const s = Math.max(pos.get(Math.max(a, start)) ?? head.length, head.length)
    const e = Math.min(pos.get(Math.min(b, end)) ?? body, body)
    if (e > s) marks.push([s, e])
  }
  return { snippet: out, marks }
}
