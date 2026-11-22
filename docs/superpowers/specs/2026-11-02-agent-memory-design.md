# Agent memory: design

Date: 2026-11-02. Built from the user's request ("In OpenBot each agent has its own list of memories (saved automatically or by hand) that you can review, edit, search and cap. ZumiBot doesn't show memory anywhere.") and a short talk. The user handed the approach to me ("do what you think better") and then approved the played-back description; what the user decided is marked **(user)**, everything else is my call and can be changed.

## Why

Agents forget everything between chats unless the user repeats it. Claude Code already has a per-agent memory, but nothing in ZumiBot turns it on, shows it or lets the user correct it, so today no agent has one (`~/.claude/agent-memory/` did not exist on this PC). The user wants what OpenBot offers: each agent keeps its own list of memories, saved by the agent on its own or by hand, which the user can review, edit, search and cap.

## What was checked first

- **OpenBot** (`github.com/nightly-labs/openbot`, read, not run). One memory is a text of up to 500 chars with `origin` (automatic/manual) and dates, in SQLite keyed by agent. Two kinds: *essential* (injected into every prompt, 8 KB budget) and *searchable* (found with a `search_memories` tool). The agent saves through its own tools (`remember`, `forget_memory`, `search_memories`, `list_memories`, `set_memory_inclusion`); changes commit only when the turn completes. A background "memory review" (every 20 turns or after 15 min idle, one cheap tool-less model call) adds/updates/forgets from the chat, never touching user-written or user-pinned memories. Cap: "Memories per agent", 64/128/256/512, default 256; at the cap a save is refused, nothing is evicted, the agent is told to merge. UI: Agent settings › Memories, two groups ("Always used", "Used when relevant"), search box, New memory, Clear all, a detail page with Edit, "Use in every chat" switch and Delete with an 8 s undo. After a turn the chat shows "Memory: 1 saved, 0 updated, 0 forgotten".
- **Claude Code's own agent memory** (docs at `code.claude.com/docs/en/sub-agents` and `/memory`). An agent file with `memory: user | project | local` gets a memory directory: `user` → `~/.claude/agent-memory/<agent>/`, `project` → `<cwd>/.claude/agent-memory/<agent>/`, `local` → `<cwd>/.claude/agent-memory-local/<agent>/`. The first 200 lines or 25 KB of `MEMORY.md` go into the agent's system prompt; Read/Write/Edit are enabled for it. It is part of auto memory: `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY` turns it off. The CLI (2.1.299) honours `CLAUDE_CONFIG_DIR` for the root and replaces `[^a-zA-Z0-9\-_]` in the agent name with `-` (no effect on names `NAME_PATTERN` allows).
- **Live checks with the real CLI 2.1.299** (throwaway agents, cleaned up after):
  - `claude -p --agent <probe>` with `memory: user`: the system prompt carries the memory instructions; the agent wrote `user_favourite_colour.md` and a `MEMORY.md` line; no permission denials. A fresh session answered "Teal" without any tool call, so `MEMORY.md` is in the prompt. **So `memory:` works under `--agent` as the main thread.**
  - The same through ZumiBot's exact flags (`--permission-mode auto --permission-prompt-tool stdio`, stream-json, Haiku): two `Write`s into the memory dir, **no `can_use_tool` request**, result success. So the agent's memory writes never become approval cards.
  - The format the CLI tells the agent to use, quoted from its system prompt: one file per memory with frontmatter `name` (kebab-case slug), `description` (one line), `metadata: { type: user | feedback | project | reference }` and a body ("for feedback/project types: rule/fact, then **Why:** and **How to apply:** lines", `[[name]]` links allowed); then one line in `MEMORY.md`, `- [Title](file.md) — one-line hook`, under ~150 chars, no frontmatter, "lines after 200 will be truncated". Third-party write-ups show plain `type:` in the frontmatter too, so a reader must accept both.
