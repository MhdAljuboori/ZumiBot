import { describe, expect, it } from 'vitest'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { ASK_REPLY_MAX } from '@zumibot/shared/agentAsk'
import { SIDE_LIMIT_TEXT, SIDE_TIMEOUT_TEXT, type SideQuestion } from '@zumibot/shared/btw'
import type { AgentSummary, ChatMeta, ChatPush } from '@zumibot/shared/types'
import { AgentAsks, AskRefusal, type AskedOutcome } from '../../src/core/asks/askService'
import { CODEX_REFUSALS, engineCaps, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { REFUSAL } from '../../src/core/asks/askPrompt'
import type { AskOwner } from '../../src/core/asks/askIpc'

const agent = (name: string, error: string | null = null): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error,
  builtIn: false
})

function setup(opts: { agents?: AgentSummary[]; sourceTitle?: string; noSource?: boolean; caps?: (e: Engine) => EngineCaps } = {}) {
  const agents = opts.agents ?? [agent('a'), agent('b'), agent('c'), agent(ZUMI_BOT_NAME)]
  const store = new Map<string, ChatMeta>()
  if (!opts.noSource)
    store.set('src', {
      id: 'src',
      agentName: 'a',
      sessionId: null,
      cwd: '/work/dir',
      title: opts.sourceTitle ?? 'Login bug',
      createdAt: 0,
      updatedAt: 0,
      inFlight: true
    })
  let n = 0
  const chats = {
    list: async () => [...store.values()],
    get: async (id: string) => store.get(id) ?? null,
    create: async (agentName: string, cwd: string) => {
      const m: ChatMeta = { id: `ask${++n}`, agentName, sessionId: null, cwd, title: '', createdAt: 0, updatedAt: 0, inFlight: false }
      store.set(m.id, m)
      return m
    },
    update: async (id: string, patch: Partial<ChatMeta>) => {
      const m = { ...store.get(id)!, ...patch }
      store.set(id, m)
      return m
    }
  }
  const pushes: ChatPush[] = []
  const runs: { chatId: string; o: { from: string; message: string; chain: string[]; parent: string; auto?: true } }[] = []
  let outcome: AskedOutcome | (() => Promise<AskedOutcome>) = { kind: 'ok', reply: 'done' }
  let currentAgents = agents
  const sides: {
    chatId: string
    o: { question: string; from: string; link: { chatId: string; entryId: string } | null; signal: AbortSignal }
  }[] = []
  let sideResult: SideQuestion | Error | (() => Promise<SideQuestion>) = {
    id: 'e1',
    question: 'q',
    agent: 'b',
    askedAt: 0,
    after: null,
    state: 'done',
    answer: 'side answer'
  }
  const asks = new AgentAsks({
    agents: async () => currentAgents,
    chats,
    side: async (chatId, o) => {
      sides.push({ chatId, o })
      if (sideResult instanceof Error) throw sideResult
      return typeof sideResult === 'function' ? await sideResult() : sideResult
    },
    run: async (chatId, o) => {
      runs.push({ chatId, o })
      return typeof outcome === 'function' ? await outcome() : outcome
    },
    push: (p) => pushes.push(p),
    ...(opts.caps ? { caps: opts.caps } : {})
  })
  // The A to B chat a side question needs: made by an earlier ask.
  const addAsked = (agentName = 'b', from = 'src') => {
    store.set(`ab-${agentName}`, {
      id: `ab-${agentName}`,
      agentName,
      sessionId: null,
      cwd: '/work/dir',
      title: '',
      createdAt: 0,
      updatedAt: 0,
      inFlight: false,
      asked: { by: 'a', from, fromTitle: 'Login bug', chain: [] }
    })
  }
  return {
    asks,
    store,
    runs,
    pushes,
    sides,
    addAsked,
    setSide: (r: typeof sideResult) => {
      sideResult = r
    },
    setOutcome: (o: typeof outcome) => {
      outcome = o
    },
    setAgents: (a: AgentSummary[]) => {
      currentAgents = a
    }
  }
}
const owner = (over: Partial<AskOwner> = {}): AskOwner => ({ chatId: 'src', agent: () => 'a', chain: [], turn: 't1', ...over })
const sig = () => new AbortController().signal
const reason = async (p: Promise<string>) => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AskRefusal)
    return (e as Error).message
  }
  throw new Error('did not reject')
}

