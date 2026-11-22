import { beforeEach, describe, expect, it } from 'vitest'
import type { Workflow } from '@zumibot/shared/workflows'
import { MAIL_PER_CHECK, MAIL_POLL_MS, type EventBodies, type WorkflowEvent } from '@zumibot/shared/workflowEvents'
import {
  MAIL_CHECK_DEADLINE_MS,
  MailWatchers,
  checkMailbox,
  scrubPassword,
  type MailClient,
  type MailDeps,
  type MailState
} from '../../src/core/workflows/mailWatchers'
import { ACCOUNT_MISSING, MAIL_HOST_MISSING } from '../../src/core/workflows/workflowRunner'

type MailEvent = Extract<WorkflowEvent, { kind: 'email' }>
interface Box {
  uidValidity: string
  uidNext: number
  uids: number[]
}
interface Timer {
  fn: () => void
  ms: number
  cleared: boolean
}

const PASSWORD = 'hunter22'
let box: Box
let accounts: Record<string, { username: string; password: string }>
let connects: { host: string; port: number; user: string; password: string; folder: string }[]
let closed: number
let connectError: Error | null
let gate: Promise<void> | null
let unreadable: Set<number>
let stored: MailState
let writes: number
let emitted: { e: MailEvent; id: string }[]
let timers: Timer[]
let logs: string[]
let free: Record<string, number> // the runner's free run slots per workflow (5 when absent)
let d: MailDeps
let mw: MailWatchers

const wf = (
  id: string,
  over: { enabled?: boolean; account?: string; host?: string; port?: number; folder?: string; name?: string } = {}
): Workflow => ({
  id,
  name: over.name ?? `Name ${id}`,
  enabled: over.enabled ?? true,
  timeZone: 'UTC',
  steps: [],
  edges: [],
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0,
  trigger: {
    kind: 'email',
    account: over.account ?? 'acc',
    host: over.host ?? 'imap.example.com',
    port: over.port ?? 993,
    folder: over.folder ?? 'INBOX',
    filters: []
  }
})
const fileWf = (id: string): Workflow => ({
  ...wf(id),
  trigger: { kind: 'file', path: '/x', pattern: '', changes: ['added'], filters: [] }
})
const active = (): Timer[] => timers.filter((t) => !t.cleared)
// The poll timers only, not a running check's deadline.
const polls = (): Timer[] => active().filter((t) => t.ms === MAIL_POLL_MS)
const add = (...uids: number[]): void => {
  box.uids.push(...uids)
  box.uidNext = Math.max(box.uidNext, ...uids.map((u) => u + 1))
}
const subjects = (): string[] => emitted.map((x) => x.e.body.subject)
const tick = (): void => {
  const t = polls().pop()
  if (!t) throw new Error('no timer armed')
  t.cleared = true
  t.fn()
}
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  box = { uidValidity: 'v1', uidNext: 101, uids: Array.from({ length: 100 }, (_, i) => i + 1) }
  accounts = { acc: { username: 'ann', password: PASSWORD } }
  connects = []
  closed = 0
  connectError = null
  gate = null
  unreadable = new Set()
  stored = {}
  writes = 0
  emitted = []
  timers = []
  logs = []
  free = {}
  d = {
    connect: async (o) => {
      connects.push(o)
      if (gate) await gate
      if (connectError) throw connectError
      const client: MailClient = {
        open: async () => ({ uidValidity: box.uidValidity, uidNext: box.uidNext, exists: box.uids.length }),
        // Newest first on purpose: the watcher puts them in order itself.
        fetchSince: async (uid, max) =>
          box.uids
            .filter((u) => u > uid)
            .sort((a, b) => a - b)
            .slice(0, max)
            .reverse()
            .map((u) => ({ uid: u, source: Buffer.from(`m${u}`) })),
        close: async () => {
          closed++
        }
      }
      return client
    },
    parse: async (source): Promise<EventBodies['email']> => {
      const s = source.toString()
      if (unreadable.has(Number(s.slice(1)))) throw new Error('bad mime')
      return {
        from: { name: 'Ann', address: 'ann@example.com' },
        to: 'me@example.com',
        subject: s,
        date: '',
        messageId: `<${s}>`,
        text: 'hi'
      }
    },
    account: (id) => accounts[id] ?? null,
    state: {
      read: async () => structuredClone(stored),
      write: async (s) => {
        stored = structuredClone(s)
        writes++
      }
    },
    emit: (e, id) => {
      emitted.push({ e, id })
    },
    setTimer: (fn, ms) => {
      const t: Timer = { fn, ms, cleared: false }
      timers.push(t)
      return {
        clear: () => {
          t.cleared = true
        }
      }
    },
    log: (l) => {
      logs.push(l)
    },
    freeRuns: (id) => free[id] ?? 5
  }
  mw = new MailWatchers(d)
})