- **ZumiBot code** (worktree at `023ea37`):
  - Every turn is `claude -p --agent <name> … --append-system-prompt <…> --system-prompt-snapshot off` (`claudeRunner.ts` `buildArgs`); the appended prompt is rebuilt each turn in `chatService.ts` `agentTurn` (house style, group briefing, browser prompt).
  - `serializeAgent` (`shared/src/frontmatter.ts`) edits a `YAML.Document` of the original header and keeps unknown keys, so a `memory:` line written by hand already survives saves. `AgentFields` has no memory field.
  - Rename: `agents:save` (`rpc/handlers.ts`) moves approvals before any await, because the agents-folder watcher's removal pass (`agentsSync.ts` `detectRemovals` → `app.ts`) would otherwise drop them; renames from outside the app go through `app.ts` (the `sync.changed` rename branch). Delete: `agents:trash` → `AgentStore.trash` → `core/trash.ts` (folders work).
  - `streamParser.ts` emits `toolUse {id, name, input}` and `toolResult {toolUseId, content, isError}`; `agentTurn` turns them into `tool` items. Single chats have no per-turn id, so anything counted per turn is counted in `agentTurn`'s closure.
  - `deploy/sync.mjs` syncs only `agents`, `skills`, `projects` and `file-history` under `~/.claude` (`CLAUDE_DIRS`). **`agent-memory/` is not synced today.**
  - Zumi Bot's own file is rewritten by `ensureZumiBot` whenever it differs, so it cannot keep a `memory:` line.
  - Nothing reads `~/.claude/settings.json` except sync's md5 compare. The run env is the server's env (minus a few ZumiBot vars), so `CLAUDE_CODE_DISABLE_AUTO_MEMORY` set on the server reaches the CLI.

## Goals

1. **Each agent can have its own memory, built on Claude Code's agent memory (`memory: user`), not a ZumiBot store** (approved in playback). The same memory works when the agent runs in the terminal.
2. **Saved automatically:** the agent saves on its own judgment, as Claude Code already instructs it, with no approval card (approved in playback).
3. **Saved by hand:** the user adds, edits and deletes memories in ZumiBot, which keeps `MEMORY.md` in step (approved in playback).
4. **Review and search** each agent's memories in Agent Studio (approved in playback).
5. **A cap per agent** that the UI and the agent both respect (approved in playback).
6. **The chat shows when a reply touched memory:** "Memory: 1 saved, 1 updated · View" under the reply (approved in playback; mockup shown).
7. **Memory follows the agent:** a rename moves it, a delete moves it to the Trash, and `npm run sync` / the desktop Sync carries it between PC and VPS.
8. **The UI says plainly when memory can't work** (Claude Code's auto memory turned off).

## Non-goals

- OpenBot's background "memory review" pass. It can be added later as a cheap moderator-style call; v1 relies on the agent saving on its own.
- OpenBot's "Always used / Used when relevant" split. Claude Code already has it in another form: the `MEMORY.md` index is always in the prompt, the files are read when relevant.
- Managing `memory: project` or `memory: local`. Their folders depend on each chat's working folder, so one agent can have many. ZumiBot shows a notice for them (see "Other scopes"), no list.
- A hard cap. The CLI allows the agent's memory writes without asking, so ZumiBot cannot refuse one; the cap is enforced by instruction and by the UI.
- Revision history of a memory, "Clear all", an undo toast, pinning.
- Rewinding memory on Edit, Resend, version switch or Fork. Memory lives outside the session; a memory saved in an old version stays.
- Memory for Zumi Bot.
- A ZumiBot search tool for the agent. The agent already reads its own files.
- Showing memory in the Usage page or notifications.

## Anti-goals

- **ZumiBot deleting or evicting a memory on its own.** Only the user (Delete in the UI) or the agent removes one. Lowering the cap deletes nothing.
- **Breaking the terminal.** Files stay in exactly the format Claude Code writes, so `claude --agent <name>` in a terminal keeps reading them.
- **Writing outside `<memory root>/<agent>/`,** or following a file name the UI or a client sent without checking it.
- **Memory text in logs, error messages, notifications or the appended system prompt.** The appended prompt carries counts only; the agent reads the text from its own prompt as Claude Code puts it there.
- **Approval cards for the agent's own memory writes** (there are none today; nothing here may add any).

## Decided with the user