describe('AgentAsks.ask: the A to B chat', () => {
  it('creates one chat under B, reuses it, and runs with the chain', async () => {
    const t = setup()
    expect(await t.asks.ask(owner(), { agent: '@B', message: 'hi' }, sig())).toBe('done')
    const made = [...t.store.values()].filter((c) => c.asked)
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({
      agentName: 'b',
      cwd: '/work/dir',
      title: '@a · Login bug',
      asked: { by: 'a', from: 'src', fromTitle: 'Login bug', chain: [] }
    })
    expect(t.pushes.some((p) => p.kind === 'meta' && p.chatId === made[0].id)).toBe(true)
    await t.asks.ask(owner(), { agent: 'b', message: 'again' }, sig())
    expect([...t.store.values()].filter((c) => c.asked)).toHaveLength(1)
    expect(t.runs).toHaveLength(2)
    expect(t.runs[1]).toMatchObject({ chatId: made[0].id, o: { from: 'a', message: 'again', chain: ['a'], parent: 'src' } })
  })
  it("passes the owner's unattended flag to the asked turn, and no auto key without it", async () => {
    const t = setup()
    await t.asks.ask(owner({ auto: true }), { agent: 'b', message: 'x' }, sig())
    expect(t.runs[0].o.auto).toBe(true)
    await t.asks.ask(owner({ turn: 't2' }), { agent: 'b', message: 'y' }, sig())
    expect(t.runs[1].o).not.toHaveProperty('auto')
  })
  it('an ask from a worktree chat copies the worktree', async () => {
    const t = setup()
    const wt = { root: '/work/dir-wt', branch: 'zumibot/a-1', source: '/work', folder: '/work/dir', links: [] }
    t.store.set('src', { ...t.store.get('src')!, cwd: '/work/dir-wt/dir', worktree: wt })
    await t.asks.ask(owner(), { agent: 'b', message: 'hi' }, sig())
    const made = [...t.store.values()].find((c) => c.asked)!
    expect(made).toMatchObject({ cwd: '/work/dir-wt/dir', worktree: wt })
    // A plain source leaves the field off.
    const t2 = setup()
    await t2.asks.ask(owner(), { agent: 'b', message: 'hi' }, sig())
    expect([...t2.store.values()].find((c) => c.asked)).not.toHaveProperty('worktree')
  })
  it('keeps one chat per source chat and agent', async () => {
    const t = setup()
    await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())
    await t.asks.ask(owner(), { agent: 'c', message: 'x' }, sig())
    expect([...t.store.values()].filter((c) => c.asked)).toHaveLength(2)
  })
  it('makes one chat for two asks that start together', async () => {
    const t = setup()
    await Promise.all([t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig()), t.asks.ask(owner(), { agent: 'b', message: 'y' }, sig())])
    expect([...t.store.values()].filter((c) => c.asked)).toHaveLength(1)
  })
  it('makes a new chat when the old one is deleted', async () => {
    const t = setup()
    await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())
    t.store.delete('ask1')
    await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())
    expect([...t.store.values()].filter((c) => c.asked)).toHaveLength(1)
  })
  it('refuses with stopped when the source chat is gone', async () => {
    const t = setup({ noSource: true })
    expect(await reason(t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig()))).toBe(REFUSAL.stopped('b'))
  })
  it('titles a source chat without a title as New chat', async () => {
    const t = setup({ sourceTitle: '' })
    await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())
    expect([...t.store.values()].find((c) => c.asked)?.title).toBe('@a · New chat')
  })
})

