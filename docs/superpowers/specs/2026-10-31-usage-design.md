# Usage page and per-chat cost: design

Date: 2026-10-31. Built from a talk with the user and a screenshot of a usage page they want copied. What the user decided is marked **(user)**; everything else is my call and can be changed.

## Why

ZumiBot shows the plan's limits (the 5-hour and weekly bars in the account menu, kept in `usage.json`), but nothing about what each chat or agent spends. The user wants both: a page for the whole app, and the cost of the chat they're in.

`usage.json` doesn't help here. It holds only the two plan-limit percentages from `rate_limit_event`. No cost or token count is saved anywhere today. Every turn's `result` event already carries them (`total_cost_usd`, `usage`, `modelUsage` with `costUSD` per model), and ZumiBot throws them away.

## Goals

1. **A Usage page for the whole app (user):** everything in the user's screenshot, redrawn in ZumiBot's style.
2. **Per-chat cost (user):** a cost chip in every chat, with a details popover.
3. **History (user):** old chats get an estimate, so the page isn't empty on day one. From this release on, numbers are as real as possible.

## Non-goals

- **Real billing.** Every dollar figure is the API list-price equivalent, the same figure the CLI reports. On a subscription plan it isn't what the user pays. The page says "API estimate", as the screenshot does.
- **Jev's OpenRouter calls** stay out for now: different provider, and it's unconfirmed that they report cost.
- **Claude Code use outside ZumiBot** (terminal sessions and so on) isn't counted, even though those session files sit in the same folder.
- **Budgets, alerts, exports.**
- **Other currencies.** USD only.

## Anti-goals

