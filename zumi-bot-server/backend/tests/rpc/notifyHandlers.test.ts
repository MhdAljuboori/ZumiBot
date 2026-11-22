import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TOGGLES, type NotifyStatus, type NotifyToggles } from '@zumibot/shared/notify'
import type { ServerMode } from '@zumibot/shared/types'
import { NotifyStore } from '../../src/core/notify/notifyStore'
import type { PresenceReport } from '../../src/core/notify/presence'
import { createNotifyHandlers } from '../../src/rpc/notifyHandlers'
import type { ConnHandlers } from '../../src/rpc/hub'

const ID = 'device-0001'
const OTHER = 'device-0002'
const conn = { id: 'conn-1', sessionKey: 'sess-1' }
const NEWSESS = { id: 'conn-2', sessionKey: 'sess-2' }

const sub = (host = 'push.example.com', id = 'a') => ({
  endpoint: `https://${host}/send/${id}`,
  keys: { p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') }
})

let dir: string
let store: NotifyStore
let t: number
let updates: { connId: string; r: PresenceReport }[]
let tested: string[]

function setup(mode: ServerMode = 'vps', testOrigin: string | null = null): ConnHandlers {
  return createNotifyHandlers({
    store,
    presence: {
      update: (connId, r) => void updates.push({ connId, r }),
      deviceOf: (connId) => updates.filter((u) => u.connId === connId).at(-1)?.r.deviceId ?? null
    },
    notify: {
      test: async (id) => (tested.push(id), 'sent' as const),
      state: () => ({ pending: { c1: 2 }, lookedAt: { c1: 5 } })
    },
    mode,
    testOrigin,
    now: () => t
  })
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'cb-notify-h-'))
  store = new NotifyStore(dir)
  t = 1_000_000
  updates = []
  tested = []
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const enablePush = (h: ConnHandlers, id = ID, c = conn, s = sub()) =>
  h['notify:enable']!(c, id, { channel: 'push', label: 'Phone', subscription: s }) as Promise<NotifyStatus>

describe('notifyHandlers: argument checks', () => {
  const calls: [string, unknown[]][] = [
    ['notify:status', []],
    ['notify:enable', [{ channel: 'desktop', label: 'x' }]],
    ['notify:refresh', [null]],
    ['notify:disable', []],
    ['notify:remove', []],
    ['notify:setPrefs', [DEFAULT_TOGGLES]],
    ['notify:test', []],
    ['notify:presence', [null, false, 0]]
  ]

  it.each(calls)('%s rejects a bad deviceId', async (name, rest) => {
    const h = setup()
    for (const bad of [undefined, 5, '', 'short', 'has space!', 'x'.repeat(65), '../etc/passwd']) {
      await expect(h[name]!(conn, bad, ...rest)).rejects.toThrow(/deviceId/)
    }
  })

  it('setPrefs rejects bad toggles', async () => {
    const h = setup()
    for (const bad of [null, 'x', {}, { waiting: true }, { ...DEFAULT_TOGGLES, error: 'yes' }]) {
      await expect(h['notify:setPrefs']!(conn, ID, bad)).rejects.toThrow(/toggles/)
    }
  })

  it('presence rejects a bad chatId, looking or inputAgoMs and forwards nothing', async () => {
    const h = setup()
    for (const chatId of [undefined, 5, {}]) await expect(h['notify:presence']!(conn, ID, chatId, true, 0)).rejects.toThrow(/chatId/)
    await expect(h['notify:presence']!(conn, ID, 'c1', 'yes', 0)).rejects.toThrow(/looking/)
    for (const ago of [undefined, '5', -1, NaN, Infinity])
      await expect(h['notify:presence']!(conn, ID, 'c1', true, ago)).rejects.toThrow(/inputAgoMs/)
    for (const ago of ['5', -1, NaN, Infinity, {}])
      await expect(h['notify:presence']!(conn, ID, 'c1', true, 0, ago)).rejects.toThrow(/openedAgoMs/)
    expect(updates).toEqual([])
  })

  it('enable rejects a bad channel, a bad label or a non-object', async () => {
    const h = setup()
    await expect(h['notify:enable']!(conn, ID, null)).rejects.toThrow()
    await expect(h['notify:enable']!(conn, ID, { channel: 'sms', label: 'x' })).rejects.toThrow(/channel/)
    for (const label of [undefined, 5, '', '   ', '\u0000\u0007', 'x'.repeat(81)]) {
      await expect(h['notify:enable']!(conn, ID, { channel: 'desktop', label })).rejects.toThrow(/label/)
    }
    expect(await store.devices()).toEqual([])
  })

  it('refresh rejects a bad subscription', async () => {
    const h = setup()
    await expect(h['notify:refresh']!(conn, ID, { endpoint: 'http://x', keys: {} })).rejects.toThrow(/subscription/)
    await expect(h['notify:refresh']!(conn, ID, 'nope')).rejects.toThrow(/subscription/)
  })
})

