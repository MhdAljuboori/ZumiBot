import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isArchived } from '@zumibot/shared/archive'
import { listedOf, parseStatusZ } from '@zumibot/shared/gitChanges'
import {
  PR_BODY_MAX,
  PR_COMMITS_MAX,
  PR_TITLE_MAX,
  checkMessage,
  draftBody,
  draftTitle,
  foldRollup,
  prUnfinished,
  scrubToken
} from '@zumibot/shared/pullRequest'
import type { ChatMeta, ChatPr, ChatPush, GhState, PrDraft, PrState } from '@zumibot/shared/types'
import type { TodoItem } from '@zumibot/shared/todos'
import { GitError, type Git } from '../git/git'
import type { ChatStore } from '../store/chatStore'
import { GhError, isAuthError, type Gh } from './gh'

export interface PullRequestsDeps {
  git: Git
  gh: Gh
  ghState(): Promise<GhState>
  /** Dropped whenever a gh call fails on authentication, so the UI stops offering what cannot work. */
  forgetAuth(): void
  store: Pick<ChatStore, 'get' | 'patchInPlace'>
  /** The card a chat works on, when it is a task chat; null otherwise. Used only to draft and to mirror the PR. */
  card(todoId: string): Promise<TodoItem | null>
  /** Writes the card's display copy of the PR. Never fails a PR: a mirror is only what the board shows. */
  mirror(todoId: string, pr: { number: number; url: string; state: PrState; chatId: string } | null): Promise<void>
  /** The user's message into the chat, through the queue. Resolves when its turn ends, so it is never awaited. */
  submit(chatId: string, text: string): Promise<unknown>
  push(p: ChatPush): void
  now(): number
}

const STATUS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']
const GIT_TIMEOUT_MS = 15_000
const PUSH_TIMEOUT_MS = 300_000
const LOG_TIMEOUT_MS = 120_000
const PR_FIELDS = 'number,url,state,isDraft,statusCheckRollup'

export const NO_WORKTREE = 'This chat does not run in a worktree, so it has no branch of its own to open a pull request from.'
export const WORKTREE_GONE = 'Its worktree folder was removed. Send a message in the chat to bring it back first.'
export const DEFAULT_BRANCH = "This chat is on the repository's default branch. ZumiBot never pushes there."
export const NO_COMMITS = 'Nothing is committed on this branch yet.'
export const NO_PR = 'This chat has no pull request.'

const dirtyLine = (n: number): string => `Commit or stash the ${n} uncommitted ${n === 1 ? 'change' : 'changes'} first.`

/**
 * Pull requests opened from a chat's worktree branch, through the `gh` CLI. ZumiBot stores no GitHub token: gh holds
 * its own credentials. A push and a create happen only on the user's own click — no agent tool, workflow step, routine
 * or poll reaches them — and never with `--force`, never to the repository's default branch.
 */
export class PullRequests {
  constructor(private readonly d: PullRequestsDeps) {}

  /** What the Open PR dialog starts from, and why it cannot be opened yet when it cannot. */
  async draftPr(chatId: string): Promise<PrDraft> {
    const meta = await this.chat(chatId)
    const wt = meta.worktree
    if (!wt) return { branch: '', base: null, commits: [], title: '', body: '', dirty: 0, refusal: NO_WORKTREE }
    if (wt.removed) return { branch: wt.branch, base: null, commits: [], title: '', body: '', dirty: 0, refusal: WORKTREE_GONE }
    const [dirty, commits, isDefault] = await Promise.all([
      this.dirtyCount(meta),
      this.commits(wt.root, wt.base ?? null),
      this.onDefaultBranch(wt.root, wt.branch)
    ])
    const card = meta.task ? await this.d.card(meta.task.todoId).catch(() => null) : null
    const draft: PrDraft = {
      branch: wt.branch,
      base: wt.base ?? null,
      commits,
      title: draftTitle(card?.text ?? null, commits, wt.branch),
      body: draftBody(card?.description ?? null, commits),
      dirty
    }
    const refusal = isDefault ? DEFAULT_BRANCH : dirty > 0 ? dirtyLine(dirty) : commits.length === 0 ? NO_COMMITS : undefined
    return refusal === undefined ? draft : { ...draft, refusal }
  }

