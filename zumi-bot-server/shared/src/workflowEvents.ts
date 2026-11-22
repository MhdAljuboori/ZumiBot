import type { WebhookCall } from './routines'
import type { EventKind, FileChange, WorkflowTrigger } from './workflows'

export const EVENT_KINDS: readonly EventKind[] = ['reply', 'todo', 'inbox', 'file', 'email']
export const isEventKind = (k: string): k is EventKind => (EVENT_KINDS as readonly string[]).includes(k)

/** The `method` of an event's stored call, as a webhook's is 'POST'. */
export const EVENT_METHOD = 'EVENT'
/** Per workflow: more event runs than this in a minute are dropped, so a chatty source cannot flood the run list. */
export const EVENT_RUNS_PER_MINUTE = 30
/** A chain of event starts (an Inbox message, or a file another workflow's run may have written) this deep fires no more. */
export const INBOX_CHAIN_MAX = 3
/** A file burst is debounced this long, and reports at most this many files. */
export const FILE_BURST_MS = 2_000
export const FILE_BURST_MAX = 100
export const MAIL_POLL_MS = 120_000
export const MAIL_PER_CHECK = 10
export const MAIL_TEXT_MAX = 20_000
export const REPLY_TEXT_MAX = 20_000
export const MAIL_PORT_DEFAULT = 993
export const MAIL_FOLDER_DEFAULT = 'INBOX'

export interface ChatRef {
  id: string
  title: string
  folder: string
}
export interface EventBodies {
  reply: { chat: ChatRef; agent: string; outcome: 'ok' | 'error'; room: boolean; reply: string }
  todo: { chat: ChatRef; by: string; count: number; todos: { text: string; group: string | null }[] }
  inbox: { message: { id: string; title: string; body: string }; workflow: { id: string; name: string }; step: string; runId: string }
  // count: every matching file in the burst; files: the first FILE_BURST_MAX of them, truncated when that cut some.
  file: { folder: string; count: number; truncated: boolean; files: { path: string; name: string; change: FileChange }[] }
  email: { from: { name: string; address: string }; to: string; subject: string; date: string; messageId: string; text: string }
}
/** The body of a /run-workflow run: the chat it was typed in, the typed text, and that chat's last agent reply. */
export interface ChatRunBody {
  chat: ChatRef
  text: string
  lastReply: string
}
export type WorkflowEvent = { [K in EventKind]: { kind: K; body: EventBodies[K] } }[EventKind]

/** The event's text, which the trigger step hands on: the reply, one to-do or path per line, the message, the mail. */
export function eventText(e: WorkflowEvent): string {
  switch (e.kind) {
    case 'reply':
      return e.body.reply
    case 'todo':
      return e.body.todos.map((t) => t.text).join('\n')
    case 'inbox':
      return e.body.message.body ? `${e.body.message.title}\n\n${e.body.message.body}` : e.body.message.title
    case 'file':
      return e.body.files.map((f) => f.path).join('\n')
    case 'email': {
      const { name, address } = e.body.from
      return `From: ${name ? `${name} <${address}>` : address}\nSubject: ${e.body.subject}\n\n${e.body.text}`
    }
  }
}

/** The call a run stores for an event, so `{{trigger.body.…}}` and the filters read it as a webhook's. */
export const eventCall = (body: unknown, at: number): WebhookCall => ({ method: EVENT_METHOD, query: {}, body, receivedAt: at })

/** Example bodies for the field list and the `{{` menu, shown as a webhook's latest call is. No real data. */
export const EVENT_SAMPLES: { [K in EventKind]: EventBodies[K] } = {
  reply: {
    chat: { id: 'c-1a2b3c', title: 'Weekly report', folder: '/home/user/projects/report' },
    agent: 'writer',
    outcome: 'ok',
    room: false,
    reply: 'The report is ready: three sections, two charts.'
  },
  todo: {
    chat: { id: 'c-1a2b3c', title: 'Weekly report', folder: '/home/user/projects/report' },
    by: 'user',
    count: 1,
    todos: [{ text: 'Send the report to the team', group: null }]
  },
  inbox: {
    message: { id: 'm-4d5e6f', title: 'Nightly backup finished', body: 'All 12 folders were copied.' },
    workflow: { id: 'w-7a8b9c', name: 'Nightly backup' },
    step: 'Notify',
    runId: 'r-0d1e2f'
  },
  file: {
    folder: '/home/user/invoices',
    count: 1,
    truncated: false,
    files: [{ path: '/home/user/invoices/2026/acme-0042.pdf', name: 'acme-0042.pdf', change: 'added' }]
  },
  email: {
    from: { name: 'Ann Example', address: 'ann@example.com' },
    to: 'me@example.com',
    subject: 'Your invoice for November',
    date: '2026-11-13T09:30:00.000Z',
    messageId: '<20261113093000.1234@example.com>',
    text: 'Hello, the invoice is attached.\n\nThanks, Ann'
  }
}

const LABELS: { [K in EventKind]: string } = {
  reply: 'Reply ended',
  todo: 'To-do added',
  inbox: 'Inbox message',
  file: 'File changed',
  email: 'Email arrived'
}
export const eventLabel = (kind: EventKind): string => LABELS[kind]

/** A file-name glob: `*` any run, `?` one character, the rest literal, case-insensitive; empty matches every name. */
export function nameMatches(pattern: string, name: string): boolean {
  if (!pattern) return true
  // Two pointers with one star to fall back to, not a regex: `*a*a*a…` on a long name cannot backtrack without bound.
  const p = pattern.toLowerCase()
  const n = name.toLowerCase()
  let pi = 0
  let ni = 0
  let star = -1
  let mark = 0
  while (ni < n.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi++
      mark = ni
    } else if (pi < p.length && (p[pi] === '?' || p[pi] === n[ni])) {
      pi++
      ni++
    } else if (star >= 0) {
      pi = star + 1
      ni = ++mark
    } else return false
  }
  while (pi < p.length && p[pi] === '*') pi++
  return pi === p.length
}

/** A fresh trigger of an event kind, as the Starts select sets it: no filters, nothing picked yet. */
export function defaultTrigger(kind: EventKind): WorkflowTrigger {
  switch (kind) {
    case 'reply':
    case 'todo':
    case 'inbox':
      return { kind, filters: [] }
    case 'file':
      return { kind, path: '', pattern: '', changes: ['added', 'changed', 'removed'], filters: [] }
    case 'email':
      return { kind, account: '', host: '', port: MAIL_PORT_DEFAULT, folder: MAIL_FOLDER_DEFAULT, filters: [] }
  }
}
