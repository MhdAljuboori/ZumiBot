# Side Question Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An input at the top of Side panel › Side questions in every chat, and side questions in read-only A→B chats answered by B (from the A→B chat) or A (from the chat A asked from, with a snapshot of B's progress).

**Architecture:** No new RPC. The panel turns its "Answer from" chip into a leading `@handle` on the question, which `sideParts` already parses. `SideQuestions` learns that an A→B chat has two answerers and, for A, reads its base, fork point, seed, browser and desktop from `asked.from` while storing the entry under the A→B chat. A new pure builder turns the A→B chat's items into the thread A's side message carries.

**Tech Stack:** TypeScript, Node 22, React 19, vitest, playwright-core e2e with the fake memory claude.

**Spec:** `docs/superpowers/specs/2026-11-05-side-question-input-design.md`

## Global Constraints

- No commits and no pushes: the user's global rule. The skill's commit steps are left out; the user commits.
- Questions are capped at `COMMAND_PROMPT_MAX` (8000, `shared/src/commands.ts`), already enforced by `btw:ask`.
- At most `SIDE_MAX_OPEN` (3) open side answers per chat; the limit error text stays `SIDE_LIMIT_TEXT`.
- Deleted-source error, exact: `` `The chat @${agent} asked from was deleted` `` (no chat id, no path).
- Every other read-only guard on A→B chats stays (send, edit, resend, version switch, fork, compact, mark unread).
- Side answers never mark unread, notify or unarchive (unchanged; do not add any of these).
- Comments short and about *why*; dependencies unchanged.
- Run from repo root: `npm test`, `npm run typecheck`, `npm run e2e:btw`.

## Review Focus

1. **A typed `@handle` naming neither A nor B in an A→B chat** → the server refuses with "<Name> is not in this chat", the panel shows it under the input and keeps the text (Task 2 test, Task 3 test).
2. **A's source chat is itself an A→B chat** (X asked A, A asked B) → asking A still forks from `asked.from`, the X→A chat (Task 2 test).
3. **Ask again on A's entry after the source chat was deleted** → the entry fails with the fixed error, no CLI run (Task 2 test).
4. **Rename of A after an entry exists** → Ask again still answers as A (the renamed name), from the source chat (Task 2 test).
5. **Both with only one free slot** → Both chip disabled with a reason; the user cannot start a half pair (Task 3 test).

---

### Task 1: A→B snapshot builder

**Files:**
- Modify: `zumi-bot-server/backend/src/core/btw/sidePrompt.ts`
- Test: `zumi-bot-server/backend/tests/core/sidePrompt.test.ts`

**Interfaces:**
- Consumes: `toolSummary(name, input)` from `@zumibot/shared/toolSummary`; `ThreadEntry`, `threadLines` from `../chat/groupPrompts`.
- Produces:
  - `export const ASKED_THREAD_MAX = 20_000`
  - `export function askedThread(items: readonly ChatItem[], asker: string, owner: string, max = ASKED_THREAD_MAX): { entries: ThreadEntry[]; cut: boolean }`
  - `export function askedLead(owner: string, cut: boolean): string`
  - `sideMessage(question: string, thread: ThreadEntry[] | null, lead?: string): string` and `seededSideMessage(items: ChatItem[], question: string, thread?: ThreadEntry[] | null, lead?: string): string` — `lead`, when given, is the first line, before the thread lines.

- [ ] **Step 1: Write the failing tests** in `sidePrompt.test.ts`:

```ts
const ab: ChatItem[] = [
  { type: 'user', id: 'u', text: 'Write the CSV parser', ts: 1, from: 'planner' },
  { type: 'tool', id: 't', name: 'Bash', input: { command: 'npm test\nmore' }, result: 'ok', isError: false, blocked: false, ts: 2, turn: 'live' },
  { type: 'assistant', id: 'a', text: 'Parser half done', ts: 3, turn: 'live' },
  { type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped', ts: 4 }
]
test('askedThread keeps the asker message, live text and one line per tool step', () => {
  expect(askedThread(ab, 'planner', 'coder')).toEqual({ cut: false, entries: [
    { from: 'planner', text: 'Write the CSV parser' },
    { from: 'coder', text: 'Used Bash(npm test)' },
    { from: 'coder', text: 'Parser half done' }
  ] })
})
test('askedThread over the cap keeps the first message and the newest', () => {
  const many: ChatItem[] = [ab[0], ...Array.from({ length: 50 }, (_, n): ChatItem => ({ type: 'assistant', id: `a${n}`, text: `step ${n} ${'x'.repeat(100)}`, ts: 10 + n }))]
  const { entries, cut } = askedThread(many, 'planner', 'coder', 1000)
  expect(cut).toBe(true)
  expect(entries[0]).toEqual({ from: 'planner', text: 'Write the CSV parser' })
  expect(entries.at(-1)!.text).toContain('step 49')
  expect(entries.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(1000)
})
test('sideMessage puts the lead before the thread lines', () => {
  const lines = sideMessage('How is it going?', [{ from: 'coder', text: 'Half done' }], askedLead('coder', false)).split('\n')
  expect(lines[0]).toBe(askedLead('coder', false))
  expect(lines[1]).toContain('Half done')
  expect(lines.at(-1)).toBe('<btw>How is it going?</btw>')
})
test('askedLead names the asked agent and says when older messages were left out', () => {
  expect(askedLead('coder', false)).toContain('@coder')
  expect(askedLead('coder', true)).toMatch(/left out/)
})
```

- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/sidePrompt.test.ts` — expect FAIL (`askedThread` is not exported).

- [ ] **Step 3: Implement** in `sidePrompt.ts`. `askedThread` maps, ignoring `turn`: `user` → `{ from: item.from ?? asker, text }`; `assistant` → `{ from: owner, text }`; `tool` → `{ from: owner, text: \`Used ${toolSummary(name, input)}\` }`; every other item type is skipped. Over `max` total text length: keep entry 0, then add entries from the newest back while they fit, set `cut: true`. `askedLead` wording (exact): `` `These are the messages of your ask to @${owner} so far, newest last${cut ? ', older ones left out' : ''}:` ``. Add the optional `lead` to `sideMessage`/`seededSideMessage` without changing output when it is absent.

- [ ] **Step 4: Run** the same command — expect PASS, and the existing `sidePrompt` tests still pass.

---

### Task 2: Side questions in A→B chats (backend)

**Files:**
- Modify: `zumi-bot-server/shared/src/btw.ts` (add `sourceGoneText`)
- Modify: `zumi-bot-server/backend/src/core/btw/sideQuestions.ts` (`ask`, `again`, `answer`/`prepare`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts:303-308` (drop `writable` from `btw:ask`)
- Test: `zumi-bot-server/backend/tests/core/sideQuestions.test.ts`, `zumi-bot-server/backend/tests/rpc/handlers.test.ts`

**Interfaces:**
- Consumes: `askedThread`, `askedLead`, `sideMessage(q, thread, lead)`, `seededSideMessage(items, q, thread, lead)` from Task 1.
- Produces: `export const sourceGoneText = (agent: string): string => \`The chat @${agent} asked from was deleted\`` in `shared/src/btw.ts` (Task 3 uses it for the disabled chip's title).

Rules (from the spec):
- Members a mention may name: room → `group.members`; A→B chat (`meta.asked`) → `[meta.agentName, meta.asked.by]`; other single chat → `[meta.agentName]`.
- No mention, or a mention of `meta.agentName`, in a single chat (A→B included) → entry exactly as today (`agent: meta.agentName`, no `mention`). A mention of `asked.by` → `agent: asked.by, mention: true`.
- `again()`: a `mention` entry outside a room keeps its agent while it equals the chat's current `asked.by`; otherwise refuse with the existing "is not in this chat" error.
- `prepare()` re-reads the A→B chat (`store.get(chatId)`; gone → `this.stop` as today). The session chat is `home.asked && agent === home.asked.by ? home.asked.from : chatId`. When it differs: `store.get(from)` null → throw `new Error(sourceGoneText(agent))` before any base, browser or run; otherwise use `from` for `sideBase`, `baseFor`, `sideBrowser`, `sideDesktop`, the meta and items given to `point()`, and the seed items; the thread is `askedThread(loadItems(chatId), agent, home.agentName)` with `askedLead(home.agentName, cut)`.
- Storage, broadcast, the limit, Stop, cost (`recordCost` with `chatId` = the A→B chat, `agent` = A) stay keyed by the A→B chat.

- [ ] **Step 1: Write the failing tests.** Add an `askedFixture()` beside `fixture()`: metas `ab` (`agentName: 'coder'`, `asked: { by: 'planner', from: 'src', fromTitle: 'Import', chain: [] }`, `sessionId: 'coder-session'`) and `src` (`agentName: 'planner'`, `sessionId: 'planner-session'`), items per id (`src`: an assistant item with `end: { session: 'planner-session', at: 'planner-at' }` and text 'Plan history'; `ab`: the Task 1 `ab` items plus an assistant with `end: { session: 'coder-session', at: 'coder-at' }`), `store.get`/`loadItems` returning by id, `sideBase` keyed by `` `${chat}\n${agent}` `` (both `null` by default, so `baseFor` is used), `remove(id)` deleting a meta. Tests:

```ts
test('an A→B chat with no mention answers as the asked agent from its own chat', async () => {
  const f = askedFixture()
  expect(await f.service.ask('ab', 'Where are you at?', 'q')).toMatchObject({ agent: 'coder' })
  await started(f)
  expect(f.deps.baseFor).toHaveBeenCalledWith('ab', 'coder')
  expect(f.runs[0].options.args).toEqual(expect.arrayContaining(['--resume', 'coder-session', '--resume-session-at', 'coder-at']))
  expect(f.runs[0].options.stdin).not.toContain('These are the messages')
})
test('@asker answers as the asker from the source chat with the A→B snapshot', async () => {
  const f = askedFixture()
  expect(await f.service.ask('ab', '@planner How is coder doing?', 'q')).toMatchObject({ agent: 'planner', mention: true })
  await started(f)
  expect(f.deps.baseFor).toHaveBeenCalledWith('src', 'planner')
  expect(f.deps.chats.sideBrowser).toHaveBeenCalledWith('src', 'planner')
  expect(f.runs[0].options.args).toEqual(expect.arrayContaining(['--resume', 'planner-session', '--resume-session-at', 'planner-at']))
  const stdin = f.runs[0].options.stdin
  expect(stdin).toContain(askedLead('coder', false))
  expect(stdin).toContain('Parser half done')
  expect(stdin).toContain('Used Bash(npm test)')
  expect(stdin).toContain('<btw>How is coder doing?</btw>')
  expect((await f.service.list('ab'))[0].agent).toBe('planner')
})
test('a deleted source chat fails the asker entry with no run', async () => {
  const f = askedFixture(); f.remove('src')
  await f.service.ask('ab', '@planner status?', 'q'); await finished(f)
  expect(f.runs).toHaveLength(0)
  expect((await f.service.list('ab'))[0]).toMatchObject({ state: 'error', error: 'The chat @planner asked from was deleted' })
})
test('an A→B chat refuses a mention of anyone else', async () => {
  await expect(askedFixture().service.ask('ab', '@writer hi', 'q')).rejects.toThrow('Writer is not in this chat')
})
test('the source chat may itself be an A→B chat', async () => {
  // src meta also gets asked: { by: 'lead', from: 'top', fromTitle: 'Top', chain: [] }
  // '@planner' → baseFor called with ('src', 'planner'), never ('top', …); the run resumes planner-session at planner-at.
})
test('Ask again keeps the asker, after a rename too, and fails once the source is gone', async () => {
  // ask '@planner', runs[0].finish({ exitCode: 1, result: null }) → state 'error'.
  // service.renameAgent('planner', 'boss'); fixture sets ab.asked.by = 'boss' and src.agentName = 'boss'.
  // again('ab', 'q') → resolves with agent 'boss'; baseFor last called with ('src', 'boss'); runs.length === 2.
  // runs[1] fails the same way; remove('src'); again('ab', 'q') → entry error === sourceGoneText('boss'); runs.length stays 2.
})
```

In `handlers.test.ts`: `btw:ask` on a chat whose meta has `asked` resolves (calls `d.side.ask`), while `chats:send` on the same chat still rejects with `This chat is read-only`.

- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/sideQuestions.test.ts zumi-bot-server/backend/tests/rpc/handlers.test.ts` — expect the new tests to FAIL.

- [ ] **Step 3: Implement** the rules above in `sideQuestions.ts`, `btw.ts` and `handlers.ts`. In `prepare()`, read both chats inside the existing `within(...)` waits so Stop and the deadline still cut them.

- [ ] **Step 4: Run** the same command — expect PASS, all existing side question tests included. Then `npm run typecheck`.

---

### Task 3: Panel pick rules (frontend, pure)

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/sideQuestions.ts`
- Test: `zumi-bot-server/frontend/tests/sideQuestions.test.ts`

**Interfaces:**
- Consumes: `sideParts`, `isOpen`, `SIDE_MAX_OPEN`, `sourceGoneText` from `@zumibot/shared/btw`; `displayName` from `@zumibot/shared/frontmatter`; `ChatMeta`, `AgentSummary` from `@zumibot/shared/types`.
- Produces:
  - `export interface PickChip { key: string; label: string; agent: string | null; disabled: string | null }` — `key` is `'auto'`, `'both'` or `` `agent:${name}` ``; `disabled` is the reason shown as the chip's title, or null.
  - `export function pickChips(chat: ChatMeta, agents: readonly AgentSummary[], sourceExists: boolean, list: readonly SideQuestion[]): PickChip[]`
  - `export function sideTexts(chat: ChatMeta, key: string, text: string): string[]` — the questions to send, in order; `[]` when `sideParts(text)` is null.
  - `export function newestFirst(list: readonly SideQuestion[]): SideQuestion[]`
  - `panelOrder` unchanged (chips under messages still use it).

- [ ] **Step 1: Write the failing tests:**
  - single chat → `pickChips` is `[]`; `sideTexts(single, '', ' hi ')` → `['hi']`.
  - room with members `[helper, writer, broken]` where `broken` has `error !== null` → keys `['auto', 'agent:helper', 'agent:writer']`, all enabled; `sideTexts(room, 'auto', 'hi')` → `['hi']`; `sideTexts(room, 'agent:writer', 'hi')` → `['@writer hi']`.
  - A→B chat (`agentName: 'coder'`, `asked.by: 'planner'`) → keys `['agent:coder', 'agent:planner', 'both']`, labels `displayName` of each and `'Both'`; `sideTexts(ab, 'agent:coder', 'hi')` → `['hi']`; `'agent:planner'` → `['@planner hi']`; `'both'` → `['hi', '@planner hi']`.
  - a typed leading handle wins: `sideTexts(ab, 'both', '@writer hi')` → `['@writer hi']`; `sideTexts(room, 'agent:helper', '@writer hi')` → `['@writer hi']`.
  - `sideTexts(ab, 'both', '   ')` → `[]`.
  - `sourceExists: false` → the planner chip and Both have `disabled === sourceGoneText('planner')`.
  - Both with 2 open entries in `list` → `disabled === 'Both needs 2 free side question slots'` (exact); with 1 open → enabled. A missing source wins over the slot reason.
  - `pickChips` works the same for an archived chat (`archivedAt` set): archiving changes nothing here.
  - `newestFirst` orders by `askedAt` descending, ties stable, without mutating its input.

- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/sideQuestions.test.ts` — expect FAIL.

- [ ] **Step 3: Implement** the four exports. The default pick is `chips[0]?.key ?? ''` (callers do this; no extra export).

- [ ] **Step 4: Run** the same command — expect PASS.

---

### Task 4: Panel input UI, order, dots, docs; e2e

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/SidePanel.tsx`
- Modify: `zumi-bot-server/frontend/src/App.tsx:1531-1548` (pass `sourceExists` and `onAsk`)
- Modify: `zumi-bot-server/frontend/src/styles.css` (input row and chips, following the To-dos input row `TodosPanel.tsx:141` and existing chip styles)
- Modify: `zumi-bot-server/e2e/btw.e2e.mjs`
- Modify: `CLAUDE.md` (`/btw` paragraph and Agent asks paragraph)

**Interfaces:**
- Consumes: `pickChips`, `sideTexts`, `newestFirst` (Task 3); `btw:ask` accepting A→B chats (Task 2).
- Produces: `SidePanel` props gain `sourceExists: boolean` and `onAsk(text: string): Promise<void>` (one call per text, App calls `api.btw.ask(chat.id, text, crypto.randomUUID())`). DOM hooks: `side-input` (textarea), `side-ask` (button), `side-pick` (chip button, `data-pick` = key, `aria-pressed`), `side-input-error`.

- [ ] **Step 1: Build the input row** between `.files-head` and `.side-list`: chips (omitted when `pickChips` is empty), the textarea (`maxLength={COMMAND_PROMPT_MAX}`, placeholder "Ask a side question…"), Ask. Local state: text, pick (reset to `chips[0]?.key ?? ''` on mount; the panel is keyed by chat id), busy, error. Enter (no Shift, not composing) asks; Shift+Enter adds a line. Ask sends `sideTexts(...)` in order through `onAsk`, stops at the first failure and shows it in `side-input-error`, clears the box only when every call succeeded, keeps focus in the box. A disabled chip cannot be picked and shows its reason as `title`; if the current pick becomes disabled (a slot filled), fall back to the first enabled chip. The list renders `newestFirst(list)`; the empty note stays below the input. `SideEntry` shows the color dot when `chat.group || chat.asked`.
- [ ] **Step 2: Wire App** — `sourceExists` = `shownChat.asked ? chats.some((c) => c.id === shownChat.asked!.from) : true`, `onAsk` as above. `npm run typecheck` passes.
- [ ] **Step 3: Extend `btw.e2e.mjs`** (fake memory claude, no quota). Before `start()`, create the data dir and seed `chats.json` plus `chats/<id>.json` for a source chat of `A` (`cwd: work`, no session, items: user "Plan the CSV import", assistant "I will ask for the parser") and an A→B chat of `B` with `asked: { by: A, from: <src id>, fromTitle: 'Plan', chain: [] }` (items: user `from: A` "Write the CSV parser", a finished `Bash` tool item `npm test`, assistant "Parser half done"); pass `dataDir` to `start()`. Add steps at the end:
  1. In the single chat from step 1: type in `side-input`, press Enter → a new entry is first in the panel (newest first) and the box is empty; no `side-pick` chips.
  2. In the existing room: chips are Auto plus each member; pick B's chip and ask → the stored entry has `agent: B`, `mention: true`.
  3. Open the A→B chat: `asked-bar` shows, `composer-input` is absent. Chips are B, A, Both. Ask with B → audit run has `--agent btw-other` and its prompt contains "Write the CSV parser" and not "Plan the CSV import". Ask with A → audit run has `--agent btw-alpha`, its prompt contains "Plan the CSV import", "Parser half done" and "Used Bash(npm test)". Ask with Both → two new entries, agents `[B, A]`, both reach `done`.
  4. A typed `@nobody hi` in the A→B chat shows `side-input-error` and keeps the text.
- [ ] **Step 4: Update `CLAUDE.md`**: the `/btw` paragraph gains the panel input (top, Answer from chips, newest first, no RPC change: a chip is a leading `@handle`); the Agent asks paragraph's read-only list drops `/btw` and says side questions there are answered by B from the A→B chat or by A from `asked.from` with the A→B snapshot (`askedThread`), failing with the deleted-source error when that chat is gone.
- [ ] **Step 5: Verify** — `npm test` all pass, `npm run typecheck` clean, `npm run e2e:btw` passes (it builds first). Then `npm run e2e:ask` still passes (A→B chats unchanged otherwise).
