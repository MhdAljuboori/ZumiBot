# Side questions between agents (side ask)

Date: 2026-11-05. Builds on `2026-11-03-btw-side-questions-design.md` (`/btw`) and `2026-11-05-agent-ask-design.md` (`ask`).

## Why

An agent (A) asks another agent (B) to do a long piece of work with `ask`. A's main run is now blocked on that call until B finishes. The user often wants to know something about B's work in the meantime, for example "what padding did code-specialist measure?". They `/btw` A, but A's side answer has every tool blocked, so it answers "I can't ask it from this side reply, because there are no tools here" (the screenshot that started this).

The user wants A to be able to put a **side question on the A→B conversation**: B answers from what it already knows there (a fork at B's latest clean point, no tools, the same as a user's `/btw`), B's main work keeps going untouched, and A gets the answer back.

## What the user decided

- A can do it **from its main run and from its own `/btw` side answer**. Both use the same tool.
- It works **only on a conversation that already exists**: A must have asked B from this chat before (the A→B chat, found by source chat id plus B, as `ask` finds it). Otherwise there is nothing to ask about, and A uses `ask`.
- What the user sees (mockups approved):
  1. **A's chat, main run:** the call is a small card in place of a tool row, like the ask card: "Asked @B on the side", the question, a status, **Show answer**, and **Open in conversation**.
  2. **A's chat, Side questions panel:** when A's side answer uses it, that entry shows a chip "Side question to @B · <status>" above A's answer. Clicking it opens the A→B chat with its Side questions view focused on B's entry.
  3. **A→B chat, Side questions panel:** the side question is stored there as an ordinary side question entry marked "from @A", with B's answer. The user can Copy and Stop it, and Show in chat works as usual. There is no Ask again. The chat stays read-only otherwise.
- No approval card, the same as `ask`. B uses no tools.
- The same limits as `/btw` on B's side: at most 3 open per chat, 3-minute timeout.
- B's cost counts on the A→B chat.
- No chains: B's side answer to a side ask cannot start another side ask, or anything else.

## Goals

- A reaches B's live knowledge while B works, without stopping, resuming or writing into B's session.
- One tool, the same tool list in the main run and the side run, so the side run's prompt-cache prefix still matches the main run's.
- The user can always see, stop and read what was asked and answered, on both sides.

## Non-goals

- Rooms. Room members get no ask bridge today; this changes nothing there.
- The user typing `/btw` in an A→B chat. It stays read-only (`writable()` keeps refusing `btw:ask`).
- Side questions to an agent A has not asked from this chat.
- Any tool use in B's side answer, or in A's side answer other than this one tool.

## Anti-goals (a failure even if it works)

- B's main work is disturbed: its session is written, its run is stopped or restarted, or its next turn sees the side question.
- The exception in A's side-run guard lets anything else through: `ask` (a real run of B with tools), Bash, or any other tool.
- A sees a path, a CLI error text or a capability. As with `ask`, A only ever gets B's answer or a fixed sentence.
- The user cannot see a side question an agent asked on their behalf.

## The tool

- Name: `side_question`, on the existing `zumibot_agents` server, so it is `mcp__zumibot_agents__side_question` (`ASK_SIDE_TOOL` in `shared/src/agentAsk.ts`). *(My call.)*
- Input, exact keys only (`askTools.ts` style): `agent` (a handle, leading `@` dropped, matched without case, as `ask`), `question` (1 to 4 000 characters; *my call*, since a side question is short).
- Description, roughly: "Ask an agent you already asked from this chat a quick side question about that conversation. It answers from what it already knows there, without tools, and any work it is doing keeps going. Use ask for new work."
- Result: B's answer, capped at `ASK_REPLY_MAX` with the same cut note; an empty answer reads "@B finished without writing an answer."
- The bridge (`askBridge.ts`) lists both tools and routes each by name. The IPC message needs a kind (`ask` or `side`) so the server calls the right method; the owner still comes from the token alone.
- `withAskTool` adds both names to every non-empty `tools:` list (`AgentStore.save`).
- `ASK_PARAGRAPH` (`askPrompt.ts`) gets one fixed line about it, for example: "- To check something with an agent you already asked from this chat, while it works or after, use side_question: it answers from what it already knows there, without tools, and its work keeps going." This changes the cached prompt once, like any prompt change.

