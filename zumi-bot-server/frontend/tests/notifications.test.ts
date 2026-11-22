import { describe, expect, it } from 'vitest'
import type { DeviceSummary, NotifyPayload, NotifyPayloadKind } from '@zumibot/shared/notify'
import {
  INPUT_REPORT_MS,
  onceUntilFailure,
  LOOK_IDLE_MS,
  badgeTitle,
  desktopNotice,
  deviceIdFrom,
  deviceLabel,
  deviceRowNote,
  isLooking,
  lastSeenLabel,
  mergePending,
  newDeviceId,
  presenceReports,
  presenceToSend,
  seedFrom,
  showDot,
  staleTags,
  thisDeviceState,
  waitingChats,
  withoutChats,
  notificationTarget,
  type SentPresence,
  type ShownNotification
} from '../src/state/notifications'

describe('title and dot', () => {
  it('counts chats with something pending', () => {
    expect(waitingChats({ a: 2, b: 1, c: 0 })).toBe(2)
    expect(waitingChats({})).toBe(0)
  })
  it('prefixes the title only while something waits', () => {
    expect(badgeTitle('ZumiBot', 0)).toBe('ZumiBot')
    expect(badgeTitle('ZumiBot', 3)).toBe('(3) ZumiBot')
  })
  it('shows the dot from one waiting chat', () => {
    expect(showDot(0)).toBe(false)
    expect(showDot(1)).toBe(true)
  })
  it('exports the exact constants', () => {
    expect(LOOK_IDLE_MS).toBe(180_000)
    expect(INPUT_REPORT_MS).toBe(30_000)
  })
})

describe('isLooking', () => {
  const base = { visible: true, focused: true, chatId: 'c1', lastInputAt: 1000, now: 2000 }
  it('is true when visible, focused, on a chat and recently active', () => {
    expect(isLooking(base)).toBe(true)
  })
  it('needs each condition', () => {
    expect(isLooking({ ...base, visible: false })).toBe(false)
    expect(isLooking({ ...base, focused: false })).toBe(false)
    expect(isLooking({ ...base, chatId: null })).toBe(false)
  })
  it('stops exactly at the idle limit', () => {
    expect(isLooking({ ...base, lastInputAt: 0, now: 179_999 })).toBe(true)
    expect(isLooking({ ...base, lastInputAt: 0, now: 180_000 })).toBe(false)
  })
})

describe('presenceToSend', () => {
  const prev: SentPresence = { chatId: 'c1', looking: true, at: 100_000, inputAt: 100_000 }
  const next = { chatId: 'c1', looking: true, lastInputAt: 100_000, now: 110_000 }
  it('sends the first time', () => {
    expect(presenceToSend(null, next)).toBe(true)
  })
  it('sends on a chat change', () => {
    expect(presenceToSend(prev, { ...next, chatId: 'c2' })).toBe(true)
  })
  it('sends on a looking change, always including a stop', () => {
    expect(presenceToSend({ ...prev, looking: false }, next)).toBe(true)
    expect(presenceToSend(prev, { ...next, looking: false })).toBe(true)
  })
  it('re-reports new input only after 30 s', () => {
    expect(presenceToSend(prev, { ...next, lastInputAt: 105_000, now: 129_999 })).toBe(false)
    expect(presenceToSend(prev, { ...next, lastInputAt: 105_000, now: 130_000 })).toBe(true)
  })
  it('stays quiet without new input or when not looking', () => {
    expect(presenceToSend(prev, { ...next, now: 500_000 })).toBe(false)
    const idle: SentPresence = { chatId: 'c1', looking: false, at: 0, inputAt: 0 }
    expect(presenceToSend(idle, { chatId: 'c1', looking: false, lastInputAt: 999, now: 500_000 })).toBe(false)
  })
})

