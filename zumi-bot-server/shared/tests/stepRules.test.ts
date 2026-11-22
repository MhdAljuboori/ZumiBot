import { describe, expect, it } from 'vitest'
import { CONFIRM_ONLY_TOOLS } from '../src/automations'
import { sameStepRule, stepRuleFits, stepRuleRefused, withStepRule } from '../src/stepRules'
import { STEP_RULES_MAX, STEP_RULE_COMMAND_MAX, STEP_RULE_TOOL_MAX, type StepRule } from '../src/workflows'
import { NAME_MAX, parseWorkflowInput } from '../src/workflowInput'

describe('step rules', () => {
  it('refuses the tools that must always ask', () => {
    expect(stepRuleRefused('AskUserQuestion')).toBe(true)
    expect(stepRuleRefused('ExitPlanMode')).toBe(true)
    expect(stepRuleRefused(CONFIRM_ONLY_TOOLS[0])).toBe(true)
    expect(stepRuleRefused('Bash')).toBe(false)
  })

  it('tells rules apart by tool, command, sandbox and agent', () => {
    const a = { tool: 'Bash', command: 'ls' }
    expect(sameStepRule(a, { tool: 'Bash', command: 'ls' })).toBe(true)
    expect(sameStepRule(a, { ...a, unsandboxed: true })).toBe(false)
    expect(sameStepRule(a, { ...a, agent: 'a' })).toBe(false)
    expect(sameStepRule(a, { tool: 'Bash', command: 'pwd' })).toBe(false)
    expect(sameStepRule({ tool: 'Edit' }, { tool: 'Write' })).toBe(false)
  })

  it('appends a rule once', () => {
    const r = { tool: 'Bash', command: 'ls' }
    expect(withStepRule(undefined, r)).toEqual([r])
    const once = withStepRule([], r)
    expect(withStepRule(once, { ...r })).toEqual([r])
    expect(withStepRule(once, { tool: 'Edit' })).toEqual([r, { tool: 'Edit' }])
    expect(once).toEqual([r])
  })

  describe('stepRuleFits', () => {
    it('accepts what a card makes', () => {
      expect(stepRuleFits({ tool: 'Bash', command: 'ls', agent: 'a' }, [])).toBe(true)
      expect(stepRuleFits({ tool: 'Bash', command: 'ls', unsandboxed: true }, [])).toBe(true)
      expect(stepRuleFits({ tool: 'Edit', agent: 'a' }, [])).toBe(true)
      expect(stepRuleFits({ tool: 'Bash', command: 'x'.repeat(STEP_RULE_COMMAND_MAX) }, [])).toBe(true)
    })

    it('refuses each thing the parser refuses', () => {
      const bad: unknown[] = [
        { tool: '' },
        { tool: 'x'.repeat(STEP_RULE_TOOL_MAX + 1) },
        { tool: 'AskUserQuestion' },
        { tool: 'ExitPlanMode' },
        { tool: 'Bash' },
        { tool: 'Bash', command: '' },
        { tool: 'Bash', command: 7 },
        { tool: 'Bash', command: 'x'.repeat(STEP_RULE_COMMAND_MAX + 1) },
        { tool: 'Edit', command: 'ls' },
        { tool: 'Edit', unsandboxed: true },
        { tool: 'Bash', command: 'ls', unsandboxed: false },
        { tool: 'Edit', agent: 'a'.repeat(NAME_MAX + 1) },
        { tool: 'Edit', agent: 5 }
      ]
      for (const r of bad) expect(stepRuleFits(r as StepRule, []), JSON.stringify(r).slice(0, 80)).toBe(false)
    })

    it('agrees with parseWorkflowInput on every case', () => {
      const room = (rules: unknown[]) => ({
        id: null,
        name: 'W',
        timeZone: 'UTC',
        trigger: { kind: 'manual' },
        edges: [],
        notes: [],
        groups: [],
        enabled: false,
        steps: [
          { id: 's1', handle: 'trigger', name: 'Trigger', x: 0, y: 0, kind: 'trigger' },
          { id: 's2', handle: 'room', name: 'Room', x: 0, y: 0, kind: 'room', room: 'r', prompt: 'p', rules }
        ]
      })
      const cases: unknown[] = [
        { tool: 'Bash', command: 'ls' },
        { tool: '' },
        { tool: 'Bash' },
        { tool: 'Bash', command: 7 },
        { tool: 'Edit', command: 'ls' },
        { tool: 'Edit', agent: 'a'.repeat(NAME_MAX + 1) },
        { tool: 'Bash', command: 'x'.repeat(STEP_RULE_COMMAND_MAX + 1) },
        { tool: 'AskUserQuestion' }
      ]
      for (const r of cases) {
        let parses = true
        try {
          parseWorkflowInput(room([r]))
        } catch {
          parses = false
        }
        expect(stepRuleFits(r as StepRule, []), JSON.stringify(r).slice(0, 80)).toBe(parses)
      }
    })

    it('stops at the cap, but still takes a rule already held', () => {
      const held: StepRule[] = Array.from({ length: STEP_RULES_MAX }, (_, i) => ({ tool: 'Bash', command: `c${i}` }))
      expect(stepRuleFits({ tool: 'Bash', command: 'new' }, held)).toBe(false)
      expect(stepRuleFits({ tool: 'Bash', command: 'c3' }, held)).toBe(true)
      expect(stepRuleFits({ tool: 'Bash', command: 'new' }, held.slice(1))).toBe(true)
    })
  })
})

describe('process starts', () => {
  it('can never be a step rule: it is kept per command and folder, which a rule cannot say', () => {
    expect(stepRuleRefused('mcp__zumibot_processes__start')).toBe(true)
    expect(stepRuleFits({ tool: 'mcp__zumibot_processes__start' }, [])).toBe(false)
    expect(stepRuleRefused('mcp__zumibot_processes__list')).toBe(false)
  })
})
