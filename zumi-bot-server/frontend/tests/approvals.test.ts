import { describe, expect, it } from 'vitest'
import type { ChatMeta } from '@zumibot/shared/types'
import {
  addRuleCheck,
  agentHasPending,
  applyApprovalCount,
  approvalChoices,
  approvalLine,
  connectorSummary,
  isActionable,
  mergeApprovalCounts,
  ruleLabel,
  stepChoiceFor,
  type ApprovalItem
} from '../src/state/approvals'

const item = (status: ApprovalItem['status']): ApprovalItem => ({
  type: 'approval',
  id: 'r1',
  toolUseId: 't1',
  toolName: 'Bash',
  input: { command: 'ls' },
  description: null,
  reason: null,
  status,
  ts: 1
})

describe('approvalLine', () => {
  it('returns the fixed history lines', () => {
    expect(approvalLine('allowed-once')).toBe('Allowed once')
    expect(approvalLine('allowed-chat')).toBe('Allowed for this chat')
    expect(approvalLine('auto-allowed')).toBe('Auto-allowed (earlier "Allow for this chat")')
    expect(approvalLine('denied')).toBe('Denied')
    expect(approvalLine('unanswered')).toBe('Not answered')
    expect(approvalLine('answered')).toBe('Answered')
    expect(approvalLine('skipped')).toBe('Skipped')
    expect(approvalLine('approved')).toBe('Approved')
    expect(approvalLine('sent-back')).toBe('Sent back')
  })
  it('has the agent-wide lines', () => {
    expect(approvalLine('allowed-agent')).toBe('Allowed always for this agent')
    expect(approvalLine('auto-allowed-agent')).toBe('Auto-allowed (remembered for this agent)')
  })
  it('is null for pending', () => {
    expect(approvalLine('pending')).toBeNull()
  })
})

describe('isActionable', () => {
  it('is true only for pending while the chat is running', () => {
    expect(isActionable(item('pending'), true)).toBe(true)
    expect(isActionable(item('allowed-once'), true)).toBe(false)
    expect(isActionable(item('unanswered'), true)).toBe(false)
  })
  it('stale pending card shows Not answered', () => {
    const stale = item('pending')
    expect(isActionable(stale, false)).toBe(false)
    expect(approvalLine(stale.status) ?? 'Not answered').toBe('Not answered')
  })
})

describe('applyApprovalCount', () => {
  it('sets, updates and deletes without mutating', () => {
    const start = { a: 1 }
    const set = applyApprovalCount(start, { chatId: 'b', kind: 'approvals', pending: 2 })
    expect(set).toEqual({ a: 1, b: 2 })
    expect(start).toEqual({ a: 1 })
    expect(applyApprovalCount(set, { chatId: 'b', kind: 'approvals', pending: 1 })).toEqual({ a: 1, b: 1 })
    const del = applyApprovalCount(set, { chatId: 'b', kind: 'approvals', pending: 0 })
    expect(del).toEqual({ a: 1 })
    expect('b' in del).toBe(false)
    expect(set).toEqual({ a: 1, b: 2 })
  })
})

describe('mergeApprovalCounts', () => {
  it("takes the server's counts, which a newest page alone can miss", () => {
    // A card above the chat's newest page: the page saw none, the server counts it.
    expect(mergeApprovalCounts({}, { room: 1, b: 2 }, new Set())).toEqual({ room: 1, b: 2 })
  })
  it('a push since the request is newer: it wins, a 0 included', () => {
    const prev = { a: 3 }
    expect(mergeApprovalCounts(prev, { a: 1, b: 1, c: 2 }, new Set(['a', 'b']))).toEqual({ a: 3, c: 2 })
    expect(prev).toEqual({ a: 3 })
  })
  it('a count from before the request goes, as the snapshot is newer', () => {
    expect(mergeApprovalCounts({ old: 1, a: 1 }, { a: 2 }, new Set())).toEqual({ a: 2 })
  })
  it('drops zero and junk counts', () => {
    expect(mergeApprovalCounts({}, { a: 0, b: -1, c: Number.NaN, d: 1 }, new Set())).toEqual({ d: 1 })
  })
})

describe('agentHasPending', () => {
  const chats = [
    { id: 'a', agentName: 'x' },
    { id: 'b', agentName: 'x' },
    { id: 'c', agentName: 'y' }
  ]
  it('is true when any chat of the agent has pending > 0', () => {
    expect(agentHasPending(chats, 'x', { b: 2 })).toBe(true)
  })
  it('ignores other agents and empty counts', () => {
    expect(agentHasPending(chats, 'x', { c: 1 })).toBe(false)
    expect(agentHasPending(chats, 'x', { a: 0 })).toBe(false)
    expect(agentHasPending(chats, 'x', {})).toBe(false)
  })
})

