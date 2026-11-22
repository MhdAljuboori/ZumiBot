# Routines (and remembered approvals) — design

Date: 2026-10-27

Reference material in [`2026-10-27-routines/`](2026-10-27-routines/): the user's rail sketch (`ref-rail.png`), the
schedule picker they want copied (`ref-schedule-*.png`), and the two mockups they approved (`mockup-layout.html`,
option B; `mockup-webhook.html`). Open the mockups in a browser; they are static HTML.

## Why

The user wants agents to work without being asked each time. The first case is a **daily news digest**: every morning
a "news" agent searches for the day's news on a topic given in the prompt, builds a digest and emails it to the user.
Other cases come from outside the app: a tool calls a URL (a webhook) and an agent gets a prompt built from that call's
data (for example "review this PR").

A **routine** is: a **trigger** (schedule, manual, or webhook) plus one **action**: send a prompt to an agent or a group,
in an existing chat or in a new chat made for each run.

Unattended runs hit the app's tool approvals. The user wants a run to **wait** for approval like any chat, and then
never be asked again for that tool by that agent. So this work has two parts, built in this order:

1. **Remembered approvals**: "Allow always for this agent", saved on the server. Small, useful on its own, and it is
   what lets the digest run alone from its second day.
2. **Routines**.

---

## Part 1: Remembered approvals

### What the user sees

- Approval cards get a fourth button: **Allow always for this agent** (next to Allow once, Allow for this chat, Deny).
- Once chosen, that agent's matching tool request is approved without a card, everywhere the agent runs: single chats,
  group chats (the member who asked), and routine runs. The card shows as auto-allowed, as "Allow for this chat" does
  today.
- The rule survives restarts and is the same on every device (server-side).
- Matching (the user's choice) is **looser than "Allow for this chat"**: every tool **by name** (WebSearch, WebFetch,
  Read, Edit, MCP tools…), so a daily search with a new query is not asked again. **Bash stays by exact command**,
  because a name-only Bash rule would allow any shell command. "Allow for this chat" keeps today's matching (`allowKey`
  in `core/chat/controlProtocol.ts`); the agent rule needs its own key function.
- The agent editor gets a **Remembered approvals** section listing the agent's rules (the tool name, plus the command
  for Bash), each with a remove button.
- "Allow once" and "Allow for this chat" stay as they are.
- Renaming an agent keeps its rules.

### How (decided)