describe('MailWatchers checks', () => {
  it('records the next UID on the first check and fires nothing', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    expect(connects).toEqual([{ host: 'imap.example.com', port: 993, user: 'ann', password: PASSWORD, folder: 'INBOX' }])
    expect(stored).toEqual({ a: { key: 'imap.example.com|ann|INBOX', uidValidity: 'v1', lastUid: 100 } })
    expect(emitted).toEqual([])
    expect(closed).toBe(1)
  })

  it('fires one event per new message, oldest first, and stores the highest UID', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(101, 102, 103)
    await mw.checkNow('a')
    expect(subjects()).toEqual(['m101', 'm102', 'm103'])
    expect(emitted.every((x) => x.id === 'a' && x.e.kind === 'email')).toBe(true)
    expect(emitted[0]?.e.body).toMatchObject({ from: { address: 'ann@example.com' }, messageId: '<m101>' })
    expect(stored.a?.lastUid).toBe(103)
    await mw.checkNow('a')
    expect(emitted).toHaveLength(3)
    expect(closed).toBe(3)
  })

  it('moves past deleted messages when fewer came back than it asked for', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    box.uidNext = 110 // 101 to 108 came and went
    add(109)
    await mw.checkNow('a')
    expect(subjects()).toEqual(['m109'])
    expect(stored.a?.lastUid).toBe(109)
    box.uidNext = 120 // gone again before this check
    await mw.checkNow('a')
    expect(stored.a?.lastUid).toBe(119)
  })

  it(`fires at most ${MAIL_PER_CHECK} a check and the rest next time`, async () => {
    free.a = 100 // room for more: the per-check cap is what holds here
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(...Array.from({ length: 25 }, (_, i) => 101 + i))
    await mw.checkNow('a')
    expect(subjects()).toEqual(Array.from({ length: MAIL_PER_CHECK }, (_, i) => `m${101 + i}`))
    expect(stored.a?.lastUid).toBe(100 + MAIL_PER_CHECK)
    await mw.checkNow('a')
    expect(subjects().slice(MAIL_PER_CHECK)).toEqual(Array.from({ length: MAIL_PER_CHECK }, (_, i) => `m${111 + i}`))
    await mw.checkNow('a')
    expect(subjects()).toHaveLength(25)
    expect(stored.a?.lastUid).toBe(125)
  })

  it('fetches no more messages than the workflow has free runs, and the rest next time', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(...Array.from({ length: 8 }, (_, i) => 101 + i))
    free.a = 3
    await mw.checkNow('a')
    expect(subjects()).toEqual(['m101', 'm102', 'm103'])
    expect(stored.a?.lastUid).toBe(103)
    free.a = 5
    await mw.checkNow('a')
    expect(subjects().slice(3)).toEqual(['m104', 'm105', 'm106', 'm107', 'm108'])
    expect(stored.a?.lastUid).toBe(108)
  })

  it('skips a check without connecting while every run slot is taken, and loses no mail', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(101, 102)
    free.a = 0
    const before = { connects: connects.length, writes }
    await mw.checkNow('a')
    expect({ connects: connects.length, writes }).toEqual(before)
    expect(emitted).toEqual([])
    expect(logs).toEqual([])
    delete free.a
    await mw.checkNow('a')
    expect(subjects()).toEqual(['m101', 'm102'])
  })

  it('starts over without firing on a new UIDVALIDITY', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    box.uidValidity = 'v2'
    box.uids = [1, 2, 3]
    box.uidNext = 4
    await mw.checkNow('a')
    expect(emitted).toEqual([])
    expect(stored.a).toEqual({ key: 'imap.example.com|ann|INBOX', uidValidity: 'v2', lastUid: 3 })
    add(4)
    await mw.checkNow('a')
    expect(subjects()).toEqual(['m4'])
  })

  it('starts over without firing when the user, host or folder changes', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(101)
    accounts.acc = { username: 'bob', password: PASSWORD } // the login edited in the Vault
    await mw.checkNow('a')
    expect(emitted).toEqual([])
    expect(stored.a).toEqual({ key: 'imap.example.com|bob|INBOX', uidValidity: 'v1', lastUid: 101 })
    add(102)
    mw.sync([wf('a', { folder: 'Work' })])
    await mw.checkNow('a')
    expect(emitted).toEqual([])
    expect(stored.a).toMatchObject({ key: 'imap.example.com|bob|Work', lastUid: 102 })
    add(103)
    mw.sync([wf('a', { folder: 'Work', host: 'mail.example.com' })])
    await mw.checkNow('a')
    expect(emitted).toEqual([])
    expect(stored.a).toMatchObject({ key: 'mail.example.com|bob|Work', lastUid: 103 })
  })

  it('skips a message it cannot read, says so, and goes on', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(101, 102, 103)
    unreadable.add(102)
    await mw.checkNow('a')
    expect(subjects()).toEqual(['m101', 'm103'])
    expect(stored.a?.lastUid).toBe(103)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('Name a')
  })

  it('emits nothing when the state cannot be written, and fires the messages on the next check', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(101)
    const write = d.state.write
    d.state.write = async () => {
      throw new Error('disk full')
    }
    await mw.checkNow('a')
    expect(emitted).toEqual([])
    expect(logs.some((l) => l.includes('disk full'))).toBe(true)
    d.state.write = write
    await mw.checkNow('a')
    expect(subjects()).toEqual(['m101'])
  })

  it('reads the state once and drops the entries of workflows it no longer watches on the next write', async () => {
    stored = {
      gone: { key: 'x|y|z', uidValidity: 'v', lastUid: 5 },
      a: { key: 'imap.example.com|ann|INBOX', uidValidity: 'v1', lastUid: 98 }
    }
    mw.sync([wf('a')])
    await mw.checkNow('a')
    // Restarted with state on disk: the two messages that came meanwhile fire.
    expect(subjects()).toEqual(['m99', 'm100'])
    expect(Object.keys(stored)).toEqual(['a'])
  })
})

