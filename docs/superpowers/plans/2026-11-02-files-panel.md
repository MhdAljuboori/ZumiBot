# Files Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-chat Files panel listing every file the agent or its subagents changed with `Edit`/`Write` and every file the user attached, with Diff / Old / New previews, a step picker, Copy, Download, Show in chat and Quote / Explain.

**Architecture:** The stream parser keeps the CLI's `tool_use_result` and a subagent's `Edit`/`Write` calls. A per-turn `FileTracker` turns them into `FileChange` records stored on tool items, with whole-file copies in a content-addressed `SnapshotStore` outside the chat JSON. The server builds the list from all visible items (`files:list`) and serves copies over a gated text route; the React panel renders it beside the chat.

**Tech Stack:** TypeScript, Node 22, vitest, React 19, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-02-files-panel-design.md` (read it with this plan; it holds the reasons).

## Global Constraints

- **Never commit.** The user's global rule: no `git commit` unless they ask. Each task ends with a checkpoint (tests + typecheck), not a commit.
- Work only in the worktree `/home/mhdaljuboori/Developments/AI/ZumiBot/.claude/worktrees/files-panel` (branch `files-panel`).
- Only `Edit` and `Write` are tracked, by the agent or its subagents. Nothing else of a subagent reaches the chat.
- Whole-file cap 1 MiB (`1024 * 1024` bytes, UTF-8); a NUL byte or invalid UTF-8 = binary. Patch/snippet cap 256 KiB (`256 * 1024`, summed line text).
- Copies: `<data>/file-snapshots/<chatId>/<sha256 hex>`, files 0600, folders 0700, written atomically.
- The only disk read of an agent's file: right after a subagent `Edit` succeeds, the path that call named, resolved against the chat's `cwd`; regular file only.
- File contents, keys and paths of copies never go into logs or error messages. Logs carry the chat id and a reason only.
- Copies are served as `text/plain; charset=utf-8` with `nosniff`, never rendered as HTML or Markdown. CSP unchanged.
- Every tracking failure is caught and logged; a turn never fails because of this feature.
- Comments short, saying *why*. Dependencies pinned exactly (this plan adds none).
- Real-CLI runs: only Task 3's two fixture recordings (Haiku, a few cents). All e2e uses the fake claude.

## Review Focus

1. **CRLF files and files without a trailing newline.** Copies, Copy and Quote must give the exact text; the diff must not show phantom changes for `\r`. Pinned in Task 1 and Task 5.
2. **Stop pressed while a subagent edit is being recorded.** The pending copy write must finish or drop quietly; no error item, no crash, the chat ends idle. Pinned in Task 6.
3. **A selection mixing removed, added and context lines in the Diff view.** Quote must use new-file numbers of the non-removed rows and keep the selected text as is. Pinned in Task 9.
4. **A `Write` that leaves the content unchanged** (same text). The step shows "No changes", not an empty or broken diff. Pinned in Task 9.
5. **File names with spaces, quotes or non-ASCII in Download.** The header must be RFC 5987 encoded like attachments. Pinned in Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `zumi-bot-server/shared/src/files.ts` (new) | Types: `PatchHunk`, `SnapshotMiss`, `FileChange`, `ChangeStep`, `ChangedFile`, `AttachedFile`, `ChatFileList` |
| `zumi-bot-server/shared/src/lineDiff.ts` (new) | `splitLines`, `diffLines` (Myers, 3 lines context) |
| `zumi-bot-server/shared/src/chatFiles.ts` (new) | `resolvePath`, `shownPath`, `isBookkeeping`, `listChatFiles` |
| `zumi-bot-server/shared/src/types.ts` | `changes?` on tool items; `files.list` in `ZumiBotApi` |
| `zumi-bot-server/backend/src/core/chat/streamParser.ts` | `detail` on `toolResult`; `subToolUse` / `subToolResult` events |
| `zumi-bot-server/backend/src/core/files/snapshotStore.ts` (new) | Content-addressed copies |
| `zumi-bot-server/backend/src/core/files/fileChanges.ts` (new) | `replaceString`, `rebuildBefore`, `FileTracker` |
| `zumi-bot-server/backend/src/core/chat/chatService.ts` | Wire the tracker into `agentTurn` |
| `zumi-bot-server/backend/src/http/files.ts` (new) | `parseFilePath`, `serveSnapshot` |
| `zumi-bot-server/backend/src/http/server.ts`, `rpc/handlers.ts`, `core/chat/fork.ts`, `app.ts` | Route, `files:list`, delete, fork, wiring |
| `zumi-bot-server/deploy/sync.mjs` | `file-snapshots/` both ways |
| `zumi-bot-server/frontend/src/state/filesPanel.ts` (new) | Pure panel logic |
| `zumi-bot-server/frontend/src/useChatFiles.ts`, `useSnapshotText.ts` (new) | List fetch + refresh; copy text fetch + cache |
| `zumi-bot-server/frontend/src/components/FilesChip.tsx`, `FilesPanel.tsx`, `FilePreview.tsx` (new) | UI |
| `zumi-bot-server/frontend/src/components/SelectionMenu.tsx`, `MessageList.tsx`, `ToolCallRow.tsx`, `ChatView.tsx`, `App.tsx`, `styles.css` | Selection scope, Show in chat, chip, panel slot |
| `zumi-bot-server/backend/tests/fixtures/fake-claude.mjs`, `zumi-bot-server/e2e/files.e2e.mjs` (new), `package.json`, `CLAUDE.md` | e2e and docs |

---

### Task 1: Shared types and line diff

**Files:**
- Create: `zumi-bot-server/shared/src/files.ts`, `zumi-bot-server/shared/src/lineDiff.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (tool item, ~line 145)
- Test: `zumi-bot-server/shared/tests/lineDiff.test.ts`