- **Double counting.** A turn must never count as both exact and estimated, and a forked session's copied history must never count twice.
- **A history that shrinks.** Deleting a chat, editing a message or forking must not lower past totals. Spend happened.
- **A slow server.** Estimating reads session logs (the user's `~/.claude/projects` is 3.5 GB). It must not block startup, replies or the UI.
- **Made-up exactness.** Estimated numbers are always marked as estimates. An unknown model's cost shows as unknown, never as $0.

## Data

### Two kinds of numbers

- **Exact records** are facts saved when a run reports its cost. They're stored, synced and never recomputed.
- **Estimates** are derived data: session-log tokens that no exact record covers, priced by the price table. Each machine works them out from its own logs and the exact records it holds. They're cached, never synced, and recomputed when their inputs change.

Because estimates are always "logs minus what exact records cover", no boundary time is needed, and the PC/VPS cases come out right:

- **Turns run on a machine before it got this release** have no exact record, so they're estimated.
- **Turns synced in from the other machine** are covered once their exact records arrive, so they're never counted twice.

### Exact records (from this release on, user)

A store in the data dir holds them. One record:

- `id`: unique, so sync can merge by id.
- `chatId`.
- `agent`: the agent that spent it. In rooms this is the member, and the moderator is a reserved name shown as "Room moderator".
- `at`: time in ms.
- `sessionId` and the turn's time window `[start, end]` (spawn to process exit). Both are `null` for the moderator, which has no log.
- per model: `input`, `output`, `cacheRead`, `cacheWrite` tokens and `costUsd`.

Where they come from:

- **Chat and room turns:** extend `streamParser`'s `result` event with `total_cost_usd`, `usage` and `modelUsage`. In `ChatService`'s `result` handling, where `chatId` and the turn's agent (`spec.author ?? spec.agentName`) are known, save one record. The id is the result event's `uuid`. Every attempt that gets a `result` is recorded, error results included, since spend happened. Rooms go through the same code, because `GroupService` runs members through `ChatService.agentTurn`.
- **Moderator:** `runModerator` uses `--output-format json`, whose result also carries `total_cost_usd` and `modelUsage`. Record it on the room with the moderator agent name. Jev's fast-path answers cost nothing here.
- **Subagent cost:** the CLI's `total_cost_usd` and `modelUsage` already include subagents, so nothing extra is needed.

Store constraints:

- The file name, format and layout are the builder's call.
- Saving a record after each turn must stay cheap as history grows. Don't rewrite a multi-MB file on every turn.
- The format must allow merging by id in sync.

### Estimates (old chats, and anything no exact record covers; user)

- **Which sessions:** every session id that a chat or an exact record names:
  - `ChatMeta.sessionId` and `GroupInfo.sessions`
  - the session ids in the `end` stamps of each chat's items and its versions file
  - `sessionId` on exact records, which keeps deleted chats' sessions in reach
  - Only 55 of the 62 local chats have a `sessionId`, and older sessions from resets and seeds are named only in stamps, so the stamps matter.
- **Finding the files:** find `<sessionId>.jsonl` under any `~/.claude/projects/*/` folder (don't rebuild the escaped folder name), plus that session's subagent logs in `<sessionId>/subagents/*.jsonl`. A file that's gone is skipped. Never scan sessions nobody names.
- **What counts:** assistant lines with `message.usage`.
  - **Same message on several lines:** one message is split over several lines with the same usage, so deduplicate by `message.id`.
  - **Covered entries:** an entry of session S whose timestamp falls in an exact record's window for S is covered. That includes S's subagent logs. Its `message.id` joins a covered set.
  - **Copies:** any line with a covered `message.id`, in any file, is skipped. That handles `--fork-session` copies of history that was exact.
  - **Fork copies of estimated history:** a `message.id` seen in several sessions goes to the chat created first.
- **Pricing:** priced per message, before aggregating, so per-request rules apply. Examples are a higher rate above a prompt-size threshold and fast mode; the `claude-api` skill lists the current ones. Cache writes use the 5-minute or 1-hour rate per `usage.cache_creation`'s split.
- **Shape:** aggregate per chat, agent, day and model. Days are bucketed at query time in the browser's time zone, so the cache should keep enough detail for that (per hour, say).
- **Cache and recompute:**
  - Cache per session file, so restarts are cheap.
  - Recompute a session when its log grew, when the exact records naming it changed (after a sync, say), or when the price table or logic version changes.
  - Logs are append-only, so continuing from a saved offset is allowed. That's the builder's call.
- **Stopped turns:** a turn that ends with no `result` (Stop, crash, kill) has no exact record, so its logged tokens become an estimate. Recompute that session right after such a turn, so the chip shows it within moments.
- **Startup:** the first full pass runs in the background at server start. Read files as streams, line by line. Never load a whole log into memory, and yield between files so replies stay responsive. The page shows "Estimating old chats…" until the first pass is done.

The moderator ran with `--no-session-persistence`, so old moderator cost can't be estimated. That's fine.

### Price table

`shared` gets a table of list prices per model per million tokens: input, output, cache read, 5-minute cache write, 1-hour cache write. It also covers any per-request rules (prompt-size tiers, fast mode) that the current pricing has.

- **Where the prices come from:** the builder takes them from Anthropic's current pricing (the `claude-api` skill has them). Don't write them from memory.
- **Which models:** at least those in the user's logs today: `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`, `claude-haiku-4-5-20251001`, `claude-fable-5-1`.
- **Unknown models:** a model not in the table keeps its tokens with `costUsd: null`. The UI shows "unpriced" and leaves it out of dollar totals, noting that totals exclude it.

### Rename and delete

- **Renaming an agent** rewrites the `agent` field in its records, as stored chats are rewritten today (`agents:save` / `agentsSync.ts`). It isn't ordering-critical, so it can go anywhere after the approvals move.
- **Deleting a chat** keeps its records. The page lists it as "Deleted chat".
- **Deleting an agent** keeps its records under the old name.

### Sync (PC ↔ VPS)

`sync.mjs` merges the stored records on both sides by id (the union). It never treats the store as newest-wins.

- **Exact records** never collide: their ids are CLI uuids.
- **User-message records** (see below) use item ids.
- **The estimate cache** isn't synced at all. Each side recomputes after the restart that sync already does, from the merged records and the `~/.claude/projects` logs that sync already copies.

The desktop **Sync…** gets the same change for free: it runs the same `sync.mjs` copied into `resources/sync`. Add tests next to the existing merge tests.

## API

- **`usage:query`**
  - Args: range (from/to or "all"), optional agent, optional `chatId`, and the browser's IANA time zone for day buckets.
  - Returns the aggregate the page needs:
    - totals for each token kind
    - cost split into exact and estimated
    - a daily series, split exact and estimated
    - breakdowns by model, agent, chat (with title, or "Deleted chat") and day
    - the chat count and the user-message count
  - The server aggregates, so the browser never gets raw records.
- **`usage:changed`:** a server event broadcast after each new record, with the `chatId`. Open pages and chips refetch, debounced.
- **Per-chat chip:** the builder decides whether it comes from `usage:query` with `chatId` and all time, or from a lighter call.
- Both follow the usual three places: `ZumiBotApi`, `rpc/handlers.ts` (args checked with `str()` and so on), and `net/api.ts`.

### User messages and Chats counts

These follow the same "history never shrinks" rule as cost.

- **User messages:**
  - Every message the user sends saves a small record in the same store (chat, time, id = the user item's id) and syncs by id. Edit and Resend make new user items, so they count as sent messages.
  - **Old chats:** a one-time pass at first start adds records for user items already in the chat files and their versions files. Ids are item ids, so the same pass on the other machine, or a "(copy from …)" chat made by sync that keeps item ids, adds nothing twice. The builder checks that sync's copy chats keep item ids; if they don't, copies must be skipped by another rule.
- **Chats:** distinct chats with any cost in the range, deleted ones included.
- **Under the agent filter:**
  - Chats = chats where that agent spent in the range.
  - User messages = messages in those chats in the range. For rooms this counts the room's messages, since a user message has no single agent.
  - "Room moderator" as the filter counts rooms the same way.

## UI

The mockups from the talk are in `.superpowers/brainstorm/372179-1793461045/content/`: `usage-page-entry.html` for the page and `per-chat-view.html` option A for the chip.

### Usage page

**Entry (user):** a **Usage…** item in the account menu, next to **Jev decisions…** and **Sync…**. It opens the page full width in the main area as a new `View` kind (for example `{ kind: 'usage'; chatId?: string }`). The sidebar doesn't change. Whether the page gets its own URL path is the builder's call (`state/route.ts` only knows `/chat/` today).

**Top bar:**
- title "Usage"
- agent filter: All agents, each agent, and "Room moderator"
- metric: **Cost** or **Tokens**
- range: 7 days, 30 days, 90 days or All time (default 30 days)
- refresh

**Chat filter:** opened from a chat's popover, the page shows a "This chat ✕" filter, and clearing it goes back to all chats.

**Hero, left:**
- the big total, cost or tokens depending on the metric
- the line "N chats · API estimate · USD"
- the legend, in place of the screenshot's single "Claude Code" row:
  - **Exact:** "% of known cost · tokens · since this release"
  - **Estimated:** "% · tokens · old chats"

**Hero, right:**
- **Daily chart:** "Daily cost" (or "Daily tokens"), one bar per day, with exact solid and estimated hatched or lighter.
- **"View daily data":** switches the breakdown to the Day tab.
- **How to draw it:** hand-drawn SVG. No chart library, to keep dependencies small and pinned.

**Totals row (as in the screenshot):**
- Tokens without cache reads (input + cache creation + output)
- Processed tokens with cache reads (that plus cache reads)
- Cached input
- Uncached input
- Cache creation
- Output
- User messages
- Chats (the screenshot's cut-off "Con…")

**Breakdown:**
- segmented tabs **Model · Agent · Chat · Day**, defaulting to Agent
- columns: name, Cost, Share (of cost, or of tokens on the Tokens metric) and Tokens (without cache reads)
- sorted by the current metric
- rows that are fully or partly estimated get a small "est." tag
- in the Chat tab, clicking a row opens that chat

**Number formats:**
- **Dollars:** `$1.59`, and four decimals under a cent (`$0.0012`), as in the screenshot.
- **Tokens:** `180.78K` and `48.20M`.

**Live and layout:**
- **Live updates:** the page updates on `usage:changed` without a reload.
- **Phone width:** the totals row wraps, the chart shrinks and the table scrolls inside itself, following the existing phone and tablet layout. Light and dark themes use the existing tokens in `styles.css`.

### Cost chip in a chat (user: option A)

**Where it sits:** in the composer's locked pickers row, after the agent and folder chips. In rooms it goes after the members chip.

**What it shows:**
- the chat's all-time cost, for example `$1.59`
- tinted like a selected chip (`--sel-*`)
- no chip at all when the chat has no records, never `$0.00`

**The popover it opens:**
- "This chat" and the total
- number of turns, and how much of the total is estimated
- four token boxes: tokens without cache reads, cached input, cache creation, output
- cost per model
- in rooms, cost per member plus Room moderator
- an "Open in Usage →" link to the page filtered to this chat

**Live updates:** the chip updates after each turn while the chat is open.

**Code placement:** formatting, aggregation helpers and chart scaling go in pure modules under `frontend/src/state/`, so they can be tested. Frontend tests have no DOM.

## Edge cases

- **Fork:** the new chat starts at $0. The copied history's cost stays with the original. Exact records belong to the chat that ran them, and estimates skip copied messages by `message.id`. The builder checks with the real CLI that a `--fork-session` file keeps the original `message.id`s. If it doesn't, they find another way to tell copied lines apart (for example `parentUuid` chains or a fork marker) and note it.
- **Upgrade gap:** turns a machine ran on the old build, before this release reached it, become estimates. Turns from the other machine are covered once sync brings their exact records.
- **Edit and Resend:** new turns add to the same chat, and old versions' cost stays.
- **Routines:** runs happen in chats, so they count like any chat. A skipped webhook run has no chat and no cost.
- **Seeded and expired sessions:** a seed turn's cost is recorded like any turn.
- **A failed `--fork-session` cut run** (`FORK_IGNORED`): its result, if any, is still recorded.

## Testing

- **Backend unit tests:**
  - the parser's new result fields (extend the stream fixtures)
  - pricing math, including the 5-minute and 1-hour cache-write split and unknown models
  - estimates against fixture logs: duplicate `message.id` lines, a forked session copying exact and estimated history, a subagent file, a missing file, entries inside an exact record's window skipped, an exact record arriving later (as after a sync) shrinking the estimate by the same amount
  - records saved on result and on moderator runs, and a stopped turn showing up as an estimate
  - user-message records, including the one-time pass over old chats
  - rename rewriting records
- **Sync tests:** union by id for cost and user-message records, and the estimate cache left out.
- **Frontend unit tests:** formatters, breakdown sorting and shares, chart scaling.
- **End to end:**
  - make the fake claude's `result` line carry `total_cost_usd` and `modelUsage`, then check the chip and the page after a turn
  - `e2e:versions` or `e2e:group` style checks for forks and rooms if cheap, using the fake claudes only so no quota is spent

## Left to the builder

- **Store:** the file format and layout, within the constraints above.
- **Estimate cache:** its shape, and whether recomputes read from a saved offset.
- **Chip data:** whether the chip uses `usage:query` or a lighter call.
- **Routing:** whether the page gets its own URL path.
- **Backfill progress:** how it's reported to the UI.
- **Look:** exact spacing and visuals, within the mockups and the existing style tokens.
