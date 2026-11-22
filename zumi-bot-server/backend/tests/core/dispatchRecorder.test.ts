import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DispatchEntry } from '@zumibot/shared/dispatch'
import { DispatchRecorder } from '../../src/core/dispatch/dispatchRecorder'
import { parseLine, type RunEvent } from '../../src/core/chat/streamParser'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const events = (n: string): RunEvent[] => readFileSync(`${fixtures}stream/${n}.jsonl`, 'utf8').split('\n').flatMap(parseLine)

const privateTool = (name: string) =>
  name.startsWith('mcp__zumibot_browser__')
    ? ('browser' as const)
    : name.startsWith('mcp__zumibot_desktop__')
      ? ('desktop' as const)
      : name === 'mcp__zumibot_vault__vault_items'
        ? ('vault' as const)
        : null

function recorder(o: { member?: string } = {}) {
  let t = 1000
  let changes = 0
  const rec = new DispatchRecorder({
    turn: 'turn-1',
    ...o,
    now: () => ++t,
    onChange: () => {
      changes++
    },
    privateTool
  })
  return { rec, changes: () => changes }
}

const byId = (rec: DispatchRecorder, id: string): DispatchEntry => {
  const e = rec.entries().find((x) => x.id === id)
  if (!e) throw new Error(`no entry ${id}`)
  return e
}

const feed = (rec: DispatchRecorder, list: RunEvent[]) => {
  for (const e of list) rec.event(e)
}

