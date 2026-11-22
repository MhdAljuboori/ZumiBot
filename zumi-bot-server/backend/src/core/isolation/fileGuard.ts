import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { sandboxFileBlocked } from '@zumibot/shared/isolation'
import { FILE_TOOLS_MATCHER, type GuardRoots } from './sandboxSettings'

export { encodeRoots, FILE_TOOLS_MATCHER, fileGuardCommand, type GuardRoots } from './sandboxSettings'

// The file tools' half of a sandboxed run (governance.md 2.3). The CLI's OS sandbox covers Bash only, and its own
// blockReadsOutsideWorkingDirectories also checks paths inside Bash commands (`-o /dev/null` turns into a card even in auto
// mode, as the phase 2 probe found), so ZumiBot holds the file tools to the agent's folders with this PreToolUse hook instead.
// Fail closed: unreadable input, a missing path, a crash or a timeout all block.

const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const HOOK_INPUT_MS = 10_000

const inside = (path: string, root: string): boolean => {
  const r = relative(root, path)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** The real path of `p`, or of its nearest existing parent with the rest added (a file about to be written). */
export function realOf(p: string, real: (p: string) => string = realpathSync): string {
  let head = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return join(real(head), ...rest.reverse())
    } catch {
      const up = dirname(head)
      if (up === head) return resolve(p)
      rest.push(basename(head))
      head = up
    }
  }
}

/** The path a call is refused for, or null when it may run. `real` resolves symlinks, so a link out of the folder is caught. */
export function fileGuardVerdict(inputJson: string, roots: GuardRoots, real: (p: string) => string = realpathSync): string | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(inputJson) as Record<string, unknown>
  } catch {
    return '(unreadable call)'
  }
  if (!v || typeof v !== 'object') return '(unreadable call)'
  const tool = typeof v.tool_name === 'string' ? v.tool_name : ''
  const input = (v.tool_input && typeof v.tool_input === 'object' ? v.tool_input : {}) as Record<string, unknown>
  const cwd = typeof v.cwd === 'string' && isAbsolute(v.cwd) ? v.cwd : null
  if (!FILE_TOOLS_MATCHER.split('|').includes(tool)) return null
  const field = tool === 'NotebookEdit' ? input.notebook_path : tool === 'Grep' || tool === 'Glob' ? (input.path ?? cwd) : input.file_path
  if (typeof field !== 'string' || field === '') return '(no path)'
  if (!isAbsolute(field) && cwd === null) return field
  const targets = [resolve(cwd ?? '/', field)]
  // A Glob pattern may itself name a folder: an absolute one, or one climbing out with `..`.
  if (tool === 'Glob' && typeof input.pattern === 'string') {
    const pattern = input.pattern
    if (pattern.split('/').includes('..')) return pattern
    if (isAbsolute(pattern)) {
      const parts = pattern.split('/')
      const g = parts.findIndex((x) => /[*?[{]/.test(x))
      targets.push((g < 0 ? parts : parts.slice(0, g)).join('/') || '/')
    }
  }
  const realRoots = (list: string[]) => list.map((r) => realOf(r, real))
  const write = realRoots(roots.write)
  const read = [...realRoots(roots.read), ...write]
  const deny = realRoots(roots.deny)
  for (const t of targets) {
    const path = realOf(t, real)
    if (WRITE_TOOLS.has(tool)) {
      if (!write.some((r) => inside(path, r)) || deny.some((d) => inside(path, d))) return t
    } else if (!read.some((r) => inside(path, r))) return t
  }
  return null
}

/** The hook's whole run: read the call, then exit 0 to let it run or write the block line and exit 2. */
export function runFileGuard(o: {
  stdin: NodeJS.ReadableStream
  stderr: NodeJS.WritableStream
  exit(code: number): void
  roots: GuardRoots | null
  timeoutMs?: number
}): void {
  const chunks: Buffer[] = []
  let done = false
  const finish = (blocked: string | null) => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (blocked === null) return o.exit(0)
    o.stderr.once('error', () => o.exit(2))
    try {
      o.stderr.write(sandboxFileBlocked(blocked) + '\n', () => o.exit(2))
    } catch {
      o.exit(2)
    }
  }
  const read = () => {
    try {
      finish(o.roots === null ? '(no folders given)' : fileGuardVerdict(Buffer.concat(chunks).toString('utf8'), o.roots))
    } catch {
      finish('(guard error)')
    }
  }
  const timer = setTimeout(() => finish('(no input in time)'), o.timeoutMs ?? HOOK_INPUT_MS)
  o.stdin.on('data', (b: Buffer | string) => chunks.push(typeof b === 'string' ? Buffer.from(b) : b))
  o.stdin.once('end', read)
  o.stdin.once('close', read)
  o.stdin.once('error', () => finish('(unreadable call)'))
}

export function decodeRoots(arg: string | undefined): GuardRoots | null {
  try {
    const v = JSON.parse(Buffer.from(arg ?? '', 'base64url').toString('utf8')) as GuardRoots
    const ok = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string' && isAbsolute(s))
    return ok(v.read) && ok(v.write) && ok(v.deny) ? v : null
  } catch {
    return null
  }
}
