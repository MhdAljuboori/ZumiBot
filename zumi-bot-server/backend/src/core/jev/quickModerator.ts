import type { ModeratorAnswer } from '../chat/groupQueue'
import { moderatorPrompt, type ModeratorInput } from '../chat/moderator'
import type { JevClient, JevQuestion } from './jevClient'

export const NOBODY = 'nobody'
const SURE = 0.85
const UNLIKELY = 0.2

const none = (askUser: boolean): ModeratorAnswer => ({ next: [], drop: [], skip: [], askUser })

/**
 * Settles the easy routing cases with Jev before the Haiku moderator runs: in an idle room, one member answers, or
 * nobody needs to. Null means "ask the moderator": Jev was unsure, failed, or the case needs waits, notes or a plan.
 */
export async function quickModerate(
  decide: JevClient['decide'],
  input: ModeratorInput,
  signal?: AbortSignal
): Promise<ModeratorAnswer | null> {
  const fromUser = input.speaker === null
  // Busy rooms need waits; @everyone needs a plan; several mentions may need an order; an agent's mention may be
  // agreement only (skip). All of that is the moderator's.
  if (input.everyone || input.working.length > 0 || input.queue.length > 0) return null
  if (input.mentioned.length > (fromUser ? 1 : 0)) return null
  if (input.members.some((m) => m.name === NOBODY)) return null

  const candidates = input.members.filter((m) => m.name !== input.speaker && !input.mentioned.includes(m.name))
  const criteria: Record<string, string> = {}
  for (const m of candidates) criteria[m.name] = m.description || m.name
  criteria[NOBODY] = 'No member needs to act on the latest message.'
  const instructions =
    input.mentioned.length > 0
      ? `The latest message already goes to @${input.mentioned[0]}. Which other member must also act on it now, if any?`
      : fromUser
        ? "Which one member should answer the user's latest message?"
        : `Which one member should act next on @${input.speaker}'s latest message, if any?`
  const questions: Record<string, JevQuestion> = {
    next: { type: 'choice', instructions, criteria },
    several: {
      type: 'noul',
      instructions:
        'Does the latest message need more than one member to act, or a member to wait for another member, by what it says or by the group role?'
    }
  }
  if (!fromUser)
    questions.askUser = { type: 'noul', instructions: 'Does the latest message ask the user to decide something or answer a question?' }

  const answers = await decide(moderatorPrompt(input), questions, signal)
  const next = answers?.next
  const several = answers?.several
  if (next?.type !== 'choice' || several?.type !== 'noul') return null
  if (several.noul > UNLIKELY || (next.probabilities[next.choice] ?? 0) < SURE) return null

  if (!fromUser) {
    const ask = answers?.askUser
    if (ask?.type !== 'noul') return null
    if (ask.noul >= SURE) return next.choice === NOBODY ? none(true) : null
    if (ask.noul > UNLIKELY) return null
  }
  if (next.choice === NOBODY) {
    // A user's message always gets an answer: who gives it is the moderator's call, not "nobody".
    return fromUser && input.mentioned.length === 0 ? null : none(false)
  }
  // Next to a mentioned member, a second one acts at the same time: that is the "several" case Jev just ruled out.
  if (input.mentioned.length > 0) return null
  return { next: [{ agent: next.choice, after: [], note: null }], drop: [], skip: [], askUser: false }
}