describe('DispatchRecorder', () => {
  it('opens one entry per dispatch with prompt, description, type', () => {
    const { rec } = recorder()
    feed(rec, events('dispatch-nested'))
    expect(rec.entries().map((e) => e.id)).toEqual(['toolu_A', 'toolu_B', 'toolu_N'])
    expect(byId(rec, 'toolu_A')).toMatchObject({
      parent: null,
      turn: 'turn-1',
      description: 'Code review ENH-6916 diff',
      subagentType: 'general-purpose',
      prompt: 'You are a Senior Code Reviewer. Review the diff.'
    })
    expect(byId(rec, 'toolu_B').subagentType).toBe('structure-reviewer')
  })

  it('parallel dispatches keep their own steps', () => {
    const { rec } = recorder()
    feed(rec, events('dispatch-nested'))
    const kinds = (id: string) =>
      byId(rec, id).steps.map((s) => (s.kind === 'text' ? `text:${s.text}` : s.kind === 'tool' ? `tool:${s.name}` : s.kind))
    expect(kinds('toolu_A')).toEqual(['text:Looking at the diff.', 'tool:Bash', 'agent', 'text:Review done: no Critical.'])
    expect(kinds('toolu_B')).toEqual(['tool:Read', 'text:Structure fine.'])
    expect(kinds('toolu_N')).toEqual(['text:Searching.', 'tool:Grep', 'text:Found one caller.'])
  })

  it('nested dispatch has parent and an agent step', () => {
    const { rec } = recorder()
    feed(rec, events('dispatch-nested'))
    expect(byId(rec, 'toolu_N')).toMatchObject({
      parent: 'toolu_A',
      description: 'Find callers',
      subagentType: 'Explore',
      prompt: 'Find callers of isVibeAppOpenable.'
    })
    expect(byId(rec, 'toolu_A').steps).toContainEqual(expect.objectContaining({ kind: 'agent', id: 'toolu_N' }))
    // The nested dispatch is not a tool step of its parent.
    expect(byId(rec, 'toolu_A').steps.some((s) => s.kind === 'tool' && s.id === 'toolu_N')).toBe(false)
  })

  it('tool result patches the step and failed Bash is isError', () => {
    const { rec } = recorder()
    feed(rec, events('dispatch-nested'))
    const bash = byId(rec, 'toolu_A').steps.find((s) => s.kind === 'tool' && s.name === 'Bash')
    expect(bash).toMatchObject({
      kind: 'tool',
      id: 'toolu_A1',
      input: { command: 'git diff origin/master...HEAD' },
      result: 'fatal: bad revision',
      isError: true
    })
    expect(bash).toHaveProperty('doneTs')
  })

  it('main tool result ends entry with totals and report', () => {
    const { rec } = recorder()
    feed(rec, events('dispatch-nested'))
    expect(byId(rec, 'toolu_A')).toMatchObject({
      status: 'done',
      now: null,
      report: 'Review done: no Critical.',
      usage: { tokens: 41000, toolUses: 7, durationMs: 72000 }
    })
    expect(byId(rec, 'toolu_A').endedAt).not.toBeNull()
    expect(byId(rec, 'toolu_N')).toMatchObject({
      status: 'done',
      report: 'Found one caller.',
      usage: { tokens: 1000, toolUses: 1, durationMs: 1500 }
    })
    expect(byId(rec, 'toolu_B')).toMatchObject({ status: 'failed', report: null })
  })

  it('task_progress sets now and usage while running', () => {
    const { rec } = recorder()
    const all = events('dispatch-nested')
    const upTo = all.findIndex((e) => e.kind === 'taskProgress')
    feed(rec, all.slice(0, upTo + 1))
    expect(byId(rec, 'toolu_A')).toMatchObject({
      status: 'running',
      now: 'Running git diff',
      usage: { tokens: 41000, toolUses: 1, durationMs: 1200 }
    })
  })

  it('task_updated ends an entry the tool result has not ended yet', () => {
    const { rec } = recorder()
    rec.event({ kind: 'toolUse', id: 'x', name: 'Task', input: { description: 'd', prompt: 'p' } })
    rec.event({ kind: 'taskStarted', toolUseId: 'x', taskId: 'tx', description: null, subagentType: 'Plan', prompt: null })
    rec.event({ kind: 'taskUpdated', taskId: 'tx', status: 'killed', endTime: 5 })
    expect(byId(rec, 'x')).toMatchObject({ status: 'failed', subagentType: 'Plan', endedAt: 5 })
    // A later result does not reopen or change the outcome.
    rec.event({ kind: 'toolResult', toolUseId: 'x', content: 'ok', isError: false })
    expect(byId(rec, 'x').status).toBe('failed')
  })

  it("end('stopped') marks running entries stopped and leaves ended ones", () => {
    const { rec } = recorder()
    const all = events('dispatch-nested')
    feed(rec, all.slice(0, all.findIndex((e) => e.kind === 'toolResult' && e.toolUseId === 'toolu_A') + 1))
    rec.end('stopped')
    expect(byId(rec, 'toolu_A').status).toBe('done')
    expect(byId(rec, 'toolu_B')).toMatchObject({ status: 'stopped', now: null })
    expect(byId(rec, 'toolu_B').endedAt).not.toBeNull()
  })

  it('browser tool input and result are hidden, desktop result too', () => {
    const { rec } = recorder()
    rec.event({ kind: 'toolUse', id: 'x', name: 'Agent', input: { description: 'd', prompt: 'p' } })
    rec.event({
      kind: 'subToolUse',
      parent: 'x',
      id: 'b',
      name: 'mcp__zumibot_browser__navigate',
      input: { url: 'https://secret' },
      subagent: null
    })
    rec.event({ kind: 'subToolResult', parent: 'x', toolUseId: 'b', content: 'page text', isError: false })
    rec.event({
      kind: 'subToolUse',
      parent: 'x',
      id: 'd',
      name: 'mcp__zumibot_desktop__desktop_click',
      input: { x: 1, y: 2 },
      subagent: null
    })
    rec.event({ kind: 'subToolResult', parent: 'x', toolUseId: 'd', content: 'image', isError: true })
    const steps = byId(rec, 'x').steps
    expect(steps[0]).toMatchObject({ input: {}, result: 'Browser command completed.' })
    expect(steps[1]).toMatchObject({ input: { x: 1, y: 2 }, result: 'Desktop command failed.', isError: true })
  })

  it("a subagent's vault_items result is reduced to the item names, like the chat row", () => {
    const { rec } = recorder()
    rec.event({ kind: 'toolUse', id: 'x', name: 'Agent', input: { description: 'd', prompt: 'p' } })
    for (const [id, content, isError] of [
      [
        'v1',
        JSON.stringify([
          { id: 'secret-id-1', kind: 'login', name: 'Gmail', sites: ['mail.google.com'], username: 'bob@x.com' },
          { id: 'secret-id-2', kind: 'apiKey', name: 'Azure PAT', env: 'AZURE_PAT', description: 'devops token' }
        ]),
        false
      ],
      ['v2', 'Vault unavailable', true]
    ] as const) {
      rec.event({ kind: 'subToolUse', parent: 'x', id, name: 'mcp__zumibot_vault__vault_items', input: {}, subagent: null })
      rec.event({ kind: 'subToolResult', parent: 'x', toolUseId: id, content, isError })
    }
    const steps = byId(rec, 'x').steps
    expect(steps[0]).toMatchObject({ result: 'Checked the vault (2 items): Gmail, Azure PAT', isError: false })
    expect(steps[1]).toMatchObject({ result: 'Vault command failed.', isError: true })
    const text = JSON.stringify(rec.entries())
    for (const secret of ['secret-id-1', 'bob@x.com', 'mail.google.com', 'AZURE_PAT', 'devops token']) expect(text).not.toContain(secret)
  })

  it('caps long text and results', () => {
    const { rec } = recorder()
    rec.event({ kind: 'toolUse', id: 'x', name: 'Agent', input: { description: 'd', prompt: 'p'.repeat(60_000) } })
    rec.event({ kind: 'subText', parent: 'x', text: 't'.repeat(30_000) })
    rec.event({ kind: 'subToolUse', parent: 'x', id: 'r', name: 'Read', input: {}, subagent: null })
    rec.event({ kind: 'subToolResult', parent: 'x', toolUseId: 'r', content: 'r'.repeat(30_000), isError: false })
    const e = byId(rec, 'x')
    expect(e.prompt.endsWith('… 10000 more characters')).toBe(true)
    expect(e.steps[0]).toMatchObject({ text: 't'.repeat(20_000) + '… 10000 more characters' })
    expect(e.steps[1]).toMatchObject({ result: 'r'.repeat(20_000) + '… 10000 more characters' })
  })

  it('a SubagentHandback call is the report, not a step, and the result pointing at it does not replace it', () => {
    const { rec } = recorder()
    const long = 'r'.repeat(30_000) // past the 20 000 input cap, under the report's 50 000
    rec.event({ kind: 'toolUse', id: 'x', name: 'Agent', input: { description: 'd', prompt: 'p' } })
    rec.event({ kind: 'subToolUse', parent: 'x', id: 'g', name: 'Grep', input: { pattern: 'a' }, subagent: null })
    rec.event({
      kind: 'subToolUse',
      parent: 'x',
      id: 'h',
      name: 'SubagentHandback',
      input: { message: `## Found\n${long}` },
      subagent: null
    })
    rec.event({ kind: 'subToolResult', parent: 'x', toolUseId: 'h', content: '{"success":true}', isError: false })
    expect(byId(rec, 'x')).toMatchObject({ status: 'running', report: `## Found\n${long}` })
    rec.event({
      kind: 'toolResult',
      toolUseId: 'x',
      isError: false,
      content: 'pointer',
      detail: {
        content: [{ type: 'text', text: 'This agent\'s report was delivered to you as a message from "a1".' }],
        totalToolUseCount: 2
      }
    })
    const e = byId(rec, 'x')
    expect(e).toMatchObject({ status: 'done', report: `## Found\n${long}`, usage: { toolUses: 2 } })
    expect(e.steps.map((s) => (s.kind === 'tool' ? s.name : s.kind))).toEqual(['Grep'])
  })

  it('a SubagentHandback call without a message stays a step', () => {
    const { rec } = recorder()
    rec.event({ kind: 'toolUse', id: 'x', name: 'Agent', input: { description: 'd', prompt: 'p' } })
    rec.event({ kind: 'subToolUse', parent: 'x', id: 'h', name: 'SubagentHandback', input: { message: '  ' }, subagent: null })
    expect(byId(rec, 'x')).toMatchObject({ report: null, steps: [expect.objectContaining({ kind: 'tool', name: 'SubagentHandback' })] })
  })

  it('stamps the member and follows its rename', () => {
    const { rec } = recorder({ member: 'alice' })
    rec.event({ kind: 'toolUse', id: 'x', name: 'Agent', input: { description: 'd', prompt: 'p' } })
    expect(byId(rec, 'x').member).toBe('alice')
    rec.rename('alice', 'bob')
    expect(byId(rec, 'x').member).toBe('bob')
  })

  it('ignores lines for unknown dispatches and other tools of the agent', () => {
    const { rec, changes } = recorder()
    rec.event({ kind: 'toolUse', id: 'r', name: 'Read', input: {} })
    rec.event({ kind: 'subText', parent: 'nobody', text: 'x' })
    rec.event({ kind: 'toolResult', toolUseId: 'r', content: 'x', isError: false })
    expect(rec.entries()).toEqual([])
    expect(changes()).toBe(0)
    expect(rec.has('r')).toBe(false)
  })

  it('an ordinary repeated Claude taskStarted keeps the completed report and status', () => {
    const { rec } = recorder()
    rec.event({ kind: 'toolUse', id: 'x', name: 'Agent', input: {} })
    const start: RunEvent = { kind: 'taskStarted', toolUseId: 'x', taskId: 'tx', description: null, subagentType: null, prompt: null }
    rec.event(start)
    rec.event({ kind: 'toolResult', toolUseId: 'x', content: 'report', isError: false, detail: { content: 'report' } })
    rec.event(start)
    expect(byId(rec, 'x')).toMatchObject({ status: 'done', report: 'report' })
  })

  it('onChange fires per change', () => {
    const { rec, changes } = recorder()
    rec.event({ kind: 'toolUse', id: 'x', name: 'Agent', input: { description: 'd', prompt: 'p' } })
    rec.event({ kind: 'subText', parent: 'x', text: 'a' })
    expect(changes()).toBe(2)
    expect(rec.has('x')).toBe(true)
  })
})

