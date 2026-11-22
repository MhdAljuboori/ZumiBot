import { describe, expect, it } from 'vitest'
import { stepRuleKey, stepRuleOf, stepRulesAllow } from '../../src/core/workflows/stepRules'
import { agentAllowKey } from '../../src/core/chat/controlProtocol'

describe('stepRulesAllow', () => {
  it('a rule with only a tool allows any call of it by any member', () => {
    const rules = [{ tool: 'Edit' }]
    expect(stepRulesAllow(rules, 'a', 'Edit', { file_path: '/x' })).toBe(true)
    expect(stepRulesAllow(rules, 'b', 'Edit', { file_path: '/y' })).toBe(true)
    expect(stepRulesAllow(rules, 'a', 'Write', {})).toBe(false)
  })

  it("a rule with an agent allows that member's call only", () => {
    const rules = [{ tool: 'Edit', agent: 'a' }]
    expect(stepRulesAllow(rules, 'a', 'Edit', {})).toBe(true)
    expect(stepRulesAllow(rules, 'b', 'Edit', {})).toBe(false)
  })

  it('a Bash rule matches its exact command, sandboxed', () => {
    const rules = [{ tool: 'Bash', command: 'ls' }]
    expect(stepRulesAllow(rules, 'a', 'Bash', { command: 'ls' })).toBe(true)
    expect(stepRulesAllow(rules, 'a', 'Bash', { command: 'ls -la' })).toBe(false)
    expect(stepRulesAllow(rules, 'a', 'Bash', { command: 'ls', dangerouslyDisableSandbox: true })).toBe(false)
  })

  it('an unsandboxed Bash rule allows only the unsandboxed call', () => {
    const rules = [{ tool: 'Bash', command: 'ls', unsandboxed: true as const }]
    expect(stepRulesAllow(rules, 'a', 'Bash', { command: 'ls', dangerouslyDisableSandbox: true })).toBe(true)
    expect(stepRulesAllow(rules, 'a', 'Bash', { command: 'ls' })).toBe(false)
  })

  it('never allows a question, a plan or a confirm-only delete, even from a rule written past the parser', () => {
    const rules = [{ tool: 'AskUserQuestion' }, { tool: 'ExitPlanMode' }, { tool: 'mcp__zumibot_automations__routine_delete' }]
    expect(stepRulesAllow(rules, 'a', 'AskUserQuestion', q())).toBe(false)
    expect(stepRulesAllow(rules, 'a', 'ExitPlanMode', {})).toBe(false)
    expect(stepRulesAllow(rules, 'a', 'mcp__zumibot_automations__routine_delete', { id: 'x', name: 'y' })).toBe(false)
  })

  it('a rule key is the key an agent rule would have', () => {
    expect(stepRuleKey({ tool: 'Bash', command: 'ls' })).toBe(agentAllowKey('Bash', { command: 'ls' }))
    expect(stepRuleKey({ tool: 'Bash', command: 'ls', unsandboxed: true })).toBe(
      agentAllowKey('Bash', { command: 'ls', dangerouslyDisableSandbox: true })
    )
    expect(stepRuleKey({ tool: 'Edit' })).toBe(agentAllowKey('Edit', { file_path: '/z' }))
  })
})

const q = () => ({ questions: [] })

describe('stepRuleOf', () => {
  it('a Bash call gives its command, and unsandboxed when it ran outside the sandbox', () => {
    expect(stepRuleOf('Bash', { command: 'ls', dangerouslyDisableSandbox: true }, 'a')).toEqual({
      tool: 'Bash',
      command: 'ls',
      unsandboxed: true,
      agent: 'a'
    })
    expect(stepRuleOf('Bash', { command: 'ls' }, 'a')).toEqual({ tool: 'Bash', command: 'ls', agent: 'a' })
  })

  it('any other tool gives its name and the agent only', () => {
    expect(stepRuleOf('mcp__w__x', { a: 1 }, 'a')).toEqual({ tool: 'mcp__w__x', agent: 'a' })
  })
})
