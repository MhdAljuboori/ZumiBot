# `/later` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/later <when> <text>` in a chat stores a message that goes into the same chat at that time.

**Architecture:** A pure parser in `shared`, a `LaterSends` service in the backend built like `LimitResumes` (stored on
`ChatMeta`, one timer per item, `recover`/`stop`), sending through `TaskQueue.submit` with a new `SendFrom` `'later'` and a
`later` mark carried onto the user item. The frontend routes a leading `/later` to a new RPC, previews the time while typing,
and shows a Later tray.

**Tech Stack:** TypeScript, vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-28-later-command-design.md`

## Global Constraints

- `LATER_MAX = 10` per chat; `LATER_MAX_MS = 30 days`.
- Times read in the browser's IANA time zone, sent with the request; the server re-parses.
- No commits (the user's standing rule); dependencies unchanged.
- Comments short and say why; docs updated in the same change (`docs/architecture/later.md`, index line in `CLAUDE.md`).

## Review Focus

- `/later 9am` with nothing after the time → refused with "Write the message after the time", nothing stored.
- A clock time already past today (`8am` at 10:00) → tomorrow 08:00; `12am` is 00:00, `12pm` is 12:00.
- The server was down at the time → `recover()` sends it at once.
- The chat runs or is paused when it comes due → queued as a task / held for Resume, never lost or ending the pause.
- Cancel or Send now racing the timer → the message goes in at most once; the loser gets "That message was already sent or cancelled".

---

### Task 1: Parser and types (`shared/src/later.ts`)

**Files:** Create `shared/src/later.ts`, `shared/tests/later.test.ts`. Modify `shared/src/types.ts` (ChatMeta, QueuedTask, user
item, `ZumiBotApi.chats`), `shared/src/schedule.ts` (export `zonedToUtc`).

**Interfaces — Produces:**
- `LATER_NAME = 'later'`, `LATER_DESCRIPTION`, `LATER_MAX`, `LATER_MAX_MS`
- `interface LaterSend { id: string; at: number; text: string; createdAt: number }`
- `laterRest(text: string): string | null`
- `parseLater(rest: string, now: number, timeZone: string): { at: number; text: string } | { error: string }`
- `laterWhen(at: number, now: number, timeZone: string): string` → `today at 09:00`, `tomorrow at 09:00`, `Mon 1 Dec at 09:00`
- `ChatMeta.later?: LaterSend[]`; `QueuedTask.later?: number`; user item `later?: number` (the time it was set for)
- `ZumiBotApi.chats.later(chatId, text, timeZone): Promise<LaterSend>`, `laterCancel(chatId, id): Promise<void>`, `laterNow(chatId, id): Promise<void>`

- [ ] Tests (Europe/Berlin and UTC, fixed `now`): `9am` before/after 09:00 today; `21:30`; `9:30pm`; `12am`/`12pm`; `noon`;
  `in 20m`, `in 2h`, `in 1h30m`, `in 1d`; `tomorrow 9am`; `mon 9am` on a Monday before and after 09:00; empty message;
  bad time (`25:00`, `13pm`); past 30 days (`in 31d`); `laterRest('/laterx')` null; DST day keeps 09:00 local.
- [ ] Implement; run `npx vitest run --project shared shared/tests/later.test.ts` → PASS.

### Task 2: Queue mark and `'later'` sender

**Files:** Modify `backend/src/core/chat/taskQueue.ts`, `chatService.ts`, `groupService.ts`. Test `backend/tests/core/taskQueue.test.ts`.

**Interfaces — Produces:** `SendFrom` gains `'later'`; `SubmitOptions.later?: number`; `ChatService.send(…, run?, later?)`,
`GroupService.send(…, run?, later?)` store `later` on the user item. `'later'` behaves like `'run'` for the limit wait and the
pause (queued behind a wait, never ends it; held in a paused chat), is not `auto`, never steers, and its task is visible.

- [ ] Tests: idle chat → `chats.send` gets the mark; paused chat → task stored with `later`, tray held, pause kept; limit wait
  standing → queued, wait not cancelled (`onNewTurn` not called).
- [ ] Implement; run the taskQueue tests → PASS.

### Task 3: `LaterSends` service, RPC, wiring, sync

**Files:** Create `backend/src/core/chat/laterSends.ts`, `backend/tests/core/laterSends.test.ts`. Modify `backend/src/app.ts`,
`backend/src/rpc/handlers.ts`, `backend/src/core/extensions/engineCommandRows.ts` (reserve `later`), `deploy/sync.mjs`
(drop `later` with `resume`, log the count), `backend/tests/sync.test.ts`.

**Interfaces — Produces:** `class LaterSends { add(chatId, at, text): Promise<LaterSend>; cancel(chatId, id); sendNow(chatId, id); recover(); stop(); forget?(chatId) }`
with deps `{ store: Pick<ChatStore,'get'|'list'|'patchInPlace'>; send(chatId, text, at): Promise<unknown>; push; now; newId; setTimer?; log? }`.
`app.ts`'s `send` splits `/todo`, resolves a typed command (`commands.forSend(id, rest, null)`) and calls
`tasks.submit(id, text, [], undefined, undefined, command, todo, 'later', undefined, { later: at })`.
Handler `chats:later` refuses a read-only chat, a bad time zone, a text whose message leads with `/later`, `/btw` or
`/run-workflow`, and an 11th item (`A chat can hold at most 10 /later messages`).

- [ ] Tests: add stores sorted and pushes meta; timer fires → item removed then `send` called once; cancel before fire → no
  send; sendNow → send once and timer cleared; cancel of a gone id → "That message was already sent or cancelled";
  recover arms a due one at once; stop disarms; a send that throws only logs.
- [ ] Implement and wire; run the backend tests for these files → PASS.

### Task 4: Frontend

**Files:** Modify `frontend/src/state/sideQuestions.ts` (`routeSend` → `{kind:'later'}`, `laterRefusal`),
`frontend/src/state/commandInput.ts` (built-in row), `frontend/src/components/CommandMenu.tsx`, `Composer.tsx` (preview
line, refuse a bad time with its error), `App.tsx` (`sendFromComposer` → `api.chats.later`, new-chat/island-new refusal),
`frontend/src/net/api.ts`, `ChatView.tsx` (Later tray), `MessageList.tsx` (⏰ note under a later's bubble). Create
`frontend/src/components/LaterTray.tsx`, `frontend/src/state/later.ts` (`laterPreview(text, now, tz)`), tests in
`frontend/tests/state/later.test.ts`, `sideQuestions` and `commandInput` tests.

- [ ] Tests: `routeSend('/later 9am x')` → later; `laterPreview` gives `Sends today at 09:00` / the parse error / null for
  other text; `filterCommands('la', …)` lists the built-in.
- [ ] Implement; `npm run typecheck` and frontend tests → PASS.

### Task 5: Docs

- [ ] `docs/architecture/later.md`, index line in `CLAUDE.md`, `data.md` (`ChatMeta.later`), `deploy-and-sync.md` (dropped
  like `resume`), `agent-commands.md` (built-in beside `/btw`), user docs page in `zumi-bot-docs`.
- [ ] `npm test` and `npm run typecheck` → PASS.
