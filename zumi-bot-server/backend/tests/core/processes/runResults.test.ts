import { describe, expect, it, vi } from 'vitest'
import { runResultText } from '@zumibot/shared/runBlocks'
import type { RunEndEvent } from '../../../src/core/processes/processService'
import { RunResults } from '../../../src/core/processes/runResults'

const ev = (over: Partial<RunEndEvent> = {}): RunEndEvent => ({
  chatId: 'c1',
  id: 'p_0000000001',
  messageId: 'm1',
  command: 'ls',
  cwd: '/w',
  agent: 'dev',
  startedAt: 1,
  endedAt: 2,
  end: { kind: 'exit', code: 0 },
  outcome: 'ok',
  error: null,
  output: 'a\nb\n',
  cut: false,
  ...over
})
const settle = () => new Promise((r) => setTimeout(r, 5))

function setup(chat: { archived: boolean; room: boolean } | null = { archived: false, room: false }, fail = false) {
  const submit = vi.fn(async (_chatId: string, _text: string, _run: { processId: string }) => {
    if (fail) throw Object.assign(new Error('boom secret'), { code: 'EBOOM' })
  })
  const r = new RunResults({ submit, chat: async () => chat })
  return { r, submit }
}

describe('RunResults', () => {
  it('sends the result for a single chat', async () => {
    const { r, submit } = setup()
    r.ended(ev())
    await settle()
    expect(submit).toHaveBeenCalledWith(
      'c1',
      runResultText({ command: 'ls', output: 'a\nb\n', cut: false, end: { kind: 'exit', code: 0 } }),
      { processId: 'p_0000000001' }
    )
  })
  it('room result mentions the author', async () => {
    const { r, submit } = setup({ archived: false, room: true })
    r.ended(ev())
    await settle()
    expect(submit.mock.calls[0]![1]).toBe(
      runResultText({ command: 'ls', output: 'a\nb\n', cut: false, end: { kind: 'exit', code: 0 }, mention: 'dev' })
    )
    expect(submit.mock.calls[0]![1].startsWith('@dev\n')).toBe(true)
  })
  it('no message when end is null', async () => {
    const { r, submit } = setup()
    r.ended(ev({ end: null, outcome: 'interrupted' }))
    await settle()
    expect(submit).not.toHaveBeenCalled()
  })
  it('archived or gone chat drops it', async () => {
    for (const chat of [{ archived: true, room: false }, null]) {
      const { r, submit } = setup(chat)
      r.ended(ev())
      await settle()
      expect(submit).not.toHaveBeenCalled()
    }
  })
  it('submit failure only logs, with a code and nothing of the run', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { r, submit } = setup(undefined, true)
    expect(() => r.ended(ev())).not.toThrow()
    await settle()
    expect(submit).toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.any(String), 'EBOOM')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    log.mockRestore()
  })
  it('a chat lookup failure only logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const submit = vi.fn()
    const r = new RunResults({ submit, chat: async () => Promise.reject(new Error('x')) })
    expect(() => r.ended(ev())).not.toThrow()
    await settle()
    expect(submit).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
