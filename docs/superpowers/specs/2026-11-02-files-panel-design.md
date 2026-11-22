# Files panel: design

Date: 2026-11-02. Built from the user's request and a short talk, with a visual mockup. What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

## Why

The user asks agents to change things or to draft things, such as a post **(user)**. The agent does it with `Edit` and `Write` calls. Each call shows up as a tool card somewhere in the chat. In a long chat, finding "which files did it make or change, and what do they say now" means scrolling and opening cards one by one. The cards show the call's input, not the file. When the agent hands the work to a subagent, the chat shows nothing of the edits at all, only the subagent's final report.

The user wants every file in a chat in one list, with a preview **(user)**.

## Goals

1. **One list per chat (user):** every file an agent changed with `Edit` or `Write`, every file a subagent of that agent changed the same way **(user)**, and every file the user attached.
2. **Preview shows the diff first (user),** with a switch to the **whole old file** and the **whole new file (user)**.
3. **One entry per file.** It opens on the overall change (before the chat touched it → now). A step picker shows each change on its own (approved: the user left this to me, then approved the playback).
4. **A side panel beside the chat (user, mockup option A).** The chat stays usable, and the panel updates live while the agent works. On a phone it is a full-screen sheet (approved).
5. **What the user does with a file (user): investigate it, mention part of it, or copy all of it.** So the panel has *Show in chat* (jump to the change's tool card), the same Quote / Explain menu agent messages have for a text selection, *Copy* and *Download* (approved).
6. **Rooms:** each change shows which member made it, with the member's colour dot (approved).
7. **Subagent changes get the same views as the agent's own (user, option B):** line-numbered diff, whole old and new file, Copy and Quote. Where the old file cannot be rebuilt exactly, the panel says so (see *Subagent changes*).

## Non-goals

- Files changed any other way: `Bash` (`sed`, `cat >`, `git checkout`), `NotebookEdit`, MCP tools, the agent browser's downloads. Only `Edit` and `Write` are tracked, by the agent or its subagents.
- Files the agent only read.
- Claude Code's own bookkeeping: auto-memory files (`~/.claude/projects/*/memory/`), plan files (`~/.claude/plans/`) and ZumiBot agent memory (`~/.claude/agent-memory/`), all under `CLAUDE_CONFIG_DIR` instead when it is set. They get changes recorded like any file, but `chatFiles.ts` leaves them out of the list and the count. Agent files under `~/.claude/agents` (Zumi Bot's work) are listed.
- Reverting, undoing or editing a file from the panel. The panel only shows.
- A rendered Markdown view. Old and New show the raw text, so Copy gives exactly what the file holds.
- Syntax highlighting. The app has no highlighter today.
- Whole old and new files for changes made before this feature (the data was never kept; see *What the CLI gives*).
- A list across chats, or a search.
- Files from hidden versions of edited messages. The panel follows the visible version of the chat.
- Showing a subagent's messages or other tool calls in the chat. They stay hidden as today; only its file changes are kept.

## Anti-goals

- **The server reads files it has no reason to.** The agent's own changes come only from what the CLI sends in the stream. The server reads a file from disk in one case only: right after a subagent's `Edit` succeeds, the path that `Edit` named (the user chose this, option B, because the stream carries no file contents for subagent edits).
- **Chats get slower to load.** Whole-file copies never go into `chats/<id>.json` or the items feed.
- **The panel shows an old or new file it is not sure of.** When a copy was not kept or could not be rebuilt exactly, the panel says so. It never guesses.
- **Keeping a copy can break a turn.** Every write and read for this feature is caught and logged; the turn goes on as before.

## What the CLI gives

Checked on 2026-11-02 with CLI 2.1.299: `claude -p --output-format stream-json --verbose`, one run with an `Edit` and a `Write` by the agent, one with an `Edit` and a `Write` by a `general-purpose` subagent.

**The agent's own calls.** The `user` message that carries a `tool_result` also carries `tool_use_result`, which `streamParser.ts` ignores today.