- The decision is per agent, never per chat or per routine (the user's words: "allow should work per agent, routine
  or out of routine").

### How (my calls; the builder may adjust the mechanics, not the behaviour)

- New `ApprovalDecision` `'allow-agent'` and `ApprovalStatus` `'allowed-agent'`. `chats:answer` already carries the
  member's name for group cards; for a single chat the agent is the chat's agent.
- Stored in a new data-dir file, `approvals.json` (`{ [agentName]: allowKey[] }`), with its own small store like
  `settingsStore.ts`. Kept out of `settings.json` so the lists can grow without bloating settings.
- Check order on a permission request (in `ChatService.agentTurn`, where `allowed.get(spec.allowScope)` is checked
  today): unanswerable tools first (unchanged), then this chat's memory, then the agent's remembered rules, then a
  pending card. `TurnSpec` needs the agent name for this lookup (it has `agentName`; group turns set `author`).
- Rename: there are two rename paths, and both must move the rules. `agents:save` updates group rooms, chats,
  settings and sidebar for renames made in the app. `agentsSync.ts` does the same for renames made outside it (Bot
  Father, hand edits). Add the approvals store to both.
- Delete: when an agent's **file disappears** from the agents folder, its rules are **dropped**, so a new agent created
  later under the same name does not inherit them. That covers every way a file is removed: the app's Delete, Bot
  Father (it deletes with `gio trash`) and the user's file manager. A file that still exists but fails to parse
  (broken frontmatter) keeps its rules. So detection goes in the agents-folder watcher path, keyed on the file path
  being gone, not on the agent dropping out of the list.
- Production runs the CLI with `--permission-mode auto` (`app.ts`), so many tool calls never reach a card. Only calls
  that do reach a card can be remembered.
- Zumi Bot: its deny rules are CLI-level (`disallowedTools`), so the CLI never asks for those tools and a remembered
  rule cannot widen them. No special case needed.

### Anti-goals

- One agent's rule applies to another agent.
- A rule survives the agent being deleted and re-created.
- A remembered Bash rule allows any command other than the exact one approved.
- The looser agent matching leaks into "Allow for this chat", which keeps its current rule.

---

## Part 2: Routines

### What the user sees

#### The rail (app-wide navigation)

- A thin vertical **rail** on the far left, beside the sidebar (see `ref-rail.png` and the mockup). Top: the app's bot
  logo. Then two buttons with tooltips: **Agents** (today's sidebar and views) and **Routines**.
- Only these two. The user's sketch also shows "⋯", a store icon, help and settings; those are not part of this work.
  Account menu and theme stay in the sidebar footer.
- An **amber dot** on the Routines button while any routine run is waiting for an approval. It clears when the user
  answers. This is the only alert for now; notifications are later work.
- **Phones** (the existing drawer layout): the rail becomes two tabs, Agents and Routines, at the top of the sidebar
  drawer.

#### Routines sidebar (when Routines is selected)

- Header like today's sidebar: `ROUTINES`, a count badge, **+** (new routine), search.
- One row per routine: an icon for its trigger (clock / play / bolt), its name, a status dot for the last run
  (green done, amber waiting for you, red failed; none if it never ran), and a subline: the schedule in words plus
  "next in 9h", or "Webhook", or "Manual", or "paused". Paused routines are dimmed.

#### Routine editor (main area, layout B in `mockup-layout.html`)

- Header: the routine's name (editable), an **On/Off** switch, **Run now**, and a **⋯** menu (Delete).
- Left: two cards joined by a line, as in the mockup: **1 Trigger** and **2 Send prompt**. The mockup's dashed "Add
  step" is **not** built (multi-step is a non-goal).
- Right: **Recent runs**.
- Footer: **Cancel** and **Save**. Edits apply from the next run.
- **Run now** works for every trigger kind; "Manual only" routines run only through it.

#### Card 1: Trigger

A dropdown picks **Schedule**, **Manual only** or **Webhook**.

**Schedule.** Copies the user's reference (`ref-schedule-*.png`): a frequency menu, then "on <days>" and "at <time>"
pills. The day pill opens an S M T W T F S picker; the time pill opens an hour : minute AM/PM picker.

| Frequency | Fields | Meaning |
|-----------|--------|---------|
| Once | date, time | Fires once; afterwards the routine switches itself off. |
| Hourly | minute, days | Every hour at that minute, on the ticked days. |
| Daily | days, time | At that time on the ticked days. "Every day" = all seven ticked. |
| Weekly | weekday, time | Once a week. |
| Monthly | day of month (1–31 or **Last day**), time | "Last day" so short months are not skipped. A fixed day that a month lacks (31 in April) is skipped that month. |
| Yearly | month, day, time | Once a year. |
| Custom | cron expression | Standard 5-field cron. Shows the next 3 run times under the field so the user can check it; invalid cron blocks Save. |

- **Time zone:** times are in the user's time zone, not the server's (the VPS likely runs UTC). On save the routine
  stores the browser's IANA time zone; the card shows it next to the time.
- **Missed runs:** if the server was off or asleep when a run was due, it runs **once** as soon as the server is back,
  marked **late** in Recent runs. Several missed times still give one run (a PC waking after a week must not fire seven
  digests). A missed "Once" also runs late, then switches off.

**Manual only.** No fields. Runs only from Run now.

**Webhook** (see `mockup-webhook.html`).

- Picking Webhook shows the routine's **URL** (`<origin>/hooks/<id>`) with Copy, and its **secret** with Show, Copy and
  **New secret**. The hint says how to send it: header `X-ZumiBot-Secret`.
- The user calls the URL from their tool, then presses **Check test call**. The app shows the latest call it received:
  method, time, and its **fields** with sample values, each with **Insert**.
- **A webhook routine cannot be saved until a test call has arrived.**
- Before the first save, calls are only captured as test calls. They **never** start a run.
- After saving, every valid call starts a run. **Check again** shows the latest call received (test or real), to pick
  up new fields.
- Fields:
  - GET: the URL's query, as `query.<name>`.
  - Other methods: the body, as `body.<path>`. JSON bodies are flattened with dots and list items by position
    (`body.pr.labels.0`). Form-encoded bodies give `body.<name>`.
- **Run now** on a webhook routine uses the saved test call's data.

#### Card 2: Send prompt

- **Agent | Group** switch.
- **Agent:** pick the agent, then the chat: **New chat every run** or one of that agent's existing chats. A new chat
  needs a **folder** (folder picker, default the agent's last folder, as New chat does today).
- **Group:** pick **New group chat every run** or one of the existing group chats. A new group chat needs members, a
  folder, and optional **rules** (the group's role text, as the New group form has today).
- **Prompt:** a text box. For webhook routines, fields go in as chips, added by typing `{{` or pressing Insert. Stored
  as `{{body.pr.title}}` placeholders in the text.

What a run does with the target:

- **New chat every run:** creates a fresh chat (or group chat) with the routine's settings and sends the prompt as the
  first message. Title: routine name and date, e.g. `Daily AI digest · Oct 27`. The chats appear in the Agents sidebar
  as normal chats. No automatic cleanup.
- **Existing chat:** sends the prompt into it as if the user typed it. If that chat is busy, the prompt is **queued**
  like any message sent mid-run (the existing Tasks queue). In a group, the moderator picks who replies, as for any
  message.

#### Runs

- Each trigger starts its own run, even if the previous run of the same routine is still going. New chats keep them
  apart; an existing chat queues.
- Safety cap (my call): at most **5 unfinished runs per routine**. Each one waiting on an approval keeps a `claude`
  process alive. A trigger past the cap starts nothing and is recorded in Recent runs as failed ("too many runs in
  progress"). Normal use never reaches it. It stops a week away, or a chatty webhook, from piling up processes.
- Runs waiting on an approval count as busy for `npm run deploy`, the same as a chat waiting on a card today.
- Run states: **running**, **waiting for you** (an approval card is open in the run's chat), **done**, **failed** (with a
  reason). **Late** is a tag on a run that fired after a missed time.
- A run is done when the agent finishes its reply. For a group, when the room goes quiet (no member working, nothing
  queued).
- Runs wait for approvals exactly like normal chats: the card sits in the run's chat until answered. Remembered
  approvals (Part 1) answer it automatically.
- **Recent runs** lists each run: status dot, time, late tag, short reason when failed, and **Open chat** (the chat it
  created or posted into). Each routine keeps its last **50** runs.
- A missing target (agent deleted, chat removed) shows a warning on the routine; its runs fail with a clear reason.
  Routines refer to agents by name, as chats do: if a new agent with the same name appears, the routine uses it
  (my call).
- Renaming an agent updates the routines that use it, through both rename paths (`agents:save` and `agentsSync.ts`).
- Deleting a routine asks first; the chats it made stay.

#### Webhook calls (HTTP behaviour)

- Wrong or missing secret: refused. Paused routine: refused. Body over about 1 MB: refused. Very fast repeat calls:
  rate-limited and refused.
- A valid call is answered **at once** with "accepted" (and the run id). The caller never waits for the agent.
- A field the prompt uses but the call lacks becomes empty text; the run notes which fields were missing.
- **Local mode:** the server listens only on `127.0.0.1`, so only programs on the user's PC can call it.
- **Local mode port (the user's choice):** today Local mode takes a random free port each launch (`config.ts`: port
  `0` unless `ZUMIBOT_PORT` is set), which would change the webhook URL every start. Local mode moves to a **fixed,
  saved port** so URLs survive restarts:
  - Default `4318`, one above the VPS default `4317`, so both can run on one machine.
  - The desktop shell saves it with the Local choice (`servers.ts`, `server.json` in userData) and passes it to the
    server as `ZUMIBOT_PORT` (`localServer.ts`).
  - The picker page gets a port field for Local.
  - If the port is taken at launch, the shell says so plainly on the picker page and lets the user pick another. It
    never falls back to a random port without saying so.
  - Tests and the e2e harness can still pass `ZUMIBOT_PORT=0`.

### Goals

- The daily digest works end to end: scheduled at 07:00 in the user's time zone, new chat each day, waits for approval
  the first time, runs alone once the tools are remembered.
- Webhook routines can be set up from a test call and use its fields in the prompt.
- Everything lives on the server: same routines and runs in every tab and device; the schedule clock runs in the
  server, not the browser.

### Non-goals (this version)

- Notifications (desktop, push, email from the app). The amber dot is the only alert.
- More than one step per routine, or actions other than "send a prompt".
- Cleaning up the chats routines create.
- Placeholders for scheduled routines (like `{{date}}`).
- Returning the agent's answer in the webhook's response.
- Signature-based webhook auth (GitHub-style HMAC). Tools that can't send a custom header can't call these webhooks yet.
- A marker on messages saying they came from a routine. New chats carry the routine name in their title.

### Anti-goals (a failure even if it "works")

- A routine run auto-denies, skips or bypasses tool approvals. It must wait. Never add `--dangerously-skip-permissions`
  or `bypassPermissions`.
- Waking after downtime fires a burst of missed runs.
- One schedule tick starts two runs (two tabs open, a restart racing the tick, a save racing the tick).
- A test call starts a run.
- A webhook is callable without the secret, or the secret shows up in logs, URLs, error messages or broadcast pushes.
- A trigger fires and leaves no trace: every run, including failures, appears in Recent runs.
- A routine's prompt silently goes to the wrong chat or agent after a rename.

### Constraints (from the project)

- New API methods touch three places: `ZumiBotApi` in `shared/src/types.ts`, `rpc/handlers.ts`, `frontend/src/net/api.ts`.
  Handlers check every argument (`str()` etc.).
- Secrets never go into logs, URLs or error messages. Compare the webhook secret in constant time.
- The server stays bound to `127.0.0.1`. The webhook route is a plain HTTP route in `http/server.ts`, handled
  **before** the session gate (no cookie, no `Origin` check), and authenticated by its own secret only.
- Dependencies pinned to exact versions and bundled into `server.mjs`. Prefer a small in-house schedule/cron calculator
  over a new dependency; if one is added, pin it.
- Dev/test hooks go through `devEnv()`. Tests run against the fake claude (`backend/tests/fixtures/fake-claude.mjs`).
- Frontend logic in pure modules under `src/state/` or `src/net/` where it can be unit-tested (no DOM tests exist).
- Keep the comment style: short, says why.

### How (my calls; the builder may change mechanics if behaviour stays)

**Data.** New data-dir file `routines.json`, with its own store (atomic writes like the other stores). Shape, roughly:

```ts
type Schedule =
  | { freq: 'once'; date: string; time: string }            // date YYYY-MM-DD, time HH:MM (24h)
  | { freq: 'hourly'; minute: number; days: number[] }      // days 0–6, Sunday = 0
  | { freq: 'daily'; time: string; days: number[] }
  | { freq: 'weekly'; day: number; time: string }
  | { freq: 'monthly'; day: number | 'last'; time: string }
  | { freq: 'yearly'; month: number; day: number; time: string }
  | { freq: 'custom'; cron: string }

type Trigger =
  | { kind: 'schedule'; schedule: Schedule; timeZone: string }
  | { kind: 'manual' }
  | { kind: 'webhook'; sample: WebhookCall | null }         // secret kept apart, never in list pushes

type Target =
  | { kind: 'new-chat'; agent: string; cwd: string }
  | { kind: 'new-group'; members: string[]; role: string; cwd: string }
  | { kind: 'chat'; chatId: string }                        // single or group

interface Routine {
  id: string; name: string; enabled: boolean
  trigger: Trigger; target: Target; prompt: string
  nextRunAt: number | null                                  // schedule only; drives missed-run detection
  createdAt: number; updatedAt: number
}

interface RoutineRun {
  id: string; routineId: string; via: 'schedule' | 'manual' | 'webhook'
  status: 'running' | 'waiting' | 'done' | 'failed'; late: boolean
  chatId: string | null; error?: string; missingFields?: string[]
  startedAt: number; endedAt?: number
}
```

Runs may live in a second file if rewriting `routines.json` on every status change is too heavy.

**Webhook secret.** Stored in plain text in the data dir (file mode `0600`, like the other data files) so **Show** and
**Copy** work any time, as in the approved mockup. Never included in `routines:list` or pushes; fetched on demand by a
separate call. **New secret** replaces it at once.

**Webhook before first save.** Choosing Webhook on a new routine asks the server for a **draft** endpoint (id +
secret). Calls to a draft are stored as its latest test call and answered "test call captured". Save turns the draft
into the routine (same id, so the URL the user already configured keeps working). Cancel deletes the draft; drafts
older than a day are cleaned up on start.

**Webhook responses.** `202` with the run id; `401` for an unknown id **or** a bad secret (same response, so ids can't
be probed); `409` paused; `413` too large; `415` unsupported body; `429` rate-limited. Two limits:
- **Bad secrets:** throttled per IP with the existing failure limiter (`auth/rateLimit.ts`, built for failed logins).
- **Valid calls:** a separate, simple per-routine limit of **60 calls a minute**. The login limiter counts failures
  and locks after 10, too strict for a CI hook.

Query fields are exposed for every method (a superset of the user's "GET uses params").

**Running.** A `RoutineRunner` service, built in `app.ts#startServer` like the others:

1. Resolve the target. New chat: `chats.create` (as `chats:create` does) or `chats.createGroup`, then set the title.
   Existing chat: check it exists.
2. Render the prompt (placeholders → values; missing → empty, recorded).
3. Send through `TaskQueue.submit(chatId, text, [])`, the same entry point as `chats:send`, so busy chats queue and
   groups go through their room.
4. Track status from chat pushes / pending approvals (`ChatService.pendingCount`, `TaskQueue.idle`) until the chat is
   idle. A server restart mid-run marks it failed ("interrupted").

**Scheduler.** One timer in the server for the earliest `nextRunAt`. On fire: start the run, then compute the next time
from **now** (not from the missed time), save, re-arm. On start: any routine with `nextRunAt` in the past runs once,
late. Save the new `nextRunAt` before starting the run, so a crash mid-start can't repeat it. DST: a time that doesn't
exist that day runs at the next valid minute; a repeated hour runs once.

**Rename and delete.** On agent rename, update routines after chats, in both rename chains (`agents:save` and
`agentsSync.ts`). Agent trash or chat removal: leave routines as they are and show the warning; runs fail with the
reason.

**API (roughly).** `routines.list / save / remove / runNow / runs / draftWebhook / dropDraft / latestCall / secret /
newSecret / onChanged`, with a `routines:changed` broadcast (routines plus run status, for the dot and Recent runs).

**Frontend.**
- A `Rail` component wraps the shell. The selected mode (Agents / Routines) is remembered per browser (localStorage);
  the default is Agents.
- Agents mode is today's sidebar and views, unchanged.
- Routines mode shows a routines sidebar and the editor.
- The prompt box with `{{` chips can reuse the composer's Tiptap setup (mention-style suggestion), or be a simpler
  editor. Builder's choice.

### Testing

- Unit:
  - Next-run calculation: every frequency, time zones, DST edges, "last day", cron parsing and the 3-run preview.
  - Missed-run collapse.
  - Field flattening and prompt rendering.
  - Approvals store, its rename (both paths) and its delete (file gone vs. broken frontmatter).
  - The agent key (by name; Bash by exact command) and the check order of the approval lookup.
  - Local port: saved, passed through, and a taken port reported.
  - Webhook route: auth, draft capture, size and type limits, rate limit, the secret never echoed.
- Runner tests with the fake claude:
  - New chat, existing busy chat (queues), new group.
  - Waiting on approval, then done.
  - Missing target fails.
- An e2e suite (`e2e:routines`): create a routine, Run now, see the run's chat; webhook draft → test call → save →
  real call → run.

### Left to the builder

- Exact store split, file names beyond `routines.json` / `approvals.json`, API method names and push shapes.
- How run status is observed (push listener vs. hooks in `TaskQueue`/`ChatService`).
- The exact copy, icons and spacing, within the mockups' look and the app's existing tokens (`styles.css`).
- The prompt editor's implementation.