**Interfaces:**
- Produces (`files.ts`):
  ```ts
  export interface PatchHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } // lines prefixed ' ', '-', '+'
  export type SnapshotMiss = 'too-big' | 'binary' | 'not-sent' | 'unrebuilt' | 'unreadable'
  export interface FileChange {
    id: string; ts: number; path: string; op: 'create' | 'update'
    patch: PatchHunk[] | null; before: string | null; after: string | null
    why?: { before?: SnapshotMiss; after?: SnapshotMiss } // set when before/after is null for a reason other than create
    snippet?: { old: string; new: string }
    subagent?: string
  }
  export interface ChangeStep {
    itemId: string; id: string; ts: number; agent?: string; subagent?: string
    op: 'create' | 'update' | 'unknown'
    patch: PatchHunk[] | null; before: string | null; after: string | null
    why?: FileChange['why']; snippet?: FileChange['snippet']
    legacy?: { oldString: string; newString: string } | { content: string }
  }
  export interface ChangedFile { path: string; shown: string; created: boolean; changes: ChangeStep[] } // changes oldest first
  export interface AttachedFile { itemId: string; ts: number; attachment: Attachment }
  export interface ChatFileList { changed: ChangedFile[]; attached: AttachedFile[] }
  ```
- Produces (`lineDiff.ts`): `splitLines(text: string): string[]` (splits on `\n` only; a trailing `\n` adds no empty last line; `\r` stays in the line), `diffLines(a: string, b: string, context?: number): PatchHunk[]` (default context 3; equal texts → `[]`).
- Tool item in `types.ts` gains `changes?: import('./files').FileChange[]` with a short comment.

- [ ] **Step 1: Write the failing tests** in `shared/tests/lineDiff.test.ts`:
  - `splitLines('a\nb\n')` → `['a','b']`; `splitLines('a\nb')` → `['a','b']`; `splitLines('')` → `[]`; `splitLines('a\r\nb\r\n')` → `['a\r','b\r']`.
  - `diffLines('a\nb\nc\n', 'a\nB\nc\n')` → `[{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }]`.
  - Creating from empty: `diffLines('', 'x\ny\n')` → `[{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }]`.
  - Two changes 10 lines apart in a 30-line file → two hunks, each with 3 context lines either side.
  - CRLF in both texts with one changed line → only that line in `-`/`+`.
  - Same text → `[]`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/lineDiff.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `files.ts`, `lineDiff.ts` (Myers O(ND) on line arrays, then group into hunks with `context` lines; 1-based starts, `oldStart`/`newStart` 0 when the side has no lines) and the `changes?` field.
- [ ] **Step 4: Run** the test file — expect PASS. Run `npm run typecheck` — expect no errors.
- [ ] **Step 5: Checkpoint** (no commit).

### Task 2: Building the list (`chatFiles.ts`)

**Files:**
- Create: `zumi-bot-server/shared/src/chatFiles.ts`
- Test: `zumi-bot-server/shared/tests/chatFiles.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `resolvePath(p: string, cwd: string): string` — POSIX only, pure string ops (no `node:path`; shared also runs in the browser): absolute `p` normalized, else `cwd + '/' + p` normalized (`.`/`..`/double slashes).
  - `shownPath(path: string, cwd: string, home: string): string` — relative to `cwd` when inside it, else `~/…` when inside `home`, else `path`.
  - `isBookkeeping(path: string, home: string): boolean` — true under `${home}/.claude/projects/<any>/memory/` or `${home}/.claude/plans/`.
  - `listChatFiles(items: readonly ChatItem[], cwd: string, home: string): ChatFileList`.

Rules for `listChatFiles`:
- Every `FileChange` in a tool item's `changes` becomes a `ChangeStep` with `itemId` = that item's id and `agent` = the item's `agent`.
- A tool item named `Edit` or `Write` with no `changes`, `isError === false`, `blocked === false` and `result !== null` is legacy: `Edit` → `op: 'update'`, `legacy: { oldString, newString }` from input; `Write` → `op: 'unknown'`, `legacy: { content }`; path from `input.file_path` through `resolvePath`. Inputs that are not strings are skipped.
- Steps grouped by `path` (exact string), each file's steps oldest first; files ordered by their latest step `ts`, newest first. `created` = first step's `op === 'create'`.
- Bookkeeping paths left out.
- `attached`: one entry per attachment of each `user` item, newest first.

- [ ] **Step 1: Write the failing tests:**
  - `resolvePath('a/../b.txt', '/w')` → `'/w/b.txt'`; `resolvePath('/x//y/./z', '/w')` → `'/x/y/z'`.
  - `shownPath('/w/d/a.md', '/w', '/h')` → `'d/a.md'`; `shownPath('/h/n.txt', '/w', '/h')` → `'~/n.txt'`; `shownPath('/etc/x', '/w', '/h')` → `'/etc/x'`.
  - `isBookkeeping('/h/.claude/projects/p/memory/x.md', '/h')` true; `isBookkeeping('/h/.claude/agents/a.md', '/h')` false.
  - Two tool items changing `/w/a.md` at ts 10 and 30 and one changing `/w/b.md` at ts 20 → `changed[0].path === '/w/a.md'` with 2 changes in order 10, 30; `changed[1].path === '/w/b.md'`.
  - An `Agent` item with two `changes` for different files → two files, each step `itemId` = the Agent item id, `subagent` kept.
  - A legacy `Edit` item → step with `legacy: { oldString, newString }`; a legacy `Edit` with `isError: true` → not listed.
  - A memory-file change → not listed.
  - A user item with two attachments → two `attached` entries.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/chatFiles.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `chatFiles.ts`.
- [ ] **Step 4: Run** — expect PASS; `npm run typecheck` clean.
- [ ] **Step 5: Checkpoint.**

### Task 3: Parser keeps tool results and subagent edits

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/streamParser.ts` (`RunEvent`, `parseLine` ~line 86 and `case 'user'`)
- Create: `zumi-bot-server/backend/tests/fixtures/stream/files-own.jsonl`, `files-subagent.jsonl`
- Test: `zumi-bot-server/backend/tests/core/streamParser.test.ts`

