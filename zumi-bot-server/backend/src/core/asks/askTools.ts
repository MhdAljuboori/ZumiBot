import { ASK_MESSAGE_MAX, ASK_SIDE_NAME, ASK_SIDE_QUESTION_MAX } from '@zumibot/shared/agentAsk'

export type AskCall = { agent: string; message: string }
export type SideAskCall = { agent: string; question: string }

// The tool names no chat: the server binds the caller from the capability token.
export const askTools = [
  {
    name: 'ask',
    description:
      'Ask another agent a question and wait for its answer. `agent` is its handle (for example @reviewer); `message` is the whole question with the context it needs, since it sees none of this chat. Ask only when the user wants it or you need an answer you cannot get yourself.',
    inputSchema: {
      type: 'object' as const,
      required: ['agent', 'message'],
      additionalProperties: false,
      properties: {
        agent: { type: 'string', minLength: 1, maxLength: 200 },
        message: { type: 'string', minLength: 1, maxLength: ASK_MESSAGE_MAX }
      }
    }
  },
  {
    name: ASK_SIDE_NAME,
    description:
      'Ask an agent you already asked from this chat a quick side question about that conversation. It answers from what it already knows there, without tools, and any work it is doing keeps going. Use ask for new work.',
    inputSchema: {
      type: 'object' as const,
      required: ['agent', 'question'],
      additionalProperties: false,
      properties: {
        agent: { type: 'string', minLength: 1, maxLength: 200 },
        question: { type: 'string', minLength: 1, maxLength: ASK_SIDE_QUESTION_MAX }
      }
    }
  }
]

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k))
}
const bad = (what: string) => new Error(`Invalid ask call: ${what}`)

/** Checks one tool call exactly: unknown keys (a chat id included) are refused. Messages are plain and safe to show the agent. */
export function parseAskCall(name: string, args: unknown): AskCall {
  if (name !== 'ask') throw bad('unknown tool')
  if (!record(args)) throw bad('arguments must be an object')
  if (!exact(args, ['agent', 'message'])) throw bad('ask takes agent and message only')
  if (typeof args.agent !== 'string' || args.agent.trim() === '' || args.agent.length > 200) throw bad('agent must be a handle')
  if (typeof args.message !== 'string' || args.message.trim() === '') throw bad('message must not be empty')
  if (args.message.length > ASK_MESSAGE_MAX) throw bad(`message is longer than ${ASK_MESSAGE_MAX} characters`)
  return { agent: args.agent, message: args.message }
}

/** The arguments of an already-built call, as they cross the socket. */
export function parseAskWire(call: unknown): AskCall {
  return parseAskCall('ask', call)
}

/** Same exactness for the side tool: its own key names, so a run-shaped call cannot pass as a side one. */
export function parseSideCall(name: string, args: unknown): SideAskCall {
  if (name !== ASK_SIDE_NAME) throw bad('unknown tool')
  if (!record(args)) throw bad('arguments must be an object')
  if (!exact(args, ['agent', 'question'])) throw bad('side_question takes agent and question only')
  if (typeof args.agent !== 'string' || args.agent.trim() === '' || args.agent.length > 200) throw bad('agent must be a handle')
  if (typeof args.question !== 'string' || args.question.trim() === '') throw bad('question must not be empty')
  if (args.question.length > ASK_SIDE_QUESTION_MAX) throw bad(`question is longer than ${ASK_SIDE_QUESTION_MAX} characters`)
  return { agent: args.agent, question: args.question }
}

export function parseSideWire(call: unknown): SideAskCall {
  return parseSideCall(ASK_SIDE_NAME, call)
}
