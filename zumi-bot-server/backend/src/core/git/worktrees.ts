import { lstat, readdir, readFile, realpath, rm, stat, symlink, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { isArchived } from '@zumibot/shared/archive'
import type { ChatMeta, ChatWorktree, GitStatus, WorktreeKeep } from '@zumibot/shared/types'
import { gitStatusOf, parseStatusV2, releaseBlock, worktreeBranch, worktreePath, worktreeSlug } from '@zumibot/shared/worktree'
import type { ChatStore } from '../store/chatStore'
import { agentTreeOf, type ItemsLoader } from './agentTree'
import { GitError, type Git } from './git'

export interface WorktreeDeps {
  git: Git
  store: Pick<ChatStore, 'list' | 'patchInPlace'>
  push(meta: ChatMeta): void
  hex(): string // 6 lowercase hex
  log(msg: string): void
}

const TRIES = 5
const LINK_DEPTH = 3 // folders below the top that may hold a node_modules
const STATUS_TIMEOUT_MS = 5000
const ADD_TIMEOUT_MS = 120_000 // a checkout of a big repo takes a while
const RELEASE_TIMEOUT_MS = 60_000
const REMOVE_TIMEOUT_MS = 600_000 // background work; a kill mid-delete would leave a half-deleted folder

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false
  )

export class WorktreeService {
  // Per-root queue shared by ensure and release: a release must never remove a folder a turn is just starting in.
  private readonly locks = new Map<string, Promise<void>>()
  // A remake notice by root, kept until a turn takes it: a moderator, side question or summary may re-add the folder first.
  // In memory only; a restart loses it, which is fine.
  private readonly pending = new Map<string, string>()

  constructor(private readonly d: WorktreeDeps) {}

  async topOf(dir: string): Promise<string | null> {
    try {
      const { stdout } = await this.d.git(['rev-parse', '--show-toplevel'], dir)
      // Git for Windows prints `C:/x`: resolved to the native `C:\x`, so every path a worktree stores has one form.
      const top = stdout.replace(/\r?\n$/, '')
      return top ? resolve(top) : null
    } catch (e) {
      // Only "not a repo" means plain chat; a timeout or a missing git must not silently drop the isolation.
      if (e instanceof GitError && (e.message === 'Folder not found' || /not a git repository|must be run in a work tree/i.test(e.message)))
        return null
      throw e
    }
  }

  /** `at`: the commit to start the branch at, so several attempts of one card share a base; the default is the picked folder's HEAD. */
  async create(picked: string, slugBase: string, o: { at?: string } = {}): Promise<{ cwd: string; worktree: ChatWorktree }> {
    const top = await this.topOf(picked)
    if (!top) throw new Error(`Not a git repository: ${basename(picked)}`)
    const { root, branch } = await this.freeName(top, picked, slugBase)
    // The commit the branch starts at, so the Changes panel can diff "since start" once the agent has committed.
    // A repo with no commit yet has none: the chat simply gets no base diff.
    const base = o.at ?? (await this.headOf(picked))
    try {
      // Run in the picked folder: that is the checkout whose HEAD the chat starts from.
      await this.d.git(['worktree', 'add', '-b', branch, root, base ?? 'HEAD'], picked, { timeoutMs: ADD_TIMEOUT_MS })
    } catch (e) {
      // `root` did not exist before, so whatever is there now is ours. The branch is left alone.
      await rm(root, { recursive: true, force: true }).catch(() => {})
      await this.d.git(['worktree', 'prune'], top).catch(() => {})
      throw e
    }
    const links = await this.link(top, root)
    // The picked folder may be reached through a symlink, `top` never is.
    const sub = relative(top, await realpath(picked).catch(() => picked))
    let cwd = sub && sub !== '..' && !sub.startsWith('../') && !isAbsolute(sub) ? join(root, sub) : root
    // An untracked or ignored subfolder is not in the new checkout.
    if (cwd !== root && !(await exists(cwd))) cwd = root
    return { cwd, worktree: { root, branch, source: top, folder: picked, links, ...(base ? { base } : {}) } }
  }

  /** The full sha of a folder's HEAD, or null when it has none (a repo with no commit yet) or git failed. */
  async headOf(dir: string): Promise<string | null> {
    const r = await this.d.git(['rev-parse', 'HEAD'], dir, { allowExit: [128] }).catch(() => null)
    if (!r || r.code !== 0) return null
    const sha = r.stdout.trim()
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
  }

