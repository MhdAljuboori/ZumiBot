# Side question input: design

Date: 2026-11-05. Written after a conversation with the user. **(user)** marks what the user asked for or decided. **(seen)** marks one of my proposals that I played back to the user and they approved. Everything else is my call and can be changed.

## Why

An A→B chat (agent A asked agent B with `mcp__zumibot_agents__ask`, see `2026-11-05-agent-ask-design.md`) is read-only. While it runs, the user wants to check progress, or ask how both agents are getting on **(user)**. Today they cannot: the A→B chat has no composer, and `btw:ask` is refused there by `writable()` in `rpc/handlers.ts`.

The user also wants a side question to be easy to ask in any chat, without typing `/btw` into the main message box: from **Side panel › Open Side questions**, an input to type the question into, available everywhere, not only in A→B chats **(user)**.

## Goals

1. **An input in the Side questions panel, in every chat (user):** single chats, rooms, A→B chats **(user)** and archived chats **(seen)**.
2. **The input sits at the top of the panel and the list below it is newest first (user)** (layout B of the mockups, like the To-dos panel's "Add a to-do…" row).
3. **In an A→B chat, the user can ask either agent (user):** B, the agent that was asked and owns the chat, or A, the agent that asked **(seen)**.
4. **"Both" in an A→B chat (seen):** one question, sent to each of A and B, giving two separate answers.
5. **A's answer can see B's progress (seen):** A's side question carries the A→B chat's messages so far, so A can say how B is doing, not only what it asked for.
6. **Nothing else changes for side questions (seen):** asking never unarchives a chat, never marks it unread, never notifies; at most 3 open side answers per chat; `/btw` in the composer keeps working; chips on messages and **Show in chat** stay as they are.

## Non-goals

- **Typing anything else into an A→B chat.** It stays read-only for sends, edits, resends, version switches, fork, compact and mark unread. Only `btw:ask`, `btw:again` and `btw:stop` are allowed there (`btw:stop`/`btw:list` are already unguarded).
- **Asking a third agent further down the chain.** In A→B where B asked C, the A→B chat offers A and B only. C's own B→C chat offers B and C.
- **An `@` autocomplete menu in the panel input.** The "Answer from" chips do the picking (my call).
- **Asking side questions from the new-chat screen.** There is no chat and so no panel there (unchanged).

## How it works

### The panel (frontend)

`SidePanel.tsx` gets an input row at the top, between the header and the list **(user)**:

- An **Answer from** row of chips (only when there is a choice), a text box and an **Ask** button **(seen)**.
- Enter asks, Shift+Enter adds a new line, like the composer (my call). The box takes up to `COMMAND_PROMPT_MAX` characters, the limit `btw:ask` already enforces.
- On success the box clears, focus stays in it, and the new entry shows at the top of the list. On failure the box keeps the text and the server's error (for example `SIDE_LIMIT_TEXT`) shows under the row, as `SideEntry` shows its errors (my call).
- An empty or whitespace-only question does nothing (the same rule as `sideParts`).
- The list renders newest first **(user)**. Only the panel flips: `panelOrder` stays oldest first for the chips under messages (`messageGroups.ts`), and the panel uses its own newest-first order (my call).
- The input also shows when the list is empty, above "No side questions yet."
- The panel's draft is per chat and in memory only, so switching chats does not carry a half-typed question into another chat (my call).

**Answer from, per chat kind (seen):**

| Chat | Chips | Default |
|---|---|---|
| Single chat | none (the chat's agent answers) | — |
| Room | **Auto** plus each member that loads (no broken agent files) | Auto |
| A→B chat | **B** (the chat's agent), **A** (`asked.by`), **Both** | B |

- The pick resets to the default whenever the panel opens on a chat (my call).
- **A** is greyed out, with a title saying the chat it asked from was deleted, when the source chat is no longer listed **(seen)**. The client already knows this for `AskedBar` (`askedSourceExists`).
- **Both** is greyed out unless at least 2 of the 3 open slots are free (my call), so it never starts one answer and fails the other on the limit. The server still enforces the limit per call; if the second call fails anyway (a race with `/btw` from another tab), the error shows as usual and the first answer is kept.

**How the pick reaches the server: no new RPC argument (my call).** The client sends the question with a leading `@handle` when a room member or A is picked, and as typed for Auto, B or a single chat (no mention already means the chat's own agent). The server already parses a leading `@member` with `sideParts`. Both is two `btw:ask` calls, each with its own entry id: the question as typed (B) then `@A question`, so A's entry lands on top of the newest-first list. If the typed text already starts with an `@handle`, it is sent as typed and wins over the chip (my call).

In an A→B chat each entry shows the answering agent's color dot next to its name, as room entries do, since two agents answer there (my call).

The pure rules (chips for a chat, the default, the text to send, whether Both is allowed, newest-first order) go in `frontend/src/state/sideQuestions.ts` with tests, as the repo keeps logic out of components. `App.tsx` passes an `onAsk(text)` to `SidePanel` that calls `api.btw.ask(chat.id, text, crypto.randomUUID())`, like `sendFromComposer` does for `/btw`, but without opening the panel again (it is already open) and without touching the composer draft.

### A→B chats (backend)

**The guard.** `btw:ask` no longer calls `writable()` (`rpc/handlers.ts`). `btw:again` gets no guard either (it has none today). Every other read-only guard stays.

**Who can answer.** In `SideQuestions.ask` (`core/btw/sideQuestions.ts`), the members a mention may name are:

- a room: `meta.group.members` (unchanged);
- an A→B chat: `[meta.agentName, meta.asked.by]`;
- any other single chat: `[meta.agentName]` (unchanged).

With no mention in an A→B chat the answer is B's (`meta.agentName`), as in any single chat; a typed `@B` gives the same entry. A mention of A sets `agent: A` and `mention: true` (outside rooms, `mention` is set only for A, so every other single-chat entry stays as it is today). A mention of anyone else is refused with the existing "is not in this chat" error. `again()` keeps an A entry on A while A is still `asked.by` (a rename moves `asked.by` with the agent, `ChatStore.renameAgent`, and `SideQuestions.renameAgent` moves entry agents).

**Where A's answer comes from.** B's answer works exactly like a side question in any single chat: the fork point and base come from the A→B chat itself. A's session does not live in the A→B chat. It lives in the chat A asked from (`asked.from`), which is always a single chat whose agent is A. So for an entry whose agent is `asked.by`:

- The entry is stored, broadcast, limited and stopped under the A→B chat id, like every entry of that chat.
- Everything that picks the session reads the **source chat**: `chats.sideBase(asked.from, A)` (or `baseFor(asked.from, A)` when there is no retained base, for example after a restart), `sideBrowser(asked.from, A)` and `sideDesktop(asked.from, A)` (so the tools, browser profile and prompt-cache prefix are the same as A's main run), the fork point (`point()` with the source chat's meta and items) and, when there is no clean point, the seed (the source chat's items).
- While A waits on the ask, A's run is active and its clean point is the entry before the open `ask` tool call (`CleanPoint`), so A knows the whole chat with the user and what it decided to ask, but not the ask call itself. When A has moved on, the point is A's latest clean entry, as for any side question.
- The source chat is read again in `prepare()` next to the A→B chat. If it is gone, the entry fails with a fixed error, "The chat @A asked from was deleted" (wording my call; it names the agent, never an id or path), with no CLI run.

**B's progress in A's question (seen).** A's side message gets a snapshot of the A→B chat, passed as the `thread` argument `sideMessage`/`seededSideMessage` already take for rooms, with a short line before it saying these are the messages of A's ask to B so far (wording my call). The snapshot is built from the A→B chat's items at `prepare()` time, live items included:

- A's messages (user items with `from: A`) as from A;
- B's text (assistant items) as from B;
- one short line per B tool step, so progress shows even while B is only running tools: the tool name plus the same short summary the UI shows on the tool row where one exists, or just the name (builder's call, but never the tool's input JSON or result text in full);
- a size cap that keeps the newest part, plus the first message (A's request), like the room summary's cap (amount builder's call; the existing side-answer prompts have no cap, so pick one of the order of 20 000 characters).

This needs a small builder next to `unseenEntries` in `core/btw/sidePrompt.ts`; `threadEntries` cannot be reused as is, because single-chat assistant items have no `agent` and are skipped by it, and it skips live items.

**Cost.** A side answer's cost is recorded on the chat it was asked in (the A→B chat) under the answering agent, A or B (my call). It shows in that chat's cost chip and in Usage under that chat.

**Show in chat.** Unchanged: `after` is the A→B chat's last item when asked, for A's entries as well as B's.

### What stays the same

- `/btw` from the composer, its routing (`routeSend`), the room picker for Auto, the 3-open limit, the 3-minute timeout, the deny hook, Stop, Ask again, restart marking and `chats/<id>.btw.json` and its sync.
- A side answer never writes to A's session or B's session (`--fork-session` plus `--no-session-persistence`), so asking A never disturbs A's waiting run or the source chat.

## Testing

- **Backend unit (`sideQuestions` tests):** in an A→B chat, no mention answers as B from the A→B chat's base; `@A` answers as A from the source chat's base, point and items, with the A→B snapshot in the message; a deleted source chat fails with the fixed error and starts no run; `@someone-else` is refused; Ask again keeps A; `btw:ask` is accepted on an A→B chat while `chats:send` still gets "This chat is read-only".
- **Snapshot builder:** A's message, B's text and tool lines, live items included, the cap keeps the first and the newest.
- **Frontend pure (`state/sideQuestions.ts`):** chips per chat kind, defaults, text sent per pick (including a typed leading `@`), Both allowed only with 2 free slots, A greyed when the source is gone, newest-first panel order while `panelOrder` stays oldest first.
- **e2e (`npm run e2e:btw`, fake claude only, no quota):** ask from the panel input in a single chat; in a room with Auto and with a member chip; in an A→B chat (made the way `e2e:ask` makes one) ask B, ask A (the fake's invocation shows the source chat's resume point and the snapshot in stdin), and Both (two entries); newest first in the panel; the A→B chat still has no composer.

## Docs

Update the `/btw` and Agent asks paragraphs of `CLAUDE.md`: the panel input, newest-first panel order, and that an A→B chat refuses everything but side questions, which can be asked of A (from the source chat's session, with the A→B snapshot) or B.

## Left to the builder

- Styling of the input row and chips (follow the To-dos input row and the existing chip styles).
- The snapshot's exact cap and tool-line format, within the rules above.
- Whether the Ask button shows a spinner while the RPC is in flight (the entry itself shows "Answering…" right after).