describe('ruleLabel', () => {
  it('shows the command for Bash', () => {
    expect(ruleLabel({ key: 'k', toolName: 'Bash', command: 'git status' })).toBe('Bash: git status')
  })
  it('shows only the tool name otherwise', () => {
    expect(ruleLabel({ key: 'k', toolName: 'mcp__mail__send', command: null })).toBe('mcp__mail__send')
  })
  it('shows a CLI rule by its prefix or folder', () => {
    expect(ruleLabel({ key: 'k', toolName: 'Bash', command: null, cli: 'Bash(gh pr view:*)' })).toBe('Bash: commands starting with gh pr view')
    expect(ruleLabel({ key: 'k', toolName: 'Read', command: null, cli: 'Read(//work/repo/**)' })).toBe('Read: files in /work/repo')
  })
})

describe('stepChoiceFor', () => {
  const meta = (over: Partial<ChatMeta>): ChatMeta => ({ id: 'c', title: 'c', agentName: 'a', updatedAt: 1, ...over }) as ChatMeta
  const wf = { workflowId: 'w', runId: 'r', stepId: 's', name: 'W' }
  const group = { members: ['a', 'b'], sessions: {}, seen: {}, role: '', active: [], queue: [] }
  it('is true for a workflow room copy only', () => {
    expect(stepChoiceFor(meta({ group, workflow: wf }))).toBe(true)
    expect(stepChoiceFor(meta({ workflow: wf }))).toBe(false)
    expect(stepChoiceFor(meta({ group }))).toBe(false)
    expect(stepChoiceFor(undefined)).toBe(false)
  })
})

describe('approvalChoices', () => {
  it('a routine or workflow delete offers Allow once and Deny only', () => {
    expect(approvalChoices('mcp__zumibot_automations__routine_delete')).toEqual({ chat: false, agent: false, step: false })
    expect(approvalChoices('mcp__zumibot_automations__workflow_delete')).toEqual({ chat: false, agent: false, step: false })
  })
  it('a once-only card (an ACP call no rule may hold) offers Allow once and Deny only, in a workflow room too', () => {
    expect(approvalChoices('AcpCall', { onceOnly: true })).toEqual({ chat: false, agent: false, step: false })
    expect(approvalChoices('AcpEdit', { onceOnly: true, step: true, input: { paths: ['/etc/x'] } })).toEqual({
      chat: false,
      agent: false,
      step: false
    })
    // The same tool without the mark keeps its choices.
    expect(approvalChoices('AcpEdit', { step: true, input: { paths: ['a'] } })).toEqual({ chat: true, agent: true, step: true })
  })
  it('every other tool keeps all choices', () => {
    expect(approvalChoices('Bash')).toEqual({ chat: true, agent: true, step: false })
    expect(approvalChoices('mcp__zumibot_automations__routine_save')).toEqual({ chat: true, agent: true, step: false })
  })
  it('Allow for this step is offered only in a workflow room and never for a question, a plan or a delete', () => {
    expect(approvalChoices('Bash', { step: true }).step).toBe(true)
    expect(approvalChoices('Edit', { step: true }).step).toBe(true)
    expect(approvalChoices('AskUserQuestion', { step: true }).step).toBe(false)
    expect(approvalChoices('ExitPlanMode', { step: true }).step).toBe(false)
    expect(approvalChoices('mcp__zumibot_automations__routine_delete', { step: true }).step).toBe(false)
    expect(approvalChoices('Bash').step).toBe(false)
  })
  it('Allow for this step is hidden for a call whose rule the workflow could not keep', () => {
    expect(approvalChoices('Bash', { step: true, input: { command: 'ls' } }).step).toBe(true)
    expect(approvalChoices('Bash', { step: true, input: { command: 'x'.repeat(5_000) } }).step).toBe(false)
    expect(approvalChoices('Bash', { step: true, input: { command: 7 } }).step).toBe(false)
    expect(approvalChoices('Bash', { step: true, input: {} }).step).toBe(false)
    expect(approvalChoices('Edit', { step: true, input: { file_path: '/x' } }).step).toBe(true)
    expect(approvalChoices('x'.repeat(201), { step: true, input: {} }).step).toBe(false)
  })
})