**Interfaces:**
- Produces:
  ```ts
  | { kind: 'toolResult'; toolUseId: string; content: string; isError: boolean; detail?: unknown } // detail = the line's tool_use_result, when it is an object
  | { kind: 'subToolUse'; parent: string; id: string; name: string; input: unknown; subagent: string | null }
  | { kind: 'subToolResult'; parent: string; toolUseId: string; content: string; isError: boolean }
  ```
- `subToolUse` is emitted only for names `Edit`, `Write`, `Agent`, `Task` (the last two let nested parents be followed). `subToolResult` for every `tool_result` on a subagent `user` line. Subagent text, deltas, usage and entries stay dropped. `detail` is attached to every `tool_result` block of that line (the CLI sends one result per line).

- [ ] **Step 1: Record the fixtures** (real CLI, Haiku; the only quota this plan spends). In a fresh `mktemp -d` folder holding `a.txt` = `alpha\nbeta\ngamma\n` and `c.txt` = `old body\n`, run with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude -p --model haiku --permission-mode acceptEdits --allowedTools "Agent Edit Write Read" --output-format stream-json --verbose < /dev/null "<prompt>"`:
  - `files-own.jsonl`: "Use Edit to change beta to BETA in a.txt. Use Write to create b.txt with the text hello. Read c.txt, then use Write to overwrite c.txt with new body. No other tools."
  - `files-subagent.jsonl` (fresh folder): "Use the Agent tool once, subagent_type general-purpose, with this task: 'In the current folder, use Edit to change beta to BETA in a.txt, then Write c.txt with the text new body.' Do nothing else yourself."
  - Replace the temp folder path with `/work` in both files (`sed -i "s#$DIR#/work#g"`). Note in the test whether `Write` update carried `originalFile` (the spec's open point).
- [ ] **Step 2: Write the failing tests:**
  - `files-own`: the `Edit` result's `detail` has `originalFile === 'alpha\nbeta\ngamma\n'` and a `structuredPatch` array; the create `Write` has `detail.type === 'create'`; the overwrite `Write` has `detail.type === 'update'` (assert `originalFile` as recorded).
  - `files-subagent`: events include `subToolUse` for `Edit` and `Write` with `parent` = the top-level `Agent` tool id and `subagent === 'general-purpose'`; `subToolResult` for each with matching `toolUseId`; no `assistantText`, `textDelta`, `context` or `entry` comes from subagent lines; no `subToolUse` for `Read`.
  - Update the existing test "subagent … are ignored" (line 72): a subagent `Read` tool_use still yields `[]`; a subagent `tool_result` now yields one `subToolResult`.
  - A `tool_use_result` that is a string or null → `toolResult` without `detail`.
- [ ] **Step 3: Run** `npx vitest run zumi-bot-server/backend/tests/core/streamParser.test.ts` — expect FAIL.
- [ ] **Step 4: Implement** in `parseLine`: replace the early `return []` for subagent lines with a branch that emits only the two new events (`subagent` from the line's `subagent_type`). Update the `entryOf` comment.
- [ ] **Step 5: Run** — expect PASS; run `npx vitest run --project backend` — expect no other failures (ChatService ignores the new kinds until Task 6).
- [ ] **Step 6: Checkpoint.**

### Task 4: SnapshotStore

**Files:**
- Create: `zumi-bot-server/backend/src/core/files/snapshotStore.ts`
- Test: `zumi-bot-server/backend/tests/core/snapshotStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SNAPSHOT_MAX_BYTES = 1024 * 1024
  export const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/
  export type Kept = { id: string } | { miss: 'too-big' | 'binary' }
  export class SnapshotStore {
    constructor(root: string)
    put(chatId: string, text: string): Promise<Kept> // id = sha256 hex of UTF-8 bytes; existing file reused
    read(chatId: string, id: string): Promise<string | null>
    pathOf(chatId: string, id: string): string | null // null on a bad chat id or id
    copy(fromChat: string, toChat: string, ids: Iterable<string>): Promise<void> // missing source skipped
    removeChat(chatId: string): Promise<void>
  }
  ```
- Chat ids checked with the same `/^[A-Za-z0-9-]+$/` as `AttachmentStore` (export it from there or repeat it). Atomic write via the existing helper used by `ChatStore` (`writeFileAtomic` in `core/fsutil.ts`), then mode 0600; folders 0700.

- [ ] **Step 1: Write the failing tests:** `put` returns a 64-hex id and `read` gives the same text (include a CRLF text and one without a trailing newline); `put` twice → same id, one file; file mode `0o600`, folder `0o700`; text of `SNAPSHOT_MAX_BYTES + 1` bytes → `{ miss: 'too-big' }`; text with `\u0000` → `{ miss: 'binary' }`; `read` with `'../x'` or a bad id → `null`; `copy` copies listed ids and skips missing; `removeChat` removes the folder; `pathOf('a/b', id)` → `null`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/snapshotStore.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 5: FileTracker

**Files:**
- Create: `zumi-bot-server/backend/src/core/files/fileChanges.ts`
- Test: `zumi-bot-server/backend/tests/core/fileChanges.test.ts`

**Interfaces:**
- Consumes: `SnapshotStore` (`put`, `read`), `diffLines`, `resolvePath`, Task 3 event shapes.
- Produces:
  ```ts
  export const PATCH_MAX_BYTES = 256 * 1024
  export function replaceString(text: string, find: string, repl: string, all: boolean): string | null // null: find empty, absent, or (not all) found more than once
  export function rebuildBefore(after: string, edit: { old: string; new: string; all: boolean }, prior: string | null): string | null
  export interface TrackerDeps {
    cwd: string; chatId: string
    snapshots: Pick<SnapshotStore, 'put' | 'read'>
    now(): number
    items(): readonly ChatItem[] // the turn's live list, for earlier copies and parent items
    readFile(path: string): Promise<Buffer> // must reject unless a regular file; app passes an fstat-checked read
    log(msg: string, err?: unknown): void
  }
  export class FileTracker {
    constructor(d: TrackerDeps)
    own(tool: { id: string; name: string; input: unknown }, detail: unknown): Promise<FileChange | null>
    subUse(e: Extract<RunEvent, { kind: 'subToolUse' }>): void
    subResult(e: Extract<RunEvent, { kind: 'subToolResult' }>): Promise<{ itemId: string; change: FileChange } | null>
  }
  ```

Rules (from the spec, *Data*):
- `own`, `Edit`: before = `detail.originalFile` (string) else null with `why.before = 'not-sent'`; after = `replaceString(originalFile, oldString, newString, replaceAll)` (strings from `detail`, falling back to `input`), null → `why.after = 'unrebuilt'`; patch = `detail.structuredPatch` when an array of well-formed hunks within `PATCH_MAX_BYTES`, else null. (Decision: string replacement is what `Edit` does, so it is exact where re-applying hunks can trip on CRLF.)
- `own`, `Write`: `detail.type === 'create'` → op create, before null, after = content; `'update'` → before = `originalFile` when a string else null with `why.before = 'not-sent'`, after = content, patch as above.
- `own`: other names, a `detail` that is not an object, or a missing path → `null`.
- `subUse`: remembers `Edit`/`Write` calls by id; remembers `Agent`/`Task` ids → their parent.
- `subResult` (errors → null; unknown id → null): the top-level item id = follow `parent` through remembered sub `Agent`/`Task` ids until an id that is a `tool` item in `items()`; none → null.
  - `Edit`: **start the disk read synchronously inside `subResult`, before any `await`** (spec: read at once). After = decoded file (`TextDecoder('utf-8', { fatal: true })`; NUL or decode error → `why.after = 'binary'`; over cap → `'too-big'`; read rejects → `'unreadable'`). Prior = text of the newest earlier `FileChange` with the same `path` and non-null `after` in `items()` (via `snapshots.read`). Before = `rebuildBefore(after, edit, prior)`, null → `why.before = 'unrebuilt'`. Patch = `diffLines(before, after)` when both, else null with `snippet` (within cap).
  - `Write`: result `content` starting `File created successfully` → op create; else update with before null, `why.before = 'not-sent'`. After = input content.
  - `subagent` = the call's `subagent` when not null.
- `rebuildBefore`: (1) `prior !== null && replaceString(prior, old, new, all) === after` → `prior`; (2) else if `!all && new !== ''` and `new` occurs exactly once in `after`: candidate = that occurrence replaced by `old`; return candidate when `replaceString(candidate, old, new, false) === after`; (3) else `null`.
- Copies are written with `snapshots.put`; a `{ miss }` sets the matching `why`. `path` = `resolvePath(file_path, cwd)`. `ts` = `now()` when the result arrives.
- Never throws: every public method catches, logs `log('file change not recorded', err)` with no contents, and resolves `null`.

- [ ] **Step 1: Write the failing tests** (a real `SnapshotStore` in a temp dir; `readFile` stubbed or real temp files):
  - `replaceString('a b a', 'a', 'x', false)` → `null`; `(…, true)` → `'x b x'`; `replaceString('abc', 'b', 'B', false)` → `'aBc'`; empty `find` → `null`.
  - `rebuildBefore('aBc', { old: 'b', new: 'B', all: false }, null)` → `'abc'`; `rebuildBefore('B B', { old: 'b', new: 'B', all: false }, null)` → `null`; with prior `'b B'` → `'b B'`; `new === ''` with no prior → `null`.
  - `own` Edit from the `files-own.jsonl` result (parse the fixture with `parseLine`): before/after read back as `'alpha\nbeta\ngamma\n'` / `'alpha\nBETA\ngamma\n'`, `op: 'update'`, patch with one hunk.
  - `own` Write create → `op: 'create'`, `before: null`, no `why.before`; Write update without `originalFile` → `why.before === 'not-sent'`.
  - `own` on a CRLF `originalFile` → after keeps `\r\n` exactly.
  - Subagent from `files-subagent.jsonl`: feed every parsed event (`subUse` for `subToolUse`, `subResult` for `subToolResult`) with `items()` holding the top-level `Agent` tool item and a temp file holding the edited text → the `Edit` yields `{ itemId: <Agent id>, change }` with before `'alpha\nbeta\ngamma\n'`, `subagent: 'general-purpose'`, and a computed patch; the overwrite `Write` yields `why.before === 'not-sent'`.
  - `readFile` rejects → `why.after === 'unreadable'`, before null, `snippet` set.
  - Disk read starts before the first `await`: `subResult` with a `readFile` spy → spy called synchronously (check right after the call, before awaiting).
  - Nested parent: sub `Agent` id → top-level id resolves; unknown parent → `null`.
  - `snapshots.put` rejects → `null` and `log` called once, message has no file text.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/fileChanges.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 6: Wire the tracker into ChatService and app

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`ChatServiceDeps` ~line 31; `agentTurn` ~lines 517-1000: `onEvent`, the `try` that loads `meta`)
- Modify: `zumi-bot-server/backend/src/app.ts` (~line 141 and `new ChatService` ~line 202)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: `FileTracker`, `SnapshotStore`.
- Produces: `ChatServiceDeps.snapshots?: Pick<SnapshotStore, 'put' | 'read'>` and `ChatServiceDeps.readFile?: (path: string) => Promise<Buffer>`. `app.ts` builds `const snapshots = new SnapshotStore(join(dataDir, 'file-snapshots'))` and a `readFile` that opens the path, `fstat`s it, rejects unless `isFile()`, and reads at most `SNAPSHOT_MAX_BYTES + 1` bytes. Later tasks use the same `snapshots` instance.

Wiring in `agentTurn`:
- After `meta` is loaded, create `tracker = new FileTracker({ cwd: meta.cwd, chatId, snapshots, now, items: () => ref.get(), readFile, log })` when `snapshots` is set.
- `toolResult`: after the existing `patchTool`, when `!e.isError` and the tool item's name is `Edit` or `Write`, call `track(itemId, tracker.own(item, e.detail))`.
- `subToolUse` → `tracker.subUse(e)`; `subToolResult` → `track(tracker.subResult(e))` (call `subResult` synchronously in the event handler so its read starts at once).
- `track` hands the promise to the existing `later(...)` chain: when it resolves to a change, `patchTool(itemId, t => ({ changes: [...(t.changes ?? []), change] }))` then `saveAndPush(false)`. The turn's final `await pending` already waits for it.
- Browser tools (`mcp__zumibot_browser__*`) never reach the tracker.

- [ ] **Step 1: Write the failing tests** (use the existing `makeService`, with `snapshots: new SnapshotStore(join(dir, 'snap'))` and a stub `readFile`):
  - A script with `toolUse` Edit + `toolResult` carrying `detail` (from the Task 3 fixture) → after the turn, the stored tool item has one `changes` entry whose `before`/`after` read back correctly.
  - A script with `toolUse` Agent, `subToolUse` Edit, `subToolResult`, then the Agent's `toolResult` → the Agent item has one change with `subagent` set, and the subagent's text never appears as items.
  - `toolResult` with `isError: true` → no `changes`.
  - `readFile` rejecting and `snapshots.put` rejecting → the turn still ends with `ok`, no error item, chat not `inFlight`.
  - **Review Focus 2:** a `hang` script that emits the subagent events, then `svc.stop(chatId)` before `readFile` resolves (stub returns a deferred) → resolve it afterwards; the chat ends idle with a `stopped` notice and no error item.
  - Without `snapshots` in deps → no `changes`, everything else unchanged.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts` — expect FAIL on the new tests only.
