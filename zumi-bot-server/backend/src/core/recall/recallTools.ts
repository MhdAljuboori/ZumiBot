import { RECALL_PAGE } from '@zumibot/shared/recall'
import { SEARCH_OFFSET_MAX, SEARCH_QUERY_MAX } from '@zumibot/shared/search'

export type RecallCall =
  | { op: 'search'; query: string; since?: string; until?: string; offset?: number }
  | { op: 'read'; chatId: string; messageId: string }

const ID = /^[A-Za-z0-9_-]{1,64}$/
// A day (`2026-11-21`) or a full time (`2026-11-21T14:00Z`); anything else ("last week") is refused, so the agent works the date out.
const WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/
const DAY_MS = 86_400_000

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false
})
const when = (what: string) => ({
  type: 'string',
  maxLength: 40,
  description: `${what}, as a UTC date (2026-11-21) or a time (2026-11-21T14:00Z).`
})

// The names carry no chat id of the caller or agent: the server binds both from the bridge's capability.
export const recallTools = [
  {
    name: 'search',
    description: `Search your past chats (the ones your recall setting covers, never this one) for messages holding every word of query. Newest first, ${RECALL_PAGE} a page, each with its date, who wrote it, its chat and a snippet. Use since and until to narrow by date, then read a hit for the whole message and what was said around it. Read-only.`,
    inputSchema: obj(
      {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: SEARCH_QUERY_MAX,
          description: 'Words that must all appear (word starts match). Put a phrase in double quotes.'
        },
        since: when('Only messages from this day on'),
        until: when('Only messages up to the end of this day'),
        offset: { type: 'integer', minimum: 0, maximum: SEARCH_OFFSET_MAX, description: 'Hits to skip, for the next page.' }
      },
      ['query']
    )
  },
  {
    name: 'read',
    description: 'Read one message a search found, whole, with up to two messages before and after it in the same chat. Read-only.',
    inputSchema: obj(
      {
        chatId: { type: 'string', pattern: ID.source, description: 'The chat id a search hit gave.' },
        messageId: { type: 'string', pattern: ID.source, description: 'The message id a search hit gave.' }
      },
      ['chatId', 'messageId']
    )
  }
]

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k))
}
const bad = (what: string) => new Error(`Invalid recall call: ${what}`)
const optWhen = (v: unknown, what: string): string | undefined => {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !WHEN.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${what} must be a date like 2026-11-21`)
  return v
}
const id = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !ID.test(v)) throw bad(`${what} must be an id a search hit gave`)
  return v
}

/** Checks one tool call exactly: unknown keys are refused. Messages are plain and safe to show the agent. */
export function parseRecallCall(name: string, args: unknown): RecallCall {
  if (!record(args)) throw bad('arguments must be an object')
  switch (name) {
    case 'search': {
      if (!exact(args, ['query', 'since', 'until', 'offset'])) throw bad('search takes query, and optional since, until and offset')
      if (typeof args.query !== 'string' || args.query.trim() === '' || args.query.length > SEARCH_QUERY_MAX)
        throw bad(`query must be 1 to ${SEARCH_QUERY_MAX} characters`)
      const call: RecallCall = { op: 'search', query: args.query }
      const since = optWhen(args.since, 'since')
      if (since !== undefined) call.since = since
      const until = optWhen(args.until, 'until')
      if (until !== undefined) call.until = until
      if (args.offset !== undefined) {
        const o = args.offset
        if (typeof o !== 'number' || !Number.isInteger(o) || o < 0 || o > SEARCH_OFFSET_MAX)
          throw bad(`offset must be a whole number from 0 to ${SEARCH_OFFSET_MAX}`)
        call.offset = o
      }
      return call
    }
    case 'read':
      if (!exact(args, ['chatId', 'messageId'])) throw bad('read takes chatId and messageId')
      return { op: 'read', chatId: id(args.chatId, 'chatId'), messageId: id(args.messageId, 'messageId') }
    default:
      throw bad('unknown tool')
  }
}

/** The bridge's parsed call is the wire form the server parses again. */
export function parseRecallWire(call: unknown): RecallCall {
  if (!record(call) || typeof call.op !== 'string') throw bad('missing op')
  const { op, ...args } = call
  return parseRecallCall(op, args)
}

/** A parsed `since` / `until` as epoch ms. A bare day starts at 00:00 UTC; as `until` it takes the whole day. */
export function whenMs(v: string, end: boolean): number {
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)
  return end && v.length === 10 ? t + DAY_MS - 1 : t
}