describe('allowScope', () => {
  it('says what each remembered answer covers, as the server keys it', async () => {
    const { allowScope } = await import('../src/state/approvals')
    expect(allowScope('Bash', 'chat')).toBe('this exact command')
    expect(allowScope('mcp__zumibot_processes__start', 'chat')).toBe('this exact command in this folder')
    expect(allowScope('mcp__zumibot_processes__start', 'agent')).toBe('this exact command in this folder')
    expect(allowScope('mcp__x__y', 'chat')).toBe('any call to mcp__x__y')
    expect(allowScope('Edit', 'chat')).toBeNull()
    expect(allowScope('Edit', 'agent')).toBe('any call to Edit')
  })
  it('never offers a step rule for a process start', async () => {
    const { approvalChoices } = await import('../src/state/approvals')
    expect(approvalChoices('mcp__zumibot_processes__start', { step: true, input: { command: 'x' } })).toEqual({
      chat: true,
      agent: true,
      step: false
    })
  })
})

describe('ruleLabel for a process start', () => {
  it('names the command and the folder it is kept for', () => {
    const key = JSON.stringify(['mcp__zumibot_processes__start', 'npm run dev', 'web'])
    expect(ruleLabel({ key, toolName: 'mcp__zumibot_processes__start', command: 'npm run dev' })).toBe(
      'Start process: npm run dev (in web)'
    )
    expect(
      ruleLabel({
        key: JSON.stringify(['mcp__zumibot_processes__start', 'x', '']),
        toolName: 'mcp__zumibot_processes__start',
        command: 'x'
      })
    ).toBe('Start process: x')
  })
})

describe('connector cards', () => {
  const tool = 'mcp__claude_ai_Gmail__send_message'
  it('offers only Allow once and Deny while the service does not remember', () => {
    expect(approvalChoices(tool, { connector: { remember: false }, step: true })).toEqual({ chat: false, agent: false, step: false })
  })
  it('offers the remembering choices when it does, and never a step', () => {
    expect(approvalChoices(tool, { connector: { remember: true }, step: true })).toEqual({ chat: true, agent: true, step: false })
  })
  it('leaves other cards unchanged', () => {
    expect(approvalChoices(tool, { step: true })).toEqual({ chat: true, agent: true, step: true })
    expect(approvalChoices('Bash')).toEqual({ chat: true, agent: true, step: false })
  })
  it('summarises a stamped card as service and tool, an unstamped one as null', () => {
    const base = { ...item('pending'), toolName: tool }
    expect(connectorSummary({ ...base, connector: { id: 'gmail', tool: 'send_message', remember: false } })).toBe('Gmail · Send message')
    expect(connectorSummary(base)).toBeNull()
    expect(connectorSummary({ ...base, connector: { id: 'slack', tool: 'slack_send_message', remember: false } })).toBe(
      'Slack · Send message'
    )
  })

  it('falls back to the raw id for a service this build does not know', () => {
    const base = { ...item('pending'), toolName: tool }
    const from = { ...base, connector: { id: 'newservice', tool: 'send', remember: false } } as unknown as ApprovalItem
    expect(connectorSummary(from)).toBe('newservice · Send')
  })
})

describe('ruleLabel for a CLI rule', () => {
  it('says which commands the rule allows, not just Bash', () => {
    expect(ruleLabel({ key: '["cli","Bash(git branch -D:*)"]', toolName: 'Bash', command: null, cli: 'Bash(git branch -D:*)' })).toBe(
      'Bash: commands starting with git branch -D'
    )
  })
  it('keeps a CLI rule of another shape readable', () => {
    expect(ruleLabel({ key: 'k', toolName: 'Bash', command: null, cli: 'Bash(npm test)' })).toBe('Bash: Bash(npm test)')
  })
})

describe('addRuleCheck', () => {
  it('gives the rule for a good prefix or folder, trimmed', () => {
    expect(addRuleCheck('prefix', '  gh pr merge ')).toEqual({ rule: 'Bash(gh pr merge:*)', error: null })
    expect(addRuleCheck('folder', ' /work/repo ')).toEqual({ rule: 'Read(//work/repo/**)', error: null })
  })
  it('gives the reason for a bad one, and nothing for an empty field', () => {
    expect(addRuleCheck('prefix', 'sh -c x').error).toMatch(/Auto ignores/)
    expect(addRuleCheck('folder', '~/repo').error).toMatch(/absolute/)
    expect(addRuleCheck('folder', '   ')).toEqual({ rule: null, error: null })
  })
})