| Call | `tool_use_result` fields |
|---|---|
| `Edit` | `filePath`, `oldString`, `newString`, `replaceAll`, **`originalFile`** (the whole file before the edit), `structuredPatch` (hunks: `oldStart`, `oldLines`, `newStart`, `newLines`, `lines` with ` `/`-`/`+` prefixes and 3 lines of context), `userModified` |
| `Write`, new file | `type: 'create'`, `filePath`, `content`, `structuredPatch: []`, `originalFile: null` |
| `Write`, existing file | `type: 'update'`, `filePath`, `content`, `structuredPatch`; `originalFile` expected but **not seen yet**. The builder records it first. |

- `filePath` repeats the call's input and can be relative. Resolve it against the chat's `cwd`.
- The session logs under `~/.claude/projects` store `originalFile: null`. Only the live stream has the whole file. So old chats cannot get their whole files back from the logs.
- Large files may come without `originalFile`. That case is handled below as "not kept".

**A subagent's calls.** Every line a subagent produces has `parent_tool_use_id` (the `Agent` call that started it), plus `agent_id`, `subagent_type` and `task_description`. `parseLine` drops all of them today.

| Line | What it has |
|---|---|
| `assistant` with a `tool_use` | The call's input: `Edit` → `file_path`, `old_string`, `new_string`, `replace_all`; `Write` → `file_path`, `content` |
| `user` with a `tool_result` | Only the result text, such as `The file <path> has been updated successfully.` or `File created successfully at: <path>`. **No `tool_use_result`.** |

The subagent's own log (`<session>/subagents/agent-<id>.jsonl`) has no `toolUseResult` either. So for a subagent's `Edit`, nothing in the CLI's output holds the whole file or a patch.

## Data

### On the tool item

A new optional field on `type: 'tool'` items in `shared/src/types.ts`:

```ts
/** One structuredPatch hunk, as the CLI sends it. */
export interface PatchHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** What one Edit or Write call did to one file. Whole-file copies are kept outside the item, by id. */
export interface FileChange {
  id: string // tool_use id of the Edit/Write call: the item's own id, or the subagent's call
  ts: number // when its result arrived
  path: string // absolute: the call's file path resolved against the chat's cwd
  op: 'create' | 'update'
  patch: PatchHunk[] | null // null when over the cap or not known; a create has none
  before: string | null // id of the whole file before; null when not kept (and always for a create: the file did not exist)
  after: string | null // id of the whole file after; null when not kept
  snippet?: { old: string; new: string } // a subagent Edit's strings, kept when patch is null
  subagent?: string // the subagent_type, when a subagent made it
}
// on the tool item:
changes?: FileChange[]
```

- The agent's own `Edit`/`Write` item gets one entry.
- An `Agent` item gets one entry per successful `Edit`/`Write` its subagent made, appended as each lands. One subagent can touch many files.
- A result with `isError`, a blocked call, and any other tool get no entry.
- Set where `ChatService` handles tool events, so single chats, rooms and routine runs all get it. Writing copies is async; the entry is added once they are written, through the usual `patchTool` + `saveAndPush`.

### The agent's own changes

| Call | before | after |
|---|---|---|
| `Edit` | `originalFile` | `patch` applied to `originalFile`. If it does not apply cleanly: null |
| `Write` create | none (the file did not exist) | `content` |
| `Write` update | `originalFile`; if absent, `patch` applied in reverse to `content`; if that fails: null | `content` |

### Subagent changes

The parser keeps a subagent's `Edit`/`Write` calls and their results, and still drops everything else on those lines (text, deltas, usage, other tools). `ChatService` matches each result to its call by `tool_use_id`, and the call to its `Agent` item by `parent_tool_use_id`. If a `parent_tool_use_id` names another subagent call rather than a top-level item, it is followed up to the top-level one; an unknown parent is dropped.

| Call | before | after | patch |
|---|---|---|---|
| `Write`, result says "created" | none | `content` | none |
| `Write`, otherwise | null (not kept: the stream never had the old file) | `content` | none |
| `Edit` | rebuilt from *after*, below | **read from disk** right after the result arrives | line diff of before and after when both are kept, else null with `snippet` set |

**Reading after a subagent `Edit` (user chose this):**

