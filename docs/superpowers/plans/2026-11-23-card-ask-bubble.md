# Card ask bubble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A card comment's `@agent` message shows in its chat as the comment bubble plus an inline card, while the agent reads the same full message as today.

**Architecture:** The user item gains `cardAsk {todoId, title, before, after}` and keeps only the comment as `text`. `readAs` composes `before + quote(text) + after` for the CLI. The field rides the send path (SubmitOptions, QueuedTask, TaskQueue.launch, ChatService.send) like `workflowSent`. The frontend draws a card above the bubble and a Full prompt toggle under it.

**Tech Stack:** TypeScript, Node, vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-23-card-ask-bubble-design.md`

## Global Constraints

- Never commit or push (user rule). No commit steps.
- The CLI text for a card ask must equal today's `commentAskMessage` output byte for byte.
- No trailing `undefined` added to existing `chats.send` calls: tests assert exact argument lists.
- Frontend styling uses app tokens only (`--accent`, `--sel-*`, `--status-*`), so dark mode follows.
- Comments in code are short and say why.

## Review Focus

- A card whose notes or comments are empty: `before` has no notes or earlier-comments parts, and the composed text still equals `commentAskMessage` (Task 1 test).
- A multi-line comment: every line quoted with `> ` in the CLI text, the bubble shows plain lines (Task 1 test).
- Edit of a card-ask message: the new text is quoted inside the same `before`/`after` (Task 3 test).
- A card removed from the board, or a done card older than the loaded 200: removed shows "Card removed", unknown shows no status (Task 5 test).
- A queued card ask (chat busy): `cardAsk` survives the tray and reaches the send (Task 3 test).

---

### Task 1: Shared `CardAsk` and the split prompt

**Files:**
- Modify: `zumi-bot-server/shared/src/todos.ts` (add type and helper near the comment helpers)
- Modify: `zumi-bot-server/backend/src/core/todos/taskPrompt.ts`
- Test: `zumi-bot-server/shared/tests/todos.test.ts`, `zumi-bot-server/backend/tests/core/todoTasks.test.ts`

**Interfaces:**
- Produces: `interface CardAsk { todoId: string; title: string; before: string; after: string }`, `quoteLines(text: string): string`, `cardAskPrompt(ask: Pick<CardAsk, 'before' | 'after'>, text: string): string` (all in `@zumibot/shared/todos`); `commentAsk(item, comment, commands?, images?): CardAsk` in `taskPrompt.ts`.

- [ ] **Step 1: Failing tests.** Shared: `cardAskPrompt({ before: 'B\n\n', after: '\n\nA' }, 'one\ntwo')` is `'B\n\n> one\n> two\n\nA'`. Backend (`todoTasks.test.ts`, in the taskPrompt describe): for a card with no notes and no comments and for one with notes, two earlier comments, 2 images and a `/card` command, `cardAskPrompt(commentAsk(item, c, cmds, 2), c.text)` equals `commentAskMessage(item, c, cmds, 2)`; `commentAsk(...)` has `todoId: item.id`, `title: item.text`, `before` ending `"The user's comment:\n\n"`, `after` starting `'\n\n'` and containing `'Do what the comment asks'`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/todos.test.ts zumi-bot-server/backend/tests/core/todoTasks.test.ts` — FAIL (`cardAskPrompt` / `commentAsk` not exported).
- [ ] **Step 3: Implement.** Move `quote` from `taskPrompt.ts` to shared as `quoteLines` (taskPrompt imports it). `commentAsk` builds the parts list as `commentAskMessage` does today, split at the comment; `commentAskMessage` becomes `cardAskPrompt(commentAsk(...), comment.text)`.
- [ ] **Step 4: Run** the same command — PASS, and the existing CommentAsks text assertions still pass.

### Task 2: The CLI reads the card ask

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (user `ChatItem` and `QueuedTask`: `cardAsk?: CardAsk`, with a short comment)
- Modify: `zumi-bot-server/backend/src/core/chat/commandText.ts`
- Test: `zumi-bot-server/backend/tests/core/commandText.test.ts`

**Interfaces:**
- Consumes: `CardAsk`, `cardAskPrompt` (Task 1).
- Produces: `readAs(user, reader, bridges)` returns `cardAskPrompt(user.cardAsk, body)` when `user.cardAsk` is set, `body` being what it returns today; `withCommands` also rewrites items with `cardAsk`.

