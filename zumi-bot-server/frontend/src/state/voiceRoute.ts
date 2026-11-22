import { displayName } from '@zumibot/shared/agentName'
import { matchAgent } from '@zumibot/shared/agentMatch'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { isRemoteAgent } from '@zumibot/shared/engine'
import type { AgentSummary } from '@zumibot/shared/types'
import type { VoiceTalk } from '@zumibot/shared/voice'
import { ASK_PREFIXES, normalizeUtterance } from '@zumibot/shared/voiceWords'

// The first thing said in a voice request picks the agent. Pure: the machine (voiceTalk.ts) takes the result as an event.
export type VoiceRoute = { kind: 'agent'; agent: string; request: string } | { kind: 'unknown'; named: string } | { kind: 'no-agent' }

export interface Normalized {
  n: string
  start: number[]
  end: number[]
}

/**
 * `normalizeUtterance` plus, per normalized character, where it sat in the original, so the request can be cut from the
 * original text (its casing and script) after matching on the normalized one. Same per-character rules as
 * `normalizeUtterance`; a test pins the two together.
 */
export function normalizeWithMap(text: string): Normalized {
  const out: string[] = []
  const start: number[] = []
  const end: number[] = []
  let i = 0
  for (const ch of text) {
    const s = ch
      .toLowerCase()
      .replace(/[\p{M}ـ]/gu, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/['’‘`]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    for (const c of s) {
      const space = /\s/.test(c)
      if (space && (out.length === 0 || out[out.length - 1] === ' ')) continue
      out.push(space ? ' ' : c)
      start.push(i)
      end.push(i + ch.length)
    }
    i += ch.length
  }
  if (out[out.length - 1] === ' ') {
    out.pop()
    start.pop()
    end.pop()
  }
  return { n: out.join(''), start, end }
}

// "Tell me ...", "قل لي ...": a pronoun object after the prefix is a plain request, not an address to an agent.
const PRONOUNS = new Set(['me', 'us', 'him', 'her', 'them', 'it'])
// Only after the attached "قل ل" / "قول ل": the object-pronoun suffixes (لي, لنا, له, لها, لهم).
const ATTACHED_PRONOUNS = new Set(['ي', 'نا', 'ه', 'ها', 'هم'])

interface Hit {
  phrase: string
  agents: Set<string>
}

/** Every spoken form an agent answers to, normalized: its file name, its display name and its aliases. */
function candidates(agents: readonly AgentSummary[], aliases: Record<string, string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (phrase: string, name: string): void => {
    const p = normalizeUtterance(phrase)
    if (p === '') return
    const set = out.get(p) ?? new Set<string>()
    set.add(name)
    out.set(p, set)
  }
  for (const a of agents) {
    add(a.name, a.name)
    add(displayName(a.name), a.name)
    for (const alias of aliases[a.name] ?? []) add(alias, a.name)
  }
  return out
}

/** The longest phrase `n` has at `pos`, whole words only ("bobby" is not "bob"). */
function longestAt(n: string, pos: number, cands: Map<string, Set<string>>): Hit | null {
  const rest = n.slice(pos)
  let best: Hit | null = null
  for (const [phrase, agents] of cands) {
    if (rest !== phrase && !rest.startsWith(`${phrase} `)) continue
    if (!best || phrase.length > best.phrase.length) best = { phrase, agents }
    // Two phrases of one length that both match are the same text, so they are already merged in `cands`.
  }
  return best
}

/** Edits (insert, delete, change, swap two neighbours) between two strings, by code point so Arabic counts per letter. */
function editDistance(a: string, b: string): number {
  const x = Array.from(a)
  const y = Array.from(b)
  let prev2: number[] = []
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d = Math.min(d, prev2[j - 2]! + 1)
      row.push(d)
    }
    prev2 = prev
    prev = row
  }
  return prev[y.length]!
}

/**
 * Edits a misheard name may carry: none under 5 letters (Bob is not Rob), one from 5, two from 10. Speech-to-text spells
 * unusual names its own way ("Workiom" heard as "workium"), and an alias for each spelling is a chore.
 */
function slack(phrase: string): number {
  const letters = phrase.replace(/ /g, '').length
  return letters >= 10 ? 2 : letters >= 5 ? 1 : 0
}

/**
 * The agent a misheard name after "ask" most likely means: the phrase is compared with the next words (one fewer, as many,
 * or one more, since a name may be split or joined), within `slack`. Only when every phrase that comes that close belongs
 * to one agent; two agents near the same words are unknown, never a guess.
 */
function nearestAt(n: string, pos: number, cands: Map<string, Set<string>>): Hit | null {
  const words = n.slice(pos).split(' ')
  let best: { hit: Hit; dist: number } | null = null
  const near = new Set<string>()
  for (const [phrase, agents] of cands) {
    const max = slack(phrase)
    if (max === 0) continue
    const k = phrase.split(' ').length
    for (const take of [k, k - 1, k + 1]) {
      if (take < 1 || take > words.length) continue
      const said = words.slice(0, take).join(' ')
      const dist = editDistance(said, phrase)
      if (dist > max) continue
      for (const a of agents) near.add(a)
      // The matched span is what was said, so the request starts after it, not after the phrase's own length.
      if (!best || dist < best.dist) best = { hit: { phrase: said, agents }, dist }
    }
  }
  return near.size === 1 ? best!.hit : null
}