- Only on a successful result, only the path that call named, resolved against the chat's `cwd`.
- Opened once; it must be a regular file, at most 1 MiB, with no NUL byte. Otherwise after is null.
- Read at once when the event arrives, before anything else for that turn is awaited. The subagent's next call needs another model round trip, so the file is still as the edit left it.

**Rebuilding before, exactly or not at all:**

1. If this chat already holds an earlier kept *after* of the same path, and applying the edit to it (`old_string` → `new_string`, once or all with `replace_all`) gives exactly the new after, that earlier copy is before.
2. Else, without `replace_all`: if `new_string` is not empty and appears exactly once in after, replace it with `old_string`. If `old_string` then appears exactly once and replacing it back gives after again, that is before.
3. Else before is null, and the Old view says "Not kept: couldn't rebuild this version exactly".

### Caps

My numbers: a whole file over 1 MiB, or holding a NUL byte (binary), gets no copies. A patch or snippet whose text totals over 256 KiB is stored as null; the diff is then made from the copies when they exist.

### Whole-file copies

- `<data>/file-snapshots/<chatId>/<id>`, where `<id>` is the SHA-256 hex of the content. Same content, same file: the "after" of one change is usually the "before" of the next, so it is stored once.
- Written atomically, mode 0600, folders 0700 (they can hold secrets an agent edited, such as `.env`).
- A new `SnapshotStore` in `backend/src/core/`, shaped like `AttachmentStore`: `put(chatId, text) → id`, `read(chatId, id)`, `copy(fromChat, toChat, ids)`, `removeChat(chatId)`.
- **Delete chat:** removes the chat's folder, next to the attachments.
- **Fork (`fork.ts`):** copies the ids the copied items use, as it does attachments.
- **Edit / Resend:** the hidden versions keep their items, so their copies stay. Switching back to a version shows its files again. Nothing is cleaned up before the chat is deleted.
- **Sync (`deploy/sync.mjs`):** `file-snapshots/` travels both ways like `attachments/`. Copies never change once written, so a union copy is enough. A copy chat made by sync gets the folder copied under its new id, as attachments are today.

### Older changes

Tool items saved before this feature have no `changes`. The agent's own `Edit`/`Write` items are still listed, from their input:

- `Edit`: the diff is made from `old_string`/`new_string`, with no line numbers, labeled "position not known".
- `Write`: New is the input's `content`. Old is unknown.
- Their Old/New views say "Not kept for changes made before this feature".

Subagent edits from before this feature were never recorded and cannot be listed.

## Server

### `files:list`

The client holds only the loaded pages of a chat (`ITEMS_PAGE`), so the list is built on the server from all visible items. A new pure helper, `shared/src/chatFiles.ts`, takes the items and the chat's `cwd` and returns:

```ts
interface ChatFiles {
  changed: Array<{
    path: string // absolute
    shown: string // relative to cwd when inside it, else with ~ for the home folder
    created: boolean // its first change is a create
    changes: Array<{
      itemId: string // the card Show in chat goes to: the Edit/Write item, or the Agent item for a subagent
      id: string; ts: number; agent?: string; subagent?: string
      op: 'create' | 'update' | 'unknown'
      patch: PatchHunk[] | null; before: string | null; after: string | null
      snippet?: { old: string; new: string }
      legacy?: { oldString: string; newString: string } | { content: string }
    }>
  }>
  attached: Array<{ itemId: string; ts: number; attachment: Attachment }>
}
```

- `changed` is ordered by latest change, newest first; `attached` by time, newest first. Each attachment is its own entry, even with the same name.
- The same file is the same `path` string. No `realpath`.
- New RPC method `files:list(chatId)` in the three usual places: `ZumiBotApi` in `shared/src/types.ts`, `rpc/handlers.ts`, `frontend/src/net/api.ts`.

### Content route

`GET /api/files/<chatId>/<id>` in `http/server.ts`, behind `createGate` like every route:

- `chatId` and `id` are checked by pattern (`id` is 64 hex chars) before any path is built. Unknown → 404.
- Served as `text/plain; charset=utf-8` with `nosniff`, never as HTML. `?download=<name>` adds `Content-Disposition: attachment`.
- Content-addressed, so it can be cached as immutable.
- Contents never reach logs or error messages.

## UI

