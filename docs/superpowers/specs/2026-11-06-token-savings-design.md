# Token savings: true usage numbers, Compact at, cold-cache notice

## Why

ZumiBot chats looked very expensive. The investigation found two problems.

1. **The Usage page counted about 5× the real spend.** On this PC the records summed to $16,445, while the session logs priced
   per request came to about $2,075 (at most about $3,600 counting the sessions that live only on the VPS). A resumed CLI
   restores the session's last `cost-state` line and adds the run to it, so `total_cost_usd` and `modelUsage` in a result are
   the whole session's so far. Forks and cut runs carry the source session's state too. ZumiBot stored that as one turn's cost.
2. **The real spend came from long sessions.** In API-equivalent prices at Opus 5.5 rates:
   - Writing a big context back into the prompt cache when a session resumed after more than an hour idle: 42% ($879 over 246
     resumes, about $3.60 each).
   - Reading contexts of 100K to 966K tokens on every request: about 30%.
   - Output: about 12%.

   Sessions grew to about 966K tokens, because a 1M window makes the CLI compact only near its limit. Daily routines that
   resumed rooms of 500K–700K per member reloaded every member's cache every day. Cache misses inside the hour were rare
   (12 of them, about $29), so ZumiBot's prompts and tools keep the cache prefix stable.

A replay of the logs estimated the savings from compacting earlier: 26% at 600K, 41% at 400K and 46% at 300K.

## Goals

- The Usage page and the cost chip show what each run really cost.
- Each agent can be set to compact earlier. Nothing changes for an agent until the user picks a size.
- Before a message would reload a big, cold context at full price, the user sees that and can compact first or send anyway.

## Non-goals

- Changing models, effort or tools. What the agents can do stays the same.
- Keeping caches warm with pings. A ping costs a request and writes into the session.
- Rewriting old records. The file is synced by id and never shrinks.

## Design

### Per-run cost (`core/usage/costBaseline.ts`)

- Before a resumed run spawns, `createCostBaseline(projectsDir)(sessionId)` finds `<projects>/*/<session>.jsonl` and reads the
  newest `cost-state` line backwards, a 64 KiB chunk at a time. This is the state the CLI is about to restore. It must be read
  before the run, because the run appends its own line when it ends.
- At the result, `minusBaseline` subtracts per model and per token kind, clamped at zero. A model whose usage did not change
  drops out.
- If the baseline cannot be read, the CLI's totals are kept. Counting too much is better than a run that cost nothing.
- Main turns (`ChatService`, including room members, asks and `/compact`) and side runs (`sideRun.ts`) both do this. A seeded
  run resumes nothing and reads no baseline.
- New records carry `v: 2`. An older record that has a session id and no `v` holds session totals. Those records are left out
  of the summary and of the estimator's covered windows, so the session's log is estimated instead. Records with no session
  (the moderator, room handoffs) were always per call and still count as exact.

Verified against the real CLI 2.1.317:
- A plain resume continues the total.
- A run of another session in the same folder in between does not reset it.
- A `--resume-session-at` + `--fork-session` run continues the source session's full total, not the total at the cut point.

### Compact at (per agent)

- The setting is the frontmatter key `autoCompactWindow`, the CLI's own (an integer from 100000 to 1000000).
- The CLI applies that key only when the agent runs as a subagent. For the agent's own runs it reads
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, so `ChatService` passes the key as that env var on every attempt.
- This env var does not change the system prompt or the request shape (checked against the real CLI), so the cache prefix holds.
- Side runs never get it, so a side answer never compacts the forked session.
- Verified against the real CLI: with a 100K window, a 218K session compacted to 19K before its next request
  (`status: compacting`, then `compact_boundary`). ZumiBot already shows those events.
- Agent Studio's **Compact at** card offers Default (no key, the CLI's own point near the window's end), 200K, 300K, 400K and
  600K. A size typed into the raw file shows as "Custom". It was first labelled Auto, renamed because nothing picks a size.
- Zumi Bot gives every new agent a size: 400K by default, 600K for one that ships to production in one long run, 300K for an
  assistant of many small jobs. The key adds nothing to the prompt, unlike the context rules, which only heavy jobs get.

