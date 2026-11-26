import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  baseEntries,
  gitChangesOf,
  lineCount,
  listedOf,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusZ,
  type LineCount,
  type StatusEntry,
  type StatusZ
} from '@zumibot/shared/gitChanges'
import type { ChatMeta, GitChanges, GitDiffScope, GitFileDiff, GitSide } from '@zumibot/shared/types'
import { agentTreeOf, branchStart, type ItemsLoader } from './agentTree'
import { GitError, type Git } from './git'

const TIMEOUT_MS = 10_000
/** A side over this size is not sent; the Files panel's snapshots stop at the same size. */
export const GIT_TEXT_MAX = 1024 * 1024
// Bytes read in all to count untracked files' lines: a big untracked folder must not make the list slow.
const COUNT_BUDGET = 8 * 1024 * 1024
// git's own binary test: a NUL in the first 8000 bytes.
const SNIFF = 8000

export const NO_CHANGE = 'This file has no uncommitted changes now.'
export const NO_BASE_CHANGE = 'This file has not changed since the worktree started.'

// --no-optional-locks: a status or diff must not take index.lock from under the agent's own git add or commit.
// -uall lists each untracked file, not just its folder, so every row has one file to show.
const STATUS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']
const DIFF = ['--no-optional-locks', 'diff', '-z', '-M', '--no-ext-diff', '--no-textconv']

const ABSENT: GitSide = { miss: 'absent' }
const UNREADABLE: GitSide = { miss: 'unreadable' }

