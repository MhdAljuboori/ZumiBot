import { describe, expect, it } from 'vitest'
import { WAKE_NOTES, WAKE_PER_CHAT_HOUR, WAKE_PER_SERVER_HOUR, type WakeEvent } from '@zumibot/shared/processes'
import { ProcessWakes } from '../../src/core/processes/processWakes'

const ev = (over: Partial<WakeEvent> = {}): WakeEvent => ({
  chatId: 'c1',
  id: 'p_0000000001',
  name: 'web',
  startedBy: 'dev',
  kind: 'exit',
  exitCode: 1,
  signal: null,
  line: null,
  tail: 'boom',
  at: 0,
  ...over
})
const settle = () => new Promise((r) => setTimeout(r, 10))

function setup(over: { running?: boolean; archived?: boolean; room?: boolean; overAgent?: string; gone?: boolean } = {}) {
  const sent: { chatId: string; text: string; id: string }[] = []
  const notes: [string, string][] = []
  const cleared: string[] = []
  const state = { running: over.running ?? false, taskIds: [] as string[], now: 1_000_000, n: 0 }
  const w = new ProcessWakes({
    submit: async (chatId, text, id) => {
      sent.push({ chatId, text, id })
    },
    running: () => state.running,
    chat: async () => (over.gone ? null : { archived: over.archived ?? false, room: over.room ?? false, taskIds: state.taskIds }),
    gate: async (agents) => agents.find((a) => a === over.overAgent) ?? null,
    note: async (id, note) => {
      notes.push([id, note])
    },
    sent: async (id) => {
      cleared.push(id)
    },
    now: () => state.now,
    newId: () => `m${++state.n}`
  })
  return { w, sent, notes, cleared, state }
}

describe('ProcessWakes', () => {
  it('sends one message for an event in an idle chat, with the event, the tail and who sends it', async () => {
    const { w, sent, cleared } = setup()
    w.event(ev())
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('sent by ZumiBot')
    expect(sent[0].text).toContain('"web" (p_0000000001) exited with code 1.')
    expect(sent[0].text).toContain('boom')
    expect(cleared).toEqual(['p_0000000001'])
  })

  it('never sends while a turn runs, and joins what came meanwhile at the idle', async () => {
    const { w, sent, state } = setup({ running: true })
    w.event(ev())
    w.event(ev({ id: 'p_0000000002', name: 'tests', kind: 'match', line: 'FAIL a.test.ts', exitCode: null }))
    await settle()
    expect(sent).toEqual([])
    expect(w.pending('c1')).toBe(2)
    state.running = false
    w.idle('c1')
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('"web" (p_0000000001) exited with code 1.')
    expect(sent[0].text).toContain('"tests" (p_0000000002) printed a line you asked to hear about: FAIL a.test.ts')
  })

  it('waits while its earlier message is still queued (a paused chat), then sends the rest after it', async () => {
    const { w, sent, state } = setup()
    w.event(ev())
    await settle()
    state.taskIds = [sent[0].id]
    w.event(ev({ exitCode: 3 }))
    w.idle('c1')
    await settle()
    expect(sent).toHaveLength(1)
    state.taskIds = []
    w.idle('c1')
    await settle()
    expect(sent).toHaveLength(2)
    expect(sent[1].text).toContain('code 3')
  })

  it('names the starters in a room, so the moderator hands it to them', async () => {
    const { w, sent } = setup({ room: true })
    w.event(ev({ startedBy: 'web-dev' }))
    await settle()
    expect(sent[0].text.split('\n')[0]).toBe('@web-dev')
  })

  it("drops an agent's events past its spend cap, and an archived or gone chat's, noting why", async () => {
    const capped = setup({ overAgent: 'dev' })
    capped.w.event(ev())
    capped.w.event(ev({ id: 'p_0000000002', startedBy: 'other' }))
    await settle()
    expect(capped.notes).toEqual([['p_0000000001', WAKE_NOTES.spendCap]])
    expect(capped.sent).toHaveLength(1)
    expect(capped.sent[0].text).not.toContain('p_0000000001')
    const archived = setup({ archived: true })
    archived.w.event(ev())
    await settle()
    expect(archived.sent).toEqual([])
    expect(archived.notes).toEqual([['p_0000000001', WAKE_NOTES.closed]])
    const gone = setup({ gone: true })
    gone.w.event(ev())
    await settle()
    expect(gone.sent).toEqual([])
    expect(gone.notes).toEqual([])
  })

  it('caps wake-ups per chat and per server each hour, so a crash loop cannot run up cost', async () => {
    const { w, sent, notes, state } = setup()
    for (let i = 0; i < WAKE_PER_CHAT_HOUR + 2; i++) {
      w.event(ev())
      await settle()
    }
    expect(sent).toHaveLength(WAKE_PER_CHAT_HOUR)
    expect(notes.at(-1)).toEqual(['p_0000000001', WAKE_NOTES.chatCap])
    state.now += 3_600_001
    w.event(ev())
    await settle()
    expect(sent).toHaveLength(WAKE_PER_CHAT_HOUR + 1)
    const s = setup()
    for (let i = 0; i < WAKE_PER_SERVER_HOUR + 1; i++) {
      s.w.event(ev({ chatId: `c${i}` }))
      await settle()
    }
    expect(s.sent).toHaveLength(WAKE_PER_SERVER_HOUR)
    expect(s.notes.at(-1)).toEqual(['p_0000000001', WAKE_NOTES.serverCap])
  })
})