// A Codex subagent whose activity ended `interrupted` (R21) was cut off, not failed: it ends `interrupted`, as an entry the
// turn's end cut off does. Only the mapper sets `cut`; a Claude task_updated never carries it.
describe('DispatchRecorder: a dispatch cut off', () => {
  const start = (rec: DispatchRecorder) => {
    rec.event({ kind: 'toolUse', id: 'sp', name: 'Agent', input: { description: 'helper', subagent_type: 'codex' } })
    rec.event({ kind: 'taskStarted', toolUseId: 'sp', taskId: 'th', description: 'helper', subagentType: 'codex', prompt: null })
  }
  it('a cut taskUpdated ends it interrupted, and its error result then keeps that outcome and adds the report', () => {
    const { rec } = recorder()
    start(rec)
    rec.event({ kind: 'taskUpdated', taskId: 'th', status: 'interrupted', endTime: null, cut: true })
    expect(byId(rec, 'sp')).toMatchObject({ status: 'interrupted', now: null })
    rec.event({ kind: 'toolResult', toolUseId: 'sp', content: 'half done', isError: true, detail: { content: 'half done' } })
    expect(byId(rec, 'sp')).toMatchObject({ status: 'interrupted', report: 'half done' })
  })
  it('a Claude task_updated with the same status and no cut is read as before: it closes nothing, and the error result fails it', () => {
    const { rec } = recorder()
    start(rec)
    rec.event({ kind: 'taskUpdated', taskId: 'th', status: 'interrupted', endTime: null })
    expect(byId(rec, 'sp').status).toBe('running')
    rec.event({ kind: 'toolResult', toolUseId: 'sp', content: 'x', isError: true })
    expect(byId(rec, 'sp').status).toBe('failed')
    // And every status Claude's parser can give keeps its old meaning.
    const { rec: r2 } = recorder()
    start(r2)
    r2.event({ kind: 'taskUpdated', taskId: 'th', status: 'killed', endTime: 5 })
    expect(byId(r2, 'sp')).toMatchObject({ status: 'failed', endedAt: 5 })
  })
})