describe('MailWatchers errors', () => {
  it('a missing account: no connection, one log line naming the workflow, never a password', async () => {
    accounts = {}
    mw.sync([wf('a')])
    await mw.checkNow('a')
    await mw.checkNow('a')
    expect(connects).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('Name a')
    expect(logs[0]).toContain(ACCOUNT_MISSING)
    expect(logs.join('\n')).not.toContain(PASSWORD)
    expect(logs.join('\n')).not.toContain('ann')
  })

  it('scrubs the password out of a failure and logs each distinct failure once, again after a success', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    connectError = Object.assign(new Error(`LOGIN ann "${PASSWORD}" refused`), { responseText: `NO bad password ${PASSWORD}` })
    await mw.checkNow('a')
    await mw.checkNow('a')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('Name a')
    expect(logs[0]).toContain('***')
    expect(logs[0]).toContain('NO bad password ***')
    expect(logs[0]).not.toContain(PASSWORD)
    connectError = new Error('getaddrinfo ENOTFOUND imap.example.com')
    await mw.checkNow('a')
    expect(logs).toHaveLength(2)
    connectError = null
    await mw.checkNow('a')
    connectError = new Error('getaddrinfo ENOTFOUND imap.example.com')
    await mw.checkNow('a')
    expect(logs).toHaveLength(3)
    expect(logs.join('\n')).not.toContain(PASSWORD)
  })

  it('names the first cause of a connect refused on every address (an AggregateError has an empty message)', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    connectError = Object.assign(
      new AggregateError([new Error(`connect ECONNREFUSED ::1:993 ${PASSWORD}`), new Error('connect ECONNREFUSED 127.0.0.1:993')], ''),
      { code: 'ECONNREFUSED' }
    )
    await mw.checkNow('a')
    expect(logs).toEqual(['email check failed for Name a: connect ECONNREFUSED ::1:993 ***'])
  })

  it('never connects for a blank host, logs it once, and connects to the host trimmed', async () => {
    mw.sync([wf('a', { host: '' }), wf('b', { host: '  ' })])
    await flush()
    await mw.checkNow('a')
    await mw.checkNow('b')
    expect(connects).toEqual([])
    expect(logs).toEqual([`email check failed for Name a: ${MAIL_HOST_MISSING}`, `email check failed for Name b: ${MAIL_HOST_MISSING}`])
    mw.sync([wf('c', { host: ' imap.example.com ' })])
    await mw.checkNow('c')
    expect(connects.map((c) => c.host)).toEqual(['imap.example.com'])
    expect(stored.c?.key).toBe('imap.example.com|ann|INBOX')
  })

  it('gives a check that never ends a deadline: the client is closed, it logs once, and the next tick polls again', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(101)
    const connect = d.connect
    let hung = 0
    d.connect = async (o) => {
      const c = await connect(o)
      let cut: (e: Error) => void = () => undefined
      // The server keeps the fetch open; closing the connection is what ends it, with an error.
      return {
        ...c,
        fetchSince: () => {
          hung++
          return new Promise((_, reject) => {
            cut = reject
          })
        },
        close: async () => {
          await c.close()
          cut(new Error('Connection not available'))
        }
      }
    }
    tick()
    await flush()
    expect(hung).toBe(1)
    const deadline = active().find((t) => t.ms === MAIL_CHECK_DEADLINE_MS)
    expect(deadline).toBeDefined()
    expect(MAIL_CHECK_DEADLINE_MS).toBeLessThan(MAIL_POLL_MS)
    const before = closed
    deadline!.cleared = true
    deadline!.fn()
    await flush()
    expect(closed).toBeGreaterThan(before)
    expect(logs).toEqual(['email check failed for Name a: The mail server did not answer in time.'])
    expect(emitted).toEqual([])
    expect(stored.a?.lastUid).toBe(100)
    // The hung check no longer blocks the workflow: the next tick connects again and fires the mail.
    d.connect = connect
    tick()
    await flush()
    expect(subjects()).toEqual(['m101'])
    expect(logs).toHaveLength(1)
  })

  it('closes the connection when the mailbox fails to open', async () => {
    const connect = d.connect
    d.connect = async (o) => ({
      ...(await connect(o)),
      open: async () => {
        throw new Error("Mailbox doesn't exist: Nope")
      }
    })
    mw.sync([wf('a', { folder: 'Nope' })])
    await mw.checkNow('a')
    expect(closed).toBe(1)
    expect(logs[0]).toContain("Mailbox doesn't exist")
  })
})

