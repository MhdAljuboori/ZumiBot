// Dispatched agents: the subagents a chat's agents start with the CLI's Agent (older: Task) tool, and what each one did.
// Kept apart from the chat items (chats/<id>.dispatch.json), so no agent prompt, seed or context meter ever holds them.

/** The tool names that dispatch a subagent. */
export const DISPATCH_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

/** Newer CLIs: a subagent's last call, carrying its report; the dispatch's own result then only points at that call. */
export const HANDBACK_TOOL = 'SubagentHandback'

/** The report in a SubagentHandback call's input (`message`), or null. */
export function handbackMessage(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const m = (input as Record<string, unknown>).message
  return typeof m === 'string' && m.trim() !== '' ? m : null
}

export const DISPATCH_TEXT_MAX = 20_000 // a text step or a tool result
export const DISPATCH_LONG_MAX = 50_000 // the prompt and the final report
export const DISPATCH_INPUT_MAX = 20_000 // a tool input, as JSON
export const DISPATCH_STEPS_MAX = 1_000
export const DISPATCH_STEPS_HEAD = 50 // kept from the start when the middle is dropped
export const DISPATCH_ENTRIES_MAX = 200 // per chat; sync.mjs applies the same cap
export const DISPATCH_FILE_MAX = 10_000_000 // characters of JSON per chat file; sync.mjs applies the same budget

export type DispatchStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'

export type DispatchStep =
  | { kind: 'text'; text: string; ts: number }
  | { kind: 'tool'; id: string; name: string; input: unknown; result: string | null; isError: boolean; ts: number; doneTs?: number }
  | { kind: 'agent'; id: string; ts: number } // a nested dispatch: the child entry's id
  | { kind: 'gap'; dropped: number; ts: number } // steps dropped from the middle of a very long run

export interface DispatchUsage {
  tokens: number | null
  toolUses: number | null
  durationMs: number | null
}

export interface DispatchEntry {
  id: string // the dispatching tool use id
  parent: string | null // the parent entry id for a nested dispatch
  turn: string // groups the entries of one reply
  member?: string // the room member whose turn dispatched it
  description: string
  subagentType: string | null
  prompt: string
  status: DispatchStatus
  now: string | null // what it does now (the CLI's progress line); null once it ended
  usage: DispatchUsage
  steps: DispatchStep[]
  report: string | null
  startedAt: number
  endedAt: number | null
  updatedAt: number
}

/** A list row: no steps, prompt or report. `openTools`: its tool calls still waiting for a result. */
export type DispatchSummary = Omit<DispatchEntry, 'steps' | 'prompt' | 'report'> & { stepCount: number; openTools: string[] }

export interface DispatchFile {
  v: 1
  entries: DispatchEntry[]
}

export const emptyDispatch = (): DispatchFile => ({ v: 1, entries: [] })

export function capText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… ${s.length - max} more characters`
}

/** Input whose JSON is too long becomes the start of that JSON (a string); input with no JSON form is null. */
export function capInput(input: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(input)
  } catch {
    return null
  }
  if (json === undefined) return null
  return json.length <= DISPATCH_INPUT_MAX ? input : json.slice(0, DISPATCH_INPUT_MAX)
}

/** The first steps and the newest, with one gap step counting what was dropped between them. */
export function capSteps(steps: DispatchStep[]): DispatchStep[] {
  const gapAt = steps[DISPATCH_STEPS_HEAD]?.kind === 'gap' ? DISPATCH_STEPS_HEAD : -1
  const real = steps.length - (gapAt === -1 ? 0 : 1)
  if (real <= DISPATCH_STEPS_MAX) return steps
  const head = steps.slice(0, DISPATCH_STEPS_HEAD)
  const rest = gapAt === -1 ? steps.slice(DISPATCH_STEPS_HEAD) : steps.slice(DISPATCH_STEPS_HEAD + 1)
  const keep = DISPATCH_STEPS_MAX - DISPATCH_STEPS_HEAD
  const dropped = rest.length - keep
  const before = gapAt === -1 ? 0 : (steps[gapAt] as Extract<DispatchStep, { kind: 'gap' }>).dropped
  const ts = gapAt === -1 ? rest[0].ts : steps[gapAt].ts
  return [...head, { kind: 'gap', dropped: before + dropped, ts }, ...rest.slice(dropped)]
}

/**
 * The newest entries by start time that fit both caps (count and the file's size), in their original order. The newest
 * one is always kept; the first that does not fit ends the walk, so no older entry outlives a newer one.
 */
export function pruneEntries(entries: DispatchEntry[]): DispatchEntry[] {
  const keep = new Set<string>()
  let size = 0
  for (const e of [...entries].sort((a, b) => b.startedAt - a.startedAt)) {
    if (keep.size >= DISPATCH_ENTRIES_MAX) break
    const n = JSON.stringify(e).length
    if (keep.size > 0 && size + n > DISPATCH_FILE_MAX) break
    keep.add(e.id)
    size += n
  }
  return keep.size === entries.length ? entries : entries.filter((e) => keep.has(e.id))
}

export function summaryOf(e: DispatchEntry): DispatchSummary {
  const { steps, prompt: _prompt, report: _report, ...rest } = e
  const openTools = steps.flatMap((s) => (s.kind === 'tool' && s.result === null ? [s.id] : []))
  return { ...rest, stepCount: steps.length, openTools }
}
