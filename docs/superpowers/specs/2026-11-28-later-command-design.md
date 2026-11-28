# `/later` — send a message into this chat at a set time

## Intent

`/later 9am check CI on this PR` picks the same chat back up at that time: at 09:00 the chat gets `check CI on this PR` as if
the user had just typed it. A routine can do this, but a routine is too heavy for a one-off: it needs a name, a trigger, a
target, and it stays in the Routines list after it has run.

## Goals

- One line in the composer schedules one message into the chat it is typed in (single chats and rooms).
- The time reads the way people say it: `9am`, `9:30pm`, `21:30`, `in 20m`, `in 2h`, `in 1d`, `tomorrow 9am`, `mon 9am`.
- It survives a server restart; a time missed while the server was down sends as soon as it is back.
- Pending ones are visible and can be sent now or cancelled.

## Non-goals

- Repeating messages (routines do that).
- Agents scheduling their own `/later`.
- Editing a pending message in place (cancel and type it again).
- The new-chat screen and the island's new chat, where no chat exists yet (they refuse it with a notice, as they refuse
  `/run-workflow`). The island's open chat takes it like any chat (builder's call: it needs nothing a chat lacks).

## Anti-goals

- A `/later` that silently never fires, or fires twice.
- A time read in the server's time zone when the user's browser is in another (a VPS often is).

## Approaches

1. **Stored on the chat, armed by a small service (picked).** `ChatMeta.later[]`, a `LaterSends` service with one timer per
   item, `recover()` at start and `stop()` at shutdown, sending through `TaskQueue.submit`, exactly the way usage limit waits
   (`limitResumes.ts`) are built. Queue, pause, limit wait and steering rules all apply for free.
2. **A hidden one-off routine.** Reuses the scheduler, but drags in everything that makes routines heavy (runs file, Routines
   list, policies) and needs hiding everywhere.
3. **A timer in the browser.** Dies with the tab; useless for "tomorrow 9am".

## Design

- **Parser** (`shared/src/later.ts`, pure): `laterRest(text)` (null unless the text leads with `/later` and a word boundary),
  `parseLater(rest, now, timeZone)` → `{ at, text }` or `{ error }`. Forms: `HH:MM` (24 h), `H[:MM]am|pm`, `noon`,
  `midnight`, `in <n><m|min|h|hr|d>` (also `in 1h30m`), optional leading `today`, `tomorrow` or a weekday (`mon`…`sun`,
  full names too) before a clock time. A bare clock time already past today means tomorrow; a weekday means its next
  occurrence (today's if still ahead). Wall-clock times convert through the routine scheduler's `zonedToUtc`, so DST gaps
  behave as routines do. The message must not be empty; the time must be at most 30 days out (`LATER_MAX_MS`).
- **Time zone:** the browser sends its `Intl` time zone with the request; the server checks it (`isTimeZone`) and parses
  again. The composer runs the same parser to preview "Sends tomorrow at 09:00".
- **Stored:** `ChatMeta.later?: LaterSend[]`, `{ id, at, text, createdAt }`, oldest `at` first, at most 10 per chat
  (`LATER_MAX`). Written through `patchInPlace` (sidebar order kept).
- **Sending:** at `at`, `LaterSends` removes the item and submits its text through `TaskQueue.submit(…, from 'user')` with a
  `later` mark carried onto the user item (`{ at }`), so the bubble shows a small ⏰ chip. An idle chat sends now, a running
  one queues it as a task, a paused one holds it (see "Paused" below). Messages sent meanwhile do not cancel it. Rooms
  route it like a typed message (@mentions as usual).
- **Paused chats:** a `/later` is the user's own message written ahead of time, but it arrives unattended. It must not end a
  pause the user chose: it is submitted as `'routine'`-like for the pause rule only (waits, held, for Resume) while still
  being the user's text (no `auto` mark). Implemented as its own `SendFrom` value `'later'`.
- **Restart:** `recover()` arms every stored item; one already due goes at once. `stop()` disarms at shutdown.
- **RPC:** `chats:later(chatId, text, timeZone)` → the stored `LaterSend`; `chats:laterCancel(chatId, id)`;
  `chats:laterNow(chatId, id)`.
- **UI:** `routeSend` gets `{ kind: 'later' }`; the composer previews the parsed time under the text (or the parse error),
  and Enter on a bad one shows the error instead of sending. A **Later** tray above the composer (same look as Tasks): each
  row shows the time and the text, with **Send now** and ×. `/later` is a built-in row in the `/` menu.
- Edits and resends never route it (they are plain text there, as `/run-workflow` is).

## Left to the builder

Exact copy of notices, the tray's placement relative to the Tasks tray, and test layout.
