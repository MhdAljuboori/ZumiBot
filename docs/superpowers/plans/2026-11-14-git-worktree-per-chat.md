# Git Worktree per Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each chat's git branch and uncommitted-changes mark in its header. Let a repo's chats and rooms run in their own ZumiBot-made git worktree (remembered per repo), cleaned up on archive and delete without ever losing work.

**Architecture:** A new `core/git/` module wraps `git` (`execFile`, no shell) and a `WorktreeService` creates, inspects, re-adds (`ensure`) and removes (`release`) worktrees. A worktree chat is an ordinary chat whose `cwd` points into the worktree, with `ChatMeta.worktree` recording where it came from. The rest of the server only needs `ensure` awaited before it spawns a CLI. The frontend reads the git state through a new `chats:gitStatus` RPC and the per-repo toggle through `app:gitFolder` / `app:setWorktreeFolder`.

**Tech Stack:** TypeScript, Node ≥ 22 (`node:child_process` `execFile`, `node:fs/promises`), React 19, vitest (node env), the e2e harness in `zumi-bot-server/e2e/`.

**Spec:** `docs/superpowers/specs/2026-11-14-git-worktree-per-chat-design.md`. Read it before each task. It holds the rules, and this plan holds the names.

## Global Constraints

- **No commits.** The user's global rule says never commit unless explicitly told, so tasks end at "tests pass", with no commit step.
- **No new dependencies.** Use `node:child_process` `execFile` with no shell. Every argument goes through the args array, never through string interpolation.
- **Never pass `--force`** to `git worktree remove`. **Never delete a branch.** Never edit the source checkout's `.gitignore` or `info/exclude`.
- **Error text never carries env values.** A git error message is the first line of git's stderr, trimmed.
- **A new RPC touches three places:** `ZumiBotApi` in `shared/src/types.ts`, the handler in `backend/src/rpc/handlers.ts`, and the mapping in `frontend/src/net/api.ts`.
- **Comments are short and say *why*,** as in the rest of the repo.
- **Branch prefix** is `zumibot/`. **Folder** is `<parent of repo top>/<repo basename>-<slug>`. **Slug** is `<handle>-<6 hex>`, or `room-<6 hex>` for a room.
- **Cache segments** that release may discard: `node_modules`, `.angular`, `dist`, `out`, `build`, `coverage`, `.cache`, `.turbo`, `.next`, `.vite`, `tmp`, plus files ending `.log`.
- **Copy, verbatim from the spec:**
  - `Not a git repository: <folder name>`
  - `Isolate in worktree — runs on its own branch next to the repo`
  - `Not a git repository` (the disabled toggle's tooltip)
  - `<n> uncommitted changes` / `1 uncommitted change` / `No uncommitted changes` / `Worktree: <root>`
  - `Its worktree folder was removed. Branch <branch> is kept.`
  - `Its worktree was kept: <reason>.`, where the reason is `uncommitted changes`, `ignored files that would be lost`, `detached HEAD` or `another chat uses it`
  - `Branch <branch> was gone, so it was made again from <source folder>'s current HEAD.`
  - `Branch <branch> is checked out in <path>. Switch that checkout to another branch, then send again.`
- **Run tests from the worktree root** (`/home/mhdaljuboori/Developments/AI/ZumiBot/.claude/worktrees/git-worktree-per-chat-220544`). Task 0 sets up its build links first.

## Review Focus

1. **Repo path with spaces** (`~/code/my repo`). Create, status, ensure and release must all work. Pinned in Task 2.
2. **`git` not installed or not on PATH.** The chip hides (status `null`), `app:gitFolder` reports `repo: false`, and create refuses with `git not found`. Pinned in Tasks 2 and 5.
3. **Name collision.** The sibling folder or `zumibot/<slug>` branch already exists (a leftover from an earlier chat), so a new suffix is drawn. After 5 failed tries it refuses. Pinned in Task 2.
4. **Two room members, or a member and the moderator, starting together** on a removed worktree. They must add it once, not race into `already exists`. Pinned in Task 3.
5. **Agent handles with odd characters** (`Frontend Dev!`, `ux_ui`, `--x--`). The slug must stay a valid branch and folder name. Pinned in Task 1.

---

### Task 0: Worktree build links (setup, no product code)

This worktree has no `node_modules`, so `npm test` and `npm run typecheck` fail until links exist. The user's own memory note says so.

- [ ] **Step 1: Create the links.** Run from the worktree root. `<main>` is `/home/mhdaljuboori/Developments/AI/ZumiBot`.

```bash
mkdir -p node_modules/@zumibot && for p in backend frontend shared; do ln -sfn ../../zumi-bot-server/$p node_modules/@zumibot/$p; done
for p in frontend backend; do ln -sfn /home/mhdaljuboori/Developments/AI/ZumiBot/zumi-bot-server/$p/node_modules zumi-bot-server/$p/node_modules; done
```

Everything else resolves by walking up into the main checkout's `node_modules`, since this worktree sits inside it.

- [ ] **Step 2: Check the baseline.** Run `npm run typecheck && npm test`. Expected: PASS. The known worktree flake in `backend/tests/app.test.ts` ("a fresh side base…") may time out. Rerun it once, and don't treat it as a regression.

---

### Task 1: Shared types and pure helpers

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (add types next to `ChatMeta`, add the `worktree` field to `ChatMeta`, add `'worktree'` to `NoticeKind`)
- Create: `zumi-bot-server/shared/src/worktree.ts`
- Test: `zumi-bot-server/shared/tests/worktree.test.ts`

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  export type WorktreeKeep = 'dirty' | 'ignored' | 'detached' | 'shared'
  export interface ChatWorktree { root: string; branch: string; source: string; folder: string; links: string[]; removed?: true; kept?: WorktreeKeep }
  export interface GitStatus { branch: string | null; head: string; changed: number; removed?: true }
  // ChatMeta: worktree?: ChatWorktree   (doc comment as in the spec's Data section; kept = why the last release skipped)
  ```
- Produces, in `worktree.ts`. These are pure, use string paths with `/` only, and import no `node:` modules, since the frontend imports this file too:
  - `WORKTREE_BRANCH_PREFIX = 'zumibot/'`
  - `worktreeSlug(base: string, hex: string): string`: lowercase, every run of characters outside `[a-z0-9]` becomes one `-`, leading and trailing `-` are trimmed, an empty base becomes `chat`, and the result is `${base}-${hex}`
  - `worktreeBranch(slug: string): string`
  - `worktreePath(top: string, slug: string): string`: the sibling folder `<dirname(top)>/<basename(top)>-<slug>`
  - `interface StatusV2 { oid: string; head: string | null; changed: string[]; ignored: string[] }`
  - `parseStatusV2(text: string): StatusV2`: parses `git status --porcelain=v2 --branch` output. `# branch.oid` gives `oid`. `# branch.head` gives `head`, or `null` for `(detached)`. Lines `1 `/`2 `/`u ` give the path (the last field; for `2 ` the part before the TAB). `? path` goes to changed, `! path` goes to ignored
  - `isLinkPath(path: string, links: readonly string[]): boolean`: true when `path`, with any trailing `/` stripped, equals a link
  - `isCachePath(path: string): boolean`: true when any segment is one of the cache segments, or the path ends in `.log`
  - `gitStatusOf(s: StatusV2, links: readonly string[]): GitStatus`: `head` is the first 7 characters of `oid`, and `changed` leaves links out
  - `releaseBlock(s: StatusV2, links: readonly string[]): WorktreeKeep | null`, in this order: `detached` when `head === null`, then `dirty` when changed has a non-link path, then `ignored` when ignored has a path that is neither a link nor a cache, otherwise `null`
  - `sidebarFolder(c: { cwd: string; worktree?: ChatWorktree }): string`: `c.worktree?.folder ?? c.cwd`

- [ ] **Step 1: Write the failing tests** in `shared/tests/worktree.test.ts`:

```ts
it('slugs odd handles', () => {
  expect(worktreeSlug('Frontend Dev!', 'a1b2c3')).toBe('frontend-dev-a1b2c3')
  expect(worktreeSlug('ux_ui', 'a1b2c3')).toBe('ux-ui-a1b2c3')
  expect(worktreeSlug('--x--', 'a1b2c3')).toBe('x-a1b2c3')
  expect(worktreeSlug('!!!', 'a1b2c3')).toBe('chat-a1b2c3')
})
it('names branch and sibling folder', () => {
  expect(worktreeBranch('room-a1b2c3')).toBe('zumibot/room-a1b2c3')
  expect(worktreePath('/home/u/Angular/WebFrontend', 'fd-a1b2c3')).toBe('/home/u/Angular/WebFrontend-fd-a1b2c3')
  expect(worktreePath('/home/u/my repo/', 'x-000000')).toBe('/home/u/my repo-x-000000')
})
it('parses porcelain v2', () => {
  const s = parseStatusV2('# branch.oid 0123456789abcdef\n# branch.head main\n1 .M N... 100644 100644 100644 a b src/a.ts\n2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts\n? angular/node_modules\n? notes.md\n! dist/\n! docs/superpowers/specs/x.md\n')
  expect(s).toEqual({ oid: '0123456789abcdef', head: 'main', changed: ['src/a.ts', 'new.ts', 'angular/node_modules', 'notes.md'], ignored: ['dist/', 'docs/superpowers/specs/x.md'] })
  expect(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n').head).toBeNull()
})
it('counts changes without links', () => {
  const s = parseStatusV2('# branch.oid 0123456789abcdef\n# branch.head main\n? angular/node_modules\n')
  expect(gitStatusOf(s, ['angular/node_modules'])).toEqual({ branch: 'main', head: '0123456', changed: 0 })
})
it('blocks release in order', () => {
  const p = (t: string) => parseStatusV2('# branch.oid 0123456789abcdef\n' + t)
  expect(releaseBlock(p('# branch.head (detached)\n'), [])).toBe('detached')
  expect(releaseBlock(p('# branch.head b\n? a.ts\n'), [])).toBe('dirty')
  expect(releaseBlock(p('# branch.head b\n! docs/superpowers/plans/p.md\n'), [])).toBe('ignored')
  expect(releaseBlock(p('# branch.head b\n! angular/node_modules\n! dist/\n! .angular/cache/\n! debug.log\n'), ['angular/node_modules'])).toBeNull()
})
it('groups by picked folder', () => {
  expect(sidebarFolder({ cwd: '/r-x/angular', worktree: { root: '/r-x', branch: 'b', source: '/r', folder: '/r/angular', links: [] } })).toBe('/r/angular')
  expect(sidebarFolder({ cwd: '/r' })).toBe('/r')
})
```

- [ ] **Step 2: Run it and see it fail.** Run `npx vitest run zumi-bot-server/shared/tests/worktree.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the types in `types.ts` and the helpers in `worktree.ts`, with the signatures above.
- [ ] **Step 4: Run it and see it pass.** Same command, then `npm run typecheck`. Expected: PASS. `NoticeKind` gaining `'worktree'` must not break any exhaustive switch. If one exists, render it like `'fresh'`.

---

### Task 2: Git runner and WorktreeService create/status

**Files:**
- Create: `zumi-bot-server/backend/src/core/git/git.ts`, `zumi-bot-server/backend/src/core/git/worktrees.ts`, `zumi-bot-server/backend/src/core/git/CLAUDE.md` (pointer: "Worktrees and the git chip: see docs/architecture/worktrees.md")
- Test: `zumi-bot-server/backend/tests/core/git/worktrees.test.ts`. Use real temp repos via `mkdtemp`. Each test runs `git init -b main`, sets `user.email`/`user.name` locally and makes one commit. Pass `GIT_CONFIG_GLOBAL=/dev/null` in the env so the user's config can't leak in.

**Interfaces:**
- Consumes: Task 1 helpers and types.
- Produces, in `git.ts`:
  ```ts
  export class GitError extends Error {}
  export interface GitResult { stdout: string; code: number }
  export type Git = (args: string[], cwd: string, o?: { timeoutMs?: number; allowExit?: number[] }) => Promise<GitResult>
  export function makeGit(env: () => NodeJS.ProcessEnv): Git
  ```
  - The default timeout is 30 000 ms, and `maxBuffer` is 16 MB.
  - A non-zero exit that isn't in `allowExit` rejects with a `GitError` whose message is git's first stderr line.
  - `ENOENT` rejects with `GitError('git not found')`.
- Produces, in `worktrees.ts`:
  ```ts
  export interface WorktreeDeps {
    git: Git
    store: Pick<ChatStore, 'list' | 'patchInPlace'>
    push(meta: ChatMeta): void
    hex(): string // 6 lowercase hex
    log(msg: string): void
  }
  export class WorktreeService {
    constructor(d: WorktreeDeps)
    topOf(dir: string): Promise<string | null>              // rev-parse --show-toplevel; null on any GitError
    create(picked: string, slugBase: string): Promise<{ cwd: string; worktree: ChatWorktree }>
    status(meta: ChatMeta): Promise<GitStatus | null>
  }
  ```
- `create`:
  - Throws `Not a git repository: <basename>` when `topOf` is null.
  - Makes up to 5 tries. Each draws a slug and skips it when the folder exists or `git rev-parse --verify --quiet refs/heads/<branch>` succeeds. After that it runs `git worktree add -b <branch> <root> HEAD` in `picked`.
  - After 5 collisions it throws `Could not find a free worktree name`.
  - On a git failure it removes `root` (it didn't exist before) and rethrows.
  - Then it links `node_modules` (private `link(source, root): Promise<string[]>`, following the spec's three conditions; `git check-ignore -q <rel>` runs in `root` with `allowExit: [0, 1]`, after making the link, and a link git doesn't ignore is removed).
  - `cwd` is `root` plus the picked folder's path relative to `top`.
  - `worktree` is `{ root, branch, source: top, folder: picked, links }`.
- `status`:
  - Returns `{ branch: meta.worktree.branch, head: '', changed: 0, removed: true }` when `worktree?.removed` is set, without running git.
  - Otherwise runs `git status --porcelain=v2 --branch --untracked-files=normal` in `meta.cwd` with a 5 000 ms timeout and returns `gitStatusOf(parseStatusV2(out), meta.worktree?.links ?? [])`.
  - Any `GitError` returns `null`.

- [ ] **Step 1: Write the failing tests:**
  - `create makes a sibling worktree on a new branch from HEAD`: `root` equals `worktreePath(top, slug)`, the folder exists, `git branch --list zumibot/*` shows it, and `git -C root rev-parse HEAD` equals the source's HEAD.
  - `create in a subfolder starts the chat in the same subfolder`: pick `<repo>/angular`, and expect `cwd === root + '/angular'` and `worktree.folder === '<repo>/angular'`.
  - `links an ignored node_modules and skips the rest`: the source has `angular/.gitignore` with `/node_modules`, plus `angular/node_modules/x`, root `node_modules/` with a root `.gitignore` of `node_modules/`, and `pkg/package.json` with `{"workspaces":[]}` beside `pkg/node_modules`. Expect `links` to equal `['angular/node_modules']`, `lstat(root/angular/node_modules).isSymbolicLink()` to be true, and `root/node_modules` and `root/pkg/node_modules` to be absent.
  - `create refuses a non-repo`: rejects `Not a git repository: plain`.
  - `create redraws on a name collision`: the `hex` stub returns `'aaaaaa'`, then `'aaaaaa'`, then `'bbbbbb'`. The first call takes `aaaaaa`, and the second gets `bbbbbb`. With an always-`'aaaaaa'` stub, the third call rejects `Could not find a free worktree name`.
  - `works in a repo path with spaces`: the repo is at `<tmp>/my repo`. Create, then status, both succeed.
  - `status counts changes without links and reports the branch`: write `notes.md` in the worktree, then expect `{ branch: 'zumibot/…', changed: 1 }`.
  - `status returns null outside git and when git is missing`: a non-repo `cwd` gives `null`. A `git` stub rejecting with `GitError('git not found')` gives `null`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run zumi-bot-server/backend/tests/core/git/worktrees.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `makeGit` and `WorktreeService.topOf/create/status`.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.

---

### Task 3: WorktreeService ensure and release

**Files:**
- Modify: `zumi-bot-server/backend/src/core/git/worktrees.ts`
- Test: `zumi-bot-server/backend/tests/core/git/worktrees.test.ts` (the same file). Use a real `ChatStore` on a temp data dir, as other store-backed tests do.

**Interfaces:**
- Consumes: Task 2.
- Produces:
  ```ts
  ensure(meta: ChatMeta): Promise<string | null> // null = nothing to say; a string = notice text for the turn; throws Error(message for the error item)
  ensureChat(chatId: string): Promise<string | null> // loads the meta from the store, then ensure; null when the chat is gone
  release(chat: ChatMeta, o: { deleted: boolean }): Promise<void>
  ```
- `ensure`:
  - Does nothing when there's no `worktree`, or when `removed` isn't set and `root` exists.
  - Keeps one in-flight promise per `root`, so concurrent calls share it.
  - Runs in `source`:
    - First `git worktree prune`.
    - If `refs/heads/<branch>` exists, it runs `worktree add <root> <branch>`. Stderr containing `already checked out at '<p>'` or `already used by worktree at '<p>'` becomes the spec's "checked out in" message, naming `<p>`.
    - Else, if `refs/remotes/origin/<branch>` exists, it runs `worktree add --track -b <branch> <root> origin/<branch>`.
    - Else it runs `worktree add -b <branch> <root> HEAD` and returns the "was gone" notice, with `<source folder>` being `basename(source)`.
  - A failing `topOf(source)` throws `Can't rebuild the worktree: <source> is not a git repository on this machine.`
  - Then it relinks, and patches every chat whose `worktree.root` equals this one to `{ ...worktree, links, removed: undefined, kept: undefined }` through `patchInPlace`, pushing each one.
- `release`:
  - Follows the spec's Cleanup steps 1–8, in order.
  - "Other chats" are the `store.list()` entries with the same `root`, a different `id`, no `asked`, and not `isArchived`.
  - Each skip patches this chat's `worktree.kept` (unless `deleted`) and pushes it.
  - A branch change patches `branch` on every sharer.
  - Before `git worktree remove <root>` (no `--force`, run in `source`), it unlinks each link only if `lstat` says it's a symlink.
  - If `root` is already gone, it runs `git worktree prune` and marks the chats removed.
  - Every error is logged and never thrown.

- [ ] **Step 1: Write the failing tests:**
  - `release removes a clean worktree and keeps the branch`: the folder is gone, the branch still exists, and the stored chat has `worktree.removed === true`.
  - `release keeps a dirty worktree`: an untracked `a.ts` gives a folder that still exists and `kept === 'dirty'`.
  - `release keeps ignored work`: with `docs/plans/` ignored and holding `p.md`, `kept === 'ignored'`. With only `dist/x.js` ignored and the link present, it is removed, and the link target in the source still exists.
  - `release keeps a detached HEAD`: after `git -C root checkout --detach`, `kept === 'detached'`.
  - `release follows a switched branch`: after `git -C root switch -c feature/x`, release removes the folder and stores `branch === 'feature/x'`. A later `ensure` checks out `feature/x`.
  - `release keeps a worktree another live chat uses, but not an asked one`: a second chat with the same `worktree` gives `kept === 'shared'`. When the second chat has `asked` set, the folder is removed, and both chats are marked `removed`.
  - `ensure re-adds a removed worktree from its branch`: after release, `ensure` returns `null`, the folder exists on the stored branch, the links are back, and `removed` is cleared.
  - `ensure after a manual delete`: `rm -rf root` without `removed`, then `ensure` re-adds it.
  - `ensure remakes a deleted branch with a notice`: `git branch -D` the branch after release, and `ensure` returns `Branch zumibot/… was gone, so it was made again from <repo>'s current HEAD.`
  - `ensure refuses when the branch is checked out elsewhere`: check out the branch in the source, and `ensure` rejects with `Branch zumibot/… is checked out in <source>. Switch that checkout to another branch, then send again.`
  - `concurrent ensures add once`: `Promise.all([ensure(m), ensure(m)])` resolves with no error, and a spy on `git` counts `worktree add` exactly once.
  - `ensure on a machine without the repo`: with `source` set to a non-repo dir, it rejects with `Can't rebuild the worktree: …`.
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** `ensure`, `ensureChat` and `release`.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.

---

### Task 4: Store, settings and the chats that copy a worktree

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`AppSettings.worktreeFolders: string[]`)
- Modify: `zumi-bot-server/backend/src/core/store/settingsStore.ts` (defaults `[]`; read keeps only strings; new methods)
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts` (`create`/`createGroup` take `worktree`)
- Modify: `zumi-bot-server/backend/src/core/chat/fork.ts`, `zumi-bot-server/backend/src/core/chat/roomClone.ts`, `zumi-bot-server/backend/src/core/asks/askService.ts`
- Test: the existing `backend/tests/core/store/settingsStore.test.ts`, `chatStore.test.ts`, `backend/tests/core/chat/fork.test.ts`, `roomClone.test.ts`, the askService test, and `backend/tests/core/workflows/workflowRooms*.test.ts`. Add cases to each. Find the exact files with `ls backend/tests/core/**`.

**Interfaces:**
- Produces:
  ```ts
  SettingsStore.worktreeOn(top: string): Promise<boolean>
  SettingsStore.setWorktreeFolder(top: string, on: boolean): Promise<void> // add once / remove
  ChatStore.create(agentName, cwd, extra?: { title?: string; voice?: true; worktree?: ChatWorktree })
  ChatStore.createGroup(members, cwd, role?, extra?: { worktree?: ChatWorktree })
  cloneRoom(d, chatId, title, handoff, o?: { keepWorktree?: boolean }) // default false
  ```
- Fork's patch copies `src.worktree` when it's set.
- Without `keepWorktree`, `cloneRoom` makes the room in `src.worktree?.folder ?? src.cwd` with no `worktree` field. With it, the room gets `src.cwd` and `src.worktree`.
- `askService.findOrMake`'s update patch adds `worktree: source.worktree` when it's set.

- [ ] **Step 1: Write the failing tests:**
  - `worktreeFolders round-trips and ignores junk`: an on/off pair works, and a stored `[1, 'x']` reads back as `['x']`.
  - `create and createGroup store the worktree`.
  - `fork copies the worktree`.
  - `Clone room keeps the worktree only when asked`: with `keepWorktree: true`, the copy has the same `cwd` and `worktree`. Without it, `cwd === worktree.folder` and there's no field.
  - `a workflow Room step copy of a worktree room runs in the picked folder`: through `workflowRooms`' `copyRoom`.
  - `an ask from a worktree chat copies the worktree`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --project backend -t "worktree"`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run them and see them pass.** Run the same command, then `npm run typecheck`. Expected: PASS.

---

### Task 5: RPC handlers, API and wiring in app.ts

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.chats.gitStatus`, `app.gitFolder`, `app.setWorktreeFolder`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`HandlerDeps.worktrees?: WorktreeService`; the handlers below)
- Modify: `zumi-bot-server/frontend/src/net/api.ts` (three mappings)
- Modify: `zumi-bot-server/backend/src/app.ts` (build `WorktreeService` with `makeGit(() => runEnv.env())`, after `runEnv.ready()`, as other env users do; `hex: () => randomBytes(3).toString('hex')`; `push: meta => push({ chatId: meta.id, kind: 'meta', meta })`; pass it to the handlers)
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces, as RPC methods:
  - `chats:gitStatus(chatId) → GitStatus | null`
  - `app:gitFolder(cwd) → { repo: boolean; worktree: boolean }`
  - `app:setWorktreeFolder(cwd, on) → void`
- Handler behavior:
  - **`chats:create`**: a built-in agent is unchanged. Otherwise, `top = await d.worktrees?.topOf(dir)`. When `top` is set and `settings.worktreeOn(top)` is true, it calls `create(dir, name)` and stores `chats.create(name, w.cwd, { worktree: w.worktree })`. `setLastFolder(name, dir)` always stores the picked folder.
  - **`chats:createGroup`**: the same, with slug base `'room'`.
  - **`chats:gitStatus`**: an unknown chat throws `Chat not found: <id>`. Without the dep it returns `null`.
  - **`app:gitFolder`**: without the dep it returns `{ repo: false, worktree: false }`.
  - **`app:setWorktreeFolder`**: a non-repo throws `Not a git repository: <basename>`. Otherwise it saves the setting for `top`.
  - **`chats:archive`**: after the push, when `want && meta.worktree`, it calls `void d.worktrees?.release(meta, { deleted: false })`.
  - **`chats:remove`**: reads the meta before `chats.remove`, then afterwards calls `void d.worktrees?.release(meta, { deleted: true })` when it has a `worktree`.
  - **`chats:cloneRoom`**: passes `{ keepWorktree: true }`.

- [ ] **Step 1: Write the failing tests** in `handlers.test.ts`, using a fake `worktrees` with `vi.fn()` methods:
  - `chats:create isolates only when the repo's toggle is on`: with the toggle off, `create` isn't called. With it on, the stored chat has `cwd` equal to the fake's `cwd`, its `worktree` is set, and `lastFolderByAgent[name]` equals the picked folder.
  - `chats:create for the built-in agent never isolates`.
  - `chats:createGroup isolates with slug base room`.
  - `app:gitFolder and app:setWorktreeFolder`: a non-repo gives `{repo:false, worktree:false}`, and setting it rejects `Not a git repository: x`. A repo set on reads back `{repo:true, worktree:true}`.
  - `archive releases a worktree chat, remove releases with deleted`: `release` is called with `({...}, { deleted: false })`, then `({...}, { deleted: true })`.
  - `chats:gitStatus returns the service's answer, null without the dep`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run zumi-bot-server/backend/tests/rpc/handlers.test.ts -t "worktree|gitStatus|gitFolder"`. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers, API types and mappings, and the `app.ts` wiring.
- [ ] **Step 4: Run them and see them pass.** Run the same command, then `npm run typecheck`. Expected: PASS.

---

### Task 6: Ensure before every spawn

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`:
  - `ChatServiceDeps.ensureFolder?(chatId: string): Promise<string | null>`
  - In `agentTurn`, call it right before `const meta = await store.get(chatId)` (around line 2267). A non-null result adds a notice item (`kind: 'worktree'`) through the turn's existing `add`. A throw must end the turn the way a `spawnError` does, as an error item with the thrown message and `inFlight` false.
  - Call it at the start of `compactTurn` too.
- Modify: `zumi-bot-server/backend/src/app.ts`:
  - Pass `ensureFolder: id => worktrees.ensureChat(id)` to `ChatService`. `GroupService` member turns go through `chats.agentTurn`, so they're covered.
  - Await `worktrees.ensureChat(chatId)` in the `moderate` dep before spawning, and in `baseFor` and `codexSideBase` before they read `meta.cwd`. In the side bases, a throw returns `null` or rejects as those builders already do on failure.
- Modify: `zumi-bot-server/backend/src/core/chat/roomSummary.ts` (`RoomSummariesDeps.ensureFolder?(chatId: string): Promise<unknown>`, awaited at the top of `run`)
- Test: `zumi-bot-server/backend/tests/core/chat/chatService.test.ts` (fake claude, as the file already does)

**Interfaces:**
- Consumes: `WorktreeService.ensureChat` (Task 3).

- [ ] **Step 1: Write the failing tests:**
  - `a turn awaits ensureFolder before spawning`: the fake records its call order, and the fake runner's spawn comes after it.
  - `ensureFolder's notice becomes a worktree notice item before the reply`.
  - `a throwing ensureFolder ends the turn with that error text`: the last item is `{ type: 'error', text: 'Branch x is checked out in /p. Switch that checkout to another branch, then send again.' }` and the chat isn't `inFlight`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run zumi-bot-server/backend/tests/core/chat/chatService.test.ts -t ensureFolder`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then run `grep -n "meta.cwd\|\.cwd," zumi-bot-server/backend/src -r` and confirm that every spawn site reading a chat's `cwd` is behind `ensureFolder`/`ensureChat`. Note any site you leave out, and why, in `docs/architecture/worktrees.md` (Task 9).
- [ ] **Step 4: Run them and see them pass.** Run the same command, then `npm test --workspace zumi-bot-server/backend` (or `npx vitest run --project backend`). Expected: PASS.

---

### Task 7: Frontend state: chip view, refetch rule, sidebar and reuse

**Files:**
- Create: `zumi-bot-server/frontend/src/state/gitStatus.ts`
- Modify: `zumi-bot-server/frontend/src/state/sidebarTree.ts` (`groupByFolder` and `groupRows` key on `sidebarFolder`; `reusableChat` gains `worktree: boolean`)
- Modify: `zumi-bot-server/frontend/src/state/newChat.ts` (`recentFolders` uses `sidebarFolder`, so worktree paths never show as recent folders)
- Test: `zumi-bot-server/frontend/tests/gitStatus.test.ts`, plus cases in the existing `sidebarTree` and `newChat` tests

**Interfaces:**
- Produces:
  ```ts
  export interface GitChipView { label: string; dirty: boolean; muted: boolean; title: string }
  export function gitChipView(s: GitStatus, worktree?: ChatWorktree): GitChipView
  export function shouldRefetchGit(prev: { chatId: string; inFlight: boolean } | null, next: { chatId: string; inFlight: boolean }): boolean
  export function worktreeArchiveLine(w: ChatWorktree | undefined): string | null
  export function reusableChat(chats, agentName, cwd, worktree: boolean): ChatMeta | undefined
  ```
- `gitChipView`:
  - `label` is `branch ?? head`.
  - `title` joins these lines: the change count copy, then `Worktree: <root>` when there's a worktree. A removed one reads `Worktree folder removed. Branch <branch> is kept.` instead of the count.
  - `muted` is `removed === true`.
- `shouldRefetchGit` is true when `chatId` changed, or when `prev.inFlight && !next.inFlight`.
- `worktreeArchiveLine` gives the removed line when `removed`, the kept line when `kept`, and `null` otherwise.

- [ ] **Step 1: Write the failing tests:**
  - `chip copy`: `changed: 3` gives `title` starting `3 uncommitted changes` and `dirty` true. `changed: 1` gives `1 uncommitted change`. `0` gives `No uncommitted changes`. A detached status shows `head`. A worktree adds the `Worktree: /r-x` line.
  - `refetch rule`: `(null, a)` is true. The same chat running is false. Running then idle is true. Another chat is true.
  - `archive line`: removed gives `Its worktree folder was removed. Branch zumibot/x is kept.` Kept `ignored` gives `Its worktree was kept: ignored files that would be lost.` No worktree gives `null`.
  - `worktree chats group under the picked folder`.
  - `reusableChat only reuses the matching kind`: an empty plain chat and an empty worktree chat both in `/r`. `worktree: true` picks the worktree one, and `false` picks the plain one.
  - `recent folders never list a worktree path`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --project frontend -t "chip|refetch|archive line|worktree|recent folders"`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions and changes above.
- [ ] **Step 4: Run them and see them pass.** Run the same command, then `npm run typecheck`. Expected: PASS. Any other caller of `reusableChat` must be updated.

---

### Task 8: Frontend UI: chip, toggle, sidebar mark, archive note, newChat flow

**Files:**
- Create: `zumi-bot-server/frontend/src/useGitStatus.ts`: `useGitStatus(chat: ChatMeta | null): GitStatus | null`. It refetches via `api.chats.gitStatus` when `shouldRefetchGit` says so, and on `window` `focus`. Errors give `null`, and a stale reply for an earlier chat is dropped.
- Create: `zumi-bot-server/frontend/src/components/GitChip.tsx`: a disabled `picker set` button with `data-testid="chat-git"` holding a branch icon, the label, and `●` (`data-testid="chat-git-dirty"`) when dirty. It is muted when the view says so, and renders nothing for `null`.
- Modify: `zumi-bot-server/frontend/src/components/ChatView.tsx`:
  - In both pickers rows (the room one around line 213, the single one around line 541), add `<GitChip>` right after the folder chip.
  - The folder chip label is `folderName(chat.worktree?.folder ?? chat.cwd)`. Its title is the picked folder, plus `\nWorktree: <cwd>` when there's a worktree.
  - The archived note adds `worktreeArchiveLine(chat.worktree)` as a second line (`data-testid="archived-worktree"`).
- Modify: `zumi-bot-server/frontend/src/components/NewChatView.tsx`:
  - New props: `git: { repo: boolean; worktree: boolean } | null` and `onToggleWorktree(on: boolean): void`.
  - After "Choose folder…" in the folder menu (only when a folder is set and the agent isn't built-in), add a separator and a checkbox `menuitemcheckbox` row, `data-testid="new-chat-worktree"`, labelled with the verbatim toggle copy.
  - It's disabled with the title `Not a git repository` when `!git?.repo`.
  - The folder chip shows a small branch mark (`data-testid="new-chat-folder-worktree"`) when `git?.worktree`.
- Modify: `zumi-bot-server/frontend/src/App.tsx`:
  - Hold `newGit` state, refreshed with `api.app.gitFolder(draft.cwd)` whenever `newDraft.cwd` changes. Errors give `null`.
  - `onToggleWorktree` calls `api.app.setWorktreeFolder(cwd, on)`, then refreshes `newGit` and reports errors.
  - In `newChat`, before `reusableChat`, read `api.app.gitFolder(cwd)` for non-built-in agents (an error counts as `false`), and pass `.worktree`.
- Modify: `zumi-bot-server/frontend/src/components/Sidebar.tsx` (chat rows: a small branch icon, `data-testid="chat-row-branch"`, titled with the branch, when `chat.worktree` is set; room rows show `folderName(row.folder)`, which is already the picked folder after Task 7)
- Modify: `zumi-bot-server/frontend/src/styles.css` (muted chip, dirty dot, toggle row, using existing tokens only)

**Interfaces:**
- Consumes: Task 5 API methods and Task 7 helpers.

- [ ] **Step 1: Build and check by hand.** There are no component tests in this repo (frontend tests are node-only). Run `npm run typecheck && npm run build:server`. Expected: PASS.
- [ ] **Step 2: Covered by Task 9's e2e.** Every `data-testid` named above is used there.

---

### Task 9: E2E suite and docs

**Files:**
- Create: `zumi-bot-server/e2e/worktrees.e2e.mjs`. Model it on `archive.e2e.mjs`: the fake claude, the harness `start()`, a throwaway HOME and data dir, a 3-minute timeout, and deleting only its own mkdtemp dirs in `finally`.
- Modify: `package.json` (`"e2e:worktrees": "npm run build && node zumi-bot-server/e2e/worktrees.e2e.mjs"`)
- Create: `docs/architecture/worktrees.md`. It is the area doc and covers:
  - the module and service methods, and the `ChatWorktree` fields;
  - the remembered toggle, `worktreeFolders`;
  - create, ensure (with the spawn sites list from Task 6), release and its skip reasons, the link rules, and the chip refetch moments;
  - the copy rules for fork, clone, workflow copies and asks;
  - the design link.
- Modify: `CLAUDE.md` (one index line under "Docs by area": `- [Git worktrees and the git chip](docs/architecture/worktrees.md): core/git/, shared/src/worktree.ts, GitChip.tsx, useGitStatus.ts, state/gitStatus.ts`). It must stay under 16 KB, which `repoDocs.test.ts` checks.
- Modify: `docs/architecture/data.md` (`ChatMeta.worktree`; settings `worktreeFolders`, synced inside `settings.json`, newest wins), `docs/architecture/unread-and-archive.md` (one line: archive and delete call worktree release, see worktrees.md), `docs/architecture/e2e.md` (list `e2e:worktrees`)

E2E steps:
1. Make a temp git repo (`git init -b main`, one commit). Give it `angular/.gitignore` with `/node_modules` and an `angular/node_modules/x` file.
2. Over RPC, call `app:setWorktreeFolder(repo, true)`, then `chats:create(agent, repo + '/angular')`. Check that `cwd` is under `<repo>-`, the folder exists, `git branch` lists `zumibot/`, and `angular/node_modules` is a symlink.
3. Open the chat. `chat-git` shows `zumibot/…` and `chat-git-dirty` is absent.
4. Write `notes.md` into the worktree, then send a message (the fake turn). After the reply, `chat-git-dirty` is visible.
5. Archive over RPC. The folder still exists, and `archived-worktree` reads `Its worktree was kept: uncommitted changes.`
6. Delete `notes.md`, unarchive, then archive again. The folder is gone, the branch exists, and the note reads the removed line.
7. Send a message, which unarchives. The reply arrives, and the folder exists again.
8. On the new-chat screen, pick the repo folder. `new-chat-worktree` is checked and `new-chat-folder-worktree` is visible. Pick a non-repo temp folder, and the toggle is disabled.

- [ ] **Step 1: Write the suite and register it.**
- [ ] **Step 2: Run it.** Run `npm run e2e:worktrees`. Expected: every step prints ok, and it exits 0.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Full verification.** Run `npm run typecheck && npm test`. Expected: PASS, with `repoDocs.test.ts` included.
- [ ] **Step 5: Clean up.** Kill any Chrome or playwright processes this run left (the user's global rule), and confirm no `<repo>-*` temp folders remain outside the suite's own temp root.
