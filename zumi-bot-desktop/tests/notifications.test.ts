import { describe, expect, it } from 'vitest'
import type { DesktopNotification } from '@zumibot/shared/desktop'
import { checkDesktopNotification, createClickRelay, createDesktopNotifier, type NotificationLike } from '../src/main/notifications'

class Fake implements NotificationLike {
  shown = false
  closed = false
  click: (() => void) | null = null
  show(): void {
    this.shown = true
  }
  close(): void {
    this.closed = true
  }
  on(_e: 'click', cb: () => void): void {
    this.click = cb
  }
}

function setup() {
  const made: Fake[] = []
  const opts: { title: string; body: string; silent: boolean }[] = []
  const clicks: (string | null)[] = []
  const opens: (string | null)[] = []
  const n = createDesktopNotifier({
    create: (o) => {
      opts.push(o)
      const f = new Fake()
      made.push(f)
      return f
    },
    onClick: (id, open) => {
      clicks.push(id)
      opens.push(open)
    }
  })
  return { n, made, opts, clicks, opens }
}

const note = (o: Partial<DesktopNotification> = {}): DesktopNotification => ({
  tag: 'chat:c1',
  chatId: 'c1',
  kind: 'replied',
  title: 'T',
  body: 'B',
  ...o
})

describe('createDesktopNotifier', () => {
  it('shows with the page text', () => {
    const { n, made, opts } = setup()
    n.show(note({ title: 'Hello', body: 'World' }))
    expect(made[0].shown).toBe(true)
    expect(opts[0]).toMatchObject({ title: 'Hello', body: 'World' })
  })

  it('closes the older notification when the same tag is shown again', () => {
    const { n, made } = setup()
    n.show(note())
    n.show(note({ body: 'B2' }))
    expect(made[0].closed).toBe(true)
    expect(made[1].closed).toBe(false)
    expect(made[1].shown).toBe(true)
  })

  it('close(chatId, true) closes only the waiting ones of that chat', () => {
    const { n, made } = setup()
    n.show(note({ tag: 'w', kind: 'waiting' }))
    n.show(note({ tag: 'r', kind: 'replied' }))
    n.show(note({ tag: 'o', chatId: 'c2', kind: 'waiting' }))
    n.close('c1', true)
    expect(made.map((m) => m.closed)).toEqual([true, false, false])
  })

  it('close(chatId, false) closes every notification of that chat', () => {
    const { n, made } = setup()
    n.show(note({ tag: 'w', kind: 'waiting' }))
    n.show(note({ tag: 'r', kind: 'replied' }))
    n.show(note({ tag: 'o', chatId: 'c2' }))
    n.close('c1', false)
    expect(made.map((m) => m.closed)).toEqual([true, true, false])
  })

  it('a click calls onClick with the chat and drops the entry', () => {
    const { n, made, clicks } = setup()
    n.show(note())
    made[0].click?.()
    expect(clicks).toEqual(['c1'])
    n.close('c1', false)
    expect(made[0].closed).toBe(false) // already dropped
  })

  it('a click hands over the open path of its notification, or null', () => {
    const { n, made, opens } = setup()
    n.show(note({ tag: 'a', chatId: null, kind: 'workflow', open: '/inbox/v1' }))
    n.show(note({ tag: 'b' }))
    made[0].click?.()
    made[1].click?.()
    expect(opens).toEqual(['/inbox/v1', null])
  })

  it('a click on a replaced notification does not drop its replacement', () => {
    const { n, made } = setup()
    n.show(note())
    n.show(note({ body: 'B2' }))
    made[0].click?.()
    n.close('c1', false)
    expect(made[1].closed).toBe(true)
  })

  it('keeps at most 100, closing the oldest', () => {
    const { n, made } = setup()
    for (let i = 0; i < 101; i++) n.show(note({ tag: `t${i}`, chatId: `c${i}` }))
    expect(made[0].closed).toBe(true)
    expect(made.slice(1).every((m) => !m.closed)).toBe(true)
  })

  it('closeAll closes everything', () => {
    const { n, made } = setup()
    n.show(note({ tag: 'a' }))
    n.show(note({ tag: 'b', chatId: null }))
    n.closeAll()
    expect(made.every((m) => m.closed)).toBe(true)
  })

  it('closeAll still closes the others when one close throws, and does not throw', () => {
    const { n, made } = setup()
    n.show(note({ tag: 'a' }))
    n.show(note({ tag: 'b' }))
    n.show(note({ tag: 'c' }))
    made[1].close = () => {
      throw new Error('gone')
    }
    expect(() => n.closeAll()).not.toThrow()
    expect(made[0].closed).toBe(true)
    expect(made[2].closed).toBe(true)
  })

  it('closeTag closes that one notification, chat or none', () => {
    const { n, made } = setup()
    n.show(note({ tag: 'workflow:r1:waiting', chatId: null, kind: 'waiting' }))
    n.show(note({ tag: 'workflow:r2:waiting', chatId: null, kind: 'waiting' }))
    n.show(note({ tag: 'chat:c1' }))
    n.closeTag('workflow:r1:waiting')
    n.closeTag('nope')
    expect(made.map((m) => m.closed)).toEqual([true, false, false])
  })

  it('a null chatId notification is never matched by close', () => {
    const { n, made } = setup()
    n.show(note({ tag: 'a', chatId: null, kind: 'routine-failed' }))
    n.close('c1', false)
    expect(made[0].closed).toBe(false)
  })
})

