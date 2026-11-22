import { describe, expect, it } from 'vitest'
import type { VaultListItem } from '@zumibot/shared/vault'
import type { FileChange, WorkflowRunSummary } from '@zumibot/shared/workflows'
import {
  accountKnown,
  emptyValueHint,
  eventFieldRows,
  filterHints,
  mailAccountLabel,
  mailAccounts,
  mailCheckText,
  portDraft,
  portOnBlur,
  runTag,
  setFilterOp,
  toggleChange
} from '../src/state/workflowTriggers'

const login = (over: Record<string, unknown>) =>
  ({
    id: 'v1',
    updatedAt: 1,
    name: 'Work mail',
    agents: [],
    label: 'Work mail',
    kind: 'login',
    sites: [],
    username: 'me@example.com',
    hasPassword: true,
    hasCode: false,
    workflows: true,
    ...over
  }) as VaultListItem

describe('setFilterOp', () => {
  it('sets contains and drops the key for equals', () => {
    expect(setFilterOp({ field: 'body.subject', equals: 'x' }, 'contains')).toEqual({ field: 'body.subject', equals: 'x', op: 'contains' })
    const back = setFilterOp({ field: 'body.subject', equals: 'x', op: 'contains' }, 'equals')
    expect(back).toEqual({ field: 'body.subject', equals: 'x' })
    expect('op' in back).toBe(false)
  })
})

describe('eventFieldRows', () => {
  it("lists the sample call's leaf paths for each event kind", () => {
    expect(eventFieldRows('email').map((r) => r.path)).toContain('body.subject')
    expect(eventFieldRows('file').map((r) => r.path)).toContain('body.files.0.name')
    expect(eventFieldRows('reply').map((r) => r.path)).toContain('body.outcome')
  })
})

describe('mailAccounts', () => {
  it('keeps only logins a workflow may use', () => {
    const items = [
      login({ id: 'a' }),
      login({ id: 'b', workflows: false }),
      { ...login({ id: 'c' }), kind: 'apiKey', workflows: true } as unknown as VaultListItem
    ]
    expect(mailAccounts(items).map((i) => i.id)).toEqual(['a'])
  })
  it('labels one by name and username', () => {
    expect(mailAccountLabel(login({}) as never)).toBe('Work mail (me@example.com)')
    expect(mailAccountLabel(login({ username: '' }) as never)).toBe('Work mail')
  })
})

describe('mailCheckText', () => {
  it('words a count, one and many, or passes the error on', () => {
    expect(mailCheckText({ messages: 12 })).toBe('12 messages')
    expect(mailCheckText({ messages: 1 })).toBe('1 message')
    expect(mailCheckText({ error: 'Sign-in refused' })).toBe('Sign-in refused')
  })
})

describe('toggleChange', () => {
  it('adds and removes a change, keeping the canonical order', () => {
    expect(toggleChange(['added', 'removed'], 'changed', true)).toEqual(['added', 'changed', 'removed'])
    expect(toggleChange(['added', 'changed'], 'added', false)).toEqual(['changed'])
  })
  it('refuses to remove the last change, which the server would refuse to save', () => {
    const one: FileChange[] = ['changed']
    expect(toggleChange(one, 'changed', false)).toBe(one)
  })
})

describe('accountKnown', () => {
  const list = mailAccounts([login({ id: 'a' })])
  it('treats no pick as known, so the placeholder is the only empty option', () => {
    expect(accountKnown('', list)).toBe(true)
    expect(accountKnown('', [])).toBe(true)
  })
  it('knows a listed id, not a missing one, and trusts it until the list loads', () => {
    expect(accountKnown('a', list)).toBe(true)
    expect(accountKnown('gone', list)).toBe(false)
    expect(accountKnown('gone', null)).toBe(true)
  })
})

describe('portDraft', () => {
  it('keeps digits only, at most five', () => {
    expect(portDraft('9a9').text).toBe('99')
    expect(portDraft('1234567').text).toBe('12345')
  })
  it('stores a valid 1-65535 port and nothing else', () => {
    expect(portDraft('993')).toEqual({ text: '993', port: 993, valid: true })
    expect(portDraft('65535').port).toBe(65535)
    expect(portDraft('')).toEqual({ text: '', port: null, valid: false })
    expect(portDraft('0')).toEqual({ text: '0', port: null, valid: false })
    expect(portDraft('99999')).toEqual({ text: '99999', port: null, valid: false })
  })
})

describe('portOnBlur', () => {
  it('restores the default for an empty or invalid draft, keeps a valid one', () => {
    expect(portOnBlur('')).toBe(993)
    expect(portOnBlur('99999')).toBe(993)
    expect(portOnBlur('143')).toBe(143)
  })
})

describe('runTag', () => {
  const run = (over: Partial<WorkflowRunSummary>): WorkflowRunSummary => ({
    id: 'r',
    workflowId: 'w',
    via: 'manual',
    status: 'done',
    late: false,
    startedAt: 1,
    waiting: [],
    failed: [],
    ...over
  })
  it('tags event runs with the lowercased event, chat runs from chat, manual by hand', () => {
    expect(runTag(run({ via: 'event', event: 'email' }))).toBe('email arrived')
    expect(runTag(run({ via: 'event', event: 'file' }))).toBe('file changed')
    expect(runTag(run({ via: 'event' }))).toBe('event')
    expect(runTag(run({ via: 'chat' }))).toBe('from chat')
    expect(runTag(run({ via: 'manual' }))).toBe('manual')
    expect(runTag(run({ via: 'webhook' }))).toBeNull()
  })
})

describe('filterHints', () => {
  it('keeps the webhook copy, about calls and skipped runs', () => {
    expect(filterHints('webhook')).toEqual({
      none: 'Every call runs. Add a filter to run only on some calls.',
      rule: 'Text compares exactly, or contains it (capitals matter), all of them must match. A call that fails one is kept as a skipped run.'
    })
  })
  it('speaks of events for every event kind, which keep no skipped run', () => {
    for (const kind of ['reply', 'todo', 'inbox', 'file', 'email'] as const) {
      expect(filterHints(kind)).toEqual({
        none: 'Every event runs. Add a filter to run only on some events.',
        rule: 'Exact or contains compares; all must match. An event that fails one starts nothing.'
      })
    }
  })
})

describe('emptyValueHint', () => {
  it('warns under an equals row with an empty value, which matches only an empty field', () => {
    expect(emptyValueHint({ field: 'body.subject', equals: '' })).toBe('An empty value matches only an empty field.')
  })
  it('says nothing once a value is typed, or for contains, where empty matches any value', () => {
    expect(emptyValueHint({ field: 'body.subject', equals: 'x' })).toBeNull()
    expect(emptyValueHint({ field: 'body.subject', equals: '', op: 'contains' })).toBeNull()
  })
})
