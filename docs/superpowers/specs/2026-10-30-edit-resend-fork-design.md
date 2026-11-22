# Edit, Resend and Fork

## Intent

A reply goes wrong: the agent misreads the question, the user stops it halfway, or the answer is cut off. Today the only way forward is to type a new message on top of the bad turn, or to start a new chat and paste the context in by hand. The agent still remembers the bad turn either way.

The user wants three things, in single chats and group rooms alike:

1. **Edit**: change a message they sent (usually after stopping the reply) and run it again.
2. **Resend**: send the same message again to get a complete answer, or just a different one.
3. **Fork**: carry the chat up to some point into a new chat and continue there, leaving the original alone.

Old answers are kept. The user can switch back to any earlier version, and the agent's memory switches with it.

## Goals

- Edit and Resend on every message the user sent, in single chats and group rooms. The latest agent answer also gets Resend.
- Every Edit or Resend makes a new **version** of everything after that user message. Earlier versions are kept, and arrows under the user's bubble (`‹ 2 / 3 ›`) switch between them.
- What the agent remembers always matches the version on screen. After an edit or resend the agent has no memory of the replaced answer. After switching back, it remembers the old one again.
- Fork on any message opens a new chat seeded from that point. The original chat is not changed.
- Works the same in every tab and device, like the rest of the chat (server-owned, pushed to every tab).

## Non-goals

- Undoing file changes. Files on disk stay as they are, whichever version is shown (see "Files").
- Regenerating one member's reply inside a group room. A version always starts at a user message.
- Editing an agent's message.
- Deleting a version.
- Editing attachments. An edit changes the text; the message keeps its attachments as they were.
- Versions for queued tasks (the tasks tray). A task becomes a normal user message once it is sent, and from then on it can be edited like any other.

## Anti-goals (a failure even if it "works")

- The agent remembers something the user can't see on screen, or forgets something they can. This is the whole point. Pretending to rewind while the Claude session still holds the old turn would be the worst way to get it wrong.
- A version is lost: through switching, an agent rename, a server restart mid-run, `npm run sync`, or the desktop Sync button.
- Items from a hidden version reach a group member, the moderator, a routine, search or anything else that reads the chat's items.
- The original chat changes when a fork is made.
- Two replies run at once in one chat because of an edit racing a running reply or a queued task.
- Never add `--dangerously-skip-permissions` or `bypassPermissions` (as everywhere in this app).

## Behavior the user decided

Mockups: `.superpowers/brainstorm/694350-1793384147/content/edit-resend-fork.html` (git-ignored, local only). The user approved them as shown.