- [ ] **Step 3: Implement** the wiring and `app.ts` construction.
- [ ] **Step 4: Run** the file, then `npx vitest run --project backend` and `npm run typecheck` — expect PASS / clean.
- [ ] **Step 5: Checkpoint.**

### Task 7: `files:list`, content route, delete and fork

**Files:**
- Create: `zumi-bot-server/backend/src/http/files.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi`: new `files` area), `backend/src/rpc/handlers.ts` (deps, `files:list`, `chats:remove` ~line 363, `chats:fork` ~line 313), `backend/src/core/chat/fork.ts`, `backend/src/http/server.ts` (`AppServerOptions`, API branch), `backend/src/app.ts`, `frontend/src/net/api.ts`
- Test: `backend/tests/http/files.test.ts`, `backend/tests/rpc/handlers.test.ts`, `backend/tests/core/fork.test.ts`

**Interfaces:**
- Consumes: `listChatFiles`, `SnapshotStore`.
- Produces:
  - `ZumiBotApi.files: { list(chatId: string): Promise<ChatFileList> }`; handler `'files:list'` = `listChatFiles(await chats.loadItems(id), meta.cwd, homedir())`, throwing `Chat not found: <id>` when absent; `api.ts` maps `files.list` to `call('files:list', chatId)`.
  - `parseFilePath(pathname: string): { chatId: string; id: string } | null` for `^/api/files/([A-Za-z0-9-]+)/([0-9a-f]{64})$`.
  - `serveSnapshot(req, res, snapshots: Pick<SnapshotStore, 'pathOf'>, p: { chatId: string; id: string }, download: string | null): Promise<void>`: 404 JSON when missing; headers `Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=31536000, immutable`; `download` (from `?download=<name>`) adds `Content-Disposition` built exactly like `http/attachments.ts` line 64 (export its `asciiName`/`encode5987` helpers rather than copying).
  - `AppServerOptions.snapshots?: Pick<SnapshotStore, 'pathOf'>`; route added inside the gated `isApi` branch, GET/HEAD only.
  - `ForkDeps.snapshots?: Pick<SnapshotStore, 'copy' | 'removeChat'>`: after `copyFiles`, copy every non-null `before`/`after` of the copied items' `changes` to the new chat; the existing failure path also calls `snapshots.removeChat(fresh.id)`.
  - `chats:remove`: after attachments, `snapshots.removeChat(id)` in its own try/catch with `console.error('removing file copies failed:', err)`.

