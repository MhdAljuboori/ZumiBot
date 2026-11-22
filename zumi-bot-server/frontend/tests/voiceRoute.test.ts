import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '@zumibot/shared/types'
import { normalizeUtterance } from '@zumibot/shared/voiceWords'
import { normalizeWithMap, routeUtterance } from '../src/state/voiceRoute'

const agent = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...extra
})
const agents = [
  agent('work-assistant'),
  agent('bob'),
  agent('obada'),
  agent('coder', { provider: 'codex' }),
  agent('broken', { error: 'bad' }),
  agent('zumi-bot', { builtIn: true })
]
const talk = { defaultAgent: 'work-assistant' as string | null, aliases: { 'work-assistant': ['مساعد العمل'] } as Record<string, string[]> }

describe('routeUtterance', () => {
  it('picks the agent named after "ask" and keeps the original request', () => {
    expect(routeUtterance('Ask Work Assistant to set a meeting with Obada tomorrow after 3pm', agents, talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'set a meeting with Obada tomorrow after 3pm'
    })
  })

  it('matches an Arabic prefix and an alias', () => {
    const r = routeUtterance('اسأل مساعد العمل يحجز اجتماع مع عبادة', agents, talk)
    expect(r).toMatchObject({ kind: 'agent', agent: 'work-assistant' })
    expect(r.kind === 'agent' && r.request.startsWith('يحجز')).toBe(true)
    expect(r.kind === 'agent' && r.request).toBe('يحجز اجتماع مع عبادة')
  })

  it('matches an English name after an Arabic prefix', () => {
    expect(routeUtterance('اسأل work assistant يحجز اجتماع', agents, talk)).toMatchObject({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'يحجز اجتماع'
    })
  })

  it('matches a prefix written attached to the name', () => {
    expect(routeUtterance('قل لعبادة يجي بكرة', agents, { defaultAgent: null, aliases: { obada: ['عبادة'] } })).toEqual({
      kind: 'agent',
      agent: 'obada',
      request: 'يجي بكرة'
    })
    expect(routeUtterance('قول لمساعد العمل يحجز اجتماع', agents, talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'يحجز اجتماع'
    })
    expect(routeUtterance('قل ل عبادة يجي', agents, { defaultAgent: null, aliases: { obada: ['عبادة'] } })).toMatchObject({
      agent: 'obada'
    })
  })

  it('handles diacritics and alef forms in the original text', () => {
    expect(routeUtterance('إسألْ مُساعِد العَمل يحجز', agents, talk)).toEqual({ kind: 'agent', agent: 'work-assistant', request: 'يحجز' })
  })

  it('names an unknown agent instead of using the default', () => {
    expect(routeUtterance('Ask Carl to do x', agents, talk)).toEqual({ kind: 'unknown', named: 'carl' })
    expect(routeUtterance('Ask Carl, do x', agents, talk)).toEqual({ kind: 'unknown', named: 'carl' })
    expect(routeUtterance('Ask Carl about the meeting at three', agents, talk)).toEqual({ kind: 'unknown', named: 'carl about the' })
  })

  it('names a broken agent as unknown', () => {
    expect(routeUtterance('Ask broken to do x', agents, talk)).toEqual({ kind: 'unknown', named: 'broken' })
  })

  it('refuses Zumi Bot', () => {
    expect(routeUtterance('Ask Zumi Bot to do x', agents, talk)).toEqual({ kind: 'unknown', named: 'zumi bot' })
    expect(routeUtterance('Zumi Bot, do x', agents, talk)).toEqual({ kind: 'unknown', named: 'zumi bot' })
  })

  it('goes to the default agent with the text unchanged when no agent is named', () => {
    expect(routeUtterance('Set a meeting tomorrow', agents, talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'Set a meeting tomorrow'
    })
  })

  it('does not treat a leading name without a vocative comma as a pick', () => {
    expect(routeUtterance('Bob owes me a call', agents, talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'Bob owes me a call'
    })
  })

  it('has no agent when there is no prefix and no usable default', () => {
    expect(routeUtterance('set a meeting', agents, { defaultAgent: null, aliases: {} })).toEqual({ kind: 'no-agent' })
    expect(routeUtterance('set a meeting', agents, { defaultAgent: 'gone', aliases: {} })).toEqual({ kind: 'no-agent' })
    expect(routeUtterance('set a meeting', agents, { defaultAgent: 'broken', aliases: {} })).toEqual({ kind: 'no-agent' })
    expect(routeUtterance('set a meeting', agents, { defaultAgent: 'zumi-bot', aliases: {} })).toEqual({ kind: 'no-agent' })
  })

  it('routes to a Codex agent like any other, named or default', () => {
    expect(routeUtterance('Ask Coder to fix it', agents, talk)).toEqual({ kind: 'agent', agent: 'coder', request: 'fix it' })
    expect(routeUtterance('fix it', agents, { defaultAgent: 'coder', aliases: {} })).toEqual({
      kind: 'agent',
      agent: 'coder',
      request: 'fix it'
    })
  })

  it('picks by a vocative', () => {
    expect(routeUtterance('Work Assistant, what is on my calendar', agents, talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'what is on my calendar'
    })
    expect(routeUtterance('مساعد العمل، شو عندي اليوم', agents, { defaultAgent: null, aliases: talk.aliases })).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'شو عندي اليوم'
    })
  })

  it('matches whole words only', () => {
    expect(routeUtterance('Ask Bobby to do x', agents, talk)).toEqual({ kind: 'unknown', named: 'bobby' })
    expect(routeUtterance('Bobby, do x', agents, talk)).toEqual({ kind: 'agent', agent: 'work-assistant', request: 'Bobby, do x' })
  })

  it('prefers the longest name', () => {
    const a = [agent('work'), agent('work-assistant')]
    expect(routeUtterance('Ask Work Assistant to go', a, { defaultAgent: null, aliases: {} })).toMatchObject({
      agent: 'work-assistant',
      request: 'go'
    })
    expect(routeUtterance('Ask Work to go', a, { defaultAgent: null, aliases: {} })).toMatchObject({ agent: 'work', request: 'go' })
  })

  it('never guesses when one alias belongs to two agents', () => {
    const t = { defaultAgent: 'work-assistant', aliases: { bob: ['boss'], obada: ['Boss'] } }
    expect(routeUtterance('Ask the boss to do x', agents, t)).toEqual({ kind: 'unknown', named: 'the boss' })
    expect(routeUtterance('Ask boss to do x', agents, t)).toEqual({ kind: 'unknown', named: 'boss' })
  })

  it('lets an alias win over a shorter name', () => {
    const t = { defaultAgent: null, aliases: { obada: ['bob the builder'] } }
    expect(routeUtterance('Ask bob the builder to dig', agents, t)).toMatchObject({ agent: 'obada', request: 'dig' })
  })

  it('ignores aliases of agents that do not exist', () => {
    const t = { defaultAgent: null, aliases: { ghost: ['spooky'] } }
    expect(routeUtterance('Ask spooky to do x', agents, t)).toEqual({ kind: 'unknown', named: 'spooky' })
  })

  it('keeps the request original when the name has an apostrophe-free match but the text has punctuation', () => {
    expect(routeUtterance('Ask Work-Assistant: to Add Milk!', agents, talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'Add Milk!'
    })
  })

  it('trims a leading Arabic "ان" connector', () => {
    expect(routeUtterance('اسأل bob أن يحجز', agents, talk)).toEqual({ kind: 'agent', agent: 'bob', request: 'يحجز' })
  })
})

