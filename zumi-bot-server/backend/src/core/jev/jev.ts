import { jevActive, type ApprovalRisk, type JevStatus, type JevSwitches } from '@zumibot/shared/jev'
import type { ConditionCheck, WebhookCall } from '@zumibot/shared/routines'
import type { ModeratorAnswer } from '../chat/groupQueue'
import type { ModeratorInput } from '../chat/moderator'
import { suggestAgent } from './agentSuggest'
import { approvalRisk, type RiskRequest } from './approvalRisk'
import type { JevClient } from './jevClient'
import type { JevStore } from './jevStore'
import { quickModerate } from './quickModerator'
import { checkCondition } from './webhookCondition'

/** Every Jev decision ZumiBot makes. Each answers null while Jev or its feature is off, so callers do what they did before Jev. */
export interface Jev {
  moderate(input: ModeratorInput, signal?: AbortSignal): Promise<ModeratorAnswer | null>
  approvalRisk(r: RiskRequest, signal?: AbortSignal): Promise<ApprovalRisk | null>
  suggestAgent(text: string, agents: readonly { name: string; description: string }[]): Promise<string | null>
  /** null = Jev is off: the run starts as it always did, with no check recorded. */
  webhookCondition(condition: string, call: WebhookCall): Promise<ConditionCheck | null>
}

export interface JevDeps {
  store: Pick<JevStore, 'status'>
  client: JevClient
}

export function createJev(d: JevDeps): Jev {
  // Read per decision, so a switch flipped in any tab applies at once. Unreadable reads as off.
  const allowed = async (feature?: Exclude<keyof JevSwitches, 'enabled'>): Promise<boolean> => {
    let s: JevStatus
    try {
      s = await d.store.status()
    } catch {
      return false
    }
    return jevActive(s) && (feature === undefined || s[feature])
  }
  const decide = d.client.decide
  return {
    moderate: async (input, signal) => ((await allowed('moderator')) ? quickModerate(decide, input, signal) : null),
    approvalRisk: async (r, signal) => ((await allowed('approvalRisk')) ? approvalRisk(decide, r, signal) : null),
    suggestAgent: async (text, agents) => ((await allowed('agentSuggest')) ? suggestAgent(decide, text, agents) : null),
    webhookCondition: async (condition, call) => ((await allowed()) ? checkCondition(decide, condition, call) : null)
  }
}
