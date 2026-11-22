import {
  PROCESS_COMMAND_MAX,
  PROCESS_LIFETIME_MAX_MIN,
  PROCESS_NAME_MAX,
  PROCESS_PATTERNS_MAX,
  PROCESS_PATTERN_MAX,
  PROCESS_TAIL_MAX,
  PROCESS_WAIT_MAX_S,
  WAKE_TIMES_MAX,
  type NotifyRule
} from '@zumibot/shared/processes'

export type ProcessCall =
  | { op: 'start'; command: string; name?: string; cwd?: string; timeoutMinutes?: number; notify?: NotifyRule }
  | { op: 'list' }
  | { op: 'logs'; id: string; tail?: number; from?: number; grep?: string }
  | { op: 'wait'; id: string; patterns?: string[]; timeoutSeconds?: number; from?: number }
  | { op: 'stop'; id: string }

export const PROCESS_SERVER = 'zumibot_processes'
export const PROCESS_TOOL_PREFIX = `mcp__${PROCESS_SERVER}__`
export const PROCESS_START_TOOL = `${PROCESS_TOOL_PREFIX}start`
/** The CLI asks before every start, in every mode: a process outlives the turn, so the user sees each one begin. */
export const PROCESS_ASK_SETTINGS: string = JSON.stringify({ permissions: { ask: [PROCESS_START_TOOL] } })

const idSchema = { type: 'string', pattern: '^p_[0-9a-f]{10}$' }
const cursorSchema = { type: 'integer', minimum: 0, description: 'A cursor a previous logs or wait answer gave.' }
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false
})

