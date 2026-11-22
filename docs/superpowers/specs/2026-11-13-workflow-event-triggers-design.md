# Workflow event triggers and /run-workflow

## Why

A workflow can only start by hand, on a schedule or from a webhook. Nothing that happens inside ZumiBot can start one:
a reply ending, a to-do being added, an Inbox message arriving, a file changing, an email coming in. And there is no way to
start a workflow from the chat you are in. The user skipped the questions, so every choice below is the builder's call,
made to fit what the app already does.

## Goals

- Five new trigger kinds, each picked in the trigger step's **Starts** select:
  - **When a reply ends** (`reply`): an agent's turn in a chat or room ends (replied or failed).
  - **When a to-do is added** (`todo`): the user or an agent adds to-dos to a chat's list.
  - **When an Inbox message arrives** (`inbox`): another workflow's Notify step files a message.
  - **When a file changes** (`file`): a file in a folder (and its subfolders) is added, changed or removed.
  - **When an email arrives** (`email`): a new message lands in an IMAP mailbox.
- `/run-workflow` in the chat composer starts a workflow from the chat, the text after its name as the run's input.
- Event runs reuse what webhooks already have: `{{trigger.body.…}}` fields, the "Only run when" filters, the Audit log.

## Non-goals

- No result posted back into the chat after `/run-workflow` (a Notify step already reaches the Inbox). Adding items to a
  chat from outside its turn races the turn's own item writes.
- No new filter operators beyond **contains** (below). No regex.
- No Gmail API or OAuth: email is IMAP with an app password.
- Routines get none of this (their triggers stay as they are).

## Anti-goals (would be a failure even if it works)

- A workflow that starts itself forever (its own reply, to-do, Inbox message or file write starting it again).
- An email body, reply text or file name read as instructions by a model: event text is material, always wrapped.
- A password in a log, error, URL or the client. The IMAP password stays in the Vault and is read only by the server.
- Every reply in the app writing a skipped run to disk.

## How it works

### One shape for every event

An event becomes a run the way a webhook call does: the run stores `call` (`method: 'EVENT'`, empty `query`, the event's
JSON `body`) so `{{trigger.body.x}}` and the filters work unchanged, and `input`, the event's text, which the trigger step
hands on as its output and which `{{trigger.text}}` names. Event text is material (`TemplateCtx.trigger.material`), so a
model reads it inside an `<input from="trigger">` block. `WorkflowRun.via` gains `'event'` (with `run.event: {kind, depth?}`)
and `'chat'` (with `run.chat: {chatId, title}`).

A pure `shared/src/workflowEvents.ts` holds each kind's body type, its text, a static sample body (the inspector's field
list and the editor's `{{` menu read it, as a webhook's latest call), and the per-kind match (file changes, patterns).

### Dispatch

