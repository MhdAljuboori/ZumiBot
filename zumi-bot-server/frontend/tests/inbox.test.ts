import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import type { InboxMessages, WorkflowApproval, WorkflowMessage } from '@zumibot/shared/inbox'
import { addTodos, askTodo, assignTodo, emptyTodos, startTask, type TodoItem } from '@zumibot/shared/todos'
import type { Visit, WorkflowsSnapshot } from '@zumibot/shared/workflows'
import {
  ANSWERED_MS,
  anyNewMessage,
  answeredLine,
  answeredText,
  chatsToLoad,
  countText,
  entryHeader,
  heldSeenAt,
  inboxRows,
  loadKey,
  messageTime,
  messageView,
  liveLines,
  nextExpiry,
  pressAnswer,
  rowKey,
  seenToSend,
  settleAnswer,
  waitedText,
  waitingChats,
  waitingEntries,
  filterOnOpen,
  focusStep,
  needsOlder,
  ownPending,
  OLDER_PAGES_MAX,
  type AnsweredLine,
  type WaitingEntry
} from '../src/state/inbox'

const chat = (id: string, agentName: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({
  id,
  agentName,
  sessionId: null,
  cwd: '/w',
  title: id,
  createdAt: 0,
  updatedAt: 0,
  inFlight: false,
  ...extra
})
const card = (id: string, ts: number, extra: Record<string, unknown> = {}): ChatItem =>
  ({
    type: 'approval',
    id,
    toolUseId: null,
    toolName: 'Bash',
    input: { command: 'ls' },
    description: null,
    reason: null,
    status: 'pending',
    ts,
    ...extra
  }) as ChatItem
const handoff = (id: string, ts: number, status = 'pending'): ChatItem =>
  ({
    type: 'browser-action',
    id,
    ts,
    agent: 'writer',
    handoff: {
      id,
      profileId: 'p',
      generation: 'g',
      chatId: 'c',
      turnId: 't',
      site: 's',
      reason: 'log in',
      createdAt: ts,
      agent: 'writer',
      status
    }
  }) as ChatItem
const wfApproval = (visitId: string, startedAt: number): WorkflowApproval => ({
  workflowId: 'w1',
  workflowName: 'Deploy',
  runId: 'r1',
  visit: { id: visitId, stepId: 's1', n: 1, status: 'waiting', input: '', inputs: [], startedAt } as Visit,
  step: { id: 's1', kind: 'approval', name: 'Ship it?', question: 'q', editable: false } as WorkflowApproval['step']
})
const msg = (id: string, at: number, extra: Partial<WorkflowMessage> = {}): WorkflowMessage => ({
  id,
  workflowId: 'w1',
  workflowName: 'Deploy',
  runId: 'r1',
  stepName: 'Tell',
  title: id,
  at,
  updatedAt: at,
  ...extra
})

describe('waitingEntries', () => {
  it('lists pending approvals and handoffs, oldest first, mixed with workflow approvals', () => {
    const items: Record<string, ChatItem[]> = { a: [card('c1', 300), handoff('h1', 100)], b: [card('c2', 200)] }
    const out = waitingEntries({
      chats: [chat('a', 'writer'), chat('b', 'coder')],
      pendingByChat: { a: 2, b: 1 },
      itemsOf: (id) => items[id],
      approvals: [wfApproval('v1', 250)]
    })
    expect(out.map((e) => [e.kind, e.key, e.since])).toEqual([
      ['handoff', 'a:h1', 100],
      ['card', 'b:c2', 200],
      ['workflow', 'run:v1', 250],
      ['card', 'a:c1', 300]
    ])
  })

  it('breaks a tie by key', () => {
    const out = waitingEntries({
      chats: [chat('a', 'w')],
      pendingByChat: { a: 2 },
      itemsOf: () => [card('z', 5), card('y', 5)],
      approvals: []
    })
    expect(out.map((e) => e.key)).toEqual(['a:y', 'a:z'])
  })

  it('ignores answered cards and chats with no pending count', () => {
    const items: Record<string, ChatItem[]> = {
      a: [card('c1', 1, { status: 'denied' }), card('c2', 2), handoff('h1', 3, 'done')],
      b: [card('c3', 4)]
    }
    const out = waitingEntries({
      chats: [chat('a', 'w'), chat('b', 'w')],
      pendingByChat: { a: 1 },
      itemsOf: (id) => items[id],
      approvals: []
    })
    expect(out.map((e) => e.key)).toEqual(['a:c2'])
  })

  it('skips a chat whose items are not loaded yet', () => {
    const out = waitingEntries({ chats: [chat('a', 'w')], pendingByChat: { a: 1 }, itemsOf: () => undefined, approvals: [] })
    expect(out).toEqual([])
  })

  it("an A→B chat's card appears once", () => {
    const asked = chat('ab', 'reviewer', { asked: { by: 'writer', from: 'a', fromTitle: 'Site', chain: ['writer'] } })
    const items: Record<string, ChatItem[]> = { a: [], ab: [card('c1', 10)] }
    const out = waitingEntries({
      chats: [chat('a', 'writer'), asked],
      pendingByChat: { a: 2, ab: 1 },
      itemsOf: (id) => items[id],
      approvals: []
    })
    expect(out.map((e) => e.key)).toEqual(['ab:c1'])
  })

  it('drops cards of chats no longer listed', () => {
    const out = waitingEntries({
      chats: [chat('a', 'w')],
      pendingByChat: { a: 1, gone: 1 },
      itemsOf: () => [card('c1', 1)],
      approvals: []
    })
    expect(out.map((e) => e.key)).toEqual(['a:c1'])
  })
})

describe('chatsToLoad', () => {
  it('names the chats with a pending count', () => {
    expect(chatsToLoad({ a: 1, b: 0, c: 3 })).toEqual(['a', 'c'])
  })
})

describe('entryHeader', () => {
  it('names the room member', () => {
    const room = chat('r', '', { title: 'Team' })
    const [e] = waitingEntries({
      chats: [room],
      pendingByChat: { r: 1 },
      itemsOf: () => [card('c1', 1, { agent: 'coder' })],
      approvals: []
    })
    expect(entryHeader(e, [room], [])).toEqual({ who: 'coder', where: 'Team', link: 'chat' })
  })

  it('falls back to the chat agent when the card has none', () => {
    const c = chat('a', 'writer', { title: 'Site' })
    const [e] = waitingEntries({ chats: [c], pendingByChat: { a: 1 }, itemsOf: () => [card('c1', 1)], approvals: [] })
    expect(entryHeader(e, [c], []).who).toBe('writer')
  })

  it('A→B header says who asked and where', () => {
    const c = chat('ab', 'reviewer', { asked: { by: 'writer', from: 'a', fromTitle: 'Site', chain: ['writer'] } })
    const [e] = waitingEntries({ chats: [c], pendingByChat: { ab: 1 }, itemsOf: () => [card('c1', 1)], approvals: [] })
    expect(entryHeader(e, [c], [])).toEqual({ who: 'reviewer', where: 'asked by @Writer in Site', link: 'chat' })
  })

  it('writes agent handles in the chat title as display names', () => {
    const c = chat('a', 'writer', { title: 'ask @code-reviewer' })
    const [e] = waitingEntries({ chats: [c], pendingByChat: { a: 1 }, itemsOf: () => [card('c1', 1)], approvals: [] })
    expect(entryHeader(e, [c], [{ name: 'code-reviewer' }]).where).toBe('ask @Code Reviewer')
  })

  it('a workflow entry links to the run', () => {
    const [e] = waitingEntries({ chats: [], pendingByChat: {}, itemsOf: () => undefined, approvals: [wfApproval('v1', 1)] })
    expect(entryHeader(e, [], [])).toEqual({ who: null, where: 'Deploy › Ship it?', link: 'run' })
  })
})

describe('countText', () => {
  it("null at 0, '7', '99+' at 100", () => {
    expect(countText(0)).toBeNull()
    expect(countText(7)).toBe('7')
    expect(countText(99)).toBe('99')
    expect(countText(100)).toBe('99+')
  })
})

describe('waitedText', () => {
  it('buckets', () => {
    const now = 10 * 86_400_000
    const ago = (ms: number) => waitedText(now - ms, now)
    expect(ago(59_000)).toBe('just now')
    expect(ago(60_000)).toBe('waiting 1 min')
    expect(ago(59 * 60_000)).toBe('waiting 59 min')
    expect(ago(3_600_000)).toBe('waiting 1 h')
    expect(ago(23 * 3_600_000 + 59 * 60_000)).toBe('waiting 23 h')
    expect(ago(86_400_000)).toBe('waiting 1 d')
    expect(ago(3 * 86_400_000)).toBe('waiting 3 d')
    expect(waitedText(now + 5000, now)).toBe('just now')
  })
})

describe('answeredText', () => {
  const c = chat('a', 'writer')
  const [bash] = waitingEntries({ chats: [c], pendingByChat: { a: 1 }, itemsOf: () => [card('c1', 1, { agent: 'writer' })], approvals: [] })
  const [wf] = waitingEntries({ chats: [], pendingByChat: {}, itemsOf: () => undefined, approvals: [wfApproval('v1', 1)] })
  const [ho] = waitingEntries({ chats: [c], pendingByChat: { a: 1 }, itemsOf: () => [handoff('h1', 1)], approvals: [] })

  it('words each reply', () => {
    expect(answeredText(bash, 'allow-once')).toBe('✓ Allowed once · Bash(ls) · @Writer')
    expect(answeredText(bash, 'allow-chat')).toBe('✓ Allowed for this chat · Bash(ls) · @Writer')
    expect(answeredText(bash, 'allow-agent')).toBe('✓ Allowed always · Bash(ls) · @Writer')
    expect(answeredText(bash, 'deny')).toBe('✗ Denied · Bash(ls) · @Writer')
    expect(answeredText(bash, { answers: { q: 'a' } })).toBe('✓ Answered · Bash(ls) · @Writer')
    expect(answeredText(bash, { plan: { approve: true } })).toBe('✓ Plan approved · Bash(ls) · @Writer')
    expect(answeredText(wf, 'approved')).toBe('✓ Approved · Deploy › Ship it?')
    expect(answeredText(wf, 'rejected')).toBe('✗ Rejected · Deploy › Ship it?')
  })

  it('cuts a handoff reason to 60 characters', () => {
    const long = {
      ...ho,
      item: { ...ho.item, handoff: { ...(ho as Extract<WaitingEntry, { kind: 'handoff' }>).item.handoff, reason: 'x'.repeat(100) } }
    } as WaitingEntry
    const text = answeredText(long, 'done')
    expect(text.startsWith('✓ Done · ')).toBe(true)
    expect(text).toBe('✓ Done · ' + 'x'.repeat(59) + '…' + ' · @Writer')
    expect(answeredText(ho, 'cancelled')).toBe('✗ Cancelled · log in · @Writer')
  })
})

describe('inboxRows', () => {
  const mk = (key: string, since: number): WaitingEntry => ({ kind: 'workflow', key, approval: wfApproval(key, since), since })
  const line = (key: string, since: number, until: number): AnsweredLine => ({ key, since, text: 'done', until })

  it("answered line holds the entry's place until it expires, never beside the entry", () => {
    const entries = [mk('run:a', 100), mk('run:b', 200), mk('run:c', 300)]
    const rows = inboxRows(entries, [line('run:b', 200, 1000)], 500)
    expect(rows.map((r) => (r.kind === 'entry' ? r.entry.key : 'ans:' + r.line.key))).toEqual(['run:a', 'ans:run:b', 'run:c'])
    // the answer already left the waiting list: still one row
    const gone = inboxRows([entries[0], entries[2]], [line('run:b', 200, 1000)], 500)
    expect(gone.map((r) => (r.kind === 'entry' ? r.entry.key : 'ans:' + r.line.key))).toEqual(['run:a', 'ans:run:b', 'run:c'])
    // expired: dropped, and an entry still listed shows again
    const expired = inboxRows(entries, [line('run:b', 200, 400)], 500)
    expect(expired.map((r) => (r.kind === 'entry' ? r.entry.key : 'ans:' + r.line.key))).toEqual(['run:a', 'run:b', 'run:c'])
  })
})

describe('messageView', () => {
  const none: WorkflowsSnapshot = { workflows: [], runs: {} }
  it('new by held seenAt, archived split, newest first', () => {
    const m: InboxMessages = {
      seenAt: 999,
      messages: [
        msg('old', 100),
        msg('fresh', 300),
        msg('mid', 200),
        msg('arch', 400, { archivedAt: 450 }),
        msg('arch2', 350, { archivedAt: 360 })
      ]
    }
    const v = messageView(m, 150, none)
    expect(v.shown.map((x) => [x.id, x.isNew])).toEqual([
      ['fresh', true],
      ['mid', true],
      ['old', false]
    ])
    expect(v.archived.map((x) => x.id)).toEqual(['arch', 'arch2'])
    expect(v.newCount).toBe(2)
  })

  it('hides Open run when the run is gone', () => {
    const runs: WorkflowsSnapshot = {
      workflows: [{ id: 'w1' } as WorkflowsSnapshot['workflows'][number]],
      runs: { w1: [{ id: 'r1' } as WorkflowsSnapshot['runs'][string][number]] }
    }
    const m: InboxMessages = {
      seenAt: 0,
      messages: [msg('ok', 3), msg('norun', 2, { runId: 'r9' }), msg('nowf', 1, { workflowId: 'w9' })]
    }
    const v = messageView(m, 0, runs)
    expect(v.shown.map((x) => [x.id, x.runGone])).toEqual([
      ['ok', false],
      ['norun', true],
      ['nowf', true]
    ])
  })
})

describe('anyNewMessage', () => {
  it('false for null and for archived-only news', () => {
    expect(anyNewMessage(null)).toBe(false)
    expect(anyNewMessage({ seenAt: 10, messages: [msg('a', 20, { archivedAt: 30 })] })).toBe(false)
    expect(anyNewMessage({ seenAt: 10, messages: [msg('a', 5)] })).toBe(false)
    expect(anyNewMessage({ seenAt: 10, messages: [msg('a', 20)] })).toBe(true)
  })
})

describe('seenToSend', () => {
  const data = (seenAt: number, ...at: number[]): InboxMessages => ({ seenAt, messages: at.map((a, i) => msg(`m${i}`, a)) })
  it('sends the newest message time (the server clock), not this clock, while a message is past seenAt', () => {
    expect(seenToSend(data(10, 20, 35, 5), true, null)).toBe(35)
    expect(seenToSend(data(50, 20), true, null)).toBeNull()
    expect(seenToSend(data(0), true, null)).toBeNull()
    expect(seenToSend(null, true, null)).toBeNull()
  })
  it('sends nothing while the Messages section does not show', () => {
    expect(seenToSend(data(10, 20), false, null)).toBeNull()
  })
  it('sends each time once a visit, so a time the server clamps cannot loop seen → change → refetch', () => {
    // The server clamped 500 to its own now (100): the message is still past seenAt, but 500 was already sent.
    expect(seenToSend(data(100, 500), true, 500)).toBeNull()
    // A newer message is a new time: sent.
    expect(seenToSend(data(100, 500, 600), true, 500)).toBe(600)
  })
})

describe('filterOnOpen', () => {
  it('All when the page opens from closed, or a message is named; else the chip stays', () => {
    expect(filterOnOpen('waiting', false, null)).toBe('all')
    expect(filterOnOpen('messages', false, null)).toBe('all')
    expect(filterOnOpen('waiting', true, 'm1')).toBe('all')
    expect(filterOnOpen('waiting', true, null)).toBe('waiting')
    expect(filterOnOpen('messages', true, null)).toBe('messages')
  })
})

describe('focusStep', () => {
  const ids = { shown: ['a', 'b'], archived: ['z'] }
  it('lights a message on screen once', () => {
    expect(focusStep('a', null, true, ids, false)).toBe('light')
    expect(focusStep('a', 'a', true, ids, false)).toBe('none')
    expect(focusStep(null, 'a', true, ids, false)).toBe('none')
  })
  it('unfolds the archived list first', () => {
    expect(focusStep('z', null, true, ids, false)).toBe('unfold')
    expect(focusStep('z', null, true, ids, true)).toBe('light')
  })
  it('waits while the section is hidden or the message is not loaded yet, instead of dropping the id', () => {
    expect(focusStep('a', null, false, ids, false)).toBe('wait')
    expect(focusStep('new', null, true, ids, false)).toBe('wait')
  })
})

describe('heldSeenAt', () => {
  const data = (seenAt: number): InboxMessages => ({ seenAt, messages: [] })
  it('takes the first answer after opening and keeps it', () => {
    expect(heldSeenAt(null, true, null)).toBeNull()
    expect(heldSeenAt(null, true, data(5))).toBe(5)
    expect(heldSeenAt(5, true, data(99))).toBe(5)
  })
  it('is dropped when the page is left', () => {
    expect(heldSeenAt(5, false, data(99))).toBeNull()
  })
})

describe('messageTime', () => {
  const at = (d: number, h: number, m: number, mo = 10, y = 2026): number => new Date(y, mo, d, h, m).getTime()
  const now = at(7, 15, 0)
  it('says the clock time today, yesterday with the clock time, else the date', () => {
    expect(messageTime(at(7, 6, 5), now)).toBe('06:05')
    expect(messageTime(at(6, 23, 59), now)).toBe('yesterday 23:59')
    expect(messageTime(at(3, 10, 42), now)).toBe('3 Nov 10:42')
    expect(messageTime(at(3, 10, 42, 10, 2025), now)).toBe('3 Nov 2025 10:42')
  })
})

describe('loadKey order', () => {
  it('does not depend on the order of the counts map (a push moves its chat to the end)', () => {
    const chats = [chat('a', 'w'), chat('b', 'w')]
    expect(loadKey({ a: 1, b: 2 }, chats)).toBe(loadKey({ b: 2, a: 1 }, chats))
  })
})

describe('ownPending and needsOlder', () => {
  const asked = (id: string, from: string): ChatMeta =>
    chat(id, 'reviewer', { asked: { by: 'writer', from, fromTitle: 'Site', chain: ['writer'] } })
  it("takes the A→B chats' cards out of the asking chat's count", () => {
    const chats = [chat('a', 'writer'), asked('ab', 'a'), asked('ac', 'a'), asked('xb', 'x')]
    expect(ownPending('a', { a: 4, ab: 1, ac: 2, xb: 5 }, chats)).toBe(1)
    expect(ownPending('ab', { a: 4, ab: 1 }, chats)).toBe(1)
    // a late push never makes it negative
    expect(ownPending('a', { a: 1, ab: 3 }, chats)).toBe(0)
  })
  it('loads older pages only while cards are missing, older items exist and the bound is not reached', () => {
    expect(needsOlder(0, 1, false, 0)).toBe(true)
    expect(needsOlder(1, 1, false, 0)).toBe(false)
    expect(needsOlder(0, 1, true, 0)).toBe(false)
    expect(needsOlder(0, 1, false, OLDER_PAGES_MAX - 1)).toBe(true)
    expect(needsOlder(0, 1, false, OLDER_PAGES_MAX)).toBe(false)
  })
})

describe('waitingChats and loadKey', () => {
  it('names only listed chats with a pending count', () => {
    expect(waitingChats({ a: 1, b: 0, gone: 2, c: 3 }, [chat('a', 'w'), chat('b', 'w'), chat('c', 'w')])).toEqual(['a', 'c'])
  })
  it('the key moves when a count moves or a waiting chat is listed', () => {
    const chats = [chat('a', 'w')]
    expect(loadKey({ a: 1 }, chats)).toBe(loadKey({ a: 1, b: 0 }, chats))
    expect(loadKey({ a: 2 }, chats)).not.toBe(loadKey({ a: 1 }, chats))
    expect(loadKey({ a: 1, n: 1 }, [...chats, chat('n', 'w')])).not.toBe(loadKey({ a: 1, n: 1 }, chats))
    expect(loadKey({}, chats)).toBe('')
  })
})

describe('answeredLine', () => {
  const c = chat('a', 'deployer')
  it("names a single chat's agent, which its card does not carry", () => {
    const [e] = waitingEntries({
      chats: [c],
      pendingByChat: { a: 1 },
      itemsOf: () => [card('c1', 7, { input: { command: 'npm test' } })],
      approvals: []
    })
    const line = answeredLine(e, { kind: 'card', reply: 'allow-once' }, [c])
    // Held until its send settles: no expiry yet.
    expect(line).toEqual({ key: 'a:c1', since: 7, text: '✓ Allowed once · Bash(npm test) · @Deployer', until: null })
  })
  it('names the room member for a room card', () => {
    const room = chat('r', '', { title: 'Team' })
    const [e] = waitingEntries({
      chats: [room],
      pendingByChat: { r: 1 },
      itemsOf: () => [card('c1', 1, { agent: 'coder' })],
      approvals: []
    })
    expect(answeredLine(e, { kind: 'card', reply: 'deny' }, [room])).toMatchObject({ text: '✗ Denied · Bash(ls) · @Coder', no: true })
  })
  it('names a question by its first question and leaves a plan unquoted', () => {
    const q = {
      questions: [
        {
          question: 'Which plan tiers?',
          header: 'Tiers',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' }
          ],
          multiSelect: false
        }
      ]
    }
    const [qe] = waitingEntries({
      chats: [c],
      pendingByChat: { a: 1 },
      itemsOf: () => [card('q1', 1, { toolName: 'AskUserQuestion', input: q })],
      approvals: []
    })
    expect(answeredLine(qe, { kind: 'card', reply: { answers: { 'Which plan tiers?': 'A' } } }, [c]).text).toBe(
      '✓ Answered · Which plan tiers? · @Deployer'
    )
    const [pe] = waitingEntries({
      chats: [c],
      pendingByChat: { a: 1 },
      itemsOf: () => [card('p1', 1, { toolName: 'ExitPlanMode', input: { plan: '1. a\n2. b' } })],
      approvals: []
    })
    expect(answeredLine(pe, { kind: 'card', reply: { plan: { approve: true } } }, [c]).text).toBe('✓ Plan approved · @Deployer')
    expect(answeredLine(pe, { kind: 'card', reply: { plan: { approve: false, feedback: 'x' } } }, [c])).toMatchObject({
      text: '✗ Plan sent back · @Deployer',
      no: true
    })
    expect(answeredLine(qe, { kind: 'card', reply: { answers: null } }, [c])).toMatchObject({
      text: '✗ Skipped · Which plan tiers? · @Deployer',
      no: true
    })
  })
  it('words a handoff and a workflow answer', () => {
    const [ho] = waitingEntries({ chats: [c], pendingByChat: { a: 1 }, itemsOf: () => [handoff('h1', 1)], approvals: [] })
    expect(answeredLine(ho, { kind: 'handoff', decision: 'cancel' }, [c])).toMatchObject({
      text: '✗ Cancelled · log in · @Writer',
      no: true
    })
    expect(answeredLine(ho, { kind: 'handoff', decision: 'done' }, [c]).text).toBe('✓ Done · log in · @Writer')
    expect(answeredLine(ho, { kind: 'handoff', decision: 'done' }, [c]).no).toBeUndefined()
    const [wf] = waitingEntries({ chats: [], pendingByChat: {}, itemsOf: () => undefined, approvals: [wfApproval('v1', 1)] })
    expect(answeredLine(wf, { kind: 'workflow', ok: false }, [])).toMatchObject({ text: '✗ Rejected · Deploy › Ship it?', no: true })
    expect(answeredLine(wf, { kind: 'workflow', ok: true, text: 'x' }, []).text).toBe('✓ Approved · Deploy › Ship it?')
  })
})