- [ ] **Step 1: Failing tests** in a new `describe('readAs with a card ask')`: an item `{ text: 'hi\nthere', cardAsk: { todoId: 't', title: 'T', before: 'B\n\n', after: '\n\nA' } }` reads as `'B\n\n> hi\n> there\n\nA'` for any reader; `withCommands([item], 'x')[0].text` is the same and keeps `cardAsk`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/commandText.test.ts` — FAIL.
- [ ] **Step 3: Implement** the wrap in `readAs` and the extra condition in `withCommands`.
- [ ] **Step 4: Run** the same — PASS. `npm run typecheck` clean for shared and backend.

### Task 3: The send path carries `cardAsk`

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/taskQueue.ts` (`SubmitOptions.cardAsk?`, queued task, `launchTask`, `launch`, `withAuto`)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`send`, `sendTurn`, `rerunTurn`)
- Test: `zumi-bot-server/backend/tests/core/taskQueue.test.ts`, `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Produces: `TaskQueue.submit(..., opts?: SubmitOptions & { cardAsk?: CardAsk })` (field on `SubmitOptions`); `ChatService.send(chatId, text, attachments, replyTo, messageId, command, todo, auto, workflowSent, cardAsk?)`. `withAuto` passes `cardAsk` as the slot after `sent` only when set.

- [ ] **Step 1: Failing tests.** taskQueue (`describe('cardAsk')`, modelled on `describe('workflowSent')`): idle submit with `{ cardAsk }` calls `chats.send` with `[c.id, 'hi', [], undefined, 'm1', undefined, undefined, undefined, undefined, ask]`; a busy chat stores `{ id: 'm2', cardAsk: ask }` on the task and sends it with the same tail after `idle`; a submit without it stores none. chatService: `svc.send(c.id, 'comment', [], undefined, undefined, undefined, undefined, undefined, undefined, ask)` stores the user item with `text: 'comment'` and `cardAsk: ask`, `calls[0].stdin` starts with `cardAskPrompt(ask, 'comment')`; `svc.rerun(c.id, user.id, null)` keeps `cardAsk`; `svc.rerun(c.id, id, 'edited')` keeps `cardAsk` and its stdin starts with `cardAskPrompt(ask, 'edited')`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/taskQueue.test.ts zumi-bot-server/backend/tests/core/chatService.test.ts -t cardAsk` — FAIL.
- [ ] **Step 3: Implement.** Groups ignore it (`withSent` unchanged: card asks only run in single chats). `rerunTurn` copies `old.cardAsk` for Resend and Edit.
- [ ] **Step 4: Run** both files whole — PASS (existing exact-argument tests unchanged).

### Task 4: CommentAsks sends the comment with its card

**Files:**
- Modify: `zumi-bot-server/backend/src/core/todos/commentAsks.ts` (`CommentAsksDeps.submit(chatId, text, messageId, stagedIds, cardAsk: CardAsk)`; `ask` uses `commentAsk`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts:1096` (pass `{ cardAsk }` as `opts`)
- Test: `zumi-bot-server/backend/tests/core/todoTasks.test.ts`

**Interfaces:**
- Consumes: `commentAsk` (Task 1), `SubmitOptions.cardAsk` (Task 3).

- [ ] **Step 1: Failing tests.** In the CommentAsks `submit` stub record `text` and `prompt: cardAskPrompt(cardAsk, text)`; switch the existing `.text` content assertions to `.prompt`; add to the first test: `sent[0].text` is exactly `'Hey @Work-Assistant create a card for this, @broken and @zumi-bot too'` and `sent[0].cardAsk` matches `{ todoId: id, title: 'Investigate watchers' }`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/todoTasks.test.ts` — FAIL.
- [ ] **Step 3: Implement** the new `submit` shape and the handler wiring.
- [ ] **Step 4: Run** the file — PASS; `npm run typecheck` clean.

### Task 5: Inline card and Full prompt in the chat

**Files:**
- Create: `zumi-bot-server/frontend/src/state/cardAsk.ts`, `zumi-bot-server/frontend/src/components/CardAskCard.tsx`
- Modify: `zumi-bot-server/frontend/src/components/TodoCard.tsx` (`TodoCardEnv.board?: TodoBoard | null`), `zumi-bot-server/frontend/src/App.tsx:2381` (pass `board.board`)
- Modify: `zumi-bot-server/frontend/src/components/CommandBubble.tsx` (`FullPrompt({ prompt: string, open, onToggle })`)
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx` (~1113-1155: card in the `quote` slot, footer for `cardAsk`)
- Modify: the stylesheet that holds `.full-prompt` (card styles beside it)
- Test: `zumi-bot-server/frontend/tests/cardAsk.test.ts`

**Interfaces:**
- Produces: `cardAskView(ask: CardAsk, env: { board: TodoBoard | null | undefined; chats; approvals }): { title: string; status: string | null; removed: boolean; path: string }` — `title` is the live card's title, else `ask.title`; `status` is `COLUMN_LABEL[columnOf(...)]` when found; `removed` true only when the board is loaded, the card is not in it, and `done.length >= doneTotal`; `path` is `todosPath(ask.todoId)`.

- [ ] **Step 1: Failing tests** for `cardAskView`: open card in progress → `{ status: 'In progress', removed: false }` with its live title; a done card in `done` → `'Done'`; missing with `doneTotal === done.length` → `{ removed: true, status: null }`; missing with `doneTotal > done.length` → `{ removed: false, status: null }`; `board: null` → `{ removed: false, status: null, title: ask.title }`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/cardAsk.test.ts` — FAIL.
- [ ] **Step 3: Implement** `cardAskView`, then `CardAskCard` (reads `TodoCardEnvContext`; card glyph, "Task card" label, status pill tinted with `--status-<column>` or "Card removed", title in one clipped line, `AppLink` "Open card →" to `path`; `data-testid="card-ask"`). In `MessageList`, render it first in `quote`; footer is `FullPrompt` with `item.command.prompt`, else `cardAskPrompt(item.cardAsk, item.text)`.
- [ ] **Step 4: Run** the test — PASS; `npm run typecheck` clean; `npm run build:server` succeeds.
- [ ] **Step 5: Look at it.** Run the app (preview), mention an agent in a card comment, open its chat: card above the comment bubble, Full prompt shows the old long text; check dark mode.

### Task 6: Docs

**Files:**
- Modify: `docs/architecture/todos.md` (Threads section: the message is stored as the comment with `cardAsk`, `readAs` composes it, the chat draws the card and Full prompt, Edit and Resend keep it, old chats keep their long text)
- Modify: `zumi-bot-docs/src/content/docs/projects/todos-and-board.mdx:86` (one sentence: the agent's chat shows your comment under a link to the card)

- [ ] **Step 1:** Edit both. **Step 2:** `npx vitest run zumi-bot-server/shared/tests/repoDocs.test.ts` — PASS. **Step 3:** `npm test` and `npm run typecheck` — all green.
