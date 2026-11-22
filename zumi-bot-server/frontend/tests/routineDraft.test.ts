import { describe, expect, it } from 'vitest'
import type { Routine } from '@zumibot/shared/routines'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { spendCapRefusal } from '@zumibot/shared/engine'
import {
  cronPreview,
  draftErrors,
  draftFromRoutine,
  draftToInput,
  emptyDraft,
  isDraftDirty,
  promptCommandAgents,
  routineCapBlocker,
  shownSection
} from '../src/state/routineDraft'

const base = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Daily AI digest',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '07:00', days: [1, 2] } },
  target: { kind: 'new-chat', agent: 'Scout', cwd: '/x' },
  prompt: 'go',
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over
})
const inputOf = (r: Routine) => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  timeZone: r.timeZone,
  trigger: r.trigger,
  target: r.target,
  prompt: r.prompt,
  command: r.command ?? null,
  limitPolicy: r.limitPolicy ?? 'wait',
  missedPolicy: r.missedPolicy ?? 'run-once',
  sessionPolicy: r.sessionPolicy ?? 'continue'
})

describe('routine draft', () => {
  it('round-trips the limit and missed policies, reading an older routine as the defaults', () => {
    const r = base({ limitPolicy: 'skip', missedPolicy: 'skip' })
    expect(draftToInput(draftFromRoutine(r))).toEqual(inputOf(r))
    expect(draftToInput(draftFromRoutine(base()))).toMatchObject({ limitPolicy: 'wait', missedPolicy: 'run-once' })
    expect(emptyDraft('UTC')).toMatchObject({ limitPolicy: 'wait', missedPolicy: 'run-once' })
  })
  it('round-trips the session policy, reading an older routine as continue', () => {
    const r = base({ target: { kind: 'chat', chatId: 'c9' }, sessionPolicy: 'fresh' })
    expect(draftToInput(draftFromRoutine(r))).toEqual(inputOf(r))
    expect(draftToInput(draftFromRoutine(base())).sessionPolicy).toBe('continue')
    expect(emptyDraft('UTC').sessionPolicy).toBe('continue')
  })
  it('keeps the missed policy of a routine switched off schedule, for when it goes back', () => {
    const d = { ...draftFromRoutine(base({ missedPolicy: 'skip' })), triggerKind: 'manual' as const }
    expect(draftToInput(d).missedPolicy).toBe('skip')
  })
  it('round-trips a new-chat routine', () => {
    const r = base()
    expect(draftToInput(draftFromRoutine(r))).toEqual(inputOf(r))
  })
  it('round-trips an existing-chat routine', () => {
    const r = base({ target: { kind: 'chat', chatId: 'c9' } })
    expect(draftToInput(draftFromRoutine(r))).toEqual(inputOf(r))
  })
  it('round-trips a new-group routine', () => {
    const r = base({ target: { kind: 'new-group', members: ['A', 'B'], role: 'be brief', cwd: '/g' } })
    expect(draftToInput(draftFromRoutine(r))).toEqual(inputOf(r))
  })
  it("round-trips a new chat's title and a new room's title and section", () => {
    const chat = base({ target: { kind: 'new-chat', agent: 'Scout', cwd: '/x', title: 'Morning brief' } })
    expect(draftFromRoutine(chat).chatTitle).toBe('Morning brief')
    expect(draftToInput(draftFromRoutine(chat))).toEqual(inputOf(chat))
    const room = base({ target: { kind: 'new-group', members: ['A', 'B'], role: '', cwd: '/g', title: 'Standup', section: 's1' } })
    expect(draftFromRoutine(room)).toMatchObject({ chatTitle: 'Standup', section: 's1' })
    expect(draftToInput(draftFromRoutine(room))).toEqual(inputOf(room))
    expect(emptyDraft('UTC')).toMatchObject({ chatTitle: '', section: '' })
  })
  it('sends a trimmed title, no blank one, and a section only for a new room', () => {
    const d = { ...draftFromRoutine(base()), chatTitle: '  Brief  ', section: 's1' }
    expect(draftToInput(d).target).toEqual({ kind: 'new-chat', agent: 'Scout', cwd: '/x', title: 'Brief' })
    expect(draftToInput({ ...d, chatTitle: '   ' }).target).toEqual({ kind: 'new-chat', agent: 'Scout', cwd: '/x' })
    expect(draftToInput({ ...d, targetKind: 'group', groupMembers: ['A', 'B'], section: '' }).target).toEqual({
      kind: 'new-group',
      members: ['A', 'B'],
      role: '',
      cwd: '/x',
      title: 'Brief'
    })
    expect(draftToInput({ ...d, chatChoice: 'c9' }).target).toEqual({ kind: 'chat', chatId: 'c9' })
  })
  it('shows a section deleted since as outside every section', () => {
    expect(shownSection('s1', [{ id: 's1' }, { id: 's2' }])).toBe('s1')
    expect(shownSection('gone', [{ id: 's1' }])).toBe('')
    expect(shownSection('', [{ id: 's1' }])).toBe('')
  })
  it('shows an existing group chat as Group and keeps it a chat target', () => {
    const r = base({ target: { kind: 'chat', chatId: 'g1' } })
    const chats = [{ id: 'g1', agentName: '', group: { members: ['A', 'B'], role: '' } }] as never
    const d = draftFromRoutine(r, chats)
    expect(d.targetKind).toBe('group')
    expect(draftToInput(d)).toEqual(inputOf(r))
    expect(draftErrors({ ...d, name: 'n', prompt: 'p' }, false)).toEqual([])
  })
  it('takes the agent of an existing single chat', () => {
    const r = base({ target: { kind: 'chat', chatId: 'c1' } })
    expect(draftFromRoutine(r, [{ id: 'c1', agentName: 'Scout' }] as never).agent).toBe('Scout')
  })
  it('round-trips manual and webhook triggers', () => {
    const m = base({ trigger: { kind: 'manual' } })
    expect(draftToInput(draftFromRoutine(m))).toEqual(inputOf(m))
    const w = base({ trigger: { kind: 'webhook', sample: null } })
    expect(draftToInput(draftFromRoutine(w))).toEqual(inputOf(w))
    const c = base({ trigger: { kind: 'webhook', sample: null, condition: 'the build failed' } })
    expect(draftToInput(draftFromRoutine(c))).toEqual(inputOf(c))
  })
  it('sends a webhook condition only when there is one', () => {
    const d = { ...emptyDraft('UTC'), triggerKind: 'webhook' as const, condition: '   ' }
    expect(draftToInput(d).trigger).toEqual({ kind: 'webhook', sample: null })
    expect(draftToInput({ ...d, condition: ' x ' }).trigger).toEqual({ kind: 'webhook', sample: null, condition: 'x' })
    expect(draftToInput({ ...d, triggerKind: 'manual', condition: 'x' }).trigger).toEqual({ kind: 'manual' })
  })
  it('starts as an enabled daily 09:00 draft', () => {
    const d = emptyDraft('Asia/Baghdad')
    expect(d).toMatchObject({
      id: null,
      enabled: true,
      timeZone: 'Asia/Baghdad',
      triggerKind: 'schedule',
      schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }
    })
  })
  it('lists name and prompt errors for an empty draft', () => {
    const e = draftErrors(emptyDraft('UTC'), false)
    expect(e).toContain('Name is required')
    expect(e).toContain('Prompt is required')
  })
  it('lists target errors', () => {
    const d = emptyDraft('UTC')
    expect(draftErrors(d, false)).toContain('Pick an agent')
    expect(draftErrors(d, false)).toContain('Choose a folder')
    const g = { ...d, targetKind: 'group' as const, groupMembers: ['A'] }
    expect(draftErrors(g, false)).toContain('Pick at least 2 members')
    const chat = { ...d, agent: 'A', chatChoice: 'c1' }
    expect(draftErrors(chat, false)).not.toContain('Choose a folder')
  })
  it('requires a test call for a webhook draft', () => {
    const d = { ...emptyDraft('UTC'), triggerKind: 'webhook' as const }
    expect(draftErrors(d, false)).toContain('Webhook needs a test call before saving')
    expect(draftErrors(d, true)).not.toContain('Webhook needs a test call before saving')
  })
  it('flags a bad cron', () => {
    const d = { ...emptyDraft('UTC'), schedule: { freq: 'custom' as const, cron: '* * *' } }
    expect(draftErrors(d, false)).toContain('Invalid cron expression')
  })
  it('previews three cron times, or null when invalid', () => {
    const now = Date.UTC(2026, 9, 27)
    expect(cronPreview('0 7 * * *', 'UTC', now)).toHaveLength(3)
    expect(cronPreview('* * *', 'UTC', now)).toBeNull()
  })
  it('detects dirty drafts', () => {
    const d = emptyDraft('UTC')
    expect(isDraftDirty(d, d)).toBe(false)
    expect(isDraftDirty({ ...d, name: 'x' }, d)).toBe(true)
  })

  it('round-trips a command pick, and saves it only while the prompt starts with its name', () => {
    const command = { agent: 'Scout', name: 'check' }
    const r = base({ prompt: '/check today', command })
    expect(draftToInput(draftFromRoutine(r))).toEqual(inputOf(r))
    expect(draftToInput({ ...draftFromRoutine(r), prompt: '/fix today' }).command).toBeNull()
    expect(draftFromRoutine(base()).command).toBeNull()
  })

  describe('promptCommandAgents', () => {
    const agent = (name: string): AgentSummary => ({
      filePath: `/a/${name}.md`,
      name,
      description: '',
      color: null,
      icon: null,
      error: null,
      builtIn: false
    })
    const agents = [agent('scout'), agent('rev'), agent('fix')]
    const room = { id: 'g1', agentName: '', group: { members: ['rev', 'fix', 'left'] } } as unknown as ChatMeta
    const single = { id: 's1', agentName: 'scout' } as ChatMeta
    const names = (r: { agents: AgentSummary[]; grouped: boolean }) => [r.agents.map((a) => a.name), r.grouped]

    it('lists the target agent, ungrouped, and nobody before one is picked', () => {
      expect(names(promptCommandAgents({ ...emptyDraft('UTC'), agent: 'scout' }, agents, []))).toEqual([['scout'], false])
      expect(names(promptCommandAgents({ ...emptyDraft('UTC'), agent: 'scout', chatChoice: 's1' }, agents, [single]))).toEqual([
        ['scout'],
        false
      ])
      expect(names(promptCommandAgents(emptyDraft('UTC'), agents, []))).toEqual([[], false])
    })

    it("lists a new room's members, or an existing room's, grouped and in member order", () => {
      expect(names(promptCommandAgents({ ...emptyDraft('UTC'), targetKind: 'group', groupMembers: ['fix', 'scout'] }, agents, []))).toEqual(
        [['fix', 'scout'], true]
      )
      // A member whose file is gone has no commands to list.
      expect(names(promptCommandAgents({ ...emptyDraft('UTC'), targetKind: 'group', chatChoice: 'g1' }, agents, [room]))).toEqual([
        ['rev', 'fix'],
        true
      ])
      expect(names(promptCommandAgents({ ...emptyDraft('UTC'), targetKind: 'group', chatChoice: 'gone' }, agents, [room]))).toEqual([
        [],
        true
      ])
    })
  })
})

