# Dispatched agents: design

Date: 2026-11-06. Built from a talk with the user and two mockup rounds (`layout`, then `layout-v2`). What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

## Why

An agent often dispatches subagents with the CLI's `Agent` tool (older name `Task`), for example a code reviewer and a structure reviewer in parallel. Today the chat shows each dispatch as a plain tool row: its prompt as Input and "(no result yet)" as Result until the subagent ends, which can take minutes. The user wants to see what each subagent is doing while it works: its conversation and exactly what is happening **(user)**.

The data is already in the stream. Every subagent line carries `parent_tool_use_id`, and the CLI also sends `system` lines `task_started` (prompt, type, description), `task_progress` (a short "what it does now" line such as "Reading a.txt", plus tokens, tool uses and time so far) and `task_updated` (status and end time). The main agent's tool result for the dispatch has the subagent's totals and final report in `tool_use_result`. `streamParser.subagentEvents` drops all of it except the subagent's `Edit`/`Write`/`Agent`/`Task` calls, which the Files panel needs.

## Goals

1. **A new side panel view, "Dispatched agents" (user).** A new row, **Open Dispatched agents**, at the end of the side panel list.
2. **Layout A: a list, then one agent (user, picked A over tabs per agent).** The list works like Files: click a row to open that agent's conversation, Back returns to the list.
3. **The full conversation of each subagent (user):** the prompt the main agent sent, the subagent's own text, every tool call with its Input and Result, and its final report.
4. **Live (user):** while a subagent runs, the list and its conversation update as it works.
5. **Approved playback and mockup `layout-v2` (user):**
   - Menu row badge: "N running" (green) while any runs, else the total count; no badge at zero.
   - List grouped by reply, newest first. Each row: status dot (running, done, failed), the dispatch's `description`, a type chip (`subagent_type`), while running a blue line with what it does now, and "tool uses · tokens · time".
   - A subagent dispatched by another subagent sits indented under its parent.
   - One agent: Back arrow and title; a line with type, status, tool uses and time; the prompt folded with **Show all**; then text and tool rows in order (tool rows open to Input and Result like the chat's); "working…" with a timer while it runs; the final report at the end, labelled as going back to the main agent, folded with **Show all**.
   - The chat's Agent tool rows get **Watch ›** while the subagent runs and **View ›** after, opening the panel straight on that agent.
6. **Kept (user approved the guess):** readable after the reply ends, after a reload and days later. Stored in its own file per chat, never in chat items, so no agent prompt, seed or context meter ever contains it.
7. **Everywhere an agent runs (user approved the guess):** single chats, room members, A→B chats and routine chats.
8. **Watch only (user approved the guess):** no Stop for one subagent (the CLI cannot stop one); the chat's Stop stops them all, as today.
9. **Fork, clone, sync (user approved the guess):** fork and clone start with an empty list; sync carries the file like the to-do list.

## Non-goals

- Tabs per agent (option B, not chosen).
- Stopping, answering or messaging one subagent.
- Subagents dispatched before this ships. The CLI keeps its own subagent logs under `~/.claude/projects/<cwd>/<session>/subagents/agent-<id>.jsonl`, and reading them could fill in old chats, but their layout is internal to the CLI and could change in any update. Old Agent rows show no Watch/View link.
- Letter-by-letter streaming of a subagent's text. Its text appears a message at a time, as the CLI sends whole subagent messages.
- Subagent thinking blocks (the main agent's thinking is not shown either).
- Notifications, unread dots or sounds when a subagent finishes.
- `/btw` side runs: they cannot use tools, so they dispatch nothing.

## How it works

### Capture (backend)

`streamParser` keeps everything a subagent sends instead of only the four tools (my call on event names):

- `subText {parent, text}` for each text block of a subagent `assistant` line.
- `subToolUse` for **every** tool of a subagent, not only `Edit`/`Write`/`Agent`/`Task`. `FileTracker.subUse` already ignores every name but `Edit`, `Write`, `Agent` and `Task`, so it needs no change.
- `subToolResult` as today, plus `detail` (the line's `tool_use_result`, when an object) like the main `toolResult`.
- `taskStarted {toolUseId, taskId, description, subagentType, prompt}`, `taskProgress {toolUseId, description, tokens, toolUses, durationMs}` and `taskUpdated {taskId, status, endTime}` from the `system` lines of those subtypes. `task_updated` carries only `task_id`, so the turn maps it to the dispatch through the `task_id` seen in `task_started`.

`agentTurn` (in `ChatService`, which room members, A→B chats and routines all run through) feeds them to a new per-turn `DispatchRecorder`, which builds one **entry** per dispatch:

- A main-agent `toolUse` named `Agent` or `Task` opens a top-level entry keyed by its tool use id; a `subToolUse` named `Agent` or `Task` opens a nested entry whose `parent` is the dispatching subagent's entry. So the tree is known from tool use ids alone, at any depth.
- The prompt comes from the dispatch's `input.prompt` (and `task_started.prompt` when the input has none); description and type from `input.description` / `input.subagent_type`.
- Steps are appended in stream order: text, tool calls (result patched in by `toolUseId`), and nested dispatches (a step pointing to the child entry).
- The main `toolResult` for the dispatch ends a top-level entry: `done`, or `failed` when `isError`. Its `detail` gives the final totals (`totalTokens`, `totalToolUseCount`, `totalDurationMs`) and the report (`content` text). A nested entry ends on the parent subagent's `subToolResult` the same way. `task_updated` with a final status ends one too, whichever comes first.
- A turn that ends with entries still running marks them `stopped` (the user stopped the turn) or `interrupted` (anything else). At startup, next to the existing recovery of interrupted chats, every stored `running` entry becomes `interrupted`.

### Entry shape

In `shared/src/dispatch.ts` (my call on names; pure helpers live here too):

```ts
interface DispatchEntry {
  id: string            // the dispatching tool use id
  parent: string | null // the parent entry id for a nested dispatch
  turn: string          // the turn id, for grouping by reply
  member?: string       // room member whose turn dispatched it
  description: string
  subagentType: string | null
  prompt: string
  status: 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'
  now: string | null    // the latest task_progress description, cleared when it ends
  usage: { tokens: number | null; toolUses: number | null; durationMs: number | null }
  steps: DispatchStep[]
  report: string | null
  startedAt: number
  endedAt: number | null
  updatedAt: number
}
type DispatchStep =
  | { kind: 'text'; text: string; ts: number }
  | { kind: 'tool'; id: string; name: string; input: unknown; result: string | null; isError: boolean; ts: number; doneTs?: number }
  | { kind: 'agent'; id: string; ts: number } // a nested dispatch: the child entry's id
```

Caps (my call): a tool input's JSON over 20 000 characters is stored as its first 20 000 characters with a note; a result or text over 20 000 characters keeps its first 20 000 plus "… N more characters"; the prompt and report over 50 000 the same way; at most 1 000 steps per entry, keeping the first 50 and the newest 950 with one marker step for the dropped middle; per chat the newest 200 entries by `startedAt` that fit in 10 000 000 characters of JSON (the newest always stays; added after the final review, since 1 000 steps of 20 000 characters let one entry reach 20 MB). Browser and desktop tool inputs and results are stored the way chat items store them (inputs `{}`, results "Browser command completed./failed.", "Desktop command …").

### Store

`chats/<id>.dispatch.json` (`{v: 1, entries}`), written 0600 (tool results can hold what an agent read from a `.env`), through a new `ChatStore.updateDispatch`/`loadDispatch` on the same per-chat queue as the to-dos file. The recorder holds running entries in memory, where every read finds them; tabs are told about once a second, and the file is written once, when the turn finishes (a restart mid-turn loses that turn's entries; changed after the final review, since rewriting a file of up to several megabytes every second was the cost). A write never fails a turn: a failure is logged by its code only.

Chat delete removes the file. Agent rename moves `member` (as `ChatStore.renameAgent` does for the to-dos file); `subagentType` is history and stays. Fork and Clone room start without the file **(user)**.

### Which entries show

`dispatch:list` returns only entries whose top-level dispatch's tool item is in the chat's visible items (nested ones follow their root), so an edited or resent message's hidden version hides its agents, and switching back shows them again. Nothing is deleted on Edit/Resend.

### RPCs and live updates

- `dispatch:list {chatId}` → summaries (every field but `steps`, `prompt` and `report`, plus a step count), with running entries served from the recorder's memory so they are fresh.
- `dispatch:get {chatId, id, from?}` → one entry; with `from`, only steps from that index on (the client appends), so an open long conversation does not refetch everything each second.
- `dispatch:changed {chatId}` is broadcast after each coalesced save. Clients refetch the list when the panel or the menu shows it, and the open entry with `from`. As with `todos:changed`, never dedupe the event.

A new API method touches `ZumiBotApi` (`shared/src/types.ts`), `rpc/handlers.ts` (args checked with `str()` and friends) and `frontend/src/net/api.ts`.

### UI

- `SideView` gains `'dispatch'` (a chat view, like `files` and `todos`, in `state/sidePanel.ts`). The menu row and badge as in Goal 5. The badge needs the summaries, so the menu fetches `dispatch:list` when it opens and on `dispatch:changed`.
- `DispatchPanel.tsx` over a pure `state/dispatchPanel.ts` (grouping by turn, newest first, nesting order, labels such as "7 tool uses · 41k tokens · 1m 12s", the running timer) and a `useDispatch.ts` hook (fetch, refetch on event, append by `from`).
- Group headings: "This reply" for the newest turn, else the reply's time; in a room, the member's name as well.
- One agent: text through the same `Markdown` renderer as replies; tool rows reuse `ToolCallRow` (summary, Input through `visibleJson`, Result); a nested dispatch step is a row that opens that child entry (Back returns to the parent, then the list).
- A row whose subagent has a pending approval card in the chat (the card's `toolUseId` is one of its steps' tool ids) shows "Waiting for your approval" in place of the blue line (my call: the card is already in the chat, this only says which agent asked).
- `ToolCallRow` for `Agent`/`Task` shows **Watch ›** while its result is null and **View ›** after, only when an entry for that id exists. It opens the panel on that entry through a focus value like `SideFocus`.
- On a phone the view is the full-screen sheet like Files and To-dos; Esc and ✕ behave like the other chat views.

### Sync

`sync.mjs` joins `chats/<id>.dispatch.json` by entry id: the later `updatedAt` wins per entry, then the 200-entry cap is applied with the same rule as the server, so both sides prune the same entries. A copy chat gets a copy of the file under its new id.

## Security

- The file is 0600 and served only over the gated WebSocket. No new HTTP route.
- Entries never reach logs, URLs, error messages or any agent's prompt.
- Subagent text and tool results are model output; the UI renders them like replies (same Markdown sanitising, same `visibleJson` for inputs).

## Tests

- Parser: the new events from `fixtures/stream/files-subagent.jsonl` plus a new fixture with text, a failing tool, a nested dispatch and two parallel dispatches.
- Recorder: tree building, ending by tool result and by `task_updated`, stop/interrupt, caps, coalesced saves.
- Store and handlers: visible-items filter, `from`, rename, delete, startup recovery.
- `sync.mjs` merge by id and the shared cap.
- Pure UI state: grouping, nesting, labels, badge.
- An `e2e:dispatch` suite on the fake claude (no quota): a scripted reply with two dispatches, one nested, checking the live list, the detail, Watch/View from the chat row, and that it survives a reload. The fake may need a way to emit subagent lines with `parent_tool_use_id` and `system` task lines; it already replays raw stream lines.

## Left to the builder

- Exact event and type names, file layout of the new modules, and the coalescing interval.
- Whether `dispatch:list` is cached in memory per chat.
- Visual details within the approved mockup (icons, spacing, colours from the existing tokens).
- Whether `task_updated` reports a failure status worth mapping; if it does, map it to `failed`.
- Adding a section for this to `CLAUDE.md`.