describe('checkDesktopNotification', () => {
  it('accepts a valid notification as a copy', () => {
    const v = { tag: 'chat:c1', chatId: 'c1', kind: 'waiting', title: 'T', body: 'B', extra: 1 }
    const r = checkDesktopNotification(v)
    expect(r).toEqual({ tag: 'chat:c1', chatId: 'c1', kind: 'waiting', title: 'T', body: 'B' })
    expect(r).not.toBe(v)
  })

  it('accepts a null chatId and an empty body', () => {
    expect(checkDesktopNotification({ tag: 't', chatId: null, kind: 'test', title: 'T', body: '' })).not.toBeNull()
  })

  it('accepts every known kind', () => {
    for (const kind of ['waiting', 'replied', 'error', 'routine-failed', 'test', 'paused', 'workflow'])
      expect(checkDesktopNotification({ tag: 't', chatId: null, kind, title: 'T', body: 'B' }), kind).not.toBeNull()
  })

  it('accepts a workflow Notify step (no chat, its own title and body) and still refuses an unknown kind', () => {
    const wf = { tag: 'workflow:r1', chatId: null, kind: 'workflow', title: 'Done', body: 'All 3 files synced' }
    expect(checkDesktopNotification(wf)).toEqual(wf)
    expect(checkDesktopNotification({ ...wf, kind: 'workflows' })).toBeNull()
    expect(checkDesktopNotification({ ...wf, body: 'x'.repeat(201) })).toBeNull()
  })

  it('checkDesktopNotification keeps a safe open path', () => {
    const wf = { tag: 'workflow:r1', chatId: null, kind: 'workflow', title: 'Done', body: 'B' }
    expect(checkDesktopNotification({ ...wf, open: '/inbox/v%201-2_x.y' })).toEqual({ ...wf, open: '/inbox/v%201-2_x.y' })
    expect(checkDesktopNotification({ ...wf, open: '/' })).toEqual({ ...wf, open: '/' })
    const run = '/workflows/0b4c5a1e-6f2d-4e8a-9c3b-1d2e3f4a5b6c/runs/7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f'
    expect(checkDesktopNotification({ ...wf, kind: 'waiting', open: run })).toEqual({ ...wf, kind: 'waiting', open: run })
    expect(checkDesktopNotification({ ...wf, open: '/' + 'a'.repeat(511) })).toMatchObject({ open: '/' + 'a'.repeat(511) })
    expect(checkDesktopNotification(wf)).not.toHaveProperty('open')
  })

  it('drops an open path with a scheme or spaces, keeping the notification itself', () => {
    const wf = { tag: 'workflow:r1', chatId: null, kind: 'workflow', title: 'Done', body: 'B' }
    for (const open of [
      'https://evil.example/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      '//evil.example/x',
      'inbox/v1',
      '',
      '/inbox/a b',
      '/inbox?x=1',
      '/inbox#x',
      '/inbox\\x',
      '/inbox/\n',
      '/' + 'a'.repeat(512),
      5,
      null,
      {}
    ])
      expect(checkDesktopNotification({ ...wf, open }), String(open)).toEqual(wf)
  })

  it('rejects bad input', () => {
    const ok = { tag: 't', chatId: 'c', kind: 'replied', title: 'T', body: 'B' }
    for (const bad of [
      { ...ok, kind: 'nope' },
      { ...ok, kind: 5 },
      { ...ok, title: 5 },
      { ...ok, title: 'x'.repeat(201) },
      { ...ok, body: 'x'.repeat(201) },
      { ...ok, body: null },
      { ...ok, tag: '' },
      { ...ok, tag: 'x'.repeat(201) },
      { ...ok, chatId: 'x'.repeat(201) },
      { ...ok, chatId: 5 },
      { ...ok, chatId: undefined },
      null,
      undefined,
      'str',
      5,
      []
    ])
      expect(checkDesktopNotification(bad)).toBeNull()
  })

  it('accepts exactly 200 characters', () => {
    expect(checkDesktopNotification({ tag: 't', chatId: null, kind: 'test', title: 'x'.repeat(200), body: 'B' })).not.toBeNull()
  })
})

