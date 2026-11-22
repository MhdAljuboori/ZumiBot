# Edit, Resend and Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can edit or resend any message they sent (keeping every earlier version, switchable with `‹ n / m ›`), and fork a chat from any message into a new chat. The agent's Claude session always matches the version on screen. Works in single chats and group rooms.

**Architecture:** The visible version stays the flat item list in `chats/<id>.json`. Hidden versions live in `chats/<id>.versions.json`. Each turn stamps the last item it leaves with its session and last chain-entry uuid (`end`), and each agent message records its own uuid (`cut`). The start point for an edit, resend, switch or fork is read from those stamps in the visible items. It is stored as `next` on the chat (or per room member), and the next CLI run uses `--resume <session> --resume-session-at <uuid> --fork-session`. A missing point becomes a fresh session seeded from the visible history (`next: { seed: true }`). Edit and Resend go through `TaskQueue`, which stops a running reply and holds queued tasks.

**Tech Stack:** TypeScript, Node 22, vitest, React 19, playwright-core e2e; the `claude` CLI 2.1.299 hidden flags `--resume-session-at` and `--fork-session`.

**Spec:** `docs/superpowers/specs/2026-10-30-edit-resend-fork-design.md` (read it first; this plan argues from it).

## Global Constraints

- **Never commit.** The user's global rule. Leave all changes in the working tree; the user commits. Ignore any "Commit" habit from the skills.
- Never add `--dangerously-skip-permissions` or `bypassPermissions`.
- A cut run never falls back to a plain `--resume`. On "No message found with message.uuid" or a non-zero exit, the run shows an error item. On a missing session ("No conversation found with session ID"), it uses the existing `expired` seed fallback.
- Hidden versions never reach group prompts, the moderator, seeds, routines, `itemsFeed` or any other reader of the chat's items. They are only in `chats/<id>.versions.json`.
- New API methods touch three places: `ZumiBotApi` in `shared/src/types.ts`, `rpc/handlers.ts` (validate every argument), and `frontend/src/net/api.ts`.
- Frontend logic goes in pure modules under `frontend/src/state/`, with tests in `frontend/tests/`. There are no component tests.
- Comments are short and say *why*. Match the surrounding style. Dependencies stay pinned; add none.
- Exact copy:
  - Fork title: `Fork of <title>`, or `Fork of chat` when the title is empty.
  - Files notice, files only: `Version N edited F file(s). They stay as they are now.`
  - Files notice, commands only: `Version N ran C command(s). Anything they changed stays as it is now.`
  - Files notice, both: `Version N edited F file(s) and ran C command(s). Nothing was undone.`
  - Use the singular form when the count is 1: `1 file`, `1 command`.
- Run each task's tests with `npx vitest run <file>` from the repo root, and `npm run typecheck` before declaring a task done.

## Review Focus

1. **Edit while an approval card is pending** on a running reply. Stop marks the card `unanswered`, and the old version keeps it hidden. The new version starts clean. Test in Task 6.
2. **Edit the very first message** of a chat. No items before it means a fresh session: no `--resume`, no seed, no `expired` notice. Test in Task 2 and Task 4.
3. **Double Resend** (two quick clicks, or two tabs). The second waits on the queue lock, stops the first rerun and makes version 3. Two CLI runs never overlap. Test in Task 6.
4. **Legacy chat** (items with no `end` stamps). Edit seeds a fresh session and adds the `expired` notice. It never resumes the legacy session. Test in Task 4.
5. **Stale message id**: another tab switched versions, so the id being edited is no longer visible. The server rejects with `Message not found`, and the client shows the error and closes the editor. Test in Task 3 (switchTo/branch throw) and Task 10 (editor reset).

---

