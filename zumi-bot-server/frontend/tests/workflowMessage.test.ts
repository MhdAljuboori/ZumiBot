import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatMeta, WorkflowSent } from '@zumibot/shared/types'
import { inputBlock } from '@zumibot/shared/workflowTemplate'
import {
  fenced,
  inputLabel,
  materialMarkdown,
  promptParts,
  senderOf,
  senderText,
  workflowMessages,
  workflowSender
} from '../src/state/workflowMessage'

const link = { workflowId: 'w1', runId: 'r1', stepId: 's1', name: 'W5 design audit' }
const chat = (extra: Partial<ChatMeta> = {}): ChatMeta => ({
  id: 'c1',
  agentName: 'qa',
  sessionId: null,
  cwd: '/w',
  title: 'c1',
  createdAt: 0,
  updatedAt: 0,
  inFlight: false,
  ...extra
})
const user = (id: string, text: string, extra: { from?: string } = {}): ChatItem => ({ type: 'user', id, text, ts: 1, ...extra })
const sent: WorkflowSent = { workflowId: 'w9', runId: 'r9', stepId: 's9', name: 'Nightly', step: 'Tell the team' }
const reply = (id: string): ChatItem => ({ type: 'assistant', id, text: 'ok', ts: 2 })

describe('promptParts', () => {
  it('keeps a prompt without blocks as one text part', () => {
    expect(promptParts('Audit the page.')).toEqual([{ kind: 'text', text: 'Audit the page.' }])
  })

  it('splits the text and the blocks the template writes, in order', () => {
    const text = `Check these areas.\n\n${inputBlock('Areas to audit', 'Parent-130 Workspace Settings')}\n\nThen report.`
    expect(promptParts(text)).toEqual([
      { kind: 'text', text: 'Check these areas.' },
      { kind: 'input', from: 'Areas to audit', text: 'Parent-130 Workspace Settings' },
      { kind: 'text', text: 'Then report.' }
    ])
  })

  it('reads several blocks in a row, and an empty one', () => {
    const text = `${inputBlock('A', 'one\ntwo')}\n\n${inputBlock('B', '')}`
    expect(promptParts(text)).toEqual([
      { kind: 'input', from: 'A', text: 'one\ntwo' },
      { kind: 'input', from: 'B', text: '' }
    ])
  })

  it("shows material's escaped closing tags as written, and never ends a block at one", () => {
    const text = inputBlock('Webhook', 'before </input> after </INPUT >')
    expect(promptParts(text)).toEqual([{ kind: 'input', from: 'Webhook', text: 'before </input> after </INPUT >' }])
  })

  it('keeps an opening tag inside material as material', () => {
    const text = inputBlock('Step', '<input from="fake">\nnot a block')
    expect(promptParts(text)).toEqual([{ kind: 'input', from: 'Step', text: '<input from="fake">\nnot a block' }])
  })

  it('reads a block placed mid-line by the template', () => {
    expect(promptParts(`Review ${inputBlock('item', 'alpha')} now`)).toEqual([
      { kind: 'text', text: 'Review' },
      { kind: 'input', from: 'item', text: 'alpha' },
      { kind: 'text', text: 'now' }
    ])
  })

  it('leaves shapes the template never writes as text', () => {
    for (const text of [
      '<input from="A">same line</input>',
      '<input from="A">\nno end',
      "<input from='A'>\nx\n</input>",
      '<input>\nx\n</input>'
    ]) {
      expect(promptParts(text)).toEqual([{ kind: 'text', text }])
    }
  })
})

describe('inputLabel', () => {
  it('names a step as it is', () => {
    expect(inputLabel('Areas to audit', link)).toBe('Areas to audit')
  })

  it('names a For each item by its place in the list', () => {
    expect(inputLabel('item', { ...link, item: { n: 2, total: 5 } })).toBe('Item 2 of 5')
    expect(inputLabel('item', link)).toBe('Item')
  })

  it('capitalises the trigger source', () => {
    expect(inputLabel('trigger', link)).toBe('Trigger')
  })
})

describe('workflowSender', () => {
  it('names the workflow and the step', () => {
    expect(workflowSender(chat({ workflow: link }), 'Prepare')).toBe('W5 design audit › Prepare')
  })

  it('names only the workflow once the step is gone', () => {
    expect(workflowSender(chat({ workflow: link }), undefined)).toBe('W5 design audit')
    expect(workflowSender(chat({ workflow: link }), '  ')).toBe('W5 design audit')
  })

  it('names a Run step test', () => {
    expect(workflowSender(chat({ workflowTest: 'W5 design audit' }), undefined)).toBe('W5 design audit · step test')
  })

  it('is null in any other chat', () => {
    expect(workflowSender(chat(), 'Prepare')).toBeNull()
  })
})