describe('AgentAsks.ask: refusals', () => {
  it('lists the other agents for an unknown one', async () => {
    const t = setup()
    const m = await reason(t.asks.ask(owner(), { agent: 'zz', message: 'x' }, sig()))
    expect(m).toBe(REFUSAL.unknown(['b', 'c']))
    expect(m).toContain('@b, @c')
    expect(t.runs).toHaveLength(0)
  })
  it('leaves broken agents out of the list, and names one as broken', async () => {
    const t = setup({ agents: [agent('a'), agent('b'), agent('c', 'bad frontmatter'), agent('d')] })
    expect(await reason(t.asks.ask(owner(), { agent: 'zz', message: 'x' }, sig()))).toBe(REFUSAL.unknown(['b', 'd']))
    expect(await reason(t.asks.ask(owner(), { agent: 'c', message: 'x' }, sig()))).toBe(REFUSAL.broken('c'))
  })
  it('refuses a remote agent for ask and side_question, and leaves it out of the list it offers', async () => {
    const remote: AgentSummary = { ...agent('r'), provider: 'ag-ui', remoteHost: 'agents.example.com' }
    const t = setup({ agents: [agent('a'), agent('b'), remote] })
    expect(await reason(t.asks.ask(owner(), { agent: 'r', message: 'x' }, sig()))).toBe(REFUSAL.remote('r'))
    expect(await reason(t.asks.sideAsk(owner(), { agent: 'r', question: 'x' }, sig()))).toBe(REFUSAL.remote('r'))
    expect(await reason(t.asks.ask(owner(), { agent: 'zz', message: 'x' }, sig()))).toBe(REFUSAL.unknown(['b']))
    expect(t.runs).toHaveLength(0)
    expect(t.sides).toHaveLength(0)
    expect([...t.store.values()].filter((c) => c.asked)).toHaveLength(0)
  })
  it('refuses Zumi Bot, itself, an agent in the chain and a chain too long', async () => {
    const t = setup()
    expect(await reason(t.asks.ask(owner(), { agent: ZUMI_BOT_NAME, message: 'x' }, sig()))).toBe(REFUSAL.zumiBot)
    expect(await reason(t.asks.ask(owner(), { agent: 'a', message: 'x' }, sig()))).toBe(REFUSAL.self)
    expect(await reason(t.asks.ask(owner({ chain: ['b'] }), { agent: 'b', message: 'x' }, sig()))).toBe(REFUSAL.inChain('b'))
    expect(await reason(t.asks.ask(owner({ chain: ['x', 'y', 'z'] }), { agent: 'b', message: 'x' }, sig()))).toBe(REFUSAL.tooDeep)
    expect(t.runs).toHaveLength(0)
  })
  it('refuses the 11th ask of a turn, until the turn ends', async () => {
    const t = setup()
    for (let i = 0; i < 10; i++) await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())
    expect(await reason(t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig()))).toBe(REFUSAL.perTurn)
    expect(await t.asks.ask(owner({ turn: 't2' }), { agent: 'b', message: 'x' }, sig())).toBe('done')
    t.asks.endTurn('t1')
    expect(await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())).toBe('done')
  })
  it('refuses the 4th of four parallel asks', async () => {
    const t = setup({ agents: [agent('a'), agent('b'), agent('c'), agent('d'), agent('e')] })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    t.setOutcome(async () => {
      await gate
      return { kind: 'ok', reply: 'r' }
    })
    const three = ['b', 'c', 'd'].map((n) => t.asks.ask(owner(), { agent: n, message: 'x' }, sig()))
    await new Promise((r) => setTimeout(r, 20))
    expect(await reason(t.asks.ask(owner(), { agent: 'e', message: 'x' }, sig()))).toBe(REFUSAL.parallel)
    release()
    expect(await Promise.all(three)).toEqual(['r', 'r', 'r'])
    t.setOutcome({ kind: 'ok', reply: 'r' })
    expect(await t.asks.ask(owner(), { agent: 'e', message: 'x' }, sig())).toBe('r')
  })
  it('refuses with stopping after close', async () => {
    const t = setup()
    t.asks.close()
    expect(await reason(t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig()))).toBe(REFUSAL.stopping)
  })
})

