# Agent asks: design

Date: 2026-11-05. Written after a conversation with the user. **(user)** marks what the user asked for or decided. **(seen)** marks one of my proposals that I played back to the user and they did not object to. It is still my call, but they have read it. Everything else is my call and can be changed.

## Why

The user is in a one-on-one chat with an agent, checking an issue, and notices a second issue. They want to hand that off without leaving the chat: "Ask @workiom-master to create a card for this one" **(user)**. The current agent (A) should run the other agent (B), tell it what is needed, and continue once B is done. The conversation A had with B should show up among B's chats as a read-only agent-to-agent chat **(user)**.

Today the only way to involve a second agent is a room, where the user has to set up the members first. In a single chat, `@name` is plain text and the agent can do nothing with it.

## Goals

1. **A can ask B mid-task (user).** A writes the message to B itself. B never sees A's chat, only what A sends it, so A must include the details B needs **(seen)**.
2. **Agents ask each other on their own, not only when the user says so (user).** A may ask B whenever it decides B is the better fit.
3. **Every agent can ask every other agent (user).** There is no per-agent allow list. The exceptions (Zumi Bot, rooms) are under Non-goals.
4. **B can ask questions back (user).** A either answers from what it knows or asks the user, then passes the answer to B.
5. **The A→B conversation is a read-only chat under B (user).** Reading it is enough. The user never types into it **(user)**.
6. **A waits for B's answer, then carries on (seen).** It does not just send the request and move on.
7. **One A→B chat per source chat and B (seen).** If A asks B again from the same chat, that chat continues and B remembers the earlier exchanges.
8. **B's approvals show in A's chat (seen)**, where the user already is, and can be answered there.
9. **Stop in A's chat stops B too (seen).**
10. **Limits (seen):** a chain of at most 3 hops; no agent can be asked while it is already waiting in the same chain; at most 10 asks per turn of A.
11. **An `@` menu in a single chat's composer (seen)** that lists the agents, so "Ask @B" is quick to type and is colored the same way room mentions are.

## Non-goals

- **Rooms (seen).** Room members already hand work to each other with @mentions, and `groupPrompts.ts` tells them never to run another member. Room turns get no ask tool, and a room cannot be the source of an A→B chat. This could come later.
- **Zumi Bot (seen).** It cannot be asked, because its own description says never to delegate to it, and it gets no ask tool either. Its working folder and deny rules are special.
- **Typing into an A→B chat (user).** There is no composer, and none of Edit, Resend, Fork, Compact, `/btw`, Retry or Mark unread.
- **Per-agent permissions on who may ask whom.**
- **Passing attachments from A to B.** B runs in A's chat folder, so A can name file paths in its message.
- **B's file edits in A's Files panel.** They show in the A→B chat's own Files panel.
- **Running asks in the background.** A's turn waits on its ask, the same way it waits on any other tool.

## How it works

### Overview

- Each turn of a single chat, ZumiBot gives the agent an `ask` tool through its own MCP server, `zumibot_agents`, built the same way as `zumibot_todos` (`core/todos/todoIpc.ts`, `todoBridge.ts`) and `zumibot_browser`.
- An `ask` call finds or creates the A→B chat and runs one normal ChatService turn of B in it, with A's message as the user message. A gets back B's final reply.
- While B runs, A's chat shows a live "Asked @B" card that holds B's pending approval cards and a link to the A→B chat.
- B's turn is an ordinary chat turn, so B has its own session, prompt, tools, memory, approvals, usage records, Files panel and context meter. Only how the chat is shown, and who sees its cards, changes.

### The tool (my call)

An MCP server named `zumibot_agents`, hardened like the todo IPC: an owned 0700 directory, a 0600 socket, the auth line first, byte limits enforced before JSON parsing, a bounded number of pending calls, and a capability token issued per CLI attempt and revoked when that attempt ends. The token is bound to the owner `{chatId, agent, chain, turn}`, and the server never takes a chat id or an agent name for the caller from the call itself. Whether to share an IPC server with todos or run a separate one is the builder's call.