describe('pronoun objects after an ask prefix', () => {
  it('sends the whole text to the default agent', () => {
    for (const t of [
      "Tell me what's on my calendar today",
      'ask me later',
      'Tell them to wait',
      'قل لي شو عندي اليوم',
      'قول لنا شو صار',
      'قل لها تتصل',
      'قل لهم',
      'قل له',
      'اسالني بكرا',
      'اسألنا بكرا'
    ]) {
      expect(routeUtterance(t, agents, talk), t).toEqual({ kind: 'agent', agent: 'work-assistant', request: t })
    }
  })

  it('follows the default rules: no default, or a Codex default', () => {
    const none = { defaultAgent: null, aliases: {} }
    expect(routeUtterance('قل لي شو عندي اليوم', agents, none)).toEqual({ kind: 'no-agent' })
    expect(routeUtterance('Tell me the time', agents, none)).toEqual({ kind: 'no-agent' })
    expect(routeUtterance('Tell me the time', agents, { defaultAgent: 'coder', aliases: {} })).toEqual({
      kind: 'agent',
      agent: 'coder',
      request: 'Tell me the time'
    })
  })

  it('lets an agent literally named like a pronoun win', () => {
    const a = [agent('me'), agent('work-assistant')]
    expect(routeUtterance('Ask me to go', a, talk)).toEqual({ kind: 'agent', agent: 'me', request: 'go' })
  })

  it('does not take a longer word that only starts like a pronoun for one', () => {
    expect(routeUtterance('Ask Mel to go', agents, talk)).toEqual({ kind: 'unknown', named: 'mel' })
    expect(routeUtterance('قل لهدى تجي', agents, talk)).toEqual({ kind: 'unknown', named: 'هدي تجي' })
  })
})