describe('AgentAsks.ask: outcomes', () => {
  it('cuts a long reply and says so', async () => {
    const t = setup()
    t.setOutcome({ kind: 'ok', reply: 'x'.repeat(200_000) })
    const r = await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())
    expect(r.startsWith('x'.repeat(ASK_REPLY_MAX))).toBe(true)
    expect(r).toBe('x'.repeat(ASK_REPLY_MAX) + REFUSAL.cut)
  })
  it('does not cut a reply at the limit', async () => {
    const t = setup()
    t.setOutcome({ kind: 'ok', reply: 'x'.repeat(ASK_REPLY_MAX) })
    expect(await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())).toBe('x'.repeat(ASK_REPLY_MAX))
  })
  it('answers a reply with no text', async () => {
    const t = setup()
    t.setOutcome({ kind: 'ok', reply: null })
    expect(await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())).toBe('@b finished without writing a reply.')
  })
  it.each([
    [{ kind: 'busy' } as AskedOutcome, REFUSAL.busy('b')],
    [{ kind: 'stopped' } as AskedOutcome, REFUSAL.stopped('b')],
    [{ kind: 'limited', resetsAt: Date.UTC(2026, 10, 5, 14, 5) } as AskedOutcome, REFUSAL.limited('b', Date.UTC(2026, 10, 5, 14, 5))],
    [{ kind: 'limited', resetsAt: null } as AskedOutcome, REFUSAL.limited('b', null)],
    [{ kind: 'error' } as AskedOutcome, REFUSAL.failed('b')]
  ])('maps %j to its sentence, never the message text', async (outcome, sentence) => {
    const t = setup()
    t.setOutcome(outcome)
    const m = await reason(t.asks.ask(owner(), { agent: 'b', message: 'SECRET-TEXT' }, sig()))
    expect(m).toBe(sentence)
    expect(m).not.toContain('SECRET-TEXT')
  })
  it('says broken when the agent file went missing while it ran', async () => {
    const t = setup()
    t.setOutcome(async () => {
      t.setAgents([agent('a'), agent('c')])
      throw new Error('Agent not found')
    })
    expect(await reason(t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig()))).toBe(REFUSAL.broken('b'))
  })
  it('says failed when the run throws for another reason', async () => {
    const t = setup()
    t.setOutcome(async () => {
      throw new Error('/secret/path boom')
    })
    expect(await reason(t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig()))).toBe(REFUSAL.failed('b'))
  })
  it('says stopped when the signal aborted and the run threw', async () => {
    const t = setup()
    const c = new AbortController()
    t.setOutcome(async () => {
      c.abort()
      throw new Error('aborted')
    })
    expect(await reason(t.asks.ask(owner(), { agent: 'b', message: 'x' }, c.signal))).toBe(REFUSAL.stopped('b'))
  })
})

