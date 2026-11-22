# Side Question Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Side questions become threads the user can follow up, answered from the first question's moment, shown as Dispatched-agents-style rows that open a chat-style thread.

**Architecture:** A follow-up is an ordinary side entry carrying `thread: <rootId>`, so every per-entry rule stays. The root keeps a server-only snapshot (fork point, last seed item, context text); a follow-up forks from that point and replays the thread's earlier Q&A as text. The panel builds threads from the flat list with pure helpers in `state/sideQuestions.ts`.

**Tech Stack:** TypeScript, Node (backend), React 19 (frontend), vitest, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-06-side-question-followups-design.md`

All paths below are relative to `zumi-bot-server/` unless they start with `docs/`.

## Global Constraints

- Never commit (user rule in `~/.claude/CLAUDE.md`); each task ends with its tests green, not a commit.
- Side runs keep `--no-session-persistence`, `--fork-session` and the existing guard strings byte for byte; base args, tool definitions and system prompt are built exactly as for a new question.
- A follow-up never touches chat items, prompts, context meter, unread or notifications.
- `SIDE_MAX_OPEN` (3) counts follow-ups; `SIDE_TIMEOUT_MS` per entry unchanged.
- Earlier-exchange cap: `FOLLOW_MAX = 40_000` characters, root pair always kept.
- The snapshot never leaves the server: `btw:list`, `btw:changed`, and every RPC result strip it.
- Copy (exact): `Wait for this answer to finish`, `Ask a follow-up…`, `Answering follow-up…`, `Answering…`, `Picking who answers…`, `Stopped`, `This reply`, `N questions` (N ≥ 2), `Asked by @<handle>; follow-ups are not available`.
- New API method touches `shared/src/types.ts` (`ZumiBotApi`), `backend/src/rpc/handlers.ts`, `frontend/src/net/api.ts`.
- Comments short, say why. Pure logic in `frontend/src/state/`; no DOM tests exist.

## Review Focus

1. Root's session file gone (deleted, other machine) when a follow-up runs → reseeds once from items through `upTo`, never a plain `--resume` (Task 2 test).
2. Orphan follow-up (its root missing after a partial sync or fork) → UI shows it as its own thread; `btw:follow` on it treats it as root (Tasks 2 and 4 tests).
3. Agent renamed between root and follow-up → follow-up answered by the new name (Task 2 test).
4. Very long earlier exchange → cap keeps root pair plus newest, says older were left out (Task 1 test).
5. A→B chat asker thread (`mention`, answers from the source chat) → follow-up seeds/forks from the source chat's snapshot, not the A→B chat's items (Task 2 test).

---

### Task 1: Follow-up prompt builders

**Files:**
- Modify: `shared/src/btw.ts` (add `thread?: string` to `SideQuestion`, after `from`, comment: `// a follow-up: its thread's first entry; absent = a thread's first question`)
- Modify: `backend/src/core/btw/sidePrompt.ts`
- Test: `backend/tests/core/sidePrompt.test.ts`

**Interfaces:**
- Produces:
  - `sideContext(thread: ThreadEntry[] | null, lead?: string): string` — `[lead?, ...threadLines(thread ?? [])].join('\n')`; `''` when both empty.
  - `sideMessage` rewritten on top of `sideContext`, output unchanged.
  - `export const FOLLOW_MAX = 40_000`
  - `followExchange(earlier: readonly Pick<SideQuestion, 'question' | 'answer'>[], max = FOLLOW_MAX): { pairs: string[]; cut: boolean }` — each pair `` `<btw>${q}</btw>\n<answer>${a.trim() || '(no answer)'}</answer>` ``; over `max` (sum of pair lengths) keep `pairs[0]` then the newest pairs that fit (same walk as `askedThread`).
  - `followMessage(context: string, note: string, earlier: readonly Pick<SideQuestion, 'question' | 'answer'>[], question: string): string` — lines: context (only when non-empty), note, `FOLLOW_LEAD` (or `FOLLOW_LEAD_CUT` when cut), each pair, `` `<btw>${question}</btw>` ``, joined by `\n`.
  - `export const FOLLOW_LEAD = 'This side question follows up earlier ones in the same side thread. The earlier questions and your answers, oldest first:'`
  - `export const FOLLOW_LEAD_CUT = 'This side question follows up earlier ones in the same side thread. The earlier questions and your answers, oldest first, some in the middle left out:'`
  - `seedWith(items: ChatItem[], message: string): string` — `buildSeedPrompt(items, message)`; `seededSideMessage` uses it.

