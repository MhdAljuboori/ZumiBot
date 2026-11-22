# For each concurrency and saved history for workflows and routines

## Why

1. A For each step runs its items strictly one at a time. A list of 36 items that each take five minutes takes three
   hours. Running two or three at once cuts that to an hour or 90 minutes.
2. Workflows and routines keep no history. Undo lives only in the open tab, and a save (the user's, or Zumi Bot's
   through its tools) overwrites the definition with no way back.

The user asked for both and skipped the design questions, so the calls below are mine.

## Part 1: For each concurrency

**Setting.** A For each step gets `concurrency?: 2 | 3`. When the key is absent the step runs one item at a time, as
before, so older workflows, run snapshots and Zumi Bot's saves keep working unchanged. `concurrencyOf(step)` reads it.
The inspector's **Run at once** select offers `1 (one after another)`, `2` and `3`. The parser keeps a number between 1
and 3 (rounded), and stores only 2 or 3. Zumi Bot's authoring format accepts `concurrency: 1 | 2 | 3`.

**Engine.** One shared pure helper, `startPending(items, room, now)`, marks up to `room` pending items running, in list
order. The visit's opening write starts up to N items. When an item ends, the same write starts pending items until N
are open again, and the visit ends only once no item is open or pending. With several items open, the visit is
`waiting` while any of them waits on a card, else `running`. `goOn` (a crash between items, an empty list) and
`recover()` follow every open item (resent or followed, as one item is today), then fill the free slots.

Everything else is per item already, and stays that way: each item's chat, card, usage-limit wait, cost, Stop and
Retry. A Retry reruns the failed items up to N at once.

**Pause.** Pausing one item's chat holds that item's slot until Resume. The other slots carry on and start the next
items. With N = 1 nothing changes: the paused item blocks the rest.

**Progress.** `RunProgress` gains `running` (how many items are open) when more than one is. `current` is the first open
item in list order, and `paused` is set when any open item is paused. The text stays `2 / 3 · beta` for one open item,
and reads `4 / 36 · 3 running` for several.

**Limits (accepted).** Items share the agent. An agent's browser and desktop serve one turn at a time, so items that use
them wait for each other. Three items at once spend usage three times as fast. Run step still tests the first item only.

## Part 2: Saved history

**What a version is.** A version is the definition only. For a workflow that means name, time zone, trigger, steps,
edges, notes and groups. For a routine it means name, time zone, trigger, target, prompt, command and the three policies.
On/off, `nextRunAt` and the timestamps are left out, and so is a webhook's `sample`, which is a real caller's body that
the server replaces with the hook's latest call on every save anyway. `workflowDef`/`routineDef` (shared) build it with a
fixed key order, so two versions compare by their JSON.

**When one is kept.** Every save through `workflowEditing.save` and `routineEditing.save` records the saved definition
(the editor's saves and Zumi Bot's tools both go through them). A save that leaves the definition unchanged, such as a
change to on/off only, keeps nothing. When the stored history is empty, or its newest version differs from the
definition being replaced (a workflow saved before history existed, a copy Duplicate made, or anything else that wrote
around a save), that older definition is kept first as an `earlier` version, dated by its `updatedAt`. Each version
records its `source`: `editor`, `zumi-bot`, `restore` (with `restoredFrom`, the restored version's time) or `earlier`.

**Storage.** One file per item: `<data>/history/workflows/<id>.json` and `<data>/history/routines/<id>.json`, holding
`{v: 1, versions}` newest first. Each id passes a strict pattern before it becomes a path. Each file is kept to 50
versions and 2 000 000 characters of JSON (the newest always stays). Deleting a workflow or routine deletes its file. An
agent rename rewrites the names inside the files, after routines and workflows, caught and logged. A failed history write
is logged by its code only and never fails the save, which has already landed.

**Sync.** `routines.json` and `workflows.json` come from the VPS on every sync, so `history/` does too: the VPS's files
replace this PC's (the backup folder keeps the old ones).

**RPCs.** `workflows:history id` and `routines:history id` return summaries, newest first:
`{id, savedAt, source, restoredFrom?, current, changes}`. `changes` lists what that version changed against the one
before it ("Renamed", "2 steps added", "Step “Summarize” changed", "Layout changed", "Prompt changed", …), and `current`
is true when the version equals the saved definition. `workflows:version id versionId` and
`routines:version id versionId` return one version's definition. `workflows:save` and `routines:save` take an optional
second argument `{restoredFrom?: number}`.

**UI.** The ⋯ menu of both editors gets **History…** (disabled for a workflow or routine that was never saved). It opens
`HistoryDialog`: one row per version, with when it was saved, who saved it ("You", "Zumi Bot", "Restored from …",
"Earlier version"), its changes, a **Current** tag, and **Restore** on every other row. Restore loads that version into
the editor as unsaved edits and keeps the current on/off and id. A webhook keeps the hook's latest call. A notice then
says "Restored the version from <time>. Save to keep it." Nothing is written until the user saves, so Discard changes
takes it back. In the workflow editor the restore is one undo step. In the routine editor, which has no undo, a restore
over unsaved edits asks first. The next save is recorded with source `restore`.

## Non-goals

- Restoring a deleted workflow or routine. Delete removes the history along with the item.
- A side-by-side diff view. The change list plus loading the version onto the canvas does that job.
- History tools for Zumi Bot.
- Versioning on/off switches or run history.
