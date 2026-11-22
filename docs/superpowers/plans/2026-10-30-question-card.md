# Question Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer an agent's `AskUserQuestion` from an interactive card (radio buttons, one question at a time), sending the answers back so the same reply continues.

**Architecture:** `AskUserQuestion` stops being auto-denied and becomes a pending approval card that only a new RPC (`chats:answerQuestions`) can answer, with `updatedInput.answers` (or a deny for Skip). Parsing and validation of questions/answers live in one shared pure module used by both server and UI. Group rooms show answered cards to other members and the moderator, and an answer resets the room's hop counter.

**Tech Stack:** TypeScript, Node 22, React 19, vitest, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-10-30-question-card-design.md`

## Global Constraints

- Never commit. The user's global CLAUDE.md forbids commits unless they ask; each task ends with a checkpoint, not a commit.
- No new dependencies. Dependencies stay pinned; versions are not bumped in this work.
- Never add `--dangerously-skip-permissions` or `bypassPermissions`.
- Comments are short and say *why*, matching the surrounding code.
- `ExitPlanMode` stays in `UNANSWERABLE_TOOLS` and is still auto-denied.
- CLI answer limits (CLI 2.1.299): each answer string ≤ 8192 chars; multi-select arrays only, ≤ `options.length + 1` entries; total answer chars ≤ 32768; `answers` keyed by exact `question` text; the original input must not already hold `answers`.
- UI copy, exactly: buttons `Send answers`, `Skip`, `Back`, `Next`, option row `Other`; status lines `Answered`, `Skipped` (existing `Not answered` unchanged); Skip's deny message `The user chose not to answer these questions.`; malformed input message `This question can't be shown.`; heading when no `title`: `A question for you` (1 question) or `<n> questions for you`.
- A new API method touches `ZumiBotApi` (`shared/src/types.ts`), `rpc/handlers.ts` and `frontend/src/net/api.ts`.

## Review Focus

1. **Blank "Other" text** (spaces only): the question counts as unanswered in the UI, and the server rejects a blank string. Tests: Task 1 (`checkAnswers` rejects `'  '`), Task 5 (`answerOf` returns null).
2. **Old or malformed inputs** (cards saved before this change with `input: {}`, a question without text, duplicate question texts): the card renders `This question can't be shown.` with only Skip while pending, or just its status line when done; never crashes. Tests: Task 1 (`parseQuestions` returns null), Task 5 (`shownAnswer` with undefined answer).
3. **Oversize answers** (Other text over 8192, total over 32768): server throws, card stays pending; UI text box has `maxLength={8192}`. Test: Task 1.
4. **Answering a card that is no longer pending** (double-click Send, answer after Stop): no-op, no throw, nothing sent twice. Test: Task 2.
5. **Two group members asking with the same request id**: `agent` picks the right card. Test: Task 4.

---

### Task 1: Shared question module and types

