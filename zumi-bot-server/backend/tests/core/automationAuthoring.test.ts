import { describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { Routine } from '@zumibot/shared/routines'
import { problemsOf } from '@zumibot/shared/workflowGraph'
import type { Step, Workflow, WorkflowInput } from '@zumibot/shared/workflows'
import {
  routineFromAuthoring,
  routineToAuthoring,
  workflowFromAuthoring,
  workflowToAuthoring,
  type AuthoringCtx
} from '../../src/core/automations/authoring'
import { COLUMN_WIDTH } from '../../src/core/automations/layout'
import { parseRoutineInput } from '../../src/core/routines/routineInput'
import { WorkflowStore } from '../../src/core/workflows/workflowStore'
import { workflowEditing } from '../../src/core/workflows/workflowEditing'
import { ACCOUNT_MISSING, WorkflowRunner, type WorkflowRunnerDeps } from '../../src/core/workflows/workflowRunner'

// Each call gets a fresh counter, so an edit's generator first offers ids the saved workflow already holds.
const ctx = (o: { tz?: string; folder?: string; group?: string | null } = {}): AuthoringCtx => {
  let n = 0
  return {
    timeZone: o.tz ?? 'UTC',
    folders: { 'x-expert': o.folder ?? '/home/u/x', 'medium-writer': '/home/u/notes' },
    groupFolder: o.group ?? null,
    home: '/home/u',
    newId: () => `id-${++n}`
  }
}

// The spec's example: Manual → Agent → LLM filter → For each → LLM → Notify.
const hashtagWorkflow = {
  name: 'Daily tech hashtags',
  trigger: { kind: 'manual' },
  steps: [
    { handle: 'find', name: 'Find hashtags', kind: 'agent', agent: 'x-expert', prompt: 'Find new tech hashtags on x.com, one per line.' },
    {
      handle: 'filter',
      name: 'Keep Claude ones',
      kind: 'llm',
      prompt: 'Keep only the Claude-related hashtags, one per line:\n\n{{steps.find.output}}'
    },
    {
      handle: 'each',
      name: 'Write articles',
      kind: 'foreach',
      agent: 'medium-writer',
      prompt: 'Write an article on {{item}}, save it as a new Notion page, end with the page link.'
    },
    { handle: 'links', name: 'Collect links', kind: 'llm', prompt: 'Collect every page link into one list.' },
    { handle: 'tell', name: 'Send links', kind: 'notify', title: 'New articles', body: '{{steps.links.output}}' }
  ],
  edges: [
    { from: 'trigger', to: 'find' },
    { from: 'find', to: 'filter' },
    { from: 'filter', to: 'each' },
    { from: 'each', to: 'links' },
    { from: 'links', to: 'tell' }
  ]
}
type Authored = typeof hashtagWorkflow
// The spec's guard: a Condition whose no port tells the user there was nothing, so For each never runs on an empty list.
const withAnyGuard = (w: Authored) => ({
  ...w,
  steps: [
    ...w.steps,
    { handle: 'any', name: 'Any hashtags?', kind: 'condition', question: 'Is there at least one hashtag?' },
    { handle: 'none', name: 'Nothing today', kind: 'notify', title: 'No Claude hashtags today' }
  ],
  edges: [
    ...w.edges.filter((e) => !(e.from === 'filter' && e.to === 'each')),
    { from: 'filter', to: 'any' },
    { from: 'any', port: 'yes', to: 'each' },
    { from: 'any', port: 'no', to: 'none' }
  ]
})
const withEdge = (edge: { from: string; port?: string; to: string }) => ({ ...hashtagWorkflow, edges: [...hashtagWorkflow.edges, edge] })
const withSteps = (steps: unknown[]) => ({ ...hashtagWorkflow, steps, edges: [] })
const agent = (handle: string) => ({ handle, name: handle, kind: 'agent', agent: 'x-expert', prompt: 'p' })

const asSaved = (w: WorkflowInput): Workflow => ({ ...w, id: w.id ?? 'wf-1', nextRunAt: null, createdAt: 1, updatedAt: 2 })
const stepOf = (w: Pick<Workflow, 'steps'>, handle: string): Step => w.steps.find((s) => s.handle === handle)!
const idOf = (w: Pick<Workflow, 'steps'>, handle: string): string => stepOf(w, handle).id
const moveStepInFixture = (w: Workflow, handle: string, at: { x: number; y: number }): Workflow => ({
  ...w,
  steps: w.steps.map((s) => (s.handle === handle ? { ...s, ...at } : s))
})
const edgeId = (w: Pick<Workflow, 'steps' | 'edges'>, from: string, to: string): string | undefined =>
  w.edges.find((e) => e.from === idOf(w, from) && e.to === idOf(w, to))?.id
// What the bridge's IPC lets through to the agent (Task 8 widens todoIpc's filter to quotes and slashes).
const PLAIN = /^[A-Za-z0-9 .,:;'(){}?"“”/-]{1,400}$/
const refusal = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

const dailyRoutine = {
  name: 'Daily',
  trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  target: { kind: 'new-chat', agent: 'x-expert' },
  prompt: 'p'
}
const storedRoutine = (o: Partial<Routine> = {}): Routine => ({
  id: 'r-1',
  name: 'Hooked',
  enabled: true,
  timeZone: 'Asia/Tokyo',
  trigger: {
    kind: 'webhook',
    sample: { method: 'POST', query: { a: '1' }, body: { secret: 'shh' }, receivedAt: 5 },
    condition: 'a new issue'
  },
  target: { kind: 'new-chat', agent: 'x-expert', cwd: '/srv/app' },
  prompt: 'Handle {{body.title}}',
  command: { agent: 'x-expert', name: 'check' },
  nextRunAt: 99,
  createdAt: 1,
  updatedAt: 7,
  ...o
})

describe('routineFromAuthoring', () => {
  test('routine defaults', () => {
    const r = routineFromAuthoring(dailyRoutine, ctx({ tz: 'Europe/Istanbul', folder: '/home/u/x' }))
    expect(r).toMatchObject({
      id: null,
      enabled: true,
      timeZone: 'Europe/Istanbul',
      target: { cwd: '/home/u/x' },
      limitPolicy: 'wait',
      missedPolicy: 'run-once',
      sessionPolicy: 'continue',
      command: null
    })
  })

  test('a room takes the last group folder, else home; an agent with no folder takes home', () => {
    const room = { ...dailyRoutine, target: { kind: 'new-group', members: ['x-expert', 'medium-writer'], role: '' } }
    expect(routineFromAuthoring(room, ctx({ group: '/srv/room' })).target).toMatchObject({ cwd: '/srv/room' })
    expect(routineFromAuthoring(room, ctx()).target).toMatchObject({ cwd: '/home/u' })
    const other = { ...dailyRoutine, target: { kind: 'new-chat', agent: 'stranger' } }
    expect(routineFromAuthoring(other, ctx()).target).toMatchObject({ cwd: '/home/u' })
    // A name that is an Object.prototype member must not read one.
    const proto = { ...dailyRoutine, target: { kind: 'new-chat', agent: 'constructor' } }
    expect(routineFromAuthoring(proto, ctx()).target).toMatchObject({ cwd: '/home/u' })
  })

  // The tool schema and Zumi Bot's prompt both say a room's role is optional.
  test('a room with no role converts with an empty one, and a given role is kept', () => {
    const room = { ...dailyRoutine, target: { kind: 'new-group', members: ['x-expert', 'medium-writer'] } }
    const r = routineFromAuthoring(room, ctx())
    expect(r.target).toEqual({ kind: 'new-group', members: ['x-expert', 'medium-writer'], role: '', cwd: '/home/u' })
    expect(parseRoutineInput(r)).toEqual(r)
    const blankRole = routineFromAuthoring({ ...room, target: { ...room.target, role: '  ' } }, ctx())
    expect(blankRole.target).toMatchObject({ role: '' })
    const given = routineFromAuthoring({ ...room, target: { ...room.target, role: 'Review the PR' } }, ctx())
    expect(given.target).toMatchObject({ role: 'Review the PR' })
  })

  test("a new chat takes a title, and a room a title and a section; a new chat's section is refused", () => {
    const chat = routineFromAuthoring({ ...dailyRoutine, target: { kind: 'new-chat', agent: 'x-expert', title: 'Morning brief' } }, ctx())
    expect(chat.target).toMatchObject({ kind: 'new-chat', title: 'Morning brief' })
    const room = routineFromAuthoring(
      { ...dailyRoutine, target: { kind: 'new-group', members: ['x-expert', 'medium-writer'], title: 'Standup', section: 's1' } },
      ctx()
    )
    expect(room.target).toMatchObject({ kind: 'new-group', title: 'Standup', section: 's1' })
    expect(
      refusal(() => routineFromAuthoring({ ...dailyRoutine, target: { kind: 'new-chat', agent: 'x-expert', section: 's1' } }, ctx()))
    ).toMatch(/section/)
  })

  test('an existing chat needs no folder', () => {
    const r = routineFromAuthoring({ ...dailyRoutine, target: { kind: 'chat', chatId: 'c-1' } }, ctx())
    expect(r.target).toEqual({ kind: 'chat', chatId: 'c-1' })
  })

  test('what the author set is kept, and a command is always dropped', () => {
    const r = routineFromAuthoring(
      {
        ...dailyRoutine,
        id: 'r-9',
        updatedAt: 3,
        path: '/routines/r-9',
        enabled: false,
        timeZone: 'Asia/Tokyo',
        target: { kind: 'new-chat', agent: 'x-expert', cwd: '/srv/app' },
        prompt: '/check today',
        limitPolicy: 'skip',
        missedPolicy: 'skip',
        sessionPolicy: 'fresh',
        command: { agent: 'x-expert', name: 'check' }
      },
      ctx()
    )
    expect(r).toMatchObject({
      id: 'r-9',
      enabled: false,
      timeZone: 'Asia/Tokyo',
      target: { cwd: '/srv/app' },
      prompt: '/check today',
      limitPolicy: 'skip',
      missedPolicy: 'skip',
      sessionPolicy: 'fresh',
      command: null
    })
  })

  test('refusals are plain sentences', () => {
    const noPrompt = refusal(() => routineFromAuthoring({ ...dailyRoutine, prompt: '' }, ctx()))
    expect(noPrompt).toMatch(/prompt/)
    const typo = refusal(() => routineFromAuthoring({ ...dailyRoutine, limit_policy: 'skip' }, ctx()))
    expect(typo).toMatch(/no field "limit\?policy"/)
    const badTarget = refusal(() =>
      routineFromAuthoring({ ...dailyRoutine, target: { kind: 'new-chat', agent: 'x-expert', chatId: 'c' } }, ctx())
    )
    expect(badTarget).toMatch(/chatId/)
    const notObject = refusal(() => routineFromAuthoring('daily', ctx()))
    for (const m of [noPrompt, typo, badTarget, notObject]) expect(m).toMatch(PLAIN)
  })
})

describe('routineToAuthoring', () => {
  test('routineToAuthoring omits the webhook sample and keeps the condition', () => {
    const a = routineToAuthoring(storedRoutine())
    expect(a).toEqual({
      id: 'r-1',
      updatedAt: 7,
      name: 'Hooked',
      enabled: true,
      timeZone: 'Asia/Tokyo',
      trigger: { kind: 'webhook', condition: 'a new issue' },
      target: { kind: 'new-chat', agent: 'x-expert', cwd: '/srv/app' },
      prompt: 'Handle {{body.title}}',
      limitPolicy: 'wait',
      missedPolicy: 'run-once',
      sessionPolicy: 'continue'
    })
    expect(JSON.stringify(a)).not.toMatch(/sample|shh|secret/)
  })

  test('it reads back through routineFromAuthoring unchanged', () => {
    const r = storedRoutine({ trigger: { kind: 'manual' }, limitPolicy: 'skip', sessionPolicy: 'fresh' })
    const back = routineFromAuthoring(routineToAuthoring(r), ctx())
    expect(back).toEqual({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      timeZone: r.timeZone,
      trigger: r.trigger,
      target: r.target,
      prompt: r.prompt,
      limitPolicy: 'skip',
      missedPolicy: 'run-once',
      sessionPolicy: 'fresh',
      command: null
    })
  })
})

describe('workflowFromAuthoring', () => {
  test('a new workflow: handles become ids, kind defaults are filled, steps are laid out left to right', () => {
    const w = workflowFromAuthoring(hashtagWorkflow, null, ctx({ tz: 'Europe/Istanbul' }))
    expect(w).toMatchObject({
      id: null,
      name: 'Daily tech hashtags',
      enabled: true,
      timeZone: 'Europe/Istanbul',
      trigger: { kind: 'manual' }
    })
    const trigger = w.steps.find((s) => s.kind === 'trigger')!
    expect(trigger).toMatchObject({ handle: 'trigger', name: 'Trigger', x: 0, y: 0 })
    expect(stepOf(w, 'filter')).toMatchObject({ kind: 'llm', model: 'haiku', effort: 'low' })
    expect(w.steps.map((s) => s.x)).toEqual([0, 1, 2, 3, 4, 5].map((c) => c * COLUMN_WIDTH))
    expect(w.steps.every((s) => s.y === 0)).toBe(true)
    expect(w.edges.map((e) => [e.from, e.port, e.to])).toEqual([
      [trigger.id, 'out', idOf(w, 'find')],
      [idOf(w, 'find'), 'out', idOf(w, 'filter')],
      [idOf(w, 'filter'), 'out', idOf(w, 'each')],
      [idOf(w, 'each'), 'out', idOf(w, 'links')],
      [idOf(w, 'links'), 'out', idOf(w, 'tell')]
    ])
    const ids = [...w.steps.map((s) => s.id), ...w.edges.map((e) => e.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('workflow handles become ids and edits keep positions', () => {
    const saved = asSaved(workflowFromAuthoring(hashtagWorkflow, null, ctx()))
    // the user moved `find` on the canvas; the edit adds `none` (notify) after a new `any` (condition)
    const moved = moveStepInFixture(saved, 'find', { x: 40, y: 500 })
    const edited = workflowFromAuthoring(withAnyGuard(hashtagWorkflow), moved, ctx())
    expect(edited.id).toBe(saved.id)
    expect(edited.steps.find((s) => s.handle === 'find')).toMatchObject({ id: idOf(saved, 'find'), x: 40, y: 500 })
    expect(edited.steps.find((s) => s.handle === 'none')!.id).not.toBe(idOf(saved, 'tell'))
    for (const h of ['filter', 'each', 'links', 'tell'])
      expect(stepOf(edited, h)).toMatchObject({ id: idOf(saved, h), x: stepOf(saved, h).x, y: stepOf(saved, h).y })
    expect(edited.steps.find((s) => s.kind === 'trigger')).toEqual(saved.steps.find((s) => s.kind === 'trigger'))
    // An unchanged connection keeps its id; a new one, and every new step, gets an id no saved step or edge ever had.
    expect(edgeId(edited, 'each', 'links')).toBe(edgeId(saved, 'each', 'links'))
    const savedIds = new Set([...saved.steps.map((s) => s.id), ...saved.edges.map((e) => e.id)])
    for (const id of [idOf(edited, 'any'), idOf(edited, 'none'), edgeId(edited, 'filter', 'any')!, edgeId(edited, 'any', 'none')!]) {
      expect(savedIds.has(id)).toBe(false)
    }
    expect(edited.edges.find((e) => e.from === idOf(edited, 'any') && e.to === idOf(edited, 'none'))!.port).toBe('no')
    // The new steps sit right of what feeds them, clear of the steps already there.
    expect(stepOf(edited, 'any').x).toBe(stepOf(saved, 'filter').x + COLUMN_WIDTH)
    expect(stepOf(edited, 'none').x).toBe(stepOf(edited, 'any').x + COLUMN_WIDTH)
    const each = stepOf(edited, 'each'),
      any = stepOf(edited, 'any')
    expect(any.x === each.x && any.y === each.y).toBe(false)
  })

  test("a missing folder follows the agent's last folder, else home", () => {
    const w = workflowFromAuthoring(
      {
        ...hashtagWorkflow,
        steps: [
          ...hashtagWorkflow.steps,
          { handle: 'stray', name: 'Stray', kind: 'agent', agent: 'stranger', prompt: 'p' },
          { handle: 'proto', name: 'Proto', kind: 'foreach', agent: 'toString', prompt: '{{item}}' },
          { handle: 'blank', name: 'Blank', kind: 'agent', agent: 'x-expert', prompt: 'p', cwd: '' },
          { handle: 'set', name: 'Set', kind: 'agent', agent: 'x-expert', prompt: 'p', cwd: '/srv/app' }
        ]
      },
      null,
      ctx()
    )
    expect(stepOf(w, 'find')).toMatchObject({ cwd: '/home/u/x' })
    expect(stepOf(w, 'each')).toMatchObject({ cwd: '/home/u/notes' })
    expect(stepOf(w, 'stray')).toMatchObject({ cwd: '/home/u' })
    expect(stepOf(w, 'proto')).toMatchObject({ cwd: '/home/u' })
    expect(stepOf(w, 'blank')).toMatchObject({ cwd: '/home/u/x' })
    expect(stepOf(w, 'set')).toMatchObject({ cwd: '/srv/app' })
  })

  test('a step left with only its kind gets the canvas defaults', () => {
    const w = workflowFromAuthoring(
      withSteps([
        { handle: 'ok', kind: 'approval' },
        { handle: 'pause', kind: 'wait' },
        { handle: 'ask', kind: 'condition', question: 'q' },
        { handle: 'note', kind: 'notify', title: 't' },
        { handle: 'own', kind: 'agent', agent: 'x-expert', prompt: 'p', model: null }
      ]),
      null,
      ctx()
    )
    expect(stepOf(w, 'ok')).toMatchObject({ name: 'ok', question: 'Approve?', editable: true })
    expect(stepOf(w, 'pause')).toMatchObject({ minutes: 5 })
    expect(stepOf(w, 'ask')).toMatchObject({ model: 'haiku' })
    expect(stepOf(w, 'note')).not.toHaveProperty('body')
    expect(stepOf(w, 'own')).not.toHaveProperty('model')
  })

  test('bad port and repeated handle are refused', () => {
    expect(() => workflowFromAuthoring(withEdge({ from: 'find', port: 'yes', to: 'filter' }), null, ctx())).toThrow(/port/)
    expect(() => workflowFromAuthoring(withSteps([agent('a'), agent('a')]), null, ctx())).toThrow(/handle/)
  })

  test('other mistakes are refused with a plain sentence naming the problem', () => {
    const cases: [unknown, RegExp][] = [
      [withSteps([agent('trigger')]), /handle "trigger" is kept for the trigger/],
      [withSteps([agent('Find Tags')]), /such as "find-tags"/],
      [withSteps([agent('find_tags')]), /such as "find-tags"/],
      [withSteps([{ ...agent('a'), kind: 'trigger' }]), /kind/],
      [withSteps([{ ...agent('a'), model: 'gpt' }]), /model must be opus, sonnet or haiku/],
      [withSteps([{ handle: 'a', kind: 'wait', minutes: 'five' }]), /minutes must be a number/],
      [withSteps([{ handle: 'a', kind: 'llm', prompt: 'p', cwd: '/x' }]), /no field "cwd"/],
      [withEdge({ from: 'nowhere', to: 'filter' }), /comes from "nowhere"/],
      [withEdge({ from: 'find', to: 'trigger' }), /into the trigger/],
      [withEdge({ from: 'find', to: 'find' }), /itself/],
      [{ ...hashtagWorkflow, name: ' ' }, /name/],
      [{ ...hashtagWorkflow, timeZone: 'Mars/Base' }, /time zone/],
      [{ ...hashtagWorkflow, trigger: { kind: 'schedule', schedule: { freq: 'daily' } } }, /schedule/],
      [{ ...hashtagWorkflow, trigger: { kind: 'manual', condition: 'x' } }, /no field "condition"/],
      [{ ...hashtagWorkflow, edges: undefined }, /edges/]
    ]
    for (const [raw, want] of cases) {
      const m = refusal(() => workflowFromAuthoring(raw, null, ctx()))
      expect(m).toMatch(want)
      expect(m).toMatch(PLAIN)
    }
  })

  test('a webhook trigger keeps its filters and never a sample', () => {
    const w = workflowFromAuthoring(
      { ...hashtagWorkflow, trigger: { kind: 'webhook', filters: [{ field: 'body.action', equals: 'opened' }] } },
      null,
      ctx()
    )
    expect(w.trigger).toEqual({ kind: 'webhook', sample: null, filters: [{ field: 'body.action', equals: 'opened' }] })
  })

  test('a repeated connection is kept once', () => {
    const w = workflowFromAuthoring(withEdge({ from: 'find', port: 'out', to: 'filter' }), null, ctx())
    expect(w.edges).toHaveLength(5)
  })
})

describe('workflowToAuthoring', () => {
  const stored = (): Workflow => {
    const w = asSaved(workflowFromAuthoring(withAnyGuard(hashtagWorkflow), null, ctx()))
    return {
      ...w,
      trigger: {
        kind: 'webhook',
        sample: { method: 'POST', query: {}, body: { token: 'shh' }, receivedAt: 1 },
        filters: [{ field: 'body.action', equals: 'opened' }]
      }
    }
  }

  test('it has no step ids, no positions, no trigger step and no webhook sample', () => {
    const w = stored()
    const a = workflowToAuthoring(w)
    expect(a).toMatchObject({ id: w.id, updatedAt: w.updatedAt, name: w.name, enabled: w.enabled, timeZone: w.timeZone })
    expect(a.trigger).toEqual({ kind: 'webhook', filters: [{ field: 'body.action', equals: 'opened' }] })
    expect(a.steps.map((s) => s.handle)).toEqual(['find', 'filter', 'each', 'links', 'tell', 'any', 'none'])
    for (const s of a.steps) {
      expect(Object.keys(s)).not.toContain('id')
      expect(Object.keys(s)).not.toContain('x')
      expect(Object.keys(s)).not.toContain('y')
    }
    expect(a.steps[0]).toEqual({
      handle: 'find',
      name: 'Find hashtags',
      kind: 'agent',
      agent: 'x-expert',
      prompt: 'Find new tech hashtags on x.com, one per line.',
      cwd: '/home/u/x'
    })
    expect(a.edges).toContainEqual({ from: 'trigger', port: 'out', to: 'find' })
    expect(a.edges).toContainEqual({ from: 'any', port: 'no', to: 'none' })
    const text = JSON.stringify(a)
    expect(text).not.toMatch(/sample|shh/)
    for (const s of w.steps) expect(text).not.toContain(s.id)
  })

  test('a trigger the user renamed: its placeholders read {{steps.trigger.output}}, and saving keeps the workflow free of problems', () => {
    // As the editor leaves it after renaming the trigger "GitHub issue": the handle followed the name, and rehandle
    // rewrote every placeholder that named it.
    const base = stored()
    const w: Workflow = {
      ...base,
      steps: base.steps.map((s) => {
        if (s.kind === 'trigger') return { ...s, name: 'GitHub issue', handle: 'github-issue' }
        if (s.handle === 'find') return { ...s, prompt: 'Find hashtags about {{ steps.github-issue.output }}.' }
        if (s.handle === 'tell')
          return { ...s, title: 'From {{steps.github-issue.output}}', body: '{{steps.links.output}} {{steps.github-issue-2.output}}' }
        return s
      })
    }
    const a = workflowToAuthoring(w)
    expect(a.steps.find((s) => s.handle === 'find')).toMatchObject({ prompt: 'Find hashtags about {{ steps.trigger.output }}.' })
    expect(a.steps.find((s) => s.handle === 'tell')).toMatchObject({
      title: 'From {{steps.trigger.output}}',
      body: '{{steps.links.output}} {{steps.github-issue-2.output}}'
    })
    expect(JSON.stringify(a)).not.toContain('steps.github-issue.output')

    const saved = workflowFromAuthoring(a, w, ctx())
    const agents = [
      { name: 'x-expert', error: null },
      { name: 'medium-writer', error: null }
    ]
    const tell = { ...stepOf(saved, 'tell'), body: '{{steps.links.output}}' } as Step // the lookalike above names no step on purpose
    const problems = problemsOf({ ...saved, steps: saved.steps.map((s) => (s.handle === 'tell' ? tell : s)) }, agents, ZUMI_BOT_NAME)
    expect(problems).toEqual([])
    expect(saved.steps.find((s) => s.kind === 'trigger')).toMatchObject({
      id: idOf(w, 'github-issue'),
      handle: 'trigger',
      name: 'GitHub issue'
    })
  })

  test('it round-trips through workflowFromAuthoring to the same steps and edges', () => {
    const w = stored()
    const again = workflowFromAuthoring(workflowToAuthoring(w), w, ctx())
    expect(again.steps).toEqual(w.steps)
    expect(again.edges).toEqual(w.edges)
    expect(again).toMatchObject({ id: w.id, name: w.name, enabled: w.enabled, timeZone: w.timeZone })
  })
})

describe('HTTP request, Transform, Sub-workflow and the failure path in the format', () => {
  const apiFlow = {
    name: 'Check API',
    trigger: { kind: 'manual' },
    steps: [
      {
        handle: 'fetch',
        kind: 'http',
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: [{ name: 'Accept', value: 'application/json' }]
      },
      { handle: 'pick', kind: 'transform', fields: [{ name: 'titles', path: 'items[].title' }], format: 'lines' },
      { handle: 'sub', kind: 'workflow', workflow: 'wf-other', input: '{{input}}' },
      { handle: 'alert', kind: 'notify', title: 'Fetch failed', body: '{{input}}' }
    ],
    edges: [
      { from: 'trigger', to: 'fetch' },
      { from: 'fetch', to: 'pick' },
      { from: 'pick', to: 'sub' },
      { from: 'fetch', port: 'error', to: 'alert' }
    ]
  }

  test('builds the steps, and an error edge turns the failure path on', () => {
    const w = workflowFromAuthoring(apiFlow, null, ctx())
    expect(stepOf(w, 'fetch')).toMatchObject({
      kind: 'http',
      method: 'GET',
      bodyType: 'json',
      headers: [{ name: 'Accept', value: 'application/json' }],
      onFailure: 'branch'
    })
    expect(stepOf(w, 'pick')).toMatchObject({ kind: 'transform', format: 'lines', fields: [{ name: 'titles', path: 'items[].title' }] })
    expect(stepOf(w, 'pick')).not.toHaveProperty('onFailure')
    expect(stepOf(w, 'sub')).toMatchObject({ kind: 'workflow', workflow: 'wf-other', input: '{{input}}' })
    expect(w.edges.find((e) => e.port === 'error')).toMatchObject({ from: idOf(w, 'fetch'), to: idOf(w, 'alert') })
    expect(problemsOf(w, [], ZUMI_BOT_NAME)).toEqual([])
  })

  test('refuses an error edge from a step that never fails by itself, a key, and a bad workflow id', () => {
    expect(() =>
      workflowFromAuthoring({ ...apiFlow, edges: [...apiFlow.edges, { from: 'alert', port: 'error', to: 'pick' }] }, null, ctx())
    ).toThrow('only has the port out')
    expect(() =>
      workflowFromAuthoring(withSteps([{ handle: 'h', kind: 'http', url: 'https://a.example/', key: 'item-1' }]), null, ctx())
    ).toThrow('has no field "key"')
    expect(() => workflowFromAuthoring(withSteps([{ handle: 's', kind: 'workflow', workflow: 'not an id' }]), null, ctx())).toThrow(
      "must be a workflow's id"
    )
  })

  test('an edit keeps the vault key the user picked, and a get shows neither it nor onFailure', () => {
    const saved = asSaved(workflowFromAuthoring(apiFlow, null, ctx()))
    const withKey: Workflow = { ...saved, steps: saved.steps.map((s) => (s.kind === 'http' ? { ...s, key: 'item-1' } : s)) }
    const shown = workflowToAuthoring(withKey)
    expect(JSON.stringify(shown)).not.toContain('item-1')
    expect(JSON.stringify(shown)).not.toContain('onFailure')
    const again = workflowFromAuthoring(shown, withKey, ctx())
    expect(stepOf(again, 'fetch')).toMatchObject({ key: 'item-1', onFailure: 'branch' })
    // Dropping the error edge turns the setting off again.
    const off = workflowFromAuthoring({ ...shown, edges: shown.edges.filter((e) => e.port !== 'error') }, withKey, ctx())
    expect(stepOf(off, 'fetch')).not.toHaveProperty('onFailure')
  })

  test("Allow local network is the user's: a save never turns it on, an edit keeps a stored one, a get never shows it", () => {
    const sent = { ...apiFlow, steps: apiFlow.steps.map((s) => (s.handle === 'fetch' ? { ...s, allowLocalNetwork: true } : s)) }
    expect(stepOf(workflowFromAuthoring(sent, null, ctx()), 'fetch')).not.toHaveProperty('allowLocalNetwork')
    const saved = asSaved(workflowFromAuthoring(apiFlow, null, ctx()))
    expect(stepOf(workflowFromAuthoring(sent, saved, ctx()), 'fetch')).not.toHaveProperty('allowLocalNetwork')
    const local: Workflow = {
      ...saved,
      steps: saved.steps.map((s) => (s.kind === 'http' ? { ...s, allowLocalNetwork: true as const } : s))
    }
    const shown = workflowToAuthoring(local)
    expect(JSON.stringify(shown)).not.toContain('allowLocalNetwork')
    expect(stepOf(workflowFromAuthoring(shown, local, ctx()), 'fetch')).toMatchObject({ allowLocalNetwork: true })
  })
})

describe('For each concurrency in the authoring format', () => {
  const withConcurrency = (c: unknown) => ({
    ...hashtagWorkflow,
    steps: hashtagWorkflow.steps.map((s) => (s.handle === 'each' ? { ...s, concurrency: c } : s))
  })

  test('stores 2 or 3, leaves 1 as no key, and workflow_get hands it back', () => {
    const three = workflowFromAuthoring(withConcurrency(3), null, ctx())
    expect(stepOf(three, 'each')).toMatchObject({ kind: 'foreach', concurrency: 3 })
    expect(workflowToAuthoring(asSaved(three)).steps.find((s) => s.handle === 'each')).toMatchObject({ concurrency: 3 })
    expect(stepOf(workflowFromAuthoring(withConcurrency(1), null, ctx()), 'each')).not.toHaveProperty('concurrency')
  })

  test('refuses anything but 1, 2 or 3 with a sentence the agent can act on', () => {
    const text = refusal(() => workflowFromAuthoring(withConcurrency(4), null, ctx()))
    expect(text).toBe('Step "each": concurrency must be 1, 2 or 3')
    expect(text).toMatch(PLAIN)
    // Only a For each step takes it.
    expect(refusal(() => workflowFromAuthoring(withSteps([{ ...agent('a'), concurrency: 2 }]), null, ctx()))).toMatch(/concurrency/)
  })
})

describe('Room steps in the authoring format', () => {
  const ROOM = '0b6f1d3e-2a4c-4d5e-8f70-123456789abc'
  const roomFlow = (room: unknown = ROOM, extra: object = {}) =>
    withSteps([{ handle: 'panel', name: 'Panel', kind: 'room', room, ...extra }])
  const rule = { tool: 'Bash', command: 'ls' }

  test('a room link or a full URL saves the room id, and the prompt defaults to the input', () => {
    for (const room of [`/chat/${ROOM}`, `https://bot.example.com/chat/${ROOM}`, ROOM]) {
      expect(stepOf(workflowFromAuthoring(roomFlow(room), null, ctx()), 'panel')).toMatchObject({
        kind: 'room',
        room: ROOM,
        prompt: '{{input}}'
      })
    }
    expect(stepOf(workflowFromAuthoring(roomFlow(ROOM, { prompt: 'Review {{input}}' }), null, ctx()), 'panel')).toMatchObject({
      prompt: 'Review {{input}}'
    })
  })

  test('refuses text that names no chat', () => {
    expect(refusal(() => workflowFromAuthoring(roomFlow('the design room'), null, ctx()))).toContain('link')
  })

  test('workflow_get shows no rules, and a roomTitle sent back is dropped', () => {
    const saved = asSaved(workflowFromAuthoring(roomFlow(), null, ctx()))
    const withRules: Workflow = { ...saved, steps: saved.steps.map((s) => (s.kind === 'room' ? { ...s, rules: [rule] } : s)) }
    const shown = workflowToAuthoring(withRules)
    expect(JSON.stringify(shown)).not.toContain('rules')
    const again = workflowFromAuthoring({ ...shown, steps: shown.steps.map((s) => ({ ...s, roomTitle: 'Design' })) }, withRules, ctx())
    expect(stepOf(again, 'panel')).not.toHaveProperty('roomTitle')
  })

  test('an edit keeps the stored room when it is left out, and always the stored rules', () => {
    const saved = asSaved(workflowFromAuthoring(roomFlow(), null, ctx()))
    const withRules: Workflow = { ...saved, steps: saved.steps.map((s) => (s.kind === 'room' ? { ...s, rules: [rule] } : s)) }
    const shown = workflowToAuthoring(withRules)
    const noRoom = workflowFromAuthoring({ ...shown, steps: shown.steps.map((s) => ({ ...s, room: undefined })) }, withRules, ctx())
    expect(stepOf(noRoom, 'panel')).toMatchObject({ room: ROOM, rules: [rule] })
    // Rules the author sends are ignored: only the user adds one.
    const sent = workflowFromAuthoring(
      { ...shown, steps: shown.steps.map((s) => ({ ...s, rules: [{ tool: 'Write' }] })) },
      withRules,
      ctx()
    )
    expect(stepOf(sent, 'panel')).toMatchObject({ rules: [rule] })
    const created = workflowFromAuthoring(roomFlow(ROOM, { rules: [rule] }), null, ctx())
    expect(stepOf(created, 'panel')).not.toHaveProperty('rules')
  })

  test('an edit that points the step at another room drops the stored rules, one that keeps the room keeps them', () => {
    const OTHER = '1c7a2e4f-3b5d-4e6f-9a81-23456789abcd'
    const saved = asSaved(workflowFromAuthoring(roomFlow(), null, ctx()))
    const withRules: Workflow = { ...saved, steps: saved.steps.map((s) => (s.kind === 'room' ? { ...s, rules: [rule] } : s)) }
    const shown = workflowToAuthoring(withRules)
    const to = (room: unknown) => workflowFromAuthoring({ ...shown, steps: shown.steps.map((s) => ({ ...s, room })) }, withRules, ctx())
    expect(stepOf(to(OTHER), 'panel')).toMatchObject({ room: OTHER })
    expect(stepOf(to(OTHER), 'panel')).not.toHaveProperty('rules')
    expect(stepOf(to(`/chat/${ROOM}`), 'panel')).toMatchObject({ room: ROOM, rules: [rule] })
    expect(stepOf(to(undefined), 'panel')).toMatchObject({ room: ROOM, rules: [rule] })
  })

  test('a step that was another kind takes no stored rules', () => {
    const saved = asSaved(workflowFromAuthoring(withSteps([agent('panel')]), null, ctx()))
    expect(stepOf(workflowFromAuthoring(roomFlow(), saved, ctx()), 'panel')).not.toHaveProperty('rules')
  })
})

describe('Chat steps, rooms from agents and Keep in the authoring format', () => {
  const CHAT = '0b6f1d3e-2a4c-4d5e-8f70-123456789abc'
  const one = (step: object, before: Workflow | null = null) =>
    workflowFromAuthoring(withSteps([step]), before, ctx({ group: '/home/u/rooms' }))
  const chatStep = (o: object = {}) => ({ handle: 'post', name: 'Post', kind: 'chat', chat: CHAT, ...o })
  const roomStep = (o: object = {}) => ({ handle: 'panel', name: 'Panel', kind: 'room', members: ['x-expert', 'medium-writer'], ...o })

  test('a chat step takes an id or a link, the prompt defaults to the input, and continue is stored as absent', () => {
    for (const chat of [CHAT, `/chat/${CHAT}`, `https://bot.example.com/chat/${CHAT}`]) {
      expect(stepOf(one(chatStep({ chat })), 'post')).toMatchObject({ kind: 'chat', chat: CHAT, prompt: '{{input}}' })
    }
    expect(stepOf(one(chatStep({ session: 'continue' })), 'post')).not.toHaveProperty('session')
    expect(stepOf(one(chatStep({ session: 'fresh' })), 'post')).toMatchObject({ session: 'fresh' })
    expect(refusal(() => one(chatStep({ session: 'later' })))).toBe('Step "post": session must be continue or fresh')
    expect(refusal(() => one(chatStep({ chat: 'the build chat' })))).toMatch(/link or id/)
  })

  test('a chat step round trips, and its get returns session only when stored', () => {
    const saved = asSaved(one(chatStep({ session: 'fresh' })))
    const shown = workflowToAuthoring(saved)
    expect(shown.steps[0]).toMatchObject({ kind: 'chat', chat: CHAT, session: 'fresh' })
    expect(stepOf(workflowFromAuthoring(shown, saved, ctx()), 'post')).toMatchObject({ chat: CHAT, session: 'fresh' })
    expect(workflowToAuthoring(asSaved(one(chatStep()))).steps[0]).not.toHaveProperty('session')
  })

  test('a room from agents takes members, role, cwd, keep and title; a missing cwd is the last room folder, else home', () => {
    const step = stepOf(one(roomStep({ role: 'Review it', keep: true, title: 'Panel notes' })), 'panel')
    expect(step).toMatchObject({
      kind: 'room',
      room: '',
      members: ['x-expert', 'medium-writer'],
      role: 'Review it',
      cwd: '/home/u/rooms',
      keep: true,
      title: 'Panel notes'
    })
    expect(stepOf(workflowFromAuthoring(withSteps([roomStep()]), null, ctx()), 'panel')).toMatchObject({ cwd: '/home/u', role: '' })
    expect(stepOf(one(roomStep({ cwd: '/work' })), 'panel')).toMatchObject({ cwd: '/work' })
  })

  test('refuses a room that names both, and role or folder on a template room, with a sentence', () => {
    expect(refusal(() => one(roomStep({ room: CHAT })))).toBe('Step "panel": give a room or members, not both')
    expect(refusal(() => one({ handle: 'panel', kind: 'room', room: CHAT, role: 'x' }))).toBe(
      'Step "panel": role and cwd belong to a room built from members'
    )
    expect(refusal(() => one(roomStep({ members: ['x-expert', 'x-expert'] })))).toBe('Step "panel": members names an agent twice')
    expect(refusal(() => one(roomStep({ members: 'x-expert' })))).toBe('Step "panel": members must be a list')
  })

  test('a members room and a kept agent round trip with keep and title, and false or blank keep nothing', () => {
    const w = workflowFromAuthoring(
      withSteps([roomStep({ keep: true, title: 'T' }), { ...agent('a'), keep: true, title: 'Notes' }, { ...agent('b'), keep: false }]),
      null,
      ctx()
    )
    const saved = asSaved(w)
    const shown = workflowToAuthoring(saved)
    expect(shown.steps.find((s) => s.handle === 'panel')).toMatchObject({ members: ['x-expert', 'medium-writer'], keep: true, title: 'T' })
    expect(shown.steps.find((s) => s.handle === 'a')).toMatchObject({ keep: true, title: 'Notes' })
    expect(stepOf(w, 'b')).not.toHaveProperty('keep')
    expect(shown.steps.find((s) => s.handle === 'b')).not.toHaveProperty('keep')
    expect(stepOf(workflowFromAuthoring(shown, saved, ctx()), 'a')).toMatchObject({ keep: true, title: 'Notes' })
    expect(refusal(() => one({ ...agent('a'), keep: 'yes' }))).toBe('Step "a": keep must be true or false')
    expect(refusal(() => one({ ...agent('a'), keep: true, title: 'x'.repeat(101) }))).toContain('title is over 100 characters')
  })

  test('an edit that omits members keeps members, role and cwd, and role alone changes just the role', () => {
    const saved = asSaved(one(roomStep({ role: 'Review it', cwd: '/work' })))
    const shown = workflowToAuthoring(saved)
    const edit = (drop: string[], extra: object = {}) =>
      workflowFromAuthoring(
        {
          ...shown,
          steps: shown.steps.map((s) => ({ ...Object.fromEntries(Object.entries(s).filter(([k]) => !drop.includes(k))), ...extra }))
        },
        saved,
        ctx()
      )
    expect(stepOf(edit(['members', 'role', 'cwd']), 'panel')).toMatchObject({
      room: '',
      members: ['x-expert', 'medium-writer'],
      role: 'Review it',
      cwd: '/work'
    })
    expect(stepOf(edit(['members', 'role', 'cwd'], { cwd: '' }), 'panel')).toMatchObject({
      members: ['x-expert', 'medium-writer'],
      cwd: '/work'
    })
    expect(stepOf(edit(['members', 'role']), 'panel')).toMatchObject({ members: ['x-expert', 'medium-writer'], role: 'Review it' })
    expect(stepOf(edit(['members'], { role: 'Audit it' }), 'panel')).toMatchObject({
      members: ['x-expert', 'medium-writer'],
      role: 'Audit it',
      cwd: '/work'
    })
    // Sending members replaces them, and sending a room switches to a template copy.
    expect(stepOf(edit(['members'], { members: ['x-expert', 'medium-writer', 'extra-one'] }), 'panel')).toMatchObject({
      members: ['x-expert', 'medium-writer', 'extra-one']
    })
    const copy = stepOf(edit(['members', 'role', 'cwd'], { room: CHAT }), 'panel')
    expect(copy).toMatchObject({ room: CHAT })
    expect(copy).not.toHaveProperty('members')
  })

  test('section and command are never in the format, and an edit keeps them', () => {
    const base = asSaved(one(roomStep({ keep: true, prompt: '/review {{input}}' })))
    const stored: Workflow = {
      ...base,
      steps: base.steps.map((s) => (s.kind === 'room' ? { ...s, section: 'sec-1', command: { agent: 'x-expert', name: 'review' } } : s))
    }
    const shown = workflowToAuthoring(stored)
    expect(JSON.stringify(shown)).not.toMatch(/section|command"/)
    expect(refusal(() => workflowFromAuthoring({ ...shown, steps: [{ ...shown.steps[0], section: 's' }] }, stored, ctx()))).toContain(
      'no field "section"'
    )
    expect(stepOf(workflowFromAuthoring(shown, stored, ctx()), 'panel')).toMatchObject({
      section: 'sec-1',
      command: { agent: 'x-expert', name: 'review' }
    })
    // The prompt no longer starts with the command's name: the pick goes. Not kept: no section.
    const moved = workflowFromAuthoring(
      { ...shown, steps: [{ ...shown.steps[0], prompt: 'Review {{input}}', keep: false }] },
      stored,
      ctx()
    )
    expect(stepOf(moved, 'panel')).not.toHaveProperty('command')
    expect(stepOf(moved, 'panel')).not.toHaveProperty('section')
    // A command is kept only while the step keeps its handle.
    const renamed = workflowFromAuthoring({ ...shown, steps: [{ ...shown.steps[0], handle: 'other' }] }, stored, ctx())
    expect(stepOf(renamed, 'other')).not.toHaveProperty('command')
  })

  test('an agent step keeps its stored command while the prompt starts with its name', () => {
    const base = asSaved(one({ ...agent('a'), prompt: '/check {{input}}' }))
    const stored: Workflow = {
      ...base,
      steps: base.steps.map((s) => (s.kind === 'agent' ? { ...s, command: { agent: 'x-expert', name: 'check' } } : s))
    }
    expect(stepOf(workflowFromAuthoring(workflowToAuthoring(stored), stored, ctx()), 'a')).toMatchObject({
      command: { agent: 'x-expert', name: 'check' }
    })
  })

  test('limitPolicy and missedPolicy: wait and run-once are stored as absent, and a get returns them only when skip', () => {
    const w = workflowFromAuthoring({ ...hashtagWorkflow, limitPolicy: 'skip', missedPolicy: 'skip' }, null, ctx())
    expect(w).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'skip' })
    const shown = workflowToAuthoring(asSaved(w))
    expect(shown).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'skip' })
    const plain = workflowFromAuthoring({ ...hashtagWorkflow, limitPolicy: 'wait', missedPolicy: 'run-once' }, null, ctx())
    expect(plain).not.toHaveProperty('limitPolicy')
    expect(plain).not.toHaveProperty('missedPolicy')
    expect(workflowToAuthoring(asSaved(plain))).not.toHaveProperty('limitPolicy')
    expect(refusal(() => workflowFromAuthoring({ ...hashtagWorkflow, limitPolicy: 'stop' }, null, ctx()))).toBe(
      'limitPolicy must be wait or skip'
    )
    expect(refusal(() => workflowFromAuthoring({ ...hashtagWorkflow, missedPolicy: 'wait' }, null, ctx()))).toBe(
      'missedPolicy must be run-once or skip'
    )
  })

  test('a webhook trigger takes a condition, trimmed, and a get shows it only when set', () => {
    const hook = (condition?: unknown) => ({
      ...hashtagWorkflow,
      trigger: { kind: 'webhook', filters: [], ...(condition !== undefined ? { condition } : {}) }
    })
    const w = workflowFromAuthoring(hook('  a new issue  '), null, ctx())
    expect(w.trigger).toMatchObject({ kind: 'webhook', condition: 'a new issue' })
    expect(workflowToAuthoring(asSaved(w)).trigger).toEqual({ kind: 'webhook', filters: [], condition: 'a new issue' })
    expect(workflowFromAuthoring(hook('  '), null, ctx()).trigger).not.toHaveProperty('condition')
    expect(workflowToAuthoring(asSaved(workflowFromAuthoring(hook(), null, ctx()))).trigger).not.toHaveProperty('condition')
    expect(refusal(() => workflowFromAuthoring(hook('x'.repeat(501)), null, ctx()))).toBe("The trigger's condition is over 500 characters")
    expect(
      refusal(() => workflowFromAuthoring({ ...hashtagWorkflow, trigger: { kind: 'manual', condition: 'x' } }, null, ctx()))
    ).toContain('no field "condition"')
  })
})

describe('spend caps in the authoring format', () => {
  const routineIn = { name: 'R', trigger: { kind: 'manual' }, target: { kind: 'new-chat', agent: 'x-expert' }, prompt: 'go' }
  test('a routine takes spendCap, and its get shows the stored one only when set', () => {
    expect(routineFromAuthoring({ ...routineIn, spendCap: 4 }, ctx())).toMatchObject({ spendCap: 4 })
    expect(routineFromAuthoring(routineIn, ctx())).not.toHaveProperty('spendCap')
    expect(() => routineFromAuthoring({ ...routineIn, spendCap: 'lots' }, ctx())).toThrow('spendCap is invalid')
    const stored = {
      ...parseRoutineInput(routineFromAuthoring(routineIn, ctx())),
      id: 'r1',
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 2
    } as unknown as Routine
    expect(routineToAuthoring(stored)).not.toHaveProperty('spendCap')
    expect(routineToAuthoring({ ...stored, spendCap: 9 })).toMatchObject({ spendCap: 9 })
  })
  test('a workflow takes spendCap, and its get shows the stored one only when set', () => {
    const w = workflowFromAuthoring({ ...hashtagWorkflow, spendCap: 12.5 }, null, ctx())
    expect(w.spendCap).toBe(12.5)
    expect(workflowFromAuthoring(hashtagWorkflow, null, ctx())).not.toHaveProperty('spendCap')
    const saved = { ...w, id: 'w1', nextRunAt: null, createdAt: 1, updatedAt: 2 } as Workflow
    expect(workflowToAuthoring(saved).spendCap).toBe(12.5)
    const { spendCap: _gone, ...none } = saved
    expect(workflowToAuthoring(none as Workflow)).not.toHaveProperty('spendCap')
  })
})

describe('event triggers', () => {
  const withTrigger = (trigger: unknown) => ({ ...hashtagWorkflow, trigger })
  const stored = (trigger: Workflow['trigger']): Workflow => ({ ...asSaved(workflowFromAuthoring(hashtagWorkflow, null, ctx())), trigger })
  const emailTrigger = {
    kind: 'email',
    host: 'imap.example.com',
    port: 993,
    folder: 'INBOX',
    filters: [{ field: 'from.address', equals: 'ann@example.com' }]
  }
  const savedEmail = (o: Partial<{ account: string; host: string; port: number; folder: string }> = {}): Workflow =>
    stored({ kind: 'email', account: 'acc-1', host: 'imap.example.com', port: 993, folder: 'INBOX', filters: [], ...o })
  const authored: [string, Record<string, unknown>][] = [
    [
      'reply',
      {
        kind: 'reply',
        filters: [
          { field: 'agent', equals: 'x-expert' },
          { field: 'reply', equals: 'done', op: 'contains' }
        ]
      }
    ],
    ['todo', { kind: 'todo', filters: [] }],
    ['inbox', { kind: 'inbox', filters: [{ field: 'message.title', equals: 'backup', op: 'contains' }] }],
    [
      'file',
      {
        kind: 'file',
        path: '/home/u/invoices',
        pattern: '*.pdf',
        changes: ['added', 'changed'],
        filters: [{ field: 'folder', equals: '/home/u' }]
      }
    ],
    ['email', emailTrigger]
  ]

  test.each(authored)('a %s trigger round-trips authoring, input, authoring', (_kind, trigger) => {
    const input = workflowFromAuthoring(withTrigger(trigger), null, ctx())
    expect(input.trigger).toMatchObject(trigger)
    const back = workflowToAuthoring(asSaved(input))
    expect(back.trigger).toEqual(trigger)
  })

  test('a filter without an op stays without one, and op equals is dropped', () => {
    const w = workflowFromAuthoring(
      withTrigger({
        kind: 'todo',
        filters: [
          { field: 'text', equals: 'x', op: 'equals' },
          { field: 'by', equals: 'user' }
        ]
      }),
      null,
      ctx()
    )
    expect(w.trigger).toEqual({
      kind: 'todo',
      filters: [
        { field: 'text', equals: 'x' },
        { field: 'by', equals: 'user' }
      ]
    })
  })

  test('a webhook filter keeps its op through get', () => {
    const w = stored({
      kind: 'webhook',
      sample: null,
      filters: [
        { field: 'body.title', equals: 'bug', op: 'contains' },
        { field: 'body.a', equals: 'b' }
      ]
    })
    expect(workflowToAuthoring(w).trigger).toEqual({
      kind: 'webhook',
      filters: [
        { field: 'body.title', equals: 'bug', op: 'contains' },
        { field: 'body.a', equals: 'b' }
      ]
    })
  })

  test('file defaults: no pattern is empty and no changes is all three; email defaults: port and folder', () => {
    expect(workflowFromAuthoring(withTrigger({ kind: 'file', path: '/p' }), null, ctx()).trigger).toEqual({
      kind: 'file',
      path: '/p',
      pattern: '',
      changes: ['added', 'changed', 'removed'],
      filters: []
    })
    expect(workflowFromAuthoring(withTrigger({ kind: 'email', host: 'imap.example.com' }), null, ctx()).trigger).toEqual({
      kind: 'email',
      account: '',
      host: 'imap.example.com',
      port: 993,
      folder: 'INBOX',
      filters: []
    })
  })

  test('an email trigger never shows its account, and a get of it round-trips', () => {
    const w = savedEmail()
    const a = workflowToAuthoring(w)
    expect(a.trigger).toEqual({ kind: 'email', host: 'imap.example.com', port: 993, folder: 'INBOX', filters: [] })
    expect(JSON.stringify(a)).not.toContain('acc-1')
    expect(workflowFromAuthoring(a, w, ctx()).trigger).toEqual(w.trigger)
  })

  test('an authored account is refused: it is never invented', () => {
    expect(refusal(() => workflowFromAuthoring(withTrigger({ ...emailTrigger, account: 'acc-9' }), null, ctx()))).toMatch(
      /no field "account"/
    )
  })

  test('a new email trigger has an empty account (the runner reports it as a problem, so the save turns the workflow off)', () => {
    const w = workflowFromAuthoring(withTrigger(emailTrigger), null, ctx())
    expect(w.trigger).toMatchObject({ kind: 'email', account: '' })
  })

  test('an edit keeping host and port keeps the saved account, also when only the folder changes', () => {
    const before = savedEmail()
    const same = workflowFromAuthoring(workflowToAuthoring(before), before, ctx())
    expect(same.trigger).toMatchObject({ account: 'acc-1' })
    const folder = workflowFromAuthoring(withTrigger({ ...emailTrigger, folder: 'Archive' }), before, ctx())
    expect(folder.trigger).toMatchObject({ account: 'acc-1', folder: 'Archive' })
    const upper = workflowFromAuthoring(withTrigger({ ...emailTrigger, host: ' IMAP.Example.COM ' }), before, ctx())
    expect(upper.trigger).toMatchObject({ account: 'acc-1' })
  })

  test('an edit that changes the host or the port clears the account', () => {
    const before = savedEmail()
    expect(workflowFromAuthoring(withTrigger({ ...emailTrigger, host: 'imap.evil.example' }), before, ctx()).trigger).toMatchObject({
      account: ''
    })
    expect(workflowFromAuthoring(withTrigger({ ...emailTrigger, port: 143 }), before, ctx()).trigger).toMatchObject({ account: '' })
  })

  // Past authoring: the save over a real store, its problems from a real runner (which checks the Vault account).
  const throughSaves = async (
    body: (save: (w: WorkflowInput) => ReturnType<ReturnType<typeof workflowEditing>['save']>) => Promise<void>
  ) => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-authoring-'))
    try {
      const store = new WorkflowStore(dir)
      const known = (name: string) => ({
        filePath: `/agents/${name}.md`,
        name,
        description: '',
        color: null,
        icon: null,
        error: null,
        builtIn: false
      })
      const runner = new WorkflowRunner({
        store,
        agents: async () => [known('x-expert'), known('medium-writer')],
        zumiBot: ZUMI_BOT_NAME,
        builtInCwd: () => null,
        dirExists: async () => true,
        vaultKey: () => null,
        mailAccount: (id: string) => (id === 'acc-1' ? { username: 'ann', password: 'pw' } : null)
      } as unknown as WorkflowRunnerDeps)
      const editing = workflowEditing({
        store,
        runner: { problems: (w) => runner.problems(w), stopAllOf: async () => {} },
        scheduler: { rearm: async () => {} },
        changed: () => {},
        newSecret: () => 'a-secret-long-enough-1234'
      })
      await body((w) => editing.save(w, { source: 'zumi-bot' }))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  test('an enabled email workflow whose host Zumi Bot changes stays on, without its account, and its problem says so', async () => {
    await throughSaves(async (save) => {
      // The user's own save: the account picked in the editor, the workflow on.
      const made = workflowFromAuthoring(withTrigger(emailTrigger), null, ctx())
      const { workflow: on, problems: none } = await save({
        ...made,
        enabled: true,
        trigger: { ...made.trigger, account: 'acc-1' } as Workflow['trigger']
      })
      expect([on.enabled, none]).toEqual([true, []])
      // Zumi Bot's edit: what its get shows, with another host.
      const got = workflowToAuthoring(on)
      const { workflow: after, problems } = await save(
        workflowFromAuthoring({ ...got, trigger: { ...got.trigger, host: 'imap.other.example' } }, on, ctx())
      )
      expect(after.enabled).toBe(true)
      expect(after.trigger).toMatchObject({ kind: 'email', account: '', host: 'imap.other.example' })
      expect(problems.map((p) => p.text)).toEqual([ACCOUNT_MISSING])
    })
  })

  test('email, then file, then email again across two Zumi Bot saves never brings the account back', async () => {
    await throughSaves(async (save) => {
      const made = workflowFromAuthoring(withTrigger(emailTrigger), null, ctx())
      const { workflow: email } = await save({
        ...made,
        enabled: true,
        trigger: { ...made.trigger, account: 'acc-1' } as Workflow['trigger']
      })
      const { workflow: file } = await save(workflowFromAuthoring(withTrigger({ kind: 'file', path: '/home/u/in' }), email, ctx()))
      expect(file.trigger).not.toHaveProperty('account')
      // The same host and port as before the file save: the saved trigger is a file one now, so nothing is kept.
      const { workflow: back, problems } = await save(workflowFromAuthoring(withTrigger(emailTrigger), file, ctx()))
      expect(back.trigger).toMatchObject({ kind: 'email', account: '', host: 'imap.example.com', port: 993 })
      expect(problems.map((p) => p.text)).toContain(ACCOUNT_MISSING)
    })
  })

  test('an email trigger on a workflow that was not email never takes an account', () => {
    expect(workflowFromAuthoring(withTrigger(emailTrigger), stored({ kind: 'manual' }), ctx()).trigger).toMatchObject({ account: '' })
  })

  test('mistakes in an event trigger are refused with a plain sentence', () => {
    const cases: [unknown, RegExp][] = [
      [{ kind: 'sms' }, /kind must be one of manual, schedule, webhook, reply, todo, inbox, file or email/],
      [{ kind: 'reply', filters: [{ field: 'a', equals: 'b', op: 'regex' }] }, /op must be contains or equals/],
      [{ kind: 'reply', path: '/x' }, /no field "path"/],
      [{ kind: 'file' }, /path must be text/],
      [{ kind: 'file', path: '/p', changes: [] }, /changes/],
      [{ kind: 'file', path: '/p', changes: ['renamed'] }, /changes must be added, changed or removed/],
      [{ kind: 'file', path: '/p', pattern: 5 }, /pattern must be text/],
      [{ kind: 'email' }, /host must be text/],
      [{ kind: 'email', host: 'h', port: 'x' }, /port must be a whole number/],
      [{ kind: 'email', host: 'h', port: 70000 }, /port/],
      [{ kind: 'email', host: 'h', folder: 3 }, /folder must be text/],
      [{ kind: 'file', path: 'x'.repeat(2000) }, /too long/]
    ]
    for (const [trigger, want] of cases) {
      const m = refusal(() => workflowFromAuthoring(withTrigger(trigger), null, ctx()))
      expect(m).toMatch(want)
      expect(m).toMatch(PLAIN)
    }
  })

  test('a workflow whose stored trigger is of any kind is never shown as manual', () => {
    for (const [kind, trigger] of authored) {
      const back = workflowToAuthoring(asSaved(workflowFromAuthoring(withTrigger(trigger), null, ctx()))).trigger
      expect(back.kind).toBe(kind)
    }
  })
})
