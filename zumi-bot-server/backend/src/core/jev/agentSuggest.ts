import type { JevClient } from './jevClient'

export const NO_AGENT = 'none'
export const SUGGEST_TEXT_MAX = 2_000
const LIKELY = 0.6
// A choice question takes at most 255 options; one is the "none" option.
const MAX_AGENTS = 254

/** The agent Jev thinks fits a new chat's first message, or null. */
export async function suggestAgent(
  decide: JevClient['decide'],
  text: string,
  agents: readonly { name: string; description: string }[]
): Promise<string | null> {
  if (agents.length === 0 || agents.some((a) => a.name === NO_AGENT)) return null
  const criteria: Record<string, string> = {}
  for (const a of agents.slice(0, MAX_AGENTS)) criteria[a.name] = a.description || a.name
  criteria[NO_AGENT] = 'None of these agents fits the message.'
  const answers = await decide(
    { message: text.slice(0, SUGGEST_TEXT_MAX) },
    { agent: { type: 'choice', instructions: 'A user starts a new chat with `message`. Which agent should answer it?', criteria } }
  )
  const a = answers?.agent
  if (a?.type !== 'choice' || a.choice === NO_AGENT) return null
  return (a.probabilities[a.choice] ?? 0) >= LIKELY ? a.choice : null
}