describe('holding an answered entry', () => {
  const mk = (key: string, since: number): WaitingEntry => ({ kind: 'workflow', key, approval: wfApproval(key, since), since })
  const entries = [mk('run:a', 100), mk('run:b', 200)]
  const held = (): AnsweredLine => ({ key: 'run:b', since: 200, text: '✓ Approved', until: null })
  const shape = (rows: ReturnType<typeof inboxRows>) =>
    rows.map((r) => (r.kind === 'entry' ? `card:${r.entry.key}` : `line:${r.line.key}${r.entry ? '+held card' : ''}`))

  it('an entry whose send has not settled stays held past 4 s, with its card kept under the line', () => {
    const lines = pressAnswer([], held())
    const press = 1000
    for (const now of [press, press + ANSWERED_MS + 1, press + 60_000]) {
      expect(shape(inboxRows(entries, lines, now))).toEqual(['card:run:a', 'line:run:b+held card'])
    }
    expect(nextExpiry(lines, press + 60_000)).toBeNull()
    expect(liveLines(lines, press + 60_000)).toEqual(lines)
  })

  it('a failed send releases the hold: the same card shows again under the same row key, so its draft stays', () => {
    const before = inboxRows(entries, [], 0).find((r) => r.kind === 'entry' && r.entry.key === 'run:b')!
    const during = inboxRows(entries, pressAnswer([], held()), 0).find((r) => r.kind === 'answered')!
    const lines = settleAnswer(pressAnswer([], held()), 'run:b', false, 5000)
    expect(lines).toEqual([])
    const after = inboxRows(entries, lines, 5000).find((r) => r.kind === 'entry' && r.entry.key === 'run:b')!
    expect(rowKey(during)).toBe(rowKey(before))
    expect(rowKey(after)).toBe(rowKey(before))
  })

  it('a successful send expires about 4 s after it settles, not after the press', () => {
    const settledAt = 20_000
    const lines = settleAnswer(pressAnswer([], held()), 'run:b', true, settledAt)
    expect(lines[0].until).toBe(settledAt + ANSWERED_MS)
    expect(nextExpiry(lines, settledAt)).toBe(ANSWERED_MS)
    expect(shape(inboxRows(entries, lines, settledAt + ANSWERED_MS - 1))).toEqual(['card:run:a', 'line:run:b+held card'])
    // expired while the entry is still listed (the push is late): the card shows again
    expect(shape(inboxRows(entries, lines, settledAt + ANSWERED_MS))).toEqual(['card:run:a', 'card:run:b'])
    // left the list meanwhile: the line stays alone until it expires
    expect(shape(inboxRows([entries[0]], lines, settledAt + 1))).toEqual(['card:run:a', 'line:run:b'])
    expect(liveLines(lines, settledAt + ANSWERED_MS)).toEqual([])
  })

  it('a settle for a key no longer held changes nothing; a press replaces the same key', () => {
    const lines = pressAnswer([{ key: 'run:a', since: 100, text: 'x', until: 50 }], held())
    expect(settleAnswer(lines, 'run:z', true, 10)).toEqual(lines)
    expect(
      pressAnswer(lines, { ...held(), text: 'again' })
        .filter((l) => l.key === 'run:b')
        .map((l) => l.text)
    ).toEqual(['again'])
  })

  it('nextExpiry waits for the earliest settled live line', () => {
    const line = (key: string, until: number | null): AnsweredLine => ({ key, since: 1, text: key, until })
    expect(nextExpiry([line('a', 500), line('b', 300), line('c', 50), line('d', null)], 100)).toBe(200)
    expect(nextExpiry([line('c', 50)], 100)).toBeNull()
    expect(nextExpiry([], 100)).toBeNull()
  })
})

