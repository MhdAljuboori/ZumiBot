// Word tables for voice routing and transcript cleanup. Every table entry is already in `normalizeUtterance` form, so
// matching is a plain string compare (a test checks the invariant).

const table = (...words: string[]): readonly string[] => Object.freeze(words)

/**
 * Lowercases and strips what speech-to-text varies on: punctuation (apostrophes are joined, "don't" -> "dont"),
 * Arabic diacritics and tatweel, alef forms (أ إ آ -> ا) and alef maqsura (ى -> ي). Digits are kept as written.
 */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{M}ـ]/gu, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Leading phrases that name an agent to talk to ("ask Obada ..."). Matched with a space after them. */
export const ASK_PREFIXES = table('ask', 'tell', 'اسال', 'قل ل', 'قول ل', 'خلي')

/**
 * English hums and hesitation sounds, cut when the user turns filler removal on. Compared after letter runs of three or
 * more fold to two ("ummm" is "umm"). Never a sound that can mean yes ("mhm", "uh-huh").
 */
export const FILLER_WORDS = table('uh', 'uhh', 'um', 'umm', 'uhm', 'uhmm', 'er', 'erm', 'ah', 'ahh', 'hm', 'hmm', 'mm')
// Arabic hums need three or more م ("ممم", "اممم") or alefs ("ااا"): "مم" is مِمَّ and "امم" is أمم, and "اه" means yes.
const ARABIC_HUM = /^ا?م{3,}$|^ا{3,}$/u

const FILLERS = new Set(FILLER_WORDS)

const END_MARKS = /[.?!؟…]/gu
const TERMINAL = /[.?!؟…]$/u
const PRONOUN_I = new Set(['i', 'im', 'ive', 'id', 'ill'])

/** A hum, not a word that looks like one: an abbreviation (ER, UM), a unit ("10 mm") or a name ("Umm Ahmad", "Um Ali"). */
function isFiller(token: string, prev: string | undefined, next: string | undefined): boolean {
  const core = normalizeUtterance(token)
  if (core === '' || core.includes(' ')) return false
  if (ARABIC_HUM.test(core)) return true
  if (!FILLERS.has(core.replace(/(\p{L})\1{2,}/gu, '$1$1'))) return false
  const letters = token.replace(/[^\p{L}]/gu, '')
  if (letters.length >= 2 && letters === letters.toUpperCase()) return false
  if (core === 'mm' && prev !== undefined && /\d$/u.test(prev)) return false
  // A hum before a name carries a comma; a bare one before a capital is the kunya (Umm/Um), unless the capital is "I".
  if (
    (core === 'um' || core === 'umm') &&
    /^\p{L}+$/u.test(token) &&
    next !== undefined &&
    /^\p{Lu}/u.test(next) &&
    !PRONOUN_I.has(normalizeUtterance(next))
  )
    return false
  return true
}

/** Upper-cases the first letter of an all-lowercase word; a mixed-case one (iPhone, eBay) is left alone. */
function capitalised(word: string): string {
  const letters = word.replace(/[^\p{L}]/gu, '')
  return letters !== '' && letters === letters.toLowerCase() && letters !== letters.toUpperCase()
    ? word.replace(/\p{L}/u, (c) => c.toUpperCase())
    : word
}

/**
 * Drops standalone hums with the punctuation they carry, as a reader would: a dropped sentence end ("go, um.") moves onto
 * the word before, a dropped mid-sentence comma takes the one before it ("to, uh, go"), a capitalised hum at a sentence
 * start passes its capital on, and line breaks stay. Text with no hum comes back exactly as it was.
 */
export function stripFillers(text: string): string {
  const toks: { sep: string; tok: string }[] = []
  let sep = ''
  for (const part of text.split(/(\s+)/)) {
    if (/^\s+$/.test(part)) sep = part
    else if (part !== '') {
      toks.push({ sep, tok: part })
      sep = ''
    }
  }
  const kept: { sep: string; tok: string }[] = []
  let dropped = false
  let capNext = false
  let carry: string | null = null // the separator a dropped run leaves; a line break in it wins
  for (let i = 0; i < toks.length; i++) {
    const { sep: before, tok } = toks[i]!
    const prev = kept[kept.length - 1]
    if (!isFiller(tok, prev?.tok, toks[i + 1]?.tok)) {
      const gap = carry === null ? before : ([carry, before].find((x) => x.includes('\n')) ?? ' ')
      kept.push({ sep: gap, tok: capNext ? capitalised(tok) : tok })
      capNext = false
      carry = null
      continue
    }
    dropped = true
    if (/^\p{Lu}/u.test(tok) && (prev === undefined || TERMINAL.test(prev.tok) || before.includes('\n'))) capNext = true
    carry = carry !== null && carry.includes('\n') ? carry : before
    if (!prev) continue
    const end = (tok.match(END_MARKS) ?? []).join('')
    if (end !== '') {
      if (!TERMINAL.test(prev.tok)) prev.tok = prev.tok.replace(/[,،;:]+$/u, '') + end
    } else if (/[,،]$/u.test(tok)) prev.tok = prev.tok.replace(/[,،]+$/u, '')
  }
  if (!dropped) return text
  return kept.map((k, i) => (i === 0 ? '' : k.sep) + k.tok).join('')
}