- Build on Claude Code's own agent memory files rather than a ZumiBot store (the user said "do what you think better"; the playback below was **approved**).
- The played-back description, **approved as a whole**: memory on/off per agent writing `memory: user`; the agent saves on its own with no approval; hand add/edit/delete keeping `MEMORY.md` in step; a searchable list per agent; a per-agent cap enforced by instruction plus the UI hiding "New memory"; the chat line after a reply; rename moves, delete trashes; a notice when auto memory is off; work on a new worktree.
- **Layout A** from the mockups: a "Memory" section in the Agent Studio page under the form (above Remembered approvals), rows grouped by type, a row opens an inline editor in place. Not a separate tab.
- **On its own worktree** (`.claude/worktrees/agent-memory`, branch `agent-memory`, from `master` at `023ea37`).

Correction made during the talk: I first said `npm run sync` already carries this memory; it doesn't (`CLAUDE_DIRS`), so goal 7 adds it.

## Where memory lives

- **Memory root:** `<CLAUDE_CONFIG_DIR or $HOME/.claude>/agent-memory`, the same rule the CLI uses (read `CLAUDE_CONFIG_DIR` the way `core/claudeAccount.ts` does). One folder per agent: `<root>/<agent name>/`. No separate ZumiBot env var: tests that need isolation already run the fake claude with `HOME=root/home` (`e2e/harness.mjs`).
- **A memory** is a top-level `*.md` file in that folder other than `MEMORY.md`. Subfolders and other files are ignored (left alone, never deleted).
- **Reading one** (pure, in `shared/src/memory.ts`): frontmatter through the existing YAML handling; `name`, `description`, type from `metadata.type` or else `type`; a type outside the four becomes `null` ("Other"). A file with no or broken frontmatter is still a memory: name = file stem, description empty, type `null`, body = the whole file. Never fails the list.
- **`MEMORY.md`** is the index, not a memory. Its lines matching `- [Title](file.md) — hook` (hook optional, dash `—` or `-`) give each file a **title** and an **index line number**; a file with no line gets its `name` as title.
- **Writing a new one** (by hand): frontmatter in the format the CLI currently asks for, `name`, `description`, `metadata:\n  type:`, then the body. Written with `writeFileAtomic` (`core/fsutil.ts`), mode left to the default.
- **Updating an existing one** edits its frontmatter as a `YAML.Document`, the way `serializeAgent` does for agent files: only `name`/`description`/the type key that was there (`metadata.type` or `type`) change, **unknown keys and a non-standard type value are kept** unless the user picks another type. A file with no frontmatter gets one added on its first hand edit. (My call, from the builder check: the CLI may add keys later.)

```markdown
---
name: never-commit-without-asking
description: Commit only when told, even if a skill suggests it
metadata:
  type: feedback
---

Never run git commit unless the user says so.
**Why:** they review every diff first.
```

## Memory on and off (agent fields)

