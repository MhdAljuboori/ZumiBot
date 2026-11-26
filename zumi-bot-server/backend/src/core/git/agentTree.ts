import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { GitError, type Git } from './git'

/** The chat's items, newest last; called only when the repo has another worktree to follow. */
export type ItemsLoader = () => Promise<readonly ChatItem[]>

const TIMEOUT_MS = 5_000

// Tools that write a file, by the input field naming it. Reads don't count: an agent reviews other folders too.
const FILE_TOOLS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

// `cd <dir>` at a command's start (also `pushd`), and `git -C <dir>`.
const WORD = `("[^"\\n]*"|'[^'\\n]*'|[^\\s;&|()<>]+)`
const SHELL_PLACE = new RegExp(`(?:^|[;&|(\\n])\\s*(?:cd|pushd)\\s+(?:--\\s+)?${WORD}|\\bgit\\s+-C\\s+${WORD}`, 'g')

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** An absolute path, with `~` and `$HOME` expanded; null for a relative one, whose shell folder the item doesn't record. */
function absolute(v: unknown, home: string): string | null {
  if (typeof v !== 'string' || v === '') return null
  const p = v.replace(/^(?:~|\$HOME|\$\{HOME\})(?=$|[\\/])/, home)
  return isAbsolute(p) ? resolve(p) : null
}

function shellPlaces(command: string, home: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(SHELL_PLACE)) {
    const word = m[1] ?? m[2] ?? ''
    const p = absolute(/^["']/.test(word) ? word.slice(1, -1) : word, home)
    if (p !== null) out.push(p)
  }
  return out.reverse()
}

/** The folders one tool call worked in, the last one first. */
export function toolPlaces(item: ChatItem, home: string): string[] {
  if (item.type !== 'tool' || !isObj(item.input)) return []
  const input = item.input
  const field = FILE_TOOLS[item.name]
  if (field !== undefined) {
    const file = absolute(input[field], home)
    return file === null ? [] : [dirname(file)]
  }
  // Bash, and any tool that runs a shell line (a background process): its cd's, then the folder it started in.
  const out = typeof input['command'] === 'string' ? shellPlaces(input['command'], home) : []
  const cwd = absolute(input['cwd'], home)
  if (cwd !== null) out.push(cwd)
  return out
}

const within = (tree: string, p: string): boolean => {
  const r = relative(tree, p)
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r))
}

/** The worktree among `trees` holding `path`: the deepest, since one can sit inside another (`.claude/worktrees/x`). */
export function treeOf(path: string, trees: readonly string[]): string | null {
  let best: string | null = null
  for (const t of trees) if (within(t, path) && (best === null || t.length > best.length)) best = t
  return best
}

/** One of a repo's worktrees, from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string
  branch: string | null // the short name; null = detached HEAD
  main: boolean // the repo's own checkout, listed first; the others are linked worktrees
}

/** `git worktree list --porcelain`: the repo's worktrees there are to read (not bare, not prunable). */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let first = true
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const head = lines[0] ?? ''
    if (!head.startsWith('worktree ')) continue
    const main = first
    first = false
    if (lines.some((l) => l === 'bare' || l.startsWith('prunable'))) continue
    const ref = lines.find((l) => l.startsWith('branch refs/heads/'))
    out.push({ path: head.slice('worktree '.length), branch: ref ? ref.slice('branch refs/heads/'.length) : null, main })
  }
  return out
}

/**
 * Another worktree of the chat's repo that the agent last worked in, or null to read the chat's own folder. An agent can
 * make its own worktree (`git worktree add`) and work there with `cd` and absolute paths; the git chip and the Changes
 * panel follow it so they show the agent's work, not the checkout the chat was opened in. The newest tool call that
 * names a folder of one of the repo's worktrees decides; a place outside the repo (scratch files in /tmp) is passed over,
 * and a worktree removed since is no longer listed, so it is never followed. `path` is the folder's real path.
 */
export async function agentTreeOf(git: Git, meta: ChatMeta, items: ItemsLoader, home: string = homedir()): Promise<WorktreeEntry | null> {
  if (meta.worktree?.removed) return null
  let listed: string
  try {
    listed = (await git(['worktree', 'list', '--porcelain'], meta.cwd, { timeoutMs: TIMEOUT_MS })).stdout
  } catch (e) {
    if (e instanceof GitError) return null
    throw e
  }
  // Paths compared as real paths: git lists /private/tmp/x on macOS where the agent typed /tmp/x.
  const seen = new Map<string, Promise<string>>()
  const real = (p: string): Promise<string> => {
    let got = seen.get(p)
    if (!got) {
      got = realpath(p).catch(() => p)
      seen.set(p, got)
    }
    return got
  }
  const entries = await Promise.all(parseWorktreeList(listed).map(async (e) => ({ ...e, path: await real(resolve(e.path)) })))
  if (entries.length < 2) return null
  const trees = entries.map((e) => e.path)
  const own = treeOf(await real(resolve(meta.cwd)), trees)
  const list = await items()
  for (let i = list.length - 1; i >= 0; i--) {
    for (const place of toolPlaces(list[i] as ChatItem, home)) {
      const tree = treeOf(await real(place), trees)
      if (tree !== null) return tree === own ? null : (entries.find((e) => e.path === tree) ?? null)
    }
  }
  return null
}

/**
 * Where the agent's work in its own worktree started, for Since start: the commit its branch was created at, the oldest
 * entry of the branch's reflog ("branch: Created from ..."). Null for the repo's own checkout (its branch reaches back
 * to the clone), a detached HEAD, or a reflog that is gone.
 */
export async function branchStart(git: Git, tree: WorktreeEntry): Promise<string | null> {
  if (tree.main || tree.branch === null) return null
  const r = await git(['reflog', 'show', '--format=%H', `refs/heads/${tree.branch}`], tree.path, { timeoutMs: TIMEOUT_MS }).catch(
    (e: unknown) => {
      if (e instanceof GitError) return null
      throw e
    }
  )
  const oldest = r?.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
  return /^[0-9a-f]{40,64}$/.test(oldest) ? oldest : null
}