### Task 1: Shared types, stream parser and runner args

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/streamParser.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/claudeRunner.ts` (`buildArgs`)
- Test: `zumi-bot-server/backend/tests/core/streamParser.test.ts` (create if absent; else extend), `zumi-bot-server/backend/tests/core/claudeRunner.test.ts`

**Interfaces:**
- Produces (shared/types.ts):
  ```ts
  /** A point in one Claude session: resume `session` up to and including chain entry `at`. */
  export interface SessionCut { session: string; at: string }
  /** On the last item a turn leaves: where its author's session ended. `agent` and `seen` only in group rooms. */
  export interface TurnEnd extends SessionCut { agent?: string; seen?: string | null }
  /** How an agent's next turn starts when it must not just resume its session's end. */
  export type NextStart = { at: string } | { seed: true }
  /** On a user message with more than one version; index is 0-based, root is the first version's item id. */
  export interface VersionInfo { root: string; index: number; count: number }
  export interface ForkResult { chat: ChatMeta; draft: { text: string; attachments: Attachment[] } | null }
  ```
  - `ChatItem` becomes `(…existing union…) & { end?: TurnEnd }`.
  - The `user` variant gains `versions?: VersionInfo`, and the `assistant` variant gains `cut?: SessionCut`.
  - `NoticeKind` gains `'kept'`, with `NOTICE_TEXT.kept = 'An earlier version changed files. Nothing was undone.'` (fallback text only; the real text is set per notice).
  - `ChatMeta` gains `next?: NextStart` and `held?: boolean`. `GroupInfo` gains `next?: Record<string, NextStart>`.
  - Do **not** touch `ZumiBotApi` here (Task 8 does).
- Produces (streamParser):
  - `RunEvent` gains `{ kind: 'entry'; uuid: string }`.
  - The `init` variant becomes `{ kind: 'init'; sessionId: string; version?: string }`.
- Produces (claudeRunner): `buildArgs` option `resumeAt?: string`.

- [ ] **Step 1: Write failing tests**
  - `parseLine emits entry before content for an assistant line`: an assistant line with `uuid: 'u1'` and a text block gives `[{ kind: 'entry', uuid: 'u1' }, { kind: 'assistantText', text: … }]`.
  - `parseLine emits entry for a tool_result user line`: `[{ kind: 'entry', uuid: 'u2' }, { kind: 'toolResult', … }]`.
  - `parseLine emits no entry for subagent lines, stream_event or system lines`: a line with `parent_tool_use_id: 'x'` gives `[]`; a `stream_event` with a uuid gives no entry.
  - `parseLine reads claude_code_version on init`: `{ type:'system', subtype:'init', session_id:'s', claude_code_version:'2.1.299' }` gives `{ kind:'init', sessionId:'s', version:'2.1.299' }`. Without the field, `version` is absent.
  - `buildArgs adds resume-at and fork after --resume`: `buildArgs({ …, resumeSessionId: 's', resumeAt: 'u' })` contains the consecutive run `'--resume','s','--resume-session-at','u','--fork-session'`. With `resumeAt` set but `resumeSessionId: null`, neither flag appears.
- [ ] **Step 2: Run them, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/streamParser.test.ts zumi-bot-server/backend/tests/core/claudeRunner.test.ts`
- [ ] **Step 3: Implement** the types, the parser change (an entry only for `assistant`/`user` lines with a string `uuid` and no `parent_tool_use_id`, emitted first) and `buildArgs`.
- [ ] **Step 4: Run the tests and `npm run typecheck`, expect PASS.** Existing tests that build `{ kind: 'init', sessionId }` still compile because `version` is optional.

---

### Task 2: Session points (pure)

**Files:**
- Create: `zumi-bot-server/backend/src/core/chat/sessionPoints.ts`
- Test: `zumi-bot-server/backend/tests/core/sessionPoints.test.ts`

**Interfaces:**
- Consumes: `ChatItem`, `TurnEnd`, `SessionCut`, `NextStart` (Task 1).
- Produces:
  ```ts
  export interface StartPoint { sessionId: string | null; next: NextStart | null }
  export interface MemberPoint extends StartPoint { seen: string | null }
  export function startBefore(items: readonly ChatItem[], index: number): StartPoint
  export function startAfterMessage(items: readonly ChatItem[], index: number): StartPoint
  export function memberStartsBefore(items: readonly ChatItem[], index: number, members: readonly string[]): Record<string, MemberPoint>
  export function memberStartsAfterMessage(items: readonly ChatItem[], index: number, members: readonly string[]): Record<string, MemberPoint>
  ```

**Rules (the tests pin these):**
- `startBefore(items, i)` (single chat; `i` may equal `items.length`). Let `k` be the last index `< i` whose item has `end`.
  - No `k`: if any `user` item is before `i`, return `{ sessionId: null, next: { seed: true } }`. Otherwise return `{ sessionId: null, next: null }`.
  - `k` found, with a `user` item in `(k, i)`: `{ null, { seed: true } }`. That turn was never recorded.
  - Otherwise: `{ sessionId: end.session, next: { at: end.at } }`.
- `startAfterMessage(items, i)` (fork at agent message `items[i]`): `items[i].cut` gives `{ cut.session, { at: cut.at } }`. Without `cut`: `{ null, { seed: true } }`.
- `memberStartsBefore`: for each member `m`, let `k` be the last index `< i` with `end?.agent === m`.
  - Found: `{ sessionId: end.session, next: { at: end.at }, seen: end.seen ?? null }`.
  - Not found, but `m` has an `assistant` item before `i`: `{ null, { seed: true }, null }`.
  - Otherwise: `{ null, null, null }`.