**Files:**
- Create: `zumi-bot-server/shared/src/questions.ts`
- Create: `zumi-bot-server/shared/tests/questions.test.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (`ApprovalStatus`, the `approval` member of `ChatItem`)
- Modify: `zumi-bot-server/frontend/src/state/approvals.ts` (`LINES`)
- Test: `zumi-bot-server/frontend/tests/approvals.test.ts`

**Interfaces:**
- Produces (in `types.ts`):
  - `ApprovalStatus` gains `'answered' | 'skipped'`.
  - `export type QuestionAnswers = Record<string, string | string[]>`
  - approval item gains `answers?: QuestionAnswers` (present only on `answered` cards).
- Produces (in `questions.ts`, imported as `@zumibot/shared/questions`):
  - `export const QUESTION_TOOL = 'AskUserQuestion'`
  - `export const ANSWER_MAX_CHARS = 8192`, `export const ANSWERS_MAX_CHARS = 32768`
  - `export interface QuestionOption { label: string; description: string | null; preview: string | null }`
  - `export interface Question { text: string; header: string; kind: 'choice' | 'text' | 'number'; multiSelect: boolean; options: QuestionOption[]; description: string | null; placeholder: string | null; min: number | null; max: number | null; step: number | null; defaultValue: number | null; unit: string | null }`
  - `export function parseQuestions(input: unknown): { title: string | null; questions: Question[] } | null`
  - `export function checkAnswers(input: unknown, answers: unknown): QuestionAnswers` (throws `TypeError`)

- [ ] **Step 1: Write the failing tests** in `shared/tests/questions.test.ts`

```ts
const input = {
  questions: [
    { question: 'Which text?', header: 'Mila key', options: [{ label: 'Master', description: 'short' }, { label: 'w5', description: 'long', preview: 'x' }], multiSelect: false },
    { question: 'Which sizes?', header: 'Sizes', options: [{ label: 'S', description: '' }, { label: 'M', description: '' }], multiSelect: true }
  ]
}
it('parses questions with defaults', () => {
  const p = parseQuestions(input)!
  expect(p.title).toBeNull()
  expect(p.questions.map((q) => [q.text, q.kind, q.multiSelect, q.options.length])).toEqual([['Which text?', 'choice', false, 2], ['Which sizes?', 'choice', true, 2]])
  expect(p.questions[0].options[1]).toEqual({ label: 'w5', description: 'long', preview: 'x' })
})
it('reads the extended kinds', () => {
  const p = parseQuestions({ title: 'T', questions: [{ question: 'Name?', header: 'N', kind: 'text', placeholder: 'type' }, { question: 'How many?', header: 'C', kind: 'number', min: 1, max: 5, unit: 'px' }] })!
  expect(p.title).toBe('T')
  expect(p.questions.map((q) => [q.kind, q.options.length, q.placeholder, q.min, q.max, q.unit])).toEqual([['text', 0, 'type', null, null, null], ['number', 0, null, 1, 5, 'px']])
})
it.each([[{}], [null], [{ questions: [] }], [{ questions: [{ header: 'h' }] }], [{ questions: [{ question: 'a?' }, { question: 'a?' }] }], [{ questions: [{ question: 'a?', kind: 'slider' }] }]])(
  'malformed input %j parses to null', (bad) => expect(parseQuestions(bad)).toBeNull())
it('accepts a full, valid answer set', () => {
  expect(checkAnswers(input, { 'Which text?': 'Master', 'Which sizes?': ['S', 'my own'] })).toEqual({ 'Which text?': 'Master', 'Which sizes?': ['S', 'my own'] })
})
it.each([
  ['not an object', ['x']],
  ['a missing question', { 'Which text?': 'Master' }],
  ['an unknown question', { 'Which text?': 'Master', 'Which sizes?': ['S'], 'Other?': 'x' }],
  ['a blank answer', { 'Which text?': '  ', 'Which sizes?': ['S'] }],
  ['a list for a single-select question', { 'Which text?': ['Master'], 'Which sizes?': ['S'] }],
  ['an empty list', { 'Which text?': 'Master', 'Which sizes?': [] }],
  ['too many choices', { 'Which text?': 'Master', 'Which sizes?': ['S', 'M', 'a', 'b'] }],
  ['an answer over 8192 chars', { 'Which text?': 'x'.repeat(8193), 'Which sizes?': ['S'] }]
])('rejects %s', (_name, answers) => expect(() => checkAnswers(input, answers)).toThrow(TypeError))
it('rejects input that already carries answers, or malformed input', () => {
  expect(() => checkAnswers({ ...input, answers: {} }, { 'Which text?': 'Master', 'Which sizes?': ['S'] })).toThrow(TypeError)
  expect(() => checkAnswers({}, {})).toThrow(TypeError)
})
it('accepts a total right at 32768 chars, and rejects one char over', () => {
  // Four single-value questions at the 8192 per-answer cap sum to exactly 32768: the inclusive boundary.
  const four = { questions: Array.from({ length: 4 }, (_, i) => ({ question: `Q${i}?`, header: 'H', kind: 'text' })) }
  const atCap = Object.fromEntries(four.questions.map((q) => [q.question, 'x'.repeat(8192)]))
  expect(checkAnswers(four, atCap)).toEqual(atCap)
  // A fifth question's single extra char pushes the total to 32769, one over the cap.
  const five = { questions: [...four.questions, { question: 'Q4?', header: 'H', kind: 'text' }] }
  expect(() => checkAnswers(five, { ...atCap, 'Q4?': 'x' })).toThrow(TypeError)
})
```

And in `frontend/tests/approvals.test.ts`: `expect(approvalLine('answered')).toBe('Answered')`, `expect(approvalLine('skipped')).toBe('Skipped')`.

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run zumi-bot-server/shared/tests/questions.test.ts zumi-bot-server/frontend/tests/approvals.test.ts`
Expected: FAIL (module not found; `approvalLine('answered')` undefined).

