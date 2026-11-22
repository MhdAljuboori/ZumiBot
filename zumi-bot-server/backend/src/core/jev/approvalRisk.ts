import type { ApprovalRisk } from '@zumibot/shared/jev'
import type { JevClient } from './jevClient'

export const RISK_INPUT_MAX = 4_000
const LIKELY = 0.6
const LEVELS: ApprovalRisk[] = ['low', 'medium', 'high']

export interface RiskRequest {
  toolName: string
  input: unknown
  description: string | null
  reason: string | null
  cwd: string
}

/**
 * Jev's guess of how risky a pending tool call is, or null when it has none. Only ever shown on the card: the input
 * may carry prompt injection, so nothing may allow or deny a call on this guess.
 */
export async function approvalRisk(decide: JevClient['decide'], r: RiskRequest, signal?: AbortSignal): Promise<ApprovalRisk | null> {
  const input = (JSON.stringify(r.input) ?? '').slice(0, RISK_INPUT_MAX)
  const answers = await decide(
    { tool: r.toolName, input, description: r.description ?? '', reason: r.reason ?? '', folder: r.cwd },
    {
      risk: {
        type: 'score',
        instructions: 'An AI agent asks to run this tool call in `folder`. How risky is it to allow it?',
        criteria: [
          'Only reads or looks things up. Changes nothing.',
          'Changes files or state inside the folder in a way that is easy to undo.',
          'Deletes data, changes things outside the folder, needs raised rights, installs software, or sends data to other people or services.'
        ]
      }
    },
    signal
  )
  const a = answers?.risk
  if (a?.type !== 'score') return null
  let best = -1
  let bestP = 0
  LEVELS.forEach((_, i) => {
    const p = a.probabilities[String(i)] ?? 0
    if (p > bestP) {
      best = i
      bestP = p
    }
  })
  return best >= 0 && bestP >= LIKELY ? LEVELS[best]! : null
}
