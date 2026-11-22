import { describe, expect, it } from 'vitest'
import type { ChatMeta } from '@zumibot/shared/types'
import { STEP_RULES_MAX, STEP_RULE_COMMAND_MAX, STEP_RULE_TOOL_MAX, type Step, type StepRule } from '@zumibot/shared/workflows'
import { parseStep } from '@zumibot/shared/workflowInput'
import { addStep, newWorkflow, stepSummary, toFlow } from '../src/state/workflowCanvas'
import { draftRule, mergeRuleAdditions, roomOptions, roomStepNote, roomTitleOf, ruleDraftError, ruleText } from '../src/state/workflowRoom'

const meta = (id: string, over: Partial<ChatMeta> = {}): ChatMeta => ({ id, title: id, agentName: '', updatedAt: 1, ...over }) as ChatMeta
const room = (id: string, over: Partial<ChatMeta> = {}): ChatMeta =>
  meta(id, { group: { members: ['a', 'b'], sessions: {}, seen: {}, role: '', active: [], queue: [] }, ...over })

describe('roomOptions', () => {
  it('lists live template rooms only, by title', () => {
    const chats = [
      room('r2', { title: 'Beta' }),
      room('r1', { title: 'Alpha' }),
      meta('single'),
      room('old', { archivedAt: 5 }),
      room('ab', { asked: { by: 'a', from: 'x', fromTitle: '', chain: [] } }),
      room('copy', { workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'W' } })
    ]
    expect(roomOptions(chats, '').map((c) => c.id)).toEqual(['r1', 'r2'])
  })
  it('keeps the current room even when archived', () => {
    const chats = [room('old', { archivedAt: 5 }), room('r1', { title: 'A' })]
    expect(
      roomOptions(chats, 'old')
        .map((c) => c.id)
        .sort()
    ).toEqual(['old', 'r1'])
  })
})

describe('roomStepNote', () => {
  const chats = [room('r1'), meta('single')]
  it('is null with no room or a found one', () => {
    expect(roomStepNote('', chats)).toBeNull()
    expect(roomStepNote('r1', chats)).toBeNull()
  })
  it('says Room not found for a missing id or a single chat', () => {
    expect(roomStepNote('gone', chats)).toBe('Room not found')
    expect(roomStepNote('single', chats)).toBe('Room not found')
  })
})

describe('roomTitleOf', () => {
  it('reads the title of a group chat, else null', () => {
    const chats = [room('r1', { title: 'Team' }), meta('single', { title: 'Solo' })]
    expect(roomTitleOf('r1', chats)).toBe('Team')
    expect(roomTitleOf('single', chats)).toBeNull()
    expect(roomTitleOf('', chats)).toBeNull()
    expect(roomTitleOf('r2', [room('r2', { title: '' })])).toBe('New group chat')
  })
})

describe('ruleText', () => {
  it('names the member and the command', () => {
    expect(ruleText({ tool: 'Bash', command: 'npm run build', agent: 'a' })).toBe('@a · Bash: npm run build')
  })
  it('says Every member without an agent', () => {
    expect(ruleText({ tool: 'Edit' })).toBe('Every member · Edit')
  })
  it('marks an unsandboxed rule', () => {
    expect(ruleText({ tool: 'Bash', command: 'ls', unsandboxed: true })).toBe('Every member · Bash: ls (outside the sandbox)')
  })
})

describe('ruleDraftError', () => {
  it('needs a tool', () => expect(ruleDraftError({ tool: ' ', command: '' })).toBe('Write a tool name'))
  it('needs a command for Bash', () => expect(ruleDraftError({ tool: 'Bash', command: '' })).toBe('Write the exact command'))
  it('refuses tools that always ask', () => {
    expect(ruleDraftError({ tool: 'AskUserQuestion', command: '' })).toBe('Questions, plans and deletes always ask')
    expect(ruleDraftError({ tool: 'ExitPlanMode', command: '' })).toBe('Questions, plans and deletes always ask')
  })
  it('accepts a valid draft', () => {
    expect(ruleDraftError({ tool: 'Bash', command: 'ls' })).toBeNull()
    expect(ruleDraftError({ tool: 'Edit', command: '' })).toBeNull()
  })
})

describe('room node summary', () => {
  const step = (room: string): Step => ({ id: 's', handle: 'r', name: 'R', x: 0, y: 0, kind: 'room', room, prompt: '' })
  it('reads the room title, else Pick a room or Room not found', () => {
    const titles = (id: string): string | null => (id === 'r1' ? 'Team' : null)
    expect(stepSummary(step('r1'), titles)).toBe('Team')
    expect(stepSummary(step(''), titles)).toBe('Pick a room')
    expect(stepSummary(step('gone'), titles)).toBe('Room not found')
  })
  it('reads plain Room where no chats are known', () => {
    expect(stepSummary(step('r1'))).toBe('Room')
  })
  it('toFlow hands the resolver to the node data', () => {
    const added = addStep(newWorkflow('UTC'), 'room', { x: 0, y: 0 })
    const w = { ...added.w, steps: added.w.steps.map((x) => (x.id === added.stepId ? { ...x, room: 'r1' } : x)) }
    const flow = toFlow(w, [], undefined, undefined, (id) => (id === 'r1' ? 'Team' : null))
    const node = flow.nodes.find((n) => n.id === added.stepId)
    expect((node?.data as { summary: string }).summary).toBe('Team')
  })
})