describe('a misheard name after an ask prefix', () => {
  const none = { defaultAgent: null, aliases: {} as Record<string, string[]> }

  it('picks the one agent a letter or two away and cuts the request after what was said', () => {
    const a = [agent('workiom-master'), agent('work-assistant')]
    expect(routeUtterance('Ask Workium Master to add a task', a, none)).toEqual({
      kind: 'agent',
      agent: 'workiom-master',
      request: 'add a task'
    })
    expect(routeUtterance('Ask Workiom Mastre, add a task', a, none)).toEqual({
      kind: 'agent',
      agent: 'workiom-master',
      request: 'add a task'
    })
    expect(routeUtterance('Ask Work Asistant to go', a, none)).toEqual({ kind: 'agent', agent: 'work-assistant', request: 'go' })
    expect(routeUtterance('Tell Obadah to call me', agents, none)).toEqual({ kind: 'agent', agent: 'obada', request: 'call me' })
  })

  it('takes a name split or joined into a different number of words', () => {
    const a = [agent('workiom-master')]
    expect(routeUtterance('Ask Workiommaster to go', a, none)).toEqual({ kind: 'agent', agent: 'workiom-master', request: 'go' })
    expect(routeUtterance('Ask Work iom Master to go', a, none)).toEqual({ kind: 'agent', agent: 'workiom-master', request: 'go' })
  })

  it('works on aliases and Arabic script', () => {
    expect(routeUtterance('اسأل مساعد العمال يحجز اجتماع', agents, talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'يحجز اجتماع'
    })
  })

  it('stays exact for short names', () => {
    expect(routeUtterance('Ask Rob to do x', agents, talk)).toEqual({ kind: 'unknown', named: 'rob' })
  })

  it('is unknown when the spelling is too far off', () => {
    expect(routeUtterance('Ask Wokum Mister to go', [agent('workiom-master')], none)).toEqual({ kind: 'unknown', named: 'wokum mister' })
  })

  it('never guesses between two agents near the same words', () => {
    const a = [agent('sarah'), agent('saran')]
    expect(routeUtterance('Ask Sarai to go', a, none)).toEqual({ kind: 'unknown', named: 'sarai' })
  })

  it('still refuses Zumi Bot and broken agents', () => {
    expect(routeUtterance('Ask Zumi Bott to do x', agents, talk)).toEqual({ kind: 'unknown', named: 'zumi bott' })
    expect(routeUtterance('Ask brokn to do x', agents, talk)).toEqual({ kind: 'unknown', named: 'brokn' })
  })

  it('leaves a vocative exact, so it goes to the default', () => {
    expect(routeUtterance('Workium Master, add a task', [agent('workiom-master'), agent('work-assistant')], talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'Workium Master, add a task'
    })
  })

  it('keeps a pronoun object a plain request, even one letter from an agent', () => {
    expect(routeUtterance('Tell them to wait', [agent('theme'), agent('work-assistant')], talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'Tell them to wait'
    })
  })
})

describe('an address with nothing after the name', () => {
  it('still picks the agent, with an empty request', () => {
    expect(routeUtterance('Ask Work Assistant', agents, talk)).toEqual({ kind: 'agent', agent: 'work-assistant', request: '' })
    expect(routeUtterance('Ask Work Assistant to', agents, talk)).toEqual({ kind: 'agent', agent: 'work-assistant', request: '' })
  })
})

describe('normalizeWithMap', () => {
  it('gives the same text as normalizeUtterance, with one original range per character', () => {
    for (const t of ['  Ask   Work-Assistant: to Add Milk! ', 'إسألْ مُساعِد العَمل', "don't  stop", 'ـ، ', 'قل لعبادة']) {
      const m = normalizeWithMap(t)
      expect(m.n).toBe(normalizeUtterance(t))
      expect(m.start).toHaveLength(m.n.length)
      expect(m.end).toHaveLength(m.n.length)
    }
  })
})

describe('routeUtterance and remote agents', () => {
  const remote = agent('remote-bot', { provider: 'ag-ui', remoteHost: 'agents.example.com' })
  const list = [...agents, remote]
  const none = { defaultAgent: null as string | null, aliases: {} as Record<string, string[]> }

  it('reads a remote agent named after "ask" as unknown, by file name, display name or alias', () => {
    expect(routeUtterance('Ask remote bot to check the status', list, none)).toEqual({ kind: 'unknown', named: 'remote bot' })
    expect(routeUtterance('Ask remote-bot to check', list, none)).toMatchObject({ kind: 'unknown' })
    expect(routeUtterance('Ask the gateway to check', list, { ...none, aliases: { 'remote-bot': ['the gateway'] } })).toMatchObject({
      kind: 'unknown'
    })
  })
  it('does not take a vocative to a remote agent', () => {
    expect(routeUtterance('Remote Bot, what is up', list, none)).toEqual({ kind: 'no-agent' })
    expect(routeUtterance('Remote Bot, what is up', list, talk)).toEqual({
      kind: 'agent',
      agent: 'work-assistant',
      request: 'Remote Bot, what is up'
    })
  })
  it('a remote default agent is no agent', () => {
    expect(routeUtterance('set a meeting', list, { defaultAgent: 'remote-bot', aliases: {} })).toEqual({ kind: 'no-agent' })
  })
  it('a misheard name near a remote agent is still unknown, never the remote agent', () => {
    expect(routeUtterance('Ask remote bott to check', list, none)).toMatchObject({ kind: 'unknown' })
  })
  it('leaves every other agent routing as it was', () => {
    expect(routeUtterance('Ask Bob to call', list, none)).toEqual({ kind: 'agent', agent: 'bob', request: 'call' })
    expect(routeUtterance('Ask coder to fix it', list, none)).toMatchObject({ kind: 'agent', agent: 'coder' })
  })
})