- `AgentFields` gains `memory: string | null` (the raw scope; the switch writes `'user'`, off deletes the key) and `memoryLimit: number | null` (ZumiBot's own key, like `icon`; Claude Code ignores unknown keys). Wire both through `fieldsOf`, the "nothing changed" check and the null-means-delete list in `serializeAgent`, with tests next to the `unknown-keys` ones.
- The **switch and the limit edit the agent like any other field**: they go through the editor state (`editFields`), mark the editor "unsaved" and are written by **Save Changes**. This keeps one way to change the agent file and avoids the "changed on disk" note. The memory list itself works live (see below). If the raw text does not parse, both are disabled, like the Form button.
- **Limit choices:** 25, 50, 100, 150; default 100 (no key = 100). Reason for the top: each index line is up to ~150 chars and only 200 lines / 25 KB of `MEMORY.md` reach the agent, so 150 entries keep the index inside what the agent sees.
- **Zumi Bot:** no switch, no limit, no Memory section (its file is rewritten by the server).

## Other scopes

An agent whose file says `memory: project` or `memory: local` (written by hand) shows the Memory section with the switch on and a notice instead of the list: "This agent keeps a separate memory in each project folder (`memory: project`). ZumiBot shows only memory kept for all projects." The switch turning it off deletes the key as usual; turning it back on writes `user`. Rename and delete (below) only handle the user-scope folder.

## The Memory section (Agent Studio, layout A)

Shown for a saved agent (same condition as Remembered approvals: `filePath` and saved name exist), placed between the form/raw editor and Remembered approvals, in both Form and Raw mode. A `.card`-style section, phone width included (16 px gutters, no horizontal scroll).

- **Head:** title "Memory", the count "12 of 100", a "New memory" button, the on/off switch (`role="switch"`, like the routine editor's), and the limit as a small select ("Limit 100"). The count and list come from disk (the saved state); the switch and limit show the editor's current value.
- **When the saved agent has memory off:** one hint line, "Off. Turn it on and Save Changes to let this agent remember things between chats." If memories exist on disk anyway (turned off later, or written in the terminal), the list still shows, with "Memory is off: the agent neither reads nor saves these."
- **Auto memory off:** a warning line "Claude Code's auto memory is off, so this agent can't read or save memories. Turn it on with /memory in Claude Code." Detected when the server's env has `CLAUDE_CODE_DISABLE_AUTO_MEMORY` set to a truthy value, or `<config dir>/settings.json` has `autoMemoryEnabled: false`. (Project-level settings in a chat's folder are not checked.)
- **Search:** a search field like the routines sidebar's (`.search`, clear button). Case-insensitive; a memory matches when every word appears in its title, description, name or body. Pure function in `frontend/src/state/memory.ts`.
- **List:** grouped User, Feedback, Project, Reference, Other (empty groups hidden), newest change first within a group. Each row: title, description (one line, ellipsis), and a small "not seen by the agent" mark when its `MEMORY.md` line is past line 200 (the CLI truncates there). Rows are plain text (no markdown rendering). (My call, from the builder check: since listing repairs the index first, a "not in index" mark would never show; the line-200 mark is the one that tells the user something.)
- **Opening a row** turns it into the inline editor in place: Title, Description, Type (the four, plus the file's own value if it is something else, shown as is), Text (textarea), "Changed <date>" from the file's mtime, and Delete · Cancel · Save. One row open at a time. While the open row has unsaved changes, other rows don't open and New memory is disabled until Save or Cancel; an untouched open row closes when another opens. Searching never closes it.
- **New memory** opens the same editor at the top of the list (type defaults to User). Hidden when the count is at or over the limit, with "This agent has reached its limit of 100 memories. Edit, merge or delete one before adding another." Over the limit (the agent kept writing, or the limit was lowered) the count shows in the warning color.
- **Delete** asks with `ConfirmDialog` ("Move this memory to Trash?" / "You can restore it from the Trash."), then moves the file to the freedesktop Trash with `trashPath` and removes its `MEMORY.md` line.
- **Empty and error states** follow `RememberedApprovals.tsx` (load failure line, a stale-list line when a refresh fails, the `latest`/`alive` refs so an older answer never overwrites a newer one).
- **Index over 200 lines:** "Only the first 200 lines of MEMORY.md reach the agent." (Can only happen through the terminal or the agent ignoring the cap.)

## Saving by hand (server)

- **Create:** file name `<type>_<slug>.md` (type `other` when none), slug from the title: lowercase ASCII letters, digits and `_`, at most 48 chars, `memory` if empty; on a clash add `_2`, `_3`… `name:` gets the kebab-case form of the same slug. Then append `- [Title](file) — description` to `MEMORY.md` (create it if missing; keep a trailing newline).
- **Update:** the file name and `name:` never change (other memories may link `[[name]]`). Rewrite frontmatter and body; then replace the index line that points to this file, or append one if there is none. Other lines of `MEMORY.md` are kept byte for byte.
- **Delete:** see above. The index line pointing to the file is removed; nothing else in `MEMORY.md` changes.
- **Limits on input** (checked in the handler, like every RPC arg): title 1–100 chars, one line; description 0–150 chars, one line; body 1–8000 chars; type one of the four or null. `[`, `]`, `(`, `)` in the title are allowed but escaped in the index line so the link still parses. Creating at or over the limit is refused with a plain error (the UI hides the button anyway).
- **Conflict check:** save and delete take the `modified` time the UI loaded; if the file changed since (the agent rewrote it meanwhile), refuse with "This memory changed since you opened it." and the UI reloads the list keeping the open editor's text so nothing typed is lost.
- **Safety:** agent name must match `NAME_PATTERN` and be a known agent. A file name sent by the client must be a plain base name: ends in `.md`, no `/` or `\`, no NUL, does not start with `.`, is not `MEMORY.md`, at most 200 chars, and must be a file the list would show (top-level, regular file, not a symlink). Every path goes through `assertInside(<root>/<agent>)`. So files the agent or the terminal named differently (`User_Role.md`) are editable and deletable too; only names ZumiBot *creates* follow the `<type>_<slug>.md` rule. (My call, from the builder check.)

## Keeping the index whole

Files can reach the folder without an index line: the agent forgets the second step, a hand edit in the terminal, `sync` bringing a file from the other machine while each side's `MEMORY.md` is newest-wins as a whole, or a late-file move after a rename (below). So ZumiBot **adds a missing index line** (built from the file's `name` and `description`) for every memory file that has none, at two points: when it lists an agent's memories (repair first, then build the list), and just before a turn of a memory-enabled agent starts. It never removes a line, even one pointing to a missing file (a turn may be mid-write).

## The cap, told to the agent

When the agent's memory is on (`user` scope) and auto memory is not off, `agentTurn` appends one more block to the appended system prompt (next to house style; skipped for `/compact` turns):

- Under the limit: `Agent memory: you have 12 of at most 100 memories.`
- At or over: `Agent memory is full (100 of 100). Do not add a new memory file. To save something new, update a related memory with the combined text, or merge two related memories into one and delete the other. Never delete a memory that is still true only to make room. If nothing can be merged, tell the user that memory is full.`

Counts only, no memory text. Because the appended prompt is rebuilt each turn with `--system-prompt-snapshot off`, a changed count reaches the next turn of a resumed session.

## The chat line

- **Counting, in `agentTurn`'s closure:** a `toolUse` for `Write`, `Edit` or `MultiEdit` whose `input.file_path` resolves inside `<root>/<the agent name this CLI was started with>/` (not a name the agent got by a rename mid-turn) and is not `MEMORY.md`, confirmed by its `toolResult` with `isError` false. A `Write` to a file that did not exist when the `toolUse` arrived counts as **saved**; everything else as **updated**. (The builder may instead read "File created successfully" from the result if that proves more reliable; either way one file counts once per turn, as saved if it was ever new in the turn.) Deletions (the agent using `rm`) are not counted.
- **Stored** on the turn's last item as `memory: { saved, updated }` (both ≥ 0, at least one > 0), set in `agentTurn`'s `finally` before `store.saveItems`, so single chats, rooms and routines all get it. Readers that build seeds or send items to the agent ignore the field.
- **Shown** under that reply as a small muted line: "Memory: 1 saved, 1 updated · View" (omit a zero part). In a room it names the member: "Ana's memory: 1 saved". **View** opens that agent in Agent Studio and scrolls to the Memory section.
- **Broadcast** `memory:changed {agent}` at the end of such a turn so an open Memory section refreshes.

## Live updates

The server watches the memory root (recursive `fs.watch`, 150 ms debounce, closes on `'error'`, like `AgentStore.watch`; create the root if missing, as `AgentStore` does for its folder) and broadcasts `memory:changed {agent}` for the agent folder that changed. That covers the agent's writes, terminal edits, `rm`, and ZumiBot's own writes. The open Memory section reloads on the event for its agent.

## RPC

New area `memory`, following `approvals`:

- `memory:list(agent)` → `{ scope: string | null, limit: number, autoMemoryOff: boolean, indexLines: number, entries: MemoryEntry[] }`
- `memory:save(agent, file | null, { title, description, type, body }, modified | null)` → the new list
- `memory:remove(agent, file, modified)` → the new list
- event `memory:changed` (agent name)

`MemoryEntry` = `{ file, name, title, description, type, body, modified, indexLine }` (`indexLine` 1-based, or null) in `shared/src/types.ts`. Touches `ZumiBotApi`, `rpc/handlers.ts`, `frontend/src/net/api.ts`, `shared/src/rpc.ts`, as every new method does.

## Rename and delete

- **Rename in the app** (`agents:save`): right after `agents.save` returns and **before any await**, next to `approvals.renameAgent`, move `<root>/<old>` to `<root>/<new>` synchronously (`renameSync`). Same in `app.ts`'s outside-rename branch. Because the watcher's removal pass also fires for every rename, **memory is never touched by the removal pass**.
- **Moving is a merge, never an overwrite.** No old folder → nothing. No new folder → one `renameSync`. Both exist → move each top-level memory file from old to new; a name already taken in new gets `_2`, `_3`… before `.md`; then the old folder (now holding only its `MEMORY.md` and anything ignored) goes to the Trash. The index repair adds lines for the moved files on the next list or turn. Nothing is ever lost.
- **Rename or delete while that agent is replying** (ZumiBot allows a rename mid-turn; the running CLI keeps its old `--agent` name and its next memory `Write` recreates `<root>/<old>/`): the move happens at once as above, and again, as the same merge, when the last turn started under the old name ends. So late writes join the new folder (or, after a delete, go to the Trash with the rest). Needs a small "turns running per spawned agent name" count, or a hook at turn end that checks for a leftover old folder whose name no agent has. (My call, from the builder check.)
- **Delete in the app** (`agents:trash`): after the existing check that the agent is gone, move `<root>/<name>` to the Trash with `trashPath`, failure caught and logged (the agent is already deleted). Deletes by Zumi Bot or a file manager leave the folder; a new agent with that name later inherits it (accepted).

## Sync

Add `['agent-memory', []]` to `CLAUDE_DIRS` in `deploy/sync.mjs`, so `npm run sync` and the desktop Sync carry it like `agents` (per-file newest-wins, replaced files backed up, never deletes). Consequences, documented in CLAUDE.md: a memory deleted on one machine comes back from the other on the next sync (sync never deletes anything), and `MEMORY.md` is newest-wins as a whole, which "Keeping the index whole" repairs on the next list or turn. Update the sync e2e/fixtures that list the synced folders.

## Security

- Paths: `NAME_PATTERN` agent names, the file-name pattern, `assertInside` on every join; the memory root comes from env/config, never from a client.
- No memory text in logs or errors: error messages name the agent and the file name at most.
- The appended prompt holds counts only.
- No new HTTP route; everything is RPC behind the existing gate.

## Testing

- **shared:** parse (both `type` placements, missing/broken frontmatter, non-standard types), serialize round trip, index line parse/build/escape, slug/file naming, `AgentFields` `memory`/`memoryLimit` save without touching other keys.
- **backend:** memory store (list, create, update keeping file name, delete to trash with index line removed, conflict refusal, limit refusal, path refusals, index repair adds but never removes), rename idempotence (old missing, both exist), trash on delete, the appended cap block (under, at, over, off, compact skipped, auto memory off), counting in `agentTurn` from fixture streams (new vs existing file, `MEMORY.md` ignored, failed tool result ignored, other agent's folder ignored), handlers' argument checks.
- **frontend (pure modules):** search matching, grouping/order, count/limit state, chat-line text.
- **e2e `npm run e2e:memory`** with the fake claude (`HOME=root/home`), no quota: turn memory on and save; a fake reply that writes a memory file shows "Memory: 1 saved" and the list updates live; add, edit, search, delete by hand and check the files and `MEMORY.md`; the limit hides New memory; rename moves the folder. The fake claude needs a way to write a file as a tool call (extend its script format if it has none).
- **Not automated, run once by hand (ask before touching the VPS):** that memory works on the VPS, and a real `claude` turn through ZumiBot saving a memory. Expected to pass: the docs say auto memory is off by default "in a self-hosted environment", but CLI 2.1.299 only turns it off under `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_SIMPLE`, safe mode or a restricted session, and the VPS unit sets none of them.

## Left to the builder

- Module names and split (suggested: `backend/src/core/memory/memoryStore.ts`, `shared/src/memory.ts`, `frontend/src/state/memory.ts`, `frontend/src/components/AgentMemory.tsx`), CSS class names, icons.
- How "saved vs updated" is detected (existence at `toolUse` time or the result text), within the rule above.
- Exact wording of hints, within the meaning above.
- How View navigates to Agent Studio and scrolls to the section.
- CLAUDE.md: a short "Agent memory" section in the same style as the others, plus the sync note and `e2e:memory` in Commands.
