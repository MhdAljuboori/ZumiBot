import { describe, expect, it, vi } from 'vitest'
import type { WebhookCall } from '@zumibot/shared/routines'
import type { JevAnswers, JevQuestion } from '../../src/core/jev/jevClient'
import { checkCondition, CONDITION_STATE_MAX } from '../../src/core/jev/webhookCondition'
import { quickModerate, NOBODY } from '../../src/core/jev/quickModerator'
import { approvalRisk, RISK_INPUT_MAX } from '../../src/core/jev/approvalRisk'
import { suggestAgent, NO_AGENT, SUGGEST_TEXT_MAX } from '../../src/core/jev/agentSuggest'
import type { ModeratorInput } from '../../src/core/chat/moderator'

type Decide = (state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal) => Promise<JevAnswers | null>
const fake = (answers: JevAnswers | null) => vi.fn<Decide>(async () => answers)
const asked = (d: ReturnType<typeof fake>) => d.mock.calls[0] as [unknown, Record<string, JevQuestion>, AbortSignal | undefined]

const call: WebhookCall = { method: 'POST', query: { ref: 'main' }, body: { status: 'failed' }, receivedAt: 1 }

describe('checkCondition', () => {
  it('asks whether the call meets the condition and says met at p >= 0.5', async () => {
    const d = fake({ condition: { type: 'noul', noul: 0.5 } })
    expect(await checkCondition(d, 'the CI run failed', call)).toEqual({ met: true, p: 0.5 })
    const [state, questions] = asked(d)
    expect(state).toEqual({ method: 'POST', query: { ref: 'main' }, body: { status: 'failed' } })
    expect(questions.condition.type).toBe('noul')
    expect(questions.condition.instructions).toContain('the CI run failed')
  })

  it('says not met below 0.5', async () => {
    expect(await checkCondition(fake({ condition: { type: 'noul', noul: 0.49 } }), 'x', call)).toEqual({ met: false, p: 0.49 })
  })

  it('says not checked when Jev fails', async () => {
    expect(await checkCondition(fake(null), 'x', call)).toEqual({ met: null })
  })

  it('sends a big call as cut JSON text', async () => {
    const d = fake({ condition: { type: 'noul', noul: 1 } })
    await checkCondition(d, 'x', { ...call, body: 'y'.repeat(CONDITION_STATE_MAX * 2) })
    const [state] = asked(d)
    expect(typeof state).toBe('string')
    expect((state as string).length).toBe(CONDITION_STATE_MAX)
  })
})

const members = [
  { name: 'coder', description: 'Writes code' },
  { name: 'reviewer', description: 'Reviews pull requests' },
  { name: 'writer', description: 'Writes docs' }
]
const input = (o: Partial<ModeratorInput> = {}): ModeratorInput => ({
  members,
  messages: [{ from: null, text: 'Please fix the login bug' }],
  speaker: null,
  role: '',
  working: [],
  queue: [],
  mentioned: [],
  everyone: false,
  ...o
})
const choice = (pick: string, p: number) => ({ type: 'choice' as const, choice: pick, probabilities: { [pick]: p } })
const noul = (p: number) => ({ type: 'noul' as const, noul: p })

describe('quickModerate', () => {
  it('picks one member for a user message when Jev is sure', async () => {
    const d = fake({ next: choice('coder', 0.9), several: noul(0.1) })
    expect(await quickModerate(d, input())).toEqual({
      next: [{ agent: 'coder', after: [], note: null }],
      drop: [],
      skip: [],
      askUser: false
    })
    const [state, questions] = asked(d)
    expect(typeof state).toBe('string')
    expect(Object.keys((questions.next as Extract<JevQuestion, { type: 'choice' }>).criteria)).toEqual([
      'coder',
      'reviewer',
      'writer',
      NOBODY
    ])
    expect(questions.askUser).toBeUndefined() // only asked of an agent's message
  })

  it('leaves it to the moderator when Jev is not sure enough', async () => {
    expect(await quickModerate(fake({ next: choice('coder', 0.84), several: noul(0.1) }), input())).toBeNull()
  })

  it('leaves it to the moderator when more than one member or a wait may be needed', async () => {
    expect(await quickModerate(fake({ next: choice('coder', 0.95), several: noul(0.21) }), input())).toBeNull()
  })

  it('never answers a user message with nobody', async () => {
    expect(await quickModerate(fake({ next: choice(NOBODY, 0.99), several: noul(0) }), input())).toBeNull()
  })

  it("settles an agent's reply that needs nobody", async () => {
    const d = fake({ next: choice(NOBODY, 0.95), several: noul(0.05), askUser: noul(0.05) })
    const answer = await quickModerate(d, input({ speaker: 'coder', messages: [{ from: 'coder', text: 'Done, tests pass.' }] }))
    expect(answer).toEqual({ next: [], drop: [], skip: [], askUser: false })
    const [, questions] = asked(d)
    expect(Object.keys((questions.next as Extract<JevQuestion, { type: 'choice' }>).criteria)).toEqual(['reviewer', 'writer', NOBODY])
    expect(questions.askUser?.type).toBe('noul')
  })

  it("marks an agent's question to the user", async () => {
    const d = fake({ next: choice(NOBODY, 0.9), several: noul(0), askUser: noul(0.9) })
    expect(await quickModerate(d, input({ speaker: 'coder' }))).toEqual({ next: [], drop: [], skip: [], askUser: true })
  })

  it('leaves an unclear ask-the-user to the moderator', async () => {
    expect(
      await quickModerate(fake({ next: choice(NOBODY, 0.9), several: noul(0), askUser: noul(0.5) }), input({ speaker: 'coder' }))
    ).toBeNull()
    // Asking the user while handing work to a member does not add up.
    expect(
      await quickModerate(fake({ next: choice('writer', 0.9), several: noul(0), askUser: noul(0.9) }), input({ speaker: 'coder' }))
    ).toBeNull()
  })

  it('answers "nobody else" when the user mentions one member', async () => {
    const d = fake({ next: choice(NOBODY, 0.9), several: noul(0.1) })
    expect(await quickModerate(d, input({ mentioned: ['coder'] }))).toEqual({ next: [], drop: [], skip: [], askUser: false })
    const [, questions] = asked(d)
    expect(Object.keys((questions.next as Extract<JevQuestion, { type: 'choice' }>).criteria)).toEqual(['reviewer', 'writer', NOBODY])
  })

  it('does not add a second member next to a mentioned one', async () => {
    expect(await quickModerate(fake({ next: choice('writer', 0.95), several: noul(0) }), input({ mentioned: ['coder'] }))).toBeNull()
  })

  it.each([
    ['@everyone', { everyone: true }],
    ['a busy room', { working: ['coder'] }],
    ['a queue', { queue: [{ agent: 'coder', after: [] }] }],
    ['several mentions', { mentioned: ['coder', 'reviewer'] }],
    ["an agent's mention", { speaker: 'coder', mentioned: ['reviewer'] }],
    ['a member called like the nobody option', { members: [...members, { name: NOBODY, description: '' }] }]
  ])('leaves %s to the moderator without asking Jev', async (_what, o) => {
    const d = fake({ next: choice('coder', 1), several: noul(0) })
    expect(await quickModerate(d, input(o as Partial<ModeratorInput>))).toBeNull()
    expect(d).not.toHaveBeenCalled()
  })

  it('leaves it to the moderator when Jev fails', async () => {
    expect(await quickModerate(fake(null), input())).toBeNull()
  })

  it('passes the signal on', async () => {
    const d = fake(null)
    const ctrl = new AbortController()
    await quickModerate(d, input(), ctrl.signal)
    expect(asked(d)[2]).toBe(ctrl.signal)
  })
})