- [ ] **Step 3: Implement** the types in `types.ts`, `questions.ts`, and the two `LINES` entries.

`parseQuestions` returns null when: input is not a plain object; `questions` is not a non-empty array; any question is not a plain object or has no non-empty string `question`; two questions share the same text (answers are keyed by text); `kind` is present but not `choice`/`text`/`number`; an option is not an object with a string `label`. Missing `header`/`description`/etc. default to `''`/`null`; `multiSelect` is `true` only when exactly `true`; `options` default to `[]`. `checkAnswers` checks, in order: input parses and has no own `answers`; answers is a plain object; its keys equal the question texts exactly; each value is a non-blank string (≤ `ANSWER_MAX_CHARS`), or for a `multiSelect` question an array of 1..`options.length + 1` non-blank strings (each ≤ `ANSWER_MAX_CHARS`); total chars ≤ `ANSWERS_MAX_CHARS`. Returns the answers unchanged.

- [ ] **Step 4: Run, expect pass**; also `npm run typecheck`.

Run: `npx vitest run zumi-bot-server/shared/tests/questions.test.ts zumi-bot-server/frontend/tests/approvals.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Checkpoint** (no commit).

---

### Task 2: Server answers question cards

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/controlProtocol.ts` (`UNANSWERABLE_TOOLS`, new `SKIPPED_BY_USER`)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`TurnSlot`, `TurnSpec`, `permissionRequest` case, `slot.answer`, new public `answerQuestions`)
- Modify: `CLAUDE.md` (one sentence under **Running claude**)
- Test: `zumi-bot-server/backend/tests/core/controlProtocol.test.ts`, `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: `QUESTION_TOOL`, `checkAnswers`, `QuestionAnswers` (Task 1).
- Produces:
  - `export const SKIPPED_BY_USER = 'The user chose not to answer these questions.'`
  - `UNANSWERABLE_TOOLS` = `new Set(['ExitPlanMode'])`
  - `TurnSlot.answerQuestions: ((requestId: string, answers: QuestionAnswers | null) => void) | null`
  - `TurnSpec.onAnswered?(): void` — called once when the user answers (not on Skip) a question card of this turn.
  - `ChatService.answerQuestions(chatId: string, requestId: string, answers: QuestionAnswers | null, agent?: string): void` — `null` = Skip. Throws `TypeError` (from `checkAnswers`) before anything is sent when answers are invalid; silently does nothing when no matching pending card exists.

- [ ] **Step 1: Update and add failing tests** in `chatService.test.ts` (inside `describe('approvals')`, using its `req`, `hold`, `statusOf`, `approvals`, `counts` helpers; `q = { questions: [{ question: 'Pick?', header: 'P', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] }`):
  - Rename `'AskUserQuestion is denied automatically'` to `'ExitPlanMode is denied automatically'` and switch its tool name; same for the `'unanswerable tools are never auto-allowed by an agent rule'` test (rule and request for `ExitPlanMode`).
  - `'a question becomes a pending card'`: `hold(c.id, [req('r1', null, q, 'AskUserQuestion')])` → `sent` is `[]`, `statusOf` is `['pending']`, `counts()` is `[1]`.
  - `'a question is never auto-allowed'`: with `rules.add('helper', ruleOf('AskUserQuestion', q))`, the card is still `pending` and `sent` is `[]`. (Chat memory cannot hold a question: allow decisions on question cards are ignored.)
  - `'answering sends the answers'`: `svc.answerQuestions(c.id, 'r1', { 'Pick?': 'B' })` → `sent` equals `[allowResponse('r1', { ...q, answers: { 'Pick?': 'B' } })]`; stored card has `status: 'answered'`, `answers: { 'Pick?': 'B' }`; `counts()` ends with `0`.
  - `'Skip denies the questions'`: `svc.answerQuestions(c.id, 'r1', null)` → `sent` equals `[denyResponse('r1', 'The user chose not to answer these questions.')]`; status `skipped`.
  - `'bad answers throw and leave the card pending'`: `expect(() => svc.answerQuestions(c.id, 'r1', { 'Pick?': ' ' })).toThrow(TypeError)`; `sent` is `[]`; status `pending`.
  - `'chats:answer on a question card: deny skips, allow is ignored'`: `svc.answer(c.id, 'r1', 'allow-once')` → `sent` `[]`, still pending; `svc.answer(c.id, 'r1', 'deny')` → status `skipped`, deny with `SKIPPED_BY_USER`.
  - `'answering twice or after Stop is harmless'`: answer, answer again → `sent` has length 1; on a second chat, `svc.stop` then `answerQuestions` → no throw, status `unanswered`.
  - `'onAnswered runs on answer, not on Skip'`: drive `svc.agentTurn` with a spec carrying `onAnswered: vi.fn()` (pattern of the existing `'stamps the author'` test), answer → called once; a second card skipped → still once.
  - In `controlProtocol.test.ts`, replace the `UNANSWERABLE_TOOLS.has('AskUserQuestion')` expectation with `false`, and expect `has('ExitPlanMode')` to be `true`.

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/backend/tests/core/controlProtocol.test.ts`
Expected: FAIL (`answerQuestions` is not a function; question still auto-denied).

- [ ] **Step 3: Implement.** In the `permissionRequest` case, a `QUESTION_TOOL` request skips both auto-allow branches and goes to the pending branch. `slot.answerQuestions` replies (`allowResponse(requestId, { ...(p.input as object), answers })`, or `denyResponse(requestId, SKIPPED_BY_USER)` plus `blockTool`), sets status (`answered` with `answers` stored on the card / `skipped` / `unanswered` when the reply fails), saves, pushes, `pushApprovals()`, and on a successful answer calls `spec.onAnswered?.()`. At the top of `slot.answer`, a question card is routed: `deny` → `slot.answerQuestions(requestId, null)`; anything else returns without change. The public `answerQuestions` finds the slot like `answer()` does, then runs `checkAnswers(p.input, answers)` (when not null) before calling the slot. Add to CLAUDE.md, after the sentence about approval cards: "`AskUserQuestion` gets a question card instead; the answers go back as `updatedInput.answers` (`chats:answerQuestions`)."

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run --project backend && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint** (no commit).

---

### Task 3: RPC method

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.chats`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts`
- Modify: `zumi-bot-server/frontend/src/net/api.ts`
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`, `zumi-bot-server/frontend/tests/net/api.test.ts`

**Interfaces:**
- Consumes: `ChatService.answerQuestions` (Task 2), `QuestionAnswers` (Task 1).
- Produces: `ZumiBotApi.chats.answerQuestions(chatId: string, requestId: string, answers: QuestionAnswers | null, agent?: string): Promise<void>` over RPC name `'chats:answerQuestions'`.

- [ ] **Step 1: Write failing tests.** In `handlers.test.ts` add `'chats:answerQuestions'` to `KEPT`; add `'chats:answerQuestions rejects answers that are not an object or null'` (`await expect(h['chats:answerQuestions'](id, 'r1', 'B')).rejects.toThrow(TypeError)`, same for `['B']`) and `'chats:answerQuestions accepts null answers and a null agent'` (resolves with no running chat). In `api.test.ts`: `await make(rpc).chats.answerQuestions('c', 'r', null)` → `rpc.call` called with `('chats:answerQuestions', ['c', 'r', null, undefined])` (match how the existing `chats.answer` mapping test passes args).

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run zumi-bot-server/backend/tests/rpc/handlers.test.ts zumi-bot-server/frontend/tests/net/api.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Handler checks `chatId`/`requestId` with `str()`, `answers` is `null` or a plain object (else `TypeError('answers must be an object or null')`), `agent` like `chats:answer` (null/undefined → undefined); deeper checks stay in `ChatService` (`checkAnswers`) and are deliberately not caught, like `chats:answer`.

- [ ] **Step 4: Run, expect pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint** (no commit).

---

### Task 4: Group rooms share answers and restart the count

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/groupPrompts.ts` (`threadEntries`)
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts` (`runTurn`'s `TurnSpec`)
- Test: `zumi-bot-server/backend/tests/core/groupPrompts.test.ts`, `zumi-bot-server/backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `parseQuestions`, `QUESTION_TOOL` (Task 1); `TurnSpec.onAnswered`, `ChatService.answerQuestions` (Task 2).
- Produces: `threadEntries` emits, for an `answered` `AskUserQuestion` card whose `agent` is not `me` and that has no live `turn`, `{ from: null, text }` at the card's position, where `text` is exactly:

```
Answers to <agent>'s questions:

<question 1>
→ <answer 1>

<question 2>
→ <answer 2>
```

  (list answers joined with `', '`; no `@`, so it never reads as a mention).

- [ ] **Step 1: Write failing tests.**
  - `groupPrompts.test.ts` `'threadEntries shows answered questions to other members'`: items `[user u1 'go', approval {id:'r1', toolName:'AskUserQuestion', input: {questions:[{question:'Which?',header:'W',options:[{label:'Yes',description:''},{label:'No',description:''}]}]}, status:'answered', answers:{'Which?':'Yes'}, agent:'a', ...}, assistant a1 'done' agent 'a']` → for `me='b'`: `[{from:null,text:'go'}, {from:null,text:"Answers to a's questions:\n\nWhich?\n→ Yes"}, {from:'a',text:'done'}]`; for `me='a'` the answers entry is absent; the same card with `status:'skipped'` or `'pending'` gives no entry.
  - `groupService.test.ts` `'answering a question restarts the turn count'`: like `'pauses after 15 turns without the user'`, but the first `ui` turn emits a `permissionRequest` for `AskUserQuestion` and hangs; the test answers it with `chats.answerQuestions(c.id, 'r1', { 'Which?': 'Yes' }, 'ui')`, finishes the turn, and lets the ping-pong run. Expect `calls` length `16` (turn 1, then 15 more after the reset) and the last item the `paused` notice.
  - `groupService.test.ts` `'answerQuestions reaches the asking member when request ids clash'`: like `'"Allow always for this agent" saves the rule under the member that asked'`, but both `ui` and `wk` emit `AskUserQuestion` with request id `r1`; `chats.answerQuestions(c.id, 'r1', {…}, 'wk')` → `pendingCount` drops to 1, and after both finish the stored cards are `[['ui','unanswered'],['wk','answered']]`.

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run zumi-bot-server/backend/tests/core/groupPrompts.test.ts zumi-bot-server/backend/tests/core/groupService.test.ts`
Expected: FAIL (no answers entry; 15 calls).

- [ ] **Step 3: Implement.** `threadEntries` gets an `approval` branch using `parseQuestions(item.input)` (skip the card if it returns null or `answers` is absent). In `runTurn`'s spec add `onAnswered: () => { room.hops = 0 }`, with a comment that an answer counts as the user taking part.

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run --project backend`
Expected: PASS.

- [ ] **Step 5: Checkpoint** (no commit).

---

### Task 5: Frontend question state

**Files:**
- Create: `zumi-bot-server/frontend/src/state/questions.ts`
- Modify: `zumi-bot-server/frontend/src/state/approvals.ts` (add `ApprovalReply`)
- Test: `zumi-bot-server/frontend/tests/questions.test.ts`

**Interfaces:**
- Consumes: `Question`, `QuestionAnswers` (Task 1).
- Produces:
  - `export type ApprovalReply = ApprovalDecision | { answers: QuestionAnswers | null }` (in `approvals.ts`)
  - `export interface QuestionPick { labels: string[]; other: string | null }` — `other: null` = Other not chosen (not `Pick`, which would shadow TypeScript's utility type)
  - `export interface Draft { step: number; picks: Record<string, QuestionPick> }` (keyed by question text)
  - `export const EMPTY_DRAFT: Draft` (`{ step: 0, picks: {} }`)
  - `export function choose(d: Draft, qs: Question[], label: string): Draft` — option click on the current step
  - `export function chooseOther(d: Draft, qs: Question[]): Draft`
  - `export function typeOther(d: Draft, qs: Question[], text: string): Draft` — also the input for `text`/`number` kinds
  - `export function goTo(d: Draft, qs: Question[], step: number): Draft` — clamps to `0..qs.length-1`
  - `export function answerOf(q: Question, p: QuestionPick | undefined): string | string[] | null`
  - `export function buildAnswers(qs: Question[], d: Draft): QuestionAnswers | null` — null unless every question has an answer
  - `export function shownAnswer(q: Question, a: string | string[] | undefined): QuestionPick` — splits a sent answer into option labels and leftover Other text, for the read-only view

- [ ] **Step 1: Write failing tests** (`qs` = parsed single-select `Which?` [Yes, No] + multi-select `Sizes?` [S, M]):
  - `choose` on step 0 picks `Yes` and moves to step 1; on the last step it picks without moving.
  - `choose` on a multi-select toggles labels in option order (`M` then `S` → `['S','M']`; `S` again → `['M']`) and never moves.
  - `chooseOther` on a single-select clears the label (`{labels:[], other:''}`) and does not move; `typeOther(…, ' blue ')` → `answerOf` is `'blue'`; `typeOther(…, '   ')` → `answerOf` is `null`.
  - multi-select with `S` and Other `'XL'` → `answerOf` is `['S','XL']`; nothing chosen → `null`.
  - `buildAnswers` is `null` with one question unanswered, and `{ 'Which?': 'Yes', 'Sizes?': ['S'] }` when both are.
  - `goTo(d, qs, 5).step` is `1`; `goTo(d, qs, -1).step` is `0`.
  - `shownAnswer(single, 'Yes')` → `{labels:['Yes'], other:null}`; `shownAnswer(single, 'teal')` → `{labels:[], other:'teal'}`; `shownAnswer(multi, ['S','XL'])` → `{labels:['S'], other:'XL'}`; `shownAnswer(single, undefined)` → `{labels:[], other:null}`.

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run zumi-bot-server/frontend/tests/questions.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** the module and `ApprovalReply`.

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run --project frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint** (no commit).

---

### Task 6: Question card UI

**Files:**
- Create: `zumi-bot-server/frontend/src/components/QuestionCard.tsx`
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx` (`case 'approval'`, `GroupProps.onAnswer`, `onAnswerApproval`)
- Modify: `zumi-bot-server/frontend/src/components/WorkingTray.tsx`, `ChatView.tsx` (callback types `ApprovalDecision` → `ApprovalReply`)
- Modify: `zumi-bot-server/frontend/src/App.tsx` (`answerApproval`)
- Modify: `zumi-bot-server/frontend/src/styles.css` (next to `.approval*`)

**Interfaces:**
- Consumes: `parseQuestions` (Task 1), `api.chats.answerQuestions` (Task 3), the Task 5 module, `isActionable`/`approvalLine` (`state/approvals.ts`).
- Produces: `export function QuestionCard({ item, chatRunning, onAnswer }: { item: ApprovalItem; chatRunning: boolean; onAnswer: (requestId: string, reply: ApprovalReply) => void })`. DOM hooks: `question-card` (+ `data-status`, `data-request-id`), `question-tab` (+ `data-done`), `question-option` (+ `data-label`, an `<input type="radio">` or `checkbox` inside a `<label>`), `question-other`, `question-other-input`, `question-back`, `question-next`, `question-send`, `question-skip`.

- [ ] **Step 1: Build the card.** Behavior is the spec's "Behavior the user decided" plus "Left to the builder"; copy from Global Constraints.
  - Pending + `isActionable`: `title ?? heading` line, tabs (header; `✓ ` prefix when answered), the current step's question, `description` line, options (radio for single-select, checkbox for multi), `preview` as `<pre>` under a selected option, `Other` row whose text box (`maxLength={8192}`) shows when chosen. `text` kind: text box only; `number` kind: `<input type="number">` with `min`/`max`/`step`, `defaultValue` as its placeholder, and the unit beside it. Footer: `Question <i> of <n>` hint, `Back` (not on step 0), `Skip`, `Next` (multi-select, Other or text/number steps, when not last), `Send answers` (last step, disabled until `buildAnswers` is non-null). Draft held in `useState(EMPTY_DRAFT)`.
  - Send → `onAnswer(item.id, { answers })`; Skip → `onAnswer(item.id, { answers: null })`.
  - Otherwise (done, or pending while the chat is not running): read-only, every question with `shownAnswer(q, item.answers?.[q.text])` highlighted (`--sel-bg`/`--sel-border`), other options dimmed, Other text as its own highlighted row, then `approvalLine(item.status)` (`Not answered` for pending-not-running, matching `ApprovalCard`).
  - `parseQuestions` null: `This question can't be shown.`, plus `Skip` while actionable, else the status line.
  - Styles: reuse `.approval`/`.approval.pending` framing; new `.question-*` classes use only existing tokens; no horizontal scroll at 360px width; previews `white-space: pre-wrap; overflow-wrap: anywhere` in `--font-mono`.
- [ ] **Step 2: Wire it.** `MessageList` `case 'approval'` renders `QuestionCard` when `item.toolName === QUESTION_TOOL`, else `ApprovalCard` (whose `onAnswer` keeps passing a plain `ApprovalDecision`, which is an `ApprovalReply`). `App.answerApproval(chatId, requestId, reply: ApprovalReply, agent?)` calls `api.chats.answer` for a string and `api.chats.answerQuestions(chatId, requestId, reply.answers, agent)` otherwise, with the same `failChat` error handling.
- [ ] **Step 3: Verify build and types**

Run: `npm run typecheck && npm test && npm run build:server`
Expected: all PASS, build succeeds.

- [ ] **Step 4: Checkpoint** (no commit).

---

### Task 7: End-to-end check with the fake claude

**Files:**
- Modify: `zumi-bot-server/e2e/routines.e2e.mjs` (header's DOM hooks list; `start()` env; new step 7)

**Interfaces:**
- Consumes: the DOM hooks of Task 6; the fake claude's `FAKE_RESPONSES_FILE` (appends every `control_response` line it receives).

- [ ] **Step 1: Add step 7** after step 6. Pass `FAKE_RESPONSES_FILE: join(<a mkdtemp dir made here>, 'responses.jsonl')` in `start()`'s env. Rewrite `h.script` as step 6 does, but the injected `control_request` is `{ request_id: 'req-e2e-question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: <two questions: 'Which color?' [Red, Blue] single-select, 'Which sizes?' [S, M] multiSelect>, description: 'Ask', tool_use_id: 'toolu_q' } }` followed by `#WAIT_RESPONSE req-e2e-question`.
  - Run now → run `waiting` and `mode-waiting` visible → open chat → click `question-option[data-label="Blue"]` (moves to step 2) → tick `S` and `M` → `question-send`. Assert: card `data-status` becomes `answered`; run becomes `done`; the last line of the responses file has `response.response.behavior === 'allow'` and `updatedInput.answers` deep-equals `{ 'Which color?': 'Blue', 'Which sizes?': ['S', 'M'] }`; the read-only card shows both questions.
  - Run again → open chat → `question-skip`. Assert: `data-status` `skipped`; last response is `behavior: 'deny'` with message `The user chose not to answer these questions.`; run `done`.
  - Steps assert structure, never reply wording, like the rest of the file.
- [ ] **Step 2: Run**

Run: `npm run e2e:routines`
Expected: every `ok` line including the two new ones, then `e2e:routines passed`.

- [ ] **Step 3: Confirm the multi-select format with the real CLI (ask the user first: it spends a little real quota).** In the scratchpad, a Node script spawns `claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`, sends one user message asking it to call `AskUserQuestion` once with a single `multiSelect` question (options `Apple`, `Banana`) and then repeat the answer, answers the `can_use_tool` request with `allowResponse(id, { ...input, answers: { [question]: ['Apple', 'Banana'] } })`, and checks that the `AskUserQuestion` `tool_result` is not an error and names both labels. If the CLI refuses the array, change Task 5's `answerOf` to join multi-select answers with `', '` into a string, update its test and the e2e expectation, and rerun Tasks 5 and 7.

- [ ] **Step 4: Final verification**

Run: `npm test && npm run typecheck && npm run build:server && npm run e2e:routines`
Expected: all pass. Kill any leftover Chrome/server processes from the e2e run.

- [ ] **Step 5: Checkpoint** (no commit; the user asks for a commit message when ready).