### Refusals

A fixed sentence the agent can act on, all passing `SAFE_ASK_MESSAGE`. Reuse `unknown`, `zumiBot`, `self`, `broken`, `perTurn`, `parallel` and `stopping`. New ones (*wording is my call*):

- no conversation: "You have not asked @B from this chat yet, so there is no conversation to ask about."
- B's chat has 3 open side questions: "@B already has 3 side questions running. Wait for one to finish."
- timeout: "The side question to @B took too long."
- error (B's side run failed for any reason): "@B could not answer the side question."
- stopped (by the user in the A→B panel, or because A's call was cancelled): "The side question to @B was stopped."

### Limits

Side asks count in the same per-turn counters as `ask` (`ASK_PER_TURN` 10, `ASK_PARALLEL` 3, keyed by the owner's turn). *(My call: one budget for both, so an agent cannot fan out side questions endlessly.)* `ASK_MAX_HOPS` and the chain do not apply: a side ask never runs tools, so it cannot extend a chain.

## Server

### `AgentAsks.sideAsk(owner, call, signal)`

1. Check the target as `ask` does: unknown, Zumi Bot, self, broken.
2. Find the A→B chat: `ChatMeta.asked.from === owner.chatId` and `agentName === B`. Never make one. None means the "no conversation" refusal.
3. Count against the turn's counters, then run `SideQuestions.askFrom(abChatId, { question, from: A, link, signal })` (below) and wait for the entry to end.
4. Map the end: `done` gives the answer text (capped), `stopped` the stopped refusal, an error with `SIDE_TIMEOUT_TEXT` the timeout refusal, `SIDE_LIMIT_TEXT` the limit refusal, and any other error the error refusal. A thrown error never reaches A as text.

`close()` refuses new side asks as it refuses asks.

### `SideQuestions.askFrom`

A server-internal variant of `ask` for the A→B chat (no `writable()` check; the RPC never reaches it):

- The new entry gets `from: A` (new optional field on `SideQuestion`: the asking agent's handle). `agent` is B (the chat's `agentName`).
- It returns a promise of the final entry. The `signal` stops the entry (`stop`) when A's call is cancelled, that is when the CLI process that made the call ends early: A's main run was stopped (a chat Stop, an Edit or Resend on a running chat, the ask cascade), or A's side entry was stopped, timed out or deleted.
- B's side-run message uses a variant of `SIDE_NOTE` naming the asker, for example: "@A is asking you a side question while your main work goes on in another process. Answer only this question, briefly, from what you already know in this conversation. You cannot use tools here. Do not continue, restart or change the main work; this answer does not affect it." The message is not part of the cached prefix, so this costs nothing in cache.
- `again()` refuses an entry with `from` (the asker asks again, not the user), and the UI hides Ask again for it.
- Everything else is plain `/btw`: the live clean point while B runs, the seed fallback, the 3-open limit, the 3-minute timeout, cost recorded on the A→B chat with agent B, no unread and no notification.

### The link in A's side entry

When A's side answer makes the call, A's own side entry (in A's chat) records it, so the chip is exact rather than guessed:

- New optional field on `SideQuestion`: `asks?: { agent: string; chatId: string; entryId: string; state: 'running' | 'done' | 'error' | 'stopped' }[]`.
- The side run's ask owner carries which side entry it belongs to (`{ chatId, entryId }`). `ChatService.sideBrowser` gets the entry id from `SideQuestions.answer`'s `prepare()` to set this. `askFrom` adds the link to that entry when B's entry is created and sets its `state` when B's entry ends. Both changes go through the same save-and-broadcast path as the answer text.
- A main-run call has no side entry, so nothing is linked there. The main-run card finds B's entry itself (see UI).

### A's side run: the one exception to "no tools"

Today `sideArgs` always adds `SIDE_GUARD_SETTINGS` (a `PreToolUse` hook with matcher `*` that exits 2), and `startSideRun` denies every permission request.

- **When the exception applies:** the side question is the user's own (no `from`), and the side run joined our ask bridge (`SideBase.asks`, which only single chats' main runs have). In every other side run (rooms, agents without the bridge, and B's side runs for a side ask) the guard and the denials stay exactly as they are today, byte for byte. That is what keeps "no chains" true.
- **Guard:** a second constant, the same hook with a matcher that matches every tool name except exactly `mcp__zumibot_agents__side_question`. Proposed: `^(?!mcp__zumibot_agents__side_question$).*`. Whether the CLI treats the matcher as a JavaScript regex with lookahead must be proven against the real CLI (see Testing). If it does not, the fallback is a hook command that parses the hook's stdin JSON and exits 0 only when `tool_name` is exactly that name. It must never be a substring check on the raw JSON, because `tool_input` is in the same JSON and an agent controls it. The desktop ask rules still merge into the one `--settings` (`oneSettings`).
- **Permissions:** `startSideRun` answers allow, with the input unchanged, only for a request whose `toolName` is exactly the side tool, and only when this run has the exception. Every other request is still denied with "No tools in a side answer". No card, no stored rule, no Jev hint.
- **Message:** A's side-run note says tools are off except `side_question`, and names the agents A has a conversation with from this chat (the A→B chats found by `asked.from`, as handles). A's fork stops before an in-flight `ask` call, so without this A may not know whom it asked. That sentence is in the message, not the prefix. With no A→B chat the note says tools are off, as today, but the guard exception still applies so the tool list stays the same.
- **Second guard:** `AgentAsks` refuses a plain `ask` from a side-run owner (the owner carries a side flag set by `sideBrowser`), with the fixed sentence "Side answers cannot ask an agent to do work. Use side_question." The hook already blocks it; this is defense in depth.
- **Turn counters:** a side run's ask turn (`randomUUID()` in `sideBrowser`) must call `askEnd` on dispose. Today nothing counts there, but side asks will.
- **Deadline:** A's side entry has one 3-minute deadline covering its whole answer, and B's entry starts its own 3 minutes later, so A would always time out first and B would get less than its full time. So the time A's side entry spends waiting on a `side_question` call does not count against A's deadline (the clock pauses while one is in flight), with an overall cap of 6 minutes for A's entry. *(My call.)* The CLI run's own `timeoutMs` in `startSideRun` follows the same clock. B's entry keeps its own plain 3 minutes, so a slow B ends with B's own "Took too long" and A gets the timeout refusal, with time left to write its answer.
- **Restart:** `baseFor` (used when the server has no `SideBase` yet, after a restart) must set `asks` the same way `runTurn` decides it (single chat, not Zumi Bot, bridge wired), so A's side runs keep `side_question` after a restart.

### A's main run

`ChatService` answers the side tool's permission request itself, as it does for `ask` (`ownAsk` covers both names): no card, no rule, no Jev hint. `askParents` and the approvals roll-up are not involved, since B's side answer never raises a card.

## UI

- **Card (mockup 1).** `messageGroups.ts` lets a `side_question` call stand alone like `ask`. `MessageList` draws a side-ask card, either a variant of `AskCard` or its own component (*builder's call*). Its state is a pure function in `state/agentAsk.ts`: Asking while the call has no result and is live; Done on a result; Failed on an error result (Show details shows the refusal sentence); Stopped once the chat stops without a result. **Show answer** toggles the result as Markdown. **Open in conversation** opens the A→B chat (`askedChatOf`) with the Side questions view focused on B's entry. That entry is found by `from === A` and an exact question match, the newest one asked at or after the tool item (*a small grace window is the builder's call*). If none is found, it opens the view unfocused.
- **Chip (mockup 2).** `SideEntry` in `SidePanel.tsx` shows one chip per `asks` link above the answer: "Side question to @B · Asking… / Done / Failed / Stopped", with B's color dot. Clicking it opens the A→B chat with its Side questions view focused on `entryId`. A link whose chat no longer exists shows "(deleted chat)" and does nothing.
- **A→B chat panel (mockup 3).** An entry with `from` shows "from @A" with A's color dot in its meta line. Copy, Stop and Show in chat stay; Ask again is hidden. **Open Side questions** must be reachable in the side panel list of a read-only asked chat (check that it is not hidden there today).
- **Opening another chat's side panel focused on an entry** is new: today chips only open the current chat's panel. Add it to the app's navigation (open chat, side view, focus id) as one pure step in `state/sidePanel.ts`.

## Elsewhere

- **Rename:** `SideQuestions.renameAgent` and the load-time `renamed()` also move `from` and each `asks[].agent`.
- **Delete:** deleting the A→B chat deletes its side questions file. A's chips show "(deleted chat)", and A's main-run cards open nothing.
- **Stop:** this keeps `/btw`'s rule that a chat Stop never stops side answers. *(My call.)* A chat Stop on A ends A's main run, so a `side_question` call made by the main run is cancelled and stops B's entry. A's own side entries keep running, the same as today, and so do their side asks. Stopping A's side entry cancels its side ask and stops B's entry. Stopping B's entry in the A→B panel ends A's call with the stopped refusal. A cascade stop of the A→B chat's main run (from A's Stop) leaves B's side entries alone, the same as a chat Stop leaves `/btw` alone.
- **Ask again on A's entry:** clears its `asks` links before the new run.
- **Archived A→B chat:** side asks still work there, and the chat stays archived, since a side question never sets `inFlight`.
- **Restart:** open entries become "Interrupted by a restart" as today. An open link in A's entry is set to `error` at the same load.
- **Sync:** `btw.json` already joins by entry id. The new fields travel inside the entries. A copy chat of A's chat keeps its links pointing at the original A→B chat.
- **Fork:** A→B chats cannot be forked (read-only). A fork of A's chat carries its side entries as today, links included.
- **Usage, unread, notifications:** as `/btw`: cost on the A→B chat, no unread, no notification.
- **CLAUDE.md:** add a short paragraph under "Agent asks" and a line under "`/btw` side questions".

## Testing

- **Unit (backend):** `parseAskCall` for the new tool (exact keys, caps); `AgentAsks.sideAsk` (each refusal, the shared counters, the outcome mapping, abort stops B's entry, no chat ever made); `SideQuestions.askFrom` (`from` stored, link added and updated, `again` refused, rename moves `from` and links, restart marks links); `sideArgs` (the exception guard only for a user's side question with the bridge, the old guard string byte for byte otherwise, desktop ask rules still merged); `startSideRun` (allow only the exact side tool when flagged, deny everything else); the IPC kind routing; the `askEnd` on side-run dispose.
- **Unit (frontend, pure):** the card state, the B-entry match, the chip text, the cross-chat open step.
- **Real CLI probe:** extend `btwProbe.mjs` (run by `npm run e2e`) with a side run that uses the exception guard and a stub `zumibot_agents` server exposing `side_question` and `ask`, in auto and manual mode. `side_question` must run; `ask`, Bash and the stub's other tool must be blocked. This settles the matcher question above. If it fails, use the fallback hook and probe that instead. Result (Claude Code 2.1.317): the lookahead matcher `^(?!mcp__zumibot_agents__side_question$).*` passed in auto and default mode, so no fallback hook is needed; the probe is `e2e/sideAskProbe.mjs` (own file, run by `npm run e2e`) rather than an extension of `btwProbe.mjs`.
- **e2e (fake claude, no quota):** extend `e2e:ask`. (1) A asks B, then A's script calls `side_question` to B: the card in A's chat shows Done and the answer, and Open in conversation lands on B's entry marked "from @A". (2) The user `/btw`s A, and A's side-run script calls `side_question`: the chip appears in A's side entry and opens B's entry. (3) Stop from the A→B panel gives A the stopped refusal. (4) `side_question` with no A→B chat gives the no-conversation refusal.

## Left to the builder

Component structure and styling (follow `AskCard` and `SideEntry`), the match grace window, how the IPC carries the call kind, and file layout, within the repo's conventions.

## Calls I made (for the user to check)

- Tool name `side_question`, question cap 4 000 characters.
- Side asks share `ask`'s per-turn and in-flight counters.
- The refusal sentences above.
- The guard exception via a lookahead matcher, with a parsed-JSON hook as fallback, proven by the real CLI probe.
- The A→B panel allows Stop but not Ask again.
- A chat Stop still never stops side answers; only a cancelled call or a stop of the entry itself stops a side ask.
- A's side-entry clock pauses while it waits on `side_question`, capped at 6 minutes overall, so B gets its full 3 minutes and A has time to answer.
- A's side-run note names the agents A can side-question, and a plain `ask` from a side run is refused by the server as well as by the hook.
