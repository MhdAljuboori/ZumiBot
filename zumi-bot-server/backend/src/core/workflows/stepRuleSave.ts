import { sameStepRule, stepRuleFits, withStepRule } from '@zumibot/shared/stepRules'
import type { StepRule, Workflow, WorkflowInput } from '@zumibot/shared/workflows'
import type { ChatStore } from '../store/chatStore'
import type { WorkflowStore } from './workflowStore'

export interface StepRuleSaveDeps {
  chats: Pick<ChatStore, 'get' | 'patchInPlace'>
  workflows: Pick<WorkflowStore, 'get'>
  save(input: WorkflowInput): Promise<unknown>
}

const inputOf = (w: Workflow): WorkflowInput => ({
  id: w.id,
  name: w.name,
  enabled: w.enabled,
  timeZone: w.timeZone,
  trigger: w.trigger,
  steps: w.steps,
  edges: w.edges,
  notes: w.notes,
  groups: w.groups,
  // save clears what the input leaves out, so the run settings must ride along.
  ...(w.spendCap !== undefined ? { spendCap: w.spendCap } : {}),
  ...(w.limitPolicy ? { limitPolicy: w.limitPolicy } : {}),
  ...(w.missedPolicy ? { missedPolicy: w.missedPolicy } : {})
})

/**
 * "Allow for this step" on a card in a Room step's copy: the rule goes on the copy (so its later turns, and a restart, keep it)
 * and on the step of the saved workflow (so the next run's copy starts with it). One chain does every read-then-write, so two
 * answers close together both land, in the copy and in the workflow's one save.
 */
export function stepRuleSaver(d: StepRuleSaveDeps): (chatId: string, rule: StepRule) => Promise<void> {
  let chain: Promise<unknown> = Promise.resolve()
  const run = async (chatId: string, rule: StepRule): Promise<void> => {
    const meta = await d.chats.get(chatId)
    const link = meta?.workflow
    if (!meta || !link) return
    // The chat answering checks this too; here it is the belt, since a rule the workflow can't keep would fail every later save of it.
    if (!stepRuleFits(rule, meta.workflowRules ?? [])) return
    // patchInPlace: one queued read-modify-write that keeps `updatedAt`, so the sidebar order never moves for a rule.
    await d.chats.patchInPlace(chatId, (cur) =>
      (cur.workflowRules ?? []).some((r) => sameStepRule(r, rule)) ? null : { workflowRules: withStepRule(cur.workflowRules, rule) }
    )
    // A workflow deleted since leaves the copy updated and nothing to save.
    const w = await d.workflows.get(link.workflowId)
    const step = w?.steps.find((s) => s.id === link.stepId)
    if (!w || !step || step.kind !== 'room') return
    if ((step.rules ?? []).some((r) => sameStepRule(r, rule)) || !stepRuleFits(rule, step.rules ?? [])) return
    await d.save({ ...inputOf(w), steps: w.steps.map((s) => (s === step ? { ...step, rules: withStepRule(step.rules, rule) } : s)) })
  }
  return (chatId, rule) => {
    const next = chain.then(() => run(chatId, rule))
    chain = next.catch(() => undefined)
    return next
  }
}