  /** `items` given: read in the other worktree the agent last worked in, when there is one (see `agentTreeOf`). */
  async status(meta: ChatMeta, items?: ItemsLoader): Promise<GitStatus | null> {
    const wt = meta.worktree
    if (wt?.removed) return { branch: wt.branch, head: '', changed: 0, removed: true }
    try {
      const agent = items ? await agentTreeOf(this.d.git, meta, items) : null
      const { stdout } = await this.d.git(
        ['--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
        agent?.path ?? meta.cwd,
        { timeoutMs: STATUS_TIMEOUT_MS }
      )
      // ZumiBot's links belong to the chat's own worktree only.
      const status = gitStatusOf(parseStatusV2(stdout), agent ? [] : (wt?.links ?? []))
      return agent ? { ...status, agentTree: agent.path } : status
    } catch (e) {
      if (e instanceof GitError) return null
      throw e
    }
  }

  /** Runs `fn` after every earlier job on `root`; a rejection reaches only its own caller, and an idle root leaves no entry. */
  private locked<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(root) ?? Promise.resolve()).then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(root, tail)
    void tail.then(() => {
      if (this.locks.get(root) === tail) this.locks.delete(root)
    })
    return run
  }

  /**
   * Makes sure a chat's worktree folder exists before a turn. Null = nothing to say; a string = a notice for the turn;
   * throws an Error whose message is the turn's error item. Calls for one root run one after another, so only the
   * first of several concurrent callers rebuilds and a running release finishes first.
   * The notice is returned only to a turn (`forTurn`), once; any other caller gets null and leaves it for the turn.
   */
  async ensure(meta: ChatMeta, o: { forTurn?: boolean } = {}): Promise<string | null> {
    const given = meta.worktree
    if (!given) return null
    return this.locked(given.root, async () => {
      await this.rebuild(meta, given)
      if (!o.forTurn) return null
      const notice = this.pending.get(given.root) ?? null
      this.pending.delete(given.root)
      return notice
    })
  }

  async ensureChat(chatId: string, o: { forTurn?: boolean } = {}): Promise<string | null> {
    const meta = (await this.d.store.list()).find((c) => c.id === chatId)
    return meta ? this.ensure(meta, o) : null
  }

  private async rebuild(meta: ChatMeta, given: ChatWorktree): Promise<void> {
    // The meta may be older than a release or rebuild that ran just before this call.
    const wt = (await this.d.store.list()).find((c) => c.id === meta.id)?.worktree ?? given
    const here = await exists(wt.root)
    if (!wt.removed && here) return
    const { root, branch, source } = wt
    if (!(await this.topOf(source))) throw new Error(`Can't rebuild the worktree: ${source} is not a git repository on this machine.`)
    // A `removed` flag can reach a machine whose folder is live (set elsewhere, then synced): adding over it would fail every turn.
    if (here && (await this.registered(source, root))) {
      const made = await this.link(source, root)
      const kept: string[] = []
      for (const rel of wt.links)
        if (
          await lstat(join(root, rel)).then(
            () => true,
            () => false
          )
        )
          kept.push(rel)
      const links = [...new Set([...kept, ...made])].sort()
      await this.patchRoot(root, null, (w) => ({ ...w, links, removed: undefined, kept: undefined }))
      return
    }
    let notice: string | null = null
    try {
      // Drops the registration of a folder that was deleted by hand.
      await this.d.git(['worktree', 'prune'], source)
      const has = async (ref: string): Promise<boolean> =>
        (await this.d.git(['rev-parse', '--verify', '--quiet', ref], source, { allowExit: [0, 1] })).code === 0
      let add: string[]
      if (await has(`refs/heads/${branch}`)) add = ['worktree', 'add', root, branch]
      else if (await has(`refs/remotes/origin/${branch}`)) add = ['worktree', 'add', '--track', '-b', branch, root, `origin/${branch}`]
      else {
        add = ['worktree', 'add', '-b', branch, root, 'HEAD']
        notice = `Branch ${branch} was gone, so it was made again from ${basename(source)}'s current HEAD.`
      }
      await this.d.git(add, source, { timeoutMs: ADD_TIMEOUT_MS })
    } catch (e) {
      await this.d.git(['worktree', 'prune'], source).catch(() => {})
      const elsewhere = /already (?:checked out at|used by worktree at) '(.+)'/.exec(msg(e))
      if (elsewhere)
        throw new Error(
          `Branch ${branch} is checked out in ${resolve(elsewhere[1]!)}. Switch that checkout to another branch, then send again.`
        )
      throw new Error(`Can't rebuild the worktree for branch ${branch}: ${msg(e)}`)
    }
    const links = await this.link(source, root)
    await this.patchRoot(root, null, (w) => ({ ...w, links, removed: undefined, kept: undefined }))
    if (notice) this.pending.set(root, notice)
  }

  /** Whether `source`'s git lists `root` as one of its worktrees. */
  private async registered(source: string, root: string): Promise<boolean> {
    const { stdout } = await this.d.git(['worktree', 'list', '--porcelain'], source)
    const real = (p: string): Promise<string> => realpath(p).catch(() => p)
    const want = await real(root)
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ') && (await real(line.slice(9))) === want) return true
    }
    return false
  }

  /**
   * Cleanup after an archive or a delete: removes the worktree folder when that loses nothing, and otherwise keeps it
   * and says why. Runs in the background, so it never throws. The branch is never deleted and git is never forced.
   */
  async release(chat: ChatMeta, o: { deleted: boolean }): Promise<void> {
    try {
      if (chat.worktree) await this.locked(chat.worktree.root, () => this.releaseNow(chat, o.deleted))
    } catch (e) {
      this.d.log(`worktree release ${chat.id}: ${msg(e)}`)
    }
  }

  private async releaseNow(chat: ChatMeta, deletedArg: boolean): Promise<void> {
    let deleted = deletedArg
    // Read inside the lock: a turn may have unarchived the chat, or another release may have run, since the caller looked.
    const all = await this.d.store.list()
    const current = all.find((c) => c.id === chat.id)
    // The user sent a message after archiving: the chat needs its folder, so touch nothing, not even `kept`.
    if (!deleted && current && !isArchived(current)) return
    if (!current) deleted = true // gone from the store: nothing of it to patch
    const wt = current?.worktree ?? chat.worktree
    // 1
    if (!wt || wt.removed) return
    const { root, source } = wt
    if (root === source) throw new Error(`worktree root is the source checkout: ${root}`)
    // 2: an asked chat is never archived with the chat that asked, so it must not hold the folder.
    if (all.some((c) => c.id !== chat.id && c.worktree?.root === root && !c.asked && !isArchived(c)))
      return this.keep(chat, deleted, 'shared')
    if (!(await exists(root))) {
      // Already gone (deleted by hand): only git's record is left.
      await this.d.git(['worktree', 'prune'], source)
      return this.markRemoved(root, chat, deleted)
    }
    // 3, 4, 5: one status gives the changes, the ignored entries and the HEAD.
    // --no-optional-locks: a status must not take index.lock from under the agent's own git add or commit.
    const { stdout } = await this.d.git(
      [
        '--no-optional-locks',
        '-c',
        'core.quotePath=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=normal',
        '--ignored=matching'
      ],
      root,
      { timeoutMs: RELEASE_TIMEOUT_MS }
    )
    const s = parseStatusV2(stdout)
    const block = releaseBlock(s, wt.links)
    if (block) return this.keep(chat, deleted, block)
    // 6: the agent may have switched branches; ensure must bring back the one that holds the work.
    if (s.head !== null && s.head !== wt.branch) {
      const head = s.head
      await this.patchRoot(root, deleted ? chat.id : null, (w) => ({ ...w, branch: head }))
    }
    // 7: the links are untracked files, so git would see the folder as dirty with them in.
    await this.unlinkAll(root, wt.links)
    try {
      await this.d.git(['worktree', 'remove', root], source, { timeoutMs: REMOVE_TIMEOUT_MS })
    } catch (e) {
      this.d.log(`worktree remove ${root}: ${msg(e)}`)
      if (await exists(root)) {
        // Still there, maybe partly deleted: put the links back and say so, rather than let the next turn run in it unflagged.
        await this.link(source, root)
        return this.keep(chat, deleted, 'failed')
      }
      // Gone after all: only git's record may be left.
      await this.d.git(['worktree', 'prune'], source).catch(() => {})
    }
    // 8: the branch stays.
    await this.markRemoved(root, chat, deleted)
  }

  /** Removes only what is a symlink, and only inside `root`. */
  private async unlinkAll(root: string, links: readonly string[]): Promise<void> {
    for (const rel of links) {
      if (isAbsolute(rel) || rel.split('/').includes('..')) {
        this.d.log(`worktree link ${rel} ignored: not inside the worktree`)
        continue
      }
      const at = join(root, rel)
      try {
        if ((await lstat(at)).isSymbolicLink()) await unlink(at)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.d.log(`worktree link ${rel} not removed: ${msg(e)}`)
      }
    }
  }

  private async keep(chat: ChatMeta, deleted: boolean, why: WorktreeKeep): Promise<void> {
    if (deleted) {
      // The chat is gone, so nothing else records the folder left behind.
      this.d.log(`worktree kept after delete: ${chat.worktree?.root ?? '?'} (${why})`)
      return
    }
    const next = await this.d.store.patchInPlace(chat.id, (cur) => (cur.worktree ? { worktree: { ...cur.worktree, kept: why } } : null))
    if (next) this.d.push(next)
  }

  /** Every chat with this root, asked and archived ones too; the deleted one is gone, so it is left out. */
  private markRemoved(root: string, chat: ChatMeta, deleted: boolean): Promise<void> {
    // A notice nobody took must not outlive a later clean rebuild.
    this.pending.delete(root)
    return this.patchRoot(root, deleted ? chat.id : null, (w) => ({ ...w, removed: true, kept: undefined }))
  }

  /** Patches the worktree of every chat that shares `root` and pushes each one. */
  private async patchRoot(root: string, skipId: string | null, fn: (w: ChatWorktree) => ChatWorktree): Promise<void> {
    for (const c of await this.d.store.list()) {
      if (c.worktree?.root !== root || c.id === skipId) continue
      const next = await this.d.store.patchInPlace(c.id, (cur) => (cur.worktree?.root === root ? { worktree: fn(cur.worktree) } : null))
      if (next) this.d.push(next)
    }
  }

  private async freeName(top: string, picked: string, slugBase: string): Promise<{ root: string; branch: string }> {
    for (let i = 0; i < TRIES; i++) {
      const slug = worktreeSlug(slugBase, this.d.hex())
      const root = worktreePath(top, slug)
      const branch = worktreeBranch(slug)
      if (await exists(root)) continue
      const taken = await this.d.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], picked, { allowExit: [0, 1] })
      if (taken.code === 0) continue
      return { root, branch }
    }
    throw new Error('Could not find a free worktree name')
  }

  /** Links the source's node_modules into `root` where that is safe; returns the relative paths made. Never throws. */
  async link(source: string, root: string): Promise<string[]> {
    const made: string[] = []
    let found: string[]
    try {
      found = await this.findModules(source)
    } catch (e) {
      this.d.log(`worktree links: ${(e as Error).message}`)
      return made
    }
    for (const rel of found) {
      try {
        if (await this.linkOne(source, root, rel)) made.push(rel)
      } catch (e) {
        this.d.log(`worktree link ${rel} skipped: ${(e as Error).message}`)
      }
    }
    return made
  }

  private async linkOne(source: string, root: string, rel: string): Promise<boolean> {
    const at = join(root, rel)
    const parent = join(at, '..')
    if (!(await exists(parent))) return false
    if (
      await lstat(at).then(
        () => true,
        () => false
      )
    )
      return false
    // A workspace's node_modules holds relative links to its own packages: through our link they would resolve into the source.
    const pkg = await readFile(join(source, rel, '..', 'package.json'), 'utf8').catch(() => null)
    if (pkg !== null) {
      try {
        if ((JSON.parse(pkg) as { workspaces?: unknown }).workspaces !== undefined) return false
      } catch {
        return false
      }
    }
    // A junction on Windows: a symlink there needs admin rights or Developer Mode.
    await symlink(join(source, rel), at, process.platform === 'win32' ? 'junction' : undefined)
    // Checked after linking: a symlink does not match a `node_modules/` pattern, and `git add -A` must never commit it.
    let ignored = false
    try {
      ignored = (await this.d.git(['check-ignore', '-q', '--', rel], root, { allowExit: [0, 1] })).code === 0
    } finally {
      if (!ignored) await rm(at, { force: true })
    }
    return ignored
  }

  /** Relative paths of every node_modules folder up to LINK_DEPTH below `top`, never looking inside one. */
  private async findModules(top: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (rel: string, depth: number): Promise<void> => {
      const entries = await readdir(join(top, rel), { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isDirectory() || e.name === '.git') continue
        const next = rel ? `${rel}/${e.name}` : e.name
        if (e.name === 'node_modules') out.push(next)
        else if (depth < LINK_DEPTH) await walk(next, depth + 1)
      }
    }
    await walk('', 1)
    return out.sort()
  }
}