describe('MailWatchers.sync', () => {
  it('arms one timer per enabled email workflow and checks each at once', async () => {
    mw.sync([wf('a'), wf('b', { account: 'acc' }), wf('c', { enabled: false }), fileWf('d')])
    expect(polls()).toHaveLength(2)
    await flush()
    expect(connects).toHaveLength(2)
  })

  it('keeps the timer while the config is unchanged, and clears it on a change, a disable or a delete', async () => {
    mw.sync([wf('a'), wf('b')])
    await flush()
    const [ta, tb] = polls()
    // A run's progress, a rename or a filter edit changes nothing the poll needs.
    mw.sync([wf('a', { name: 'Renamed' }), wf('b')])
    mw.sync([wf('a', { name: 'Renamed' }), wf('b')])
    expect(polls()).toEqual([ta, tb])
    expect(connects).toHaveLength(2)
    mw.sync([wf('a', { port: 1993 }), wf('b', { enabled: false })])
    expect(ta?.cleared).toBe(true)
    expect(tb?.cleared).toBe(true)
    expect(polls()).toHaveLength(1)
    await flush()
    expect(connects.at(-1)?.port).toBe(1993)
    mw.sync([wf('a', { port: 1993, account: 'other' })])
    expect(polls()).toHaveLength(1)
    mw.sync([])
    expect(polls()).toEqual([])
  })

  it('polls on each tick, re-arming the timer, and never runs two checks of one workflow at once', async () => {
    let open!: () => void
    gate = new Promise<void>((r) => {
      open = r
    })
    mw.sync([wf('a')])
    expect(connects).toHaveLength(1)
    tick() // the first check still waits on the server
    expect(polls()).toHaveLength(1)
    await flush()
    expect(connects).toHaveLength(1)
    open()
    gate = null
    await mw.checkNow('a')
    add(101)
    tick()
    await flush()
    expect(connects).toHaveLength(2)
    expect(subjects()).toEqual(['m101'])
    expect(polls()).toHaveLength(1)
  })

  it('fires nothing and keeps no state for a workflow turned off while its check ran', async () => {
    mw.sync([wf('a')])
    await mw.checkNow('a')
    add(101)
    let open!: () => void
    gate = new Promise<void>((r) => {
      open = r
    })
    tick()
    const running = mw.checkNow('a')
    mw.sync([wf('a', { enabled: false })])
    open()
    await running
    expect(emitted).toEqual([])
    expect(stored.a).toBeUndefined()
  })

  it('starts fresh when a workflow is turned back on: its state is dropped when it goes off or away', async () => {
    mw.sync([wf('a'), wf('b')])
    await flush()
    expect(stored.a?.lastUid).toBe(100)
    mw.sync([wf('a', { enabled: false }), wf('b')])
    await flush()
    expect(stored.a).toBeUndefined()
    expect(stored.b?.lastUid).toBe(100)
    add(101, 102)
    mw.sync([wf('a'), wf('b')])
    await flush()
    expect(emitted.filter((x) => x.id === 'a')).toEqual([])
    expect(stored.a?.lastUid).toBe(102)
    mw.sync([wf('b')])
    await flush()
    expect(stored.a).toBeUndefined()
  })

  it('keeps no state across a restart for a workflow that was off when the server started', async () => {
    stored = { a: { key: 'imap.example.com|ann|INBOX', uidValidity: 'v1', lastUid: 90 } }
    mw.sync([wf('a', { enabled: false })])
    await flush()
    mw.sync([wf('a')])
    await flush()
    expect(emitted).toEqual([])
    expect(stored.a?.lastUid).toBe(100)
  })

  it('stop clears every timer and starts no check', async () => {
    mw.sync([wf('a'), wf('b')])
    await flush()
    mw.stop()
    expect(active()).toEqual([])
    await mw.checkNow('a')
    expect(connects).toHaveLength(2)
  })
})