describe('approvalRisk', () => {
  const req = { toolName: 'Bash', input: { command: 'rm -rf build' }, description: 'Clean the build', reason: null, cwd: '/work' }
  const score = (probabilities: Record<string, number>) => ({ risk: { type: 'score' as const, probabilities } })

  it('names the most likely level', async () => {
    expect(await approvalRisk(fake(score({ '0': 0.1, '1': 0.2, '2': 0.7 })), req)).toBe('high')
    expect(await approvalRisk(fake(score({ '0': 0.6, '1': 0.3, '2': 0.1 })), req)).toBe('low')
    expect(await approvalRisk(fake(score({ '0': 0.1, '1': 0.8, '2': 0.1 })), req)).toBe('medium')
  })

  it('gives no hint when no level is likely enough', async () => {
    expect(await approvalRisk(fake(score({ '0': 0.3, '1': 0.3, '2': 0.4 })), req)).toBeNull()
  })

  it('gives no hint when Jev fails', async () => {
    expect(await approvalRisk(fake(null), req)).toBeNull()
  })

  it('sends a three-level scale and cuts a long input', async () => {
    const d = fake(score({ '0': 1 }))
    await approvalRisk(d, { ...req, input: { content: 'z'.repeat(RISK_INPUT_MAX * 2) } })
    const [state, questions] = asked(d)
    expect((questions.risk as Extract<JevQuestion, { type: 'score' }>).criteria).toHaveLength(3)
    const s = state as { tool: string; input: string; folder: string }
    expect(s.tool).toBe('Bash')
    expect(s.folder).toBe('/work')
    expect(s.input.length).toBe(RISK_INPUT_MAX)
  })
})

describe('suggestAgent', () => {
  const agents = [
    { name: 'coder', description: 'Writes code' },
    { name: 'writer', description: '' }
  ]

  it('suggests the likely agent', async () => {
    const d = fake({ agent: choice('coder', 0.7) })
    expect(await suggestAgent(d, 'Fix the failing test', agents)).toBe('coder')
    const [state, questions] = asked(d)
    expect(state).toEqual({ message: 'Fix the failing test' })
    // An agent with no description is described by its name.
    expect((questions.agent as Extract<JevQuestion, { type: 'choice' }>).criteria).toEqual({
      coder: 'Writes code',
      writer: 'writer',
      [NO_AGENT]: expect.any(String)
    })
  })

  it('suggests nothing when unsure, when none fits, or when Jev fails', async () => {
    expect(await suggestAgent(fake({ agent: choice('coder', 0.59) }), 'Fix it please', agents)).toBeNull()
    expect(await suggestAgent(fake({ agent: choice(NO_AGENT, 0.9) }), 'Fix it please', agents)).toBeNull()
    expect(await suggestAgent(fake(null), 'Fix it please', agents)).toBeNull()
  })

  it('does not ask with no agents or an agent called like the none option', async () => {
    const d = fake({ agent: choice('coder', 1) })
    expect(await suggestAgent(d, 'Fix it please', [])).toBeNull()
    expect(await suggestAgent(d, 'Fix it please', [...agents, { name: NO_AGENT, description: '' }])).toBeNull()
    expect(d).not.toHaveBeenCalled()
  })

  it('sends only the start of a long message', async () => {
    const d = fake({ agent: choice('coder', 1) })
    await suggestAgent(d, 'q'.repeat(SUGGEST_TEXT_MAX * 2), agents)
    expect((asked(d)[0] as { message: string }).message.length).toBe(SUGGEST_TEXT_MAX)
  })
})
