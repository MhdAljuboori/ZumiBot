import type { StepRule } from '@zumibot/shared/workflows'
import { stepRuleOf, stepRuleRefused } from '@zumibot/shared/stepRules'
import { agentAllowKey } from '../chat/controlProtocol'

/** The key an agent rule would have for the call this rule allows, so a step rule matches exactly what "Allow always for this agent" would. */
export function stepRuleKey(r: StepRule): string {
  return agentAllowKey(
    r.tool,
    r.tool === 'Bash' ? { command: r.command, ...(r.unsandboxed ? { dangerouslyDisableSandbox: true } : {}) } : {}
  )
}

/** Whether a Room step's rules let this member's call through without a card. Never a question, a plan or a delete. */
export function stepRulesAllow(rules: readonly StepRule[], agent: string, toolName: string, input: unknown): boolean {
  if (stepRuleRefused(toolName)) return false
  const key = agentAllowKey(toolName, input)
  return rules.some((r) => r.tool === toolName && (r.agent === undefined || r.agent === agent) && stepRuleKey(r) === key)
}

export { stepRuleOf }