New logic goes in a pure module, `frontend/src/state/filesPanel.ts`, with unit tests (the frontend has no component tests): view and step choice, what is available for each view, the overall diff, line numbers for a selection, and the Quote text.

### Opening

- A **Files N** chip in the composer row, next to the cost chip, in single chats and rooms (`GroupPickers`). N = changed files + attachments. Hidden when N is 0.
- The panel sits in the main area's right slot, where `BrowserPanel` sits in `App.tsx`. Close with ✕ or Esc. On a phone it is a full-screen sheet.
- The panel stays open when the user switches chats and shows the new chat's files. The chosen file resets.
- While the panel is open, or the chip is shown, the client asks `files:list` again on that chat's item pushes (debounced, about 500 ms) and after a reconnect.

### List

Two sections, as in the mockup (approved):

- **Changed by agents:** the member's colour dot, the file name, its folder in muted text, a **new** badge when the chat created it, and "N changes". Full path on hover.
- **Attached by you:** name and size.

### Preview, changed files

- **Toolbar:** a Diff | Old | New switch, the step picker, **Copy** and **Download**.
- **Step picker:** "All changes (start → now)", then each change: number, Created/Edited, who (the member, or "member › subagent type" for a subagent), time.
- **Meta line:** the shown path, who changed it and how many times, and **Show in chat ↗**.
- **Diff:** unified, with line numbers and the add/remove colours from the mockup.
  - One change: its patch. If null, a diff of its before and after copies. If those are not both kept, its `snippet` or `legacy` strings without line numbers.
  - All changes: a diff of the first change's before (empty for a create) and the last change's after, when both are kept. Otherwise each change's diff in order, under a small header per step.
- **Old / New:** the whole file with line numbers. For All changes, Old is the first before and New the last after. When a side is not kept, a short line says why: "File did not exist before this chat", "Not kept: file over 1 MB", "Not kept: binary file", "Not kept: couldn't rebuild this version exactly", "Not kept for changes made before this feature".
- While a reply runs, the list and the open preview update as changes land. All changes follows the newest change; a chosen step stays on that step.

### Preview, attachments

- Images show inline from the existing attachment route.
- Text files (by MIME type or sniffing, up to 1 MiB) show as text with line numbers, with Copy and selection.
- Anything else: Open and Download, through the existing routes.
- No Diff/Old/New switch and no step picker.
- Show in chat jumps to the user message that carried it.

### Copy, Download, Show in chat

- **Copy** puts the whole file of the current view on the clipboard: Old gives the old file, New and Diff give the new one. Disabled when that side is not kept.
- **Download** saves the same file through the content route.
- **Show in chat** scrolls to the change's card (`itemId`) and flashes it, like `MessageList`'s `jumpTo`, opening its tool group if it is folded. If the item is older than the loaded pages, the list loads older pages until it is there.

### Mention part of a file

- Selecting text in the preview shows the same Quote / Explain menu as a selection in an agent message (`SelectionMenu.tsx`; its hook now only reads agent bubbles and is widened to the preview).
- **Quote** adds to the draft a line with the path and lines, then the selected lines in a fenced code block:

  ````
  `drafts/launch-post.md:2-3`
  ```
  Files you and your agents touch now
  live in one place, with diffs.
  ```
  ````

  Line numbers come from the view: New and Diff use the new file's numbers. A selection of removed lines only uses the old file's numbers and says `(old)`. When the view has no line numbers (snippet or legacy diff), the line is just the path.
- **Explain** sends the same block followed by "Explain this selected text". It sets no `replyTo`, since there is no agent message to reply to.
- **In a room**, Explain on a changed file is routed to the member who made the shown change (for All changes, the last one), as a user mention of that member, the way a `/command` is routed. Explain on an attachment goes through the moderator as usual. Quote only fills the draft; the user can mention whoever they like.
- Both are offered only when sending is possible, as today.

## Security

- Copies can hold secrets. They are 0600, never logged, served only behind the gate, and only by an id inside that chat's own folder. The chat JSON already holds the input of every `Write`, so this is the same kind of data in the same data folder, now also for `Edit`.
- The route builds paths only from ids that match the patterns. No user-given path is ever read.
- The one disk read (after a subagent `Edit`) reads only the path that `Edit` just wrote, as the server's own user, the same user the agent runs as. It never follows anything the UI sends.
- The CSP is unchanged; file text is never rendered as HTML or Markdown.

