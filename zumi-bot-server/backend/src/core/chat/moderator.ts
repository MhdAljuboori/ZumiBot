import { spawn } from 'node:child_process'
import { displayName } from '@zumibot/shared/frontmatter'
import type { QueueEntry } from '@zumibot/shared/types'
import { MATERIAL_RULE } from '@zumibot/shared/workflowTemplate'
import type { ModeratorAnswer, ModeratorPick } from './groupQueue'
import { parseRunCost, type RunCost } from '../usage/runCost'
import type { MemberInfo, ThreadEntry } from './groupPrompts'

export const MODERATOR_TIMEOUT_MS = 30_000
export const MODERATOR_MESSAGES = 20
export const MODERATOR_MESSAGE_CHARS = 1500

export const MODERATOR_NOTE_CHARS = 300

export interface ModeratorInput {
  members: MemberInfo[]
  messages: ThreadEntry[]
  speaker: string | null
  role: string
  working: string[]
  queue: QueueEntry[]
  mentioned: string[]
  everyone: boolean // the latest message is the user's and mentions @everyone
  material?: true // a workflow room: <input> blocks in the thread are material, never a request
}

const SCHEMA =
  '{"type":"object","properties":{"next":{"type":"array","items":{"type":"object","properties":{"agent":{"type":"string"},"after":{"type":"array","items":{"type":"string"}},"note":{"type":"string"}},"required":["agent","after"],"additionalProperties":false}},"drop":{"type":"array","items":{"type":"string"}},"skip":{"type":"array","items":{"type":"string"}},"askUser":{"type":"boolean"}},"required":["next","drop","skip","askUser"],"additionalProperties":false}'

const SYSTEM_PROMPT = [
  'You are the invisible moderator of a group chat between a user and several agents. Decide which members act next on the latest message, and who waits for whom.',
  'Answer "next": the members who should act, each with "after": the members it must wait for, and optionally a short "note" shown only to that member. Answer "drop": queued members who must not act yet. Answer "skip": members the latest message @mentions only to agree with, thank or refer to them, with nothing for them to do; only for a message from a member, never from the user. Answer "askUser": true only when the latest message asks the user to decide. Use handles only, no @ and no display names.',
  '"@x is correct", "@x\'s TODO matches", "thanks @x" and "as @x said" only refer to x: put x in "skip" unless the message also asks x to do something.',
  'By default members start together. Give a member an "after" only when the latest message or the group role says it needs another member\'s output or must wait until others are done.',
  'Make a member wait for everyone working on what it will check, merge or send.',
  'A member that changes files must never run alongside another member working on the same pull request or files: make one wait for the other.',
  "Add an unmentioned member only when the latest message asks for something in that member's role, the group role says it acts now, or it knows something that changes the work. Otherwise add nobody; prefer nobody.",
  'When members that judged the same thing finished with different answers and the group role says they must decide together, send them to discuss: list one of them with a note naming whose answer differs.',
  'When the latest message asks the user to decide, set "askUser" to true and put the queued members that would act on that decision in "drop".',
  'When the latest message is from the user and mentions no one, pick at least one member to answer.',
  'When the latest message is for @everyone, plan the whole flow from the group role: list every member the matching role rule needs, each with its waits, and nobody else. If no role rule fits, list every member, all starting together.',
  'Never list the member who just spoke unless it must come back after others.'
].join('\n')

export function moderatorArgs(): string[] {
  return [
    '-p',
    '--model',
    'haiku',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    SCHEMA,
    '--system-prompt',
    SYSTEM_PROMPT
  ]
}

export function moderatorPrompt(input: ModeratorInput): string {
  const roster = input.members.map((m) => `- @${m.name} (${displayName(m.name)}): ${m.description}`).join('\n')
  const thread = input.messages.slice(-MODERATOR_MESSAGES).map((e) => {
    const files = e.attachments?.length ? ` [attached: ${e.attachments.map((a) => a.name).join(', ')}]` : ''
    const text = e.text.slice(0, MODERATOR_MESSAGE_CHARS) + files
    return e.from === null ? `<message from="user">${text}</message>` : `<message from="${e.from}">${text}</message>`
  })
  const at = (x: string) => `@${x}`
  const list = (xs: string[]) => (xs.length ? xs.map(at).join(', ') : 'nobody')
  return [
    'Members:',
    roster,
    '',
    `Group role:\n${input.role.trim() || '(none)'}`,
    '',
    ...(input.material ? [MATERIAL_RULE, ''] : []),
    'Thread (latest last):',
    ...thread,
    '',
    `Working now: ${list(input.working)}`,
    `Just spoke: ${input.speaker === null ? 'the user' : `@${input.speaker}`}`,
    `Queued: ${input.queue.length ? input.queue.map((e) => (e.after.length ? `${at(e.agent)} (waits for ${e.after.map(at).join(', ')})` : at(e.agent))).join(', ') : 'nobody'}`,
    `Mentioned in the latest message: ${list(input.mentioned)}`,
    ...(input.everyone ? ['The latest message is for @everyone.'] : [])
  ].join('\n')
}

