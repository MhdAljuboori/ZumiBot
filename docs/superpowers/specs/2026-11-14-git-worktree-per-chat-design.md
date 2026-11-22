# Git worktree per chat: design

Date: 2026-11-14. Built from the user's request and a short talk. What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

## Why

ZumiBot never uses git worktrees and knows nothing about branches. Two chats, or two room members, working in the same repo folder edit the same files and get in each other's way. With several agents working on WebFrontend at once, this is the gap the user hits most **(user)**.

## Goals

1. **Header shows git state (user).** In a chat whose folder is inside a git repo, the header shows the branch and whether there are uncommitted changes. This applies to every chat, worktree or not.
2. **"Isolate in worktree" toggle when creating a chat (user)** and when creating a room. A chat made with it runs in its own git worktree on its own new branch, so it never touches another chat's files.
3. **The toggle is remembered per folder (user).** Once it's on for WebFrontend, every new chat or room started there gets its own worktree until it's turned off. That includes the sidebar shortcuts that skip the new-chat screen: clicking an agent, and "New chat in <folder>".
4. **One room, one worktree (user).** All members of a room share the room's worktree. A room is kept apart from other chats, not its members from each other.
5. **Cleanup on archive (user).** Archiving a worktree chat removes its worktree folder.
6. **Nothing uncommitted is ever lost (user, option A).** A worktree with uncommitted changes is never removed, not on archive and not on delete. It stays until it is clean, or until the user removes it by hand.
7. **The branch is never deleted by ZumiBot.** Removing a worktree keeps its branch, so the work stays in git.
8. **The agent can build and test at once.** A new worktree gets the source checkout's `node_modules` linked in, so the agent doesn't need a long `npm install` before its first build (my call, user said "you choose").

## Non-goals

- One worktree per room member. Members of a room share files **(user)**.
- Merging, pushing, opening PRs or deleting branches. The agent or the user does that, as today.
- Worktrees for chats that routines, workflows, voice requests or agent asks create. They get no toggle. A chat made from a worktree chat (fork, room clone, an ask from it) shares that worktree (see Rules).
- Picking a base branch. The worktree starts from the picked folder's current `HEAD`.
- Setup commands other than linking `node_modules` (no `npm ci`, no Python venv).
- A worktree for the built-in agent (Zumi Bot). It always runs in its own folder and shows no folder picker.
- Live git state while a turn runs. The chip refreshes at set moments (see UI).

## Anti-goals

- Losing uncommitted work in any path: archive, delete, the server restarting, a sync.
- Making the main checkout dirty. ZumiBot never writes inside the source checkout. No `.gitignore` edits and no `info/exclude` edits.
- A turn failing with "Folder not found" because cleanup removed a worktree the chat still needs.

## Approaches

1. **ZumiBot makes the worktree itself (chosen).** A new backend module runs `git worktree add` through `execFile`. The chat's `cwd` becomes the worktree's path, and `ChatMeta.worktree` records where it came from. The runner, `--resume`, the Files panel, fork, Codex agents and side questions all keep working unchanged, since to them it's just a folder.
2. **Pass `--worktree` to `claude`.** The CLI would make the worktree. Dropped: ZumiBot spawns the CLI once per turn, sessions are tied to the folder, room members are separate CLIs, Codex agents get nothing, and cleanup would not be ours.
3. **Tell the agent in its prompt** to make and use its own worktree. Dropped: unreliable, no header state, no cleanup.

The user handed over the how; approach 1 is my pick.

**Dependencies (my call, user said "you choose"):**

- **A. Link `node_modules` from the source checkout (chosen).** Instant, and no extra disk. Risk: an `npm install` run inside the worktree changes the source checkout's packages too, and a branch with a different `package.json` builds against the source's versions.
- **B. Nothing.** Dropped: minutes and gigabytes per chat on WebFrontend.
- **C. A per-folder setup command.** Dropped for now: more UI to build, and the first turn has to wait on it.

## Where things go