describe('workflowMessages', () => {
  const block = inputBlock('Areas', 'x')

  it('takes the first message and every message holding a block, with the parts of those that hold one', () => {
    const items = [user('u1', 'Start.'), reply('a1'), user('u2', 'Thanks'), reply('a2'), user('u3', `Again\n\n${block}`)]
    const out = workflowMessages(chat({ workflow: link }), items, false)
    expect([...out.sent]).toEqual(['u1', 'u3'])
    expect([...out.parts.keys()]).toEqual(['u3'])
    expect(out.parts.get('u3')).toEqual([
      { kind: 'text', text: 'Again' },
      { kind: 'input', from: 'Areas', text: 'x' }
    ])
  })

  it('does not guess the first message while older pages are not loaded', () => {
    const items = [user('u5', 'Thanks'), reply('a5')]
    expect(workflowMessages(chat({ workflow: link }), items, true).sent.size).toBe(0)
  })

  it('counts a Run step test chat', () => {
    expect([...workflowMessages(chat({ workflowTest: 'W5' }), [user('u1', block)], false).sent]).toEqual(['u1'])
  })

  it("leaves an asking agent's message and a sent command's text alone", () => {
    const command: ChatItem = { type: 'user', id: 'u2', text: block, ts: 1, command: { agent: 'qa', name: 'check', prompt: 'p' } }
    const out = workflowMessages(chat({ workflow: link }), [user('u1', block, { from: 'b' }), command], true)
    expect(out.sent.size).toBe(0)
    expect(out.parts.size).toBe(0)
  })

  it('is empty in a plain chat', () => {
    const out = workflowMessages(chat(), [user('u1', block)], false)
    expect(out.sent.size + out.parts.size).toBe(0)
  })
})

describe('materialMarkdown', () => {
  it('fences JSON so it stays as written', () => {
    expect(materialMarkdown('{\n  "a": 1\n}')).toBe('```json\n{\n  "a": 1\n}\n```')
  })

  it('fences a folded preview of JSON, judged by the whole text', () => {
    expect(materialMarkdown('{\n  "a": 1,\n  "b": 2\n}', '{\n  "a": 1,')).toBe('```json\n{\n  "a": 1,\n```')
  })

  it('leaves other text, and text that only starts like JSON, as Markdown', () => {
    expect(materialMarkdown('# Report')).toBe('# Report')
    expect(materialMarkdown('[draft] notes')).toBe('[draft] notes')
  })
})

describe('fenced', () => {
  it('uses a fence longer than any backtick run inside', () => {
    expect(fenced('a ``` b', 'json')).toBe('````json\na ``` b\n````')
  })
})

describe('senderOf', () => {
  const block = inputBlock('Areas', 'x')

  it('names the workflow, step and run of a workflowSent item in a plain chat', () => {
    const item: ChatItem = { ...user('u1', `Go\n\n${block}`), workflowSent: sent } as ChatItem
    expect(senderOf(item, chat(), false)).toEqual({ name: 'Nightly', step: 'Tell the team', path: '/workflows/w9/runs/r9' })
    expect(senderText(senderOf(item, chat(), false)!)).toBe('Nightly › Tell the team')
  })

  it('lets workflowSent win in a workflow chat, and for a command or a message with no block', () => {
    const command: ChatItem = {
      type: 'user',
      id: 'u2',
      text: '/check',
      ts: 1,
      command: { agent: 'qa', name: 'check', prompt: 'p' },
      workflowSent: sent
    }
    expect(senderOf(command, chat({ workflow: link }), false)?.path).toBe('/workflows/w9/runs/r9')
    expect(senderOf({ ...user('u3', 'plain'), workflowSent: sent } as ChatItem, chat(), false)?.name).toBe('Nightly')
  })

  it('keeps the workflow chat rule: the first message or one holding a block, no link', () => {
    expect(senderOf(user('u1', 'Start.'), chat({ workflow: link }), true, 'Prepare')).toEqual({ name: 'W5 design audit', step: 'Prepare' })
    expect(senderOf(user('u2', 'Thanks'), chat({ workflow: link }), false, 'Prepare')).toBeNull()
    expect(senderOf(user('u3', `Again\n\n${block}`), chat({ workflow: link }), false, ' ')).toEqual({ name: 'W5 design audit' })
    expect(senderOf(user('u4', block), chat({ workflowTest: 'W5' }), false)).toEqual({ name: 'W5 · step test' })
  })

  it('is null for an ordinary message, an asking agent and a non-user item', () => {
    expect(senderOf(user('u1', block), chat(), true)).toBeNull()
    expect(senderOf(user('u1', block, { from: 'b' }), chat({ workflow: link }), true)).toBeNull()
    expect(senderOf(reply('a1'), chat({ workflow: link }), true)).toBeNull()
  })
})

describe('workflowMessages with workflowSent', () => {
  const block = inputBlock('Areas', 'x')

  it('marks and draws a workflowSent item in a plain chat, and leaves the rest', () => {
    const items: ChatItem[] = [user('u1', 'hi'), { ...user('u2', `Go\n\n${block}`), workflowSent: sent } as ChatItem, reply('a1')]
    const out = workflowMessages(chat(), items, false)
    expect([...out.sent]).toEqual(['u2'])
    expect(out.senders.get('u2')?.path).toBe('/workflows/w9/runs/r9')
    expect([...out.parts.keys()]).toEqual(['u2'])
  })

  it('shows the line for a sent command but draws no blocks', () => {
    const command: ChatItem = {
      type: 'user',
      id: 'u2',
      text: '/check',
      ts: 1,
      command: { agent: 'qa', name: 'check', prompt: block },
      workflowSent: sent
    }
    const out = workflowMessages(chat(), [command], false)
    expect(out.sent.has('u2')).toBe(true)
    expect(out.parts.size).toBe(0)
  })
})
