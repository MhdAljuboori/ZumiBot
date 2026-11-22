# Review loop: inline comments, parallel attempts, PRs and CI

Three features over the existing worktrees, Changes panel and task board: review a diff line by line and send the
comments to the agent (phase 1), run the same card on 2–5 agents at once and keep one (phase 2), and open a GitHub pull
request from a chat and watch its checks (phase 3). Each phase ships on its own and is reviewed before the next.

Read first: [Git worktrees](worktrees.md), [To-dos](todos.md), [Codex agents](codex.md), [Spend caps](spend-caps.md),
[Unread markers and Archive](unread-and-archive.md), [App shell UI](ui.md), [Data folder](data.md).

## What exists today

- `WorktreeService` (`core/git/worktrees.ts`) gives a chat its own worktree on `zumibot/<slug>`, made from the picked
  folder's `HEAD`. It never forces, never deletes a branch and never writes in the source checkout. `release()` keeps a
  dirty worktree and says why (`WorktreeKeep`).
- `GitChangesService` (`core/git/changes.ts`) lists uncommitted files and serves one file's two sides, both against
  `HEAD`. Work the agent already committed is invisible: there is no diff against a base commit.
- The board (`core/todos/`, `shared/src/todos.ts`) has cards with `status`, `assignee`, `folder`, `files`, `questions`
  and `task {agent, chatId, at, review}` — **one** chat per card. `TaskCards.start` places that chat (`place`, which
  isolates when the folder's toggle is on) and submits `taskMessage(item)` through the `TaskQueue`.
- An agent is Claude or Codex (`shared/src/engine.ts`); `engineCaps(engine)` gates what its chat supports.
- Nothing in the backend talks to GitHub or reads CI.

## Phase 1: inline review comments and the base diff — **shipped**

Built as designed, with one correction, marked below. The living detail is in [Git worktrees](worktrees.md) (Scope,
Review comments); what follows is the design and its reasons.

### The draft

A review draft is a list of comments for one chat, each pinned to a file and a line range with the lines it quoted:

```ts
// shared/src/reviewComments.ts — pure, imported by both sides
export interface ReviewComment {
  id: string            // client-made, so an edit or delete needs no server round trip
  path: string          // repo-relative, as the Changes panel lists it
  from: number          // first line of the range
  to: number            // last line (from === to for one line)
  old: boolean          // the range is on the old side (selectedLines' `old`), so the quote says so
  quote: string         // the lines as they read when the comment was made, at most QUOTE_MAX
  text: string          // what the user wrote, at most COMMENT_MAX
  at: number
  scope: GitDiffScope   // which diff it was made on ('uncommitted' | 'base'), shown in the row
}
export interface ReviewDraft { chatId: string; comments: ReviewComment[] }
```

Caps: `COMMENT_MAX` 4 000 characters, `QUOTE_MAX` 4 000 (a long selection is cut with a `…` line and the count says so),
`COMMENTS_MAX` 50 per draft. All pure (`reviewComments.ts`): `addComment`, `editComment`, `removeComment`, `countOf`,
`reviewMessage`.

**Where it lives.** `localStorage`, per device, under `zumibot:review:<chatId>` (`frontend/src/state/reviewDraft.ts`,
the `storedSet.ts` / `draftStore.ts` pattern: every access guarded, a bad value reads as no draft). So a draft survives a
reload and a chat switch, is cleared on send, and never reaches the server, `chats.json` or sync. The cost: a draft
started on the phone is not on the desktop. That is the right trade for a draft that lives minutes — the alternative
(a data-dir file) buys cross-device drafts and costs a new file, two RPCs and a sync merge rule. See Open questions.

### The message

**Send review** builds one text and posts it with the existing `chats:send` — an ordinary user turn, so Edit, Resend,
versions, the queue, spend caps and notifications all work on it unchanged. No new RPC. `reviewMessage(comments, o)` is
pure and tested:

```
Review of 3 places in the changes.

`src/app.ts:40-44`
```
  const x = compute()
  return x
```
This recomputes on every render — hoist it.

`src/app.ts:91` (old)
```
  legacy()
```
Why is this still here?
```

The quoted lines are the point: the agent finds the place again after the file has moved on, and the line numbers are
only a hint. Comments are grouped by path in the order the panel lists them, each range once. A fence longer than any
backtick run inside the quote, as `quoteBlock` already does. A comment made on the base diff adds ` (since start)` after
its range, so the agent knows which diff the lines came from.

### The base diff

`ChatWorktree.base?: string` — the full sha of the commit the worktree was created from, read with
`git rev-parse HEAD` in the picked folder inside `create()`, right before `worktree add` (that is the commit the add
starts the branch at). Optional, so older chats and the other machine's sync read as before; a chat without it is
offered no base diff and the switch says why ("This worktree was made before base diffs"). `ensure`'s remake path
(`Branch <branch> was gone, so it was made again from …`) leaves `base` alone: it is still the commit the work started
from, and the notice already tells the user the branch was rebuilt.

`GitDiffScope = 'uncommitted' | 'base'`:

- `uncommitted` (today's): `git status --porcelain=v2 -z -uall` in the repo top, counts from `git diff --numstat -z -M
  HEAD`, before side `HEAD:<path>`.
- `base`: tracked changes from `git diff --name-status -z -M --no-ext-diff --no-textconv <base> --` plus
  `git diff --numstat -z -M <base> --` for the counts, and the untracked entries of the same status call (a new file the
  agent has not committed is part of "since start"), before side `<base>:<path>`, after side the file on disk. So it is
  base → working tree, as asked, and a committed change shows.

`GitChangesService` grows a `ref` of its own instead of the hardcoded `HEAD`: `list(meta, scope)` and
`diff(meta, path, scope)`. A `base` scope with no `meta.worktree.base` returns `null` (the panel says why); a base commit
that is no longer in the repo (a rewritten history) surfaces git's own line, as every other git error does. The parsers
in `shared/src/gitChanges.ts` gain `parseNameStatusZ` beside `parseStatusZ`; everything else is reused.

### RPCs (three places each: `shared/src/types.ts`, `rpc/handlers.ts`, `frontend/src/net/api.ts`)

- `chats:gitChanges(chatId, scope?)` — `scope` absent reads `'uncommitted'`, so an older client keeps working.
- `chats:gitDiff(chatId, path, scope?)` — same.

The handler validates `scope` against the two names (`gitScope(v)`, a `TypeError` otherwise) and keeps reading only a
path the chosen scope lists now, so a made-up path never reaches the disk.

### UI

In the Changes panel (`GitChangesPanel.tsx`):

- A **scope switch** in the header beside the branch: `Uncommitted` | `Since start`. `Since start` is hidden for a chat
  with no worktree and disabled with a tooltip for a worktree with no `base`. The choice is component state per chat
  open, as the Diff/Old/New segment is.
- A **Comment** action in the existing selection menu over the diff lines (`Lines` → `SelectionMenu`, which already
  gives Quote and Explain with the exact row range through `selectedLines`). Picking it opens a small inline box under
  the selection: the quoted lines, a textarea, **Add** and Cancel.
- A **draft bar** at the foot of the panel while the draft has comments (`review-bar`): "3 comments", **Send review**,
  and a chevron that lists them. Each row: path and range, the first line of the text, **Edit** and **Delete**. Editing
  reopens the box with the text; the quote is never re-read, so it stays what the user saw.
- Send posts the turn, clears the draft and closes the bar. Send is disabled while the chat cannot take a message
  (offline, no claude) — the same gate as Explain.
- **Correction to the design.** The draft is cleared at once and *not* restored on a failure. `chats:send` settles only
  when the turn ends, so holding the draft until then would keep it for the whole reply; and a failed send already
  shows as a failed message carrying the whole review, with its own Retry. Nothing is lost either way.

Components stay thin: the reducer and the storage are `state/reviewDraft.ts`, the message and the caps are
`shared/src/reviewComments.ts`.

### Tests

`shared/tests/reviewComments.test.ts` (the builder: grouping, fences, the old-side and base marks, caps and cuts),
`frontend/tests/reviewDraft.test.ts` (storage per chat, an empty draft removing its key, storage missing or throwing,
a bad stored value), `backend/tests/core/git/changes.test.ts` grows base-scope cases against a temp repo (a committed
change shows only in `base`, an untracked file shows in both, a rename read at the base, a worktree with no `base`, and
a base commit git no longer has), `worktrees.test.ts` for the recorded `base`, and `handlers.test.ts` for the `scope`
validation. `npm run e2e:worktrees` grew the loop end to end: Since start listing a committed file that Uncommitted does
not, a mouse drag plus **Comment**, an edit, a second comment deleted again, the draft kept across a reload, and **Send
review** posting one user turn with the range, the quoted lines and `(since start)`.

## Phase 2: parallel attempts — **shipped**

Built as designed, with the corrections marked below.


### Shape

An attempt set belongs to a card and names one chat per attempt. On the card (`shared/src/todos.ts`, all optional):

```ts
export interface TodoAttempt { n: number; agent: string; engine: Engine; chatId: string }
export interface TodoAttempts {
  id: string
  at: number
  base: string            // the commit every attempt's worktree was made from
  source: string          // the checkout they were made from (worktree.source)
  folder: string          // the folder the user picked, as `TodoItem.folder`
  prompt: string          // the text every attempt was given, kept so the row can show it
  attempts: TodoAttempt[]
  winner?: string         // the kept attempt's chatId
}
```

On each attempt's chat (`ChatMeta`, optional): `attempt?: ChatAttempt { todoId: string; setId: string; n: number }`.

The card's own `task` stays **unset** while a set runs. That is deliberate: `task` is the one chat the card's machinery
drives (`ask_user`, `ready_for_review`, `todos:answer`, `todos:reply`, `taskTurnStarted/Ended` moving the column), and
all of it assumes one chat. An attempt chat carries `attempt` instead, so the card tools refuse there exactly as they do
in a plain chat, and no attempt moves the card's column. The card sits in **In progress** while any attempt runs.
**Keep this one** assigns the card to the winner's agent and links its chat as the card's `task`, after which every
existing card↔chat path works on the winner alone.

**Corrections to the design.**

- `attempts:start` takes an optional **folder**. A card that was never assigned to an agent has no `folder` of its own,
  so the dialog passes the one it shows (the card's, else the folder of the chat the card was made in) and the set
  records it. The card's own `folder` is left alone, since nobody is assigned yet.
- The set keeps the **card text** every attempt was given (`prompt`), not the whole message: the attempt paragraph
  differs per attempt, and the card is the part worth showing.
- Each attempt's chat carries its turn's **outcome** (`ChatAttempt.outcome`), written by `attemptTurnEnded`, wired
  beside the other turn-end hooks in `app.ts`. Without it a finished attempt and a failed one read the same from the
  meta, since `replyAt` is set either way.
- `n` is **the place the agent was picked at**, so a set whose second attempt failed to start reads 1 and 3, matching
  what the user asked for.

### Starting a set

`core/attempts/attemptSets.ts` (`AttemptSets`, a new folder with a pointer `CLAUDE.md`), built in `app.ts` beside
`TaskCards` and reusing its deps (`place`, `submit`, `store.create`, `push`):

1. Refuse when the card already has a set that is not finished, when it has a `task` chat, when it is done or removed,
   or when the picked folder is not a repo whose worktree toggle is on — attempts need a worktree each, so the dialog
   says to turn "Isolate in worktree" on for that folder first.
2. Read the base once: `git rev-parse HEAD` in the folder. Every attempt's worktree is created from that commit, so the
   diffs are comparable. `WorktreeService.create(picked, slugBase, { at: base })` grows an optional commit to start the
   branch at (`worktree add -b <branch> <root> <base>`), defaulting to `HEAD` as today.
3. Per attempt, in order: place the chat (`place`, which isolates), create it titled `<card title> · <agent> #<n>` with
   `attempt` on its meta, push the meta, then submit the prompt through the `TaskQueue` without awaiting the turn.
4. Store the set on the card (a restamp, not a rev bump: another chat's work is not news to the board's agents, as
   `todos.md` puts it) and move the card to In progress.

The prompt is `attemptPrompt(item, { n, total })` (`core/attempts/attemptPrompt.ts`): the card's title and notes, as
`taskMessage` builds them, plus one paragraph saying this is attempt `n` of `total` run in parallel on the same base,
that the agent should work only in its own worktree, commit its work, and not look at the other attempts. The card's
files are staged into each attempt's chat as copies, as `TaskCards.start` does. The card note (`taskNote`) is **not**
appended, since the chat has no `task` link; the attempt paragraph takes its place and says to end the turn with a
summary rather than call `ready_for_review`.

A partial failure (attempt 3 of 5 fails to get a worktree) keeps the attempts already made, stores the set with the ones
that started, and reports git's own line for the rest. Nothing is rolled back: a made worktree is work the user may
want.


An agent whose engine has no `bridges` (ACP) can't take an attempt, since an attempt is a task chat: the dialog's list leaves it out (`givableAgents`) and `AttemptSets.start` refuses the set before anything is made, naming the agent (`bridgeRefusal`).
### What a row shows

One row per attempt on the card: agent and engine tag, state, files changed and `+added −removed` **since base**, cost,
and how long since the set started (or how long its last turn took). Files and lines come from
`chats:gitChanges(chatId, 'base')`, the same call the panel's Since start uses. Cost comes from
`usage:query({chatId})`, as `CostChip` already reads it.

State (`attemptState`, pure, in `shared/src/attempts.ts`), read from the chat's meta plus what the app already holds:

| state | when |
| --- | --- |
| `running` | `inFlight` |
| `waiting` | approval cards wait, or a question card waits (the same inputs `taskState` uses) |
| `paused` | `meta.pause` — the row says `Paused` or, with `pauseCap`, `Paused at a spend cap` (`capPausedText`) |
| `limited` | `meta.resume` — `Waiting for the usage limit, continues <time>` (`limitNotice`'s words) |
| `done` | the last turn ended with a reply and nothing waits |
| `failed` | the last turn stopped or errored |
| `gone` | the chat was deleted |

So a paused or usage-limited attempt reads as itself, with the existing words, and nothing new is invented for it.

### Compare

**Compare** on two picked attempts opens a view with the two base diffs side by side: each column is the attempt's file
list and the picked file's diff, drawn by the same `changeRows` / `Lines` the Changes panel uses, each column headed by
agent, state, counts and **Open chat →**. Picking a file in one column picks the same path in the other when it is
there, so the same file is compared. The view is the card's (on the board, over the drawer; full-screen on a phone), not
the side panel's, since it needs two chats at once.

### Keep this one

`attempts:keep(todoId, chatId)`:

1. Marks `winner` on the set, assigns the card to that attempt's agent with its folder, and links the chat as the card's
   `task` (`startTask`'s invariants hold: the card is assigned to that agent, live and not done).
2. Moves the card to **In review**.
3. Archives every other attempt's chat through the existing path — `chats:archive(id, true)`'s own logic, so each gets
   `releaseInBackground`, and `release()` decides as it does today: a dirty or ignored-file worktree is kept with its
   reason. The row then shows `Kept: uncommitted changes` (the `worktreeArchiveLine` words) and the folder stays. Never
   forced, never a branch deleted.
4. Reports per attempt what happened, so a refusal is visible rather than silent.

The winner's chat is not archived and its worktree is untouched.

### Spend caps

No new cap kind. Each attempt's turns are that agent's own turns, so an agent's `dailySpendCap:` applies exactly as it
does anywhere else: the day trips, the turn pauses, the row shows `Paused at a spend cap`, and **Allow more today**
(Settings › Usage › Spend caps) is how the user goes on. The dialog carries the arithmetic the user asked for: "5
attempts cost about 5× one run", plus a line per agent that has a daily cap saying what is left of it today, and a
warning when an agent's day is already tripped (its attempt would pause on its first request). See Open questions for
what a real per-set cap would take.

### Decisions the user asked for

- **Single chats only, not rooms.** A room shares one worktree among its members by design ("One room, one worktree"),
  and a room attempt would mean a moderator, a hop cap and N worktrees per room. The picker lists agents, each attempt
  is a single chat, and a room is never an attempt. Codex agents are fine: `cwd` is a folder to them.
- **A paused or usage-limited attempt** shows its own state with the existing words (table above). Nothing is auto-
  resumed: going on is the user's act, as the spend-caps and usage-limit docs require.
- **The card is removed while a set runs.** Nothing is archived or stopped: a removed card is a tombstone, and its chats
  keep their `attempt` meta and their worktrees, as a task chat survives its card today. The set stays on the tombstone,
  so Undo brings the card back with its rows intact. The attempt chats' rows then have nowhere to show, which is the
  same hole a deleted task chat leaves; the chats are still in the sidebar and their branches are in git.

### RPCs

- `attempts:start(todoId, picks)` — `picks` is 2–5 `{agent}` entries, the same agent allowed twice; validated for
  count, agent existence, not Zumi Bot, no load error, and the folder's worktree toggle.
- `attempts:keep(todoId, chatId)` — the winner; returns what happened to each of the others.
- `attempts:cancel(todoId)` — stops every running attempt's turn and drops the set from the card, leaving the chats
  (the user archives them from the sidebar). No worktree is removed here.

The set and the rows need no RPC of their own: the card already comes through `todos:board` / `todos:list`, and the
chats through the chat list the app holds.

### UI

**Run attempts…** on a card's drawer (and in a chat row's panel menu) opens a dialog: a row per attempt with an agent
picker (2 to 5, add and remove), the folder (the card's, with Change…), the cost line, and **Run**. The card then shows
an **Attempts** section with one row per attempt, **Compare** (enabled with exactly two picked) and **Keep this one** on
each row. Pure rules in `frontend/src/state/attempts.ts` (`attemptState`, the picker's validity, the cost line, the row
labels); `TodoAttempts.tsx`, `AttemptsDialog.tsx`, `AttemptCompare.tsx` stay thin.

### Tests

`shared/tests/attempts.test.ts` (states, labels, set shape, the prompt), `frontend/tests/state/attempts.test.ts` (the
picker, the cost line, which rows allow Compare), `backend/tests/core/attempts/attemptSets.test.ts` against a temp repo
(five worktrees from one base, a partial failure, keep archives the rest and refuses a dirty one, a removed card, the
refusals), and `worktrees.test.ts` for `create` with an explicit base commit.

## Phase 3: pull request and CI from the card — **shipped**

Built as designed, with the corrections marked below.


GitHub only, through the `gh` CLI. **ZumiBot never stores a GitHub token**: `gh` holds its own credentials, and every
call is `execFile('gh', args, …)` with no shell, in the chat's worktree root.

**Corrections to the design.**

- **A failing check wins over anything still running.** The design folded pending first; that hides a failure until the
  rest finish, and **Send to agent** is most useful the moment something fails. `foldRollup` therefore reports
  `failing` as soon as one check has failed, and carries a `pending` count beside it so the line can still say how many
  are running.
- **`scrubToken` also strips credentials out of a URL.** git prints the remote back in a rejected push, and a remote
  can be `https://user:token@host/...`. Every git call of this service goes through a wrapper that scrubs its line.
  (The gits tested here strip it themselves; the scrub is what holds when one does not.)
- **The RPC is `github:draftPr`**, not `prDraft`, so it reads as a verb like its neighbours.
- **`locateBin` replaced the codex locator's copy too**, so there is now one binary search for claude, codex and gh
  rather than three.
- **Where the UI lives** (the design left it open): **Open PR…** and the PR's box sit at the foot of the Changes panel
  and in the card's "<agent>'s work" section; the chip sits beside the git chip in the chat's pickers row.

### Finding gh

`core/github/ghLocator.ts`. `claudeLocator.ts`'s `locateClaude` is generalized to `locateBin(name, deps)` (the same
candidate order: an override, each `PATH` entry, `~/.local/bin`, then the login shell's `command -v`), and
`locateClaude` becomes a one-line wrapper, so there is one locator and gh gets no copy of it. A miss is not cached, so
installing gh later works. There is no `ghPath` setting in this phase: the login-shell fallback is what finds a gh that
is not on the server's own `PATH`.

Auth is `gh auth status` (exit 0 = signed in), cached for a minute and dropped on any `gh` call that fails with an auth
error. `github:state()` returns `{ gh: 'missing' | 'logged-out' | 'ready' }`, and the UI offers nothing but a sentence
in the first two cases: "gh is not installed" / "gh is installed but not signed in. Run `gh auth login` in a terminal."
No token field anywhere.

### Open PR

**Open PR** shows on a chat that has a worktree branch. The dialog (`github:prDraft(chatId)`) shows the branch, the
commits on it (`git log --oneline <base>..HEAD`, so it is the work since the worktree started), and a title and body
drafted from the card (its title, its notes, and the commit subjects as a list) that the user can edit. Then **Create
pull request** (`github:createPr(chatId, {title, body, draft})`):

1. Refuses while the worktree has uncommitted changes, with the count: "Commit or stash the 3 uncommitted changes
   first." (one `git status --porcelain=v2`, ZumiBot's links left out, the same rule `releaseBlock` uses).
2. Refuses when the branch is the repo's default branch (`git symbolic-ref refs/remotes/origin/HEAD`, else
   `gh repo view --json defaultBranchRef`) — ZumiBot never pushes there.
3. `git push -u origin <branch>` — never `--force`, never `--force-with-lease`. A rejected push shows git's own line.
4. `gh pr create --head <branch> --title … --body-file <tmp> [--draft]`, body through a temp file so no shell and no
   long argv. Then `gh pr view --json number,url,state,isDraft` for what was made.

Push and PR creation happen **only on the user's click**: no agent tool, no workflow step, no routine and no poll ever
calls them. There is no MCP tool for this and no handler an agent can reach.

### Data

On the chat's meta (optional, so older files and sync read as before):

```ts
export interface ChatPr {
  number: number
  url: string
  state: 'open' | 'merged' | 'closed'
  draft?: true
  branch: string
  checks?: PrChecks        // the last rollup read; volatile
  at: number               // when the state was last read
  error?: string           // the last gh line, when a read failed
}
export interface PrChecks { status: 'pending' | 'passing' | 'failing'; total: number; failing: PrCheck[] }
export interface PrCheck { name: string; url?: string; jobId?: string }  // jobId from an Actions detailsUrl
```

`ChatMeta.pr?: ChatPr`. The card carries a display mirror `TodoItem.pr?: { number; url; state; chatId }` so the board
shows the PR without reading chats; it is written when the PR is made and whenever the state changes, and the chat's
meta stays authoritative — a disagreement is resolved in the chat's favour. Checks live only on the chat meta: they are
volatile and per machine, and there is no sense in syncing them. **No new data-dir file**: both live in `chats.json` and
`todos.json`, which sync already carries ([data](data.md)).

### Checks and polling

One `gh pr view --json number,url,state,isDraft,statusCheckRollup` per read gives the state and the rollup;
`shared/src/pullRequest.ts` folds the rollup into `PrChecks` (pure, tested against recorded JSON): any `in_progress` or
`queued` is `pending`, any `failure`, `timed_out`, `cancelled` or `action_required` is `failing` with the names, else
`passing`.

The watch is armed by `watcher.watch(meta)` after a create and after every read, at boot for every chat whose PR was
still running when the server stopped, and when a chat leaves the archive; `watcher.stop(id)` runs when a chat is
archived or deleted, and `stopAll()` at shutdown.

`core/github/prWatcher.ts` polls **only** while a PR is `open` **and** its checks are `pending`: 15 s, then ×1.5 after
each unchanged read, capped at 2 minutes, and it gives up after 2 hours (the row then offers **Refresh**). It stops at
once when the state becomes merged or closed, when the checks finish, when the chat is archived, when the chat is
deleted, and at shutdown. An idle PR is never polled, and a chat with no PR is never looked at. Each read that changes
anything patches the meta in place (`patchInPlace`, so the sidebar order does not move) and pushes it. Reads are
serialized per PR and at most a few run at once, so a board of ten PRs does not fire ten `gh` calls a second.

### Send a failing check to the agent

**Send to agent** on a failing check posts an ordinary user turn: the check's name, its URL, and the tail of its log —
`gh run view --job <jobId> --log-failed` when the check is a GitHub Actions job (its `jobId` comes from the
`detailsUrl`), cut to the last `LOG_TAIL_MAX` 4 000 characters with a line saying how much was dropped. A check that is
not an Actions job has no log through gh: the message then carries the name and the URL and says so. The text is built
by a pure `checkMessage()` in `shared/src/pullRequest.ts`.

### RPCs

- `github:state()` → `{ gh }`.
- `github:prDraft(chatId)` → `{ branch; base; commits: string[]; title; body; dirty: number; refusal?: string }`.
- `github:createPr(chatId, input)` → `ChatPr`.
- `github:refreshPr(chatId)` → `ChatPr` (the row's Refresh; also what the watcher calls internally).
- `github:sendCheck(chatId, name)` → posts the turn; the handler looks the check up on the stored meta, so a made-up
  name is refused rather than passed to gh.

Every handler validates each argument (`str`, `bool`, a title at most 256 characters, a body at most 60 000, the check
name matched against the stored `failing` list).

### Errors and secrets

A git or gh failure shows **that tool's own first line** and nothing of the environment — the `GitError` rule extended
to gh (`GhError`, built the same way from stderr's first `error:`/`fatal:` line). gh's output can carry a token-shaped
string in an error; the message is cut to one line and a `gh[po]_[A-Za-z0-9_]{20,}` run is replaced with `***` before it
is stored or logged, and only error **codes** reach the log, never a URL with a query.

### Tests

`shared/tests/pullRequest.test.ts` (the rollup fold, the check message, the token and URL-credential scrub),
`frontend/tests/pullRequest.test.ts` (the chip, the tones, gh's own sentences), and a **fake gh** at
`backend/tests/fixtures/fake-gh.mjs` (the `gh auth status`, `repo view`, `pr create`, `pr view` and `run view` calls it
needs, driven by env vars like `fake-claude.mjs`, or by a JSON state file it re-reads on every call so an e2e can change
what gh answers while the server runs). `backend/tests/core/github/` runs against a temp repo with a **local bare
remote**, so no test touches a real one: the dirty refusal (links left out), the default-branch refusal, a push and a
create (the body through a file, never argv, and never `--force`), a rejected push showing git's own line, a read that
fails keeping the last state, Send to agent with and without an Actions log, the watcher's intervals, backoff, give-up
and every stop (a hand-driven clock), and the locator's candidate order. `npm run e2e:github` drives the whole loop in
the built server with that fake gh on its PATH.

## Rules that hold throughout

- A new API method touches `ZumiBotApi` (`shared/src/types.ts`), the handler in `rpc/handlers.ts` and
  `frontend/src/net/api.ts`; handlers validate every argument, since args arrive as untyped JSON.
- Every new meta and card field is optional, so older files and the other machine's sync read as before. Phases 1–3 add
  **no** new data-dir file; `data.md` gains the new fields of `chats.json` and `todos.json`.
- Never `--dangerously-skip-permissions`, never `bypassPermissions`, never `git --force`, never a branch delete, never a
  write inside the source checkout.
- No new dependency, and every existing one stays pinned.
- Pure logic in `shared/src` and `frontend/src/state` with tests; backend services against temp repos; components thin.
- Docs in the same change: this file, `worktrees.md`, `todos.md`, the index line in the root `CLAUDE.md` (which has
  about 180 bytes of headroom under the 16 KB the `repoDocs` test enforces, so the line is short and a redundant phrase
  elsewhere is trimmed if needed), and a pointer `CLAUDE.md` in each new core folder (`core/attempts/`, `core/github/`).
- Before a phase is done: `npm test`, `npm run typecheck`, `npm run build:server`, and the new UI driven by hand in the
  running app.

## Open questions

Answered above, with the reasoning, and listed here so the user can overrule any of them:

1. **Review drafts are per device** (`localStorage`), not stored on the server. A server-side draft would need a
   `chats/<id>.review.json`, two RPCs and a sync rule by comment id. Recommend per device; say the word and it moves.
2. **Send review uses `chats:send`**, not a new RPC, so the turn is an ordinary one in every path that already exists.
3. **`base` is the commit the worktree started at**, and a remade branch keeps the old `base`. The alternative — reset
   `base` when `ensure` rebuilds the branch — hides what the agent did before the remake. Recommend keeping it.
4. **Attempts are single chats, never rooms** (reasons above). This is the decision most worth confirming.
5. **No per-set spend cap.** The agent day cap applies and the dialog shows the N× arithmetic. A real set cap would need
   a fourth cap kind in `shared/src/spendCaps.ts`, a `CapContext` for the set, a hold that pauses every attempt and a
   Continue beside the rows — a feature of its own size. Recommend the N× notice now.
6. **A removed card leaves its attempt chats alone.** Stopping or archiving them on a remove would discard work the
   user may not have meant to discard, and a remove is undoable.
7. **The card's PR field is a display mirror.** The chat meta is authoritative. The alternative is reading the PR from
   the chat list the board already holds and storing nothing on the card; the user asked for both, so both are written.
8. **`gh` has no override setting** in phase 3, unlike `claudePath`. If a machine's gh is somewhere the login shell does
   not find, that wants an `AppSettings.ghPath` — one more field, easy to add later.
9. **Non-Actions checks have no log tail** through gh, so Send to agent carries the name and URL for them.