describe('notifyHandlers: enable', () => {
  it('push in local mode throws and stores nothing', async () => {
    const h = setup('local')
    await expect(enablePush(h)).rejects.toThrow('Push is not available in Local mode')
    expect(await store.devices()).toEqual([])
  })

  it('push needs a valid subscription', async () => {
    const h = setup()
    await expect(h['notify:enable']!(conn, ID, { channel: 'push', label: 'Phone' })).rejects.toThrow(/subscription/)
    await expect(h['notify:enable']!(conn, ID, { channel: 'push', label: 'Phone', subscription: sub('127.0.0.1') })).rejects.toThrow(
      /subscription/
    )
    expect(await store.devices()).toEqual([])
  })

  it('the dev test origin is the one http endpoint allowed', async () => {
    const h = setup('vps', 'http://127.0.0.1:5555')
    await enablePush(h, ID, conn, { ...sub(), endpoint: 'http://127.0.0.1:5555/p/1' })
    expect((await store.get(ID))?.push?.endpoint).toBe('http://127.0.0.1:5555/p/1')
  })

  it('stores the binding with the connection session key, unpaused, default toggles', async () => {
    const h = setup()
    const s = sub()
    await enablePush(h, ID, conn, s)
    const rec = await store.get(ID)
    expect(rec).toMatchObject({
      id: ID,
      channel: 'push',
      label: 'Phone',
      toggles: DEFAULT_TOGGLES,
      createdAt: t,
      lastSeenAt: t,
      push: { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, sessionKey: 'sess-1', paused: false }
    })
  })

  it('strips control characters from the label', async () => {
    const h = setup()
    await h['notify:enable']!(conn, ID, { channel: 'desktop', label: ' My\u0007 PC\n ' })
    expect((await store.get(ID))?.label).toBe('My PC')
  })

  it('desktop needs no subscription, also in local mode, and stores no binding', async () => {
    const h = setup('local')
    const st = (await h['notify:enable']!(conn, ID, { channel: 'desktop', label: 'ZumiBot desktop' })) as NotifyStatus
    expect((await store.get(ID))?.push).toBeUndefined()
    expect(st.devices.map((d) => [d.id, d.channel, d.subscribed, d.current])).toEqual([[ID, 'desktop', false, true]])
  })

  it('enabling again keeps the toggles and creation time', async () => {
    const h = setup()
    const toggles: NotifyToggles = { ...DEFAULT_TOGGLES, replied: false }
    await enablePush(h)
    await h['notify:setPrefs']!(conn, ID, toggles)
    t += 5000
    await enablePush(h, ID, conn, sub('push.example.com', 'b'))
    expect(await store.get(ID)).toMatchObject({ toggles, createdAt: 1_000_000, lastSeenAt: t })
  })

  it('a new device id with the same endpoint replaces the old record', async () => {
    const h = setup()
    const s = sub()
    await enablePush(h, ID, conn, s)
    await enablePush(h, OTHER, conn, s)
    expect((await store.devices()).map((d) => d.id)).toEqual([OTHER])
  })

  it('creates the VAPID keys and returns the public key', async () => {
    const h = setup()
    const st = (await enablePush(h)) as NotifyStatus
    expect(st.vapidPublicKey).toBe(await store.vapidPublicKey())
    expect(st.vapidPublicKey).toBeTruthy()
  })
})