describe('AgentAsks.sideAsk', () => {
  const call = (agent = 'b') => ({ agent, question: 'quick one' })
  const entry = (over: Partial<SideQuestion>): SideQuestion => ({
    id: 'e1',
    question: 'q',
    agent: 'b',
    askedAt: 0,
    after: null,
    state: 'done',
    answer: 'x',
    ...over
  })

  it('refuses unknown, Zumi Bot, itself and a broken agent as ask does', async () => {
    const t = setup({ agents: [agent('a'), agent('b'), agent('c', 'bad'), agent(ZUMI_BOT_NAME)] })
    t.addAsked('b')
    expect(await reason(t.asks.sideAsk(owner(), call('zz'), sig()))).toBe(REFUSAL.unknown(['b']))
    expect(await reason(t.asks.sideAsk(owner(), call(ZUMI_BOT_NAME), sig()))).toBe(REFUSAL.zumiBot)
    expect(await reason(t.asks.sideAsk(owner(), call('a'), sig()))).toBe(REFUSAL.self)
    expect(await reason(t.asks.sideAsk(owner(), call('c'), sig()))).toBe(REFUSAL.broken('c'))
    expect(t.sides).toHaveLength(0)
  })
  it("a Codex agent answers a side question too: the asker gets B's answer", async () => {
    const t = setup({ agents: [agent('a'), { ...agent('b'), provider: 'codex' }] })
    t.addAsked('b')
    expect(await t.asks.sideAsk(owner(), call('b'), sig())).toBe('side answer')
    expect(t.sides).toHaveLength(1)
    expect(t.sides[0]).toMatchObject({ chatId: 'ab-b', o: { question: 'quick one', from: 'a' } })
  })
  it("with btw off for Codex (a later probe failed), a side question to a Codex agent is refused with Phase 1's sentence and never asked", async () => {
    const t = setup({
      agents: [agent('a'), { ...agent('b'), provider: 'codex' }, agent('c')],
      caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { btw: false } : {}) })
    })
    t.addAsked('b')
    t.addAsked('c')
    expect(await reason(t.asks.sideAsk(owner(), call('b'), sig()))).toBe(CODEX_REFUSALS.btw)
    expect(t.sides).toHaveLength(0)
    // A Claude agent still answers.
    expect(await t.asks.sideAsk(owner(), call('c'), sig())).toBe('side answer')
  })
  it('refuses with no conversation and never makes a chat', async () => {
    const t = setup()
    t.addAsked('c')
    t.addAsked('b', 'other')
    const before = t.store.size
    expect(await reason(t.asks.sideAsk(owner(), call('b'), sig()))).toBe(REFUSAL.noConversation('b'))
    expect(t.store.size).toBe(before)
    expect(t.sides).toHaveLength(0)
  })
  it('asks the A to B chat with the asker, the question, the link and the signal', async () => {
    const t = setup()
    t.addAsked('b')
    const signal = sig()
    expect(await t.asks.sideAsk(owner(), call('@B'), signal)).toBe('side answer')
    expect(t.sides).toHaveLength(1)
    expect(t.sides[0].chatId).toBe('ab-b')
    expect(t.sides[0].o).toEqual({ question: 'quick one', from: 'a', link: null, signal })
    await t.asks.sideAsk(owner({ side: { chatId: 'src', entryId: 'se1' } }), call(), sig())
    expect(t.sides[1].o.link).toEqual({ chatId: 'src', entryId: 'se1' })
  })
  it('refuses a call whose signal is already aborted, before side is reached', async () => {
    const t = setup()
    t.addAsked('b')
    const c = new AbortController()
    c.abort()
    expect(await reason(t.asks.sideAsk(owner(), call(), c.signal))).toBe(REFUSAL.sideStopped('b'))
    expect(t.sides).toHaveLength(0)
    // It also did not use up the turn's count.
    for (let i = 0; i < 10; i++) await t.asks.sideAsk(owner(), call(), sig())
  })
  it('counts with ask: the 11th call of a turn gives perTurn', async () => {
    const t = setup()
    t.addAsked('b')
    for (let i = 0; i < 5; i++) await t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig())
    for (let i = 0; i < 5; i++) await t.asks.sideAsk(owner(), call(), sig())
    expect(await reason(t.asks.sideAsk(owner(), call(), sig()))).toBe(REFUSAL.perTurn)
    expect(await reason(t.asks.ask(owner(), { agent: 'b', message: 'x' }, sig()))).toBe(REFUSAL.perTurn)
  })
  it('refuses the 4th call at once, ask calls counted together', async () => {
    const t = setup({ agents: [agent('a'), agent('b'), agent('c'), agent('d'), agent('e')] })
    t.addAsked('b')
    t.addAsked('c')
    t.addAsked('d')
    t.addAsked('e')
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    t.setSide(async () => {
      await gate
      return entry({ answer: 'r' })
    })
    t.setOutcome(async () => {
      await gate
      return { kind: 'ok', reply: 'r' }
    })
    const three = [
      t.asks.sideAsk(owner(), call('b'), sig()),
      t.asks.sideAsk(owner(), call('c'), sig()),
      t.asks.ask(owner(), { agent: 'd', message: 'x' }, sig())
    ]
    await new Promise((r) => setTimeout(r, 20))
    expect(await reason(t.asks.sideAsk(owner(), call('e'), sig()))).toBe(REFUSAL.parallel)
    release()
    expect(await Promise.all(three)).toEqual(['r', 'r', 'r'])
    expect(await t.asks.sideAsk(owner(), call('e'), sig())).toBe('r')
  })
  it('returns no-answer as a normal result, not a refusal, for empty or blank text', async () => {
    const t = setup()
    t.addAsked('b')
    t.setSide(entry({ answer: '' }))
    expect(await t.asks.sideAsk(owner(), call(), sig())).toBe(REFUSAL.sideNoText('b'))
    t.setSide(entry({ answer: '  \n ' }))
    expect(await t.asks.sideAsk(owner(), call(), sig())).toBe(REFUSAL.sideNoText('b'))
  })
  it('cuts a long answer and says so', async () => {
    const t = setup()
    t.addAsked('b')
    t.setSide(entry({ answer: 'y'.repeat(ASK_REPLY_MAX + 10) }))
    expect(await t.asks.sideAsk(owner(), call(), sig())).toBe('y'.repeat(ASK_REPLY_MAX) + REFUSAL.cut)
  })
  it('maps a stopped entry, a timeout and any other error', async () => {
    const t = setup()
    t.addAsked('b')
    t.setSide(entry({ state: 'stopped' }))
    expect(await reason(t.asks.sideAsk(owner(), call(), sig()))).toBe(REFUSAL.sideStopped('b'))
    t.setSide(entry({ state: 'error', error: SIDE_TIMEOUT_TEXT }))
    expect(await reason(t.asks.sideAsk(owner(), call(), sig()))).toBe(REFUSAL.sideTimeout('b'))
    t.setSide(entry({ state: 'error', error: 'Could not read /home/x/.claude' }))
    expect(await reason(t.asks.sideAsk(owner(), call(), sig()))).toBe(REFUSAL.sideFailed('b'))
  })
  it('maps a thrown limit, and hides any other thrown text', async () => {
    const t = setup()
    t.addAsked('b')
    t.setSide(new Error(SIDE_LIMIT_TEXT))
    expect(await reason(t.asks.sideAsk(owner(), call(), sig()))).toBe(REFUSAL.sideLimit('b'))
    t.setSide(new Error('Chat not found: /x/y'))
    const m = await reason(t.asks.sideAsk(owner(), call(), sig()))
    expect(m).toBe(REFUSAL.sideFailed('b'))
    expect(m).not.toContain('/')
    t.setSide(new Error('Side question stopped'))
    expect(await reason(t.asks.sideAsk(owner(), call(), sig()))).toBe(REFUSAL.sideFailed('b'))
  })
  it('says stopped when the signal is aborted while side rejects', async () => {
    const t = setup()
    t.addAsked('b')
    const c = new AbortController()
    t.setSide(async () => {
      c.abort()
      throw new Error('Side question stopped')
    })
    expect(await reason(t.asks.sideAsk(owner(), call(), c.signal))).toBe(REFUSAL.sideStopped('b'))
  })
  it('lets ask refuse a side owner', async () => {
    const t = setup()
    expect(await reason(t.asks.ask(owner({ side: { chatId: 'src', entryId: 'se1' } }), { agent: 'b', message: 'x' }, sig()))).toBe(
      REFUSAL.sideRunAsk
    )
    expect(t.runs).toHaveLength(0)
  })
  it('refuses with stopping after close', async () => {
    const t = setup()
    t.addAsked('b')
    t.asks.close()
    expect(await reason(t.asks.sideAsk(owner(), call(), sig()))).toBe(REFUSAL.stopping)
    expect(t.sides).toHaveLength(0)
  })
})
