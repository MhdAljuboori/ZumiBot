# Spend caps

## Why

Usage already records exact costs, and workflow runs show what they cost, but nothing stops a run on dollars. A For each
over 100 items, a loop pushed on by Retry, or an agent left looping in a routine is limited only by visit caps. The user
asked for caps per run, per routine and per agent per day that pause through the existing Pause and then notify them.
They skipped the design questions, so every choice below is the builder's call.

## Goals

- Three caps, each a USD amount, each optional (absent = no cap, as today):
  - **Workflow run cap** (`Workflow.spendCap`): what one run may spend: its Agent and For each turns and its LLM and
    Condition calls. A sub-workflow is judged by its own cap while it runs; once it ends, its cost is on the parent's visit
    (as the run view shows it) and counts toward the parent's cap.
  - **Routine run cap** (`Routine.spendCap`): what one routine run may spend in its chat or room.
  - **Agent daily cap** (`dailySpendCap:` in the agent file, a ZumiBot-only key): what one agent may spend in a day
    (the page's time zone, `AppSettings.timeZone`, else the server's), across every chat, room, routine and workflow.
- A cap is checked while a turn runs, not only at its end: every model request the agent (or one of its subagents) makes
  is priced from its `usage` as it streams, so a long turn is caught mid-way.
- Reaching a cap uses the existing Pause on every turn it covers (the agent wraps up, running subagents finish), stops
  anything new from starting under it, and sends a notification.
- Going on is always the user's explicit act and allows one more cap's worth: Resume in a capped chat, **Continue** on a
  capped workflow run, or **Allow more today** for an agent. The new limit is what was spent so far plus the cap.

## Non-goals

- No hard kill: a request already sent is paid for, a subagent already running finishes, a bare call (LLM, Condition)
  or an HTTP request already out completes. A cap overshoots by at most what was already in flight.
- No cap on side questions, keep warm, the moderator or a room handoff: they are small, never loop, and count toward
  nothing but an agent's day (side questions and keep warm only, through the usage records).
- No global (all agents) cap, no weekly or monthly caps.
- The user's own messages are never refused: a typed message to an agent past its daily cap runs (the user chose it).
  Only automatic starts (routine runs, workflow Agent and For each steps) are held.

## How spend is measured

- **Live.** `streamParser` turns each `assistant` line with `usage` (the agent's own and its subagents') into a `spend`
  event `{id, model, tokens}` priced with `priceMessage`. The CLI writes one line per content block with the usage so
  far, so ChatService keeps the highest price per message id and reports only the growth. Codex: each
  `thread/tokenUsage/updated`'s `last` (main thread and children) is priced with `priceCodex`. An unpriced model adds 0.
  ChatService hands each growth to `SpendCaps.live({chatId, agent, attempt, usd})`.
