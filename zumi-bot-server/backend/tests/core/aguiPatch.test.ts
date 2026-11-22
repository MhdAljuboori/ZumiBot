import { describe, expect, it } from 'vitest'
import { applyPatch } from '../../src/core/agui/aguiPatch'

// A budget no test below reaches: only the budget tests at the end measure it.
const ROOM = 1 << 20
const ok = (doc: unknown, ops: unknown) => {
  const r = applyPatch(doc, ops, ROOM)
  if (!r.ok) throw new Error('patch failed')
  return r.doc
}

describe('applyPatch', () => {
  it('adds to an object, inserts into an array and appends with -', () => {
    expect(ok({ a: 1 }, [{ op: 'add', path: '/b', value: { c: [1] } }])).toEqual({ a: 1, b: { c: [1] } })
    expect(ok({ a: [1, 3] }, [{ op: 'add', path: '/a/1', value: 2 }])).toEqual({ a: [1, 2, 3] })
    expect(ok({ a: [1] }, [{ op: 'add', path: '/a/1', value: 2 }])).toEqual({ a: [1, 2] })
    expect(ok({ a: [1] }, [{ op: 'add', path: '/a/-', value: 2 }])).toEqual({ a: [1, 2] })
    expect(ok({ a: 1 }, [{ op: 'add', path: '/a', value: 5 }])).toEqual({ a: 5 })
    expect(ok({ a: 1 }, [{ op: 'add', path: '', value: [9] }])).toEqual([9])
  })

  it('removes a key or an element', () => {
    expect(ok({ a: 1, b: 2 }, [{ op: 'remove', path: '/a' }])).toEqual({ b: 2 })
    expect(ok({ a: [1, 2, 3] }, [{ op: 'remove', path: '/a/1' }])).toEqual({ a: [1, 3] })
  })

  it('replaces a key, an element or the whole document', () => {
    expect(ok({ a: 1 }, [{ op: 'replace', path: '/a', value: null }])).toEqual({ a: null })
    expect(ok({ a: [1, 2] }, [{ op: 'replace', path: '/a/0', value: 'x' }])).toEqual({ a: ['x', 2] })
    expect(ok({ a: 1 }, [{ op: 'replace', path: '', value: 'all' }])).toBe('all')
  })

  it('moves and copies', () => {
    expect(ok({ a: { x: 1 }, b: {} }, [{ op: 'move', from: '/a/x', path: '/b/y' }])).toEqual({ a: {}, b: { y: 1 } })
    expect(ok({ a: [1, 2, 3] }, [{ op: 'move', from: '/a/0', path: '/a/-' }])).toEqual({ a: [2, 3, 1] })
    expect(ok({ a: 1 }, [{ op: 'move', from: '/a', path: '/a' }])).toEqual({ a: 1 })
    const copied = ok({ a: { x: [1] } }, [
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'add', path: '/b/x/-', value: 2 }
    ])
    expect(copied).toEqual({ a: { x: [1] }, b: { x: [1, 2] } })
  })

  it('tests with deep JSON equality, key order aside', () => {
    expect(ok({ a: { x: 1, y: [1, { z: 2 }] } }, [{ op: 'test', path: '/a', value: { y: [1, { z: 2 }], x: 1 } }])).toEqual({
      a: { x: 1, y: [1, { z: 2 }] }
    })
    expect(ok({ a: null }, [{ op: 'test', path: '/a', value: null }])).toEqual({ a: null })
  })

  it('fails the whole patch on a failing test and leaves the input alone', () => {
    const doc = { a: 1 }
    expect(
      applyPatch(
        doc,
        [
          { op: 'replace', path: '/a', value: 2 },
          { op: 'test', path: '/a', value: 3 }
        ],
        ROOM
      )
    ).toEqual({ ok: false })
    expect(doc).toEqual({ a: 1 })
    expect(applyPatch({ a: [1, 2] }, [{ op: 'test', path: '/a', value: [2, 1] }], ROOM)).toEqual({ ok: false })
    expect(applyPatch({ a: { x: 1 } }, [{ op: 'test', path: '/a', value: { x: 1, y: 2 } }], ROOM)).toEqual({ ok: false })
    expect(applyPatch({ a: 1 }, [{ op: 'test', path: '/a', value: '1' }], ROOM)).toEqual({ ok: false })
  })

  it('patches a deep copy', () => {
    const doc = { a: { b: [1] } }
    const out = ok(doc, [{ op: 'add', path: '/a/b/-', value: 2 }]) as typeof doc
    expect(doc).toEqual({ a: { b: [1] } })
    expect(out.a.b).toEqual([1, 2])
    const value = { v: 1 }
    const added = ok({}, [{ op: 'add', path: '/x', value }]) as { x: { v: number } }
    value.v = 2
    expect(added.x.v).toBe(1)
  })

  it('reads ~1 as / and ~0 as ~', () => {
    expect(
      ok({ 'a/b': 1, 'c~d': 2 }, [
        { op: 'replace', path: '/a~1b', value: 3 },
        { op: 'remove', path: '/c~0d' }
      ])
    ).toEqual({ 'a/b': 3 })
    expect(ok({}, [{ op: 'add', path: '/~01', value: 1 }])).toEqual({ '~1': 1 })
  })

  it.each([
    ['a path without a leading slash', { a: 1 }, [{ op: 'remove', path: 'a' }]],
    ['a bad escape', { a: 1 }, [{ op: 'add', path: '/a~2', value: 1 }]],
    ['a missing parent', {}, [{ op: 'add', path: '/a/b', value: 1 }]],
    ['a scalar parent', { a: 1 }, [{ op: 'add', path: '/a/b', value: 1 }]],
    ['an index past the end', { a: [1] }, [{ op: 'add', path: '/a/2', value: 1 }]],
    ['a leading-zero index', { a: [1, 2] }, [{ op: 'replace', path: '/a/01', value: 1 }]],
    ['a word as an index', { a: [1] }, [{ op: 'add', path: '/a/x', value: 1 }]],
    ['- outside add', { a: [1] }, [{ op: 'remove', path: '/a/-' }]],
    ['removing a missing key', { a: 1 }, [{ op: 'remove', path: '/b' }]],
    ['removing the whole document', { a: 1 }, [{ op: 'remove', path: '' }]],
    ['replacing a missing key', { a: 1 }, [{ op: 'replace', path: '/b', value: 1 }]],
    ['an inherited name', {}, [{ op: 'remove', path: '/toString' }]],
    ['testing a missing key', {}, [{ op: 'test', path: '/constructor', value: null }]],
    ['moving into its own child', { a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a/c' }]],
    ['moving from nowhere', { a: 1 }, [{ op: 'move', from: '/b', path: '/c' }]],
    ['copying from nowhere', { a: 1 }, [{ op: 'copy', from: '/b', path: '/c' }]],
    ['add without a value', {}, [{ op: 'add', path: '/a' }]],
    ['move without from', { a: 1 }, [{ op: 'move', path: '/b' }]],
    ['an unknown op', { a: 1 }, [{ op: 'merge', path: '/a', value: 1 }]],
    ['an op that is not an object', { a: 1 }, ['remove']],
    ['ops that are not a list', { a: 1 }, { op: 'remove', path: '/a' }]
  ])('fails on %s', (_name, doc, ops) => {
    expect(applyPatch(doc, ops, ROOM)).toEqual({ ok: false })
  })

  it('treats __proto__ as a plain key, never the prototype', () => {
    const out = ok({}, [{ op: 'add', path: '/__proto__', value: { polluted: true } }]) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse('{"__proto__":{"polluted":true}}'))
    const nested = ok(JSON.parse('{"a":{"__proto__":{"x":1}}}'), [{ op: 'replace', path: '/a/__proto__/x', value: 2 }]) as Record<
      string,
      any
    >
    expect(Object.hasOwn(nested.a, '__proto__')).toBe(true)
    expect(nested.a.x).toBeUndefined()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('keeps an own __proto__ key through a copy', () => {
    const doc = JSON.parse('{"a":{"__proto__":{"x":1}}}')
    const out = ok(doc, [{ op: 'copy', from: '/a', path: '/b' }]) as Record<string, any>
    expect(Object.hasOwn(out.b, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out.b)).toBe(Object.prototype)
  })

  describe('the byte budget and the op cap', () => {
    const doubling = (n: number) => Array.from({ length: n }, () => ({ op: 'copy', from: '/a', path: '/a/-' }))

    it('fails a patch that doubles the document past the budget, fast and in little memory', () => {
      // Each op copies /a into itself: 20 of them hold a million nodes, 26 run the process out of memory unbudgeted.
      for (const n of [20, 64]) {
        const heap = process.memoryUsage().heapUsed
        const t = Date.now()
        expect(applyPatch({ a: [1] }, doubling(n), 256 * 1024)).toEqual({ ok: false })
        expect(Date.now() - t).toBeLessThan(500)
        expect(process.memoryUsage().heapUsed - heap).toBeLessThan(32 * 1024 * 1024)
      }
    })

    it('counts what add, replace and copy write, and fails once the total would pass the budget', () => {
      const big = 'x'.repeat(100)
      expect(applyPatch({}, [{ op: 'add', path: '/a', value: big }], 50)).toEqual({ ok: false })
      expect(applyPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: [big] }], 50)).toEqual({ ok: false })
      // The kept document is not counted, only what the patch writes: the copy is.
      expect(applyPatch({ a: big }, [{ op: 'copy', from: '/a', path: '/b' }], 50)).toEqual({ ok: false })
      expect(
        applyPatch(
          {},
          [
            { op: 'add', path: '/a', value: big },
            { op: 'add', path: '/b', value: big }
          ],
          150
        )
      ).toEqual({ ok: false })
      // Within the budget each patch applies; removes and moves write nothing.
      expect(
        applyPatch(
          { a: big },
          [
            { op: 'replace', path: '/a', value: big },
            { op: 'move', from: '/a', path: '/b' },
            { op: 'remove', path: '/b' }
          ],
          150
        )
      ).toEqual({ ok: true, doc: {} })
      expect(applyPatch({}, [{ op: 'add', path: '/a', value: { k: [big, null, true, 12] } }], 150)).toEqual({
        ok: true,
        doc: { a: { k: [big, null, true, 12] } }
      })
    })

    it('refuses a patch of more than 1000 ops', () => {
      const tests = (n: number) => Array.from({ length: n }, () => ({ op: 'test', path: '/a', value: 1 }))
      expect(applyPatch({ a: 1 }, tests(1000), ROOM)).toEqual({ ok: true, doc: { a: 1 } })
      expect(applyPatch({ a: 1 }, tests(1001), ROOM)).toEqual({ ok: false })
    })
  })
})