// The names carry no chat id: the server binds the chat from the bridge's capability.
export const processTools = [
  {
    name: 'start',
    description:
      "Start a command that keeps running after your reply (a dev server, a test watcher, a long build) in this chat's folder. The user approves the exact command first. It gets no input, runs until it ends, is stopped, or its time limit passes, and its output is kept for logs and wait.",
    inputSchema: obj(
      {
        command: {
          type: 'string',
          maxLength: PROCESS_COMMAND_MAX,
          description: 'Run with bash -c, exactly as given. Do not add &, nohup or setsid.'
        },
        name: {
          type: 'string',
          maxLength: PROCESS_NAME_MAX,
          description: 'A short name such as "web" or "tests"; letters, digits, space, dot, dash, underscore.'
        },
        cwd: { type: 'string', description: 'A folder inside the chat folder, relative to it. Defaults to the chat folder.' },
        timeoutMinutes: {
          type: 'integer',
          minimum: 1,
          maximum: PROCESS_LIFETIME_MAX_MIN,
          description: `Ends it after this many minutes (default and most ${PROCESS_LIFETIME_MAX_MIN}).`
        },
        notify: {
          type: 'object',
          additionalProperties: false,
          required: ['on'],
          description:
            'Get a message in this chat later, after your reply, when it exits (exit), exits with an error (fail), or prints a line holding one of patterns (match). Use it for long builds and test runs instead of waiting. A stop never sends one.',
          properties: {
            on: { type: 'string', enum: ['exit', 'fail', 'match'] },
            patterns: {
              type: 'array',
              minItems: 1,
              maxItems: PROCESS_PATTERNS_MAX,
              items: { type: 'string', minLength: 1, maxLength: PROCESS_PATTERN_MAX },
              description: 'Plain text, not regex; only with on: match.'
            },
            times: { type: 'integer', minimum: 1, maximum: WAKE_TIMES_MAX, description: 'How many messages at most (default 1).' }
          }
        }
      },
      ['command']
    )
  },
  {
    name: 'list',
    description: "List this chat's processes: id, name, state, exit code, uptime and who started each.",
    inputSchema: obj({})
  },
  {
    name: 'logs',
    description:
      "Read a process's output: its last lines (tail), or everything after a cursor (from) a previous answer gave; grep keeps only lines containing that text.",
    inputSchema: obj(
      {
        id: idSchema,
        tail: { type: 'integer', minimum: 1, maximum: PROCESS_TAIL_MAX },
        from: cursorSchema,
        grep: { type: 'string', maxLength: PROCESS_PATTERN_MAX }
      },
      ['id']
    )
  },
  {
    name: 'wait',
    description:
      'Wait until an output line contains one of the patterns (plain text, not regex), the process ends, or the timeout passes. Lines already printed count unless from is given. Use it after start to wait for a ready line.',
    inputSchema: obj(
      {
        id: idSchema,
        patterns: {
          type: 'array',
          maxItems: PROCESS_PATTERNS_MAX,
          items: { type: 'string', minLength: 1, maxLength: PROCESS_PATTERN_MAX }
        },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: PROCESS_WAIT_MAX_S },
        from: cursorSchema
      },
      ['id']
    )
  },
  { name: 'stop', description: 'Stop a process of this chat and everything it started.', inputSchema: obj({ id: idSchema }, ['id']) }
]

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k))
}
const bad = (what: string) => new Error(`Invalid process call: ${what}`)
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^p_[0-9a-f]{10}$/.test(v)) throw bad('id must be a process id from start or list')
  return v
}
const int = (v: unknown, min: number, max: number, what: string): number | undefined => {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${what} must be a whole number from ${min} to ${max}`)
  return v
}
const optStr = (v: unknown, max: number, what: string): string | undefined => {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length > max) throw bad(`${what} must be text of at most ${max} characters`)
  return v
}

function notifyOf(v: unknown): NotifyRule {
  if (!record(v) || !exact(v, ['on', 'patterns', 'times']) || (v.on !== 'exit' && v.on !== 'fail' && v.on !== 'match'))
    throw bad('notify is {on: exit | fail | match, patterns?, times?}')
  const out: NotifyRule = { on: v.on }
  if (v.patterns !== undefined) {
    if (
      !Array.isArray(v.patterns) ||
      v.patterns.length === 0 ||
      v.patterns.length > PROCESS_PATTERNS_MAX ||
      !v.patterns.every((p) => typeof p === 'string' && p.length > 0 && p.length <= PROCESS_PATTERN_MAX)
    )
      throw bad(`notify.patterns must be 1 to ${PROCESS_PATTERNS_MAX} texts of 1 to ${PROCESS_PATTERN_MAX} characters`)
    out.patterns = v.patterns as string[]
  }
  const n = int(v.times, 1, WAKE_TIMES_MAX, 'notify.times')
  if (n !== undefined) out.times = n
  return out
}

/** Checks one tool call exactly: unknown keys (a chat id included) are refused. Messages are plain and safe to show the agent. */
export function parseProcessCall(name: string, args: unknown): ProcessCall {
  if (!record(args)) throw bad('arguments must be an object')
  switch (name) {
    case 'start': {
      if (!exact(args, ['command', 'name', 'cwd', 'timeoutMinutes', 'notify']) || typeof args.command !== 'string')
        throw bad('start takes command, and optional name, cwd, timeoutMinutes and notify')
      if (args.command.length > PROCESS_COMMAND_MAX) throw bad(`the command is longer than ${PROCESS_COMMAND_MAX} characters`)
      const call: ProcessCall = { op: 'start', command: args.command }
      const n = optStr(args.name, PROCESS_NAME_MAX, 'name')
      if (n !== undefined) call.name = n
      const c = optStr(args.cwd, 4096, 'cwd')
      if (c !== undefined) call.cwd = c
      const t = int(args.timeoutMinutes, 1, PROCESS_LIFETIME_MAX_MIN, 'timeoutMinutes')
      if (t !== undefined) call.timeoutMinutes = t
      if (args.notify !== undefined) call.notify = notifyOf(args.notify)
      return call
    }
    case 'list':
      if (!exact(args, [])) throw bad('list takes no arguments')
      return { op: 'list' }
    case 'logs': {
      if (!exact(args, ['id', 'tail', 'from', 'grep'])) throw bad('logs takes id, and optional tail, from and grep')
      const call: ProcessCall = { op: 'logs', id: id(args.id) }
      const t = int(args.tail, 1, PROCESS_TAIL_MAX, 'tail')
      if (t !== undefined) call.tail = t
      const f = int(args.from, 0, Number.MAX_SAFE_INTEGER, 'from')
      if (f !== undefined) call.from = f
      const g = optStr(args.grep, PROCESS_PATTERN_MAX, 'grep')
      if (g !== undefined && g !== '') call.grep = g
      return call
    }
    case 'wait': {
      if (!exact(args, ['id', 'patterns', 'timeoutSeconds', 'from']))
        throw bad('wait takes id, and optional patterns, timeoutSeconds and from')
      const call: ProcessCall = { op: 'wait', id: id(args.id) }
      if (args.patterns !== undefined) {
        if (
          !Array.isArray(args.patterns) ||
          args.patterns.length > PROCESS_PATTERNS_MAX ||
          !args.patterns.every((p) => typeof p === 'string' && p.length > 0 && p.length <= PROCESS_PATTERN_MAX)
        )
          throw bad(`patterns must be up to ${PROCESS_PATTERNS_MAX} texts of 1 to ${PROCESS_PATTERN_MAX} characters`)
        call.patterns = args.patterns as string[]
      }
      const t = int(args.timeoutSeconds, 1, PROCESS_WAIT_MAX_S, 'timeoutSeconds')
      if (t !== undefined) call.timeoutSeconds = t
      const f = int(args.from, 0, Number.MAX_SAFE_INTEGER, 'from')
      if (f !== undefined) call.from = f
      return call
    }
    case 'stop':
      if (!exact(args, ['id'])) throw bad('stop takes id')
      return { op: 'stop', id: id(args.id) }
    default:
      throw bad('unknown tool')
  }
}

/** The bridge's parsed call is the wire form the server parses again. */
export function parseProcessWire(call: unknown): ProcessCall {
  if (!record(call) || typeof call.op !== 'string') throw bad('missing op')
  const { op, ...args } = call
  return parseProcessCall(op, args)
}