describe('staleTags', () => {
  const n = (o: Partial<ShownNotification> & { tag: string }): ShownNotification => ({ chatId: 'c1', kind: 'waiting', at: 100, ...o })
  const state = (pending: Record<string, number>, lookedAt: Record<string, number> = {}) => ({ pending, lookedAt })

  it('closes a waiting one when nothing is pending, or the chat is missing', () => {
    expect(staleTags([n({ tag: 't' })], state({ c1: 0 }))).toEqual(['t'])
    expect(staleTags([n({ tag: 't' })], state({}))).toEqual(['t'])
    expect(staleTags([n({ tag: 't' })], state({ c1: 1 }))).toEqual([])
  })
  it('closes any kind once the chat was looked at after it', () => {
    for (const kind of ['waiting', 'replied', 'error', 'routine-failed'] as const) {
      expect(staleTags([n({ tag: 't', kind })], state({ c1: 1 }, { c1: 101 }))).toEqual(['t'])
      expect(staleTags([n({ tag: 't', kind })], state({ c1: 1 }, { c1: 100 }))).toEqual([])
    }
  })
  it('keeps a replied one while pending is empty', () => {
    expect(staleTags([n({ tag: 't', kind: 'replied' })], state({}))).toEqual([])
  })
  it('never closes test or paused', () => {
    const shown = [n({ tag: 'test', kind: 'test' }), n({ tag: 'paused', kind: 'paused' })]
    expect(staleTags(shown, state({}, { c1: 999 }))).toEqual([])
  })
  it('never closes one without a chat', () => {
    const shown = [n({ tag: 'a', chatId: null, kind: 'routine-failed' }), n({ tag: 'b', chatId: null })]
    expect(staleTags(shown, state({}, { c1: 999 }))).toEqual([])
  })
  it('returns each tag once, in input order', () => {
    const shown = [n({ tag: 'b', chatId: 'c2' }), n({ tag: 'a' }), n({ tag: 'b', chatId: 'c2' })]
    expect(staleTags(shown, state({}))).toEqual(['b', 'a'])
  })
})

describe('deviceLabel', () => {
  const chromeAndroid =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
  const safariIphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const firefoxLinux = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'
  const edgeWindows =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
  const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  const safariMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
  const chromeIos =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1'
  const firefoxIos =
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15'
  const chromeOs = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

  it('names the browser and the system', () => {
    expect(deviceLabel(chromeAndroid, false)).toBe('Chrome on Android')
    expect(deviceLabel(safariIphone, false)).toBe('Safari on iPhone')
    expect(deviceLabel(firefoxLinux, false)).toBe('Firefox on Linux')
    expect(deviceLabel(edgeWindows, false)).toBe('Edge on Windows')
    expect(deviceLabel(chromeMac, false)).toBe('Chrome on Mac')
    expect(deviceLabel(safariMac, false)).toBe('Safari on Mac')
    expect(deviceLabel(chromeOs, false)).toBe('Chrome on ChromeOS')
  })
  it('maps the iOS wrappers', () => {
    expect(deviceLabel(chromeIos, false)).toBe('Chrome on iPhone')
    expect(deviceLabel(firefoxIos, false)).toBe('Firefox on iPad')
  })
  it('labels the desktop shell regardless of the UA', () => {
    expect(deviceLabel(chromeMac, true)).toBe('ZumiBot desktop')
    expect(deviceLabel('', true)).toBe('ZumiBot desktop')
  })
  it('falls back to Browser', () => {
    expect(deviceLabel('', false)).toBe('Browser')
    expect(deviceLabel('curl/8.0', false)).toBe('Browser')
  })
  it('keeps the label short', () => {
    expect(deviceLabel('x'.repeat(500) + ' Firefox/1', false).length).toBeLessThanOrEqual(60)
  })
})

describe('deviceIdFrom', () => {
  const mem = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init))
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }
  it('returns the stored id', () => {
    const s = mem({ 'zumibot.deviceId': 'abcd-1234-efgh' })
    expect(deviceIdFrom(s, () => 'never-used-id')).toBe('abcd-1234-efgh')
  })
  it('stores a new id when none is saved', () => {
    const s = mem()
    expect(deviceIdFrom(s, () => 'fresh-id-0001')).toBe('fresh-id-0001')
    expect(s.m.get('zumibot.deviceId')).toBe('fresh-id-0001')
  })
  it('replaces a stored value the server would refuse', () => {
    for (const bad of ['short', 'has space in it', 'x'.repeat(65), '']) {
      const s = mem({ 'zumibot.deviceId': bad })
      expect(deviceIdFrom(s, () => 'fresh-id-0002')).toBe('fresh-id-0002')
      expect(s.m.get('zumibot.deviceId')).toBe('fresh-id-0002')
    }
  })
  it('survives a storage that throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(deviceIdFrom(bad, () => 'fresh-id-0003')).toBe('fresh-id-0003')
  })
  it('still returns the new id when only saving throws', () => {
    const s = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full')
      }
    }
    expect(deviceIdFrom(s, () => 'fresh-id-0004')).toBe('fresh-id-0004')
  })
})

