# Routine limit and missed-run policies

Two per-routine settings.

## Why

A routine that hits the Claude usage limit stops partway. Today the user waits for the reset and types "continue" in
the chat by hand. And a schedule routine whose time passed while ZumiBot was off always fires one late run, even
when a late run is useless (a morning digest at 3 pm).

## Settings

`Routine.limitPolicy: 'wait' | 'skip'` (default `wait`) and `Routine.missedPolicy: 'run-once' | 'skip'` (default
`run-once`). Stored routines without them read as the defaults (`limitPolicyOf`, `missedPolicyOf` in
`shared/src/routines.ts`), so old files need no migration. Both are set in the routine editor, in a "When things get in
the way" card. The missed policy shows only for a schedule trigger, because manual and webhook routines have nothing to
miss.

## Spotting a limit hit

The CLI emits `rate_limit_event` on every rate-limit status change. A rejected request (HTTP 429) turns the status to
`rejected`, and the event carries `rate_limit_info.resetsAt` in epoch seconds (checked in CLI 2.1.299, and in a real
session log). `streamParser` turns it into a `limited` event. When that turn then ends in an error, `agentTurn` stamps
its error item with `limit: { resetsAt, agent? }` (`agent` only in rooms, where errors carry no author). The item is on
disk, so the runner reads it from the items like every other outcome, and a restart loses nothing.

## Limit policy

`RoutineRunner.settle` reads the stamp:

- **skip:** the run ends `skipped`, `skipReason: 'limit'`. No failure notification.
- **wait:** the run becomes `limited`, with `resumeAt = max(resetsAt + 60 s, now + 5 s)`. It stays active, so it still
  counts toward the 5-run cap and the chat still belongs to the routine for notifications. At `resumeAt` it sends
  `continue` into the same chat, so the agent resumes its own session (in a room `@member continue` for each limited
  member, so the moderator does not pick someone else). The run's `messageId` moves to that message and the run is
  `running` again. A later limit hit waits again, up to `ROUTINE_MAX_LIMIT_WAITS` (5) waits, then the run fails.
- A stamp with no `resetsAt` fails as before. So does any non-limit error.

While a run waits:

- A user message in the chat cancels the wait. The run fails with "Continued by hand", which is silent like other user
  causes.
- Deleting the chat fails it, as before.
- Turning the routine off does not cancel it: the run already started. Deleting the routine drops its runs, and the
  timer then finds nothing to resume.
- A restart re-arms it from `routine-runs.json` (`recover`). A wait that is already due resumes at once.
- Shutdown (`runner.stop()`, next to `scheduler.stop()`) clears the timers but keeps the stored wait, because
  `tasks.shutdown()` would fail a resume that fired then.
- `recover` leaves a wait alone, unarmed and unwritten, when its routine is off. `sync.mjs` switches the local copy of
  every routine off and copies `routine-runs.json` newest-wins. Re-arming a pulled wait would send a second `continue`
  next to the VPS's. Even failing it would make the local file the newer one and overwrite the VPS's record of the
  wait. The local Routines tab still shows the wait, which is true: the VPS is waiting.

The Routines tab shows "waiting for limit reset" on the row and "Usage limit reached · continues today at 14:40" on the
run. A wait does not light the approval dot, because the user has nothing to answer.

## Missed policy

The scheduler already treats a run due more than `LATE_AFTER_MS` (2 min) ago as late, and advances `nextRunAt` as
usual. With `skip`, `RoutineRunner.run` records that late schedule run as `skipped` with `skipReason: 'missed'` instead
of starting it, next to the webhook-condition skip. The scheduler itself is unchanged. Laptop sleep in
Local mode counts as missed too, the same as downtime.

## Calls made by the builder

- Resume text is plain `continue`, matching what the user typed by hand.
- 60 s margin after the reset, minimum 5 s, at most 5 waits per run.
- Skipped runs use the existing `skipped` status (they count toward the 10 kept skipped runs), told apart by
  `skipReason`. A skipped run with no `skipReason` is a webhook condition miss, as before.
- `sync.mjs` needs no change: it carries routine and run fields through unchanged (see the `recover` rule above).
- The card's options are short ("Wait, then continue", "Run once when back"), with a hint line under each.