- [ ] **Step 1: Write failing tests** in `sidePrompt.test.ts`:
  - `sideContext joins lead and thread lines`: `sideContext(null)` → `''`; `sideContext([{from: null, text: 'start'}], 'Lead:')` → `'Lead:\n<message from="user">start</message>'`.
  - existing `sideMessage` tests still pass unchanged (guards the refactor).
  - `followMessage puts context, note, exchange, then the question`: `followMessage('', SIDE_NOTE, [{question: 'Q1', answer: 'A1'}], 'Q2')` === `` `${SIDE_NOTE}\n${FOLLOW_LEAD}\n<btw>Q1</btw>\n<answer>A1</answer>\n<btw>Q2</btw>` ``; with context `'ctx'` it starts `'ctx\n'`.
  - `an earlier entry without text reads (no answer)`: answer `'  '` → `<answer>(no answer)</answer>`.
  - `followExchange keeps the first pair and the newest that fit`: 5 pairs of 100-char answers, `max` = length of pair 1 + pairs 4 and 5 → `pairs` = [p1, p4, p5], `cut: true`; under max → all, `cut: false`.
  - `followMessage says when pairs were left out`: uses `FOLLOW_LEAD_CUT` when cut (pass a tiny exchange cap through `followExchange` by testing `followExchange` directly and `followMessage` with an exchange over 40 000 chars).

- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/sidePrompt.test.ts` from the repo root. Expected: new tests FAIL (not exported).
- [ ] **Step 3: Implement** the exports above in `sidePrompt.ts`; add the `thread` field in `shared/src/btw.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `npm run typecheck`. Expected: clean.

---

### Task 2: SideQuestions follow, snapshot, Ask again rules, RPC

**Files:**
- Modify: `backend/src/core/btw/sideQuestions.ts`
- Modify: `shared/src/types.ts` (`ZumiBotApi['btw']` gains `follow(chatId: string, threadId: string, question: string, id: string): Promise<SideQuestion>`)
- Modify: `backend/src/rpc/handlers.ts` (`'btw:follow'`, same argument checks as `'btw:ask'`: `str()` each, question length ≤ `COMMAND_PROMPT_MAX` with the same message, no `writable()`)
- Modify: `frontend/src/net/api.ts` (`follow: (chatId, threadId, question, id) => call('btw:follow', chatId, threadId, question, id)`)
- Test: `backend/tests/core/sideQuestions.test.ts`, `backend/tests/core/fork.test.ts`

**Interfaces:**
- Consumes: Task 1's `sideContext`, `followMessage`, `seedWith`; `SideQuestion.thread`.
- Produces:
  - `interface SideSnapshot { point: { session: string; at: string } | null; upTo: string | null; context: string }` and `type StoredSide = SideQuestion & { snapshot?: SideSnapshot }` exported from `sideQuestions.ts`. `Room.entries: StoredSide[]`.
  - `SideQuestions.follow(chatId: string, threadId: string, question: string, id: string): Promise<SideQuestion>`
  - Fixed refusal texts (exported consts in `shared/src/btw.ts` so the UI can reuse them): `SIDE_WAIT_TEXT = 'Wait for this answer to finish'`, `SIDE_NOT_FOUND_TEXT = 'Side question not found'`, `SIDE_ASK_FIRST_TEXT = 'Ask this side question again first'`, `askedByText = (agent) => \`Asked by @${agent}; follow-ups are not available\``, `SIDE_LAST_ONLY_TEXT = 'Only the last question in a side thread can be asked again'`.