describe('presenceReports', () => {
  const sent: SentPresence = { chatId: 'c1', looking: true, at: 100_000, inputAt: 100_000 }
  const next = { chatId: 'c1', looking: true, lastInputAt: 100_000, now: 110_000 }

  it('sends one fresh report the first time', () => {
    expect(presenceReports(null, { ...next, lastInputAt: 104_000 })).toEqual([{ chatId: 'c1', looking: true, inputAgoMs: 6_000 }])
  })
  it('sends nothing when presenceToSend would not', () => {
    expect(presenceReports(sent, { ...next, lastInputAt: 105_000, now: 129_999 })).toEqual([])
  })
  it('re-reports throttled input as one looking report', () => {
    expect(presenceReports(sent, { ...next, lastInputAt: 105_000, now: 130_000 })).toEqual([
      { chatId: 'c1', looking: true, inputAgoMs: 25_000 }
    ])
  })
  it('flushes unreported input to the old chat before a chat change', () => {
    expect(presenceReports(sent, { chatId: 'c2', looking: true, lastInputAt: 108_000, now: 110_000 })).toEqual([
      { chatId: 'c1', looking: true, inputAgoMs: 2_000 },
      { chatId: 'c2', looking: true, inputAgoMs: 2_000 }
    ])
  })
  it('flushes before looking stops (blur, hidden, no chat, idle)', () => {
    expect(presenceReports(sent, { ...next, looking: false, lastInputAt: 105_000 })).toEqual([
      { chatId: 'c1', looking: true, inputAgoMs: 5_000 },
      { chatId: 'c1', looking: false, inputAgoMs: 5_000 }
    ])
    expect(presenceReports(sent, { chatId: null, looking: false, lastInputAt: 105_000, now: 110_000 })).toEqual([
      { chatId: 'c1', looking: true, inputAgoMs: 5_000 },
      { chatId: null, looking: false, inputAgoMs: 5_000 }
    ])
  })
  it('does not flush when the server already has the latest input', () => {
    expect(presenceReports(sent, { ...next, chatId: 'c2' })).toEqual([{ chatId: 'c2', looking: true, inputAgoMs: 10_000 }])
    expect(presenceReports(sent, { ...next, looking: false })).toEqual([{ chatId: 'c1', looking: false, inputAgoMs: 10_000 }])
  })
  it('never flushes for a chat that was not being looked at', () => {
    const idle: SentPresence = { chatId: 'c1', looking: false, at: 0, inputAt: 0 }
    expect(presenceReports(idle, { chatId: 'c2', looking: false, lastInputAt: 5_000, now: 10_000 })).toEqual([
      { chatId: 'c2', looking: false, inputAgoMs: 5_000 }
    ])
  })
  it('never reports a negative input age', () => {
    expect(presenceReports(null, { chatId: null, looking: false, lastInputAt: 20, now: 10 })).toEqual([
      { chatId: null, looking: false, inputAgoMs: 0 }
    ])
  })
  it('tells when the chat on screen was opened, never on the flush for the old one (that would end its mark)', () => {
    expect(presenceReports(sent, { chatId: 'c2', looking: true, lastInputAt: 108_000, now: 110_000, openedAt: 109_000 })).toEqual([
      { chatId: 'c1', looking: true, inputAgoMs: 2_000 },
      { chatId: 'c2', looking: true, inputAgoMs: 2_000, openedAgoMs: 1_000 }
    ])
    expect(presenceReports(null, { ...next, openedAt: 120_000 })).toEqual([
      { chatId: 'c1', looking: true, inputAgoMs: 10_000, openedAgoMs: 0 }
    ])
  })
})

