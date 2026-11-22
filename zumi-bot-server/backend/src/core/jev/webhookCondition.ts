import type { ConditionCheck, WebhookCall } from '@zumibot/shared/routines'
import type { JevClient } from './jevClient'

// Past about 32 kB Jev switches to a slower, less accurate long-context mode.
export const CONDITION_STATE_MAX = 16_000
const MET_AT = 0.5

/** Whether a webhook call meets the routine's condition; met null when Jev could not tell (the run then goes ahead). */
export async function checkCondition(decide: JevClient['decide'], condition: string, call: WebhookCall): Promise<ConditionCheck> {
  const parts = { method: call.method, query: call.query, body: call.body }
  const json = JSON.stringify(parts)
  const state = json.length <= CONDITION_STATE_MAX ? parts : json.slice(0, CONDITION_STATE_MAX)
  const answers = await decide(state, {
    condition: {
      type: 'noul',
      instructions: `The state is an incoming webhook call: its HTTP method, URL query and body. Does this call meet this condition: ${condition}`,
      criteria: { true: 'The call meets the condition.', false: 'The call does not meet the condition.' }
    }
  })
  const a = answers?.condition
  if (a?.type !== 'noul') return { met: null }
  return { met: a.noul >= MET_AT, p: a.noul }
}
