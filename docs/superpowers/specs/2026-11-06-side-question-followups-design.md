# Side question follow-ups and thread panel

Date: 2026-11-06. Status: approved in chat (behavior and UI); reviewer pass pending.

## Why

A `/btw` side question gets exactly one answer today. When the answer raises a new question ("would that still hold with 50k rows?"), the user has to start a new side question, and the agent answering it no longer sees what it just said. The user wants to dig into an answer with follow-ups, the way they would in the main chat, without touching the main run.

The Side questions view is also a long list of full cards (question, answer, buttons), newest first. With threads it would get longer still. The user wants it to look like the Dispatched agents view: compact rows that open a detail view.

## Goals

- A side question is a **thread**: the first question and its answer, then any number of follow-ups, each answered by the same agent.
- Each follow-up **builds on the thread**: the agent sees the earlier questions and its own answers, plus the chat **as it was when the first question was asked**. Work the main run did after that stays invisible to the thread; to ask about newer work, the user starts a new side question.
- The Side questions view becomes a **list of thread rows** like Dispatched agents, and a row opens the **thread in chat style** (the user's questions as bubbles on the right, answers on the left, a follow-up box at the bottom). Mockup option "2B" was chosen over labelled boxes.

## Non-goals

- Follow-ups never join the chat: not its items, prompts, context meter, unread state or notifications (same as side answers today).
- No follow-ups on entries an agent asked (`from` set, made by `side_question`); they stay single answers.
- No change to how a new thread starts (`/btw` in the composer, the panel's question box, Answer from chips, room picking).
- No deleting side questions (there is none today).
- Agents cannot follow up with `side_question`; only the user follows up.

## Anti-goals

- A follow-up must never write a session file, change the main session, or reach the main run (same guard, `--no-session-persistence`, `--fork-session` as now).
- A follow-up must not silently answer from a newer point of the chat than its thread's first question.
- The prompt-cache prefix of side runs must stay identical to today's (same base args, tool definitions, system prompt).

## Behavior

### Data

Follow-ups are ordinary side entries in `chats/<id>.btw.json`, so the open limit, Stop, restart recovery, rename, sync (joined by entry id), fork and the three-minute clock work per entry unchanged.

`SideQuestion` (shared/src/btw.ts) gains:

- `thread?: string` — on a follow-up only: the id of its thread's first entry (the **root**). Absent = a root.

A follow-up copies from its root: `agent`, `mention`, and `after` (so it anchors on the same chat item; chips, fork and sync treat it like its root).

The thread is the root plus every entry whose `thread` is the root's id, ordered by `askedAt`.

The server also stores, on a root only, a **snapshot** of what its answer was given, so follow-ups answer from the same moment:

- `point`: the `{session, at}` the side run forked from, or `null` when it was seeded.
- `upTo`: the id of the last item of the chat whose items fed the seed (the asking chat, or for an A→B chat's asker the source chat), or `null`.
- `context`: the text placed before the note in the root's message (the room thread lines, or the A→B asked-thread lead and lines); `''` when there was none.

The snapshot is written when the root's preparation settles (after a room pick, after the missing-session reseed fallback). It stays on the server: `btw:list` and `btw:changed` strip it (it can be 20 000+ characters and would ride every streamed delta). Sync passes it through untouched as part of the entry.

### Asking a follow-up

New RPC `btw:follow(chatId, threadId, question, id) → SideQuestion` (`ZumiBotApi.btw.follow`, handler, `api.ts` mapping). Arguments are checked like `btw:ask` (string ids, question at most `COMMAND_PROMPT_MAX`). The question is used as typed (trimmed); a leading `@handle` is not parsed, since the thread already has its agent. Like `btw:ask`, it is taken in an A→B chat (no `writable()`).

Refused with a fixed message when:

- the thread root does not exist (`threadId` may name any entry of the thread; the server resolves its root),
- the root was asked by an agent (`from` set),
- the root has no agent (it failed while a room was still picking; Ask again is the way out),
- any entry of the thread is still open (`Wait for this answer to finish`),
- a named asker in an A→B chat can no longer answer there (same check as `again()`),
- the chat already has `SIDE_MAX_OPEN` open entries (`SIDE_LIMIT_TEXT`, so a follow-up counts as one of the 3).

A follow-up whose A→B source chat is gone is not refused by the RPC: as with `btw:ask`, it is accepted and its answer ends with `sourceGoneText`. The UI disables the box for it (`canFollow`).

### What the follow-up's run reads

- **Point**: the root's snapshot `point`. When it is `null`, the follow-up is seeded from the seed chat's items up to and including `upTo` (all items when that item is gone, for example hidden by an Edit). The missing-session fallback stays: a stored point whose session file is gone reseeds once, the same way.
- **Base, browser, desktop, note, `asking`**: computed now, exactly as for a new question by the same agent, so the cache prefix and the tool guard are unchanged (`asking` only for the user's own question, which follow-ups always are).
- **Message**: `context` from the snapshot, then the note, then a fixed line introducing the earlier exchange, then each earlier entry of the thread (oldest first) as `<btw>question</btw>` and `<answer>answer</answer>`, then `<btw>new question</btw>`. An earlier entry that ended without text (error, stopped) shows `<answer>(no answer)</answer>`; a partial answer is given as is. The earlier exchange is capped at 40 000 characters: the root's pair always stays, then the newest pairs that fit, with a line saying older ones were left out.
- **Roots made before this feature** (no snapshot) answer follow-ups from the chat's current point, exactly as a new question would, plus the thread exchange. No migration.

### Ask again, Stop, restart

- Stop works per entry, as now.
- **Ask again** is offered only on the **last** entry of a thread, and only when it is `error` or `stopped` (and not agent-asked, as now). On a follow-up it reruns with the same root snapshot and the entries before it; it never re-picks the agent. On a root it reruns as today (fresh point, fresh snapshot); since it is the last entry, there are no follow-ups that would lose their context.
- A restart marks open entries interrupted, as now; the thread can continue after that.

### Chat chips, fork, sync, rename

- Chips under chat messages show **roots only** (one per thread). A chip's spinner and warning reflect the whole thread (any open entry → spinner; else the last entry's state). Clicking opens that thread.
- Fork already copies finished entries anchored on copied items; follow-ups share the root's anchor, so a thread is copied with its root. Open entries are left behind, as now.
- `sync.mjs` joins by entry id, so follow-ups merge like any entry. No change needed beyond checking it keeps unknown fields.
- Rename moves `agent` on every entry already (`renameIn`); nothing new.

## UI

Mockups were shown in the visual companion (`.superpowers/brainstorm/`, not committed); the user picked list rows plus chat-style thread (2B).

### Side panel list

- **Open Side questions** shows the number of threads, not entries.
- Header: Back, `Side questions · <threads>`, ✕.
- The question box with **Answer from** chips stays at the top, unchanged. After a single ask the view **opens the new thread** so the user watches it and can follow up; with **Both** (two asks) it stays on the list.
- Rows like Dispatched agents (`dispatch-row` look):
  - status dot: green pulsing while any entry of the thread is open, else the last entry's state (grey done, red error, amber stopped),
  - title: the root question (clamped to two lines), and a `N questions` badge once there are follow-ups,
  - one live or summary line: `Picking who answers…` / `Answering…` / `Answering follow-up…` while open; else the last entry's error, `Stopped`, or the first line of the last answer (ellipsis),
  - agent dot and name (and `from @A` on an agent-asked root), and the root's time,
  - `›` chevron.
- Rows grouped by the chat item they were asked after (the root's `after`), newest group first, newest row first inside a group. The newest group is labelled `This reply`, older ones by the time of their first question, like Dispatched agents. (Builder's call how to label a group when the anchor is `null`.)
- Empty state and load failure (Retry) as now.

### Thread view

- Header: Back (to the list), the root question (one line, ellipsis, full text in `title`), ✕.
- Meta line: status dot, agent dot + name (`from @A` when agent-asked), the root's time, **Show in chat** (the root's anchor).
- Entries oldest first. Each: the question as a right-aligned bubble (the main chat's user bubble colors); an agent-asked root's question is shown left-aligned with `from @A` instead. Then: side-ask link chips (as now), `Picking who answers…` / `Answering…` status, the answer as Markdown (live while streaming), the error or `Stopped`, then actions: Copy, Stop (while open), Ask again (last entry only, rules above).
- Follow-up box pinned at the bottom: `Ask a follow-up…`, Enter asks, Shift+Enter new line, same touch rule as the question box, Ask button. While an entry is open it is disabled with `Wait for this answer to finish`. On an agent-asked root it is replaced by a note (`Asked by @A; follow-ups are not available`). Errors from the call show under it; the text is cleared only on success.
- A running thread is followed at the bottom unless the reader scrolled up (as in Dispatched agents); opening a finished one scrolls to its last entry.
- Focus requests (a chip, **Open in conversation** on a side ask card, a link chip) open the thread that holds the entry and scroll that entry into view.
- Esc closes the panel, as now. Phone: the same full-screen sheet.

## Constraints

- Pure logic in `frontend/src/state/` (thread building, grouping, row line, can-follow, can-ask-again) with unit tests; components stay thin (there are no DOM tests).
- New API method touches the three places listed in CLAUDE.md.
- Backend unit tests for follow: snapshot reuse after the main session moves on, seed fallback through `upTo`, history cap, refusals, Ask again on a follow-up, snapshot stripped from list/broadcast.
- `npm run e2e:btw` (fake claude, no quota) gains: ask, follow up after the main run moved on (the fake's argv shows the root's `--resume-session-at`, its stdin shows the earlier exchange), the list rows and thread view, follow-up box disabled while answering, Ask again only on the last entry. Existing checks move to the new UI.
- CLAUDE.md's `/btw` section is updated.

## Calls made (not discussed with the user)

- Follow-ups are separate entries with `thread`, not a list inside one entry: every per-entry rule (limit, stop, sync, restart) keeps working.
- Follow-ups replay the earlier exchange as text on a fork from the root's point, rather than persisting side sessions: no session files, no Usage or sync changes, cache prefix unchanged.
- The snapshot stays server-side and stores the room/asked context text, so a follow-up matches the root even after items are rewritten or the member has seen more.
- History cap 40 000 characters, root pair always kept.
- A follow-up's text is not parsed for `@handle`.
- Legacy roots answer follow-ups from the current point.
- After a single ask the panel opens the new thread; after Both it stays on the list.
- No cap on follow-ups per thread beyond the open limit.