describe('pending seed', () => {
  it('keeps only chats the live pushes have not set', () => {
    expect(seedFrom({ a: 2, b: 1, c: 0 }, { b: 3 })).toEqual({ a: 2 })
  })
  it('lets live counts win in the merge', () => {
    expect(mergePending({ a: 2, b: 1 }, { b: 3, c: 1 })).toEqual({ a: 2, b: 3, c: 1 })
  })
  it('drops chats from the seed', () => {
    expect(withoutChats({ a: 2, b: 1 }, ['b', 'x'])).toEqual({ a: 2 })
  })
  it('returns the same seed when nothing is dropped', () => {
    const seed = { a: 2 }
    expect(withoutChats(seed, ['x'])).toBe(seed)
  })
})

describe('thisDeviceState', () => {
  const dev = (o: Partial<DeviceSummary> = {}): DeviceSummary => ({
    id: 'me-device-1',
    label: 'Chrome on Linux',
    channel: 'push',
    toggles: { waiting: true, replied: true, error: true, routineFailed: true },
    lastSeenAt: 0,
    subscribed: true,
    paused: false,
    current: true,
    ...o
  })
  const browser = { shell: 'none' as const, pushAvailable: true, support: 'ok' as const }

  it('is On for a subscribed push device and Off without one', () => {
    expect(thisDeviceState({ ...browser, me: dev() })).toEqual({ text: 'On', canEnable: false, canDisable: true })
    expect(thisDeviceState({ ...browser, me: undefined })).toEqual({ text: 'Off', canEnable: true, canDisable: false })
  })
  it('asks to enable again after the push service dropped the subscription', () => {
    expect(thisDeviceState({ ...browser, me: dev({ subscribed: false }) })).toEqual({
      text: 'Off: enable it again',
      canEnable: true,
      canDisable: true
    })
  })
  it('shows a paused device', () => {
    expect(thisDeviceState({ ...browser, me: dev({ paused: true }) }).text).toBe('Paused: signed out')
  })
  it('names what stops the browser', () => {
    expect(thisDeviceState({ ...browser, support: 'denied', me: undefined })).toEqual({
      text: 'Blocked by the browser',
      canEnable: false,
      canDisable: false
    })
    expect(thisDeviceState({ ...browser, support: 'unsupported', me: undefined }).text).toBe('Not supported')
    expect(thisDeviceState({ ...browser, support: 'ios-needs-install', me: undefined }).text).toBe(
      'On iPhone, add ZumiBot to the Home Screen first'
    )
  })
  it('still lets a blocked device be turned off', () => {
    expect(thisDeviceState({ ...browser, support: 'denied', me: dev() })).toEqual({
      text: 'Blocked by the browser',
      canEnable: false,
      canDisable: true
    })
  })
  it('uses no push wording without push (Local mode in a browser)', () => {
    expect(thisDeviceState({ shell: 'none', pushAvailable: false, support: 'ios-needs-install', me: undefined })).toEqual({
      text: 'Not supported',
      canEnable: false,
      canDisable: false
    })
  })
  it('registers the new shell without push', () => {
    const shell = { shell: 'new' as const, pushAvailable: false, support: 'unsupported' as const }
    expect(thisDeviceState({ ...shell, me: undefined })).toEqual({ text: 'Off', canEnable: true, canDisable: false })
    expect(thisDeviceState({ ...shell, me: dev({ channel: 'desktop', subscribed: false }) })).toEqual({
      text: 'On',
      canEnable: false,
      canDisable: true
    })
  })
  it('asks an old shell to update', () => {
    expect(thisDeviceState({ shell: 'old', pushAvailable: true, support: 'ok', me: undefined })).toEqual({
      text: 'Update the desktop app to get notifications',
      canEnable: false,
      canDisable: false
    })
  })
})

