import type { ChatItem, GroupInfo, NextStart, SessionCut } from '@zumibot/shared/types'
import { byEngine, markEngine, sessionMark, type Engine, type Provider } from '@zumibot/shared/engine'

// Where a Claude session should start when the chat is rewound or forked. Pure: reads recorded
// `end` / `cut` marks only.
// engine: the stamp's own (Codex only); absent = Claude. Whoever applies the point sets ChatMeta.sessionEngine (a room member's
// GroupInfo.sessionEngines entry) from it.
export interface StartPoint {
  sessionId: string | null
  next: NextStart | null
  engine?: Provider
}
export interface MemberPoint extends StartPoint {
  seen: string | null
}

const SEED: NextStart = { seed: true }

// A spread, so a Claude stamp gives a point with no `engine` key at all.
const engineOf = (stamp: { engine?: Provider }): { engine?: Provider } => (stamp.engine ? { engine: stamp.engine } : {})

/** The mark a session of this engine carries on a point or stamp, as a spread: none for Claude. */
export const engineField = (engine: Engine): { engine?: Provider } => {
  const mark = sessionMark(engine)
  return mark === undefined ? {} : { engine: mark }
}

/**
 * Whether a reply's turn-end stamp is its cut point: a Codex turn's id is its only one (thread/fork keeps whole turns), while a
 * Claude reply carries a `cut` of its own. ACP has no fork at a point in stable v1 (no `rewind`), so none of its stamps is one;
 * nor AG-UI's, whose rewind is a new thread with the visible items. A Record, so a new engine decides.
 */
const END_IS_CUT: Record<Engine, boolean> = { claude: false, codex: true, acp: false, 'ag-ui': false }
const endCut = (end: SessionCut | undefined): SessionCut | undefined =>
  end !== undefined && byEngine(END_IS_CUT, markEngine(end.engine), false) ? end : undefined

/**
 * The declared turn as the point carries it (`NextStart.drops`), and only for a cut of the same session: the uuid names an
 * entry in that session's own chain, so a stamp from another session, or from Codex, declares nothing.
 */
const dropsOf = (dropped: SessionCut | undefined, session: string): { drops?: string } =>
  dropped !== undefined && dropped.session === session && dropped.engine === undefined ? { drops: dropped.at } : {}

/** A stamp worth declaring: one of this engine's, and one a turn really recorded. */
const declarable = (sent: SessionCut | undefined): SessionCut | undefined =>
  sent !== undefined && sent.engine === undefined ? sent : undefined

/**
 * The turn a cut before `userId` discards, for the caller to pass to `startBefore` — but only when it is the *only* turn that
 * cut discards. The CLI validates the whole discarded range against the one declared turn: a range holding a later turn as
 * well is refused (probed against Claude Code 2.1.325), and a refusal costs the session, so a cut that would discard more
 * declares nothing and runs unvalidated, exactly as every cut did before. `stored` is the chat as the session knows it, not a
 * branched view of it: only there is the discarded turn still visible.
 */
export function droppedTurn(stored: readonly ChatItem[], userId: string): SessionCut | undefined {
  const i = stored.findIndex((it) => it.type === 'user' && it.id === userId)
  if (i < 0) return undefined
  const after = stored.slice(i + 1)
  // A later message means a later turn in the same discarded range, which the CLI would refuse.
  if (after.some((it) => it.type === 'user')) return undefined
  const ends = after.filter((it) => it.end !== undefined)
  return ends.length === 1 ? declarable(ends[0].sent) : undefined
}

/**
 * The same, per room member, for `memberStartsBefore`'s `dropped`: each member's own turns are stamped on its own items, so a
 * member whose session loses exactly one turn declares it and the rest declare nothing. A member may take several turns in one
 * pass (a hop, a mention), and a range holding two of its turns is refused just the same.
 */
export function droppedMembers(stored: readonly ChatItem[], index: number, members: readonly string[]): Record<string, SessionCut> {
  const out: Record<string, SessionCut> = {}
  for (const m of members) {
    const k = lastEndBefore(stored, index, m)
    if (k < 0) continue // nothing of this member's to keep, so the point seeds and declares nothing
    const after = stored.slice(k + 1)
    const ends = after.filter((it) => it.end?.agent === m)
    if (ends.length !== 1) continue // none discarded, or more than one turn in the range
    // Anything of this member's past that turn is work it never ended: the range would hold that too.
    const last = after.lastIndexOf(ends[0])
    if (after.slice(last + 1).some((it) => 'agent' in it && it.agent === m)) continue
    const sent = declarable(ends[0].sent)
    if (sent) out[m] = sent
  }
  return out
}