describe('routineCapBlocker', () => {
  const agent = (name: string, provider?: 'codex' | 'acp'): AgentSummary => ({
    filePath: `/a/${name}.md`,
    name,
    description: '',
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    ...(provider ? { provider } : {})
  })
  const agents = [agent('ui'), agent('cx', 'codex'), agent('gem', 'acp')]
  const chat = (id: string, agentName: string, members?: string[]): ChatMeta => ({
    id,
    agentName,
    sessionId: null,
    cwd: '/w',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    inFlight: false,
    ...(members ? { group: { members, sessions: {}, seen: {}, role: '', active: [], queue: [] } } : {})
  })
  const draft = (over: Partial<ReturnType<typeof emptyDraft>>) => ({ ...emptyDraft('UTC'), ...over })

  it("is null while the routine's agent reports a cost, or none is picked yet", () => {
    expect(routineCapBlocker(draft({ agent: 'ui' }), agents, [])).toBeNull()
    expect(routineCapBlocker(draft({ agent: 'cx' }), agents, [])).toBeNull()
    expect(routineCapBlocker(draft({}), agents, [])).toBeNull()
  })
  it('names the agent whose engine has no cost, for a new chat, a new room and an existing chat or room', () => {
    const over = spendCapRefusal('acp', 'gem')
    expect(routineCapBlocker(draft({ agent: 'gem' }), agents, [])).toBe(over)
    expect(routineCapBlocker(draft({ targetKind: 'group', groupMembers: ['ui', 'gem'] }), agents, [])).toBe(over)
    expect(routineCapBlocker(draft({ chatChoice: 'c1', agent: 'gem' }), agents, [chat('c1', 'gem')])).toBe(over)
    expect(routineCapBlocker(draft({ chatChoice: 'r1', targetKind: 'group' }), agents, [chat('r1', '', ['ui', 'gem'])])).toBe(over)
    expect(routineCapBlocker(draft({ chatChoice: 'r1', targetKind: 'group' }), agents, [chat('r1', '', ['ui', 'cx'])])).toBeNull()
  })
})