- **Folder:** a sibling of the repo's top folder, named `<repo>-<slug>`. For example `~/Developments/Angular/WebFrontend-frontend-dev-a1b2c3`, the same naming as the user's existing `WebFrontend-implement` worktrees.
  - `<repo>` is the base name of the top folder (`git rev-parse --show-toplevel`) of the folder the user picked.
  - `<slug>` is `<agent-handle>-<6 hex>` for a chat, and `room-<6 hex>` for a room. The agent handle is lowercased, and anything outside `[a-z0-9-]` becomes `-`.
  - If the folder or branch already exists, a new 6-hex suffix is drawn (a few tries, then it fails).
- **Branch:** `zumibot/<slug>`, made from the picked folder's `HEAD` (`git worktree add -b zumibot/<slug> <path> HEAD`, run in the picked folder). If the picked folder is itself a linked worktree (for example `WebFrontend-implement`), the new worktree still goes next to that folder's top level and starts from its `HEAD`.
- **Subfolder picks:** if the picked folder is a subfolder of the repo (for example `WebFrontend/angular`), the chat's `cwd` is the same subfolder inside the new worktree (`WebFrontend-frontend-dev-a1b2c3/angular`).
- **`node_modules` links:** after `worktree add`, find every `node_modules` directory in the source top folder up to 3 levels deep, skipping any inside another `node_modules`. WebFrontend's is `angular/node_modules`. A link is made at the same relative path, pointing to the source's absolute path, only when all of these hold:
  - its parent folder exists in the worktree, and nothing is already at that path;
  - `git check-ignore -q <path>`, run in the worktree, says the path is ignored. A symlink doesn't match a trailing-slash pattern like `node_modules/`, and an agent's `git add -A` must never commit a link. WebFrontend's `/node_modules` matches; ZumiBot's own `node_modules/` doesn't, so ZumiBot worktrees get no links;
  - the `package.json` beside it has no `workspaces` field. A workspace's `node_modules` holds relative links to its own packages, and through a link those would resolve into the source checkout, so builds would silently use the source's code.

  A skipped or failed link is logged and never fails the create. Those repos fall back to the agent installing (option B).

## Data

`ChatMeta.worktree?: ChatWorktree`, absent for a plain chat:

```ts
/** The git worktree a chat or room runs in, made by ZumiBot (see worktrees.md). */
export interface ChatWorktree {
  root: string    // the worktree's top folder; the chat's cwd is this or a subfolder of it
  branch: string  // zumibot/<slug>; kept when the folder is removed
  source: string  // the top folder of the checkout it was made from: git commands for re-adding run here, and node_modules links point into it
  folder: string  // the folder the user picked (source or a subfolder): the sidebar groups the chat under it, and reusableChat matches on it
  links: string[] // relative paths of the node_modules links ZumiBot made, ignored by the dirty check
  removed?: true  // the folder was removed by cleanup; the next turn adds it back from the branch
}
```

**Remembered toggle (user):** `AppSettings.worktreeFolders: string[]` holds the top folders of the repos where the toggle is on. It's keyed by the repo's top folder, not the exact folder picked (my call), so picking `WebFrontend` or `WebFrontend/angular` reads the same setting. It's absent or `[]` by default.

No new file in the data dir. Sync carries the field with the meta. `worktreeFolders` lives in `settings.json`, so sync carries it whole, newest wins, the same as `lastFolderByAgent`. A path that isn't a repo on the other machine is simply never matched there. A worktree exists on the machine that made it. If the chat runs on the other machine, "ensure" (below) makes the worktree there when that machine has the same `source` path as a git repo, and otherwise the turn fails with a clear message.

## Behavior

### Create

`chats.create(agentName, cwd)` and `chats.createGroup(members, cwd, role)` keep their signatures. **The server decides** whether to isolate: it isolates when `cwd` is inside a git repo whose top folder is in `worktreeFolders`. The new-chat screen saves the toggle the moment it changes, before the send. So every path that creates through these two RPCs follows the remembered setting with no extra argument: the new-chat screen, clicking an agent, and "New chat in <folder>". Chats made inside the server never go through these handlers: routines, workflows, voice, asks, fork and clone. They follow their own rules (Non-goals, Rules). When isolating:

1. The server checks that the picked folder is inside a git work tree. If not, it refuses: "Not a git repository: <folder name>".
2. It runs `git worktree add`, links `node_modules`, then stores the chat with `cwd` set inside the worktree and `worktree` set.
3. If `git` fails, the error reaches the client as a refusal (git's stderr, first line, trimmed). No chat is made, and a half-made worktree folder is removed.

`settings.setLastFolder` / `setLastGroupFolder` keep storing the folder the user picked, never the worktree path.

### Git status (the chip)

New RPC `chats:gitStatus(chatId) → GitStatus | null`:

```ts
export interface GitStatus {
  branch: string | null // null = detached HEAD
  head: string          // short sha, shown when detached
  changed: number       // uncommitted entries (staged, unstaged, untracked), ZumiBot's links left out
  removed?: true        // a worktree chat whose folder cleanup removed: the chip shows the branch, greyed
}
```

It runs `git status --porcelain=v1 --branch --untracked-files=normal` in the chat's `cwd`, with a short timeout (5 s). It returns `null` when the folder isn't in a git repo or git isn't installed. A removed worktree returns `{ branch, head: '', changed: 0, removed: true }` from the meta, without running git.

### Ensure before a turn

Archive cleanup can remove a folder that a later turn needs, since any turn starting unarchives the chat. So every path that spawns a CLI in a chat's `cwd` first awaits `worktrees.ensure(meta)`:

- If `worktree` is absent, or `removed` is not set and the folder exists, it does nothing.
- Otherwise it runs `git worktree add <root> <branch>` from `source` (no `-b`; the branch exists), relinks `node_modules`, and clears `removed`. If the root still exists but git no longer knows it (the user deleted it by hand), it runs `git worktree prune` first.
- Calls for the same root share one promise, so two room members starting at once add it once.
- A failure becomes the turn's error item, the way "Folder not found" does today. The text names the branch.
- **The branch is gone locally:**
  - If `origin/<branch>` exists, the worktree is added on a new local branch tracking it. This covers a chat moving to the other machine after a push.
  - If it doesn't, the branch is made again from `source`'s `HEAD`, and the turn gets a notice item first: "Branch <branch> was gone, so it was made again from <source folder>'s current HEAD." The chat stays usable, and the notice says plainly that earlier work isn't on it.
- **The branch is checked out somewhere else** (for example the main checkout, for review): the turn fails with "Branch <branch> is checked out in <path>. Switch that checkout to another branch, then send again." Nothing is forced.

The paths that need it are the single chat turn (`ChatService`), a room member's turn and the moderator (`GroupService`), side questions, the room summary, keep-warm pings and compact. The builder confirms the full list by searching for the spots that read `meta.cwd` before spawning. A single helper used at each spot is fine. Putting git calls inside `ChatStore`'s lock is not, since a worktree add can take seconds on WebFrontend.

### Cleanup on archive and on delete

After `chats:archive(id, true)` succeeds, and after `chats:remove(id)`, the server runs `worktrees.release(chat)` in the background, logging errors and never failing the archive or delete:

1. Skip it if the chat has no `worktree`, or it is already `removed`.
2. Skip it if any other chat that isn't archived has the same `worktree.root`. Fork and room clone share the worktree (see Rules), so the folder stays while any of them is live. Asked chats (`ChatMeta.asked` set) don't count: they are never archived along with the chat that asked, so counting them would keep the worktree forever.
3. Skip it if the worktree is dirty, using the same count as the chip, with ZumiBot's links left out **(user, option A)**.
4. Skip it if any ignored file would be lost. `git worktree remove` without `--force` deletes ignored files silently, and agents keep real work in ignored paths: WebFrontend ignores `docs/superpowers/specs/`, `docs/superpowers/plans/` and `.superpowers/`. Run `git status --porcelain --ignored=matching`. Any ignored entry other than ZumiBot's links and a short list of rebuildable caches means "keep". The cache list goes in `shared/src/worktree.ts`: any path segment named `node_modules`, `.angular`, `dist`, `out`, `build`, `coverage`, `.cache`, `.turbo`, `.next`, `.vite`, `tmp`, plus `*.log` files. This check belongs to release only; the chip still counts what git shows as uncommitted.
5. Skip it if `HEAD` is detached. Commits on a detached `HEAD` would be left on no branch.
6. If `HEAD` is on a branch other than the stored one (the agent ran `git switch -c feature/x`), first update `worktree.branch` to the current branch on every chat with that root, so `ensure` brings back the branch that holds the work.
7. Otherwise it removes ZumiBot's links, runs `git worktree remove <root>` (never `--force`), and marks `removed: true` on every chat with that root, asked chats included. On delete the chat is gone, so only the others get marked.
8. The branch is kept.

The reason for a skip (dirty, ignored files, detached, shared) is returned to the client so the archive note can say which one applies.

A dirty worktree that was skipped is not retried later. It stays until the chat is used again and then archived again while clean, or until the user removes it by hand. The archive note says so (see UI).

### Rules

- **Fork and Clone room** copy the source's `worktree` field. The copy shares the folder, as it shares `cwd` today. For Clone room, the copy happens in the `chats:cloneRoom` handler (or an option it passes), not inside `cloneRoom()` itself. `cloneRoom()` is also what a workflow Room step uses to copy its template room.
- **A workflow Room step whose template is a worktree room** gets a plain room in the template's `worktree.source`, plus the same subfolder, and no `worktree` field. Workflow-made chats get no worktree (non-goal). The template's worktree folder may be removed at any time, and unattended runs, possibly several at once, must not share it.
- **An ask from a worktree chat** makes the asked agent's chat with the source's `cwd`, which it does today. It also copies `worktree`, so `ensure` can bring the folder back for it. Release ignores asked chats when counting sharers, and marks them `removed` with the rest (see Cleanup).
- **`reusableChat`** (reopening an empty chat instead of making another) matches a chat on `worktree?.folder ?? cwd`. Clicking an agent twice in a remembered folder reopens its empty worktree chat instead of making a second worktree. An empty chat of the other kind is never reused: a plain chat when the toggle is on, or a worktree chat when it's off. So the client needs the folder's toggle state before it reuses (see `app.gitFolder`).
- **Codex agents** work unchanged. The `cwd` is the worktree.
- **Removing ZumiBot's links** happens only right before `git worktree remove`. Without them, git would never see the folder as clean, since the links are untracked files.

## UI

- **Header chip:** in `ChatView`'s pickers row, right after the folder chip, for single chats and rooms. It shows a branch icon, then the branch name (or the short sha when detached), then `●` when `changed > 0`. The tooltip reads "3 uncommitted changes" or "No uncommitted changes". A worktree chat adds "Worktree: <root>" to it. The chip is hidden when the status is `null`. It is fetched when a chat opens and when the chat's `inFlight` goes from true to false (a turn ended), and refreshed on window focus. Pure state lives in `frontend/src/state/gitStatus.ts` and the component is `GitChip.tsx`. The chip is display-only and not clickable.
  ```
  [Frontend Dev] [Opus] [Auto]  [📁 WebFrontend] [⑂ zumibot/frontend-dev-a1b2c3 ●]
  ```
- **The folder chip** of a worktree chat shows the source folder's name (`WebFrontend`), and its tooltip shows the worktree path.
- **Toggle:** in the new chat folder menu (`NewChatView`), below the folders, there's a checkbox row: "Isolate in worktree — runs on its own branch next to the repo".
  - It is enabled only once the picked folder is in a git repo. When it's disabled, the tooltip reads "Not a git repository".
  - Its state is the remembered setting for that repo, read with `app.gitFolder(cwd)` each time the folder changes. Ticking it saves at once with `app.setWorktreeFolder(cwd, on)`, so it is not draft state.
  - The folder chip shows a small branch mark while it's on, so the user can see it without opening the menu.
  - The same toggle shows for a new room.
  - The built-in agent shows no folder picker, so it gets no toggle.
- **First send** with the toggle on shows the usual "starting" state while the worktree is made. On a refusal the draft stays, as with any send error.
- **Sidebar:** single chats group by `worktree?.folder ?? cwd` instead of `cwd`, so worktree chats sit in the same folder group as plain chats started there. Each worktree chat row gets a small branch mark, with the branch in the tooltip. Room rows show the picked folder's name. "New chat in <folder>" on a folder group passes that picked folder, and the server applies the remembered toggle.
- **Archive note:** when a worktree chat is archived, the existing archived note in `ChatView` adds one line saying what release did:
  - removed: "Its worktree folder was removed. Branch <branch> is kept."
  - kept: "Its worktree was kept: <reason>." The reason is one of "uncommitted changes", "ignored files that would be lost", "detached HEAD" or "another chat uses it".

  Release runs in the background, so the line comes from `worktree.removed` on the pushed meta, plus a `keptBecause` reason stored on the meta. The builder picks the field name.

## API changes (three places each)

- `chats.create` and `chats.createGroup`: signatures unchanged. The server applies `worktreeFolders`.
- `chats.gitStatus(chatId): Promise<GitStatus | null>`.
- `app.gitFolder(cwd): Promise<{ repo: boolean; worktree: boolean }>`: whether the folder is in a git repo, and whether its repo's toggle is on.
- `app.setWorktreeFolder(cwd, on): Promise<void>`: saves the toggle for the folder's repo. It refuses when the folder isn't in a git repo.

Types go in `shared/src/types.ts` (`ChatWorktree`, `GitStatus`). The pure helpers go in `shared/src/worktree.ts`: slug, branch name, sibling path, porcelain parsing, ignoring links, and the sidebar group key.

## Backend layout

- `backend/src/core/git/git.ts`: one `git(args, cwd, timeoutMs)` wrapper over `execFile` (no shell). The env comes from `shellEnv` so `git` is found. Errors carry git's first stderr line and never the env.
- `backend/src/core/git/worktrees.ts`: `WorktreeService` with `isRepo(dir)`, `create(picked, slugBase)`, `status(meta)`, `ensure(meta)`, `release(chat, all)`. It is built in `app.ts` and handed to the handlers and the turn paths.
- `docs/architecture/worktrees.md`: a new area doc, an index line in the root `CLAUDE.md`, and a pointer `CLAUDE.md` in `core/git/`.

## Tests

- Unit (`shared`): slug, branch name, sibling path and suffix retry, porcelain parsing (branch, detached, ahead/behind header, untracked, renames), link filtering, sidebar group key.
- Unit (`backend`): `WorktreeService` against real temp git repos (git is on the test machine), covering create, subfolder pick, `node_modules` links, status, ensure after removal, ensure after a manual delete, release skipped when dirty, release skipped when shared, and release removes the folder and keeps the branch. Also the handlers: create with the toggle, the refusal for a non-repo, and archive triggering release.
- Unit (`backend`, settings): `worktreeFolders` read and write, keyed by top folder, and a subfolder pick reading its repo's setting. Plus the handlers: `chats:create` isolates exactly when the setting is on, and `app:setWorktreeFolder` refuses a non-repo.
- Unit (`frontend`): `gitStatus.ts` (when to refetch), sidebar grouping by `worktree.folder`, and `reusableChat` matching on `worktree?.folder ?? cwd` and only the right kind.
- E2E: a new `e2e:worktrees` suite with fake claude covering create with the toggle, chip shown, archive removes the folder, send rebuilds it, and dirty archive keeps it.

## Left to the builder

- Exact copy and icons, within the house style.
- Whether `ensure` hooks a shared helper or each spawn site. The list above is a starting point, and the search decides.
- How `release` finds chats sharing the root: scan `chats.list()` (fine at today's sizes).
- Whether the git chip refetch is debounced.