describe('checkMailbox', () => {
  const trigger = (over: Partial<{ account: string; host: string }> = {}) => ({
    kind: 'email' as const,
    account: over.account ?? 'acc',
    host: over.host ?? 'imap.example.com',
    port: 993,
    folder: 'INBOX',
    filters: []
  })

  it('signs in once and reports the message count', async () => {
    expect(await checkMailbox(d, trigger())).toEqual({ messages: 100 })
    expect(connects).toHaveLength(1)
    expect(closed).toBe(1)
  })

  it('needs a shared login and a host before it connects', async () => {
    expect(await checkMailbox(d, trigger({ account: 'nope' }))).toEqual({ error: ACCOUNT_MISSING })
    expect(await checkMailbox(d, trigger({ host: '  ' }))).toEqual({ error: MAIL_HOST_MISSING })
    expect(await checkMailbox(d, trigger({ host: '' }))).toEqual({ error: MAIL_HOST_MISSING })
    expect(connects).toEqual([])
    expect(await checkMailbox(d, trigger({ host: ' imap.example.com\t' }))).toEqual({ messages: 100 })
    expect(connects.map((c) => c.host)).toEqual(['imap.example.com'])
  })

  it('reports a failure without the password', async () => {
    connectError = Object.assign(new Error('Authentication failed'), { responseText: `[AUTHENTICATIONFAILED] ${PASSWORD} is wrong` })
    const r = await checkMailbox(d, trigger())
    expect(r).toEqual({ error: 'Authentication failed: [AUTHENTICATIONFAILED] *** is wrong' })
  })

  it('names the first cause, else the code, else says it could not connect, when an AggregateError has no message', async () => {
    connectError = Object.assign(
      new AggregateError([new Error(`connect ECONNREFUSED ::1:993 ${PASSWORD}`), new Error('connect ECONNREFUSED 127.0.0.1:993')], ''),
      { code: 'ECONNREFUSED' }
    )
    expect(await checkMailbox(d, trigger())).toEqual({ error: 'connect ECONNREFUSED ::1:993 ***' })
    connectError = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
    expect(await checkMailbox(d, trigger())).toEqual({ error: 'ECONNREFUSED' })
    connectError = new AggregateError([], '')
    expect(await checkMailbox(d, trigger())).toEqual({ error: 'Could not connect to the mail server' })
  })

  it('gives up on a server that does not answer', async () => {
    gate = new Promise<void>(() => undefined)
    const r = await checkMailbox(d, trigger(), 20)
    expect(r).toEqual({ error: 'The mail server did not answer in time.' })
  })
})

describe('scrubPassword', () => {
  it('replaces the password and its IMAP-quoted form, and leaves text alone for an empty one', () => {
    expect(scrubPassword('a hunter22 b hunter22', 'hunter22')).toBe('a *** b ***')
    expect(scrubPassword('LOGIN "pa\\"ss\\\\"', 'pa"ss\\')).toBe('LOGIN "***"')
    expect(scrubPassword('text', '')).toBe('text')
  })
})