There is one tool, seen by the agent as `mcp__zumibot_agents__ask`:

| Input | Meaning |
|-------|---------|
| `agent` | B's handle, the agent name matched without regard to case using the rules in `shared/src/mentions.ts`. A leading `@` is allowed and dropped. |
| `message` | What B reads as its user message. At most 20 000 characters. |

The call blocks until B's turn ends. It answers with one text block:

- **ok:** B's final reply: the text of the last assistant message of B's turn, capped at 50 000 characters with a note when cut. If B wrote no text, the answer says so.
- **not ok:** a fixed sentence that A can act on, never CLI output or a path. The cases:
  - no agent by that name (the answer lists the handles that do exist)
  - B is Zumi Bot
  - B is A itself
  - B is already waiting in this chain
  - the chain is too long
  - this turn's ask limit is used up
  - B is still answering an earlier message from this chat
  - B's agent file fails to load
  - B hit the usage limit (with the time it lifts)
  - B's turn failed
  - the ask was stopped
  - the server is stopping

The MCP config entry gets `timeout: 86400000`, and the turn's env sets `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, the same as the browser bridge, so a long ask is never moved to the background or timed out by the CLI.

**The `ask` call itself needs no approval card (my call).** It runs nothing on its own, and every tool B uses still goes through B's own approvals. It is allowed the same way the todo tools are. The server also refuses send, rerun, compact, fork, mark unread and `/btw` on an A→B chat (`This chat is read-only`), so the read-only rule does not rest on the UI alone.

**Every attempt gets the tool, used or not (my call).** That includes every single-chat turn of every agent except Zumi Bot, routine runs included. A tool that came and went between turns would change the cached prompt prefix, which is also why the todo bridge is created on every attempt. Side runs (`/btw`) already deny every tool through their PreToolUse hook. The moderator, the room summary and the side picker run with `--strict-mcp-config` and never see the tool.

### What A is told (my call)

A fixed paragraph is added to A's appended system prompt, next to the browser and todo paragraphs. It says:

- When the user's message `@mentions` another agent and asks for its help, or when the work clearly belongs to another agent, use `ask`.
- B sees only your message: include what it needs (links, ids, file paths, the issue itself).
- B's reply may end with questions. Answer them with another `ask` to the same agent if you know the answers. Otherwise ask the user (with `AskUserQuestion` where you have it), then pass the answer on.
- Tell the user what B did, briefly. Don't paste B's whole reply unless it's short.
- Don't ask an agent to do what you can do yourself.

A roster follows: each askable agent's handle and the first line of its `description`, A itself left out. It is rebuilt each attempt from `AgentStore`, so it only changes the cached prefix when the agent set or a description changes.

### The A→B chat

- **Key (seen):** at most one live A→B chat per `(source chat id, B)`. It is found by a new `ChatMeta.asked` field:
  ```ts
  asked?: {
    by: string          // A's agent name, the asker (renamed with the agent)
    from: string        // the source chat id
    fromTitle: string   // the source chat's title when the A→B chat was made
    chain: string[]     // agents waiting above this chat when it was made, outermost first (for display only)
  }
  ```
  If the A→B chat was deleted, the next ask makes a new one. An archived one is reused, and a run unarchives it (that already happens whenever `inFlight` is set).
