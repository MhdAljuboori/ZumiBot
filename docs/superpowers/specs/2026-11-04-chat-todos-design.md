# Chat to-dos: design

Date: 2026-11-04. Built from a talk with the user and two mockup rounds. What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

## Why

The user runs `/my-day` with Work Assistant every morning. The reply is a digest in tables: meetings, invites not answered yet, Workiom cards waiting on them, Slack messages that need a reply. During the day they work through it and want to tick off each thing they finish **(user)**. When they ask the next question, the agent should know which items are ticked and which are left, without the user pasting anything **(user)**. And when the user asks the agent to do one of them ("send a reply to Morjan with this message"), the agent does it and ticks that item itself **(user)**.

Today a `- [ ]` line in a reply renders as a disabled checkbox (remark-gfm), and the digest is tables anyway, so nothing can be ticked.

## Goals

1. **A To-dos view in the right side panel (user, picked option A of three).** The reply stays exactly as the agent wrote it. No tick boxes inside replies.
2. **One list per chat or room (user).** A new chat starts with an empty list. A new digest in the same chat adds to that chat's list.
3. **Only things the user must act on (user).** In the digest: the unanswered invites, the Workiom cards, the Slack replies. Not the meetings already accepted.
4. **The user can tick, untick and remove items. Agents can too (user).**
5. **The agent knows the list's state on the next message (user).**
6. **The agent ticks what it did for the user (user).**
7. **Repeats (user):** when a later reply in the same chat lists something that is already on the list and still open, the old item stays as it is. Only new things are added.
8. **How a list gets made (user, chose ideas 1 + 3):**
   - `/todo` at the start of any message, for any agent, asks that agent to put this reply's action items on the list.
   - `/todo` works together with an agent command: `/todo /check-inbox`.
   - A saved command can carry a "makes to-dos" flag, so using it always builds the list without `/todo`.
9. **Zumi Bot sets that flag by itself** when it writes or edits a command whose answer is a list of things the user acts on **(user)**.
10. **Existing agents (user):** the flag goes on Work Assistant's `/my-day`, `/check-inbox`, `/slack-catch-up` and `/workiom-notifications`. Not on Structure Reviewer `/review`, UI/UX Specialist `/ui-review`, Localization Manager `/audit` or Workiom Master `/use-cases`. No other command gets it.
11. **Panel behaviour (user, approved playback and mockup `panel-v2`):** described under "The panel" below.

## Non-goals

- **A per-agent "Makes to-dos" switch.** I proposed it, then dropped it once the user chose the command flag plus `/todo`. The user did not ask for it back.
- **A "Make to-do list" item in the reply's hover menu** run by a separate model. The user chose 1 + 3 instead; `/todo make the reply above a list` covers old replies, with the agent's own context.
- **Tick boxes inside the reply**, with or without the panel (options B and C, not chosen).
- **Routines (user approved the spec with routines out).** A routine run never sets `todo: true`, even for a flagged command, and `/todo` in a routine prompt is plain text. Routines resolve agent commands through `forRoutine` in `commandResolver.ts` (landed before this build); the routine runner passes no `todo`, so a routine run of a flagged command is a natural follow-up, not part of this build.
- **Editing item text by hand.** Hand-adding came later (see "The panel"); changing the text of an item is still not offered.
- Due dates, reminders, notifications about to-dos, unread dots from to-do changes, a list across chats.

## How it works

### Overview

- The agent changes the list through ZumiBot's own tools (an MCP server ZumiBot runs per turn, the same way it runs the `zumibot_browser` tools).
- The user changes it in the side panel, over RPC.
- The list is stored per chat in its own file, outside the chat items.
- The agent is told about the tools in a fixed paragraph of its system prompt, is asked to make a list by a line added to the message it reads, and is told the list's current state in a note added to the message it reads whenever the list changed since it last saw it.

### The agent's tools (my call)

An MCP server named `zumibot_todos`, built exactly like `zumibot_browser` (`core/browser/browserIpc.ts`, `browserBridge.ts`): a bundled stdio bridge entry (`todoBridge.mjs`, another `input` in `backend/vite.config.ts`), started by the CLI from an `--mcp-config` the runner passes, talking to the server over a Unix socket with a capability token issued per CLI attempt. The token is bound to `{chatId, agent, turnId}` and revoked when the attempt ends, so the bridge can only reach its own chat's list. Same hardening as the browser IPC: owned 0700 directory, 0600 socket, auth line first, byte limits before JSON parsing, bounded pending calls. Sharing the browser's IPC server with a second channel, or running a separate one, is the builder's call.