describe('to-do cards in the Inbox', () => {
  let n = 0
  const asked = (text: string, at: number, questions: string[]): TodoItem => {
    let f = addTodos(
      emptyTodos(),
      [{ text }],
      'user',
      { chatId: null, turn: 'user', itemId: null, label: '', at: 1 },
      1,
      () => `t${++n}`
    ).file
    const id = f.items[0]!.id
    f = assignTodo(f, id, 'builder', '/w', 2).file
    f = startTask(f, id, { agent: 'builder', chatId: 'task1', at: 2 }, 2).file
    if (questions.length > 0)
      f = askTodo(
        f,
        id,
        'task1',
        'builder',
        questions.map((q) => ({ text: q })),
        at,
        () => `q${++n}`
      ).file
    return f.items[0]!
  }

  it('lists one entry per card with an open question, by its oldest question, among the other entries', () => {
    const items: Record<string, ChatItem[]> = { a: [card('c1', 300)] }
    const cards = [asked('Export', 200, ['CSV?', 'Where?']), asked('Logo', 400, ['Blue?']), asked('Nothing asked', 0, [])]
    const e = waitingEntries({ chats: [chat('a', 'w')], pendingByChat: { a: 1 }, itemsOf: (id) => items[id], approvals: [], cards })
    expect(e.map((x) => [x.kind, x.key, x.since])).toEqual([
      ['todo', `todo:${cards[0]!.id}`, 200],
      ['card', 'a:c1', 300],
      ['todo', `todo:${cards[1]!.id}`, 400]
    ])
  })

  it("heads the entry with the asking agent and the card's title, and leaves an answered line", () => {
    const item = asked('Export the [report](https://x.example)', 200, ['CSV or JSON?'])
    const [entry] = waitingEntries({ chats: [], pendingByChat: {}, itemsOf: () => undefined, approvals: [], cards: [item] })
    expect(entryHeader(entry!, [], [])).toEqual({ who: 'builder', where: '“Export the report”', link: 'todo' })
    expect(answeredLine(entry!, { kind: 'todo', answers: [{ id: 'q', text: 'CSV' }] }, [])).toEqual({
      key: entry!.key,
      since: 200,
      text: '✓ Answered · CSV or JSON? · @Builder',
      until: null
    })
  })
})
