# Agent Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, edit, search and cap each agent's Claude Code memory (`memory: user` → `~/.claude/agent-memory/<agent>/`) in ZumiBot, tell the chat when a reply touched it, and carry it through renames, deletes and sync.

**Architecture:** No new store: the files Claude Code writes are the data. A pure `shared/src/memory.ts` reads and writes the file format; `backend/src/core/memory/` lists, edits, repairs, moves and watches the folders; `ChatService.agentTurn` appends a cap note, counts the agent's memory writes and stamps the turn's last item; the frontend adds a Memory section to Agent Studio and a line under replies.

**Tech Stack:** TypeScript, Node ≥ 22, `yaml` (already a dependency), React 19, vitest, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-02-agent-memory-design.md` (read it first; this plan only adds the decisions it leaves open).

## Global Constraints

- Work only in the worktree `/home/mhdaljuboori/Developments/AI/ZumiBot/.claude/worktrees/agent-memory` (branch `agent-memory`).
- **No per-task commits.** The user's rule: commit only when told. They asked for exactly: one commit of the changes, `npm run bump:minor`, one commit of the bump, then merge into `master` (Task 11).
- Commit messages: one plain paragraph of 15–25 words, terse, no `feat:`/`fix:` prefix, no `Co-Authored-By` line (user's global rule overrides the harness attribution).
- No new dependencies; versions stay pinned.
- Comments short, saying *why*, in the repo's style.
- Memory text never goes into logs, errors, notifications or the appended system prompt (counts only).
- Limit choices `25, 50, 100, 150`; default `100`; index lines the agent sees: `200`.
- Input limits: title 1–100 chars one line; description 0–150 chars one line; body 1–8000 chars; client file names ≤ 200 chars.
- Types: `user`, `feedback`, `project`, `reference`; any other value is kept as is and grouped as "Other".
- Exact copy (from the spec): cap block under the limit `Agent memory: you have {n} of at most {limit} memories.`; at or over `Agent memory is full ({n} of {limit}). Do not add a new memory file. To save something new, update a related memory with the combined text, or merge two related memories into one and delete the other. Never delete a memory that is still true only to make room. If nothing can be merged, tell the user that memory is full.`; conflict error `This memory changed since you opened it.`; full error `This agent has reached its limit of {limit} memories. Edit, merge or delete one before adding another.`

## Review Focus

1. **A memory file the agent wrote oddly** (no frontmatter, CRLF line ends, plain `type:` instead of `metadata.type`, an upper-case file name like `User_Role.md`): it lists, edits and deletes, and an edit keeps its unknown keys and line ends. Tests in Task 1 and Task 3.
2. **A hand-written or messy `MEMORY.md`** (prose lines, blank lines, a line for a missing file, no trailing newline): repair and edits change only the one line they own and keep every other byte. Tests in Task 3.
3. **The agent rewrites a memory while the user has it open:** save/delete is refused with the conflict error and the UI keeps the typed text. Tests in Task 3 (store) and Task 8 (UI state helper).
4. **Rename onto a name that already has a memory folder, or a rename during a reply:** files merge with `_2` suffixes, nothing overwritten, late writes follow. Tests in Task 3 and Task 4.
5. **A fresh machine with no `~/.claude/agent-memory`**, or memory off with files present: the list is empty or shown with the "off" note, the watcher creates the root, nothing throws. Tests in Task 3.

---

### Task 1: Memory file format (shared)

**Files:**
- Create: `zumi-bot-server/shared/src/memory.ts`
- Test: `zumi-bot-server/shared/tests/memory.test.ts`

**Interfaces:**
- Produces (all exported from `@zumibot/shared/memory`):
  - `MEMORY_TYPES = ['user','feedback','project','reference'] as const`, `MEMORY_LIMITS = [25, 50, 100, 150] as const`, `MEMORY_LIMIT_DEFAULT = 100`, `MEMORY_INDEX = 'MEMORY.md'`, `INDEX_VISIBLE_LINES = 200`, `TITLE_MAX = 100`, `DESCRIPTION_MAX = 150`, `BODY_MAX = 8000`, `FILE_NAME_MAX = 200`, `MEMORY_CHANGED`, `memoryFull(limit: number): string` (the exact copy above).
  - `interface MemoryEntry { file: string; name: string; title: string; description: string; type: string | null; body: string; modified: number /* mtimeMs */; indexLine: number | null /* 1-based */ }`
  - `interface MemoryList { scope: string | null; limit: number; autoMemoryOff: boolean; indexLines: number; entries: MemoryEntry[] }`
  - `interface MemoryInput { title: string; description: string; type: string | null; body: string }`
  - `interface MemoryTouch { saved: number; updated: number }`
  - `parseMemoryFile(file: string, raw: string): { name: string; description: string; type: string | null; body: string }`
  - `parseIndex(raw: string): Map<string, { title: string; line: number }>` (keyed by file name; first line wins)
  - `indexLine(title: string, file: string, description: string): string` (no newline)
  - `newMemoryFile(type: string | null, title: string, taken: ReadonlySet<string>): { file: string; name: string }`
  - `serializeNewMemory(name: string, input: MemoryInput): string`
  - `updateMemoryFile(raw: string, input: MemoryInput, fallbackName: string): string`
  - `isMemoryFileName(file: string): boolean`
  - `checkMemoryInput(v: unknown): MemoryInput` (throws `TypeError` with a field name, never the text)
  - `effectiveLimit(v: number | null | undefined): number`
  - `capNote(count: number, limit: number): string`
  - `memoryLineText(t: MemoryTouch, roomAgent: string | null): string`

- [ ] **Step 1: Write the failing tests** in `shared/tests/memory.test.ts`:
  - `parseMemoryFile` reads `metadata.type` and plain `type`; a type outside the four comes back as is; no frontmatter → `{ name: <stem>, description: '', type: null, body: raw }`; broken YAML → same fallback, never throws; CRLF body kept.
  - `parseIndex('# Notes\n- [Teal](user_colour.md) — likes teal\n\n- [X](a.md)\n- [Dup](a.md)\n')` → `a.md` line 4 title `X`, `user_colour.md` line 2.
  - `indexLine('A [b](c)', 'f.md', 'd')` round-trips through `parseIndex` to title `A [b](c)` (escape `[`, `]`, `(`, `)` with backslashes and unescape on parse).
  - `newMemoryFile('feedback', 'Never commit — without asking!', new Set())` → `{ file: 'feedback_never_commit_without_asking.md', name: 'never-commit-without-asking' }`; `null` type → prefix `other_`; empty slug → `memory`; slug capped at 48 chars; taken `user_x.md` → `user_x_2.md`, then `_3`.
  - `serializeNewMemory` output equals the spec's example block exactly (frontmatter `name`, `description`, `metadata:\n  type:`, blank line, body, trailing newline).
  - `updateMemoryFile` on a file with an extra key `origin: cli` and `type: preference` keeps both when `input.type === 'preference'`, changes only `description`; with `input.type: 'user'` writes it where the type was (`type:` stays `type:`); a file without frontmatter gets one with `fallbackName`; CRLF in → CRLF out.
  - `isMemoryFileName`: true for `User_Role.md`, `a.md`; false for `MEMORY.md`, `.x.md`, `a/b.md`, `a\\b.md`, `a.txt`, `x\u0000.md`, a 201-char name.
  - `checkMemoryInput` rejects a multi-line title, 101-char title, 151-char description, empty or 8001-char body, non-string type; accepts `type: null`.
  - `effectiveLimit(undefined) === 100`, `effectiveLimit(30) === 100` (not a choice), `effectiveLimit(50) === 50`.
  - `capNote(12, 100)` and `capNote(100, 100)` / `capNote(101, 100)` equal the exact copy.
  - `memoryLineText({ saved: 1, updated: 0 }, null) === 'Memory: 1 saved'`; `({ saved: 1, updated: 2 }, 'Ana')` → `"Ana's memory: 1 saved, 2 updated"`.

- [ ] **Step 2:** Run `npx vitest run --project shared shared/tests/memory.test.ts` — expect FAIL (module missing).
- [ ] **Step 3:** Implement `shared/src/memory.ts`. Frontmatter split: reuse the same `---` block regex as `frontmatter.ts` (copy the small `split` helper or export it from `frontmatter.ts`; prefer exporting). YAML edits go through `YAML.parseDocument` and `doc.set`/`setIn(['metadata','type'])` so unknown keys and order survive.
- [ ] **Step 4:** Run the same command — expect PASS.

### Task 2: Agent fields `memory` and `memoryLimit`

**Files:**
- Modify: `zumi-bot-server/shared/src/frontmatter.ts` (`AgentFields`, `fieldsOf`, `serializeAgent`)
- Modify: `zumi-bot-server/shared/src/types.ts` (`AgentSummary`)
- Modify: `zumi-bot-server/backend/src/core/agents/agentStore.ts` (summary build, ~line 199)
- Modify: literal `AgentFields` in `frontend/tests/editorState.test.ts`, `frontend/tests/commandBubble.test.ts`, `shared/tests/frontmatter.test.ts`
- Test: `zumi-bot-server/shared/tests/frontmatter.test.ts`, `zumi-bot-server/backend/tests/core/agentStore.test.ts`

**Interfaces:**
- Produces: `AgentFields.memory: string | null` (raw scope), `AgentFields.memoryLimit: number | null`; `AgentSummary.memory?: string` and `AgentSummary.memoryLimit?: number` (absent = off / default, like `commands?`).

- [ ] **Step 1: Failing tests:** `parseAgent` of a file with `memory: user` and `memoryLimit: 50` gives those values; a non-number `memoryLimit: lots` gives `null`; `serializeAgent` setting `memory: 'user'` on the `unknown-keys` fixture adds one line and keeps every other key byte for byte; `memory: null` deletes the key; changing only `memoryLimit` writes only that key; the "nothing changed" path still returns the original head verbatim. `AgentStore.list()` includes `memory: 'user', memoryLimit: 50` for such a file and omits both when absent.
- [ ] **Step 2:** `npx vitest run --project shared shared/tests/frontmatter.test.ts` and `npx vitest run --project backend backend/tests/core/agentStore.test.ts` — FAIL.
- [ ] **Step 3:** Add both keys to `fieldsOf` (`memoryLimit` = `Number(v)` when finite and integer, else `null`), to the equality check and to the null-means-delete loop (extend `['model','color','icon']` with `'memory'`, handle `memoryLimit` alongside). Add the optional fields to the summary in `agentStore.ts`. Fix the three test files' literals.
- [ ] **Step 4:** Run both commands, then `npm run typecheck` — PASS.

### Task 3: Memory store (backend)

**Files:**
- Create: `zumi-bot-server/backend/src/core/memory/memoryStore.ts`
- Test: `zumi-bot-server/backend/tests/core/memoryStore.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `writeFileAtomic`, `assertInside` (`core/fsutil.ts`); a trash function `(p: string) => Promise<void>` (app passes `trashPath(p, home, now)`).
- Produces:
  - `memoryRoot(env?: NodeJS.ProcessEnv, home?: string): string` → `<CLAUDE_CONFIG_DIR or home/.claude>/agent-memory`
  - `isAutoMemoryOff(env: NodeJS.ProcessEnv, configDir: string): Promise<boolean>` (env `CLAUDE_CODE_DISABLE_AUTO_MEMORY` truthy — `1`, `true`, `yes`, case-insensitive — or `<configDir>/settings.json` `autoMemoryEnabled === false`; unreadable settings = not off)
  - `class MemoryStore { constructor(d: { root: string; trash(p: string): Promise<void>; log(line: string): void }) }` with:
    - `dirOf(agent: string): string` (throws unless `NAME_PATTERN`)
    - `list(agent: string, o: { scope: string | null; limit: number; autoMemoryOff: boolean }): Promise<MemoryList>` (repairs first; missing folder → empty list; `indexLines` = line count of `MEMORY.md`)
    - `count(agent: string): Promise<number>`
    - `repairIndex(agent: string): Promise<void>`
    - `save(agent: string, file: string | null, input: MemoryInput, modified: number | null, limit: number): Promise<void>` (`file` null = create; refuses with `memoryFull(limit)` when count ≥ limit; `modified` must equal the file's current `mtimeMs` or `MEMORY_CHANGED`)
    - `remove(agent: string, file: string, modified: number): Promise<void>` (trash file, then drop its index line)
    - `moveAgent(from: string, to: string): void` (synchronous merge, spec "Moving is a merge")
    - `trashAgent(name: string): Promise<void>`
    - `watch(onChange: (agent: string) => void): () => void` (recursive `fs.watch` on root, 150 ms debounce per agent folder, `mkdirSync` root first, closes on `'error'`; agent = first path segment, ignored unless it matches `NAME_PATTERN`)

- [ ] **Step 1: Failing tests** (temp dirs, a recording fake `trash`):
  - list of a folder with two files, one without frontmatter and one with CRLF; entries sorted by nothing in particular (sorting is the UI's), titles from the index, `indexLine` numbers right; missing root → `{ entries: [] }`.
  - repair appends `- [name](file) — description` for an unindexed file, keeps a prose line, a blank line and a line for a missing file byte for byte, adds a trailing newline only when it appends; running twice appends nothing.
  - create writes `<type>_<slug>.md` and appends the index line, creating `MEMORY.md` if missing; create at the limit throws `memoryFull(100)`.
  - update keeps the file name and `name:`, replaces only its own index line (or appends one); stale `modified` throws `MEMORY_CHANGED` and leaves the file untouched.
  - remove calls trash with the file path and drops only its index line; stale `modified` refused.
  - path safety: `save('a', '../x.md', …)`, `remove('a', 'MEMORY.md', …)`, a symlinked `.md` and an agent name `../x` all throw before touching disk.
  - `moveAgent`: old missing → no-op; new missing → folder renamed; both → files moved, clash becomes `_2`, old `MEMORY.md` and folder trashed, nothing overwritten; idempotent when called twice.
  - `isAutoMemoryOff`: env `1` → true; settings `{"autoMemoryEnabled": false}` → true; missing/broken settings → false.
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/core/memoryStore.test.ts` — FAIL.
- [ ] **Step 3:** Implement. Serialize writes per agent folder with a promise chain (like `ApprovalStore`'s queued writes) so a list-repair and a save never interleave on `MEMORY.md`. Use `lstat` to skip symlinks and non-files. Never log memory text; logs name the agent and file only.
- [ ] **Step 4:** Same command — PASS.

### Task 4: Running-turn moves (backend)

**Files:**
- Create: `zumi-bot-server/backend/src/core/memory/memoryTurns.ts`
- Test: `zumi-bot-server/backend/tests/core/memoryTurns.test.ts`

**Interfaces:**
- Consumes: `Pick<MemoryStore, 'moveAgent' | 'trashAgent'>`.
- Produces: `class MemoryTurns { constructor(d: { store: Pick<MemoryStore,'moveAgent'|'trashAgent'>; log(line: string): void }); started(agent: string): void; ended(agent: string): void; renamed(from: string, to: string): void; deleted(name: string): Promise<void> }`.

- [ ] **Step 1: Failing tests:** `renamed(a,b)` with no running turn moves once; with `started(a)` first, moves at once and again at `ended(a)`; a chain `renamed(a,b)` then `renamed(b,c)` while `a` runs moves `a`→`c` at its end; `deleted(a)` while running trashes now and at end; a second `started(a)` keeps the end-move until both ended; store errors are logged, never thrown.
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/core/memoryTurns.test.ts` — FAIL.
- [ ] **Step 3:** Implement with a `Map<string, number>` of running turns per spawned name and a `Map<string, string | null>` of where a running name's folder must end up (`null` = trash).
- [ ] **Step 4:** Same command — PASS.

### Task 5: RPC, wiring, rename and delete

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.memory`; re-export memory types if convenient)
- Modify: `zumi-bot-server/shared/src/rpc.ts` (`{ event: 'memory:changed'; payload: { agent: string } }`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (deps, three handlers, `agents:save`, `agents:trash`)
- Modify: `zumi-bot-server/backend/src/app.ts` (build store + turns, watcher → broadcast, outside-rename branch, deps to handlers)
- Modify: `zumi-bot-server/frontend/src/net/api.ts`
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts` (and `tests/http/helpers.ts` deps if handlers' deps grow there)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `ZumiBotApi.memory: { list(agent: string): Promise<MemoryList>; save(agent: string, file: string | null, input: MemoryInput, modified: number | null): Promise<MemoryList>; remove(agent: string, file: string, modified: number): Promise<MemoryList>; onChanged(cb: (agent: string) => void): () => void }`
  - `HandlerDeps.memory: { store: MemoryStore; turns: MemoryTurns; autoMemoryOff(): Promise<boolean> }` and `HandlerDeps.memoryChanged(agent: string): void`.

- [ ] **Step 1: Failing tests** in `handlers.test.ts`: `memory:list` for an unknown agent rejects; for a known agent returns `scope`/`limit` from its summary (`memoryLimit: 50` → 50, absent → 100); `memory:save` checks args (`file` must be null or pass `isMemoryFileName`, `modified` null or a finite number, input via `checkMemoryInput`) and broadcasts `memory:changed`; `memory:remove` likewise; `agents:save` with a rename calls `turns.renamed(old, new)` **before** its first await (assert with a deps fake that records call order against `approvals.renameAgent`); `agents:trash` calls `turns.deleted(name)` only when the name is really gone.
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/rpc/handlers.test.ts` — FAIL.
- [ ] **Step 3:** Implement. Handlers find the agent with `agents.list()` (non-error, by name). In `app.ts`: `const memoryStore = new MemoryStore({ root: memoryRoot(), trash: (p) => trashPath(p, home, () => new Date()), log })`, `const memoryTurns = new MemoryTurns(…)`, `memoryChanged = (agent) => hub.broadcast({ event: 'memory:changed', payload: { agent } })`, `memoryStore.watch(memoryChanged)` with its stop pushed onto `undo`; in the `createAgentsSync` `rename` callback call `memoryTurns.renamed(from, to)` right after `approvals.renameAgent`. Do **not** touch memory in `removed`.
- [ ] **Step 4:** Same command, then `npm run typecheck` — PASS.

### Task 6: Memory in the turn (ChatService)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`ChatServiceDeps`, `agentTurn`)
- Modify: `zumi-bot-server/shared/src/types.ts` (`ChatItem` intersection gains `memory?: MemoryTouch`)
- Modify: `zumi-bot-server/backend/src/app.ts` (pass the dep)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: `capNote`, `effectiveLimit`, `MemoryTouch` (Task 1); store/turns (Tasks 3–4).
- Produces: `ChatServiceDeps.memory?: { begin(agent: string): Promise<{ dir: string; note: string } | null>; end(agent: string, touched: boolean): void }`. In `app.ts`, `begin` = `turns.started(agent)`, then if the agent's summary has `memory === 'user'` and auto memory is not off: `await store.repairIndex(agent)` and return `{ dir: store.dirOf(agent), note: capNote(await store.count(agent), effectiveLimit(summary.memoryLimit)) }`, else `null`; `end` = `turns.ended(agent)` and `memoryChanged(agent)` when `touched`. Both are wrapped so a failure only logs.

- [ ] **Step 1: Failing tests** (fake deps, recorded stream fixtures or inline events):
  - the appended system prompt contains the note after house style; absent when `begin` returns null; `begin` not called for `spec.compact`.
  - a `Write` to `<dir>/user_x.md` (file absent at `toolUse`) with an ok result → last assistant/tool item of the turn has `memory: { saved: 1, updated: 0 }`; an `Edit` of an existing file → `updated: 1`; the same file written then edited in one turn counts once as saved; `MEMORY.md`, a path in another agent's folder, a relative escape (`<dir>/../other/x.md`) and an `isError` result are not counted; no field when nothing counted.
  - `end` is called once per turn with `touched` true/false, also when the turn throws.
  - the counting uses the name the turn was spawned with even if `spec.author` changes mid-turn.
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/core/chatService.test.ts` — FAIL.
- [ ] **Step 3:** Implement in `agentTurn`: call `begin(spec.agentName)` once before the first attempt (not per retry/reseed); join `note` into `system`; track `toolUse` ids whose resolved `input.file_path` is inside `dir` (and not `MEMORY_INDEX`) with `existsSync` at `toolUse` time; confirm on `toolResult` without `isError`; remember the id of the last `assistant`/`tool` item `add` stamps; in `finally`, before `store.saveItems`, patch that item with `memory` when either count > 0; call `end` after the save. Seeds and readers need no change (unknown fields are ignored), but grep `seedPrompt.ts`/`fork.ts`/`versions.ts` to confirm nothing copies items field by field in a way that matters.
- [ ] **Step 4:** Same command, then `npm test` for the backend project — PASS (the known flaky `ENOTEMPTY` teardown in this file may need one rerun; say so if it happens).

### Task 7: Sync carries agent memory

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs` (`CLAUDE_DIRS`, the remote `mkdir -p` line ~346, any local equivalent)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

- [ ] **Step 1: Failing test** in the `sync` describe: a memory file only on the PC and another only on the VPS end up on both sides; a `MEMORY.md` edited on both sides keeps the newer one (the server's repair fixes the index later, not sync).
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/sync.test.ts` — FAIL.
- [ ] **Step 3:** Add `['agent-memory', []]` and `~/.claude/agent-memory` to the `mkdir -p`.
- [ ] **Step 4:** Same command — PASS.

### Task 8: Frontend state helpers

**Files:**
- Create: `zumi-bot-server/frontend/src/state/memory.ts`
- Test: `zumi-bot-server/frontend/tests/memory.test.ts`

**Interfaces:**
- Produces: `matchesMemory(e: MemoryEntry, query: string): boolean`; `groupMemories(entries: MemoryEntry[]): { key: 'user' | 'feedback' | 'project' | 'reference' | 'other'; label: string; entries: MemoryEntry[] }[]` (fixed order User, Feedback, Project, Reference, Other; empty groups dropped; newest `modified` first); `limitState(count: number, limit: number): 'room' | 'full' | 'over'`; `typeChoices(current: string | null): (string | null)[]` (the four, plus `current` when it is something else); `keepDraftOnConflict(draft: MemoryInput, fresh: MemoryList, file: string): { entry: MemoryEntry | null; draft: MemoryInput }`.

- [ ] **Step 1: Failing tests:** every word must match somewhere in title/description/name/body, case-insensitive, empty query matches all; grouping order and drop; `limitState(99,100)==='room'`, `(100,100)==='full'`, `(101,100)==='over'`; `typeChoices('preference')` ends with `'preference'`; `keepDraftOnConflict` returns the fresh entry and the untouched draft.
- [ ] **Step 2:** `npx vitest run --project frontend frontend/tests/memory.test.ts` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command — PASS.

### Task 9: Memory section in Agent Studio

**Files:**
- Create: `zumi-bot-server/frontend/src/components/AgentMemory.tsx`
- Modify: `zumi-bot-server/frontend/src/components/AgentEditor.tsx` (render between the form/raw editor and `RememberedApprovals`; accept `focusMemory?: boolean`)
- Modify: `zumi-bot-server/frontend/src/styles.css`

**Interfaces:**
- Consumes: `api.memory` (Task 5), Task 8 helpers, `editFields` (`state/editorState.ts`).
- Produces: `AgentMemory({ agentName: string; fields: AgentFields | null; onFields(patch: Partial<AgentFields>): void; focus: boolean })`.

- [ ] **Step 1:** Build the section exactly as the spec's "The Memory section" describes (head with title, count, New memory, `role="switch"` like `RoutineEditor`'s `rt-switch`, limit `<select>` over `MEMORY_LIMITS`; hints for off/auto-off/over 200 lines; for a saved scope of `project` or `local` the spec's "Other scopes" notice replaces the list; search like `RoutinesSidebar`'s `.search`; grouped rows; inline editor; `ConfirmDialog` delete; load/refresh/error handling copied from `RememberedApprovals.tsx`, including the `latest`/`alive` refs and `onChanged` filtered by agent). The switch writes `memory: 'user'` / `null`, the select writes `memoryLimit` (default choice writes `null`), both via `onFields`. Disabled when `fields` is null (raw text doesn't parse). `focus` scrolls the section into view once on mount. Rows and bodies are plain text. Add `data-testid`s the e2e needs: `memory-section`, `memory-switch`, `memory-count`, `memory-new`, `memory-search`, `memory-row`, `memory-save`, `memory-delete`.
Zumi Bot needs nothing here: `App.openEditor` already refuses built-in files, so its editor (and this section) never opens.
- [ ] **Step 2:** Styles reuse `.card`, `.card-title`, `.remembered*` tokens; phone width: no horizontal scroll at 360 px, 16 px gutters.
- [ ] **Step 3:** `npm run typecheck` and `npm run build:server` — PASS.

### Task 10: The chat line and View

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx` (render a `memory-line` after an item that has `memory`, outside the folded tools block; `GroupProps.onViewMemory?: (agent: string) => void`)
- Modify: `zumi-bot-server/frontend/src/components/ChatView.tsx` and `zumi-bot-server/frontend/src/App.tsx` (an `openAgentMemory(agentName)` that finds the agent's `filePath`, goes through `openEditorGuarded`, and passes `focusMemory` to `AgentEditor`)
- Modify: `zumi-bot-server/frontend/src/styles.css`

- [ ] **Step 1:** Render `memoryLineText(item.memory, isRoom ? displayName(group.agent.name) : null)` plus a "View" link button calling `onViewMemory(group.agent.name)`; muted, small, like the mockup. Nothing renders for built-in agents (they have no editor).
- [ ] **Step 2:** `npm run typecheck` — PASS.

### Task 11: E2E, docs, full check, commits and merge

**Files:**
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-claude.mjs` (a `#WRITE_FILE {"path": "...", "content": "..."}` script line that writes the file, so a scripted tool call has a real effect)
- Create: `zumi-bot-server/e2e/memory.e2e.mjs`
- Modify: `package.json` (`"e2e:memory": "npm run build && node zumi-bot-server/e2e/memory.e2e.mjs"`)
- Modify: `CLAUDE.md` (Commands line for `e2e:memory`; an **Agent memory** paragraph in Architecture in the house style; `agent-memory` in the sync paragraph with the "deleted memory comes back" note)

- [ ] **Step 1:** Write `memory.e2e.mjs` on `start({ fake: true, env: { CLAUDE_CONFIG_DIR: undefined } })` (fake runs use `HOME=root/home`, so the root is `root/home/.claude/agent-memory`), modelled on `commands.e2e.mjs`: agent file with `memory: user`; the script writes `user_teal.md` via `#WRITE_FILE` around a `Write` tool_use/tool_result pair → the reply shows "Memory: 1 saved" and the open Memory section lists it without reload; add, edit, search, delete by hand and check the files and `MEMORY.md`; set limit 25 with 25 files → New memory hidden; rename the agent in the editor → the folder moved.
- [ ] **Step 2:** Run `npm run e2e:memory` — PASS. Kill any leftover Chrome/server processes afterwards.
- [ ] **Step 3:** Run `npm test`, `npm run typecheck`, `npm run build` — all PASS (report the flaky `ENOTEMPTY` teardown if it shows, with a passing rerun). Also run `npm run e2e:commands` (fake claude, no quota) as a regression check on the chat path.
- [ ] **Step 4:** Commit the changes (all files of this plan plus the spec and this plan) with a 15–25-word paragraph, e.g. `Agent memory shown in Agent Studio, edit search cap per agent, chat line after replies, rename moves, delete trashes, sync carries it, e2e memory suite.`
- [ ] **Step 5:** `npm run bump:minor`; check every workspace `package.json` and `package-lock.json` moved to `3.11.0`; commit with a paragraph like `Bump every workspace to 3.11.0 minor for agent memory, package lock synced, ready to push and deploy.`
- [ ] **Step 6:** Merge into `master`: leave the worktree session (`ExitWorktree`, keep), confirm the main checkout is on `master` with no tracked changes, `git merge --ff-only agent-memory` (if `master` moved, `git merge agent-memory` and resolve), then `git log --oneline -3`. Do not push or deploy.