- [ ] **Step 1: Write the failing tests:**
  - `files.test.ts` with `tests/http/helpers.ts`: signed-out GET → 401; bad id (63 hex, `..`) → 404; good id → 200, body = copy text, `content-type` `text/plain; charset=utf-8`, `x-content-type-options: nosniff`; **Review Focus 5:** `?download=my "draft" é.md` → `content-disposition` contains `filename*=UTF-8''my%20%22draft%22%20%C3%A9.md` and an ASCII fallback with no quote.
  - `handlers.test.ts`: `files:list` returns a list built from stored items; unknown chat rejects; `chats:remove` calls `snapshots.removeChat`.
  - `fork.test.ts`: forking a chat whose copied tool item has `changes` → the new chat's snapshot folder holds those ids; a hidden-version item's ids are not copied.
- [ ] **Step 2: Run** the three files — expect FAIL.
- [ ] **Step 3: Implement**, wiring `snapshots` through `app.ts` into `createHandlers`, `createAppServer` and the fork call.
- [ ] **Step 4: Run** the files, `npx vitest run --project backend`, `npm run typecheck` — expect PASS / clean.
- [ ] **Step 5: Checkpoint.**

### Task 8: Sync carries `file-snapshots/`

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs` (copies loop ~line 395, attachments union ~line 420, upload `sources` ~line 444, swap script ~line 460)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

**Interfaces:** none new. Same handling as `attachments/` in each of the four places: a copy chat gets `file-snapshots/<id>` copied to `file-snapshots/<newId>`; VPS copies are unioned in with `cpSync(..., { recursive: true, force: false, preserveTimestamps: true })`; `file-snapshots` joins the upload `sources` when it exists; the swap runs `[ ! -d "$I/file-snapshots" ] || rsync -a "$I/file-snapshots/" "$D/file-snapshots/"`.

- [ ] **Step 1: Write the failing tests** next to the attachments cases: a VPS-only snapshot arrives locally; the upload args include `file-snapshots` only when the folder exists (update the expectation at line 342 only for the new case); the versions-differ copy case (line 453) also copies `file-snapshots/ed/<hex>` to the copy's id.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/sync.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 9: Pure panel logic (`state/filesPanel.ts`)

**Files:**
- Create: `zumi-bot-server/frontend/src/state/filesPanel.ts`
- Test: `zumi-bot-server/frontend/tests/filesPanel.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `diffLines`.
- Produces:
  ```ts
  export type FileView = 'diff' | 'old' | 'new'
  export type StepPick = 'all' | number // index into ChangedFile.changes
  export type MissReason = SnapshotMiss | 'created' | 'legacy'
  export type Side = { id: string } | { text: string } | { miss: MissReason }
  export const MISS_TEXT: Record<MissReason, string>
  export function sidesOf(file: ChangedFile, pick: StepPick): { before: Side; after: Side }
  export type DiffSource =
    | { kind: 'patch'; hunks: PatchHunk[] }
    | { kind: 'texts'; before: Side; after: Side }
    | { kind: 'strings'; old: string; new: string } // snippet or legacy: no line numbers
    | { kind: 'steps'; parts: Array<{ label: string; source: Exclude<DiffSource, { kind: 'steps' }> }> }
  export function diffSource(file: ChangedFile, pick: StepPick, label: (i: number) => string): DiffSource
  export type Row =
    | { kind: 'hunk' | 'step' | 'same'; text: string }
    | { kind: 'ctx' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null }
  export function rowsFromHunks(hunks: PatchHunk[]): Row[]
  export function rowsFromStrings(old: string, neu: string): Row[]
  export function rowsOfText(text: string, view: 'old' | 'new'): Row[]
  export function selectedLines(rows: Row[], a: number, b: number, view: FileView): { from: number; to: number; old: boolean } | null
  export function quoteBlock(shown: string, lines: ReturnType<typeof selectedLines>, text: string): string
  export function withFileQuote(draft: string, block: string): string
  export function explainFileText(block: string, member?: string): string
  export function whoLabel(step: ChangeStep, name: (agent: string) => string): string
  export function filesCount(list: ChatFileList | null): number
  ```