const inside = (top: string, p: string): boolean => {
  const r = relative(top, p)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

const textSide = (buf: Buffer): GitSide => (buf.subarray(0, SNIFF).includes(0) ? { miss: 'binary' } : { text: buf.toString('utf8') })

/**
 * The repo top a list or diff reads, whether it is the agent's own worktree rather than the chat's folder, and the commit
 * Since start compares against there (null: none).
 */
interface Where {
  top: string
  agent: boolean
  base: string | null
}

/** What one scope compares against: the entries it lists and the ref its "before" side is read from. */
interface Scoped {
  entries: StatusEntry[]
  more: number
  ref: string
  status: StatusZ
}

/**
 * The Changes panel: what changed in a chat's repo, either uncommitted (against HEAD) or since the worktree's base
 * commit, and one file's two sides. Read-only: git runs with --no-optional-locks and nothing is written.
 */
export class GitChangesService {
  constructor(private readonly git: Git) {}

  /**
   * null outside a repo, without git, once the chat's worktree folder was removed, or for the base scope where there is
   * no base commit; another git failure throws its line. `items` given: both scopes read the other worktree the agent
   * last worked in, when there is one (see `agentTreeOf`), and Since start measures from where its branch started.
   */
  async list(meta: ChatMeta, scope: GitDiffScope = 'uncommitted', items?: ItemsLoader): Promise<GitChanges | null> {
    const at = await this.where(meta, items, true)
    if (at === null) return null
    const scoped = await this.scoped(meta, at, scope)
    if (scoped === null) return null
    const counts = await this.counts(at.top, scoped.entries, scoped.ref)
    const changes = gitChangesOf(at.top, scoped.status, scoped.entries, scoped.more, counts)
    return { ...changes, ...(at.agent ? { agentTree: at.top } : {}), ...(at.base !== null ? { base: at.base } : {}) }
  }

  /** The listed file at the scope's ref (its old path for a rename) and on disk. Only a path the scope lists now is read. */
  async diff(meta: ChatMeta, path: string, scope: GitDiffScope = 'uncommitted', items?: ItemsLoader): Promise<GitFileDiff> {
    const at = await this.where(meta, items, scope === 'base')
    if (at === null) throw new Error('Not in a git repository')
    const { top } = at
    const scoped = await this.scoped(meta, at, scope, Infinity)
    if (scoped === null) throw new Error('This chat has no base commit to compare against.')
    const entry = scoped.entries.find((e) => e.path === path)
    if (!entry) throw new Error(scope === 'base' ? NO_BASE_CHANGE : NO_CHANGE)
    if (entry.submodule) return { path, before: { miss: 'submodule' }, after: { miss: 'submodule' } }
    const before =
      entry.kind === 'added' || entry.kind === 'untracked' ? ABSENT : await this.atRef(top, scoped.ref, entry.from ?? entry.path)
    const after = entry.kind === 'deleted' ? ABSENT : await onDisk(top, entry.path)
    return { path, before, after }
  }

  /**
   * The scope's entries and its ref. `uncommitted` is the status alone; `base` is `git diff <base>` (so a change the
   * agent already committed shows) plus the status's untracked files, and its before side comes from the base commit.
   */
  private async scoped(meta: ChatMeta, { top, agent, base }: Where, scope: GitDiffScope, max?: number): Promise<Scoped | null> {
    // ZumiBot's links belong to the chat's own worktree only.
    const links = agent ? [] : (meta.worktree?.links ?? [])
    const status = parseStatusZ((await this.git(STATUS, top, { timeoutMs: TIMEOUT_MS })).stdout)
    if (scope === 'uncommitted') {
      const { entries, more } = listedOf(status.entries, links, max)
      return { entries, more, ref: 'HEAD', status }
    }
    if (base === null) return null
    const named = parseNameStatusZ((await this.git([...DIFF, '--name-status', base, '--'], top, { timeoutMs: TIMEOUT_MS })).stdout)
    const { entries, more } = listedOf(baseEntries(named, status), links, max)
    return { entries, more, ref: base, status }
  }

  /**
   * The folder to read: the agent's own worktree when it works in one, else the chat's. `withBase`: also find the
   * commit Since start compares against (the chat worktree's recorded base, or where the agent's branch started).
   */
  private async where(meta: ChatMeta, items: ItemsLoader | undefined, withBase: boolean): Promise<Where | null> {
    const agent = items ? await agentTreeOf(this.git, meta, items) : null
    if (agent !== null) return { top: agent.path, agent: true, base: withBase ? await branchStart(this.git, agent) : null }
    const top = await this.topOf(meta)
    return top === null ? null : { top, agent: false, base: meta.worktree?.base ?? null }
  }

  private async topOf(meta: ChatMeta): Promise<string | null> {
    if (meta.worktree?.removed) return null
    try {
      const { stdout } = await this.git(['rev-parse', '--show-toplevel'], meta.cwd, { timeoutMs: TIMEOUT_MS })
      // Git for Windows prints `C:/x`: resolved to the native `C:\x`, as the chat's own paths are.
      const top = stdout.replace(/\r?\n$/, '')
      return top ? resolve(top) : null
    } catch (e) {
      if (
        e instanceof GitError &&
        (e.message === 'Folder not found' ||
          e.message === 'git not found' ||
          /not a git repository|must be run in a work tree/i.test(e.message))
      )
        return null
      throw e
    }
  }

  /** Tracked files from numstat against the scope's ref; untracked ones by reading them, within a budget. */
  private async counts(top: string, entries: StatusEntry[], ref: string): Promise<Map<string, LineCount>> {
    // A repo with no commit yet has no HEAD to diff against: its files just show no counts.
    const counts = await this.git([...DIFF, '--numstat', ref, '--'], top, { timeoutMs: TIMEOUT_MS }).then(
      (r) => parseNumstatZ(r.stdout),
      () => new Map<string, LineCount>()
    )
    let budget = COUNT_BUDGET
    for (const e of entries) {
      if (e.kind !== 'untracked' || budget <= 0) continue
      const abs = join(top, e.path)
      const st = await lstat(abs).catch(() => null)
      if (!st?.isFile() || st.size > GIT_TEXT_MAX || st.size > budget) continue
      budget -= st.size
      const buf = await readFile(abs).catch(() => null)
      if (buf && !buf.subarray(0, SNIFF).includes(0)) counts.set(e.path, { added: lineCount(buf.toString('utf8')), removed: 0 })
    }
    return counts
  }

  private async atRef(top: string, ref: string, path: string): Promise<GitSide> {
    // `<ref>:<path>` is read from the top, whatever the cwd. 128: not at that ref (or no HEAD yet).
    const size = await this.git(['cat-file', '-s', `${ref}:${path}`], top, { timeoutMs: TIMEOUT_MS, allowExit: [128] })
    if (size.code !== 0) return ABSENT
    const n = Number(size.stdout.trim())
    if (!Number.isFinite(n)) return UNREADABLE
    if (n > GIT_TEXT_MAX) return { miss: 'too-big' }
    const { stdout } = await this.git(['cat-file', 'blob', `${ref}:${path}`], top, { timeoutMs: TIMEOUT_MS })
    return stdout.slice(0, SNIFF).includes('\0') ? { miss: 'binary' } : { text: stdout }
  }
}

/** The file in the folder now. A symlink shows its target, as git stores it; nothing outside the repo is ever read. */
async function onDisk(top: string, path: string): Promise<GitSide> {
  const abs = join(top, path)
  if (!inside(top, abs)) return UNREADABLE
  const st = await lstat(abs).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : undefined))
  if (st === null) return ABSENT
  if (st === undefined) return UNREADABLE
  if (st.isSymbolicLink())
    return readlink(abs).then(
      (text) => ({ text }),
      () => UNREADABLE
    )
  if (!st.isFile()) return UNREADABLE
  if (st.size > GIT_TEXT_MAX) return { miss: 'too-big' }
  // A folder on the way could be a link out of the repo: git would not list a file there, but check rather than trust it.
  const [realTop, real] = await Promise.all([realpath(top).catch(() => top), realpath(abs).catch(() => null)])
  if (real === null || !inside(realTop, real)) return UNREADABLE
  const buf = await readFile(abs).catch(() => null)
  if (buf === null) return UNREADABLE
  return buf.length > GIT_TEXT_MAX ? { miss: 'too-big' } : textSide(buf)
}