Tools (names as the agent sees them: `mcp__zumibot_todos__list`, `__add`, `__check`, `__remove`):

| Tool | Input | Does |
|------|-------|------|
| `list` | none | Returns the open items (id, text, group, which reply they came from) and the items done or removed since this agent last saw the list. |
| `add` | `{items: [{text, group?}]}` | Adds items under the current turn. `group` is the heading from the reply ("Invites", "Workiom", "Slack"). Returns the new ids. |
| `check` | `{ids, done: boolean}` | Ticks or unticks. |
| `remove` | `{ids}` | Removes. |

Every tool answers with the current open list in short form, so the agent's own history stays current after it changes something.

**Every agent gets these tools on every turn, in every chat and room (my call).** Adding or removing tools between turns changes the tool definitions at the start of the prompt, which makes the CLI re-read the whole session at full price. Keeping them always there keeps the cache. Side runs (`/btw`) must pass the same MCP config as the main run for the same reason; their deny hook already blocks every tool, so a side answer can never touch the list.

**Agents with a `tools:` list (my call).** With `--agent`, the CLI gives such an agent only the tools it lists, so it would never see the to-do tools. Today that is Structure Reviewer and UI/UX Specialist. So the four to-do tool names go into every `tools:` list ZumiBot writes: Zumi Bot adds them as it already adds `AskUserQuestion`, Agent Studio's tools picker adds them whenever it saves a non-empty list, and the two existing files get them once (see "Existing agents"). The first build step is a real-CLI check that an agent's `tools:` list accepts `mcp__zumibot_todos__*` names. If it does not, `/todo` and the request line are left out for agents with a `tools:` list, and the `/` menu does not offer `/todo` for them.

The runner already passes the browser's `--mcp-config`; the to-do server goes in the same JSON object or in a second `--mcp-config` value. The capability env var joins the browser's in the set of secrets kept out of logs (`browserSecrets` in `chatService.ts`).

**No approval cards (my call).** `ChatService` answers every `mcp__zumibot_todos__*` permission request with allow by itself, in both permission modes, never shows a card, never stores a rule, never asks Jev for a risk hint. The tools only touch this chat's list, and the user can undo any change in the panel.

**Small server-side safety net (my call).** `add` skips an item whose trimmed text equals an open item's text in the same chat and reports it as skipped. Recognising "the same card, worded differently" stays the agent's job.

### What the agent reads

Three pieces.

1. **A fixed paragraph in the appended system prompt, the same text on every turn** (so the cache holds). It says what the list is and how to use the tools:
   - Add items only when the user's message asks for a to-do list (piece 2 says so).
   - An item is one short, actionable line about something the user has to do, with the link if there is one. Things that need nothing from the user stay out.
   - Use the reply's own headings as `group`.
   - Before adding, look at the open items and skip anything already there, even when worded differently.
   - Tick an item when you finished it for the user in this turn, or when the user says it is done. Untick when the user says so.
   - Remove an item only when the user asks.
   - Never show item ids to the user.
2. **A request line on to-do turns.** When the user's message started with `/todo`, or used a command with the flag, the text the agent reads gets one more line after the prompt, like "Put the action items of your reply on this chat's to-do list with the zumibot_todos tools." It is added at read time from a stored marker (`todo: true` on the user item, see `/todo` below), through the same path that gives a command's agent the filled prompt (`readAs` / `withCommands` in `core/chat/commandText.ts`). So Edit and Resend keep it. Every agent that reads the message sees the line, in a room too (whichever member answers should put its action items on the list); only the moderator, which reads `text`, never sees it.
3. **A state note when the list changed.** The list keeps a revision counter (`rev`), and the chat keeps, per agent, the `rev` it last saw (set at the end of each of its turns to the rev its note read at the start). When an agent's turn starts and the `rev` is newer, or the agent's session is new, seeded or cut (Edit, Resend and version switches resume a session from before the hidden turns, whose notes `seen` is already past), the message it reads gets a short block: the open items (id, group, text) and what was ticked, unticked or removed since it last saw the list, and by whom. A `/todo` turn always gets the open items, so the agent can skip repeats. For a list that never had an item the note is null, unless the turn is a `/todo` one (which then hears the list is empty). The `rev` stored in `seen` is the one the note read at the start of the turn, not the list's rev at the end: a change made while the reply ran is still news next turn, and the agent's own changes are left out of the note by `changesSince`. Past about 4 000 characters the block lists what fits and says to call `list` for the rest. The note is never a chat item and never stored in the chat JSON; it only goes to the CLI, like the filled command prompt.