  /** Pushes the branch and opens the pull request. Every refusal is checked again here: the client is never trusted. */
  async createPr(chatId: string, input: { title: string; body: string; draft: boolean }): Promise<ChatPr> {
    const meta = await this.chat(chatId)
    const wt = meta.worktree
    if (!wt) throw new Error(NO_WORKTREE)
    if (wt.removed) throw new Error(WORKTREE_GONE)
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, PR_TITLE_MAX)
    if (title === '') throw new Error('A pull request needs a title.')
    const body = input.body.slice(0, PR_BODY_MAX)
    if (await this.onDefaultBranch(wt.root, wt.branch)) throw new Error(DEFAULT_BRANCH)
    const dirty = await this.dirtyCount(meta)
    if (dirty > 0) throw new Error(dirtyLine(dirty))
    if ((await this.commits(wt.root, wt.base ?? null)).length === 0) throw new Error(NO_COMMITS)
    await this.needGh()
    // Never --force and never --force-with-lease: a rejected push is the user's to resolve, in their own terms.
    await this.git(['push', '-u', 'origin', wt.branch], wt.root, { timeoutMs: PUSH_TIMEOUT_MS })
    const dir = await mkdtemp(join(tmpdir(), 'zumibot-pr-'))
    try {
      // The body goes through a file: no shell, and a long body never reaches argv.
      const file = join(dir, 'body.md')
      await writeFile(file, body)
      const args = ['pr', 'create', '--head', wt.branch, '--title', title, '--body-file', file]
      if (input.draft) args.push('--draft')
      await this.gh(args, wt.root)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    return this.read(chatId, wt.root, wt.branch)
  }

  /** Reads the state and the checks again. The watcher calls this too, so nothing here ever writes to GitHub. */
  async refreshPr(chatId: string): Promise<ChatPr> {
    const meta = await this.chat(chatId)
    const pr = meta.pr
    if (!pr) throw new Error(NO_PR)
    const root = meta.worktree?.root ?? meta.cwd
    return this.read(chatId, root, pr.branch)
  }

  /** One `gh pr view`, folded, stored on the chat and mirrored on its card. A failed read keeps the last state. */
  private async read(chatId: string, cwd: string, branch: string): Promise<ChatPr> {
    let raw: Record<string, unknown>
    try {
      const { stdout } = await this.gh(['pr', 'view', branch, '--json', PR_FIELDS], cwd)
      raw = JSON.parse(stdout) as Record<string, unknown>
    } catch (e) {
      const why = e instanceof Error ? scrubToken(e.message) : 'gh failed'
      const kept = (await this.d.store.get(chatId))?.pr
      if (!kept) throw e
      return this.store(chatId, { ...kept, at: this.d.now(), error: why })
    }
    const number = typeof raw.number === 'number' ? raw.number : 0
    if (number === 0) throw new GhError('gh did not report a pull request for this branch')
    const checks = foldRollup(raw.statusCheckRollup)
    const next: ChatPr = {
      number,
      url: typeof raw.url === 'string' ? raw.url : '',
      state: stateOf(raw.state),
      branch,
      ...(raw.isDraft === true ? { draft: true as const } : {}),
      ...(checks ? { checks } : {}),
      at: this.d.now()
    }
    return this.store(chatId, next)
  }

  /** In place, so the sidebar order does not move, then the card's display copy. */
  private async store(chatId: string, pr: ChatPr): Promise<ChatPr> {
    const meta = await this.d.store.patchInPlace(chatId, () => ({ pr }))
    if (meta) {
      this.d.push({ chatId, kind: 'meta', meta })
      if (meta.task) {
        await this.d.mirror(meta.task.todoId, { number: pr.number, url: pr.url, state: pr.state, chatId }).catch(() => {
          // A mirror is only what the board shows; the chat's meta is what counts.
        })
      }
    }
    return pr
  }

  /** Posts a failing check and the tail of its log as an ordinary user turn in the chat. */
  async sendCheck(chatId: string, name: string): Promise<void> {
    const meta = await this.chat(chatId)
    const pr = meta.pr
    if (!pr) throw new Error(NO_PR)
    // Only a check this chat's own stored rollup names: a made-up name never reaches gh.
    const check = pr.checks?.failing.find((c) => c.name === name)
    if (!check) throw new Error('That check is not failing on this pull request.')
    const cwd = meta.worktree?.root ?? meta.cwd
    let log: string | null = null
    if (check.jobId) {
      log = await this.jobLog(cwd, check.jobId)
    }
    void this.d.submit(chatId, checkMessage(pr, check, log)).catch(() => {
      // The turn's own errors show in the chat; nothing of the message goes to a log.
    })
  }

