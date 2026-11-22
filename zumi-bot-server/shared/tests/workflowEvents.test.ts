import { describe, expect, it } from 'vitest'
import {
  EVENT_KINDS,
  EVENT_METHOD,
  EVENT_SAMPLES,
  defaultTrigger,
  eventCall,
  eventLabel,
  eventText,
  isEventKind,
  nameMatches
} from '../src/workflowEvents'
import { flattenCall, fieldList } from '../src/routineFields'
import { summaryOf, type WorkflowRun } from '../src/workflows'

describe('workflowEvents', () => {
  it('eventText per kind', () => {
    expect(eventText({ kind: 'reply', body: { ...EVENT_SAMPLES.reply, reply: 'Done.' } })).toBe('Done.')
    expect(
      eventText({
        kind: 'todo',
        body: {
          ...EVENT_SAMPLES.todo,
          todos: [
            { text: 'a', group: null },
            { text: 'b', group: 'g' }
          ]
        }
      })
    ).toBe('a\nb')
    expect(eventText({ kind: 'inbox', body: { ...EVENT_SAMPLES.inbox, message: { id: 'm', title: 'T', body: 'B' } } })).toBe('T\n\nB')
    expect(eventText({ kind: 'inbox', body: { ...EVENT_SAMPLES.inbox, message: { id: 'm', title: 'T', body: '' } } })).toBe('T')
    expect(
      eventText({
        kind: 'file',
        body: {
          folder: '/f',
          count: 2,
          truncated: false,
          files: [
            { path: '/f/a', name: 'a', change: 'added' },
            { path: '/f/b', name: 'b', change: 'removed' }
          ]
        }
      })
    ).toBe('/f/a\n/f/b')
    expect(
      eventText({ kind: 'email', body: { ...EVENT_SAMPLES.email, from: { name: 'Ann', address: 'a@x.io' }, subject: 'Hi', text: 'Body' } })
    ).toBe('From: Ann <a@x.io>\nSubject: Hi\n\nBody')
  })
  it('nameMatches stays fast for a pattern of many stars against a long non-matching name', () => {
    const t = Date.now()
    expect(nameMatches('*a'.repeat(100), 'a'.repeat(5000) + 'b')).toBe(false)
    expect(nameMatches('*'.repeat(200) + 'z', 'a'.repeat(5000))).toBe(false)
    expect(Date.now() - t).toBeLessThan(1000)
  })

  it('nameMatches globs case-insensitively; empty matches all', () => {
    expect(nameMatches('', 'x.txt')).toBe(true)
    expect(nameMatches('*.pdf', 'Invoice.PDF')).toBe(true)
    expect(nameMatches('*.pdf', 'a.pdf.tmp')).toBe(false)
    expect(nameMatches('report-??.csv', 'report-07.csv')).toBe(true)
    expect(nameMatches('a+b(1).txt', 'a+b(1).txt')).toBe(true) // regex characters are literal
    expect(nameMatches('a**b', 'axxb')).toBe(true) // a run of stars is one star
    expect(nameMatches('*.pdf', 'x/y.pdf')).toBe(true)
  })
  it('eventCall makes an EVENT call whose body flattens', () => {
    const c = eventCall({ agent: 'x' }, 5)
    expect(c).toEqual({ method: EVENT_METHOD, query: {}, body: { agent: 'x' }, receivedAt: 5 })
    expect(flattenCall(c)['body.agent']).toBe('x')
  })
  it('knows its kinds', () => {
    expect(EVENT_KINDS).toEqual(['reply', 'todo', 'inbox', 'file', 'email'])
    expect(isEventKind('file')).toBe(true)
    expect(isEventKind('webhook')).toBe(false)
  })
  it('has a sample, a label and a field list per kind', () => {
    for (const k of EVENT_KINDS) {
      expect(eventLabel(k)).not.toBe('')
      expect(fieldList(eventCall(EVENT_SAMPLES[k], 0)).length).toBeGreaterThan(0)
    }
  })
  it('the file sample shows every field a file body has, the cut flag too', () => {
    expect(fieldList(eventCall(EVENT_SAMPLES.file, 0)).map((r) => r.path)).toEqual(expect.arrayContaining(['body.count', 'body.truncated']))
    expect(EVENT_SAMPLES.file).toMatchObject({ count: 1, truncated: false })
  })
  it('eventLabel gives the short labels', () => {
    expect(EVENT_KINDS.map(eventLabel)).toEqual(['Reply ended', 'To-do added', 'Inbox message', 'File changed', 'Email arrived'])
  })
  it('defaultTrigger starts each kind empty', () => {
    expect(defaultTrigger('reply')).toEqual({ kind: 'reply', filters: [] })
    expect(defaultTrigger('file')).toEqual({ kind: 'file', path: '', pattern: '', changes: ['added', 'changed', 'removed'], filters: [] })
    expect(defaultTrigger('email')).toEqual({ kind: 'email', account: '', host: '', port: 993, folder: 'INBOX', filters: [] })
  })
  it('summaryOf copies the event kind', () => {
    const run = {
      id: 'r',
      workflowId: 'w',
      via: 'event',
      event: { kind: 'file' },
      late: false,
      status: 'done',
      visits: [],
      startedAt: 1
    } as unknown as WorkflowRun
    expect(summaryOf(run).event).toBe('file')
    expect(summaryOf({ ...run, via: 'manual', event: undefined })).not.toHaveProperty('event')
  })
})
