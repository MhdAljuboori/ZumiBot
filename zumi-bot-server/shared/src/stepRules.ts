import { confirmOnly } from './automations'
import { PLAN_TOOL } from './plans'
import { QUESTION_TOOL } from './questions'
import { NAME_MAX, STEP_RULES_MAX, STEP_RULE_COMMAND_MAX, STEP_RULE_TOOL_MAX, type StepRule } from './workflows'

/**
 * Tools that always need the user's own answer, so a step rule can never allow them. A process start is kept per command and
 * folder, which a step rule cannot say: refused rather than saved as a rule that never matches.
 */
export const stepRuleRefused = (tool: string): boolean =>
  tool === QUESTION_TOOL || tool === PLAN_TOOL || confirmOnly(tool) || tool === 'mcp__zumibot_processes__start'

export const sameStepRule = (a: StepRule, b: StepRule): boolean =>
  a.tool === b.tool &&
  (a.command ?? null) === (b.command ?? null) &&
  (a.unsandboxed ?? false) === (b.unsandboxed ?? false) &&
  (a.agent ?? null) === (b.agent ?? null)

/** The rules plus `r`, unless one the same is already there. */
export const withStepRule = (rules: readonly StepRule[] | undefined, r: StepRule): StepRule[] =>
  (rules ?? []).some((x) => sameStepRule(x, r)) ? [...(rules ?? [])] : [...(rules ?? []), r]

/**
 * Whether one rule's own keys would be stored: the parser's check (parseRules) and a card's (stepRuleFits), on untyped input.
 * A command only on Bash, `unsandboxed` only true and only on Bash, never a tool that must always ask.
 */
export function stepRuleShapeOk(o: { tool?: unknown; command?: unknown; unsandboxed?: unknown; agent?: unknown }): boolean {
  const { tool, command, unsandboxed, agent } = o
  if (typeof tool !== 'string' || !tool || tool.length > STEP_RULE_TOOL_MAX || stepRuleRefused(tool)) return false
  if (tool === 'Bash') {
    if (typeof command !== 'string' || !command || command.length > STEP_RULE_COMMAND_MAX) return false
  } else if (command !== undefined || unsandboxed !== undefined) return false
  if (unsandboxed !== undefined && unsandboxed !== true) return false
  return agent === undefined || agent === null || (typeof agent === 'string' && agent.length <= NAME_MAX)
}

/** Whether the workflow would still save with `rule` added to `existing`: its keys parse, and it is held already or there is room. */
export const stepRuleFits = (rule: StepRule, existing: readonly StepRule[]): boolean =>
  stepRuleShapeOk(rule) && (existing.some((x) => sameStepRule(x, rule)) || existing.length < STEP_RULES_MAX)

/** The rule "Allow for this workflow step" adds for a call: its tool (a Bash call by exact command) and the member who asked. */
export function stepRuleOf(toolName: string, input: unknown, agent: string): StepRule {
  if (toolName !== 'Bash') return { tool: toolName, agent }
  const cmd = (input as { command?: unknown } | null)?.command
  const unsandboxed = (input as { dangerouslyDisableSandbox?: unknown } | null)?.dangerouslyDisableSandbox === true
  return {
    tool: toolName,
    ...(typeof cmd === 'string' ? { command: cmd } : {}),
    ...(unsandboxed ? { unsandboxed: true as const } : {}),
    agent
  }
}