- `memberStartsAfterMessage(items, i, members)`, where `A = items[i].agent`:
  - Members other than `A`: the result of `memberStartsBefore(items, i + 1, members)`.
  - `A` with a `cut`: `{ cut.session, { at: cut.at }, seen }`, where `seen` is the `end.seen` of the first item at or after `i` with `end.agent === A`, else `null`.
  - `A` without a `cut`: `{ null, { seed: true }, null }`.

- [ ] **Step 1: Write failing tests** named for each rule above. Also cover:
  - `startBefore at index 0 is a fresh start`: `{ sessionId: null, next: null }`.
  - `startBefore uses the latest end before the message, not one after it`.
  - `memberStartsBefore ignores ends of other members`.
  - `members missing from the items are fresh`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 3: Versions (pure) and their storage

**Files:**
- Create: `zumi-bot-server/backend/src/core/chat/versions.ts`
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts`
- Test: `zumi-bot-server/backend/tests/core/versions.test.ts`, `zumi-bot-server/backend/tests/core/chatStore.test.ts`

**Interfaces:**
- Produces (versions.ts):
  ```ts
  export type UserItem = Extract<ChatItem, { type: 'user' }>
  export interface StoredVersion { user: UserItem; tail: ChatItem[] }
  /** list[current] is null: that version is the one on screen. */
  export interface VersionSet { current: number; list: (StoredVersion | null)[] }
  export type Versions = Record<string, VersionSet> // by root id
  export function branch(items: readonly ChatItem[], versions: Versions, userId: string, next: UserItem): { items: ChatItem[]; versions: Versions; hidden: StoredVersion }
  export function switchTo(items: readonly ChatItem[], versions: Versions, userId: string, index: number): { items: ChatItem[]; versions: Versions }
  export function hiddenItems(versions: Versions): ChatItem[]
  export function mapHidden(versions: Versions, fn: (i: ChatItem) => ChatItem): Versions
  export function keptNotice(hidden: StoredVersion, versionNumber: number): string | null
  ```
- Produces (ChatStore):
  - `loadVersions(id: string): Promise<Versions>`: `{}` when there is no file. A corrupt file is renamed `.bak-<ts>`, as `loadItemsRaw` does.
  - `saveVersions(id: string, v: Versions): Promise<void>`: deletes the file when `v` is `{}`. Runs on the store's queue, and never writes for a removed chat.
  - `holdTasks(id: string): Promise<ChatMeta>`: sets `held: true` only when `tasks` is non-empty.

**Rules:**
- `branch`: `userId` must be a visible `user` item, else throw `new Error('Message not found')`.
  - `root = old.versions?.root ?? old.id`. The set defaults to `{ current: 0, list: [null] }`.
  - The current slot becomes `{ user: old without versions, tail: items after it }`.
  - A new `null` slot is appended and becomes `current`.
  - The new visible user item is `{ ...next, versions: { root, index: current, count: list.length } }`, and the visible items end with it.
- `switchTo`: throws `Message not found` for a non-visible id and `Version not found` for a bad or empty slot. The same index is a no-op that returns the inputs unchanged. Otherwise it swaps the visible user item and tail with the stored slot and sets `versions` on the newly visible user item.
- `keptNotice`: returns `null` when there's nothing to report; otherwise the exact copy in Global Constraints.
  - Files: the distinct `input.file_path` (or `notebook_path`) of tool items named `Edit|Write|MultiEdit|NotebookEdit` with `result !== null`, `!isError` and `!blocked`.
  - Commands: tool items named `Bash` with `result !== null` and `!blocked`.
- ChatStore:
  - `remove()` also deletes `<id>.versions.json`.
  - `renameAgent()` also rewrites `agent` and `end.agent` inside every versions file (via `mapHidden`), `end.agent` in visible items, and the keys of `group.next`.
  - `takeTask`/`dropTask` drop `held` when they leave `tasks` empty.

- [ ] **Step 1: Write failing tests:**
  - `branch hides the tail and shows the new version as 2 of 2`
  - `branch on a second version makes 3 of 3 and keeps versions 1 and 2`
  - `switchTo 1 restores its tail and stores the shown one`
  - `nested: a version hidden inside another keeps its own set` (branch M, then branch N inside it, switch M back and forth, then N's set is intact)
  - `branch and switchTo throw Message not found for a hidden id`
  - `keptNotice counts distinct files and ran commands` (one case each for the three copies and the singular form)
  - `keptNotice ignores blocked and errored tools`
  - chatStore: `versions round-trip and are removed with the chat`
  - chatStore: `renameAgent rewrites hidden items, end stamps and group next keys`
  - chatStore: `holdTasks holds only with tasks, and the last take or drop clears it`
  - chatStore: `recoverInterrupted leaves the versions file untouched`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and typecheck, expect PASS.**

---

### Task 4: ChatService: stamps, start points, rerun and switch (single chats)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `TurnSpec` gains `resumeAt?: string` and `reseed?: boolean`. `TurnResult` gains `end: SessionCut | null`.
  - New `ChatService` methods:
    ```ts
    rerun(chatId: string, userId: string, text: string | null): Promise<void> // single chats; text null = Resend
    switchVersion(chatId: string, userId: string, index: number): Promise<void> // single chats and rooms; throws 'Chat is busy' while running
    whenIdle(chatId: string): Promise<void>
    ```
  - `export const FORK_IGNORED = (version: string | undefined): string` returns `Claude Code${version ? ` ${version}` : ''} ignored --fork-session, so this reply was stopped before it could change an earlier version's memory. Edit, Resend, Fork and switching versions need an update for this Claude Code version.`