describe('createClickRelay', () => {
  it('holds a click until ready, then delivers once', () => {
    const sent: (string | null)[] = []
    const r = createClickRelay((t) => sent.push(t.chatId))
    r.click('c1')
    expect(sent).toEqual([])
    r.ready()
    expect(sent).toEqual(['c1'])
    r.ready()
    expect(sent).toEqual(['c1'])
  })

  it('keeps only the latest held click', () => {
    const sent: (string | null)[] = []
    const r = createClickRelay((t) => sent.push(t.chatId))
    r.click('c1')
    r.click('c2')
    r.ready()
    expect(sent).toEqual(['c2'])
  })

  it('delivers immediately when already ready', () => {
    const sent: (string | null)[] = []
    const r = createClickRelay((t) => sent.push(t.chatId))
    r.ready()
    r.click('c1')
    r.click(null)
    expect(sent).toEqual(['c1', null])
  })

  it('reset makes the next click wait for a new ready', () => {
    const sent: (string | null)[] = []
    const r = createClickRelay((t) => sent.push(t.chatId))
    r.ready()
    r.reset()
    r.click('c1')
    expect(sent).toEqual([])
    r.ready()
    expect(sent).toEqual(['c1'])
  })
})

describe('createClickRelay open path', () => {
  it('holds the open path until ready, then delivers it with the chat', () => {
    const sent: { chatId: string | null; open: string | null }[] = []
    const r = createClickRelay((t) => sent.push(t))
    r.click(null, '/inbox/v1')
    expect(sent).toEqual([])
    r.ready()
    expect(sent).toEqual([{ chatId: null, open: '/inbox/v1' }])
  })

  it('a click without an open path delivers null, and the latest held click wins whole', () => {
    const sent: { chatId: string | null; open: string | null }[] = []
    const r = createClickRelay((t) => sent.push(t))
    r.click(null, '/inbox/v1')
    r.click('c2')
    r.ready()
    r.click('c3', '/inbox/v3')
    expect(sent).toEqual([
      { chatId: 'c2', open: null },
      { chatId: 'c3', open: '/inbox/v3' }
    ])
  })
})
