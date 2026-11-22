import { describe, expect, it } from 'vitest'
import { SAFE_ASK_MESSAGE } from '../../src/core/asks/askIpc'
import { engineCaps } from '@zumibot/shared/engine'
import type { AgentSummary } from '@zumibot/shared/types'
import { askRoster, askSystem, askedSystem, QUESTIONS_DENIED, REFUSAL } from '../../src/core/asks/askPrompt'

describe('askSystem', () => {
  it('is empty without agents', () => {
    expect(askSystem([])).toBe('')
  })
  it('lists the agents in the given order with the first line of their description', () => {
    const s = askSystem([
      { name: 'b', description: 'Makes cards.\nSecond line' },
      { name: 'a', description: 'Reviews code' }
    ])
    expect(s).toContain('Agents you can ask:')
    expect(s).toContain('- @b: Makes cards.')
    expect(s).not.toContain('Second line')
    expect(s.indexOf('- @b')).toBeLessThan(s.indexOf('- @a'))
    expect(s).toContain('mcp__zumibot_agents__ask')
    expect(s).toContain('side_question')
  })
  it('is the same text for the same roster', () => {
    const r = [{ name: 'b', description: 'x' }]
    expect(askSystem(r)).toBe(askSystem(r))
  })
})

describe('askedSystem and QUESTIONS_DENIED', () => {
  it('names the asker and the source chat', () => {
    const s = askedSystem('a', 'T')
    expect(s).toContain('@a')
    expect(s).toContain('"T"')
  })
  it('keeps a title with quotes or newlines on one line', () => {
    const s = askedSystem('a', 'say "hi"\nnow')
    expect(s).not.toContain('say "hi"')
    expect(s).toContain('now')
  })
  it('tells B to put questions at the end of its reply', () => {
    expect(QUESTIONS_DENIED('a')).toBe('Ask your question at the end of your reply; @a will answer or ask the user.')
  })
})

describe('REFUSAL', () => {
  const many = Array.from({ length: 80 }, (_, i) => `agent_number_${i}`)
  const sentences: Record<string, string> = {
    unknown: REFUSAL.unknown(['b', 'c']),
    unknownLong: REFUSAL.unknown(many),
    unknownNone: REFUSAL.unknown([]),
    zumiBot: REFUSAL.zumiBot,
    self: REFUSAL.self,
    inChain: REFUSAL.inChain('my_agent'),
    tooDeep: REFUSAL.tooDeep,
    perTurn: REFUSAL.perTurn,
    parallel: REFUSAL.parallel,
    busy: REFUSAL.busy('my_agent'),
    broken: REFUSAL.broken('my_agent'),
    limited: REFUSAL.limited('my_agent', Date.UTC(2026, 10, 5, 14, 5)),
    limitedNull: REFUSAL.limited('my_agent', null),
    failed: REFUSAL.failed('my_agent'),
    stopped: REFUSAL.stopped('my_agent'),
    stopping: REFUSAL.stopping,
    noText: REFUSAL.noText('my_agent'),
    noConversation: REFUSAL.noConversation('code-specialist'),
    sideLimit: REFUSAL.sideLimit('code-specialist'),
    sideTimeout: REFUSAL.sideTimeout('code-specialist'),
    sideFailed: REFUSAL.sideFailed('code-specialist'),
    sideStopped: REFUSAL.sideStopped('code-specialist'),
    sideNoText: REFUSAL.sideNoText('code-specialist'),
    sideRunAsk: REFUSAL.sideRunAsk,
    remote: REFUSAL.remote('my_agent'),
    awkward: REFUSAL.busy('we/ird "name"\n[x]')
  }
  it.each(Object.entries(sentences))('%s fits what the IPC lets through', (_k, text) => {
    expect(text).toMatch(SAFE_ASK_MESSAGE)
    expect(text).not.toMatch(/^[A-Z]+:/)
  })
  it('lists handles in the unknown sentence and cuts a long list', () => {
    expect(REFUSAL.unknown(['b', 'c'])).toContain('@b, @c')
    const long = REFUSAL.unknown(many)
    expect(long.length).toBeLessThanOrEqual(400)
    expect(long).toContain('and more')
    expect(long).toContain('@agent_number_0')
  })
  it('writes the limit time as HH:MM UTC', () => {
    expect(REFUSAL.limited('b', Date.UTC(2026, 10, 5, 14, 5))).toContain('until 14:05 UTC')
    expect(REFUSAL.limited('b', null)).not.toContain('UTC')
  })
  it('words the fixed ones as the brief says', () => {
    expect(REFUSAL.noText('b')).toBe('@b finished without writing a reply.')
    expect(REFUSAL.cut).toBe('\n\n[Reply cut at 50000 characters.]')
    expect(Object.isFrozen(REFUSAL)).toBe(true)
  })
  it('words the side ones as the spec says', () => {
    expect(REFUSAL.noConversation('b')).toBe('You have not asked @b from this chat yet, so there is no conversation to ask about.')
    expect(REFUSAL.sideLimit('b')).toBe('@b already has 3 side questions running. Wait for one to finish.')
    expect(REFUSAL.sideTimeout('b')).toBe('The side question to @b took too long.')
    expect(REFUSAL.sideFailed('b')).toBe('@b could not answer the side question.')
    expect(REFUSAL.sideStopped('b')).toBe('The side question to @b was stopped.')
    expect(REFUSAL.sideNoText('b')).toBe('@b finished without writing an answer.')
    expect(REFUSAL.sideRunAsk).toBe('Side answers cannot ask an agent to do work. Use side_question.')
  })
})

describe('askRoster', () => {
  const agent = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
    filePath: `/a/${name}.md`,
    name,
    description: `${name} does things`,
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    ...extra
  })
  it('lists the other loadable agents, sorted, and never a remote one', () => {
    const all = [
      agent('c'),
      agent('a'),
      agent('b', { provider: 'acp' }),
      agent('r', { provider: 'ag-ui', remoteHost: 'agents.example.com' }),
      agent('broken', { error: 'bad' }),
      agent('self')
    ]
    expect(askRoster(all, 'self')).toEqual([
      { name: 'a', description: 'a does things' },
      { name: 'b', description: 'b does things' },
      { name: 'c', description: 'c does things' }
    ])
  })
  it('reads the injected caps, not the engine name', () => {
    const all = [agent('a'), agent('b', { provider: 'acp' })]
    expect(askRoster(all, 'self', (e) => ({ ...engineCaps(e), remote: e === 'acp' })).map((x) => x.name)).toEqual(['a'])
    expect(askRoster(all, 'self').map((x) => x.name)).toEqual(['a', 'b'])
  })
})