// Letters of the original that follow a match and belong to it: diacritics and tatweel.
const TRAILING_MARKS = /^[\p{M}ـ]*/u
const SEPARATORS = /^[\s,،:;.\-–—]+/u
const CONNECTOR = /^(?:to|[أإا]ن)(?=[\s,،]|$)/iu

function requestAfter(text: string, from: number): string {
  let rest = text.slice(from)
  rest = rest.slice(TRAILING_MARKS.exec(rest)![0].length)
  rest = rest.replace(SEPARATORS, '')
  rest = rest.replace(CONNECTOR, '')
  return rest.replace(SEPARATORS, '').trim()
}

/** What was said as the name when no agent matched: up to a "to" / "ان" / comma, else the first three words. */
function namedFrom(text: string, from: number): string {
  const piece = normalizeUtterance(text.slice(from).split(/[,،]/)[0]!)
  const words = piece.split(' ').filter((w) => w !== '')
  const cut = words.findIndex((w) => w === 'to' || w === 'ان')
  return words.slice(0, cut > 0 ? cut : 3).join(' ')
}

function resolve(agents: readonly AgentSummary[], hit: Hit, request: string, named: string): VoiceRoute {
  // The same phrase on two agents is never a guess.
  if (hit.agents.size !== 1) return { kind: 'unknown', named }
  const [name] = [...hit.agents]
  // Broken agents and Zumi Bot are not for voice; matchAgent is the one place that knows.
  const m = matchAgent(name!, agents)
  if (!m.ok) return { kind: 'unknown', named }
  return { kind: 'agent', agent: m.name, request }
}

function defaultRoute(text: string, agents: readonly AgentSummary[], defaultAgent: string | null): VoiceRoute {
  const found = defaultAgent === null || defaultAgent === ZUMI_BOT_NAME ? undefined : agents.find((a) => a.name === defaultAgent)
  if (!found || found.error !== null) return { kind: 'no-agent' }
  return { kind: 'agent', agent: found.name, request: text }
}

/**
 * Where a first utterance goes: "Ask <agent> to ...", "<agent>, ...", else the default agent. A name that is asked for
 * but unknown is `unknown`, never the default: sending it to another agent would be a guess.
 */
export function routeUtterance(
  text: string,
  everyone: readonly AgentSummary[],
  talk: Pick<VoiceTalk, 'defaultAgent' | 'aliases'>
): VoiceRoute {
  // A remote agent is never reached by voice, even one the user names: the name reads as unknown, never as a pick.
  const agents = everyone.filter((a) => !isRemoteAgent(a))
  const { n, start, end } = normalizeWithMap(text)
  const cands = candidates(agents, talk.aliases)
  const origStart = (k: number): number => start[k] ?? text.length
  const matched = (pos: number, hit: Hit): { request: string; named: string } => ({
    request: requestAfter(text, end[pos + hit.phrase.length - 1]!),
    named: hit.phrase
  })

  for (const prefix of ASK_PREFIXES) {
    // "قل ل" is often written attached to the name ("قل لعبادة"), so a prefix ending in a lone ل may run into it.
    let pos: number
    if (n.startsWith(`${prefix} `)) pos = prefix.length + 1
    else if (prefix.endsWith(' ل') && n.startsWith(prefix)) pos = prefix.length
    else continue
    let hit = longestAt(n, pos, cands)
    if (!hit) {
      // Checked after the name match, so an agent literally named "me" still wins.
      const firstWord = n.slice(pos).split(' ')[0]!
      if (PRONOUNS.has(firstWord) || (pos === prefix.length && ATTACHED_PRONOUNS.has(firstWord)))
        return defaultRoute(text, agents, talk.defaultAgent)
      // Only after a prefix: the user did name an agent, so a near spelling is that agent. A vocative stays exact, since
      // any sentence opening with a word and a comma would otherwise risk a match.
      hit = nearestAt(n, pos, cands)
      if (!hit) return { kind: 'unknown', named: namedFrom(text, origStart(pos)) }
    }
    const m = matched(pos, hit)
    return resolve(agents, hit, m.request, m.named)
  }

  // A vocative: a known name straight followed by a comma ("Work Assistant, what is ...").
  const first = longestAt(n, 0, cands)
  if (first) {
    const after = text.slice(end[first.phrase.length - 1]!)
    if (/^[\p{M}ـ]*\s*[,،]/u.test(after)) {
      const m = matched(0, first)
      return resolve(agents, first, m.request, m.named)
    }
  }
  return defaultRoute(text, agents, talk.defaultAgent)
}