## Edge cases

| Case | Result |
|---|---|
| Agent edits the same file five times | One entry, "5 changes"; All changes shows start → now |
| Agent creates a file, then edits it | One entry with the **new** badge; Old says it did not exist |
| Two room members change the same file | One entry, two colour dots; each step names its member |
| A subagent edits 4 files | 4 entries, each step labeled "member › subagent type"; Show in chat goes to the `Agent` card |
| Subagent `Edit` whose new text appears twice in the file, with no earlier copy | Diff from the snippet, New kept, Old "couldn't rebuild exactly" |
| Subagent overwrites an existing file with `Write` | New kept; Old not kept |
| Two subagents edit the same file at the same instant | The disk copy may hold both edits; step 1 of the rebuild then fails and step 2 may still pass. Rare; accepted |
| Edit fails (`isError`) or is denied | Not listed |
| File changed outside the agent between two of its edits | Each step is still exact. All changes includes the outside change, since it compares real copies |
| File deleted or moved later | The panel still shows every kept copy |
| Binary or over 1 MB | Listed; diff from the patch or snippet if kept; Old/New say why they are missing |
| Chat from before this feature | The agent's own changes listed from the tool inputs, diff without line numbers, no whole files; subagent changes not listed |
| Edit or Resend | The list follows the visible version |
| Fork | The new chat lists the copied items' files, with their copies |
| Chat deleted | Its copies are removed |
| Sync | Copies travel with their chat, both ways |

## Testing

- **Unit:** `streamParser` carries `tool_use_result` (Edit, Write create, Write update, error results, missing or odd shapes) and keeps a subagent's `Edit`/`Write` calls and results while still dropping its text and other tools; building a `FileChange` for the agent (applying and reversing patches, caps, binary, relative paths, a patch that does not apply); subagent changes (matching results to calls and calls to the `Agent` item, nested parents, the disk read and its limits, each rebuild rule and its failure, `replace_all`, create vs overwrite); `SnapshotStore` (atomic write, mode, same content once, `copy`, `removeChat`); `chatFiles.ts` (grouping, order, legacy items, subagent entries, bookkeeping paths left out, attachments, errors left out); the line-diff helper; `state/filesPanel.ts` (availability per view, step choice, overall diff, Quote text and line numbers); the content route (gate, bad ids 404, download header); room Explain routing; fork and delete; `sync.mjs` copy chats get their copies.
- **Fixtures:** record real streams into `backend/tests/fixtures/stream/` once: an `Edit` and a `Write` update by the agent (confirms the `update` shape) and an `Edit` and a `Write` by a subagent. Those runs cost a little quota.
- **E2E:** a new `npm run e2e:files` (`zumi-bot-server/e2e/files.e2e.mjs`) on the fake claude, so it costs no quota. The fake claude's script gains a way to emit `Edit`/`Write` results with `tool_use_result`, and subagent lines with `parent_tool_use_id` (it writes the file itself, so the server's disk read finds it). It checks the chip count, the list, Diff/Old/New, the step picker, a subagent change with its label and Show in chat on the `Agent` card, Copy, Quote into the composer, an attachment preview, a fork keeping files, and a delete removing the folder.
- **Docs:** CLAUDE.md gets a short **Files panel** paragraph under Architecture, `file-snapshots/` in the Data list and the sync paragraph, and `e2e:files` under Commands.

## Left to the builder

- The line-diff algorithm: a small Myers diff in `shared` or a pinned diff package. I lean to the small helper: only line diffs are needed, and applying or reversing hunks is simple.
- The exact caps, within the spirit above.
- How very long files render (virtual list, or a cap with "Show all").
- How Show in chat loads older pages.
- How the Files panel and the agent browser panel share the right slot when both want it.
- Whether the parser reports subagent calls for every tool or only `Edit`/`Write`, as long as nothing else of a subagent reaches the chat.
- Visual details, using the existing tokens in `styles.css`.