- **agentName** is B and **cwd** is the source chat's cwd, so it sits under B in the sidebar with no sidebar change.
- **Title (my call):** `@A · <source chat title>`, set once at creation. The user can rename it like any chat.
- **Header (seen):** "Conversation between @A and @B, started from <source chat link>." The link works while the source chat exists and reads "(deleted chat)" otherwise, like the handoff card's link. There is no composer, and the message hover menu offers only Copy.
- **A's messages** are stored as `user` items with a new `from: string` field (A's name). They render on the user side with A's avatar and name, not "You". Every reader that turns items into prompt text (`seedPrompt.ts`, the moderator, the room summary) keeps treating them as user text. Only the bubble changes.
- **B's appended prompt in this chat (my call)** adds a paragraph: you are being asked by agent @A, working for the user in their chat "<title>"; the user does not read this chat live and cannot answer you here; if you need anything, end your reply with your questions and @A will answer them or ask the user; your last message is all @A gets back, so make it complete.
- **B's `AskUserQuestion` (my call):** in an A→B chat it is denied with the message "Ask your question at the end of your reply; @A will answer or ask the user", so B's questions reach A (goal 4). `ExitPlanMode` and tool approvals are not denied. They go to the user through A's chat (next section).
- **Unread and notifications (seen):** this chat never shows as unread (each turn end stamps `seenAt` together with `replyAt`), and it never sends `replied` or `error` notifications. Its `waiting` notification is sent as the chain's outermost chat (A's chat) instead, because that is where the card is answered. A's chat is what tells the user.
- **How B's turn runs (my call):** the ask handler calls a new ChatService entry that claims the A→B chat the same way `send` does and runs one turn. It does not go through TaskQueue, because nothing else sends to an A→B chat. A claim that fails becomes the "still answering" refusal.
- **Agent rename:** the rename path updates `asked.by` for A and `agentName` for B, in the same pass that already rewrites stored chats.
- **Deleted agents:** an A→B chat whose B is deleted is handled the same way as any chat of a deleted agent. If A is deleted, the chat stays, with A's name shown as plain text.

### In A's chat

- **The ask card (seen).** A tool item named `mcp__zumibot_agents__ask` renders as a card instead of the generic tool row:
  - B's avatar and name, and "Asked @B" (or "Asking @B…" while running)
  - A's message to B, collapsed to two lines with a toggle
  - a status: working, waiting for you, done, failed or stopped
  - B's pending approval or plan cards, live and answerable in place
  - when done, B's reply collapsed with a toggle
  - **Open conversation**, which opens the A→B chat
  
  The card finds the A→B chat from the tool result (`{chatId}` in the tool result's structured detail, or a server-side map from tool use id to chat id). The builder picks which.
- **B's pending cards count as A's chat's (seen).** ChatService keeps an in-memory link from each running A→B chat to the chat that asked it, so a change in B's pending count also re-pushes the asker's count, up the whole chain. A's `approvals` push (its `pending` number is A's own plus every live ask's below it), its pending badge in the sidebar, a routine run's `waiting` state and the `waiting` notification all include B's pending cards, and the notification opens A's chat. Answering goes through the existing `chats:answer` / `chats:answerPlan` with B's chat id, so no new answer path is needed. Allow for this chat applies to the A→B chat, and Allow always for this agent applies to B. An ask never widens what B may do: B's tools go through B's own rules.
- **Stop (seen).** Stopping A's turn cancels the MCP call, which stops B's turn. That cascades through a chain. Stopping B's turn on its own is not offered, because the A→B chat is read-only.
- **Nested chains:** if B asks C, B's ask card for C lives in the A→B chat (that is where B's turn runs), and the B→C chat sits under C. A's card shows B's pending cards, and those include C's, because pending rolls up the chain.

### Limits (seen)

- **Chain depth:** A→B is hop 1, B→C hop 2, C→D hop 3, and a fourth hop is refused. The owner's `chain` (agent names waiting above, outermost first) travels with B's turn so B's bridge knows it.
- **No asking back:** an agent that is already waiting in the chain cannot be asked (A→B→A would freeze both). Refused with the fixed sentence.
- **Per turn:** 10 asks per turn of A, counted on the owner across attempts. Each chain level has its own count.
- **One at a time per A→B chat:** a second `ask` to the same B from the same source chat while the first runs is refused ("still answering"). Parallel asks to different agents are allowed, at most 3 at once per turn (my call).

### The composer's `@` menu in a single chat (seen)