  /** A GitHub Actions job's failing steps, else its whole log; anything that is not one has none through gh. */
  private async jobLog(cwd: string, jobId: string): Promise<string | null> {
    for (const args of [
      ['run', 'view', '--job', jobId, '--log-failed'],
      ['run', 'view', '--job', jobId, '--log']
    ]) {
      const r = await this.gh(args, cwd, { timeoutMs: LOG_TIMEOUT_MS }).catch(() => null)
      if (r && r.stdout.trim() !== '') return r.stdout
    }
    return null
  }

  private async chat(chatId: string): Promise<ChatMeta> {
    const meta = await this.d.store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    return meta
  }

  private async needGh(): Promise<void> {
    const state = await this.d.ghState()
    if (state !== 'ready')
      throw new GhError(state === 'missing' ? 'gh not found' : 'gh is not signed in. Run `gh auth login` in a terminal.')
  }

  /**
   * Every git call of this service goes through here: git prints the remote back in a rejected push, and a remote URL
   * can carry credentials, so its line is scrubbed before it reaches the user, the meta or a log.
   */
  private async git(
    args: string[],
    cwd: string,
    o: { timeoutMs?: number; allowExit?: number[] } = {}
  ): Promise<{ stdout: string; code: number }> {
    try {
      return await this.d.git(args, cwd, o)
    } catch (e) {
      if (e instanceof GitError) throw new GitError(scrubToken(e.message))
      throw e
    }
  }

  /** Every gh call goes through here, so a sign-in that lapsed is noticed once and the UI stops offering what fails. */
  private async gh(args: string[], cwd: string, o: { timeoutMs?: number } = {}): Promise<{ stdout: string; code: number }> {
    try {
      return await this.d.gh(args, cwd, o)
    } catch (e) {
      if (e instanceof GhError && isAuthError(e.message)) this.d.forgetAuth()
      throw e
    }
  }

  /** Uncommitted entries in the worktree, ZumiBot's own links left out, as `release` counts them. */
  private async dirtyCount(meta: ChatMeta): Promise<number> {
    const root = meta.worktree?.root ?? meta.cwd
    const { stdout } = await this.d.git(STATUS, root, { timeoutMs: GIT_TIMEOUT_MS })
    return listedOf(parseStatusZ(stdout).entries, meta.worktree?.links ?? [], Infinity).entries.length
  }

  /** `git log --oneline <base>..HEAD`: the work since the worktree started, newest first. */
  private async commits(root: string, base: string | null): Promise<string[]> {
    const range = base ? `${base}..HEAD` : `-n${PR_COMMITS_MAX}`
    const r = await this.d
      .git(['--no-optional-locks', 'log', '--oneline', '--no-decorate', `--max-count=${PR_COMMITS_MAX}`, range], root, {
        timeoutMs: GIT_TIMEOUT_MS
      })
      .catch((e: unknown) => {
        if (e instanceof GitError) return null // an unborn branch or a base git no longer has: the dialog just lists none
        throw e
      })
    return r === null
      ? []
      : r.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
  }

  /** Whether the chat's branch is the repository's own default, which ZumiBot never pushes to. */
  private async onDefaultBranch(root: string, branch: string): Promise<boolean> {
    const ref = await this.d.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root, { allowExit: [1, 128] }).catch(() => null)
    const named = ref && ref.code === 0 ? ref.stdout.trim().replace(/^refs\/remotes\/origin\//, '') : null
    if (named) return named === branch
    const r = await this.gh(['repo', 'view', '--json', 'defaultBranchRef'], root, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
    if (!r) return false
    try {
      const parsed = JSON.parse(r.stdout) as { defaultBranchRef?: { name?: unknown } }
      return typeof parsed.defaultBranchRef?.name === 'string' && parsed.defaultBranchRef.name === branch
    } catch {
      return false
    }
  }
}

const stateOf = (v: unknown): PrState => {
  const s = String(v ?? '').toUpperCase()
  return s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open'
}

/** Whether this chat's PR is worth another read: still open, still running, and the chat still in the sidebar. */
export const watchable = (meta: Pick<ChatMeta, 'pr' | 'archivedAt' | 'unarchivedAt'>): boolean =>
  meta.pr !== undefined && prUnfinished(meta.pr) && !isArchived(meta)