### `/todo`

- `/todo` counts only at the very start of the message, like an agent command. It is built in for every agent, like `/btw`, and listed in the composer's `/` menu.
- After `/todo ` the `/` menu opens again for the agent's commands, so `/todo /my-day` can be picked from menus. Only right after `/todo `.
- The send, edit and resend handlers strip the leading `/todo` and its whitespace, then resolve a command from the rest as they do today (`CommandResolver`). The stored user item keeps `text` as typed (`/todo /my-day`), gets `todo: true`, and gets `command` as usual. The bubble shows a `/todo` chip next to the command chip.
- A command with the flag sets `todo: true` on the user item by itself, without `/todo`.
- `todo` becomes a reserved command name, like `btw`: `commandIssue` rejects it, and Zumi Bot is told.
- In a room, `/todo` applies to whichever members answer that message. Routing is unchanged: the moderator reads `text`, and a command still routes as a mention of its agent.
- `/btw /todo …` is plain text in a side question (side answers have no tools). Routines never resolve it.

### The command flag

- `AgentCommand` gets `todos?: boolean`, written in the agent file as `todos: true` under the command, next to `name`, `description` and `prompt`. `parseCommands` reads it; anything but `true` is off.
- `CommandSummary` carries it, so the `/` menu can mark such commands with a small ☑ (my call). `SentCommand` stores it on the user item, so editing the agent file later never changes history.
- Agent Studio's commands card (`CommandsCard.tsx`) gets a "Makes to-dos" checkbox per command.

### Zumi Bot

Its instructions (`core/agents/zumiBot.ts`) learn:

- the `todos: true` key on a command and what it does;
- to set it when a command's answer is mainly a list of things the user has to act on: a daily brief, an inbox, notification or Slack catch-up;
- not to set it on commands that do a job (fix, ship, merge, send, create), nor on reviews, audits or QA case lists, unless the user asks (this follows the user's choice on the four commands above);
- that `todo` is a reserved command name;
- to add the four `mcp__zumibot_todos__*` names whenever it writes a `tools:` list, as it already adds `AskUserQuestion`;
- to mention `/todo` and the flag when it tells the user which commands it added.

### Existing agents

Once the feature ships, add `todos: true` to Work Assistant's `my-day`, `check-inbox`, `slack-catch-up` and `workiom-notifications` in `~/.claude/agents/work-assistant.md` **(user)**, keeping every `prompt: |` block scalar intact. No other command gets the flag **(user)**.

The only other change: the four to-do tool names are added to the `tools:` lists of `structure-reviewer.md` and `ui-ux-specialist.md`, so `/todo` works for them too (my call, see "Agents with a `tools:` list").

### The panel

Approved in the `panel-v2` mockup and the playback **(user)**, details my calls:

- The side panel's list gets **Open To-dos**, with "N left" when items are open.
- The view (`TodosPanel.tsx`, pure logic in `frontend/src/state/todosPanel.ts`) has Back, the title "To-dos · N left", ✕, and Esc closes it, like Files and Side questions. On a phone it is a full-screen sheet, like Files.
- **Groups by the reply that made them, newest first.** A group's label is the command (`/my-day`) or the start of the user's message, plus day and time, with **Show in chat** that jumps to that reply. Show in chat is hidden when that reply is not in the visible items (another version, or gone).
- Inside a group, items sit under their headings in the order the agent gave them.
- **An item:** a tick box and the text. Text is inline markdown rendered with the same sanitising as replies, so card links stay clickable. An item the agent ticked shows "by agent", or the member's name in a room.
- **Remove:** ✕ on hover (always visible on touch). The item goes at once, and an **Undo** toast shows for about 6 seconds. No confirm.
- **Done:** ticked items move to one folded **Done · N** section at the bottom, newest first. Folded or open is remembered per device.
- **Adding by hand (user, asked after the first build):** an input row below the header ("Add a to-do…", Enter or Add; rooms too; allowed while a reply runs). The new item joins one group, "Added by you" (fixed turn `user`, no reply id, so no Show in chat; the group is placed by its newest item). A repeat of an open item says "Already on the list" and keeps the text; a failure such as the open cap shows the server's message. The agent hears of it in its next state note as "added by the user: <text>".
- **Empty list:** "No to-dos yet. Start a message with /todo to make one."
- Changes by the agent show live while its reply runs.

**In the chat.** To-do tool calls are not shown as tool rows. The turn's last item gets a `todos` touch instead, like the existing `memory` touch: what it added, ticked, unticked and removed. Under the reply this shows as:

- a chip "☑ 4 new to-dos" that opens the panel on that group;
- one line per change: "☑ Ticked: Reply to Morjan", "✕ Removed: Reply to Homam";
- in a room, the member's name on each line.

### Data

- **`chats/<id>.todos.json`**, apart from the chat items and the items feed, like `chats/<id>.btw.json`: `{v: 1, rev, items, seen}`.
- **An item:** `{id, text, group, from, addedBy, done, removed, updatedAt}`.
  - `from` holds the turn and the reply item id it came from, plus the label used for its group.
  - `done` and `removed` are each `{at, by}` or null. `by` is `'user'` or an agent name.
- **`seen`** maps agent name to the `rev` it last saw.
- **Removed items stay as tombstones,** for Undo and for sync, and are never pruned (my call). Sync joins by id and never deletes, so a pruned tombstone or an evicted done item would come back from the other machine. They are small: a year of daily digests is a few hundred kilobytes.
- **Caps (my call):** text one line, at most 300 characters; at most 50 items per `add`; at most 200 open items per chat. Done and removed items have no cap. At the open cap `add` refuses with a plain message, and the agent tells the user to tick or remove some. The panel's Done section shows the newest 100 with "Show more".
- **Agent renames** move `addedBy`, `done.by`, `removed.by` and `seen` keys, with the rest of the rename (`agentsSync.ts`).
- **Deleting a chat** deletes the file.
- **Archive** changes nothing (sending unarchives anyway).

### RPC

- `todos:list(chatId)` returns the items that are not removed, plus `rev`.
- `todos:add(chatId, text)` returns `{added}`; `added` is false when an open item already reads the same (nothing changes, no event). It adds one item by `user`; the caps apply.
- `todos:check(chatId, ids, done)`, `todos:remove(chatId, ids)`, `todos:restore(chatId, ids)` (Undo).
- Event `todos:changed {chatId, rev}`, broadcast like other events.
- The user's changes are allowed while the chat runs. The agent learns about them from its next tool result or its next turn's state note.
- Writes to one chat's file go through one queue, as the other stores do.

New methods touch the usual three places: `ZumiBotApi` in `shared/src/types.ts`, `rpc/handlers.ts`, `frontend/src/net/api.ts`.

### Edit, Resend, Fork, Clone, Sync

- **Edit, Resend, version switches** leave the list alone **(user)**. Items from a reply that is no longer visible keep their group; Show in chat hides. The cut run gets the whole state note, because its session never read what the hidden turns' notes said.
- **Fork** copies the list **(user)**. From an earlier message it copies only the items whose source reply was copied, with their current ticks, like side questions, which are copied only when their anchor item was (my call). Items from later replies stay behind. Open items the user added by hand have no reply, so they are copied when made at or before the fork point (the newest copied item), with their ticks, and stay behind when made later. Tombstones are not copied. `seen` is cleared, so each agent's first turn in the fork gets the state note. Group sources point at the copied items.
- **Clone room** starts with an empty list **(user)**.
- **Sync (`sync.mjs`):**
  - It joins `chats/<id>.todos.json` by item id. Per item, the later `updatedAt` wins, tombstones included, so a removal on one side stays removed **(user, approved playback)**.
  - `rev` becomes the larger plus one. `seen` per agent takes the smaller, so agents get a state note after a sync.
  - A copy chat made by sync gets a copy of the list.
  - Never deletes.

### Safety

- Item text comes from the agent and is untrusted: sanitised inline markdown only, length-capped.
- The capability token and item text never go into logs, URLs, error messages or notification payloads.
- The bridge has no way to name another chat.

## Testing

- **Pure units:**
  - list operations, caps and the exact-text skip;
  - the state note builder (what changed since `seen`, the size cap);
  - `/todo` parsing with and without a command;
  - `todos` in `parseCommands` and the reserved `todo` name;
  - panel grouping, ordering and the Done fold;
  - the sync join.
- **Backend:**
  - the store and its queue;
  - the RPC handlers and their argument checks;
  - the IPC auth and limits;
  - auto-allow of the to-do tools with no card;
  - the `todos` touch on the reply item;
  - fork copying, clone not copying, rename moving names.
- **`npm run e2e:todos`, fake claude only, no quota.** The fake claude needs a new script directive that starts the stdio server named in its `--mcp-config` and calls a tool, writing matching `tool_use` / `tool_result` stream lines, for example `#MCP_CALL {"server": "zumibot_todos", "tool": "add", "args": {...}}`. It checks:
  - a `/todo` turn adds items and the panel shows them;
  - a tick in the panel shows up in the next turn's stdin as a state note;
  - an agent tick shows its line under the reply and "by agent" in the panel;
  - remove and Undo;
  - a flagged command works without `/todo`;
  - Fork copies the list and Clone room starts empty;
  - a reload keeps the list;
  - a second browser context sees changes live.
- **`npm run e2e` (real CLI)** gets one probe turn that calls `list` through the real CLI, to prove the MCP wiring and the auto-allow keep working after Claude Code updates, plus one with an agent whose `tools:` list names the to-do tools.

## Left to the builder

- Shared or separate IPC server for the bridge.
- Exact wording of the system paragraph, the request line and the state note.
- Visual details: chip and line styling, toast timing, the ☑ mark in the `/` menu.
- How a group label is cut from a long user message.
- Updating `CLAUDE.md` (Architecture, Data, the e2e list) once built.

## Spike results

Run against the real CLI, Claude Code 2.1.317, `--model haiku`, with a 40-line stdio MCP server exposing one tool (`list`) as `zumibot_todos`.

1. **Two `--mcp-config` flags work.** With `--mcp-config <todos.json> --mcp-config <dummy.json>` the `init` event's `mcp_servers` lists both (`zumibot_todos`, `dummy`, each `status: connected`, `source: dynamic`) and `tools` holds `mcp__zumibot_todos__list` and `mcp__dummy__ping`. So Task 6 passes the to-do server as its own second `--mcp-config` flag; no merge into one JSON is needed.
   Working form (same shape as the browser's): `--mcp-config '{"mcpServers":{"zumibot_todos":{"type":"stdio","command":"node","args":["/path/server.mjs", ...]}}}'` (inline JSON string or a file path both fine; we ran file paths).
2. **Permission.** With `--permission-mode manual --permission-prompt-tool stdio` a `control_request` with `subtype: can_use_tool`, `tool_name: "mcp__zumibot_todos__list"`, `input: {}` arrives on stdout (twice out of two runs), and answering with `allowResponse(requestId, input)` lets the tool run (`tool_result` returned). With `--permission-mode auto` no `can_use_tool` request is sent for the MCP tool (three runs); it just runs. So the bridge must be auto-allowed on the manual path (answer `can_use_tool` for `mcp__zumibot_todos__*` without a card), and nothing is needed on the auto path. Note: the model sometimes reaches the tool through the CLI's `ToolSearch` first (a deferred tool); in manual mode that `ToolSearch` call raised no approval request, only the MCP call did.
3. **`tools:` lists honour MCP names.** An agent with `tools: Read, mcp__zumibot_todos__list` gets exactly `["Read","mcp__zumibot_todos__list"]` as its `init` `tools` and can call it (manual and auto). So Task 10 adds the to-do tool names to such lists' effective tools instead of hiding `/todo`. Caveat: the agent's `tools:` list also limits it to those tools, so any other MCP server tool (the browser's) would be absent unless named; that already holds today.

Scratch files: `/tmp/claude-1000/-home-mhdaljuboori-Developments-AI-ZumiBot/15e550cd-9c44-4b9b-bc25-7e23ffe26acd/scratchpad/spike/` (not in the repo).

## Deferred review notes

Known leftovers of the build, not fixed in it:

- The chat title from a first message `/todo plan` still contains `/todo`.
- Picking the `/todo` menu item leaves `/todo ` with no menu until `/` is typed.
- The composer highlight does not tint the command after `/todo`.
- Show in chat may show a dead jump while older pages are unloaded.
- `useTodos` does not tolerate a null reply.
- Temp dirs `/tmp/cb-t-*` leak on SIGKILL, like the browser's.