`@` opens the same list component rooms use, filled with every loadable agent except the chat's own agent and Zumi Bot. Picking one inserts `@handle`, and mentions are colored as in rooms. Nothing about sending changes: the text goes to A exactly as typed, and A decides (system paragraph). The menu does not appear in an A→B chat (no composer) or on the new-chat screen.

### Everything else

- **Usage:** B's turns record cost on the A→B chat as usual. There is no roll-up into A's chat.
- **Edit / Resend / version switch in A's chat:** the A→B chat is left as it is, and a later ask continues it, so B may remember an exchange A's new version never had. I accept this; it is simple and harmless.
- **Fork of A's chat:** the copied ask cards still link to the old A→B chat. The fork's own asks make new A→B chats, because the key is the source chat id.
- **Clone room:** not affected (rooms have no asks).
- **Restart while an ask runs:** recovery already marks both turns interrupted. A's ask card shows "interrupted", and the A→B chat gets the usual interrupted notice.
- **Sync:** `asked` is part of the chat meta and syncs with it. `sync.mjs` needs no change beyond carrying the field. A copy chat made by the join keeps `asked`.
- **Archive:** an A→B chat can be archived and unarchived like any chat, and a run brings it back.
- **Deploy busy count:** B's turns are chat turns, so they already count.
- **Routines:** a routine run in A's chat may ask. B's pending cards make the run `waiting`. If B hits the usage limit, A gets the fixed sentence and decides what to do. The routine's `limitPolicy` covers only A's own turn.
- **Memory:** B saves memories as usual, and the A→B chat shows "Memory: 1 saved".

### Security

- The capability token is bound to the owner. The bridge cannot pick its caller, its chat or its chain. It names only the target agent and the message.
- The target name is checked against `AgentStore`. It is never a path, and an unknown name is refused before anything runs.
- Message and reply caps (20 000 and 50 000 characters) keep a runaway agent from filling the other's context.
- A's message and B's reply never go into logs, URLs or error text. Errors are the fixed sentences above.
- Nothing is auto-allowed because of an ask. B's approvals reach the user in A's chat.
- Zumi Bot is never a target and never a caller.

## Testing

- **Unit (backend):** tool argument parsing (exact keys, length caps); the chain rules (depth, asking back, per-turn and parallel caps); finding or creating the A→B chat by `(from, B)`, including after delete and when archived; B's appended paragraph and the `AskUserQuestion` denial; pending cards rolling up to A's chat; rename updating `asked.by`; Stop cascading through the MCP cancel; the reply cap; no notification or unread state for A→B chats.
- **Unit (frontend, pure `state/` modules):** the ask card's state derived from the tool item and B's chat meta; the single-chat `@` menu's agent list; the A→B header text and the source link when the source is gone.
- **e2e (`npm run e2e:ask`, fake claude only, so it costs no quota):** A's script calls `#MCP_CALL` `zumibot_agents`/`ask` (the fake honours `--mcp-config`). B's fake script replies, and A's tool result holds B's reply. B's script raises a permission request (a `can_use_tool` line plus `#WAIT_RESPONSE`) that is answered from A's chat. The A→B chat sits under B, is read-only and shows A's name on its messages. A second ask from the same chat continues the same A→B chat. Stop in A's chat stops B. Asking A from B is refused. The fake's 15 s MCP call timeout is enough for scripted replies.
- **CLAUDE.md:** a paragraph under Architecture, like the other features, and the new e2e script in the Commands list.

## Left to the builder

- Sharing the todo IPC server or running a separate one.
- How the ask card finds the A→B chat id (structured detail in the tool result, or a server map).
- How the ask card gets B's pending cards to show (the `approvals` push carries only a count): loading the A→B chat's items when its count changes, or a new push. The cards must be live and answerable in place either way.
- The card shows status, not B's live tool steps (my call). To watch B work, the user opens the conversation.
- The exact wording of the fixed paragraph, B's paragraph and the refusal sentences, within the meaning above.
- Component names and where the `@` menu's agent list is computed, as long as the logic sits in `state/`.
