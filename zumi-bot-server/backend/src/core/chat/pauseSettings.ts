import { isAbsolute } from 'node:path'

/**
 * Codex's own calls that wait for its subagents or list them (probe check 11's `tool_name`s). A paused main thread may still
 * make them, so it can wait for its children to finish, as Claude's pause lets subagents finish. No Claude tool has these names.
 */
const WAIT_FOR_SUBAGENTS = new Set(['collaborationwait_agent', 'collaborationlist_agents'])

/** True when the hook must block the call: the CLI sets agent_id only for calls from inside a subagent, so the main thread (even in an --agent session) and unreadable input are blocked. */
export function blocks(input: string): boolean {
  try {
    const v: unknown = JSON.parse(input)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const id = (v as { agent_id?: unknown }).agent_id
      if (typeof id === 'string' && id !== '') return false
      const tool = (v as { tool_name?: unknown }).tool_name
      if (typeof tool === 'string' && WAIT_FOR_SUBAGENTS.has(tool)) return false
    }
  } catch {
    /* unreadable input is blocked */
  }
  return true
}

// Well under the CLI's own hook timeout, which would let the call run (a timed-out hook does not block).
const HOOK_INPUT_MS = 10_000

/**
 * The hook's whole run (pauseHook.ts): read the call from stdin, then exit 0 to let it run, or write the block text and
 * exit 2. Fail-closed and exits once: stdin closing without its end is the end of the input (partial JSON blocks), and a
 * read error, no input in time and a stderr it cannot write to all block.
 */
export function runPauseHook(o: {
  stdin: NodeJS.ReadableStream
  stderr: NodeJS.WritableStream
  exit(code: number): void
  blockText: string
  timeoutMs?: number
}): void {
  const chunks: Buffer[] = []
  let decided = false
  let exited = false
  const exit = (code: number) => {
    if (exited) return
    exited = true
    o.exit(code)
  }
  const decide = (block: boolean) => {
    if (decided) return
    decided = true
    clearTimeout(timer)
    if (!block) return exit(0)
    // Exit 2 even when stderr cannot take the text (EPIPE): the call is blocked either way.
    o.stderr.once('error', () => exit(2))
    try {
      o.stderr.write(o.blockText + '\n', () => exit(2))
    } catch {
      exit(2)
    }
  }
  const read = () => decide(blocks(Buffer.concat(chunks).toString('utf8')))
  // Not unref'd: with no input yet it keeps the process alive, so it can never just end with code 0.
  const timer = setTimeout(() => decide(true), o.timeoutMs ?? HOOK_INPUT_MS)
  o.stdin.on('data', (b: Buffer | string) => chunks.push(typeof b === 'string' ? Buffer.from(b) : b))
  o.stdin.once('end', read)
  o.stdin.once('close', read)
  o.stdin.once('error', () => decide(true))
}

export const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The hook's shell command. The test makes a call outside a pause cost one `[ -e ]`, no node start: the flag file is named by
 * ZUMIBOT_PAUSE_FILE in the run's env, and exists only while the chat is paused. `failClosed` (Codex hooks) never ends in
 * `exec`: Codex lets a call run on any exit but 2, so a node that crashes (exit 1) must still become a block.
 */
export function pauseCommand(o: { node: string; entry: string; electronNode: boolean }, failClosed = false): string {
  const run = `${o.electronNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${failClosed ? '' : 'exec '}${quote(o.node)} ${quote(o.entry)}`
  return `[ -e "$ZUMIBOT_PAUSE_FILE" ] || exit 0; ${failClosed ? `${run}; [ $? -eq 0 ] && exit 0; exit 2` : run}`
}

/** The --settings JSON that hooks every tool call. */
export function pauseSettings(o: { node: string; entry: string; electronNode: boolean }): string {
  const command = pauseCommand(o)
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } })
}

/**
 * The hook for this install, or null when its entry is not there (an incomplete build) or a path is relative (the CLI
 * runs hooks from the chat's folder). Null leaves every run as it was, and a Pause is then refused (ChatService.canPause).
 */
export function pauseHookOf(
  rt: { node: string; pauseHookEntry: string; electronNode: boolean },
  exists: (path: string) => boolean
): { settings: string } | null {
  if (!isAbsolute(rt.node) || !isAbsolute(rt.pauseHookEntry) || !exists(rt.pauseHookEntry)) return null
  return { settings: pauseSettings({ node: rt.node, entry: rt.pauseHookEntry, electronNode: rt.electronNode }) }
}