describe('ruleDraftError limits', () => {
  it('refuses a tool or command past the parser limits', () => {
    expect(ruleDraftError({ tool: 'x'.repeat(STEP_RULE_TOOL_MAX + 1), command: '' })).toMatch(/at most 200/)
    expect(ruleDraftError({ tool: 'x'.repeat(STEP_RULE_TOOL_MAX), command: '' })).toBeNull()
    expect(ruleDraftError({ tool: 'Bash', command: 'x'.repeat(STEP_RULE_COMMAND_MAX + 1) })).toMatch(/at most 4000/)
    expect(ruleDraftError({ tool: 'Bash', command: 'x'.repeat(STEP_RULE_COMMAND_MAX) })).toBeNull()
  })
})

describe('draftRule', () => {
  const d = { agent: '', tool: 'Edit', command: '', unsandboxed: false }
  it('builds the trimmed rule, dropping Bash-only keys elsewhere', () => {
    expect(draftRule({ ...d, tool: ' Edit ', command: 'ls', unsandboxed: true, agent: 'a' }, [])).toEqual({
      rule: { tool: 'Edit', agent: 'a' }
    })
    expect(draftRule({ ...d, tool: 'Bash', command: ' ls ', unsandboxed: true }, [])).toEqual({
      rule: { tool: 'Bash', command: 'ls', unsandboxed: true }
    })
    expect(draftRule({ ...d, tool: 'Bash', command: 'ls' }, [])).toEqual({ rule: { tool: 'Bash', command: 'ls' } })
  })
  it('returns the draft error', () => {
    expect(draftRule({ ...d, tool: '' }, [])).toEqual({ error: 'Write a tool name' })
    expect(draftRule({ ...d, tool: 'Bash' }, [])).toEqual({ error: 'Write the exact command' })
  })
  it('refuses a rule past the count limit, but not a repeat', () => {
    const rules: StepRule[] = Array.from({ length: STEP_RULES_MAX }, (_, i) => ({ tool: `t${i}` }))
    expect(draftRule({ ...d, tool: 'new' }, rules)).toEqual({ error: `A step holds at most ${STEP_RULES_MAX} rules` })
    expect(draftRule({ ...d, tool: 't3' }, rules)).toEqual({ rule: { tool: 't3' } })
  })
  it('only builds rules the shared parser accepts', () => {
    const step = (rules: StepRule[]): unknown => ({
      id: 's',
      handle: 'r',
      name: 'R',
      x: 0,
      y: 0,
      kind: 'room',
      room: 'r1',
      prompt: '',
      rules
    })
    for (const draft of [
      { ...d, tool: 'Bash', command: ' ls ', unsandboxed: true, agent: 'a' },
      { ...d, tool: ' Edit ', command: 'x', unsandboxed: true }
    ]) {
      const made = draftRule(draft, [])
      if ('error' in made) throw new Error(made.error)
      expect(() => parseStep(step([made.rule]))).not.toThrow()
    }
  })
})

describe('mergeRuleAdditions', () => {
  const rm = (id: string, rules?: StepRule[]): Step =>
    ({ id, handle: id, name: id, x: 0, y: 0, kind: 'room', room: 'r1', prompt: 'p', ...(rules ? { rules } : {}) }) as Step
  const bash: StepRule = { tool: 'Bash', command: 'ls' }
  const edit: StepRule = { tool: 'Edit' }
  it('brings a rule added on the server into the draft', () => {
    const out = mergeRuleAdditions([rm('a', [edit])], [rm('a', [edit])], [rm('a', [edit, bash])])
    expect(out).toEqual([rm('a', [edit, bash])])
  })
  it('works from a step that had no rules', () => {
    expect(mergeRuleAdditions([rm('a')], [rm('a')], [rm('a', [bash])])).toEqual([rm('a', [bash])])
  })
  it('does not bring back a rule the draft removed, which base already had', () => {
    expect(mergeRuleAdditions([rm('a', [])], [rm('a', [bash])], [rm('a', [bash])])).toEqual([rm('a', [])])
  })
  it('ignores a step the draft deleted', () => {
    expect(mergeRuleAdditions([], [rm('a')], [rm('a', [bash])])).toEqual([])
  })
  it('does not duplicate a rule the draft already holds', () => {
    const out = mergeRuleAdditions([rm('a', [bash])], [rm('a')], [rm('a', [bash])])
    expect(out).toEqual([rm('a', [bash])])
  })
  it('leaves other steps and a step new in the draft untouched', () => {
    const other: Step = { id: 'x', handle: 'x', name: 'x', x: 0, y: 0, kind: 'llm', prompt: 'p' } as Step
    const fresh = rm('n')
    const draft = [other, fresh, rm('a')]
    expect(mergeRuleAdditions(draft, [rm('a')], [rm('a', [edit])])).toEqual([other, fresh, rm('a', [edit])])
  })
})
