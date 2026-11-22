import { displayName } from '@zumibot/shared/frontmatter'
import { NOTICE_TEXT, type PausedRoom, type QueueEntry, type QueueReason } from '@zumibot/shared/types'

export interface ModeratorPick {
  agent: string
  after: string[]
  note: string | null
}
export interface ModeratorAnswer {
  next: ModeratorPick[]
  drop: string[]
  skip: string[]
  askUser: boolean
}

export interface PlanInput {
  answer: ModeratorAnswer | null // null = moderator failed
  mentioned: string[] // available members the message mentions, mention order
  speaker: string | null // null = the user
  queue: QueueEntry[]
  working: string[]
  unrouted: string[] // members whose finished reply waits for the moderator, besides the speaker routed now
  available: string[] // current members whose agent file exists
  lastAgent: string | null // the member who spoke last, if any
  everyone: boolean // the user's message is for @everyone: the role decides who acts, not the mentions
}

export interface Plan {
  queue: QueueEntry[] // the whole new queue
  added: string[] // members newly queued by this plan, in queue order
  notes: Record<string, string> // moderator notes for picked members
  notice: string | null
}

const uniq = (names: string[]): string[] => [...new Set(names)]

/** Merges a moderator answer into the stored queue (spec §6.3 filter). */
export function planQueue(i: PlanInput): Plan {
  const avail = new Set(i.available)
  const working = new Set(i.working)
  const oldAgents = new Set(i.queue.map((e) => e.agent))
  // Everyone working, queued or with a reply not routed yet when planning starts: working first, then queue order.
  const busy = uniq([...i.working, ...i.queue.map((e) => e.agent), ...i.unrouted])
  const mentioned = uniq(i.mentioned.filter((n) => avail.has(n)))

  // Picks: from the answer, or on a failed moderator the mentioned one after another.
  let picks: ModeratorPick[]
  let drop = new Set<string>()
  let moderatorPicks: string[] = [] // the answer's own picks, not the forced mentions
  if (i.answer) {
    picks = i.answer.next.filter((p) => avail.has(p.agent))
    moderatorPicks = picks.map((p) => p.agent)
    // A member's mention the moderator calls only agreement is no request; the user's mentions always run.
    const skipped = new Set(i.speaker === null ? [] : i.answer.skip)
    for (const m of mentioned) if (!skipped.has(m) && !picks.some((p) => p.agent === m)) picks.push({ agent: m, after: busy, note: null })
    drop = new Set(i.answer.drop.filter((n) => oldAgents.has(n) && (!mentioned.includes(n) || skipped.has(n))))
  } else {
    // @everyone with no moderator: all members one after another, so nothing runs unplanned in parallel.
    const chain = i.everyone ? uniq([...i.available.filter((n) => n !== i.speaker), ...mentioned]) : mentioned
    picks = chain.map((m, k) => ({ agent: m, after: k === 0 ? busy : [chain[k - 1]], note: null }))
  }

  // Existing entries keep their place; dropped members and the waits on them go.
  const entries: QueueEntry[] = i.queue
    .filter((e) => !drop.has(e.agent))
    .map((e) => ({ agent: e.agent, after: e.after.filter((n) => !drop.has(n)) }))
  const pickedNames = new Set(picks.map((p) => p.agent))
  // A member whose reply is not routed yet is not done: its reply may start a discussion or a hand-off to the user.
  const allowed = new Set([...working, ...entries.map((e) => e.agent), ...pickedNames, ...i.unrouted])
  const keepWait = (agent: string, n: string) => allowed.has(n) && (n !== agent || working.has(agent))

  const notes: Record<string, string> = {}
  const placed = new Set<string>() // members that got or kept an entry through a pick
  const addPick = (p: ModeratorPick) => {
    const after = p.after.filter((n) => keepWait(p.agent, n))
    // The speaker only comes back when it waits for someone, or it would answer itself.
    if (p.agent === i.speaker && after.length === 0) return
    placed.add(p.agent)
    const entry = entries.find((e) => e.agent === p.agent)
    if (entry) entry.after = uniq([...entry.after, ...after])
    else entries.push({ agent: p.agent, after: uniq(after) })
    if (p.note && !notes[p.agent]) notes[p.agent] = p.note
  }
  for (const p of picks) addPick(p)

  const addedNow = () => entries.filter((e) => !oldAgents.has(e.agent))
  // No role rule fit @everyone: every member answers, side by side.
  // A moderator pick already waiting in the queue counts: the plan did queue it for this message.
  if (i.everyone && i.answer && !moderatorPicks.some((n) => placed.has(n))) {
    for (const n of i.available) if (n !== i.speaker && !entries.some((e) => e.agent === n)) addPick({ agent: n, after: busy, note: null })
  }

  // A user message nobody was added for still gets an answer; @everyone has its own rules above.
  let fallback: string | null = null
  if (!i.everyone && i.speaker === null && mentioned.length === 0 && addedNow().length === 0) {
    const free = (n: string) => !entries.some((e) => e.agent === n)
    fallback = (i.lastAgent !== null && avail.has(i.lastAgent) && free(i.lastAgent) ? i.lastAgent : i.available.find(free)) ?? null
    if (fallback !== null) addPick({ agent: fallback, after: busy, note: null })
  }

  // A queued member that is working waits for its own current turn.
  for (const e of entries) if (working.has(e.agent)) e.after = uniq([...e.after, e.agent])

  // Break loops in queue order: skip a wait when its target already waits for this member.
  const accepted = new Map<string, Set<string>>()
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true
    if (seen.has(from)) return false
    seen.add(from)
    return [...(accepted.get(from) ?? [])].some((n) => reaches(n, target, seen))
  }
  for (const e of entries) {
    const kept: string[] = []
    for (const n of e.after) {
      if (n === e.agent || !reaches(n, e.agent)) {
        kept.push(n)
        if (n !== e.agent) accepted.set(e.agent, (accepted.get(e.agent) ?? new Set()).add(n))
      }
    }
    e.after = kept
  }

  for (const name of Object.keys(notes)) if (!entries.some((e) => e.agent === name)) delete notes[name]

  let notice: string | null = null
  if (i.answer === null) {
    notice = fallback !== null ? `${NOTICE_TEXT.moderator.slice(0, -1)}, so ${displayName(fallback)} answers.` : NOTICE_TEXT.moderator
  }
  return { queue: entries, added: addedNow().map((e) => e.agent), notes, notice }
}

/** Entries that may start now: not working, and every wait is fully done (spec §6.2 step 3). */
export function readyEntries(queue: readonly QueueEntry[], working: ReadonlySet<string>, unrouted: ReadonlySet<string>): QueueEntry[] {
  return queue.filter(
    (e) =>
      !working.has(e.agent) &&
      e.after.every((m) => m === e.agent || (!working.has(m) && !unrouted.has(m) && !queue.some((q) => q.agent === m)))
  )
}

/** A reason with the member that asked for the turn renamed. */
export const renameReason = (why: QueueReason, rn: (n: string) => string): QueueReason =>
  why.kind === 'agent' ? { ...why, by: rn(why.by) } : why

/** A paused room's saved state with every member name renamed: who worked, the queue and its waits, and the reasons. */
export function renamePaused(p: PausedRoom, rn: (n: string) => string): PausedRoom {
  return {
    members: p.members.map(rn),
    queue: p.queue.map((e) => ({ agent: rn(e.agent), after: e.after.map(rn) })),
    ...(p.reasons ? { reasons: Object.fromEntries(Object.entries(p.reasons).map(([n, why]) => [rn(n), renameReason(why, rn)])) } : {})
  }
}
