# Agent commands (`/` menu)

## Intent

Some agents do several distinct jobs. Workiom Master routes to eight skills (check a card for a release, check an Upgrade Backlog card, fix a bug, implement a task, …). Today the user types the job in words, "Check this card <link>" or "Check this upgrade card <link>", and the real problem is memory: the user forgets what each agent can do.

So each agent gets a short list of commands the user writes once: a name (`check`), a one-line description, and a prompt. Typing `/` at the start of the composer opens a menu of the chat's commands. Picking one inserts `/check `, the user types the rest (usually a card link) and sends. The chat shows the short form the user typed; the agent reads the command's prompt with that text filled in.

Zumi Bot writes a guessed set of commands into every agent it creates, and can add or change commands on existing agents when asked.

## Goals

- Per-agent commands, stored in the agent's own `.md` file, editable in the agent editor and by Zumi Bot.
- A `/` menu in the composer of single chats, group rooms and the new-chat screen, listing the chat's commands with their descriptions.
- On send, the agent reads the command's prompt with the user's text filled in. The chat shows the short form, with a collapsed "Full prompt" toggle that reveals what the agent read.
- In a group room the menu lists every member's commands, grouped by agent. Picking one addresses that agent exactly as an `@mention` of it would.
- Zumi Bot writes commands for every agent it creates, can edit commands on existing agents, and has commands of its own.

## Non-goals

- Routines using commands in their prompts. (Added later, on 2026-11-04: see Agent commands in `CLAUDE.md`.)
- Commands shared by several agents, or a global command list.
- Commands generated from installed skills or plugins.
- Reordering commands by drag in the editor (file order is menu order).

## Anti-goals

- A `/word` that matches no command must behave exactly as today: sent as plain text, unchanged. Old messages that start with `/` must render exactly as today.
- An agent file with a broken or odd `commands` field must still load and run. Bad commands are skipped, never the agent.
- The prompt must never be shown expanded by default. It stays behind the collapsed toggle.
- Nothing about the Claude CLI's own slash-command handling changes. ZumiBot only decides what text it sends.

## Decided with the user

- The user writes each agent's command list; ZumiBot does not derive it from the agent's skills.
- Zumi Bot writes guessed commands into every new agent it creates.
- The agent reads the command's prompt, not the short form.
- Group rooms show all members' commands. Picking one works like `@mentioning` that agent: it reads the full prompt; the other members and the moderator see only the short form.
- Routing in a room is **exactly today's `@mention` path, unchanged** (asked after the review, user picked this over "others wait for the owner" and "owner only"). So the owner is guaranteed a turn, but not first place: the moderator may start other members alongside it (its default is "members start together"), or Jev's fast path may add one. Build nothing extra to serialize or block other members.
- Menu rows are two lines: `/name` on the first, the description under it. In a group room, each agent's commands sit under a header of that agent's face and display name (mockup: `.superpowers/brainstorm/*/content/commands-group-v2.html`).
- A sent command shows as a chip in the agent's color at the start of the bubble. Under the bubble a small "▸ Full prompt" toggle, collapsed by default, opens a box with the exact text the agent read. Clicking the toggle or the chip opens and closes it. It always starts collapsed (mockup: `commands-sent-v2.html`).
- In a group room the chip also carries the agent's face.
- New "Commands" card in the agent editor: each row has name, description and prompt; "+ Add command" at the bottom (mockup: `commands-menu.html`, bottom right).

## Storage: the agent file

A new optional frontmatter key, `commands`, a YAML list in file order:

```yaml
---
name: workiom-master
description: …
color: orange
icon: triangles
commands:
  - name: check
    description: Check a built card and add it to a release
    prompt: Use the workiom-check-card skill on $ARGUMENTS
  - name: upgrade-check
    description: Check an Upgrade Backlog card and merge it into upgrade/angular-22-fast
    prompt: Use the workiom-upgrade-check-card skill on $ARGUMENTS
---
```

Why the agent file (my call, the user agreed): Zumi Bot already writes agent files, the editor already edits them, and PC/VPS sync already carries `~/.claude/agents` with no extra work.