Copy (exact strings):
- `MISS_TEXT`: `created` "File did not exist before this chat"; `too-big` "Not kept: file over 1 MB"; `binary` "Not kept: binary file"; `not-sent` "Not kept: Claude Code didn't send this version"; `unrebuilt` "Not kept: couldn't rebuild the old file exactly"; `unreadable` "Not kept: couldn't read the file after the change"; `legacy` "Not kept for changes made before this feature".
- No-difference row text: "No changes".

Rules:
- `sidesOf` one step: before = `{id}` / `{miss:'created'}` for create / `{miss: why.before}` / `{miss:'legacy'}`; after = `{id}` / `{text: legacy.content}` for a legacy Write / `{miss: why.after}` / `{miss:'legacy'}`. `'all'`: before of the first step, after of the last.
- `diffSource` one step: `patch` when non-null → `patch`; else both sides `{id}` → `texts`; else `snippet`/`legacy` Edit strings → `strings`; else `texts` (the component shows the miss text). `'all'`: `texts` when the first before and last after are both usable (`{id}`, or `created` for the first before); else `steps` over every step's own source.
- `rowsFromHunks([])` and `texts` with equal sides → `[{ kind: 'same', text: 'No changes' }]`.
- `selectedLines`: rows `a..b` inclusive (either order). View `old` → old numbers, `old: true`. Views `new`/`diff`: numbered non-`del` rows give `newNo` range, `old: false`; when every numbered row selected is `del` → their `oldNo` range, `old: true`. No numbered row → `null`.
- `quoteBlock`: first line `` `shown:from-to` `` (`:n` when from = to; `` `shown` `` alone when lines is null), then `` (old)`` after the closing backtick when `old`; then a fence of `max(3, longest backtick run in text + 1)` backticks, the text, the fence.
- `withFileQuote(draft, block)` → `draft.trimEnd()` + (`'\n'` when that is non-empty) + block + `'\n'`.
- `explainFileText(block, member)` → (`'@' + member + ' '` when given) + block + `'\nExplain this selected text'`.
- `whoLabel` → `name(agent)` or `name(agent) + ' › ' + subagent`; no agent (single chat) → the subagent alone, or `''`.
- `filesCount` → changed + attached, 0 for null.