**Behavior:**
- **`agentTurn` events:**
  - On `entry`, set `tip = uuid`.
  - On `assistantText`, the assistant item gets `cut: { session: <current session id>, at: tip }` once the session id is known. Skip `cut` when the id or tip is unknown.
  - On `init` with `spec.resumeAt`: if `e.sessionId === spec.sessionId`, don't save the session. Mark `forkIgnored`, call `slot.handle.stop()`, and after the run add the error item `FORK_IGNORED(e.version)`. It never counts as `ok`.
- **`agentTurn` start:**
  - `spec.reseed`: skip the resume attempt. Add the `expired` notice, then run with `resumeId null` and `spec.seedPrompt(history)`.
  - `spec.resumeAt`: pass it to `buildArgs`.
  - The existing `isMissingSession` fallback still applies to a cut run.
  - Return `end: { session, at: tip }` when both are known, else `null`.
- **`turn()` (send):**
  - Build the spec with `resumeAt: meta.next && 'at' in meta.next ? meta.next.at : undefined` and `reseed: meta.next?.seed`.
  - `saveSession(id)` also clears `next` when `id !== null`, so a run that fails before `init` keeps it.
  - After `agentTurn`, stamp `end` on the chat's last item when `res.end` is set.
- **`rerun`:**
  - Under its own claim (throws `Chat is already running` like `send`), load items and versions.
  - Build the new user item: a new id, the edited text (or the same text), and the same `attachments`/`replyTo`. An empty edit with no attachments throws `Message is empty`.
  - Call `branch`, and insert the `kept` notice right after the new user item when `keptNotice(hidden, oldIndex + 1)` is non-null.
  - Set meta `sessionId` and `next` from `startBefore(items, index)`.
  - Save items and versions, push items and meta, then run the turn exactly like `send` does from that user item onward. Refactor `turn()` so both share it; the seed history is the items before the user item.
- **`switchVersion`:**
  - Throws `Chat is busy` if running. Loads items and versions and calls `switchTo`.
  - Single chat: set `sessionId` and `next` from `startBefore(items, items.length)`.
  - Group: for every member, set `sessions[m]`, `seen[m]` and `next[m]` from `memberStartsBefore(items, items.length, members)`, and clear `queue`/`active`.
  - Saves items, versions and meta, pushes items and meta, and bumps `updatedAt`.

- [ ] **Step 1: Write failing tests** (use the existing fake `run` and `scripts` harness; scripted events gain `entry` lines):
  - `assistant items carry cut and the turn's last item carries end`
  - `a send after a stamped turn resumes plainly with no resume-at`
  - `rerun of the second message cuts at the first turn's end with fork` (args contain `--resume s1 --resume-session-at <tip> --fork-session`)
  - `rerun of the first message runs fresh: no --resume, no expired notice` (Review Focus 2)
  - `rerun in a legacy chat seeds with the expired notice and never resumes` (Review Focus 4)
  - `rerun hides the old tail as version 1 and shows 2 / 2`
  - `rerun adds the kept notice when the old version edited files`
  - `init with the same session id on a cut run stops it and shows FORK_IGNORED`
  - `a cut run whose session is missing falls back to the seeded expired path`
  - `next survives a run that fails before init, and is cleared by the first saved session`
  - `switchVersion back sets next to the shown version's last end`
  - `switchVersion while running throws Chat is busy`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `chatService.test.ts`, the whole backend project (`npx vitest run --project backend`) and typecheck, expect PASS.**

---