`core/workflows/workflowEvents.ts` (`WorkflowEventDispatcher`) receives `emit(kind, event)` from the app's hooks and, for
each enabled workflow whose trigger is that kind: checks the kind's own settings, the filters (`filtersMatch`), a rate cap
(`EVENT_RUNS_PER_MINUTE`, 30 per workflow), then calls `runner.run(w, 'event', …)`. A filtered-out event writes nothing
(unlike a webhook's skipped run): every reply in the app would otherwise write one. Errors are caught and logged.

Loop guards:
- `reply` and `todo` skip chats a workflow made (`ChatMeta.workflow`, `workflowTest`, a Room step's copy) and A→B ask chats.
- `inbox` never fires on a message from the same workflow, and carries a depth: a run started by an Inbox message whose own
  run (or the root of its sub-workflow chain) was started by one gets depth + 1; past `INBOX_CHAIN_MAX` (3) it does not fire.
- `file` drops changes seen while a run of that workflow is unfinished (its own agent writing into the folder).
- At the active-run cap (5) an event run is `skipped` ("Too many runs in progress"), not `failed`, and sends no failure push.

### Sources

- **Reply** — `ChatService.onTurnEnd` and `GroupService.onTurnEnd` gain the reply text. Stopped turns, Compact and passed
  room turns never fire. Body: `{chat: {id, title, folder}, agent, outcome: 'ok' | 'error', room, reply}`; text = the reply.
- **To-do** — `TodoService` gets `onAdded(chatId, items, by)`, called after a user or agent add that added something.
  Body: `{chat: {id, title, folder}, by, count, todos: [{text, group}]}`; text = one to-do per line (so a For each step can
  take it straight).
- **Inbox** — `WorkflowMessages.add` reports a new message (not a repeat). Body: `{message: {id, title, body}, workflow:
  {id, name}, step, runId}`; text = title, a blank line, the body.
- **File** — `FileWatchers` keeps one recursive `fs.watch` per enabled file workflow (resynced on every workflows change),
  ignoring `.git` and `node_modules`, debouncing 2 s, then stats each path: gone = `removed`, new since the burst began =
  `added`, else `changed`. The trigger has `path` (absolute folder), `pattern` (optional `*`/`?` glob on the file name,
  e.g. `*.pdf`) and `changes` (which of added/changed/removed count). One run per burst, at most 100 files. Body: `{folder,
  count, files: [{path, name, change}]}`; text = one path per line. A missing folder is a problem (the workflow cannot be on).
- **Email** — `MailWatchers` polls each enabled email workflow every 2 minutes over IMAP with TLS (`imapflow`, pinned), the
  mailbox opened read-only, so nothing is marked read. The first check after the trigger is set records the mailbox's next
  UID and fires nothing; later checks fire one run per new message, oldest first, at most 10 per check (the rest next time).
  State per workflow in `<data>/workflow-mail.json` (0600: `{host, user, folder, uidValidity, lastUid}`; a different key or
  UIDVALIDITY starts over). The trigger has `account` (a Vault login's id), `host`, `port` (993 default) and `folder`
  (`INBOX` default). The login must be shared with workflows (a new **Workflows may use it** switch on a login, as API keys
  have). Body: `{from: {name, address}, to, subject, date, messageId, text}`, text cut to 20 000 characters, parsed with
  `postal-mime` (pinned; build-time decision, not `mailparser`); text = `From`, `Subject`, a blank line, the body. A **Check mailbox** button in the inspector runs
  one login and reports the message count or the error. Errors never carry the password.

### Filters

`TriggerFilter` gains `op?: 'contains'` (absent = equals, as stored today). The filter row gets an equals/contains select.
Webhook and event filters share the row component.

### /run-workflow

A built-in composer command next to `/btw`. The `/` menu shows a **Workflows** group, one row per workflow; a pick inserts
`/run-workflow <name> ` and carries the workflow id. Typed by hand, the server resolves the longest workflow name the text
starts with (case-insensitive). The new RPC `workflows:runFromChat(chatId, workflowId | null, text)` starts a `via: 'chat'`
run: input = the text after the name (the user's own typing, raw), body = `{chat: {id, title, folder}, text, lastReply}`.
It runs any workflow the Run workflow button would (problems refuse it, as a manual run). The composer clears and the chat
shows a one-line notice "Started <workflow> · Open run" in the send-error slot's place. Not in the island or the routine
prompt field.

### UI

- The **Starts** select lists the five kinds with a hint each; file gets a folder picker, pattern and change boxes; email
  gets account, host, port, folder and Check mailbox. Every event kind shows its field list (from the static sample, with
  Filter buttons) and the filters.
- Sidebar summary and icons per kind; run rows tag `event` runs by kind and `chat` runs as "from chat".
- Audit log: the trigger entry names the event ("Reply ended", …) or "From chat <title>", with the body as JSON and the text.
- Run workflow by hand on an event workflow hands on only the typed text, as a manual run (the hint says body fields stay empty).

### Zumi Bot

The authoring format accepts and returns the new kinds (`reply`/`todo`/`inbox`: filters; `file`: path, pattern, changes,
filters; `email`: host, port, folder, filters, the account kept from the saved workflow since Zumi Bot never sees Vault ids).

## Constraints

- Server listens on 127.0.0.1 only; nothing new is exposed over HTTP.
- Dependencies pinned to exact versions; both new packages bundle into `dist/server.mjs`.
- Workflows run on the VPS only (sync switches local copies off), so watchers and mail polls run there. `workflow-mail.json`
  is per machine and sync never copies it (sync copies only named files).
- `docs/architecture/workflows.md` and `workflow-steps.md` updated in the same change; root `CLAUDE.md` stays under 16 KB.

## Left to the builder

Exact component split, CSS, icon shapes, constant names, the order of fields in bodies.

## Build-time decisions

Rulings made while building, which refine the text above:
- Email parsing uses `postal-mime` 4.2.0, not `mailparser`; `imapflow` is 2.10.0. Both pinned and bundled.
- A Zumi Bot save keeps an email trigger's account only when the host and port are unchanged (host compared trimmed,
  case-insensitive); otherwise the account is cleared: a new workflow is saved off until the user picks one, and one
  already on stays on with the missing account reported as its problem (a save never turns a workflow off).
- A file trigger's write through a temp file and a rename reads as `added` (a rename seen in the burst, the path still there).
- `/run-workflow` is refused on the new-chat screen ("Open a chat first") and in the island ("Workflows start in ZumiBot").
- The mail state entry is `{key, uidValidity, lastUid}` with `key` = `host|user|folder`, not three separate fields.
- The RPC is `workflows:runFromChat(chatId, text, workflowId?)`: `text` is the composer's whole text (the server cuts
  `/run-workflow`; a bare rest works too). A Workflows-list pick sends its id while the text still starts with
  `/run-workflow <its name>`, and the list stays closed while the pick holds (Enter sends). With an id, the input is the
  rest past that name (case-insensitive, at a word end), else the whole rest; an unknown id is `Workflow not found`.
- The file guard is checked when a change is seen, not only at the flush: busy = a run of the workflow unfinished, or one
  that ended less than `FILE_BURST_MS` ago (the runner keeps each workflow's last run end in memory), so a write made just
  before a run ends cannot start the workflow again. The dispatcher still checks busy at the flush.
- The chain depth spans Inbox and file events: inbox and file runs store `event.depth`. An Inbox run is 1 + its message's
  root run's depth for a root started by any event (none stored = 1), else 1. A file run is 1 + the deepest unfinished run
  of another workflow at the flush (no event = 0; none = 1). Past `INBOX_CHAIN_MAX` (3) neither fires. Reply, to-do and
  email runs store none.
- A file body's `count` is every matching file in the burst; `files` holds the first `FILE_BURST_MAX`, and `truncated`
  (always present, in the sample too) says whether some were cut.
- An event run that fails on the workflow's problems pushes only when the workflow's newest run did not also fail on them.
- An email check fetches at most `min(MAIL_PER_CHECK, free run slots)` messages and moves its UID only past those; with
  no free slot it skips the check without connecting, so mail waits rather than becoming skipped runs.
- A file trigger's path must be absolute (`Use the full folder path, like /home/you/invoices`); a failing watch logs each
  distinct error once per workflow until the watch has reported a change.