**Checked with CLI 2.1.299 (2026-11-01):** `claude -p --agent cmd-test` on an agent file with a two-item `commands` list (plus `model: haiku`) loaded the agent and followed its prompt. The CLI already tolerated ZumiBot's scalar `icon` key; the nested list is fine too. Re-check after CLI updates the same way; if a later CLI rejects it, stop and come back: the fallback is a sidecar file, which changes sync and Zumi Bot.

Rules, applied by one shared parser in `shared/` (used by the server, the editor and the menu):

- `name`: same pattern as agent names (`NAME_PATTERN`: lowercase letters, digits, single hyphens). Unique within one agent.
- `description`: one line, required.
- `prompt`: required, any text. Every `$ARGUMENTS` in it is replaced by the user's text after the command. With no `$ARGUMENTS`, the user's text is appended after a blank line (my call); with no text typed, the prompt is sent as is.
- A command that breaks a rule (missing field, bad name, a later duplicate) is skipped, and the editor shows why. A `commands` value that is not a list counts as no commands. The agent always loads (see Anti-goals).
- YAML that does not parse at all is out of scope for that rule (my call): it stays a broken agent file exactly as today (`parseAgent` returns the error, the sidebar shows it), since the CLI reads the same file and ZumiBot cannot make it tolerate bad YAML. To keep that rare, the editor writes `commands` through the `yaml` library (always valid), and Zumi Bot is told to write every `prompt` as a block scalar (`prompt: |`).
- Cap the prompt length (builder picks a value, for example 8000 chars) and treat a longer one as invalid.

`AgentFields` and `serializeAgent` gain `commands`. Keep `serializeAgent`'s current behavior: frontmatter left verbatim when nothing in it changed; otherwise only changed keys are rewritten, and an empty list removes the key. `AgentSummary` gains `commands: { name, description }[]` (valid ones only, file order), so the menu needs no extra call. The prompt does not need to go to the client for the menu.

## Composer: the `/` menu

Builds on the existing `@mention` menu in `Composer.tsx` (same keys, same pure-helper split as `state/mentionInput.ts`, so the matching logic is unit-testable).