1. **Actions on the user's message.** Hovering a user message shows actions to the left of the bubble, in this order from the bubble outward: **Edit**, **Resend**, **Fork**, **Copy**. Agent messages already show react, reply and copy on hover; this adds the same kind of bar to user messages. Touch devices show the bar the way they show it for agent messages today.
2. **Edit.** The bubble turns into a text box in place, with **Cancel** and **Send**. Enter sends, Esc cancels (match the composer's Enter/Shift+Enter behavior). While editing, everything below that message is dimmed, since it moves to the old version on Send. Sending an unchanged text is the same as Resend.
3. **Resend** sends the message's text and attachments again, unchanged.
4. **Running chat.** Edit's Send and Resend work while a reply is running: they stop it first (the same as pressing Stop), then start the new version. The user does not need to press Stop.
5. **Versions.** After Edit or Resend, the user's bubble shows `‹ n / m ›` underneath, always visible once there is more than one version. The new version is the last one and is shown. The arrows switch versions: the user message text, everything after it, and what the agent remembers.
6. **Any user message**, not only the latest. Versioning an earlier message moves everything after it, including later user messages and their own versions, into the old version.
7. **Resend on the agent's answer.** The latest agent answer gets **Resend** in its hover bar, after react, reply and copy. It resends the user message above it. In a group room, "latest answer" means the last agent message of the room.
8. **Fork.** Every message gets **Fork** in its hover bar (agent messages: after Resend or Copy). Fork creates a new chat right away and opens it with the composer focused. Same agent and folder, or for a group room the same members, folder and role.
9. **Group rooms.** Everything above works in group rooms. An edit or resend rewinds every member: their Claude sessions and what they have seen. The moderator then decides who speaks, from that message, as it does for a new user message.
10. **Queued messages are held.** If the chat has messages in the tasks tray when an Edit or Resend stops a reply, none of them start: not when the stop releases the chat (today Stop starts the oldest task right away), and not when the new version finishes. They stay in the tray, held, until the user sends or removes each one. The tray already does this for a paused group room (`TasksTray`'s **Send now**, shown only while the queue holds its tasks). Reuse that for single chats and rooms alike. A routine run waiting as a queued task stays waiting while held. Removing it ends the run as it does today ("Removed from the queue"). The hold ends when the tray is empty. A message the user writes in the composer while tasks are held and the chat is idle goes straight in and the held tasks stay held, the way a paused group room treats it today *(my call: the new message is the user's latest intent)*. Whether the hold survives a server restart is the builder's call, as long as a restart never starts a held task by itself.
11. **Files.** When the version being replaced used tools that changed files, the new version starts with a notice line under the user message, for example "Version 1 edited 3 files. They stay as they are now."

## Constraints

### Rewinding the Claude session

Read from the installed CLI (2.1.299). These flags are hidden (`claude --help` doesn't list them); the Agent SDK uses them:

- `--resume <sessionId> --resume-session-at <assistant message uuid>` resumes the session only up to and including that assistant message.
- `--fork-session` (with `--resume`) writes the continued conversation under a **new** session id, so the original session file stays as it was.
- Every assistant message in the `stream-json` output carries a `uuid` (see `backend/tests/fixtures/stream/*.jsonl`). `streamParser.ts` doesn't read it today.

So a new version of user message M runs with `--resume <session before M> --resume-session-at <last assistant uuid before M> --fork-session`. The old version keeps its session id untouched, which is what switching back restores. If M is the chat's first message, or the agent never answered before M, the new version starts a fresh session (no `--resume`).

**Verified with the real `claude` 2.1.299** on 2026-10-30, in ZumiBot's chat mode (`-p`, stream-json in and out, Haiku). The session had three turns: remember APPLE; remember BANANA with a Bash call; remember CHERRY. Each test then asked "list every word I asked you to remember":

| Run | Expected | Got |
|---|---|---|
| Cut after turn 1, fork | APPLE | APPLE |
| Cut after turn 2 (the one with a tool call; cut at its last assistant message), fork | APPLE, BANANA | APPLE, BANANA |
| No cut, fork (the original is unchanged) | all three | APPLE, BANANA, CHERRY |
| Plain `--resume` of the first fork later | APPLE (the cut persists) | APPLE |
| Turn stopped by SIGTERM mid-tool, then cut at its dangling `tool_use` message, fork | runs | exit 0, APPLE, BANANA |
| Same stopped session, cut before the stopped turn, fork | APPLE | APPLE |
| Cut at an unknown uuid | fails | exit 1, stderr `No message found with message.uuid of: <uuid>` |

Every fork got a new session id. The original session file never received the forked runs' messages. The `uuid` on each `stream-json` assistant line is the one `--resume-session-at` accepts. A turn has several assistant messages (tool use, thinking, text): cut at the **last** one. The spike scripts are in this session's scratchpad and not kept. The e2e test below replaces them.

The CLI's own (hidden) help says `--resume-session-at` takes "any chain-entry UUID, typically the kept turn's last entry". So the cut point to record is the uuid of the **last chain entry** the turn wrote, whatever its type. For a finished turn that's its final assistant message. For a turn stopped mid-tool it may be a `tool_use` or a tool result. Each content block streams as its own assistant event with its own uuid. A Fork on an agent text bubble cuts at that bubble's own uuid. There is also a hidden `--resume-drops-turn <prompt uuid>` that refuses a cut whose dropped range holds anything not from the named turn. Using it as an extra guard is the builder's call.

**Messages with no recorded cut point** (my call). Recording starts when this ships. That leaves no cut point for messages sent before it, for the first message sent after it (the turn before it wasn't recorded), and for chats synced from a machine that hasn't been upgraded. Edit, Resend and Fork stay available on those messages. The run starts a **fresh session seeded from the visible items before the cut**, through the existing seed path (`seedPrompt.ts`, `SEED_MAX_CHARS`), and shows the existing `expired` notice so the user knows the agent got a summary, not its full memory. Hidden versions are never part of a seed. Group rooms do the same per member who has no cut point. Reading Claude's session files to back-fill old cut points is not required.

**A session that is gone** (my call). Claude Code deletes session files after `cleanupPeriodDays` (default 30), and a file can be missing on this machine. Switching back to an old version, or cutting a session whose file is gone, uses the same seeded fallback with the `expired` notice. The agent then remembers that version's visible history, never a hidden one. This matches what the app already does when a session expires. It is a fallback for a session that's missing. A CLI that rejects the flags is a different case and still fails loudly (below). To tell the two apart, check whether the session file exists before running, or classify the error text. That's the builder's call, and tests must cover both.

**These flags are hidden and could change in any CLI update, so the app must notice when they break:**

- **Loud failure, never a silent fallback.** A non-zero exit or the "No message found" error becomes a visible error item, and the version is kept as failed. It never retries with a plain `--resume`, because that would break the main anti-goal.
- **Runtime check.** After a forked run's `init` event, the new session id must differ from the one resumed. If it is the same, `--fork-session` was ignored, and the original version's session may have been written to. Stop the run and show an error item that names the problem and the CLI version.
- **A real-CLI e2e check**, added to the existing `npm run e2e` suite (which already drives the real `claude`): the same APPLE/BANANA/CHERRY pattern through ZumiBot itself, one edit and one switch back, asserting what the agent remembers. Run it after every Claude Code update. CLAUDE.md should say so.

### Group rooms

`GroupInfo` holds per member a session id (`sessions`) and the id of the last item they have seen (`seen`). `groupPrompts.ts` builds each member's prompt from the items since `seen`. A version must restore, for **every** member, the session and the cut point as they were just before M, plus `seen`. Members who had no session before M start fresh. The queue (`queue`) and active turns are emptied by the stop, as Stop does today. The hop counter resets, as it does for a new user message.

A member's cut point is their own last assistant message before M, which may be several turns back. Group sends never go through `ChatService.send` (see CLAUDE.md); the rewind for rooms lives in `GroupService`.

### Fork

- **Fork on an agent message**: the new chat has every visible item up to and including that message. Each agent session is cut at that message (single chat: the chat's agent; group: every member at their own last assistant message at or before it), with `--fork-session` so the original chat's sessions are never written to.
- **Fork on a user message**: the new chat has every visible item **before** that message, and the message's text and attachments are put into the new chat's composer, ready to edit and send. *(My call, see below.)*
- Only the visible items are copied, not hidden versions.
- The new chat's title is "Fork of <original title>".
- Attachments are copied or shared so that deleting either chat never breaks the other one's files.
- The fork's remembered "Allow for this chat" approvals start empty, like any new chat.

### Storage and the rest of the server

- Chat item files (`chats/<id>.json`) are a flat item list, and `itemsFeed`, paging, `sync.mjs` and many readers assume that. Keeping the **visible** version as that flat list and the hidden versions somewhere else is my suggestion, not a requirement. Whatever the shape: switching versions must call `feed.reset()` (or push a full reload) so every tab redraws.
- `ChatStore.renameAgent` rewrites items for an agent rename. It must rewrite hidden versions too. Same for anything else that rewrites stored items.
- `recoverInterrupted` at server start must leave versions intact. A chat interrupted while its new version was running keeps both versions.
- **Sync** (`deploy/sync.mjs`, `mergeItems`) joins item lists by shared start. A chat whose visible version was switched on one machine must not turn into a "forked" join that shows the hidden version's items twice. Sync must carry hidden versions both ways and never drop one. If a chat's versions changed on both machines, keeping every version from both sides is acceptable. Losing one is not.
- `recoverInterrupted`, `sync.mjs`, `itemsFeed` and `groupPrompts.ts` each need a test that covers versions.

### Files notice

Count the replaced version's successful `Edit`, `Write`, `MultiEdit` and `NotebookEdit` calls by file path. If it also ran `Bash` commands, say so too, since those may have changed files that can't be counted. For example: "Version 1 edited 3 files and ran 2 commands. Nothing was undone." No notice when neither appears. The notice is a `notice` item (a new `NoticeKind`) and must not be sent to group members or the moderator as part of the thread.

## Shape of the change

- **Shared types.** A way to mark a user item as having versions (count and current index) so the UI can draw the arrows. A new `NoticeKind` for the files notice. New `ZumiBotApi` methods, for example `chats:edit(chatId, itemId, text)`, `chats:resend(chatId, itemId)`, `chats:switchVersion(chatId, itemId, index)`, `chats:fork(chatId, itemId) → ChatMeta`. Each touches the three places listed in CLAUDE.md.
- **Server.** `streamParser.ts` reads assistant `uuid`s. The chat remembers, per agent session, the uuid each user message was sent after, so a cut point can be found without reading Claude's session files. `claudeRunner.ts` `buildArgs` gains the resume-at and fork flags. `ChatService` and `GroupService` each get edit, resend and switch. Fork creates the new chat through `ChatStore`.
- **Frontend.** A hover bar for user messages (reuse `MessageActions`), the in-place editor, the version arrows, and Resend/Fork on agent messages. Any logic beyond wiring (which actions a message gets, which message Resend on an agent answer targets, the dimmed range while editing) goes in a pure module under `src/state/` with unit tests, since there are no component tests.
- **E2E.** Extend an existing suite using the fake claude where possible (`e2e:routines` shows how to script it). Edit, resend, switch back and fork in a single chat and a group room, after a reload, and in a second tab.

## Left to the builder (my calls, not the user's)

- **No recorded cut point, or the session file is gone:** a fresh session seeded from the visible items before the cut, with the `expired` notice (see Constraints). Under this fallback, "switching back remembers the old version" holds only as a summary. The e2e tests assert exact memory for chats recorded after this ships.
- **Fork on a user message** copies the chat up to just before it and puts the message in the composer, instead of copying the message without an answer. A user message the agent never saw, sitting at the end of a chat, would look like it had been sent. The user approved a mockup that said "up to and including that message" for every message; this refines it for user messages only. Flag it when handing over.
- **Version storage shape**, as long as the constraints above hold.
- **Switching versions while a reply runs** is refused ("Chat is busy"), and the arrows are disabled while the chat runs. The running reply belongs to the version on screen.
- **Sync when versions changed on both machines:** the newer side's chat wins as it is. If the older side holds any item the newer side has nowhere (visible or hidden), the older side's whole chat is also kept as a separate chat titled "<title> (copy from this PC)" or "(copy from the VPS)", with its attachments. Nothing is lost, and the rare conflict shows up as two chats instead of a silent merge.
- **Where the agent's memory point comes from:** each turn stamps the last item it leaves with its session and last chain-entry uuid (and, in a room, the member's `seen`). Each agent message also records its own uuid. The start point for an edit, resend, switch or fork is read from those stamps in the visible items. A version's memory is then exactly what is on screen, with no separate per-version state to keep in step.
- **Copy** on user messages: the user approved the bar as Edit, Resend, Fork, Copy. Copy works like the agent message's Copy.
- The exact wording of the files notice and the fork title.
- Where the version arrows sit on narrow (phone) layouts, as long as they stay visible.
- Whether the edit box grows with the text (it should not exceed the composer's max height).