function lastEndBefore(items: readonly ChatItem[], index: number, agent?: string): number {
  for (let i = Math.min(index, items.length) - 1; i >= 0; i--) {
    const end = items[i].end
    if (end && (agent === undefined || end.agent === agent)) return i
  }
  return -1
}

const hasUser = (items: readonly ChatItem[], from: number, to: number): boolean =>
  items.slice(Math.max(from, 0), Math.max(to, 0)).some((it) => it.type === 'user')

export function startBefore(items: readonly ChatItem[], index: number, dropped?: SessionCut): StartPoint {
  const k = lastEndBefore(items, index)
  // A user message after the last end means that turn never recorded an end, so its session is unusable.
  if (k < 0) return hasUser(items, 0, index) ? { sessionId: null, next: SEED } : { sessionId: null, next: null }
  if (hasUser(items, k + 1, index)) return { sessionId: null, next: SEED }
  const end = items[k].end!
  // `dropped` is the turn the caller means to discard, when it alone is discarded (droppedTurn).
  return { sessionId: end.session, next: { at: end.at, ...dropsOf(dropped, end.session) }, ...engineOf(end) }
}

export function startAfterMessage(items: readonly ChatItem[], index: number): StartPoint {
  const msg = items[index]
  // A Codex reply never gets a cut (its turn id comes only as the turn ends), but the reply that ends its turn carries the
  // turn's end, which thread/fork keeps whole. Any other reply without a cut, a Claude one included, seeds as before.
  const cut = msg?.type !== 'assistant' ? undefined : (msg.cut ?? endCut(msg.end))
  // No declared turn here: this cut falls inside a turn, so what it discards never starts with that turn's own prompt, which
  // is what the CLI validates a declaration against. It cuts unvalidated, as every cut did before.
  return cut ? { sessionId: cut.session, next: { at: cut.at }, ...engineOf(cut) } : { sessionId: null, next: SEED }
}

export function memberStartsBefore(
  items: readonly ChatItem[],
  index: number,
  members: readonly string[],
  dropped: Readonly<Record<string, SessionCut>> = {}
): Record<string, MemberPoint> {
  const out: Record<string, MemberPoint> = {}
  for (const m of members) {
    const k = lastEndBefore(items, index, m)
    if (k >= 0) {
      const end = items[k].end!
      out[m] = {
        sessionId: end.session,
        next: { at: end.at, ...dropsOf(dropped[m], end.session) },
        seen: end.seen ?? null,
        ...engineOf(end)
      }
    } else if (items.slice(0, index).some((it) => it.type === 'assistant' && it.agent === m)) {
      out[m] = { sessionId: null, next: SEED, seen: null }
    } else {
      out[m] = { sessionId: null, next: null, seen: null }
    }
  }
  return out
}

export function memberStartsAfterMessage(
  items: readonly ChatItem[],
  index: number,
  members: readonly string[]
): Record<string, MemberPoint> {
  const msg = items[index]
  const out = memberStartsBefore(items, index + 1, members)
  if (msg?.type !== 'assistant' || !msg.agent) return out
  const a = msg.agent
  // As in startAfterMessage: a Codex member's reply that ends its turn carries the member's own end, which thread/fork keeps whole.
  const cut = msg.cut ?? (msg.end?.agent === a ? endCut(msg.end) : undefined)
  if (!cut) {
    out[a] = { sessionId: null, next: SEED, seen: null }
    return out
  }
  const later = items.slice(index).find((it) => it.end?.agent === a)
  out[a] = { sessionId: cut.session, next: { at: cut.at }, seen: later?.end?.seen ?? null, ...engineOf(cut) }
  return out
}

/**
 * The room's session engines once `points` replace those members' sessions: a member whose point is another engine's session (a Codex thread) is marked,
 * any other member in `points` is cleared (a Claude session, or none). Members not in `points` keep theirs. Undefined when no
 * member is left marked, so the key is dropped.
 */
export function enginesAfter(
  engines: Readonly<Record<string, Provider>> | undefined,
  points: Readonly<Record<string, StartPoint>>,
  rename: (m: string) => string = (m) => m
): Record<string, Provider> | undefined {
  const out: Record<string, Provider> = { ...engines }
  for (const [m, p] of Object.entries(points)) {
    if (p.sessionId !== null && p.engine !== undefined) out[rename(m)] = p.engine
    else delete out[rename(m)]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The room with its session engines replaced, or without the key when no member is marked (stored rooms need no migration). */
export function withSessionEngines(g: GroupInfo, engines: Record<string, Provider> | undefined): GroupInfo {
  const { sessionEngines: _old, ...rest } = g
  return engines ? { ...rest, sessionEngines: engines } : rest
}