Behavior to build (spec "Behavior"):
- `publicEntry(e: StoredSide): SideQuestion` drops `snapshot`; used in `flush`'s broadcast, `list`, every `accepted` returned by `create`/`again`, and `askFrom`'s result.
- `create(chatId, id, fields)`: load the room before calling `fields`, and pass it the loaded entries: `fields(meta: ChatMeta, entries: readonly StoredSide[]) => Fields`, where `Fields` gains optional `thread` and `after` (`after` present → used instead of `items.at(-1)?.id`).
- `follow`: trims the question (empty → existing `'A side question cannot be empty'`). In `fields`: entry = `entries.find(id === threadId)`, else `SIDE_NOT_FOUND_TEXT`; root = `entry.thread ? entries.find(id === entry.thread) ?? entry : entry` (an orphan is its own root); `root.from` → `askedByText(root.from)`; `root.agent === null` → `SIDE_ASK_FIRST_TEXT`; any entry of the thread (root plus `thread === root.id`) open → `SIDE_WAIT_TEXT`; `root.mention` with `root.agent` no longer in `meta.group?.members ?? (meta.asked ? [meta.asked.by] : [])` → existing `` `${displayName(agent)} is not in this chat` ``. Returns `{ question, agent: root.agent, ...(root.mention ? { mention: true } : {}), state: 'running', thread: root.id, after: root.after }`. `checkLimit` already applies.
- `answer()`: `root` = for a follow-up, `room.entries.find(q => q.id === entry.thread)`; `earlier` = the thread's entries (root first, then follow-ups) sorted by `askedAt`, those before `entry`.
  - Follow-up with `root.snapshot`: `point` = `snapshot.point`; context = `snapshot.context`; seed items (when point is null, and on the missing-session fallback) = the seed chat's items through `snapshot.upTo` (`upTo === null` → `[]`; `upTo` not found → all items). Room `sideThread` and `askedThread` are not recomputed.
  - Follow-up without snapshot (legacy root): point and context computed as for a new question (`sideContext(prepared.thread, prepared.lead)`).
  - Message: follow-up → `followMessage(context, note, earlier, entry.question)`, seeded → `seedWith(items, that)`; root → unchanged `sideMessage`/`seededSideMessage`.
  - Root: just before each `startSideRun`, set `entry.snapshot = { point, upTo: prepared.items.at(-1)?.id ?? null, context: sideContext(prepared.thread, prepared.lead) }` and mark changed (so the reseed fallback overwrites it with `point: null`).
  - A follow-up whose agent is renamed mid-run is handled by the existing rename loop; the follow-up never runs the room picker (`agent` is set).
- `again()`: refuse with `SIDE_LAST_ONLY_TEXT` when another entry of the same thread has a later `askedAt` (for a root: any entry with `thread === id`). A follow-up keeps its `agent` (skip the reset to `meta.agentName`/`null`); a root drops `snapshot` along with `asks`.