### Cold-cache notice

- Each `ContextUse` now keeps `at`, the time of its last request.
- `coldContexts` lists the contexts that the next message would reload. A context is listed when all of these hold:
  - it is at least 200K tokens;
  - its last request was more than an hour ago (the prompt cache's TTL);
  - it can be compacted;
  - the chat is not running;
  - it is not one the CLI compacts first anyway (its agent's `autoCompactWindow` is below its size).
- Contexts saved before `at` existed fall back to `replyAt`.
- `ColdNotice.tsx` shows the size and how long the context has been idle. It offers **Compact first** (per member in a room)
  and **Dismiss**. Dismiss lasts until that context runs again. The check repeats every minute while the chat is open.

## Calls made by the builder

- Existing agents were set by hand from their logs (400K most, 600K for merge-back, release-manager and localization-manager,
  300K for work-assistant); Zumi Bot sets new ones.
- The notice shows from 200K tokens. Below that a reload costs little.
- The notice shows token sizes, not dollars. Plan users think in limits, and the model price is not always known.

## Rooms: start fresh each run (routines)

Rooms were 69% of the spend in the logs ($1,118 of $1,613), and about 65% of a room's cost was members reloading big
contexts after an idle gap (1–3h 51 times, 3–12h 120, 12–36h 60): each member has its own session and its own cache,
so a daily routine into a room reloads every member that speaks. Member passes ($1) and moderator turns ($35) were not
worth changing.

A routine that posts into an existing chat or room gets **Agent sessions**: *Continue from the last run* (default, as
before) or *Start fresh each run*. Fresh marks the chat, or every room member with a session, `next: {seed: true, fresh:
true}` and drops their meters before the run's message goes in, so each agent starts a new session seeded from the chat's
recent messages (the existing reseed path, capped like any seed) and the chat says "This routine starts fresh each run"
instead of "expired". A daily check reads the board again every run, so the older detail it gives up was not what the
run needed; it stays in the chat.

## Keep warm

Most of a room's cost was members reloading a big context after it idled past the prompt cache's hour. A cache read is a
fortieth of a cache write on Opus, so reading the cache once an hour costs far less than the reload it prevents. On the
logged idle gaps, for contexts of 200K and more, a 12 h window for rooms would have saved $500 of $674 in reloads for
$176 of pings ($324 net), and 24 h $440 net (partly the routine runs that now start fresh). Single chats gained about
$30 at 2–4 h and lost money past 12 h.

- `KeepWarm` (backend `core/btw/keepWarm.ts`) is told about every saved context of a real request. A context of at least
  100K gets a ping 55 minutes after its last request and every 55 minutes after that, until the window ends (rooms 12 h,
  single chats 2 h by default; Settings › General › Tokens). A compaction, a smaller context, a failed ping, an archived
  or A→B chat, or a chat that is gone ends it; a running chat is skipped. At most two pings run at once.
- A ping is `SideQuestions.warm`: the side-question machinery (same base, tools, browser and model, so the prompt prefix
  is byte for byte the main run's) forked from the agent's clean point with `--no-session-persistence`, the side guard
  and the fixed message "Reply with exactly: ok". The session is left as it was; nothing shows in the chat.
- Its cost is recorded as `#keepwarm` ("Keep warm" in Usage), so the pings can be weighed against what they save.
- A good ping moves the context's `at`, so the cold notice measures from the last cache read.
- The schedule is in memory and only covers sessions this server ran: a session synced from the other machine runs there.
- The CLI writes nothing for an unsaved fork (no `cost-state` line), so the next real run's baseline is unchanged.
- Checked against the real CLI (2.1.317, haiku, the side-run probe's arguments): a ping forked at the end of turn 2 read
  the same 64 618 cached tokens the next real turn read. Two sessions were left 66 minutes after their last write; the
  one pinged at minute 10 read all 64 609 from cache on its next turn, the control read only the shared system prefix
  and wrote 25 661 again. So a cache read resets the hour, and an unsaved fork keeps the main session's cache warm.