describe('deviceRowNote', () => {
  const dev = (o: Partial<DeviceSummary>): DeviceSummary => ({
    id: 'x-device-1',
    label: 'Safari on iPhone',
    channel: 'push',
    toggles: { waiting: true, replied: true, error: true, routineFailed: true },
    lastSeenAt: 0,
    subscribed: true,
    paused: false,
    current: false,
    ...o
  })
  it('notes paused and dropped push devices only', () => {
    expect(deviceRowNote(dev({ paused: true }))).toBe('Paused: signed out')
    expect(deviceRowNote(dev({ subscribed: false }))).toBe('Needs enabling again')
    expect(deviceRowNote(dev({}))).toBe('')
    expect(deviceRowNote(dev({ channel: 'desktop', subscribed: false }))).toBe('')
  })
})

describe('lastSeenLabel', () => {
  it('says how long ago, simply', () => {
    expect(lastSeenLabel(1_000, 30_000)).toBe('just now')
    expect(lastSeenLabel(0, 5 * 60_000)).toBe('5 min ago')
    expect(lastSeenLabel(0, 2 * 3_600_000 + 1)).toBe('2 hr ago')
    expect(lastSeenLabel(0, 24 * 3_600_000)).toBe('1 day ago')
    expect(lastSeenLabel(0, 3 * 24 * 3_600_000)).toBe('3 days ago')
  })
  it('treats a clock ahead of this one as just now', () => {
    expect(lastSeenLabel(10_000, 0)).toBe('just now')
  })
})

describe('desktopNotice', () => {
  const p = (kind: NotifyPayloadKind, agent?: string, o: Partial<NotifyPayload> = {}): NotifyPayload => ({
    v: 1,
    kind,
    tag: 'chat:c1',
    chatId: 'c1',
    title: 'Plan the trip',
    agent,
    at: 1,
    ...o
  })

  it('builds the shell notification from the payload', () => {
    const r = desktopNotice(undefined, p('waiting', 'writer', { tag: 'chat:c1:waiting' }))
    expect(r.notification).toEqual({
      tag: 'chat:c1:waiting',
      chatId: 'c1',
      kind: 'waiting',
      title: 'Plan the trip',
      body: 'Writer needs you'
    })
    expect(r.shown).toEqual({ kind: 'waiting', agents: ['writer'] })
  })
  it("a to-do card's question opens the Inbox, and says it is a question", () => {
    const r = desktopNotice(undefined, p('waiting', 'writer', { tag: 'chat:c1:waiting', inbox: true }))
    expect(r.notification).toEqual({
      tag: 'chat:c1:waiting',
      chatId: 'c1',
      kind: 'waiting',
      title: 'Plan the trip',
      body: 'Writer has a question for you',
      open: '/inbox'
    })
  })
  it('merges room reply names under one tag', () => {
    const first = desktopNotice(undefined, p('replied', 'writer'))
    const second = desktopNotice(first.shown, p('replied', 'news'))
    expect(second.notification.body).toBe('Writer, News replied')
  })
  it('does not carry a reply name into an error', () => {
    const first = desktopNotice(undefined, p('replied', 'writer'))
    expect(desktopNotice(first.shown, p('error', 'news')).notification.body).toBe("News's reply ended with an error")
  })
})

describe('desktopNotice open path', () => {
  const wf = (o: Partial<NotifyPayload> = {}): NotifyPayload => ({
    v: 1,
    kind: 'workflow',
    tag: 'workflow:r1',
    chatId: null,
    title: 'Done',
    at: 1,
    body: 'B',
    ...o
  })

  it('gives a Notify message its Inbox path', () => {
    expect(desktopNotice(undefined, wf({ message: 'v1' })).notification.open).toBe('/inbox/v1')
    expect(desktopNotice(undefined, wf({ message: 'a/b c' })).notification.open).toBe('/inbox/a%2Fb%20c')
  })
  it('gives nothing without a message or a run, or to another kind', () => {
    expect(desktopNotice(undefined, wf()).notification).not.toHaveProperty('open')
    expect(desktopNotice(undefined, { ...wf({ message: 'v1' }), kind: 'replied' }).notification).not.toHaveProperty('open')
  })
  it("gives a workflow approval or failure its run's path", () => {
    const run = { workflowId: 'w1', runId: 'r1' }
    expect(desktopNotice(undefined, wf({ kind: 'waiting', tag: 'workflow:r1:waiting', run })).notification.open).toBe(
      '/workflows/w1/runs/r1'
    )
    expect(desktopNotice(undefined, wf({ kind: 'routine-failed', tag: 'workflow:r1', run })).notification.open).toBe(
      '/workflows/w1/runs/r1'
    )
    expect(desktopNotice(undefined, wf({ kind: 'waiting', run: { workflowId: 'a b', runId: 'c/d' } })).notification.open).toBe(
      '/workflows/a%20b/runs/c%2Fd'
    )
  })
  it('a Notify message opens its Inbox message, not its run', () => {
    expect(desktopNotice(undefined, wf({ message: 'v1', run: { workflowId: 'w1', runId: 'r1' } })).notification.open).toBe('/inbox/v1')
  })
})