- [ ] **Step 1: Write failing tests** in `sideQuestions.test.ts` (use the existing `fixture()`, `started`, `finished`, `runs[i].finish()`/`emit`):
  - `a follow-up forks from its root's point after the main run moved on`: ask `q` with base `live-session/live-at`, finish with answer text `'Three'` (emit a text event the way existing tests do), then `setBase({...active, active: false, live: null})` and `setItems([...old, newer])`; `follow('chat', 'q', 'And now?', 'f')`; run args contain `'--resume', 'live-session', '--resume-session-at', 'live-at'`; stdin contains `'<btw>Old…'`-style pair: `` `<btw>How far?</btw>\n<answer>Three</answer>\n<btw>And now?</btw>` `` and `FOLLOW_LEAD`.
  - `follow-up entry copies agent and anchor`: accepted equals `{ id: 'f', question: 'And now?', agent: 'helper', thread: 'q', after: <root.after>, askedAt, state: 'running', answer: '' }`.
  - `the snapshot never leaves the server`: after the root runs, `f.saved[0].snapshot` is `{ point: { session: 'live-session', at: 'live-at' }, upTo: 'a', context: '' }`; every `deps.broadcast` call's entry and every `list()` entry has no `snapshot` key; `ask`'s and `follow`'s results have none.
  - `a seeded root's follow-up reseeds from items through upTo`: base `null` session path from the existing seed test setup; root seeded; then add an item `'later'`; follow-up stdin contains the root-time history and not `'later'`.
  - `a missing root session reseeds the follow-up once`: follow-up run finishes with the missing-session error the existing reseed test uses → second run has no `--resume` and its stdin is seeded through `upTo`.
  - `refusals`: unknown id → `'Side question not found'`; root with `from` → `'Asked by @helper; follow-ups are not available'`; while root is running → `'Wait for this answer to finish'`; three open entries elsewhere → `SIDE_LIMIT_TEXT`; empty text → `'A side question cannot be empty'`; none of them calls `run`.
  - `an orphan follow-up is its own root`: saved entries `[{...follow-up with thread: 'gone'}]`; `follow('chat', thatId, ...)` accepted with `thread: thatId`.
  - `room follow-up keeps the picked member and its room context`: room fixture, root picked `writer`; `sideThread` mock call count unchanged by the follow-up; follow-up `pick` not called again; stdin starts with the root's context (`Room progress` line).
  - `A→B asker follow-up uses the source chat`: `addChat('asked', 'writer')` setup as the existing A→B tests do, root `@helper …` in `asked`; follow-up's `loadItems` seed reads chat `'chat'` items (assert stdin content from that chat).
  - `renamed agent answers the follow-up`: after root done, `service.renameAgent('helper', 'helper2')`; follow-up accepted `agent: 'helper2'`, run args `--agent helper2` (assert as existing rename tests do).
  - `Ask again only on the last entry`: root done, follow-up stopped → `again(root)` rejects `SIDE_LAST_ONLY_TEXT`; `again(followUp)` accepted with the same `agent` and `thread`, and its stdin still has the root pair.
  - In `fork.test.ts`: `fork keeps a thread's follow-ups and the root snapshot` — source side file with a finished root (with `snapshot`) and finished follow-up anchored on a copied item → both copied with `thread` and `snapshot` intact.

- [ ] **Step 2: Run** `npx vitest run --project backend -t "follow|snapshot|Ask again only|orphan|fork keeps a thread"`. Expected: FAIL.
- [ ] **Step 3: Implement** the behavior above, the RPC handler, the `ZumiBotApi` method and the `api.ts` mapping.
- [ ] **Step 4: Run** `npx vitest run --project backend` and `npm run typecheck`. Expected: all PASS, clean.

---

### Task 3: Thread state helpers and chat chips

**Files:**
- Modify: `frontend/src/state/sideQuestions.ts`
- Modify: `frontend/src/state/messageGroups.ts` (side row becomes `{ kind: 'side'; key: string; thread: SideThread }`, built from `sideThreads(sides)` roots, anchored on `thread.root.after`, oldest root first as now)
- Modify: `frontend/src/components/SideChip.tsx`, `frontend/src/components/MessageList.tsx` (render `SideChip` from `row.thread`)
- Test: `frontend/tests/sideQuestions.test.ts`, `frontend/tests/messageGroups.test.ts`, `frontend/tests/sideChip.test.ts` (update to the thread shape)

