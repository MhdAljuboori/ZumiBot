import {
  TODO_ADD_MAX,
  TODO_AGENT_DESC_MAX,
  TODO_ASK_MAX,
  TODO_GROUP_MAX,
  TODO_OPEN_MAX,
  TODO_OPTION_MAX,
  TODO_OPTIONS_MAX,
  TODO_QUESTION_MAX,
  TODO_COMMENT_MAX,
  TODO_REVIEW_MAX,
  TODO_TEXT_MAX,
  normalizeTodoText
} from '@zumibot/shared/todos'

export type TodoCall =
  | { op: 'list' }
  | { op: 'add'; items: { text: string; group?: string | null; description?: string }[] }
  | { op: 'check'; ids: string[]; done: boolean }
  | { op: 'remove'; ids: string[] }
  // The wire form is the tool's own (the server parses the bridge's call again), so `question` stays `question`.
  | { op: 'ask_user'; questions: { question: string; options: string[] }[] }
  | { op: 'ready_for_review'; summary: string }
  | { op: 'comment'; id: string; text: string }

const idSchema = { type: 'string', minLength: 1, maxLength: 128 }
const idsSchema = { type: 'array', minItems: 1, maxItems: TODO_OPEN_MAX, items: idSchema }

// The one-sentence rules of the spec's fixed paragraph, one per tool. The names carry no chat id: the server binds it.
export const todoTools = [
  {
    name: 'list',
    description:
      "Return the open to-dos of the user's task board (id, group, text, who made it and who has it) and what changed since you last saw it; never show ids to the user.",
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[], additionalProperties: false }
  },
  {
    name: 'add',
    description: `Add to-dos only when the user's message asks for a to-do list: one short actionable line each about something the user has to do (with its link if there is one) and a description that holds everything needed to act on it, up to ${TODO_ADD_MAX} per call, skipping anything already open even when worded differently, and using the reply's own headings as group.`,
    inputSchema: {
      type: 'object' as const,
      required: ['items'],
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: {
              text: { type: 'string', maxLength: TODO_TEXT_MAX },
              group: { type: ['string', 'null'], maxLength: TODO_GROUP_MAX },
              description: {
                type: 'string',
                maxLength: TODO_AGENT_DESC_MAX,
                description:
                  'Everything needed to act on the item without this chat: the context from your reply, names, links, numbers, dates. It may be given to another agent that never sees this chat.'
              }
            }
          }
        }
      }
    }
  },
  {
    name: 'check',
    description:
      'Tick a to-do when you finished it for the user in this turn or when the user says it is done, and untick it (done false) when the user says so.',
    inputSchema: {
      type: 'object' as const,
      required: ['ids', 'done'],
      additionalProperties: false,
      properties: { ids: idsSchema, done: { type: 'boolean' } }
    }
  },
  {
    name: 'remove',
    description: 'Remove a to-do only when the user asks you to.',
    inputSchema: { type: 'object' as const, required: ['ids'], additionalProperties: false, properties: { ids: idsSchema } }
  },
  // The two task-card tools work only in a chat a to-do card was given to; elsewhere they refuse with a sentence to act on.
  {
    name: 'ask_user',
    description: `Only in a chat that works on a task card: put your questions for the user on the card (up to ${TODO_ASK_MAX}, each with optional short choices), then end your turn. The answers come back as a new message. Use this instead of AskUserQuestion there.`,
    inputSchema: {
      type: 'object' as const,
      required: ['questions'],
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: TODO_ASK_MAX,
          items: {
            type: 'object',
            required: ['question'],
            additionalProperties: false,
            properties: {
              question: { type: 'string', maxLength: TODO_QUESTION_MAX },
              options: { type: 'array', maxItems: TODO_OPTIONS_MAX, items: { type: 'string', maxLength: TODO_OPTION_MAX } }
            }
          }
        }
      }
    }
  },
  {
    name: 'ready_for_review',
    description:
      'Only in a chat that works on a task card: when the task is done, mark the card ready for review with a short summary of what you did and how to check it, then end your turn. The user ticks the card or writes back.',
    inputSchema: {
      type: 'object' as const,
      required: ['summary'],
      additionalProperties: false,
      properties: { summary: { type: 'string', maxLength: TODO_REVIEW_MAX } }
    }
  },
  {
    name: 'comment',
    description:
      "Add a comment to a card on the board, which the user reads on the card: a short update, a finding, or a reply to the user's comment. Not for questions you need answered in a task chat (use ask_user) nor for your final summary (use ready_for_review).",
    inputSchema: {
      type: 'object' as const,
      required: ['id', 'text'],
      additionalProperties: false,
      properties: { id: idSchema, text: { type: 'string', maxLength: TODO_COMMENT_MAX } }
    }
  }
]

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k))
}
const bad = (what: string) => new Error(`Invalid to-do call: ${what}`)
// Cut here as the service would: a full add then always fits the IPC's request limit, whatever length the agent sent.
const cutGroup = (group: string) => group.replace(/\s+/g, ' ').trim().slice(0, TODO_GROUP_MAX).trim()
const cutBlock = (s: string, max: number) => s.trim().slice(0, max).trim()

