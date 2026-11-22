import { describe, expect, it } from 'vitest'
import { CommandResolver } from '../../src/core/chat/commandResolver'
import type { AgentCommand } from '@zumibot/shared/commands'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'

const check: AgentCommand = { name: 'check', description: 'c', prompt: 'Use check on $ARGUMENTS' }
const fix: AgentCommand = { name: 'fix', description: 'f', prompt: 'Fix $ARGUMENTS' }

function setup(map: Record<string, AgentCommand[]> = { wk: [check, fix], rv: [check] }, items: ChatItem[] = []) {
  const metas: Record<string, unknown> = {
    single: { id: 'single', agentName: 'wk' },
    room: { id: 'room', agentName: '', group: { members: ['wk', 'rv'] } }
  }
  return new CommandResolver({
    store: {
      get: async (id: string) => (metas[id] ?? null) as ChatMeta | null,
      loadItems: async () => items
    },
    commandsOf: async (agent) => {
      if (!(agent in map)) throw new Error('gone')
      return map[agent]
    }
  })
}

const userItem = (id: string, text: string, command?: { agent: string; name: string; prompt: string }) =>
  ({ type: 'user', id, text, ts: 1, command }) as ChatItem

describe('CommandResolver', () => {
  it('single chat resolves a hand-typed command', async () => {
    expect(await setup().forSend('single', '/check L')).toEqual({ agent: 'wk', name: 'check', prompt: 'Use check on L' })
  })

  it('unknown, uppercase and spaced names stay plain', async () => {
    const r = setup()
    for (const t of ['/nope L', '/Check L', ' /check L']) expect(await r.forSend('single', t)).toBeUndefined()
  })

  it('room: unique owner resolves without a pick', async () => {
    expect(await setup().forSend('room', '/fix L')).toMatchObject({ agent: 'wk', name: 'fix' })
  })

  it('room: duplicate name without a pick is refused', async () => {
    await expect(setup().forSend('room', '/check L')).rejects.toThrow('Several members have /check (Wk, Rv): pick one from the / menu')
  })

  it('room: a pick chooses the owner', async () => {
    expect(await setup().forSend('room', '/check L', { agent: 'rv', name: 'check' })).toMatchObject({ agent: 'rv' })
  })

  it('a pick for an agent outside the chat is refused', async () => {
    const r = setup({ wk: [check], rv: [check], other: [check] })
    await expect(r.forSend('room', '/check L', { agent: 'other', name: 'check' })).rejects.toThrow('Other is not in this chat')
    // a pick for another name is still ignored
    expect(await r.forSend('single', '/check L', { agent: 'other', name: 'fix' })).toMatchObject({ agent: 'wk' })
  })

  it('a stale pick is refused', async () => {
    const r = setup({ wk: [check, fix], rv: [] })
    await expect(r.forSend('room', '/check L', { agent: 'rv', name: 'check' })).rejects.toThrow('Rv has no /check command any more')
  })

  it('a failing commandsOf counts as no commands', async () => {
    expect(await setup({ rv: [check] }).forSend('room', '/check L')).toMatchObject({ agent: 'rv' })
  })

  it('resend falls back to the saved prompt', async () => {
    const saved = { agent: 'wk', name: 'check', prompt: 'old' }
    const r = setup({ wk: [] }, [userItem('u1', '/check L', saved)])
    expect(await r.forRerun('single', 'u1', null)).toEqual(saved)
  })

  it('edit re-resolves and keeps the room pick', async () => {
    const r = setup(undefined, [userItem('u1', '/check L', { agent: 'rv', name: 'check', prompt: 'old' })])
    expect(await r.forRerun('room', 'u1', '/check M')).toEqual({ agent: 'rv', name: 'check', prompt: 'Use check on M' })
  })

  it('edit to another command takes the menu pick, in a room where several members have the name', async () => {
    const r = setup(undefined, [userItem('u1', 'plain text')])
    await expect(r.forRerun('room', 'u1', '/check M')).rejects.toThrow('Several members have /check')
    expect(await r.forRerun('room', 'u1', '/check M', { agent: 'rv', name: 'check' })).toEqual({
      agent: 'rv',
      name: 'check',
      prompt: 'Use check on M'
    })
  })

  it('edit prefers the menu pick over the old command agent', async () => {
    const r = setup(undefined, [userItem('u1', '/check L', { agent: 'rv', name: 'check', prompt: 'old' })])
    expect(await r.forRerun('room', 'u1', '/check M', { agent: 'wk', name: 'check' })).toEqual({
      agent: 'wk',
      name: 'check',
      prompt: 'Use check on M'
    })
  })

  it('edit with a menu pick that no longer holds is refused, not retried without it', async () => {
    const r = setup({ wk: [check], rv: [] }, [userItem('u1', '/check L', { agent: 'wk', name: 'check', prompt: 'old' })])
    await expect(r.forRerun('room', 'u1', '/check M', { agent: 'rv', name: 'check' })).rejects.toThrow('Rv has no /check command any more')
  })

  it('resend of a plain message stays plain after the agent gains the command', async () => {
    const r = setup(undefined, [userItem('u1', '/check x')])
    expect(await r.forRerun('single', 'u1', null)).toBeUndefined()
  })

  it('edit after the agent lost the command resolves to plain text', async () => {
    const r = setup({ wk: [] }, [userItem('u1', '/check A', { agent: 'wk', name: 'check', prompt: 'old' })])
    expect(await r.forRerun('single', 'u1', '/check B')).toBeUndefined()
  })

  it('room edit whose owner left resolves to the remaining unique owner', async () => {
    const r = setup({ wk: [check], rv: [] }, [userItem('u1', '/check A', { agent: 'gone', name: 'check', prompt: 'old' })])
    expect(await r.forRerun('room', 'u1', '/check B')).toMatchObject({ agent: 'wk', prompt: 'Use check on B' })
  })

  it('edit that retries into an ambiguous name still throws', async () => {
    const r = setup(undefined, [userItem('u1', '/check A', { agent: 'gone', name: 'check', prompt: 'old' })])
    await expect(r.forRerun('room', 'u1', '/check B')).rejects.toThrow('Several members have /check')
  })

  it('a missing user item resolves to nothing', async () => {
    expect(await setup().forRerun('single', 'nope', null)).toBeUndefined()
  })

  describe('/todo', () => {
    const day: AgentCommand = { name: 'day', description: 'd', prompt: 'Plan $ARGUMENTS', todos: true }

    it('a flagged command carries todos: true, an unflagged one does not', async () => {
      const r = setup({ wk: [day, check] })
      expect(await r.forSend('single', '/day today')).toEqual({ agent: 'wk', name: 'day', prompt: 'Plan today', todos: true })
      expect('todos' in (await r.forSend('single', '/check L'))!).toBe(false)
    })

    it("a command's model goes on the sent command; an invalid one does not", async () => {
      const card: AgentCommand = { name: 'card', description: 'd', prompt: 'Card $ARGUMENTS', model: 'sonnet' }
      const odd: AgentCommand = { name: 'odd', description: 'd', prompt: 'Odd', model: 'gpt' }
      const r = setup({ wk: [card, odd, check] })
      expect(await r.forSend('single', '/card x')).toEqual({ agent: 'wk', name: 'card', prompt: 'Card x', model: 'sonnet' })
      expect('model' in ((await r.forSend('single', '/check L')) ?? {})).toBe(false)
    })

    it('edit resolves the command after /todo, and keeps the old pick for it', async () => {
      const r = setup(undefined, [userItem('u1', '/todo /check L', { agent: 'rv', name: 'check', prompt: 'old' })])
      expect(await r.forRerun('room', 'u1', '/todo /check M')).toEqual({ agent: 'rv', name: 'check', prompt: 'Use check on M' })
    })

    it('resend falls back to the saved command and a bare /todo stays plain', async () => {
      const saved = { agent: 'wk', name: 'check', prompt: 'old' }
      expect(await setup({ wk: [] }, [userItem('u1', '/todo /check L', saved)]).forRerun('single', 'u1', null)).toEqual(saved)
      expect(await setup(undefined, [userItem('u1', '/todo plan', undefined)]).forRerun('single', 'u1', '/todo plan')).toBeUndefined()
    })

    it('resend re-resolves the command after /todo with the same pick', async () => {
      const r = setup(undefined, [userItem('u1', '/todo /check L', { agent: 'rv', name: 'check', prompt: 'old' })])
      expect(await r.forRerun('room', 'u1', null)).toEqual({ agent: 'rv', name: 'check', prompt: 'Use check on L' })
    })

    it('a routine never resolves /todo or a command behind it', async () => {
      const r = setup()
      expect(await r.forRoutine('single', '/todo /check {{body.pr}}', '/todo /check 42')).toBeUndefined()
      expect(await r.forRoutine('single', '/todo {{body.x}}', '/todo plan')).toBeUndefined()
    })
  })

  describe('forRoutine', () => {
    it("resolves the saved prompt's command, with the filled-in text as its arguments", async () => {
      expect(await setup().forRoutine('single', '/check {{body.pr}}', '/check 42')).toEqual({
        agent: 'wk',
        name: 'check',
        prompt: 'Use check on 42'
      })
    })

    it('a command only a webhook field put at the start stays plain text', async () => {
      const r = setup()
      expect(await r.forRoutine('single', '{{body.text}}', '/fix everything')).toBeUndefined()
      expect(await r.forRoutine('single', '{{body.text}} later', '/check x later')).toBeUndefined()
    })

    it('a plain prompt and an unknown name stay plain', async () => {
      const r = setup()
      expect(await r.forRoutine('single', 'Summarize', 'Summarize')).toBeUndefined()
      expect(await r.forRoutine('single', '/nope x', '/nope x')).toBeUndefined()
    })

    it('room: the saved pick chooses between members with the same name', async () => {
      const r = setup()
      expect(await r.forRoutine('room', '/check L', '/check L', { agent: 'rv', name: 'check' })).toMatchObject({ agent: 'rv' })
      await expect(r.forRoutine('room', '/check L', '/check L')).rejects.toThrow('Several members have /check')
    })

    it('a pick gone stale falls back to the name, and only a real ambiguity is refused', async () => {
      // rv left the room's commands: wk is the one owner left.
      expect(await setup({ wk: [check], rv: [] }).forRoutine('room', '/check L', '/check L', { agent: 'rv', name: 'check' })).toMatchObject(
        { agent: 'wk' }
      )
      // A member outside the room, while two inside have the name.
      const both = setup({ wk: [check], rv: [check], gone: [check] })
      await expect(both.forRoutine('room', '/check L', '/check L', { agent: 'gone', name: 'check' })).rejects.toThrow(
        'Several members have /check'
      )
      // The agent lost it and nobody else has it: plain text, as a hand-typed unknown name.
      expect(await setup({ wk: [], rv: [] }).forRoutine('room', '/check L', '/check L', { agent: 'wk', name: 'check' })).toBeUndefined()
    })

    it("a pick for another name than the prompt's is ignored", async () => {
      expect(await setup().forRoutine('single', '/check L', '/check L', { agent: 'rv', name: 'fix' })).toMatchObject({
        agent: 'wk',
        name: 'check'
      })
    })
  })
})