**Interfaces:**
- Consumes: `SideQuestion.thread`, refusal texts from Task 2 (`SIDE_WAIT_TEXT`, `SIDE_ASK_FIRST_TEXT`, `askedByText`).
- Produces (all in `state/sideQuestions.ts`):
  - `interface SideThread { id: string; root: SideQuestion; entries: SideQuestion[]; last: SideQuestion; open: boolean; status: 'running' | 'done' | 'error' | 'stopped' }` — `id` = root id; `entries` oldest first by `askedAt`; `status` = `'running'` when `open`, else `last.state`.
  - `sideThreads(list: readonly SideQuestion[]): SideThread[]` — an entry whose `thread` names no listed entry is its own root.
  - `threadOf(threads: readonly SideThread[], entryId: string): SideThread | undefined`
  - `threadLine(t: SideThread): { text: string; tone: 'live' | 'error' | 'muted' }` — open: `last.state === 'picking'` → `Picking who answers…`, `last.thread` → `Answering follow-up…`, else `Answering…` (tone live); error → `last.error ?? 'Could not answer'` (error); stopped → `Stopped` (muted); done → first non-empty line of `last.answer`, trimmed (muted).
  - `interface ThreadGroup { key: string; label: string; rows: SideThread[] }` and `groupThreads(threads: readonly SideThread[], fmtTime: (ms: number) => string): ThreadGroup[]` — key `root.after ?? 'start'`; groups ordered by their newest root `askedAt` desc; rows newest root first; label `This reply` for the first group, else `fmtTime(oldest root askedAt in group)`.
  - `canFollow(t: SideThread, chat: ChatMeta, sourceExists: boolean): string | null` — null = allowed; `root.from` → `askedByText(root.from)`; `root.agent === null` → `SIDE_ASK_FIRST_TEXT`; `t.open` → `SIDE_WAIT_TEXT`; `chat.asked && root.mention && !sourceExists` → `sourceGoneText(root.agent)`.
  - `canAskAgain(entry: SideQuestion, t: SideThread): boolean` — replaces the one-argument version: `entry.id === t.last.id`, state error/stopped, no `from`.
  - `threadCountText(t: SideThread): string | null` — `` `${n} questions` `` when `entries.length >= 2`, else null.
  - `SideChip` props become `{ thread: SideThread; agents; room; onOpen(id: string) }`: `data-side-id={thread.id}`, `data-state={thread.status}`, spinner while `thread.open`, ⚠ when `status === 'error'`, `chipText(thread.root)`.

- [ ] **Step 1: Write failing tests**:
  - `sideThreads groups follow-ups under their root`: list `[f2(thread r, askedAt 3), r(1), f1(thread r, 2), s(4)]` → two threads `r: [r, f1, f2]`, `s: [s]`; `last` of r is f2.
  - `an orphan follow-up stands alone`: `[{...f, thread: 'gone'}]` → one thread with `id === f.id`.
  - `status and open`: root done + follow-up running → `open: true`, `status: 'running'`; root done + follow-up error → `status: 'error'`.
  - `threadLine`: picking, running root (`Answering…`), running follow-up (`Answering follow-up…`), error text, `Stopped`, done answer `'\n\n  First line\nSecond'` → `First line`.
  - `groupThreads`: three roots, two with `after: 'x'` (askedAt 1, 5), one `after: 'y'` (askedAt 3) → `[{key: 'x', label: 'This reply', rows: [5, 1]}, {key: 'y', label: fmt(3), rows: [3]}]`; `after: null` → key `'start'`.
  - `canFollow`: each refusal and null on a finished single-chat thread; A→B mention thread with `sourceExists: false` → `sourceGoneText(agent)`.
  - `canAskAgain`: stopped root with a follow-up → false; stopped last follow-up → true; agent-asked error root → false.
  - `threadCountText`: 1 entry → null, 3 → `3 questions`.
  - `messageGroups`: a follow-up adds no chip row; the root's row carries the thread with both entries.