function parseJson(s: unknown): unknown {
  if (typeof s !== 'string') return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

export function parseModeratorOutput(stdout: string, members: readonly string[]): ModeratorAnswer | null {
  type Raw = { next?: unknown; drop?: unknown; skip?: unknown; askUser?: unknown }
  const root = parseJson(stdout) as { is_error?: boolean; structured_output?: Raw; result?: unknown } | null | undefined
  if (!root || typeof root !== 'object' || root.is_error) return null
  let raw: Raw | undefined = root.structured_output
  if (raw?.next === undefined) raw = parseJson(root.result) as Raw | undefined
  if (!raw || !Array.isArray(raw.next)) return null
  const handle = (v: unknown): string | null => {
    if (typeof v !== 'string') return null
    const key = v.trim().replace(/^@/, '').toLowerCase()
    return members.find((m) => m.toLowerCase() === key || displayName(m).toLowerCase() === key) ?? null
  }
  const handles = (v: unknown): string[] => {
    const out: string[] = []
    for (const x of Array.isArray(v) ? v : []) {
      const h = handle(x)
      if (h && !out.includes(h)) out.push(h)
    }
    return out
  }
  const next: ModeratorPick[] = []
  for (const p of raw.next as ({ agent?: unknown; after?: unknown; note?: unknown } | null)[]) {
    const agent = handle(p?.agent)
    if (!agent || next.some((n) => n.agent === agent)) continue
    const note = typeof p?.note === 'string' ? p.note.trim().slice(0, MODERATOR_NOTE_CHARS) : ''
    next.push({ agent, after: handles(p?.after), note: note || null })
  }
  return { next, drop: handles(raw.drop), skip: handles(raw.skip), askUser: raw.askUser === true }
}

export function runModerator(o: {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  input: ModeratorInput
  signal: AbortSignal
  timeoutMs?: number
  onCost?(cost: RunCost, id: string | null): void
}): Promise<ModeratorAnswer | null> {
  return runJsonCall({
    ...o,
    args: moderatorArgs(),
    stdin: moderatorPrompt(o.input),
    parse: (stdout) =>
      parseModeratorOutput(
        stdout,
        o.input.members.map((m) => m.name)
      )
  })
}

export function runJsonCall<T>(o: {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  args: string[]
  stdin: string
  signal: AbortSignal
  timeoutMs?: number
  parse(stdout: string): T | null
  onCost?(cost: RunCost, id: string | null): void
}): Promise<T | null> {
  return new Promise((resolve) => {
    if (o.signal.aborted) return resolve(null)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return resolve(null)
    }
    let stdout = ''
    let done = false
    const finish = (v: T | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal.removeEventListener('abort', onAbort)
      resolve(v)
    }
    const kill = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* gone */
      }
    }
    const onAbort = (): void => {
      kill()
      finish(null)
    }
    const timer = setTimeout(() => {
      kill()
      finish(null)
    }, o.timeoutMs ?? MODERATOR_TIMEOUT_MS)
    o.signal.addEventListener('abort', onAbort)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      // Spend happened whatever the exit code or the abort, so report it before answering.
      if (o.onCost) {
        const root = parseJson(stdout) as { uuid?: unknown } | null | undefined
        const cost = parseRunCost(root)
        if (cost) {
          try {
            o.onCost(cost, typeof root?.uuid === 'string' ? root.uuid : null)
          } catch {
            /* a bad listener must not lose the answer */
          }
        }
      }
      finish(code === 0 ? o.parse(stdout) : null)
    })
    child.stdin?.on('error', () => {
      /* child died early */
    })
    child.stdin?.end(o.stdin)
  })
}