describe('notificationTarget', () => {
  it('opens the Inbox message of an inbox path, ahead of the chat', () => {
    expect(notificationTarget({ chatId: null, open: '/inbox/v1' })).toEqual({ kind: 'inbox', messageId: 'v1' })
    expect(notificationTarget({ chatId: 'c1', open: '/inbox/a%2Fb' })).toEqual({ kind: 'inbox', messageId: 'a/b' })
    expect(notificationTarget({ chatId: null, open: '/inbox' })).toEqual({ kind: 'inbox', messageId: null })
  })
  it('falls back to the chat for no path or a path the app does not route to', () => {
    expect(notificationTarget({ chatId: 'c1', open: null })).toEqual({ kind: 'chat', chatId: 'c1' })
    expect(notificationTarget({ chatId: 'c1', open: '/nope' })).toEqual({ kind: 'chat', chatId: 'c1' })
    expect(notificationTarget({ chatId: 'c1', open: 'https://evil.example/inbox/v1' })).toEqual({ kind: 'chat', chatId: 'c1' })
  })
  it("opens a workflow run's path, ahead of the chat", () => {
    expect(notificationTarget({ chatId: null, open: '/workflows/w1/runs/r1' })).toEqual({ kind: 'run', workflowId: 'w1', runId: 'r1' })
    expect(notificationTarget({ chatId: 'c1', open: '/workflows/a%20b/runs/c%2Fd' })).toEqual({
      kind: 'run',
      workflowId: 'a b',
      runId: 'c/d'
    })
  })
  it('a workflow path without a run is no target', () => {
    expect(notificationTarget({ chatId: null, open: '/workflows/w1' })).toBeNull()
    expect(notificationTarget({ chatId: 'c1', open: '/workflows' })).toEqual({ kind: 'chat', chatId: 'c1' })
  })
  it('does nothing without either', () => {
    expect(notificationTarget({ chatId: null, open: null })).toBeNull()
    expect(notificationTarget({ chatId: null, open: '/nope' })).toBeNull()
  })
})

describe('newDeviceId', () => {
  it('uses randomUUID when there is one', () => {
    expect(newDeviceId({ randomUUID: () => 'aaaa-bbbb-cccc' })).toBe('aaaa-bbbb-cccc')
  })
  it('falls back to random bytes the server accepts', () => {
    const id = newDeviceId({ getRandomValues: (a: Uint8Array) => a })
    expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/)
  })
  it('still makes an id with no crypto at all', () => {
    expect(newDeviceId(undefined)).toMatch(/^[A-Za-z0-9-]{8,64}$/)
  })
})

describe('onceUntilFailure', () => {
  it('runs once while a run is in flight or after it succeeded', async () => {
    let calls = 0
    let release!: () => void
    const run = onceUntilFailure(() => {
      calls++
      return new Promise<void>((r) => {
        release = r
      })
    })
    run()
    run()
    expect(calls).toBe(1)
    release()
    await Promise.resolve()
    await Promise.resolve()
    run()
    expect(calls).toBe(1)
  })

  it('runs again on the next call after a failure, without throwing', async () => {
    let calls = 0
    const run = onceUntilFailure(async () => {
      calls++
      if (calls === 1) throw new Error('offline')
    })
    run()
    await new Promise((r) => setTimeout(r, 0))
    run()
    expect(calls).toBe(2)
    await new Promise((r) => setTimeout(r, 0))
    run()
    expect(calls).toBe(2)
  })
})