function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > TODO_OPEN_MAX ||
    !value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 128)
  )
    throw bad('ids must be a list of item ids')
  return value as string[]
}

/** Checks the arguments of one tool call exactly: unknown keys (a chat id included) are refused. Messages are plain and safe to show the agent. */
export function parseTodoCall(name: string, args: unknown): TodoCall {
  if (!record(args)) throw bad('arguments must be an object')
  switch (name) {
    case 'list':
      if (!exact(args, [])) throw bad('list takes no arguments')
      return { op: 'list' }
    case 'add': {
      if (!exact(args, ['items']) || !Array.isArray(args.items)) throw bad('items must be a list of {text, group}')
      // The count rule (at most 50) is the service's, so the agent reads its own message; this only bounds memory.
      if (args.items.length > 1000) throw bad('too many items')
      const items = args.items.map((raw) => {
        if (
          !record(raw) ||
          !exact(raw, ['text', 'group', 'description']) ||
          typeof raw.text !== 'string' ||
          (raw.group !== undefined && raw.group !== null && typeof raw.group !== 'string') ||
          (raw.description !== undefined && typeof raw.description !== 'string')
        )
          throw bad('each item is {text, group?, description?}')
        const text = normalizeTodoText(raw.text)
        const item: { text: string; group?: string | null; description?: string } = { text }
        if (raw.group !== undefined) item.group = raw.group === null ? null : cutGroup(raw.group)
        if (typeof raw.description === 'string') item.description = cutBlock(raw.description, TODO_AGENT_DESC_MAX)
        return item
      })
      return { op: 'add', items }
    }
    case 'check':
      if (!exact(args, ['ids', 'done']) || typeof args.done !== 'boolean') throw bad('check takes ids and done')
      return { op: 'check', ids: ids(args.ids), done: args.done }
    case 'remove':
      if (!exact(args, ['ids'])) throw bad('remove takes ids')
      return { op: 'remove', ids: ids(args.ids) }
    case 'ask_user': {
      if (!exact(args, ['questions']) || !Array.isArray(args.questions) || args.questions.length === 0)
        throw bad('questions must be a list of {question, options}')
      // The count is the service's sentence too; past it nothing is cut, so a call never loses a question silently.
      if (args.questions.length > TODO_ASK_MAX) throw bad(`ask at most ${TODO_ASK_MAX} questions at a time`)
      const questions = args.questions.map((raw) => {
        if (
          !record(raw) ||
          !exact(raw, ['question', 'options']) ||
          typeof raw.question !== 'string' ||
          (raw.options !== undefined && (!Array.isArray(raw.options) || !raw.options.every((o) => typeof o === 'string')))
        )
          throw bad('each question is {question, options?}')
        const options = ((raw.options ?? []) as string[])
          .slice(0, TODO_OPTIONS_MAX)
          .map((o) => o.replace(/\s+/g, ' ').trim().slice(0, TODO_OPTION_MAX).trim())
        return { question: cutBlock(raw.question, TODO_QUESTION_MAX), options }
      })
      return { op: 'ask_user', questions }
    }
    case 'ready_for_review':
      if (!exact(args, ['summary']) || typeof args.summary !== 'string') throw bad('ready_for_review takes a summary')
      return { op: 'ready_for_review', summary: cutBlock(args.summary, TODO_REVIEW_MAX) }
    case 'comment':
      if (
        !exact(args, ['id', 'text']) ||
        typeof args.id !== 'string' ||
        args.id.length === 0 ||
        args.id.length > 128 ||
        typeof args.text !== 'string'
      )
        throw bad('comment takes id and text')
      return { op: 'comment', id: args.id, text: cutBlock(args.text, TODO_COMMENT_MAX) }
    default:
      throw bad('unknown tool')
  }
}

/** The tool arguments of an already-built call (its `op` is the tool name). */
export function parseTodoWire(call: unknown): TodoCall {
  if (!record(call) || typeof call.op !== 'string') throw bad('missing op')
  const { op, ...args } = call
  return parseTodoCall(op, args)
}