- [ ] **Step 1: Write the failing tests** covering each rule above with exact strings, plus:
  - **Review Focus 3:** Diff rows `[ctx 4/4, del 5/-, add -/5, ctx 6/6]`, selection over all four → `{ from: 4, to: 6, old: false }`; only the `del` row → `{ from: 5, to: 5, old: true }`.
  - **Review Focus 4:** a `Write` update step whose before and after ids are equal → `diffSource` gives `texts` and the rows for equal texts are `[{ kind: 'same', text: 'No changes' }]`.
  - `quoteBlock('a.md', {from:2,to:3,old:false}, 'x ``` y')` uses a 4-backtick fence.
  - `rowsOfText('a\r\nb', 'new')` → row texts `'a\r'` and `'b'`, numbered 1 and 2 (the `\r` is kept; the component trims it for display only).
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/filesPanel.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 10: Panel UI

**Files:**
- Create: `zumi-bot-server/frontend/src/useChatFiles.ts`, `useSnapshotText.ts`, `components/FilesChip.tsx`, `components/FilesPanel.tsx`, `components/FilePreview.tsx`
- Modify: `components/SelectionMenu.tsx`, `components/MessageList.tsx` (`jumpTo` ~line 343), `components/ToolCallRow.tsx` (line 13), `components/ChatView.tsx` (`cost` ~line 277, `GroupPickers` ~line 90, Props), `App.tsx` (right slot ~line 1107, Esc handling), `styles.css`

**Interfaces:**
- Consumes: `api.files.list`, Task 9 module, the content route.
- Produces:
  - `useChatFiles(chatId: string | null, connected: boolean): ChatFileList | null` — fetch on chat change and reconnect; refetch 500 ms after the last `chats:push` of kind `items` for that chat; a response for a chat no longer shown is dropped.
  - `useSnapshotText(chatId: string, side: Side | null): { text: string | null; failed: boolean }` — `{id}` fetched from `/api/files/<chatId>/<id>` with `credentials: 'same-origin'`, cached by id in a module `Map` (copies never change).
  - `FilesChip({ count, open, onToggle })` — `data-testid="files-chip"`, label `Files ${count}`, hidden at 0, `aria-pressed={open}`.
  - `FilesPanel({ chat, list, agents, onClose, onShow, onQuote, onExplain })` with `onShow(itemId: string)`, `onQuote(block: string)`, `onExplain: ((block: string, member?: string) => void) | null` (null when sending is not possible). Test ids: `files-panel`, `files-close`, `file-row` (+ `data-path`), `attached-row`, `file-view-diff|old|new`, `file-step` (a `<select>`), `file-copy`, `file-download`, `file-show`, `file-miss`, `diff-row` (+ `data-kind`).
  - `useMessageSelection(root, scope?: string)`: `scope` defaults to the current agent-bubble selector; the selection gains `rows: [number, number] | null` read from the closest `[data-row]` of anchor and focus. MessageList keeps its current call.
  - `ToolCallRow` root gets `data-tool-id={item.id}`. MessageList takes `showRequest: { itemId: string; n: number } | null`: on a new `n`, open tool runs (`onToolsOpenChange(true)`), find `[data-item-id=…] .bubble` or `[data-tool-id=…]`, call `onLoadOlder` while not found and `hasOlder`, then scroll and flash as `jumpTo` does.