### Task 5: GroupService: stamps, start points and rerun

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts`
- Test: `zumi-bot-server/backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 (`TurnSpec.resumeAt/reseed`, `TurnResult.end`, `memberStartsBefore`, `branch`, `keptNotice`).
- Produces: `GroupService.rerun(chatId: string, userId: string, text: string | null): Promise<void>`. It resolves once the message is posted, like `send`.

**Behavior:**
- **`runTurn`:** `resumeAt`/`reseed` come from `g.next?.[m]`, and `saveSession` also deletes `next[me()]` when `id !== null`.
- **`endTurn`:** when `res.end` is set and `own` is non-empty, stamp the last item of `own` with `end: { ...res.end, agent: me, seen }`. Here `seen` is the value `g.seen[me]` takes after this turn: `seenId` when the turn didn't error, else the previous value. A pass that leaves no items stamps nothing. That's correct: the next start point falls back to an earlier, still consistent pair.
- **`rerun`:** runs through `serial`, and the chat must be idle (else throw `Chat is busy`).
  - `branch`, plus the `kept` notice, as in Task 4.
  - For every current member, set `sessions`, `seen` and `next` from `memberStartsBefore(items, index, members)`.
  - Save, then open the room and enter the new user item into the inbox exactly as `post` does. Refactor `post` so both share "enter an already-added user item": `hops = 0`, `halted = false`, inbox push, start or wake.

