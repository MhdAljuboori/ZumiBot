import { isAsked } from '@zumibot/shared/agentAsk'
import { isArchived } from '@zumibot/shared/archive'
import { sameStepRule, stepRuleRefused, withStepRule } from '@zumibot/shared/stepRules'
import { isGroup, type ChatMeta } from '@zumibot/shared/types'
import { STEP_RULES_MAX, STEP_RULE_COMMAND_MAX, STEP_RULE_TOOL_MAX, type Step, type StepRule } from '@zumibot/shared/workflows'

/** What an untitled room is called in the picker and on the node. */
export const ROOM_UNTITLED = 'New group chat'

// Rooms a Room step can copy, and the pure text the inspector and the node show. Kept apart from the components.

/** Rooms a step may copy: not archived, not an A to B chat, not a workflow's own copy. The current pick stays listed even once archived. */
export function roomOptions(chats: ChatMeta[], current: string): ChatMeta[] {
  return chats
    .filter((c) => isGroup(c) && !isAsked(c) && c.workflow === undefined && (c.id === current || !isArchived(c)))
    .sort((a, b) => a.title.localeCompare(b.title))
}

/** The red line under the picker: a room that is set but gone, or no longer a room. */
export function roomStepNote(room: string, chats: ChatMeta[]): string | null {
  if (!room) return null
  return chats.some((c) => c.id === room && isGroup(c)) ? null : 'Room not found'
}

export function roomTitleOf(room: string, chats: ChatMeta[]): string | null {
  if (!room) return null
  const c = chats.find((x) => x.id === room && isGroup(x))
  return c ? c.title || ROOM_UNTITLED : null
}

export function ruleText(r: StepRule): string {
  const who = r.agent ? `@${r.agent}` : 'Every member'
  return `${who} · ${r.tool}${r.command ? `: ${r.command}` : ''}${r.unsandboxed ? ' (outside the sandbox)' : ''}`
}

export interface RuleDraft {
  agent: string
  tool: string
  command: string
  unsandboxed: boolean
}

/** Why the add row cannot add yet, or null. The limits are the parser's, so a rule that shows here always saves. */
export function ruleDraftError(d: { tool: string; command: string }): string | null {
  const tool = d.tool.trim()
  if (!tool) return 'Write a tool name'
  if (tool.length > STEP_RULE_TOOL_MAX) return `A tool name is at most ${STEP_RULE_TOOL_MAX} characters`
  if (stepRuleRefused(tool)) return 'Questions, plans and deletes always ask'
  if (tool === 'Bash') {
    const command = d.command.trim()
    if (!command) return 'Write the exact command'
    if (command.length > STEP_RULE_COMMAND_MAX) return `A command is at most ${STEP_RULE_COMMAND_MAX} characters`
  }
  return null
}

/** The exact rule the parser accepts from a draft, or the error to show. A command and the outside-the-sandbox tick belong to Bash only. */
export function draftRule(d: RuleDraft, rules: readonly StepRule[]): { rule: StepRule } | { error: string } {
  const error = ruleDraftError(d)
  if (error !== null) return { error }
  const tool = d.tool.trim()
  const bash = tool === 'Bash'
  const rule: StepRule = {
    tool,
    ...(bash ? { command: d.command.trim() } : {}),
    ...(bash && d.unsandboxed ? { unsandboxed: true as const } : {}),
    ...(d.agent ? { agent: d.agent } : {})
  }
  if (rules.length >= STEP_RULES_MAX && !rules.some((r) => sameStepRule(r, rule)))
    return { error: `A step holds at most ${STEP_RULES_MAX} rules` }
  return { rule }
}

/** The rules after adding a draft (one the same as a kept rule changes nothing). */
export const rulesWith = (rules: readonly StepRule[], rule: StepRule): StepRule[] => withStepRule(rules, rule)

/**
 * A rule saved from a card while the editor holds unsaved edits: the draft takes the rules `latest` has and `base` lacked,
 * for each room step still in all three, and nothing else. A rule the draft removed that `base` held stays removed.
 */
export function mergeRuleAdditions(draft: Step[], base: Step[], latest: Step[]): Step[] {
  const room = (steps: Step[], id: string): StepRule[] | null => {
    const s = steps.find((x) => x.id === id)
    return s?.kind === 'room' ? (s.rules ?? []) : null
  }
  return draft.map((step) => {
    if (step.kind !== 'room') return step
    const was = room(base, step.id)
    const now = room(latest, step.id)
    if (was === null || now === null) return step
    const added = now.filter((r) => !was.some((w) => sameStepRule(w, r)))
    if (added.length === 0) return step
    const rules = added.reduce((acc, r) => withStepRule(acc, r), step.rules ?? [])
    return { ...step, rules }
  })
}
