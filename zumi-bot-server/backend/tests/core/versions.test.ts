import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import { branch, hiddenItems, mapHidden, switchTo, type UserItem } from '../../src/core/chat/versions'

const user = (id: string, text = id): UserItem => ({ type: 'user', id, text, ts: 1 })
const reply = (id: string): ChatItem => ({ type: 'assistant', id, text: id, ts: 2 })
const ids = (items: readonly ChatItem[]) => items.map((i) => i.id)

describe('versions', () => {
  it('branch hides the tail and shows the new version as 2 of 2', () => {
    const items: ChatItem[] = [user('a'), reply('a1'), user('m'), reply('m1'), reply('m2')]
    const r = branch(items, {}, 'm', user('m-new'))
    expect(ids(r.items)).toEqual(['a', 'a1', 'm-new'])
    expect(r.items.at(-1)).toMatchObject({ versions: { root: 'm', index: 1, count: 2 } })
    expect(r.versions.m.current).toBe(1)
    expect(r.versions.m.list[1]).toBeNull()
    expect(r.hidden).toEqual({ user: user('m'), tail: [reply('m1'), reply('m2')] })
    expect(r.versions.m.list[0]).toEqual(r.hidden)
    expect(ids(hiddenItems(r.versions))).toEqual(['m', 'm1', 'm2'])
  })

  it('branch on a second version makes 3 of 3 and keeps versions 1 and 2', () => {
    const first = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
    const withTail = [...first.items, reply('x1')]
    const second = branch(withTail, first.versions, 'm2', user('m3'))
    expect(second.items.at(-1)).toMatchObject({ id: 'm3', versions: { root: 'm', index: 2, count: 3 } })
    expect(second.versions.m.list.map((v) => v?.user.id ?? null)).toEqual(['m', 'm2', null])
    expect(second.versions.m.list[1]?.tail.map((i) => i.id)).toEqual(['x1'])
    expect(second.versions.m.list[1]?.user).not.toHaveProperty('versions')
  })

  it('switchTo 1 restores its tail and stores the shown one', () => {
    const a = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
    const shown = [...a.items, reply('x1')]
    const back = switchTo(shown, a.versions, 'm2', 0)
    expect(ids(back.items)).toEqual(['m', 'm1'])
    expect(back.items[0]).toMatchObject({ versions: { root: 'm', index: 0, count: 2 } })
    expect(back.versions.m.current).toBe(0)
    expect(back.versions.m.list[0]).toBeNull()
    expect(back.versions.m.list[1]).toEqual({ user: user('m2'), tail: [reply('x1')] })
    const fwd = switchTo(back.items, back.versions, 'm', 1)
    expect(ids(fwd.items)).toEqual(['m2', 'x1'])
    expect(fwd.items[0]).toMatchObject({ versions: { index: 1, count: 2 } })
    const same = switchTo(fwd.items, fwd.versions, 'm2', 1)
    expect(same.items).toBe(fwd.items)
    expect(same.versions).toBe(fwd.versions)
  })

  describe("after a crash between a switch's item write and its last versions write", () => {
    // Shown: version 0 (items already swapped). File: still current = 1 and both slots filled (the safe write).
    const crashed = () => {
      const a = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
      const shown = [...a.items, reply('x1')]
      const back = switchTo(shown, a.versions, 'm2', 0)
      const versions = { m: { current: 1, list: [a.versions.m.list[0], { user: user('m2'), tail: [reply('x1')] }] } }
      return { items: back.items, versions }
    }
    const everyId = (items: readonly ChatItem[], v: Parameters<typeof hiddenItems>[0]) => [...ids(items), ...ids(hiddenItems(v))].sort()

    it('switchTo reads the shown index, so switching back to the lagging version works and loses nothing', () => {
      const { items, versions } = crashed()
      const r = switchTo(items, versions, 'm', 1)
      expect(ids(r.items)).toEqual(['m2', 'x1'])
      expect(r.items[0]).toMatchObject({ versions: { root: 'm', index: 1, count: 2 } })
      expect(r.versions.m.current).toBe(1)
      expect(r.versions.m.list[0]).toEqual({ user: user('m'), tail: [reply('m1')] })
      expect(r.versions.m.list[1]).toBeNull()
      expect(everyId(r.items, r.versions)).toEqual(['m', 'm1', 'm2', 'x1'])
    })

    it('switchTo to the version already shown is a no-op', () => {
      const { items, versions } = crashed()
      const r = switchTo(items, versions, 'm', 0)
      expect(r.items).toBe(items)
      expect(r.versions).toBe(versions)
    })

    it('switchTo to another version never overwrites the lagging slot', () => {
      // Three versions; file says current = 2 but version 0 is shown.
      const a = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
      const b = branch([...a.items, reply('x1')], a.versions, 'm2', user('m3'))
      const back = switchTo([...b.items, reply('y1')], b.versions, 'm3', 0)
      const versions = { m: { current: 2, list: [b.versions.m.list[0], b.versions.m.list[1], { user: user('m3'), tail: [reply('y1')] }] } }
      const r = switchTo(back.items, versions, 'm', 1)
      expect(ids(r.items)).toEqual(['m2', 'x1'])
      expect(everyId(r.items, r.versions)).toEqual(['m', 'm1', 'm2', 'm3', 'x1', 'y1'])
      const again = switchTo(r.items, r.versions, 'm2', 2)
      expect(ids(again.items)).toEqual(['m3', 'y1'])
    })

    it('branch keeps both versions and the shown one', () => {
      const { items, versions } = crashed()
      const r = branch(items, versions, 'm', user('m4'))
      expect(r.items.at(-1)).toMatchObject({ id: 'm4', versions: { root: 'm', index: 2, count: 3 } })
      expect(everyId(r.items, r.versions)).toEqual(['m', 'm1', 'm2', 'm4', 'x1'])
    })
  })

  describe('when the stored set does not match the shown item', () => {
    const everyId = (items: readonly ChatItem[], v: Parameters<typeof hiddenItems>[0]) => [...ids(items), ...ids(hiddenItems(v))].sort()
    const shownAs = (u: UserItem, index: number, count: number): UserItem => ({ ...u, versions: { root: 'm', index, count } })

    it('branch with a lost versions file keeps the shown version and its tail in a slot', () => {
      const items: ChatItem[] = [shownAs(user('m2'), 1, 2), reply('x1')]
      const r = branch(items, {}, 'm2', user('m3'))
      expect(ids(r.items)).toEqual(['m3'])
      expect(everyId(r.items, r.versions)).toEqual(['m2', 'm3', 'x1'])
      expect(r.items[0]).toMatchObject({ versions: { root: 'm', index: 1, count: 2 } })
      expect(r.versions.m.list.map((v) => v?.user.id ?? null)).toEqual(['m2', null])
    })

    it('branch with a shown index that is no slot of the set falls back to the stored current', () => {
      const set = { m: { current: 1, list: [{ user: user('m'), tail: [reply('m1')] }, null] } }
      const items: ChatItem[] = [shownAs(user('m2'), 5, 6), reply('x1')]
      const r = branch(items, set, 'm2', user('m3'))
      expect(everyId(r.items, r.versions)).toEqual(['m', 'm1', 'm2', 'm3', 'x1'])
    })

    it('switchTo with a lost versions file is a no-op for the shown version and rejects the rest', () => {
      const items: ChatItem[] = [shownAs(user('m2'), 1, 2), reply('x1')]
      expect(switchTo(items, {}, 'm2', 0).items).toBe(items)
      expect(() => switchTo(items, {}, 'm2', 1)).toThrow('Version not found')
    })

    // A branch whose versions were saved but whose items never were: shown index 1, file current 2 with an empty slot.
    const stale = () => {
      const a = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
      const items = [...a.items, reply('x1')]
      const b = branch(items, a.versions, 'm2', user('m3'))
      return { items, versions: b.versions }
    }

    it('re-editing after that reuses the empty slot: no version nobody can step to', () => {
      const { items, versions } = stale()
      expect(versions.m.list).toHaveLength(3)
      const r = branch(items, versions, 'm2', user('m4'))
      expect(r.items[0]).toMatchObject({ id: 'm4', versions: { root: 'm', index: 2, count: 3 } })
      expect(r.versions.m.current).toBe(2)
      expect(r.versions.m.list.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0)).toEqual([2])
      expect(everyId(r.items, r.versions)).toEqual(['m', 'm1', 'm2', 'm4', 'x1'])
    })

    it('switching away from that state drops the empty slot and renumbers', () => {
      const { items, versions } = stale()
      const r = switchTo(items, versions, 'm2', 0)
      expect(r.versions.m.list).toHaveLength(2)
      expect(r.items[0]).toMatchObject({ id: 'm', versions: { root: 'm', index: 0, count: 2 } })
      expect(r.versions.m).toMatchObject({ current: 0 })
      expect(r.versions.m.list.map((v) => v?.user.id ?? null)).toEqual([null, 'm2'])
      expect(everyId(r.items, r.versions)).toEqual(['m', 'm1', 'm2', 'x1'])
      // The slot nobody can step to is not reachable either.
      expect(() => switchTo(items, versions, 'm2', 2)).toThrow('Version not found')
      // And the renumbered set still switches.
      const back = switchTo(r.items, r.versions, 'm', 1)
      expect(ids(back.items)).toEqual(['m2', 'x1'])
    })
  })

  describe('after a failed first edit', () => {
    // The not-started path put the unmarked original back (plus an error) while the versions file kept { current: 1, [old, null] }.
    const failedFirst = () => {
      const first = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
      const items: ChatItem[] = [user('m'), reply('m1'), { type: 'error', id: 'e1', text: 'disk full', ts: 3 }]
      return { items, versions: first.versions }
    }

    it('the unmarked original counts as slot 0: the next edit reuses the empty slot, nothing is stored twice', () => {
      const { items, versions } = failedFirst()
      const r = branch(items, versions, 'm', user('m3'))
      expect(r.items.at(-1)).toMatchObject({ id: 'm3', versions: { root: 'm', index: 1, count: 2 } })
      expect(r.versions.m.list).toHaveLength(2)
      expect(r.versions.m.list[1]).toBeNull()
      expect(r.versions.m.list.flatMap((v) => (v ? [v.user.id] : []))).toEqual(['m'])
    })

    it('switchTo from that state still works', () => {
      const { items, versions } = failedFirst()
      const r = branch(items, versions, 'm', user('m3'))
      const back = switchTo(r.items, r.versions, 'm3', 0)
      expect(ids(back.items)).toEqual(['m', 'm1', 'e1'])
      expect(back.items[0]).toMatchObject({ versions: { root: 'm', index: 0, count: 2 } })
      expect(back.versions.m.list.map((v) => v?.user.id ?? null)).toEqual([null, 'm3'])
    })
  })

  it('switchTo rejects a bad or empty slot', () => {
    const a = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
    expect(() => switchTo(a.items, a.versions, 'm2', 5)).toThrow('Version not found')
    expect(() => switchTo(a.items, a.versions, 'm2', -1)).toThrow('Version not found')
    expect(() => switchTo([user('solo')], {}, 'solo', 1)).toThrow('Version not found')
  })

  it('nested: a version hidden inside another keeps its own set', () => {
    // M has a reply and a later message N; N is edited, then M is switched away and back.
    const m1 = branch([user('m'), reply('r1'), user('n'), reply('n1')], {}, 'm', user('m2'))
    const toM0 = switchTo(m1.items, m1.versions, 'm2', 0)
    const n1 = branch(toM0.items, toM0.versions, 'n', user('n2'))
    expect(ids(n1.items)).toEqual(['m', 'r1', 'n2'])
    const away = switchTo(n1.items, n1.versions, 'm', 1)
    expect(ids(away.items)).toEqual(['m2'])
    const back = switchTo(away.items, away.versions, 'm2', 0)
    expect(ids(back.items)).toEqual(['m', 'r1', 'n2'])
    expect(back.items.at(-1)).toMatchObject({ versions: { root: 'n', index: 1, count: 2 } })
    expect(back.versions.n.current).toBe(1)
    expect(back.versions.n.list.map((v) => v?.user.id ?? null)).toEqual(['n', null])
    const n0 = switchTo(back.items, back.versions, 'n2', 0)
    expect(ids(n0.items)).toEqual(['m', 'r1', 'n', 'n1'])
  })

  it('branch and switchTo throw Message not found for a hidden id', () => {
    const a = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
    expect(() => branch(a.items, a.versions, 'm', user('x'))).toThrow('Message not found')
    expect(() => switchTo(a.items, a.versions, 'm', 0)).toThrow('Message not found')
    expect(() => branch(a.items, a.versions, 'nope', user('x'))).toThrow('Message not found')
    // An assistant item with that id is not a user message.
    expect(() => branch([reply('r')], {}, 'r', user('x'))).toThrow('Message not found')
  })

  it('mapHidden rewrites every hidden item and leaves the input alone', () => {
    const a = branch([user('m'), reply('m1')], {}, 'm', user('m2'))
    const mapped = mapHidden(a.versions, (i) => ({ ...i, ts: 99 }))
    expect(hiddenItems(mapped).every((i) => i.ts === 99)).toBe(true)
    expect(mapped.m.current).toBe(1)
    expect(mapped.m.list[1]).toBeNull()
    expect(hiddenItems(a.versions).every((i) => i.ts !== 99)).toBe(true)
  })
})