- Opens only when `/` is the first character of the message (my call), outside a code block. The query is the `[a-z0-9-]*` after it. Typing a space or anything else ends the query and closes the menu.
- Filters by command name prefix first, then by description words containing the query (my call). Nothing matches → no menu, and the text is sent as typed.
- ↑↓ move, Enter or Tab pick, Esc closes (stays closed for that `/` like the mention menu's `closedAt`). Mouse and touch pick on click. Same on phone layout.
- Picking replaces `/query` with `/name ` and leaves the caret after the space.
- Single chat (and the new-chat screen for the selected agent): rows only, no header.
- Group room: one header per member that has matching commands (face + display name), its rows under it, members in room order. Two members may both have `/check`; both show.
- While typing, a leading `/name` that matches a command is tinted in its agent's color (my call, like `MentionHighlight`).
- The menu scrolls past a max height; the existing mention-menu sizing rules apply.

**The pick travels with the send.** Typed text alone cannot say which member's `/check` it is, so the composer remembers the picked `{ agent, name }` and sends it with the message (an optional extra argument on `chats:send`; touches `ZumiBotApi` in `shared/src/types.ts`, the handler in `rpc/handlers.ts` and `frontend/src/net/api.ts`). The pick is dropped if the user edits the leading `/name` so it no longer matches.

Without a pick (typed by hand, or recalled from history), the server resolves by name: in a single chat, the chat's agent; in a room, the one member that owns that name. If several members own it, the send is refused with a visible error naming them and asking to pick from the menu (my call). If none does, it is plain text (Anti-goals).

## Sending and storage of the message

Resolved on the server when the user sends, from the agent file as it is at that moment, and saved on the user item, so a message waiting in the tray keeps the prompt it had when sent (my call). The lookup lives on the user's paths only (`chats:send`, and Edit/Resend), which hand the resolved command to `TaskQueue`; it must not live inside `TaskQueue.submit` itself, because routines also send through `submit` (`routineRunner.ts`) and routine prompts stay as they are (Non-goals). A routine prompt that starts with `/` is sent as plain text, as today.

```ts
{ type: 'user', id, text, ts, …, command?: { agent: string; name: string; prompt: string } }
```

- `text` stays exactly what the user typed (`/check <link>`). It is what the bubble shows, what the moderator reads, what other room members read, and what Up-arrow history recalls.
- `command.prompt` is the full text the agent read, `$ARGUMENTS` already filled in. The "Full prompt" box shows it.
- What the agent reads follows the existing reply-quote pattern (`reply.ts`: `withReply` / `withReplies`): one helper turns a user item into "the text as this agent reads it", that is `command.prompt` when the reader is `command.agent`, else `text`. Use it wherever the agent's input is built today: the turn message in `ChatService` (next to `withReply`), the seed history (`buildSeedPrompt` inputs), and in rooms `threadEntries` / `seedHistory` for each member (only `command.agent` reads the prompt). A reply quote and attachments still go with a command message as they do with any other.
- In a room, `command.agent` counts as mentioned by the user for routing: add it to the `mentioned` list `GroupService` already builds from `findMentions`, and change nothing else in `planQueue`, the moderator or Jev. Other mentions in the text work as today.
- Messages without `command` behave and render exactly as today.

**Edit, Resend, Fork, versions** (all my calls):

- Edit opens the short form. Saving re-resolves it like a fresh send (keeping the original pick's agent in a room if the edited text still starts with that command).
- Resend re-resolves with the command's *current* prompt. If the command no longer exists, it resends the saved `command.prompt`, so nothing is lost.
- Each version keeps its own `command`. Fork copies it with the items. `sync.mjs` needs no change (it is a field on an item).
- Renaming an agent rewrites `command.agent` in stored items along with the other stored references the rename already moves (`agents:save` / `agentsSync.ts`), then `feed.reset()`.

## Rendering a sent command

In `UserText.tsx` (or next to it): a user item with `command` whose `text` starts with `/<name>` renders that prefix as a chip in the agent's color, styled like `.mention`; in a room it also shows the agent's face. If the agent or the command is gone now, the chip turns grey (like `.mention.broken`) and the toggle still works, since the prompt is stored. Under the bubble, "▸ Full prompt" toggles the stored `command.prompt` in a small box, collapsed on every render. Light and dark themes, phone width, existing tokens.

## Agent editor: Commands card

A new card in `AgentForm.tsx`, after the existing cards (placement is the builder's call). One row per command: name (monospace), description, prompt (multi-line). "+ Add command" at the bottom, a remove button per row. Validation messages follow the form's current pattern (hidden until touched). A hint under the card says `$ARGUMENTS` marks where your text goes. Saving goes through the existing `agents:save` path.

## Zumi Bot

Update `zumiBotContent` in `core/agents/zumiBot.ts`:

- Document `commands` in "Agent file format", with the rules above.
- "Creating an agent": every new agent gets commands for its main jobs (a handful; Zumi Bot judges how many), each with a short description and a prompt that uses `$ARGUMENTS` where the user's text goes. Tell the user which commands it added.
- "Editing an agent": it can add, change or remove commands when asked.
- Zumi Bot's own file gets commands (my call, the user approved): `/new-agent` (create an agent from a description), `/edit-agent` (change an agent), `/suggest-commands <agent>` (read that agent, propose commands for its jobs, ask before writing them). The last one is how Workiom Master gets its commands without hand-typing them.

## Testing

- `shared`: the commands parser (valid, skipped-with-reason, duplicates, non-list, length cap), `$ARGUMENTS` filling and the append rule, `serializeAgent` round-trips (verbatim when unchanged, key removed when emptied).
- `frontend` `state/`: the `/` query, filtering order, room grouping, pick-dropping on edit.
- `backend`: a user send resolves and stores `command`, a routine send does not; the single-chat turn text and seed use the prompt; in a room only `command.agent` reads the prompt, the others and the moderator read `text`; the owner is routed as mentioned; an ambiguous unpicked name is refused; unknown `/word` is unchanged; resend falls back to the saved prompt when the command is gone; an agent rename moves `command.agent`.
- e2e with the fake claude: open the menu, pick, send, check the bubble chip and the toggle, and check what the fake claude received.
- The real-CLI check from "Storage" passed on 2.1.299; repeat it if the CLI has been updated before the build starts.