describe('notifyHandlers: status', () => {
  it('vps: push available, creates and returns the key on first call', async () => {
    const h = setup()
    const st = (await h['notify:status']!(conn, ID)) as NotifyStatus
    expect(st.pushAvailable).toBe(true)
    expect(st.vapidPublicKey).toBe(await store.vapidPublicKey())
    expect(st.vapidPublicKey).toBeTruthy()
    expect(st.devices).toEqual([])
  })

  it('local: push unavailable, no key created', async () => {
    const h = setup('local')
    const st = (await h['notify:status']!(conn, ID)) as NotifyStatus
    expect(st).toEqual({ pushAvailable: false, vapidPublicKey: null, devices: [] })
    expect(await store.vapidPublicKey()).toBeNull()
  })

  it('never carries the endpoint, keys or session key, and marks the asking device current', async () => {
    const h = setup()
    const a = sub('push.example.com', 'a')
    const b = sub('push.example.com', 'b')
    await enablePush(h, ID, conn, a)
    await enablePush(h, OTHER, NEWSESS, b)
    const st = (await h['notify:status']!(conn, ID)) as NotifyStatus
    const text = JSON.stringify(st)
    for (const secret of [
      a.endpoint,
      a.keys.p256dh,
      a.keys.auth,
      b.endpoint,
      b.keys.p256dh,
      b.keys.auth,
      'sess-1',
      'sess-2',
      'endpoint',
      'p256dh',
      'sessionKey'
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(st.devices.map((d) => [d.id, d.current, d.subscribed, d.paused])).toEqual([
      [ID, true, true, false],
      [OTHER, false, true, false]
    ])
    expect(st.devices[0]).toEqual({
      id: ID,
      label: 'Phone',
      channel: 'push',
      toggles: DEFAULT_TOGGLES,
      lastSeenAt: t,
      subscribed: true,
      paused: false,
      current: true
    })
  })

  it('shows a paused binding as paused', async () => {
    const h = setup()
    await enablePush(h)
    await store.patch(ID, (r) => ({ ...r, push: { ...r.push!, paused: true } }))
    const st = (await h['notify:status']!(conn, ID)) as NotifyStatus
    expect(st.devices[0]).toMatchObject({ subscribed: true, paused: true })
  })
})

describe('notifyHandlers: refresh', () => {
  it('an unknown device returns known:false and creates nothing', async () => {
    const h = setup()
    expect(await h['notify:refresh']!(conn, ID, sub())).toEqual({ known: false })
    expect(await h['notify:refresh']!(conn, ID, null)).toEqual({ known: false })
    expect(await store.devices()).toEqual([])
  })

  it('rebinds the session key, clears paused and bumps lastSeenAt', async () => {
    const h = setup()
    await enablePush(h)
    await store.patch(ID, (r) => ({ ...r, push: { ...r.push!, paused: true } }))
    t += 9000
    expect(await h['notify:refresh']!(NEWSESS, ID, null)).toEqual({ known: true })
    const rec = await store.get(ID)
    expect(rec?.push).toMatchObject({ sessionKey: 'sess-2', paused: false })
    expect(rec?.lastSeenAt).toBe(t)
  })

  it('updates the subscription when given', async () => {
    const h = setup()
    await enablePush(h)
    const next = sub('push.example.com', 'fresh')
    await h['notify:refresh']!(conn, ID, next)
    expect((await store.get(ID))?.push).toMatchObject({ endpoint: next.endpoint, p256dh: next.keys.p256dh, auth: next.keys.auth })
  })

  it('a desktop device is known and only gets lastSeenAt bumped', async () => {
    const h = setup('local')
    await h['notify:enable']!(conn, ID, { channel: 'desktop', label: 'PC' })
    t += 1000
    expect(await h['notify:refresh']!(conn, ID, null)).toEqual({ known: true })
    const rec = await store.get(ID)
    expect(rec?.push).toBeUndefined()
    expect(rec?.lastSeenAt).toBe(t)
  })
})

describe('notifyHandlers: disable, remove, prefs, test, state', () => {
  it('disable removes the own device and returns the status without it', async () => {
    const h = setup()
    await enablePush(h)
    await enablePush(h, OTHER, NEWSESS, sub('push.example.com', 'b'))
    const st = (await h['notify:disable']!(conn, ID)) as NotifyStatus
    expect(st.devices.map((d) => d.id)).toEqual([OTHER])
  })

  it('remove drops another device; its status marks the asking connection device current', async () => {
    const h = setup()
    await enablePush(h)
    await enablePush(h, OTHER, NEWSESS, sub('push.example.com', 'b'))
    await h['notify:presence']!(conn, ID, null, false, 0)
    const st = (await h['notify:remove']!(conn, OTHER)) as NotifyStatus
    expect(st.devices.map((d) => [d.id, d.current])).toEqual([[ID, true]])
  })

  it('disable and remove of an unknown device succeed', async () => {
    const h = setup()
    expect(((await h['notify:disable']!(conn, ID)) as NotifyStatus).devices).toEqual([])
    expect(((await h['notify:remove']!(conn, ID)) as NotifyStatus).devices).toEqual([])
  })

  it('setPrefs replaces the toggles', async () => {
    const h = setup()
    await enablePush(h)
    const next: NotifyToggles = { waiting: false, replied: true, error: false, routineFailed: true }
    const st = (await h['notify:setPrefs']!(conn, ID, next)) as NotifyStatus
    expect(st.devices[0]!.toggles).toEqual(next)
    expect((await store.get(ID))?.toggles).toEqual(next)
  })

  it('setPrefs on an unknown device throws', async () => {
    const h = setup()
    await expect(h['notify:setPrefs']!(conn, ID, DEFAULT_TOGGLES)).rejects.toThrow(/device/i)
  })

  it('test forwards to the service', async () => {
    const h = setup()
    expect(await h['notify:test']!(conn, ID)).toBe('sent')
    expect(tested).toEqual([ID])
  })

  it('state returns the service state', async () => {
    const h = setup()
    expect(await h['notify:state']!(conn)).toEqual({ pending: { c1: 2 }, lookedAt: { c1: 5 } })
  })
})

describe('notifyHandlers: presence', () => {
  it('forwards to Presence.update with the connection id', async () => {
    const h = setup()
    await h['notify:presence']!(conn, ID, 'c1', true, 1200, 9000)
    await h['notify:presence']!(conn, ID, null, false, 0)
    await h['notify:presence']!(conn, ID, 'c1', true, 0, null)
    expect(updates).toEqual([
      { connId: 'conn-1', r: { deviceId: ID, chatId: 'c1', looking: true, inputAgoMs: 1200, openedAgoMs: 9000 } },
      { connId: 'conn-1', r: { deviceId: ID, chatId: null, looking: false, inputAgoMs: 0 } },
      { connId: 'conn-1', r: { deviceId: ID, chatId: 'c1', looking: true, inputAgoMs: 0 } }
    ])
  })

  it('bumps lastSeenAt of an existing device at most once a minute', async () => {
    const h = setup()
    await enablePush(h)
    t += 1000
    await h['notify:presence']!(conn, ID, 'c1', true, 0)
    expect((await store.get(ID))?.lastSeenAt).toBe(t)
    const first = t
    t += 30_000
    await h['notify:presence']!(conn, ID, 'c1', true, 0)
    expect((await store.get(ID))?.lastSeenAt).toBe(first)
    t += 30_000
    await h['notify:presence']!(conn, ID, 'c1', true, 0)
    expect((await store.get(ID))?.lastSeenAt).toBe(t)
  })

  it('creates no record for an unknown device', async () => {
    const h = setup()
    await h['notify:presence']!(conn, ID, 'c1', true, 0)
    expect(await store.devices()).toEqual([])
    expect(updates).toHaveLength(1)
  })
})