- [ ] **Step 1: Write failing tests:**
  - `a member's last turn item carries end with agent and seen`
  - `rerun rewinds every member: sessions, seen and next from before the message`
  - `rerun posts the new version to the moderator and members, and they never see the hidden version` (assert the members' prompts contain the new text and not the old reply)
  - `a member with no end stamp but earlier replies is reseeded`
  - `a member added after the message starts fresh`
  - `next[m] is cleared after m's first saved session`
  - `threadEntries leaves out the kept notice` (in `groupPrompts.test.ts`)
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the backend project and typecheck, expect PASS.**

---

### Task 6: TaskQueue: hold, rerun and switch

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/taskQueue.ts`
- Modify: `zumi-bot-server/backend/src/app.ts` (wiring only, if the deps change)
- Test: `zumi-bot-server/backend/tests/core/taskQueue.test.ts`

**Interfaces:**
- Consumes: `ChatService.rerun/switchVersion/whenIdle/stop`, `GroupService.rerun`, `ChatStore.holdTasks`.
- Produces:
  ```ts
  rerun(chatId: string, userId: string, text: string | null): Promise<void> // resolves when a single chat's turn ends / a room message is posted
  switchVersion(chatId: string, userId: string, index: number): Promise<void>
  ```

**Behavior:**
- **`rerun`:** under `serial`.
  - If busy (running or dispatching): `chats.stop(chatId)`, then wait for both `chats.whenIdle(chatId)` and any launch still in flight.
  - Then `store.holdTasks(chatId)` and push the meta.
  - Then launch via `isGroup(meta) ? groups.rerun : chats.rerun`, with the same `dispatching` bookkeeping as `launch`.
- **`pump`:** returns early when `meta.held`.
- **`submit`:** `waiting` is false while `meta.held`, so a composer message on an idle held chat goes straight in and the tasks stay held. `resume()` at startup also skips held chats (it goes through `pump`).
- **`switchVersion`:** under `serial`. Throws `Chat is busy` when busy, else calls `chats.switchVersion`.

- [ ] **Step 1: Write failing tests:**
  - `rerun on a running chat stops it, waits, then reruns: never two runs at once`
  - `rerun holds queued tasks: the stop's idle and the rerun's end start none`
  - `a pending approval card ends unanswered and stays in the hidden version` (Review Focus 1; drive through ChatService with a pending card)
  - `two quick reruns: the second stops the first and makes version 3` (Review Focus 3)
  - `a composer send while held and idle goes straight in; tasks stay held`
  - `sendTask sends a held task; dropping the last one clears held`
  - `resume at startup does not send held tasks`
  - `switchVersion while busy throws Chat is busy`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the backend project and typecheck, expect PASS.**

---

### Task 7: Fork

**Files:**
- Create: `zumi-bot-server/backend/src/core/chat/fork.ts`
- Modify: `zumi-bot-server/backend/src/core/attachments/attachmentStore.ts`
- Test: `zumi-bot-server/backend/tests/core/fork.test.ts`, `zumi-bot-server/backend/tests/core/attachmentStore.test.ts`

**Interfaces:**
- Consumes: `ForkResult` (Task 1), `startAfterMessage`/`startBefore`/`memberStartsBefore`/`memberStartsAfterMessage` (Task 2).
- Produces:
  ```ts
  export interface ForkDeps { store: ChatStore; files: Pick<AttachmentStore, 'copyFiles' | 'stagePath' | 'pathOf'>; now(): number }
  export async function forkChat(d: ForkDeps, chatId: string, itemId: string): Promise<ForkResult>
  // AttachmentStore:
  copyFiles(fromChat: string, toChat: string, attachments: Attachment[]): Promise<void>
  ```

**Behavior:**
- The item must be a visible, non-live item (no `turn`), else throw `Message not found`.
- **Agent message at index `i`:** copy `items[0..i]`.
  - Single chat: `sessionId`/`next` from `startAfterMessage`.
  - Room: per-member `sessions`/`seen`/`next` from `memberStartsAfterMessage`.
- **User message at index `i`:** copy `items[0..i)`.
  - Single chat: start from `startBefore(items, i)`. Room: start from `memberStartsBefore(items, i, members)`.
  - `draft` gets the message's text and its attachments, each staged anew with `files.stagePath(files.pathOf(chatId, a))`.
- **The new chat:**
  - Created with `store.create(agentName, cwd)` or `store.createGroup(members, cwd, role)`, then updated with the title (Global Constraints), `sessionId`/`next` or the group fields, and the copied items' `reactions`.
  - Copied items drop `versions` and `turn`. Attachments of copied items are copied with `copyFiles`.
- The source chat's meta, items and versions files are byte-identical afterwards.

- [ ] **Step 1: Write failing tests:**
  - `fork at an agent message copies up to it and cuts at its uuid`
  - `fork at a user message copies before it and returns its text and staged attachments as the draft`
  - `fork of a room keeps members, role and folder, and rewinds each member`
  - `fork never changes the source chat` (compare the files' bytes before and after)
  - `fork drops versions and copies attachments, so removing either chat keeps the other's files`
  - `fork of a live item throws Message not found`
  - `fork title is Fork of <title>, or Fork of chat`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 8: RPC and client API

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.chats`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts`
- Modify: `zumi-bot-server/frontend/src/net/api.ts`
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`, `zumi-bot-server/backend/tests/rpc/itemsFeed.test.ts`

**Interfaces:**
- Produces (ZumiBotApi.chats):
  ```ts
  edit(chatId: string, itemId: string, text: string): Promise<void>
  resend(chatId: string, itemId: string): Promise<void>
  switchVersion(chatId: string, itemId: string, index: number): Promise<void>
  fork(chatId: string, itemId: string): Promise<ForkResult>
  ```
- Handlers:
  - `chats:edit` → `tasks.rerun(id, item, str(text))`.
  - `chats:resend` → `tasks.rerun(id, item, null)`.
  - `chats:switchVersion` → `tasks.switchVersion(id, item, versionIndex(index))`. `versionIndex` throws `TypeError('index must be a non-negative integer')` for anything else.
  - `chats:fork` → `forkChat(…)`, then broadcast `{ chatId: new.id, kind: 'meta', meta }` so every tab lists it.
  - Like `chats:send`, none of them catch.

- [ ] **Step 1: Write failing tests:** `edit validates its arguments and calls rerun`, `resend calls rerun with null`, `switchVersion rejects -1, 1.5 and '2'`, `fork broadcasts the new chat's meta`. Also add `a version switch goes out as a delta from the switched message` to `backend/tests/rpc/itemsFeed.test.ts`: push a list, then the same list with a swapped user item and tail, and expect `from` to be the switched message's index.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and typecheck (all workspaces), expect PASS.**

---

### Task 9: Sync keeps every version

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs`
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

**Interfaces:**
- Produces (exported for tests):
  ```js
  /** One chat from both sides; versions are the parsed <id>.versions.json or null. */
  export function mergeChatFiles(local, vps, vpsNewer)
  // local/vps: { items: ChatItem[], versions: object | null }
  // returns { items, versions, forked: {local, vps} | null, copy: null | 'local' | 'vps' }
  ```
- `mergeChats` reads both sides' versions files and uses `mergeChatFiles`. Its result gains `versionWrites: [id, versions|null][]` and `copies: [{ from: 'local'|'vps', id, newId, meta }]`.

**Rules:**
- **Versions deep-equal** (both missing counts as equal): today's `mergeItems`, with `copy: null`.
- **Versions differ:**
  - `base` = the newer side, used as it is (its items and its versions).
  - Collect every item id on each side: visible items plus `user` and `tail` items of every stored version.
  - If the older side has an id the base lacks, return `copy` = the older side.
- **For each copy:**
  - A new chat id goes into the joined index, with the older side's meta and the title `"<title> (copy from this PC)"` or `"(copy from the VPS)"`.
  - Its items and versions files are written locally, and its attachments are copied from `attachments/<oldId>` to `attachments/<newId>` on the local side (from the pulled VPS copy when it came from the VPS).
  - Log one line per copy.
- The VPS-only versions files reach the local side. The existing upload of the local `chats/` folder then carries every versions file to the VPS, so no new transfer step is needed. Check this against the code and adjust if it doesn't hold.

- [ ] **Step 1: Write failing tests:**
  - `equal versions join items as before`
  - `a switch on one side wins without a copy when the other side has nothing new`
  - `versions changed on both sides keep the newer side and copy the older one, with attachments`
  - `a versions file that exists only on the VPS reaches this PC`
  - `the copy's title says where it came from`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep `sync.mjs` dependency-free; it runs from the desktop `resources/sync` copy too.
- [ ] **Step 4: Run `npx vitest run zumi-bot-server/backend/tests/sync.test.ts`, expect PASS.**

---

### Task 10: Frontend state (pure)

**Files:**
- Create: `zumi-bot-server/frontend/src/state/messageEdit.ts`
- Modify: `zumi-bot-server/frontend/src/state/tasks.ts`
- Test: `zumi-bot-server/frontend/tests/messageEdit.test.ts`, `zumi-bot-server/frontend/tests/tasks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** The user message Resend on this agent message sends again: only for the chat's latest agent message. */
  export function resendTarget(items: readonly ChatItem[], agentItemId: string): string | null
  export function versionLabel(v: VersionInfo): string // "2 / 3"
  export function canStep(v: VersionInfo, dir: -1 | 1): boolean
  /** Ids drawn dimmed while this message is edited: everything after it. */
  export function dimmedAfter(items: readonly ChatItem[], editingId: string | null): ReadonlySet<string>
  export function editOutcome(original: string, draft: string, hasAttachments: boolean): { kind: 'edit'; text: string } | { kind: 'resend' } | { kind: 'empty' }
  /** Whether an edit can stay open after the items changed (another tab switched versions). */
  export function editStillValid(items: readonly ChatItem[], editingId: string): boolean
  ```
- `tasks.ts`:
  - `sendsAsTask`: tasks no longer queue a message while `chat.held`.
  - `tasksHeld`: `!chat.inFlight && (chat.held === true || (group && pausedAtEnd(items)))`.

- [ ] **Step 1: Write failing tests:**
  - `resendTarget is the user message before the latest agent message, else null`
  - `resendTarget in a room uses the room's last agent message`
  - `versionLabel and canStep at the ends`
  - `dimmedAfter lists every item after the edited one`
  - `an unchanged edit is a resend; a blank edit without files is empty`
  - `editStillValid is false once the id is gone` (Review Focus 5)
  - tasks: `held tasks offer Send now in a single chat`
  - tasks: `a held idle chat sends a written message straight away`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx vitest run --project frontend`, expect PASS.**

---

### Task 11: Frontend UI

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/MessageActions.tsx`
  - Add `UserMessageActions` with Edit, Resend, Fork and Copy, ordered from the bubble outward.
  - Agent `MessageActions` gains optional `onResend` and `onFork`.
  - Add `EditIcon`, `ResendIcon` and `ForkIcon`, drawn like the icons already there.
- Create: `zumi-bot-server/frontend/src/components/MessageEditor.tsx`: the in-place box with Cancel and Send.
  - Enter sends and Shift+Enter makes a new line. On a coarse pointer, Enter makes a new line and Ctrl/Cmd+Enter sends, matching `Composer.tsx` lines 131–154.
  - Esc cancels. Height is capped at the composer's max height.
- Create: `zumi-bot-server/frontend/src/components/VersionSwitcher.tsx`: `‹ n / m ›` under the user bubble. Disabled while `chat.inFlight`.
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx`, `ChatView.tsx`, `App.tsx`, `styles.css`.

**Behavior** (matches the approved mockup `.superpowers/brainstorm/694350-1793384147/content/edit-resend-fork.html`):
- **`MessageList`:**
  - Keeps `editingId` in local state.
  - Dims the items from `dimmedAfter`, and closes the editor when `editStillValid` turns false.
  - New props: `onEdit(itemId, text)`, `onResend(itemId)`, `onSwitchVersion(itemId, index)`, `onFork(itemId)`.
  - User actions aren't shown for unconfirmed or failed sends (`failed[id]`, pending), or while sending can't happen (the same condition as `onExplain` being null).
- **Agent messages:** Resend is shown only where `resendTarget` is non-null. Fork shows on every finished agent message, never in the working tray.
- **`App.tsx`:**
  - `editMessage`, `resendMessage` and `switchVersion` call the API. A rejection shows through the chat's existing send-error path.
  - `forkFrom(chatId, itemId)` calls `api.chats.fork`, upserts the chat and opens it. With a `draft`, it sets `drafts[newId] = draft.text` and `draftFiles[newId] = { files: draft.attachments.map(a => ({ key: a.id, name: a.name, status: 'ready', attachment: a })), error: null }`, so the composer is focused and filled.
- **Kept notice:** the `kept` notice renders through the existing notice row, using the item's own `text`.

- [ ] **Step 1: Implement** the components and wiring.
- [ ] **Step 2: Run `npm run typecheck` and `npm run build:server`, expect exit 0.**
- [ ] **Step 3: Run `npm test`, expect every project PASS.**

---

### Task 12: Memory fake, e2e and docs

**Files:**
- Create: `zumi-bot-server/backend/tests/fixtures/fake-memory-claude.mjs`
- Create: `zumi-bot-server/e2e/versions.e2e.mjs`
- Modify: `package.json` (root): add `"e2e:versions": "npm run build && node zumi-bot-server/e2e/versions.e2e.mjs"`
- Modify: `zumi-bot-server/e2e/web.e2e.mjs` (real-CLI check)
- Modify: `CLAUDE.md`

**The fake** (`start({ fake: <path> })` in `harness.mjs` already accepts a custom script):
- Parses `--resume`, `--resume-session-at`, `--fork-session` and `--json-schema` from argv. On a moderator call (`--json-schema`), it drains stdin, prints `{}` and exits 0.
- **Sessions:** stored in `$HOME/.fake-sessions/<id>.json` as `[{ uuid, role, text }]`.
  - A missing session writes stderr `No conversation found with session ID: <id>` and exits 1.
  - An unknown cut uuid writes stderr `No message found with message.uuid of: <uuid>` and exits 1.
  - The cut keeps entries up to and including the uuid. `--fork-session` writes to a new id, unless `FAKE_MEMORY_IGNORE_FORK=1`.
- **Reply:** the words matched by `/remember the word (\w+)/gi` across all user entries (case kept). A message matching `/list every word/i` gets `Words: A, B` (or `Words: none`). Anything else gets `OK`.
- **Output:** stdout gets `system:init` (with `claude_code_version: 'fake'`), one `assistant` line with a `uuid`, and a `result`.

**`versions.e2e.mjs`** (memory fake, headless Chrome, as the other suites do):
- **Single chat:**
  - Send APPLE, then BANANA. Edit BANANA to CHERRY, and expect `2 / 2`.
  - "List every word" gives `Words: APPLE, CHERRY`.
  - Click `‹` on that message and expect `1 / 2`, with BANANA shown. "List every word" gives `Words: APPLE, BANANA`.
  - Reload, and the version and replies are the same. A second tab shows the same.
  - Resend on the latest answer gives `2 / 2` on that list message.
  - Fork on the BANANA answer opens `Fork of …`, where "List every word" gives `Words: APPLE, BANANA`.
  - Fork on the BANANA message opens a chat holding only APPLE, with the composer text `Remember the word BANANA.`
- **Room** (two members, `@mentions`): edit a user message and check the mentioned member's list reply after the edit and after switching back.
- **Fork-ignored:** with `FAKE_MEMORY_IGNORE_FORK=1`, an edit shows the FORK_IGNORED error.

**`web.e2e.mjs`** (real `claude`), the same APPLE/BANANA/CHERRY check in one single chat:
- After the edit, the list contains APPLE and CHERRY and not BANANA.
- After switching back, it contains APPLE and BANANA and not CHERRY.

**`CLAUDE.md`:**
- Edit/Resend/Fork in the Architecture section: hidden `chats/<id>.versions.json`, `end`/`cut` stamps, `next`, held tasks, the hidden CLI flags.
- `npm run e2e:versions` in Commands.
- The line: "Run `npm run e2e` after every Claude Code update: it checks the hidden `--resume-session-at`/`--fork-session` flags edit and resend rely on."
- Add `versions.json` to the Data list.

- [ ] **Step 1: Write the fake and the e2e suite.**
- [ ] **Step 2: Run `npm run e2e:versions`, expect every step PASS.** Kill any Chrome the run leaves behind.
- [ ] **Step 3: Ask the user before running `npm run e2e`** (it uses the real `claude` and their quota). Then run it and expect PASS.
- [ ] **Step 4: Update CLAUDE.md.** Run `npm test` and `npm run typecheck` one last time, expect PASS.