Behaviour (spec *UI*):
- `App` holds `filesOpen` and `showRequest`; calls `useChatFiles` for the open chat; passes the count and toggle to `ChatView`, which puts `<FilesChip>` next to the cost chip in single chats and in `GroupPickers`. The panel renders in the right slot; while it is open the browser panel is hidden and comes back when it closes (decision: one side panel at a time). It stays open across chat switches with the selection reset. Esc closes it unless a dialog or menu is open.
- On phone widths the panel is a full-screen sheet, using the breakpoint the mobile layout already uses in `styles.css`.
- List rows: one colour dot per agent that changed the file (the agent colour the sidebar already uses), file name, folder in muted text, **new** badge when `created`, "N changes"; full `path` as the row's title.
- Preview: toolbar (Diff/Old/New, step select with "All changes" + `whoLabel` steps, Copy, Download), meta line with `shown`, change count and **Show in chat ↗**; rows from Task 9 with line-number gutters and `data-row` indexes; miss sides show `MISS_TEXT` in `file-miss`. Copy uses `navigator.clipboard.writeText` with the text of `sidesOf(...).before` in the Old view and `.after` otherwise, disabled when that side is a miss. Download links to the route with `?download=<file name>`.
- While a reply runs the list refreshes; "All changes" follows the newest step, a picked step index stays put.
- Attachments: images inline via the existing attachment route; text MIME up to 1 MiB as `rowsOfText`; others Open/Download through existing routes; Show in chat goes to the user message.
- Selection inside the preview shows `SelectionMenu`: Quote → `onQuote(quoteBlock(...))` → App sets the draft with `withFileQuote` and focuses the composer; Explain → `onExplain(block, member)` → App sends `explainFileText(block, member)` with no `replyTo`. `member` = the shown step's `agent` (last step for All changes) in rooms, undefined elsewhere and for attachments.
- Colours and spacing from the `styles.css` tokens; rows use `font-family: var(--font-mono)`, `unicode-bidi: plaintext`, and trim a trailing `\r` for display only.

- [ ] **Step 1: Implement** the hooks, components and wiring.
- [ ] **Step 2: Run** `npm run typecheck` and `npx vitest run --project frontend` — expect clean / PASS (Task 9 tests and the existing selection-free suites).
- [ ] **Step 3: Build** `npm run build:server` — expect success. (Behaviour is checked by Task 11's e2e.)
- [ ] **Step 4: Checkpoint.**

### Task 11: Fake claude, e2e and docs

**Files:**
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-claude.mjs` (script loop ~line 60), `package.json` (scripts), `CLAUDE.md`
- Create: `zumi-bot-server/e2e/files.e2e.mjs`, `zumi-bot-server/e2e/fixtures/files-script.jsonl`

**Interfaces:**
- Fake claude directive: a script line `#WRITEFILE {"path":"<relative to cwd>","content":"<text>"}` writes the file in the process cwd, then continues (lets the server's disk read find the subagent's edit).
- `package.json`: `"e2e:files": "npm run build && node zumi-bot-server/e2e/files.e2e.mjs"`.

- [ ] **Step 1: Add** the `#WRITEFILE` directive.
- [ ] **Step 2: Write** `files-script.jsonl` from the Task 3 fixtures' shapes, with `/work` replaced by relative paths: init; own `Edit` of `post.md` (with `tool_use_result.originalFile`); own `Write` create of `notes.txt`; an `Agent` tool_use; subagent `Edit` of `config.json` (`parent_tool_use_id` = the Agent id), `#WRITEFILE` with the edited `config.json`, its `tool_result`; the Agent's `tool_result`; an assistant reply; `result`. Seed `post.md` and `config.json` in the chat folder before sending.
- [ ] **Step 3: Write** `files.e2e.mjs` modelled on `markdown.e2e.mjs` (same hard rules: throwaway HOME/data/agents, 3-minute timeout, cleanup in `finally`). It checks, in order: the chip shows `Files 4` after a message with one image attached and the script run; the panel lists `post.md` (badge-less, 1 change), `notes.txt` (**new**), `config.json` (label contains `› general-purpose`) and the attachment; Diff rows for `post.md` show the edit with line numbers; Old and New show whole files; the step select lists steps; Copy puts the New text on the clipboard (grant clipboard permission over CDP); selecting two New lines and pressing Quote fills the composer with `` `post.md:2-3` `` and a fenced block; Show in chat on `config.json` scrolls to and flashes the Agent tool row; the attachment previews as an image; Fork at the last agent message → the new chat's panel lists the same files and Old/New load; deleting the source chat removes `file-snapshots/<id>` from the data dir.
- [ ] **Step 4: Run** `npm run e2e:files` — expect every `ok` line and exit 0.
- [ ] **Step 5: Update `CLAUDE.md`:** a **Files panel** paragraph under Architecture (parser `detail` and subagent events, `FileTracker`, `SnapshotStore`, the one disk read, `files:list`, `/api/files/<chatId>/<id>`, `state/filesPanel.ts`, design link); `file-snapshots/` (0600, synced like attachments) in the Data list and the `npm run sync` paragraph; `e2e:files` (fake claude only, costs no quota) under Commands.
- [ ] **Step 6: Run** `npm test` and `npm run typecheck` — expect all green (the known flaky `app.test.ts` teardown `ENOTEMPTY` passes on rerun).
- [ ] **Step 7: Checkpoint.** Kill any Chrome the e2e left behind (`pgrep -f headless` should show none from this run).