- **Exact.** When a run's result reports its cost, `onRunCost` already feeds Usage and the workflow run. After those
  writes land, `SpendCaps.settled(attempt)` drops that attempt's live estimate and checks again, so an estimate is
  never counted next to the exact figure. An attempt that ends with no cost drops its estimate too (the log estimate
  later fills the agent's day).
- **Totals.** Workflow run: `runCostUsd(run)` (exact, visits) plus the live estimates of its chats. Routine run: the new
  `RoutineRun.costUsd` (exact turn costs while the run is open in its chat) plus live. Agent day: `UsageService.agentSpend`
  (exact v2 records and log estimates of that agent since the day's start) plus live.

## What happens at a cap

- **Workflow run.** The run gets `capHold {kind: 'run', at, spentUsd, limitUsd}` in one write: nothing new starts (no
  step, no For each item), running Agent and For each chats of the run are paused with the cap as the cause, and the run
  reads `waiting`. The run view shows a banner ("This run reached its $5.00 spend cap · $5.04 spent") with **Continue
  (allows $5.00 more)** and Stop. Continue sets `capLimitUsd = spent + cap`, clears the hold, resumes the chats the cap
  paused and starts what the inboxes allow. Resume in one of those chats does the same for the whole run.
- **Routine run.** The run's chat is paused with the cap as cause. The run lands `paused` as today and is marked
  `capped`; Recent runs reads "Paused at its spend cap ($5.04 of $5.00) · press Resume in its chat to continue". Resume
  sets the run's `capLimitUsd = spent + cap` and carries it on (the existing `chatResumed`).
- **Agent day.** Every running turn of that agent is paused (single chats, rooms where it is working; never an A→B
  chat, which cannot pause), and the day is marked tripped (in `spend-caps.json`, so a restart neither forgets nor
  pauses again). While the agent is over its limit, a routine run that would start it is skipped (`skipReason: 'cap'`)
  and a workflow run about to start an Agent or For each step on it is held (`capHold {kind: 'agent', agent}`), its
  Continue allowing the agent more for today. Resume in a capped chat, Continue, or **Settings › Usage › Spend caps ›
  Allow more today** raises that day's limit to spent plus the cap.
- **Pause text.** A cap pause stores `ChatMeta.pauseCap {scope, label, spentUsd, limitUsd, capUsd}` with `pausing`.
  The pause flag file holds `cap`, and the hook then tells the agent "A spend cap paused this task" instead of "The user
  paused". The landed notice reads "Spend cap reached: <label> spent $X of its $Y cap. Press Resume to continue; it
  allows $Z more." A user's own Pause, Resume, message or edit clears `pauseCap` as it clears `pause`.
- **Notification.** A new payload kind `spend-cap`, sent under the existing *needs you* (`waiting`) toggle, titled with
  the workflow, routine or agent and with the amounts as its body. A click opens the chat, or the run. One per trip.

## Settings

- Routine editor › How each run goes: **Spend cap per run** (USD, empty = none).
- Workflow trigger inspector: **Spend cap per run**.
- Agent Studio: **Daily spend cap** (writes or removes `dailySpendCap:`).
- Settings › Usage: a **Spend caps** list of agents with a daily cap, today's spend, the limit, and Allow more today
  while one is over.
- Amounts: more than 0, at most 10 000, cents. Zumi Bot's routine and workflow formats take `spendCap` too; it sets one
  only when the user asks.

## Calls made while building (the builder's, for review)

- A step visit or For each item a cap paused is marked `capPaused`, so the run view says "Paused at a spend cap" instead of
  "Paused by you"; Resume clears it with the pause.
- A stopped run drops its hold; an ended run never keeps one.
- `spend-caps.json` is per machine and never synced: each server pauses only the turns it runs, and a day tripped on one
  machine is judged again on the other from the synced usage records.
- A cap's notification is skipped while someone has the chat on screen (its notice already says it), as other chat events are.
- Routine runs now show their cost in Recent runs, since the run cap needs it anyway.
- `e2e:caps` drives an agent's daily cap and a workflow run's cap end to end with the fake claude.
- Each live estimate names the user message its turn answers. A routine run counts only its own turn (the one answering the
  run's message, also after a Resume or a usage limit's continue), and a workflow run only its steps' and items' turns, so
  the user's own turn in such a chat is never charged to the run or paused for it.
- An automated turn (a run's message) that starts while its run is held, or while its agent's day is tripped (a usage limit's
  continue), pauses on its first request; the user's own turns run on.
- The estimate of an attempt goes as its exact cost arrives, and the agent's day is judged again once that cost is stored,
  since the request that crossed may have been the turn's last.
- Continue resumes only what that hold paused (its run's cap, or the held agent's day), and a chat still wrapping up as soon
  as its pause lands. Continue on an agent's hold whose cap was removed, or whose agent was renamed, still lifts the hold.
- A routine run is marked `capped` only once its chat was actually paused.

## Limits

- Prices come from the API list price table, as Usage's estimates do; a plan subscription is not billed per token, so a
  cap there is a budget on equivalent API cost.
- A request is priced when its line streams, so one long request can overshoot. Subagents run on after a Pause until
  they end, as with the user's own Pause.
- The agent day's log estimates are only refreshed after a turn ends without a cost, as Usage does today.
