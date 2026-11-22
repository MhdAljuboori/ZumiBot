import { ATTEMPTS_MAX, ATTEMPTS_MIN, type TodoAttempt, type TodoItem } from './todos'
import type { ChatMeta } from './types'

// Pure: the frontend draws the rows from these, and the backend checks the picks with them.

/** What one attempt's chat is doing. Read from its meta plus the approval cards the app already counts. */
export type AttemptState = 'starting' | 'waiting' | 'paused' | 'limited' | 'running' | 'done' | 'stopped' | 'failed' | 'gone'

/** What an attempt row needs of a chat; the app has it all already. */
export type AttemptChat = Pick<ChatMeta, 'id' | 'inFlight' | 'pause' | 'pauseCap' | 'resume' | 'attempt'>

/**
 * An attempt's state. A paused or usage-limited chat is said to be so before anything else: its CLI may still be up
 * with the turn held at a hook, so `inFlight` alone would read as working. An approval card beats running for the same
 * reason the board's column does: the turn is up, but it waits on the user.
 */
export function attemptState(chat: AttemptChat | undefined, cards: number): AttemptState {
  if (!chat) return 'gone'
  if (chat.pause) return 'paused'
  if (chat.resume) return 'limited'
  if (cards > 0) return 'waiting'
  if (chat.inFlight) return 'running'
  const outcome = chat.attempt?.outcome
  if (outcome === undefined) return 'starting'
  return outcome === 'ok' ? 'done' : outcome === 'stopped' ? 'stopped' : 'failed'
}

/** The words on the row. A cap's pause says so, since going on from one is the user's own act. */
export function attemptLabel(state: AttemptState, chat?: AttemptChat): string {
  switch (state) {
    case 'starting':
      return 'Starting…'
    case 'running':
      return 'Working…'
    case 'waiting':
      return 'Needs approval'
    case 'paused':
      return chat?.pauseCap ? 'Paused at a spend cap' : 'Paused'
    case 'limited':
      return 'Waiting for the usage limit'
    case 'done':
      return 'Done'
    case 'stopped':
      return 'Stopped'
    case 'failed':
      return 'Failed'
    case 'gone':
      return 'Chat deleted'
  }
}

/** How the row is drawn: finished, waiting on the user, the agent working, or nothing happening. */
export function attemptTone(state: AttemptState): 'done' | 'you' | 'busy' | 'quiet' {
  if (state === 'done') return 'done'
  if (state === 'waiting' || state === 'paused' || state === 'limited') return 'you'
  return state === 'running' || state === 'starting' ? 'busy' : 'quiet'
}

/** Whether the user still has something to decide about this attempt (so Keep this one is offered). */
export const attemptOpen = (state: AttemptState): boolean => state !== 'gone'

export const NO_PICKS = `Pick ${ATTEMPTS_MIN} to ${ATTEMPTS_MAX} agents.`

/** Why a set of picks cannot run, or null. The same agent twice is fine: two tries at one job. */
export function picksError(picks: readonly { agent: string }[], known: readonly { name: string; error: string | null }[]): string | null {
  if (picks.length < ATTEMPTS_MIN || picks.length > ATTEMPTS_MAX) return NO_PICKS
  for (const p of picks) {
    const agent = known.find((a) => a.name === p.agent)
    if (!agent) return `No agent named ${p.agent}`
    if (agent.error !== null) return `${p.agent} cannot load: fix its file first`
  }
  return null
}

/** The dialog's line about what a set costs: N attempts are N runs of the same work. */
export const costLine = (n: number): string => `${n} attempts run the same work ${n} times, so expect about ${n}× the cost of one.`

/** "3 of 4 done" over the rows. */
export function attemptsLine(states: readonly AttemptState[]): string {
  const done = states.filter((s) => s === 'done').length
  return `${done} of ${states.length} done`
}

/** The title of an attempt's chat: the card, the agent, and which of the set it is. */
export const attemptTitle = (cardTitle: string, a: Pick<TodoAttempt, 'agent' | 'n'>): string => `${cardTitle} · ${a.agent} #${a.n}`

/** Whether the card is in a state where a new set may start, and why not when it is not. */
export function startBlocked(item: TodoItem): string | null {
  if (item.removed !== null) return 'This to-do was removed.'
  if (item.done !== null) return 'This to-do is done. Move it out of Done first.'
  if (item.task) return 'An agent is already working on this card in its own chat.'
  if (item.attempts && item.attempts.winner === undefined) return 'This card already has attempts running. Keep one or cancel them first.'
  return null
}
