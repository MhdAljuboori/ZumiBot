import { describe, expect, it } from 'vitest'
import { MemoryTurns } from '../../src/core/memory/memoryTurns'

function setup(opts: { moveThrows?: boolean; trashRejects?: boolean } = {}) {
  const calls: string[] = []
  const logs: string[] = []
  const turns = new MemoryTurns({
    store: {
      moveAgent(from: string, to: string) {
        calls.push(`move ${from}>${to}`)
        if (opts.moveThrows) throw new Error('boom')
      },
      async trashAgent(name: string) {
        calls.push(`trash ${name}`)
        if (opts.trashRejects) throw new Error('boom')
      }
    },
    log: (l) => logs.push(l)
  })
  return { turns, calls, logs }
}

describe('MemoryTurns', () => {
  it('moves once when nothing runs', () => {
    const { turns, calls } = setup()
    turns.renamed('a', 'b')
    turns.started('a')
    turns.ended('a')
    expect(calls).toEqual(['move a>b'])
  })

  it('moves at once and again when the running turn ends', () => {
    const { turns, calls } = setup()
    turns.started('a')
    turns.renamed('a', 'b')
    expect(calls).toEqual(['move a>b'])
    turns.ended('a')
    expect(calls).toEqual(['move a>b', 'move a>b'])
  })

  it('follows a rename chain to the final name', () => {
    const { turns, calls } = setup()
    turns.started('a')
    turns.renamed('a', 'b')
    turns.renamed('b', 'c')
    calls.length = 0
    turns.ended('a')
    expect(calls).toEqual(['move a>c'])
  })

  it('trashes now and at the end on delete', async () => {
    const { turns, calls } = setup()
    turns.started('a')
    await turns.deleted('a')
    expect(calls).toEqual(['trash a'])
    turns.ended('a')
    expect(calls).toEqual(['trash a', 'trash a'])
  })

  it('waits for every turn of the same name', () => {
    const { turns, calls } = setup()
    turns.started('a')
    turns.started('a')
    turns.renamed('a', 'b')
    calls.length = 0
    turns.ended('a')
    expect(calls).toEqual([])
    turns.ended('a')
    expect(calls).toEqual(['move a>b'])
  })

  it('logs store errors and never throws', async () => {
    const m = setup({ moveThrows: true, trashRejects: true })
    m.turns.started('a')
    expect(() => m.turns.renamed('a', 'b')).not.toThrow()
    expect(() => m.turns.ended('a')).not.toThrow()
    await expect(m.turns.deleted('x')).resolves.toBeUndefined()
    expect(m.logs.length).toBeGreaterThan(0)
    expect(m.logs.join('\n')).not.toContain('boom')
  })

  it('does nothing at the end after renaming back a->b->a', () => {
    const { turns, calls } = setup()
    turns.started('a')
    turns.renamed('a', 'b')
    turns.renamed('b', 'a')
    calls.length = 0
    turns.ended('a')
    expect(calls).toEqual([])
  })

  it('keeps a new same-named agent out of the end-time move', () => {
    const { turns, calls } = setup()
    turns.started('a')
    turns.renamed('a', 'b')
    turns.started('a')
    calls.length = 0
    turns.ended('a')
    turns.ended('a')
    expect(calls).toEqual([])
  })

  it('keeps a recreated agent out of the end-time trash', async () => {
    const { turns, calls } = setup()
    turns.started('a')
    await turns.deleted('a')
    turns.started('a')
    calls.length = 0
    turns.ended('a')
    turns.ended('a')
    expect(calls).toEqual([])
  })

  it('ignores ended without started', () => {
    const { turns, calls } = setup()
    turns.ended('a')
    expect(calls).toEqual([])
  })

  it('logs an end-time trash rejection without throwing', async () => {
    const { turns, logs } = setup({ trashRejects: true })
    turns.started('a')
    await turns.deleted('a')
    expect(() => turns.ended('a')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(logs.length).toBe(2)
  })
})