- [ ] **Step 2: Run** `npx vitest run --project frontend`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the helpers, the `messageGroups` row shape, `SideChip` and its `MessageList` call site.
- [ ] **Step 4: Run** `npx vitest run --project frontend` and `npm run typecheck`. Expected: PASS, clean.

---

### Task 4: Side questions panel list and thread view

**Files:**
- Modify: `frontend/src/components/SidePanel.tsx` (shell, `SideInput`, list rows)
- Create: `frontend/src/components/SideThreadView.tsx` (thread view, `SideEntry` moved here, follow-up box)
- Modify: `frontend/src/App.tsx` (SidePanel props; `sidesCount={sideThreads(sideQuestions.list).length}`)
- Modify: `frontend/src/styles.css` (side row/bubble/follow box rules next to the existing `.side-*` block)

**Interfaces:**
- Consumes: Task 3 helpers; `api.btw.follow`.
- Produces: `SidePanel` props change: `onAsk(text: string): Promise<string>` (resolves the new entry id; App returns `(await api.btw.ask(...)).id`), new `onFollow(threadId: string, text: string): Promise<void>` (App: `await api.btw.follow(shownChat.id, threadId, text, crypto.randomUUID())`). `onShowInChat` is called with the root id.

Build (spec "UI"):
- `SidePanel` holds `openId: string | null` (a thread id). A focus request (`focusId`, `focusRequest`) sets `openId` to `threadOf(threads, focusId)?.id` and the thread view scrolls that entry (`[data-side-id]`) into view and focuses it (the existing focus logic moves into the thread view). A thread that disappears from the list returns to the list.
- List view: header `Side questions · {threads.length}`; `SideInput` unchanged except: after a successful ask with exactly one text, `setOpenId(newId)`; with two (Both) stay on the list and scroll to top. Rows reuse the Dispatched classes: `<button className="dispatch-row side-row" data-testid="side-row" data-thread-id={t.id} data-status={t.status}>` with `dispatch-row-top` (`<span className={`dispatch-dot ${dotClass}`}>` where running → `running`, error → `failed`, stopped → `stopped`, done → none; `dispatch-name` = root question clamped to 2 lines; `dispatch-type` badge `data-testid="side-row-count"` from `threadCountText`; chevron), then `threadLine` (`data-testid="side-row-line"`, class by tone: live → `dispatch-now`, error → `side-row-error`, muted → `dispatch-usage` with one-line ellipsis), then agent dot + `displayName(root.agent)` (+ `from @X`) + root time. Groups use `dispatch-group` / `dispatch-group-head` (`data-testid="side-group"`). Empty and failed states unchanged.
- Thread view (`SideThreadView`, `data-testid="side-thread"`, `data-thread-id`): header with `SideBackButton` (back to list) and root question (`files-title`, one line, `title` attribute full text) and ✕; meta line (dot, agent, `from @X`, time, `Show in chat` → `onShowInChat(t.id)`); entries oldest first as `<article className="side-entry" data-testid="side-entry" data-side-id data-state>`: question bubble (`data-testid="side-bubble"`, right-aligned, main chat user-bubble colors; agent-asked root → left-aligned with `from @X` label), link chips, picking/answering status, Markdown answer (`live` while open), error/Stopped, actions Copy / Stop / Ask again (`canAskAgain(entry, t)`), same testids as today (`side-copy`, `side-stop`, `side-again`). Show in chat moves to the meta line (`data-testid="side-show"`).
- Follow-up box (`data-testid="side-follow-input"`, button `side-follow`, error `side-follow-error`, reason note `side-follow-note`): textarea `placeholder="Ask a follow-up…"`, same Enter / Shift+Enter / touch rule and `COMMAND_PROMPT_MAX` as `SideInput` (extract the shared key handler into one function in `SidePanel.tsx` and import it). Disabled with `canFollow(...)` text shown as the note when not null; when the reason is `askedByText`, the box is not rendered, only the note. Text cleared on success only; errors shown under it. After asking, follow the bottom.
- Scrolling: follow the bottom while the thread is open and the reader is within 60 px of it (Dispatched's `atBottom` pattern); opening a thread without a focus request scrolls to the bottom.
- Esc, ✕, Back to menu behave as now.

- [ ] **Step 1: Implement** the components, App wiring and CSS. (No DOM tests in this repo; the pure rules were tested in Task 3, the UI is checked in Task 5.)
- [ ] **Step 2: Run** `npm run typecheck` and `npx vitest run --project frontend`. Expected: clean, PASS.
- [ ] **Step 3: Build and look**: `npm run build:server`, then `npm run e2e:btw` (it will fail where Task 5 changes it; use it only to confirm the panel renders). Take one screenshot of the list and one of a thread with `npm run shot` or the e2e page and compare with mockup 2B (`.superpowers/brainstorm/*/content/side-panel-layout.html`).

---

### Task 5: e2e, docs, final verification

**Files:**
- Modify: `e2e/btw.e2e.mjs`
- Modify: `CLAUDE.md` (repo root; the `/btw` section and the `e2e:btw` sentence in Commands)
- Modify: `docs/superpowers/specs/2026-11-06-side-question-followups-design.md` (one wording fix: a follow-up whose A→B source chat is gone is not refused by the RPC; its answer ends with `sourceGoneText`, as `btw:ask` does, and the UI disables the box)

**Interfaces:**
- Consumes: testids from Task 4.

- [ ] **Step 1: Update helpers**: `entry(page, id)` opens the thread first: if no `side-entry[data-side-id=id]` is visible, press `side-back` while a `side-thread` shows, then click the `side-row` whose `data-thread-id` is the id's root (callers pass root ids; add `openThread(page, rootId)`). `newestShown` reads the first `side-row`'s `data-thread-id`. `panelAsk` waits for `side-row`/thread instead of every entry. Existing steps 1–12 keep their assertions.
- [ ] **Step 2: Add step 13** after step 2 (main has moved on past the first side question): open `first`'s thread, type `and how many now?` in `side-follow-input`, Enter; the new entry has `thread === first.id`; its audit run has `--fork-session`, `--no-session-persistence` and the same fork entries as `first`'s (3 tool results, not 8); its prompt contains `<answer>Steps done: 3</answer>` and `<btw>and how many now?</btw>`; while it runs `side-follow` is disabled and `side-follow-note` reads `Wait for this answer to finish`; the list row shows `2 questions`; the chat still has one chip for the thread; no new chat items.
- [ ] **Step 3: Add step 14**: stop the follow-up → `side-again` shows on it and not on the root; Ask again reruns it with the root pair still in its prompt.
- [ ] **Step 4: Update CLAUDE.md**: in **`/btw` side questions** say entries form threads (`thread` on follow-ups, `btw:follow`), follow-ups fork from the root's server-only snapshot (point, `upTo`, context) and replay earlier Q&A capped at 40 000 characters, Ask again only on a thread's last entry, the panel lists thread rows (Dispatched style) that open a chat-style thread with a follow-up box, chips are one per thread; add the follow-up checks to the `e2e:btw` sentence.
- [ ] **Step 5: Run** from the repo root: `npm test`, `npm run typecheck`, `npm run e2e:btw`. Expected: all PASS. Report any failure with its output.

---

## Self-review notes

- Spec coverage: data + snapshot (T2), RPC (T2), refusals (T2/T3), prompt (T1/T2), Ask again/Stop/restart (T2, restart unchanged), chips/fork/sync/rename (T2/T3; sync passes unknown fields through, no change), list + thread UI (T4), e2e + docs (T5).
- Sync: `deploy/sync.mjs` joins `.btw.json` by entry id and copies entries whole; no task needed. The implementer of Task 5 checks it keeps `thread`/`snapshot` (read `mergeSide` or equivalent; no code change expected).
