import { describe, expect, it, vi } from 'vitest'
import type { JevStatus } from '@zumibot/shared/jev'
import { createJev } from '../../src/core/jev/jev'
import type { JevAnswers, JevClient } from '../../src/core/jev/jevClient'
import type { ModeratorInput } from '../../src/core/chat/moderator'

const on: JevStatus = { keySet: true, enabled: true, moderator: true, approvalRisk: true, agentSuggest: true }
const answers: JevAnswers = {
  condition: { type: 'noul', noul: 0.9 },
  next: { type: 'choice', choice: 'coder', probabilities: { coder: 0.95 } },
  several: { type: 'noul', noul: 0 },
  risk: { type: 'score', probabilities: { '2': 0.9 } },
  agent: { type: 'choice', choice: 'coder', probabilities: { coder: 0.9 } }
}

function setup(status: Partial<JevStatus> = {}) {
  const decide = vi.fn<JevClient['decide']>(async (_state, questions) =>
    Object.fromEntries(Object.keys(questions).map((k) => [k, answers[k]!]))
  )
  const jev = createJev({ store: { status: async () => ({ ...on, ...status }) }, client: { decide, check: async () => ({ ok: true }) } })
  return { jev, decide }
}

const modInput: ModeratorInput = {
  members: [
    { name: 'coder', description: 'Writes code' },
    { name: 'writer', description: 'Docs' }
  ],
  messages: [{ from: null, text: 'Fix the bug' }],
  speaker: null,
  role: '',
  working: [],
  queue: [],
  mentioned: [],
  everyone: false
}
const call = { method: 'POST', query: {}, body: { ok: false }, receivedAt: 1 }
const req = { toolName: 'Bash', input: { command: 'ls' }, description: null, reason: null, cwd: '/w' }
const agents = [{ name: 'coder', description: 'Writes code' }]

async function all(jev: ReturnType<typeof createJev>) {
  return {
    moderate: await jev.moderate(modInput),
    risk: await jev.approvalRisk(req),
    suggest: await jev.suggestAgent('Fix the failing test', agents),
    condition: await jev.webhookCondition('the build failed', call)
  }
}

describe('createJev', () => {
  it('decides everything while on', async () => {
    const { jev } = setup()
    expect(await all(jev)).toEqual({
      moderate: { next: [{ agent: 'coder', after: [], note: null }], drop: [], skip: [], askUser: false },
      risk: 'high',
      suggest: 'coder',
      condition: { met: true, p: 0.9 }
    })
  })

  it.each([
    ['the master switch is off', { enabled: false }],
    ['no key is set', { keySet: false }]
  ])('never calls Jev when %s', async (_what, status) => {
    const { jev, decide } = setup(status)
    expect(await all(jev)).toEqual({ moderate: null, risk: null, suggest: null, condition: null })
    expect(decide).not.toHaveBeenCalled()
  })

  it("follows each feature's own switch", async () => {
    const { jev, decide } = setup({ moderator: false, approvalRisk: false, agentSuggest: false })
    const out = await all(jev)
    expect(out).toEqual({ moderate: null, risk: null, suggest: null, condition: { met: true, p: 0.9 } })
    expect(decide).toHaveBeenCalledTimes(1) // the condition only: it has no switch of its own
  })

  it('reads as off when the switches cannot be read', async () => {
    const decide = vi.fn<JevClient['decide']>()
    const jev = createJev({
      store: {
        status: async () => {
          throw new Error('EACCES')
        }
      },
      client: { decide, check: async () => ({ ok: true }) }
    })
    expect(await all(jev)).toEqual({ moderate: null, risk: null, suggest: null, condition: null })
    expect(decide).not.toHaveBeenCalled()
  })
})
