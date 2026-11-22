# Protocol engines (ACP and AG-UI)

**Status: Phase 0 design approved; Phase 1a (the seam completion) built, see [Engines](engines.md), Phase 4; Phase 1b, the
ACP engine, built** (see "Phase 1b as built" below): the runner, the engine in `ChatService`, launch trust, the UI's reads of
the new caps, Agent Studio's ACP card with Test, and rooms. It is checked by unit tests and by `e2e:acp` through the UI, both
against the fake agent written from the spec, and by `smoke:acp` against a real agent, claude-agent-acp 0.108.0 (2026-11-18,
all four steps PASS: Save and Test, a chat, a write behind an approved card, Stop with nothing left). Gemini CLI and opencode
are not run. **Phase 2, the AG-UI engine, built** (see "Phase 2 as built" below): the client and runner over HTTPS + SSE,
the engine in `ChatService` with its thread file, launch trust for endpoints, the remote chip and the automatic-pick gates,
Agent Studio's remote card with Test, and sync. It is checked by unit tests and by `e2e:agui` through the UI, both against the
fake server written from the spec, and by `smoke:agui` against a real server, a scripted Pydantic AI 2.65 server on loopback
http (2026-11-18, all four steps PASS: Save and Test, a chat, an approval answered on its card, Stop during a remote tool).
TLS to real hosts was checked the same day with `smoke:agui` (see Honest limits). Each phase stops for review.

## Intent

ZumiBot runs agents on two engines it knows well: Claude (`claude` CLI) and Codex (`codex app-server`). This work lets it run
agents it has no built-in engine for, through open protocols:

- **Agent Client Protocol (ACP)** for *local* agents ZumiBot spawns as subprocesses, such as Gemini CLI and opencode.
- **AG-UI** for *remote* agents served over HTTPS.

Claude and Codex keep their own engines. Zumi Bot, a room's moderator and the room summary stay on Claude.

**Goals**
- A protocol agent is chosen per agent file, like Codex.
- It runs through the same chat, queue, approval and notification paths as a Claude or Codex agent.
- Every feature it lacks is hidden through `EngineCaps`, never shown and then failing.

**Non-goals**
- Replacing Claude or Codex with their ACP adapters.
- ACP v2 (still a draft) and the unstable v1 methods.
- Interactive sign-in from ZumiBot: the agent's own CLI login is used.

**Anti-goals** — any of these is a failure even if chat works:
- Any "allow everything" path, whether by a flag, a mode or an adapter auto-answer.
- A protocol agent's command or endpoint set by anyone but the user.
- A session id of one engine handed to another.
- A secret in a log, URL or error message.
- A remote agent receiving local tools, files, vault keys or the desktop without a design that names a safe way.
- Any change to Claude or Codex behaviour.

## Sources checked (2026-11-17)

Every protocol claim below comes from a source read for this design, not from memory. The ACP and AG-UI rows were also
spot-checked against the shipped schemas.

| What | Version / date | Where |
| --- | --- | --- |
| ACP spec v1 (stable) | schema v1.32.0 | agentclientprotocol.com `/protocol/v1/*` (transports, initialization, authentication, session-setup, prompt-turn, tool-calls, elicitation, file-system, terminals, session-modes, session-config-options, cancellation, error) |
| ACP SDK | `@agentclientprotocol/sdk@2.7.0` (2026-11-14, Apache-2.0) | `schema/v1/schema.json`, `schema.unstable.json`, `schema/v2/*`, `dist/` |
| ACP RFDs | Draft | `/rfds/session-fork`, `/rfds/session-cursors` (landed upstream 2026-11-16, after SDK 2.7.0) |
| ACP agents | protocol matrix generated 2026-11-17 | github.com/agentclientprotocol/registry `.protocol-matrix/latest.*`, `<id>/agent.json`, and each agent's own source |
| AG-UI spec | 1.0 (normative; 1.1 is a draft) | docs.ag-ui.com `/spec/1.0/*` and `schema.json` |
| AG-UI SDKs | `@ag-ui/core@1.0.4`, `@ag-ui/client@1.0.4` (MIT) | npm tarballs |
| AG-UI servers | Pydantic AI 2.69.0, `ag-ui-langgraph` 0.0.47, others | vendor docs, ag-ui repo `integrations/` |

Concept pages on docs.ag-ui.com still call interrupts a draft and describe `parentRunId` as branching. The 1.0 spec pages
contradict both, and this design follows the spec.

## What exists, and what a third engine still needs

**The seam exists** (see [Engines](engines.md), phase 2):
- `core/engines/engine.ts` has `EngineAdapter<Config>` (`engine`, `caps()`, `locate()`, `start(turn, config) → RunHandle`),
  `TurnStart`, `TurnAction`, `EngineTurn`, `RunHandle` and `RunOutcome`.
- `RunEvent` (`core/chat/streamParser.ts`) is the neutral event vocabulary, and the Codex mapper already writes it.
- Both runners sit behind the adapter. `EngineCaps` has 13 flags.

**It is not yet safe for a third engine.** About 70 sites in `backend/src` still test the engine by name. 40 of them are in
`core/chat/chatService.ts`, and almost all are a binary `onCodex ? codexThing : claudeThing`. Add `'acp'` to `Engine` today and
every such site silently treats an ACP chat as Claude. An ACP turn would then get:
- `claudePause` settings and `vaultGuard` settings;
- the Claude cost baseline and the thinking probe;
- `CLAUDE_CODE_TMPDIR` and `cut` stamps;
- `CLI_NOT_FOUND`, and finally `this.claude.start(...)` with a `claude` binary.

`engineCaps` has the same trap (`engine === 'codex' ? CODEX_CAPS : CLAUDE_CAPS`), as do `engineOfAgent` and the frontmatter
parser (`provider === 'codex' ? 'codex' : null`). An agent file saying `provider: acp` on today's build runs on Claude.

**Phase 1a — seam completion, its own change, no behaviour change.**

1. *Make every engine decision exhaustive.*
   - Each `onCodex` / `=== 'codex'` / `=== 'claude'` site in `backend/src`, `shared/src` and `frontend/src` becomes one of:
     a cap read; a read of a per-engine trait record typed `Record<Engine, …>`; or a `switch (engine)` ending in `assertNever`.
   - Adding a member to `Engine` must then fail `npm run typecheck` at every place that has to decide.
   - `engineCaps` becomes a `Record<Engine, EngineCaps>` lookup.
   - `engineOfAgent` and the frontmatter parser read `provider` through one `parseProvider` that still returns only
     `'codex' | null` in 1a.
2. *Per-engine run traits.* The facts `agentTurn` asks by name move into `ENGINE_TRAITS: Record<Engine, EngineTraits>` in
   `core/engines/`:
   - whether a session's result cost is cumulative (Claude's cost baseline);
   - whether assistant messages carry `cut` stamps;
   - whether a turn declares its dropped turn;
   - whether the thinking flag is probed;
   - whether the agent's extension run config applies;
   - whether `CLAUDE_CODE_TMPDIR` is set;
   - whether compaction sizes are reported;
   - the session mark it writes;
   - the not-found, exited and fork-ignored texts.
3. *Per-engine attempt building.*
   - The Claude-only part of an attempt (pause settings, vault guard, extensions config, tmp dir, thinking, drops) and the
     Codex-only part (hooks, trust, key filter, compact limit) move out of the body of `agentTurn` into one function per engine.
   - `agentTurn` picks the function in one exhaustive `switch`.
   - The adapter registry (`Record<Engine, EngineAdapter<…>>`) replaces `onCodex ? codexRun(…) : this.claude.start(…)`.
4. *Deliberately left as names.* Zumi Bot is Claude by name (`automationTurns`), as are the moderator and the room summary.
   These become explicit `engine === 'claude'` tests, not caps.
5. *New caps: moved to 1b.* The new caps below (`resend`, `fork`, `cost`, `models`, `remote`, `bridges`) land in 1b, together
   with the first engine that sets them false and the UI that reads them. Added in 1a they would have been read nowhere, and a
   gate nothing exercises is a gate nobody has checked.

1a passes when every existing test and fixture passes unchanged apart from imports, and `npm run typecheck` is clean. A scratch
commit that adds `'acp'` to `Engine` must then fail typecheck everywhere a decision is due. That commit is only a check and is
never kept.

## Approaches considered

| Approach | Trade-off | Verdict |
| --- | --- | --- |
| **A. Two new `EngineAdapter`s** (`acp`, `ag-ui`) behind the completed seam, each mapping its protocol onto `RunEvent` | `ChatService`'s queue, versions, approvals, notifications, routines and rooms work unchanged. Costs the 1a refactor first. | **Chosen** |
| B. A sidecar that translates each protocol into Claude stream-json, so ZumiBot sees a fake `claude` | No `ChatService` change, but every cap would lie: the hidden flags, hooks and control protocol mean nothing to the sidecar | Rejected |
| C. A separate, smaller chat path for protocol agents | Isolated, but duplicates the queue, versions, approvals, notifications, routines and rooms, which then drift | Rejected |
| D. Run Claude and Codex through their ACP adapters too | One engine, but loses stable rewind at a point, Pause, the vault guard and plan cards, and the brief rules it out | Rejected |

**Client libraries.** Both protocols get hand-written clients: no SDK at runtime and **no new dependency**.
- **ACP.** The ACP SDK (2.7.0, zero runtime deps, zod peer, bundles cleanly) validates every message with zod and has churned
  from 2.0 to 2.7 in about three weeks, replacing `ClientSideConnection` with a new builder API. Strict validation would make
  ZumiBot refuse the slightly off-spec messages real agents send. Hand-written follows the repo's own precedent: `codexRpc.ts`
  and `codexEvents.ts` read Codex defensively, field by field, and `sanitize.ts` builds rows from an allow-list.
- **AG-UI.** `@ag-ui/client` needs `rxjs`, `uuid`, `fast-json-patch`, `untruncate-json`, `compare-versions` and protobuf
  packages. It also sets no redirect policy and no timeout, and has no total size cap: all three are things Phase 2 must own.
- **The cost of hand-writing.** About 300 lines per protocol of framing and defensive readers. The fake agent and fake server,
  written against the spec, keep them honest.

## ACP engine (Phase 1b)

### Phase 1b as built

- **The engine.** `'acp'` is an `Engine` and a `Provider` (`parseProvider` reads `provider: acp`), labelled **ACP**, with
  `ACP_CAPS` (the capability table's column: only `files`, `rooms` and `questions`) and its own refusal sentences
  (`ACP_REFUSALS`). The six new caps are on every engine; Claude and Codex have all of them but `remote`.
- **A turn** (`ChatService.agentTurn`, every `switch (engine)` has its `acp` case). Each attempt reads the agent file
  (`AgentStore.acpOf`: body and `acp:`), then refuses before spawning, with a fixed `ACP_TEXT` sentence:
  - no `acp:` (or one that does not parse): `noCommand`;
  - a refused argument: `refusedArg(flag)`;
  - a launch not confirmed in Agent Studio on this machine (launch trust): `untrusted`;
  - a command `acpLocate` cannot find on the run env's PATH: `notFound(command)`;
  - an `authEnv` name the agent is not granted (or a Vault that cannot be opened): `authEnvMissing(name)`.

  The env is the run env plus the `authEnv` keys only (the runner strips every `ZUMIBOT_*`), and every granted value is in
  the scrub map. No bridge is made (`bridges` off: to-dos, vault list, ask, browser and processes), and no bridge paragraph or
  board note is added. The body and the turn's system text go in `systemPrompt`. No model, effort, tmp dir, pause or side base.
  A prompt reached the agent once a session started, and `missingSession` reseeds once, with the `expired` notice. An agent
  that advertises neither `session/resume` nor `session/load` sets `noResume` beside it: every turn then reseeds as a matter of
  course, with no notice (`reseed(null)`), and Test's Sessions row says so ("Each turn starts a new session and resends the chat
  so far"). A turn records `sessionEngine: 'acp'`.
- **Modes before the session is known.** Until the start's answer gives the session, only a `current_mode_update` or a
  `mode`-category `config_option_update` counts, whatever session it names (`modeReport` in `acpEvents.ts`); text and tool
  updates there are dropped. During a load's replay a mode is history the session may have left, so only the last replayed mode
  (and each option's last value) is kept, and checked with the answer when the answer names none (`modes.currentModeId`,
  `configOptions`); outside a replay a mode is checked at once. The replay ends on the line that answers the load (`AcpRpc`'s
  `onSettle`, run inside `receive`), not on the await after it, so a mode sent right after the answer in the same chunk is
  checked too. A refused mode's sentence ends with the way forward ("Start a new chat, or change the mode in the agent's own
  settings"), since a resumed session keeps that mode and every later turn of the chat refuses too.
- **Attachments.** An image goes as an `image` block when the agent takes images (`promptCapabilities.image`), else the send is
  refused with `ACP_TEXT.noImages` ("This agent cannot take images."). Any other attachment reaches the agent as it does a
  Codex agent: its path in the message's `<attachments>` note (`withNote`), for the agent to read with its own tools.
- **Tool ids.** A `toolCallId` is unique only within a session, and every attempt is a new process (a reseed a new session)
  whose plan rows count from `acp-plan-1` again. So the runner prefixes every tool id it emits (`toolUse.id`,
  `toolResult.toolUseId`, a card's `toolUseId`) with the attempt's request tag, as it does request ids; the mapper keeps the
  agent's own ids. A later turn reusing an id never patches, or places a card after, an earlier turn's row.
- **Approval cards.** The permission event carries the classified tool name and input, not `rememberable`, so `ChatService`
  re-judges it with `acpRememberable` (`core/acp/acpTools.ts`, the same rule as `classifyTool`). A card no rule may hold (an
  `AcpCall`; an `AcpEdit` whose paths leave the chat's folder or worktree; any `move`, marked `move: true` on its input, since
  its destination may sit in a `rawInput` key nothing reads) skips chat memory, the agent's rules and workflow step rules, is
  stored with `onceOnly: true` (the card then offers Allow once and Deny only), and any allow is kept as Allow once. The risk
  hint still runs for it.
- **Rows wait until a call can be named** (`AcpEventMapper`). claude-agent-acp 0.108.0 announces every call as
  `tool_call {kind, title, status: 'pending', rawInput: {}}` and sends what it does only in later `tool_call_update`s (a
  Bash's `{command}`, an edit's `{file_path}` and `locations`, then its `diff`), so a row named at the first `tool_call` was
  `AcpCall` forever. The row's `toolUse` is emitted on the first of: a non-empty `rawInput`, `locations` or `diff` content
  that names a classified tool (Bash with its command, an edit, a read or search, a fetch; claude-agent-acp sends `rawInput`
  one top-level field at a time, so an `AcpCall`, such as an MCP tool, Task, or an execute whose first field is not the
  command, is never opened on input and shows its input as it stands at the next trigger);
  a status of `in_progress`, `completed` or `failed`; a `session/request_permission` for the call (`mapper.show(id, toolCall)`,
  named from the call merged with the request's fields, as the card is, so the card lands after its row); the turn's end
  (`turnEnd`, then closed as unfinished like any open row). The call still ends the open text run where it arrives. Once
  emitted, the row's name and input stay fixed, so a result never disagrees with its row.
- **Files.** `FileTracker.ownAcp` turns an `AcpEdit` result's `acpDiffs` into one `FileChange` per path, with exact before
  and after copies or none. Each path's file is read once, the read started before anything is awaited, and the disk tells
  a whole file from a hunk:
  - *A whole file* (one diff whose `newText` is the file on disk): both copies come from the diff. When the disk is exactly
    `newText` plus `\n`, the agent cut the file's last newline (claude-agent-acp joins the file's lines), so the after copy is
    the disk text and the before is `oldText` plus `\n` (only for a non-empty `oldText` whose CR ending matches `newText`'s):
    no false "no newline at end", and Restore's sha256 check matches the file.
  - *Hunks* (claude-agent-acp's diff of a longer file: the changed lines with three lines of context, one `diff` per hunk),
    handled as a subagent's `Edit`: the disk is the after copy, and the before is rebuilt with `rebuildBefore`, putting each
    hunk's `oldText` back in the one place its `newText` is, last hunk first. A lone hunk may also be settled by an earlier
    kept copy of the file. A hunk whose `newText` is not found exactly once, or a null `oldText` among hunks, leaves the
    before null (`unrebuilt`, as a Codex patch that does not fit) with a lone hunk's strings as the `snippet`. A binary or too
    big file keeps neither copy. Fragments are never kept as whole files.
  - *A new file* (no `oldText`: claude-agent-acp's `oldText` is null only when the old file had no lines, so the text is
    whole): the text as sent, whatever the disk says. Any other diff whose file cannot be read (moved or deleted at once, not
    a regular file) keeps neither copy (`unreadable` after, `unrebuilt` before), with a lone hunk's strings as the `snippet`:
    a hunk kept as a whole file could be written over the whole file by Restore.
- **The whole process tree ends with the attempt** (`core/acp/procTree.ts`). claude-agent-acp runs the Claude CLI in its own
  group, but the CLI's Bash shells, its hooks and some MCP servers' children run in sessions of their own, so a group kill left
  `/bin/bash` and `sleep` running in the chat folder. On every end path (the turn's normal end before stdin closes, Stop before
  `session/cancel`, every SIGTERM and SIGKILL, the agent's exit, a refused mode, a crash, the line cap, an unreadable reply,
  and the Test's teardown), the runner and the probe first snapshot the agent's descendants from `/proc` (each
  `/proc/<pid>/stat`'s ppid link, from the agent, from every process already seen that still runs, and from whatever is left in
  the agent's session, which only its descendants can be in), then signal each process once, through its group (by its pid
  only when that group may not be signalled), then the agent's own group unless the tree reached it already. SIGKILL follows
  the force grace after the SIGTERM on every path, so a command can clean up (a git `index.lock`): once the agent has exited,
  `done` resolves at once and a one-shot timer, left ref'd so it fires even when nothing else holds the event loop, sends it.
  A pid is signalled only while its start time is the one seen (never a reused pid), and never pid or group 0 or 1, nor the
  server's own group. Once the agent is gone, its group is reached only through a member the tree verified (a pid stays
  taken while it names a live group, so such a group is still the agent's). Where `/proc` cannot be read (not Linux), only
  the group kill runs, and on Windows (`taskkill /T` by the agent's pid) only until the agent exits: Windows gives a freed pid
  to the next process at once, so a later one could end a stranger's tree (`signalChildGroup` in `core/procKill.ts`).
- **Launch trust.** `core/acp/launchTrust.ts` (`LaunchTrust`: `confirm`, `check` → `ok` / `changed` / `none`, `confirmed`,
  `rename`, `remove`, `agents`) keeps `<data>/protocol-launch.json`. Writes are queued, so calls take effect in the order made,
  and memory changes only once a write lands; a file that cannot be read trusts nothing and is never replaced (a remove or
  rename with nothing to change is then no failure). A rename moves the old name's entry over the new one's, and changes
  nothing when the old name has none: Agent Studio's Save may already have confirmed the new name before the agents-folder
  watcher's rename of the same file. `agents:save`
  rejects a save holding a refused argument before writing, then (queued before any await) moves the entry on a rename and
  confirms the saved launch, or drops the entry when the save is no longer an ACP agent with a launch. `agents:trash`, the
  agents-folder rename and removal pipelines, and the start-up sweep (`remembered`) move or drop entries. `sync.mjs` never pulls
  or pushes the file.
- **Agent Studio's loadout card** gets no probe for an ACP agent: every section shows `EXT_TEXT.acpUnsupported`. The editor no
  longer shows it for one (`studioCards`: the loadout follows `bridges`); the ACP card carries that sentence instead.
- **Agent Studio's ACP card** (`AcpCard.tsx`, pure rules in `state/acpCard.ts`). The Engine select names it **ACP agent**, and
  picking it shows the card at once. `studioCards(engine)` hides the model choices (`models`), Compact at (`compact`), the
  daily cap (`cost`), the loadout and browser (`bridges`), memory (`memory`) and the desktop (`desktop`); the tools card stays
  Claude-only (no cap: only Claude's CLI takes a `tools` list).
  - **Command, Arguments (one per line, trimmed, blank lines dropped) and Sign-in keys.** The draft stays as typed while the
    form holds the launch it makes; a draft that makes none (no command) writes `acp: null`, so Save is refused rather than
    saving the last launch while the card shows another. Sign-in keys are the env names of API keys granted to the saved agent
    (`vault:list`, never a value), plus any listed name no longer granted, so it can be removed.
  - **Validation** (`validateFields(fields, acpReadable)`, used by the editor and `AgentStore.save`): an ACP agent needs a
    command (`ACP_TEXT.commandRequired`); a file whose `acp:` does not parse gets `launchUnreadable`, which says to quote a
    number such as `"8080"`; a caller's launch that `serializeAgent` would drop is refused (`acpLaunchError`), and so is a
    refused argument. `-f` and `--force` get their own sentence: some agents (cursor-agent) read them as running commands
    without asking.
  - **Launch trust in the editor.** `agents:acpLaunch(name)` returns the launch Save confirmed on this machine (or null). The
    editor asks for the saved name's whenever the form's engine is ACP (`confirmedLaunchName`), so a file that kept an `acp:`
    while on another engine shows "not confirmed" once switched back. `launchCompare` shows it beside the form's when they
    differ, with what Save confirms: in the ACP card, and over the Raw view's textarea (`LaunchCompareNote`), since Save
    confirms whatever launch the file holds in either view. When the saved file's launch is not the confirmed one
    (`confirmPending`: changed outside Agent Studio, or never saved here), Save is on with no edit and writes the file as it
    is, which confirms it.
- **`agents:testAcp(name)`** (`core/acp/acpTest.ts` over `core/acp/acpProbe.ts`). The name is checked as `agents:save` checks
  it. It reads the saved file as a run does and refuses in the run's order (not an ACP agent: `notAcp`; `noCommand`;
  `refusedArg`; `untrusted`; `notFound`; then `authEnvMissing`), so it never runs a command from the browser. `probeAcp`
  spawns the launch detached in a new empty temp folder with the run env (every `ZUMIBOT_*` stripped) plus the agent's
  `authEnv` values, sends one `initialize` with the run's capabilities and client info, answers any agent request `-32601`,
  then ends the tree (SIGTERM now, one SIGKILL 2 s later, after the answer is returned) and removes the folder; 20 s deadline. It
  never sends `session/new` or `authenticate`. The answer is `agentInfo`, `protocolVersion`, `loadSession`, `resume`,
  `systemPrompt`, `image` and `authMethods` (names, and for a `type: terminal` method the agent's command with that method's
  arguments), read as the runner reads them, plus `caps` and `hidden` (`missingFeatures`, now in `shared/src/engine.ts`),
  scrubbed of the agent's key values; every failure is a fixed `ACP_TEXT` sentence (`notStarted`, `testTimeout`, `stopped`,
  `protocol`, `unreadable`, `notSignedIn`, `testRefused`). Tests of one agent's one launch made together share one probe
  (keyed by the name and `launchRecord`), so a Test after a Save of another launch gets its own. Test is on only for a saved
  ACP agent with no unsaved change to its launch (`acpTestBlocked`), and the card drops an answer whose saved name or launch
  changed since the press (`acpTestKey`).
- **Zumi Bot** writes `provider: acp` only when the user asks for an ACP agent, never writes, changes or removes `acp:`, and
  tells the user to set the command in Agent Studio (format, creating, editing and make-friendly rules). Each Codex carve-out
  has its ACP twin: no `autoCompactWindow` (creating, Keeping context small, make-friendly), no `AskUserQuestion` or
  `multiSelect` by name in the asking section, no `Agent` tool or subagent lines, and no `tools` list added. A switch to ACP
  removes `model` and `dailySpendCap` (a daily cap is refused without `cost`).
- **Cost.** No USD cost is recorded for an ACP turn in 1b (`cost` off; a per-session baseline is needed first).
- **Checked.** `e2e:acp` (`zumi-bot-server/e2e/acp.e2e.mjs`, the harness's `fakeAcp` shim, fakes only) goes through the UI:
  the agent made in Agent Studio (Save refused without a command and with `--yolo`; the Save confirms the launch; Test sends
  `initialize` only); a streamed chat over the run's exact capabilities and `systemPrompt`; a card allowed once and one denied;
  a question answered; no Edit, Resend, Fork or version switcher (and the handlers refuse them); Stop with a card open, after
  which neither the agent nor the child in its group runs; a crash; a reseed after a failed `session/load`; a refused launch
  after an outside edit, confirmed again by Save; a room with an ACP member. `npm run smoke:acp` runs a real agent named by
  `ZUMIBOT_SMOKE_ACP` (see [E2E](e2e.md)); against claude-agent-acp 0.108.0 all four steps pass. Its first runs found the
  leaked shells (the tree kill), the late `rawInput` (row naming), the hunk diffs, and the agent starting in the user's `auto`
  mode (the asking mode, see Modes).
- **Where the new caps are read** (the UI hides, the handler refuses with the engine's fixed sentence; neither tests the name):
  - `resend`, `fork`: `MessageList` takes `chatCaps` and drops Edit, Resend, Fork and the version switcher;
    `chats:edit`, `chats:resend`, `chats:switchVersion` and `chats:fork` go through `refuseWithout` (`RefusedCap` has `resend`
    and `fork`). In a room both hold only for every member, like `pause` (`chatCaps` and `refuseWithout` agree). The chat's
    chat's pickers row (and a room's) carries an "i" button (`EngineInfo`, `missingFeaturesTitle`) listing what the engine can't do.
  - `models`: `modelPicker` returns none without it; `chats:setModel` is refused by `modelFits` (`acp` is false).
  - `cost`: Agent Studio hides the daily cap (an engine switch drops it, `dailyCapAfterEngineSwitch`) and `agents:save` refuses
    one (`spendCapRefusal`). `routineEditing.save` and `workflowEditing.save` (so Zumi Bot's tools too) refuse a `spendCap`
    when a target or step agent lacks `cost` (`core/caps/capEngines.ts`, over the pure `shared/src/capAgents.ts`), and the
    routine and workflow runners ask again where a run starts (a routine run fails, a manual workflow run throws, the others
    are stored failed). The editors show the sentence in the cap's place (`CapBlocked`, with Remove the cap).
    A sub-workflow step's agents are judged by that workflow's own cap.
  - `bridges`: `givableAgents` and `TodoAttempts` leave such agents out, `TaskCards.assign` (and its start) and
    `AttemptSets.start` refuse them (`bridgeRefusal`), and `askableAgents` offers nothing to a chat whose own agent lacks them
    (its run gets no ask tool); such an agent stays a target.
  - `remote` is read by Phase 2.

### Who speaks ACP today

Every agent the registry's protocol matrix could start answered `protocolVersion: 1`.

| Agent | Package / version | ACP launch | Sign-in | load / list / resume / fork* |
| --- | --- | --- | --- | --- |
| Gemini CLI (native) | `@google/gemini-cli@0.68.0` | `gemini --acp` | agent methods (`oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway`) | Y / – / – / – |
| opencode (native) | binary v2.3.0 (npm `opencode-ai@1.19.6` is 1.x) | `opencode acp` | terminal: `opencode auth login` | Y / Y / Y / Y |
| goose (native) | binary 1.59.2 | `goose acp` | `goose configure` | Y / Y / – / – |
| Qwen Code (native) | `@qwen-code/qwen-code@0.28.0` | `qwen --acp` | `OPENAI_API_KEY` or Qwen OAuth | Y / Y / Y / – |
| Kiro CLI (native) | binary 3.0.0 | `kiro-cli acp` | `kiro-cli login` / `KIRO_API_KEY` | none advertised on v3 |
| Cursor (native) | binary 2026.11.13 | `cursor-agent acp` | `cursor_login` / `CURSOR_API_KEY` | Y / Y / – / – |
| Auggie (native) | `@augmentcode/auggie` | `auggie --acp` | `auggie login` | Y / Y / – / – |
| GitHub Copilot CLI (native, preview) | `@github/copilot@1.0.112` | `copilot --acp` | Copilot subscription | Y / Y / – / – |
| Claude Agent (adapter) | `@agentclientprotocol/claude-agent-acp@0.108.0` (was `@zed-industries/claude-code-acp`) | `claude-agent-acp` | Claude login (terminal methods) | Y / Y / Y / Y |
| Codex (adapter) | `@agentclientprotocol/codex-acp@2.7.0` | `codex-acp` | `api-key`, `chat-gpt` methods | Y / Y / Y / Y |

\* `fork` here is the *unstable* whole-session `session/fork`, which ZumiBot does not use (see Sessions).

**Test agents:**
1. **Claude Agent ACP adapter.** It has the widest surface: load, resume, elicitation, modes, `usage_update` with a USD cost,
   and a `bypassPermissions` mode the refusal below must catch. It signs in with the machine's existing Claude login.
2. **Gemini CLI.** An independent native implementation with only `loadSession`, image prompts and `usage_update` without
   cost. It is the minimal-capability case and needs a Google login or a Gemini API key.

The alternate is `codex-acp`, since Codex is already signed in on this machine. Installing any of them needs the user's go-ahead.

### Agent file and Agent Studio

```yaml
provider: acp
acp:
  command: gemini          # a bare name looked up on the run's PATH, or an absolute path
  args: ["--acp"]
  authEnv: [GEMINI_API_KEY]  # optional: env names of Vault API keys granted to this agent, for its own sign-in
```

- The body is the agent's instructions (see Instructions).
- `model`, `tools`, `memory`, `computerUse`, `autoCompactWindow`, `dailySpendCap` and the extension keys are not applied to an
  ACP agent, and Agent Studio hides them.
- **Agent Studio.** The Engine select gains **ACP agent**. It shows **Command** and **Arguments** (one per line) and a **Test**
  button. Below them is a fixed note: ZumiBot puts the agent in its `default` mode before every message, when it has one;
  without that mode, the agent's own settings decide which of its calls ask first, so ZumiBot can only show a card for a
  call the agent asks about.
- **`agents:testAcp(agentName)`** is a new API method across `ZumiBotApi`, `rpc/handlers.ts` and `net/api.ts`. The handler
  checks the name like `agents:save`.
  - It tests the **saved** file only, and only once the launch has been confirmed (see Launch trust). So the RPC never runs a
    command typed into the browser or one written by anything but Agent Studio.
  - It spawns the command in a temporary empty folder as a run would, sends `initialize`, ends the process group, and has a
    20 s deadline.
  - It returns `agentInfo`, `protocolVersion`, `loadSession`, `sessionCapabilities`, `promptCapabilities` and `authMethods`
    (names and terminal hints only), plus the caps ZumiBot will enable and the features it hides — or a fixed error.
  - It never calls `session/new` or `authenticate`, so no model runs and nothing is written into the agent's own session store.
- **Refused arguments.** A save or a run refuses known allow-everything arguments with a fixed sentence naming the flag:
  - `--yolo`, `-y`;
  - `--approval-mode yolo`;
  - `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`;
  - `--permission-mode bypassPermissions|dontAsk`;
  - `--allow-all-tools`, `--trust-all-tools`, `--auto-approve`;
  - `--force` and `-f` (cursor-agent's flag that allows commands).

  The list is a speed bump, kept in `shared/` and unit-tested, not a guarantee (see Honest limits). A flag is read up to its
  first `=`, so `--yolo=true` is `--yolo` (`refusedArg`); the sentence names the flag, never the value.
- **Arguments are shown only in Agent Studio**, where the user edits them. They are never logged or put in an error, which name
  the command only. Agent Studio warns against putting a key in them: the file syncs as plain text, and argv shows in the
  process list.
- **Attachments.** An image goes as an `image` block when the agent advertises `promptCapabilities.image`. Any other attachment,
  or an image the agent cannot take, refuses the send with a fixed sentence. The adapter learns this at `initialize`, so the
  refusal is an error item on that turn. *As built:* only an image is refused; any other attachment goes as its path, as for
  Codex (see Phase 1b as built).
- **Zumi Bot.** Its prompt gets the Codex rule's twin: it writes `provider: acp` only when the user asks for an ACP agent, and
  never writes or changes `acp:`. It tells the user to set the command in Agent Studio.

### Launch trust: only the user sets a command or endpoint

The agent file is plain text that Zumi Bot, any agent with `Write` and a sync can change. So a run does not trust it on its
own.

- `agents:save` (Agent Studio, the user's own action) records the confirmed launch itself, not just a hash. For ACP that is
  `provider`, `command`, `args` and `authEnv`; for AG-UI it is `endpoint`, `authKey` and `authHeader`.
- It goes in `<data>/protocol-launch.json` (0600), which is per machine, not synced, and moved by the agent-rename pipeline. It
  holds what the agent file already holds in plain text, nothing more.
- A run and the Test button check the file's current launch against it. On a mismatch, or with no entry, the run refuses with
  a fixed sentence: "This agent's command (or endpoint) changed outside Agent Studio. Open it in Agent Studio and save to
  confirm." *As built:* no engine chip checks it (the pickers row's "i", `EngineInfo`, lists only what the engine can't do);
  the mismatch shows on the run's error item and in Agent Studio's comparison.
- Agent Studio then shows the confirmed launch beside the file's current one, so Save confirms a change the user has seen.
- This makes "only I set an agent's command or endpoint" a check, not a prompt rule.
- Per machine on purpose: the same `command: gemini` can be a different binary on the VPS, so each machine is confirmed once.
- `data.md` gets the file.

### The run

- **Process.**
  - `spawn(command, args, {cwd, env, detached: true})`, so the agent has its own process group. `cwd` is the chat's folder or
    worktree.
  - `locate()` resolves the command on the run env's `PATH` (from `shellEnv.ts`), as `claudeLocator.ts` does. A missing one
    fails the send with a fixed sentence naming the command.
- **Environment.** The base run env, with every `ZUMIBOT_*` stripped. `vaultKeys` is off (see the capability table), so a
  granted API key reaches the process only when its env name is listed in `acp.authEnv` (decided 2026-11-17).
  - Each listed key goes in under its own name, read from the Vault per attempt. Its value joins the run's scrub map.
  - A name not granted, or a Vault that cannot be opened, fails the send with a fixed sentence naming the env name, never
    the value.
  - It is the agent's own credential, like `~/.codex`'s login is Codex's. Agent Studio picks the names from the keys granted
    to the agent, and `authEnv` is part of the launch-trust record.
  - Without `authEnv`, the agent signs in through its own login in its own home, as `codex login` does.
  - The trade-off, said in Agent Studio: a prompt-injected agent can read its own env, and no guard stands beside it.
- **One process per attempt,** like Codex. Each turn does `initialize`, then a start (see Sessions), then the asking mode
  when the session is not in it (see Modes), then `session/prompt`. The
  turn ends at the prompt's response: the agent's process tree is snapshotted, stdin is closed, and the tree is ended (see
  Phase 1b as built).
  - The same clientCapabilities every time: `fs` off, `terminal` off, `auth.terminal` off, `elicitation.form` on, `session` `{}`.
  - The same `clientInfo`.
- **Stop.**
  1. Send `session/cancel`. Every pending permission or elicitation request is answered `cancelled`, as the spec requires.
  2. Wait up to one grace (5 s) for the prompt's `stopReason: cancelled`.
  3. Close stdin, then `SIGTERM` to every process of the tree (once each, through its group) and to `-pgid`, then `SIGKILL`
     after the kill grace, whether or not the agent has exited by then (the tree is snapshotted before each signal and before
     stdin closes).

  So the tree ends, in the agent's group or not, unless a child got away before any snapshot (see Honest limits).
- **Framing.** Newline-delimited JSON-RPC 2.0 on stdio. Requests are numbered per attempt and prefixed with a request tag, as the
  Codex runner does. A line over 8 MiB ends the turn. stderr keeps a 64 KiB tail for the error item, as Claude's `stderr` does.

### Message map (stable v1 → ZumiBot)

| ACP | ZumiBot (`RunEvent` / item) |
| --- | --- |
| `initialize` result | caps check; `init` with `version` = `agentInfo.version` |
| `session/new` · `session/resume` · `session/load` result `sessionId` | `init.sessionId`; stored with `sessionEngine: 'acp'` |
| `agent_message_chunk` (text) | `textDelta`; joined into `assistantText` at the turn's end, or when a non-text update breaks the run |
| `agent_message_chunk` (image / resource) | dropped, with one log line by kind |
| `user_message_chunk` | ignored (only seen in a load's replay, which is discarded) |
| `agent_thought_chunk` | `thinkingDelta`, then a `thinking` item when the thought run ends |
| `tool_call` | `toolUse {id: toolCallId, name: <classified>, input}` (see Permissions for the classification). *As built:* emitted once the call can be named (a later update's input, a permission request, a status, or the turn's end), not at the `tool_call` itself |
| `tool_call_update` with `completed` / `failed` | `toolResult {content: <text content, cut like tool rows>, isError: failed}` |
| tool content `diff {path, oldText?, newText}` | a `FileChange` with exact before and after (`files` cap): no disk read, no patch rebuild. A missing `oldText` is a new file |
| tool content `terminal` | never sent, since ZumiBot advertises no `terminal` |
| `plan` (always the full list) | a read-only **Plan** tool row holding the checklist; how updates in one turn collapse is the builder's call |
| `usage_update {used, size, cost?}` | `context {tokens: used}`, and the window from `size`. *As built:* no cost is recorded in 1b (`cost` off); turning a `USD` cost into the run's cost by difference from the session's last seen total needs a per-session baseline store, left for later |
| `current_mode_update`, `config_option_update` | checked against the refused-mode list (see Modes) |
| `available_commands_update`, `session_info_update`, `notice` | ignored in Phase 1 (`notice` is not advertised) |
| `session/request_permission` | `permissionRequest` (see Permissions) |
| `elicitation/create` (form) | an `AskUserQuestion` card (see Questions) |
| prompt result `stopReason` | `end_turn` and `cancelled` end normally. `max_tokens`, `max_turn_requests` and `refusal` end with a fixed notice naming the reason; `refusal` also says the agent will not carry that prompt forward |
| unknown `sessionUpdate`, unknown fields | ignored (forward compatibility) |

### Permissions

Every `session/request_permission` becomes a `permissionRequest` and goes through `ChatService`'s one decision path: chat
memory, the agent's remembered rules, workflow step rules, then a card. **The adapter itself answers nothing.**

**Classification** (pure, `core/acp/acpTools.ts`) gives the card and the rule a stable tool name:

| ACP `kind` | Tool name | Input on the card | Remembered as |
| --- | --- | --- | --- |
| `execute`, with a string `rawInput.command` | `Bash` | `{command}` | the exact command, like Claude's Bash |
| `edit`, `delete`, `move` | `AcpEdit` | the paths, plus each diff cut as Codex's `ApplyPatch` cards are (4 000 characters each, 20 000 per card) | per agent (as Claude's `Write`), but **only** when every path is inside the chat's folder or worktree; otherwise asked every time |
| `read`, `search` | `AcpRead` | paths or title | per agent |
| `fetch` | `AcpFetch` | the URL when `rawInput` has one, else the title | per agent |
| `think`, `switch_mode`, `other`, missing or unknown kind, `execute` without a command | **unclassified** | title and `rawInput`, scrubbed | **never**: treated as a write, asked every time with Allow once and Deny only (the `confirmOnly` treatment), and never chat-allowed |

**Answers** (pure, `core/acp/acpAnswers.ts`):
- **Allow** selects the request's `allow_once` option. A request without one shows Deny only.
- **Deny** selects `reject_once`; with none, it answers `cancelled`.
- `allow_always` and `reject_always` are **never** selected: "always" belongs to ZumiBot's own rules, exactly as Codex's
  `acceptForSession` is never sent.
- A repeated id adds no second card.
- Cards still open when the run ends are answered `cancelled`.

**Modes.**
- ACP chats offer **Ask permissions** only. That is already what `modeFits` gives any engine that is not Claude.
- Auto has no classifier to lean on. Accept edits and Plan have no protocol form with ZumiBot's meaning: a permission answer
  carries no feedback text, and no mode change is tied to an approval.
- *The design said* ZumiBot never calls `session/set_mode` or `session/set_config_option` in Phase 1. *Decided after the
  real-agent smoke run (2026-11-18):* it puts every session in the agent's **asking mode**, the id `default` (`ACP_ASK_MODE`),
  before each prompt. claude-agent-acp starts a session in the user's own Claude Code `defaultMode` (`auto` there, whose
  classifier allowed `ls` and `sleep` without a request), so no call ever reached a card, against the chat's "Ask
  permissions" label. *As built* (`askSwitch` in `core/acp/acpModes.ts`, pure):
  - After the start's refused-mode check and before `init`, on every turn: a resumed session may start in the agent's default
    again (the Claude adapter's resume does).
  - No switch when every mode the start reports (`modes.currentModeId`, each `mode`-category config value, the replay's last
    for a load answer that names none) is already `default`. Only the start's answer says what the agent offers, so a load
    answer with neither `modes` nor `configOptions` is never switched: that session keeps the agent's own mode.
  - First `session/set_config_option {sessionId, configId, value: 'default'}` on the first `mode`-category option that is not
    at `default` and whose values (flat or grouped) include it: the spec has a client that reads config options use them, and
    marks the mode methods for removal. A `model` option's `default` value is never taken.
  - Else `session/set_mode {sessionId, modeId: 'default'}` when `modes` is not at `default` and `availableModes` lists it.
  - One request a turn. The Claude adapter mirrors its modes as the `mode` config option, one control, so it gets one
    `set_config_option` (verified against 0.108.0: the answer holds the option at `default`, and a `current_mode_update`
    echoes it). A second, separate mode control left off `default` stays as it is.
  - The switch is checked three ways: its echo (`current_mode_update` / `config_option_update`) goes through the mapper's mode
    check like any update; its answer's modes go through `refusedMode`; and a `set_config_option` answer that holds the option
    at another value is not held (`askHeld`), so the run ends with `ACP_TEXT.askModeFailed`.
  - An agent that offers no `default` keeps its own mode (opencode's agents, codex-acp's sandbox levels), as before.
  - A JSON-RPC error on the switch ends the run before the prompt with `ACP_TEXT.askModeFailed`; `-32000` there is the
    not-signed-in sentence. A Stop while it waits is a stop, and an agent that exits then gets the exit sentence.
  - A refused mode at the start (`bypassPermissions`) still ends the run, even when `default` is offered: the check runs
    first and nothing is switched. *Ruling:* the reviewed refusal stays as it was; switching away from it would need the
    early and replay checks reworked, and costs only a settings change for an agent started in a bypass mode.
  - Nothing is remembered across turns and the user's agent settings are untouched: the switch is per session.
  - `default` is no promise that every call asks: the Claude adapter's Manual still runs reads such as `ls` unasked (Claude
    Code's own rule) and applies the user's `permissions.allow`. Agent Studio's note says so.
- *As built:* the mode picker offers Ask permissions only, checked whatever the chat stored (`modePicker`'s `AUTO_OFFERED`):
  no chat mode reaches the agent, and with no classifier Auto would run as Ask anyway (see
  [Chat mode and effort](chat-mode-and-effort.md)).
- It ends the turn with a fixed sentence when the session's current mode, or a `mode`-category config value, is one of
  `bypassPermissions`, `dontAsk`, `yolo`, or contains `bypass`, `yolo` or `dangerous`. That is the check at start and on every
  `current_mode_update` / `config_option_update`. The Claude ACP adapter really advertises `bypassPermissions`, so this is
  exercised.
- **Models** are config options (category `model`). Phase 1 shows no model picker (`models` off).

### Questions

`elicitation/create` is stable in v1, so `questions` is **on**. ZumiBot advertises the form mode only; URL mode would ask the
user to open a link the agent chose.

- A form whose flat `requestedSchema` maps onto the question card becomes an `AskUserQuestion` card, one question per property:
  - a string with `enum` / `oneOf` → options;
  - a boolean → Yes / No;
  - an array of an enum → multi-select;
  - a plain string, number or integer → free text, a number checked before it is sent.
- Answers go back as `{action: 'accept', content}`; Skip sends `decline`; Stop sends `cancel`.
- A schema that does not map (nested objects, unsupported types) is declined at once with no card, as Codex's unusable question
  is.
- In an A→B chat the asked agent's elicitation is declined, as Codex's `requestUserInput` is.

### Instructions

- The agent file's body, then the same appended system text a Codex run gets (only the parts that apply: no to-do, vault or ask
  bridge text, since ACP gets none of those bridges in Phase 1; the room briefing for a room member) go in
  `session/new`'s `systemPrompt: {mode: 'append', content: [text]}`.
- They go again on every `session/resume` / `session/load`, as Codex's `baseInstructions` do, when the agent advertises
  `sessionCapabilities.systemPrompt`.
- Without it, they lead the first prompt of a new or reseeded session as a quoted preamble, and the Test result says so.

### Sessions, resume and rewind

- **New.** `session/new {cwd, mcpServers: [], systemPrompt?}`.
- **Resume.**
  - `session/resume` when `sessionCapabilities.resume` is advertised (no history replay).
  - Else `session/load` when `loadSession` is, with every `session/update` before its response discarded as replay.
  - Else every turn reseeds from the visible items (`seedPrompt.ts`), with no `expired` notice each time; the Test result says
    so. *As built:* the runner marks the attempt `noResume` beside `missingSession`, `ChatService` reseeds with no notice, and
    Test's Sessions row reads "Each turn starts a new session and resends the chat so far".
- **A failed resume or load reseeds once,** as Codex's `no rollout found` does. That covers `-32002` resource not found or any
  error: a load writes into nothing, so a reseed loses nothing that was kept.
- **No rewind.** Stable v1 cannot resume or fork a session at a message. `session/fork` is unstable and forks the whole session.
  The draft session cursors (`cursor_update` + `session/fork {cursorId}`) are not in SDK 2.7.0, and neither reference adapter
  sends them.
  - Two adapters accept a vendor-only `_meta.jetbrains.air.fork`. It is not used, since it would be per-agent trust in a private
    extension.
  - So `rewind` is off, and the new `resend` and `fork` caps are off.
  - **The UI shows no Edit or Resend on a user message, no version switcher, and no Fork.** Copy stays. The chat header's engine
    chip tooltip lists what the engine cannot do, so the missing buttons are explained in one place.
  - When cursors are stable and an agent sends them, `rewind`, `resend` and `fork` can turn on per agent through the adapter's
    caps.

### Client file and terminal methods

**None are implemented.** ZumiBot advertises `fs.readTextFile`, `fs.writeTextFile` and `terminal` as false, and the spec
forbids an agent from calling a method whose capability is missing. Why:
- **Nothing is lost.** Agents fall back to their own tools, which still ask through `session/request_permission`.
- **v2 removes them.** v2 drops every `fs/*` and `terminal/*` method in favour of client-provided MCP servers.
- **They would make ZumiBot the executor.** A shell command run for an agent cannot be confined to a folder (`cd`, absolute
  paths), so `terminal/*` would add attack surface for no real confinement.

If a later phase adds them, the confinement rules are:
- **Paths.** Absolute paths only, resolved through `realpath` of the nearest existing ancestor. The path must be inside the
  realpath of the chat's folder or worktree. A symlink whose target leaves it is refused, as are the vault key's folder and
  `vault.json`.
- **Reads.** No card inside the root; refused outside it.
- **Writes.** Allowed only for a path an approved permission request of the same turn named. Any other write gets its own
  `AcpEdit` card. Writes are atomic (temp file and rename) and size-capped.
- **Terminals.** A card per `terminal/create`, with the full command, args and env names. `cwd` must be inside the root, and
  output is capped and stripped of control sequences.

### Errors and crashes

| Case | What the chat shows |
| --- | --- |
| Command not found | fixed sentence naming the command |
| `-32000` auth required (on `session/new`, resume or load) | fixed sentence: the agent is not signed in; sign in with its own CLI. The Test result names its auth methods, and for a terminal method `<command> <args>` to run |
| `protocolVersion` other than 1 | fixed sentence: protocol version not supported |
| process exits before the prompt's response | "The agent stopped before finishing (exit code N)", with the stderr tail |
| a line that is not JSON | dropped and counted. A response to one of ZumiBot's own requests that fails the reader ends the turn with "The agent sent a reply ZumiBot could not read" |
| JSON-RPC error on `session/prompt` | its `message`, cut to 500 characters |
| JSON-RPC error on the switch to the asking mode (`session/set_mode` or `session/set_config_option`) | fixed sentence: the agent would not switch to its `default` mode, so the message was not sent (`ACP_TEXT.askModeFailed`); `-32000` is the not-signed-in sentence |
| a request ZumiBot does not serve (`fs/*`, `terminal/*`, anything unknown) | `-32601` method not found, at once |

### Rooms

**Yes: an ACP agent can be a room member, as a Codex agent can** (`rooms` on).
- A member's turn is one prompt on its own session, and the room briefing rides in its `systemPrompt`.
- The moderator and the room summary stay on Claude.
- Tests: `groupService.test.ts` ("GroupService with an ACP member") runs a member through the real runner against the fake agent: briefing after the body in `systemPrompt` (or the first-prompt preamble), session marked `acp`, resume, engine-switch reseed. An ACP session has no rewind stamp (`end`), since no entry ids come back.
- A room with any member lacking `resend` / `fork` hides Edit, Resend and Fork for the whole room. That is the same rule
  `chatCaps` uses for Pause: only while every member has it.
- Rooms land last in 1b. If `e2e:group` with a fake ACP member is not green, `rooms` ships off and the member pickers hide ACP
  agents. *As built:* `e2e:acp`'s room check (a Claude and an ACP member made in the UI, both answering, the briefing in the ACP
  member's `systemPrompt`, its session marked `acp`) passes, so `rooms` stays on.

## AG-UI engine (Phase 2)

### Phase 2 as built

- **Merged with master 10.5.7.** Isolation, the audit log, connectors and card comments for both protocol engines: see
  Governance, connectors and card comments, below the capability table.
- **The engine.** `'ag-ui'` is an `Engine` and a `Provider` (`parseProvider` reads `provider: ag-ui`), labelled **AG-UI**
  (the Engine select's **Remote agent (AG-UI)**, the row tag **Remote**), with `AGUI_CAPS` (only `questions`, `resend`,
  `fork` and `remote`; `processes` is off too) and its own refusal sentences (`AGUI_REFUSALS`). Fixed sentences live in
  `shared/src/agui.ts` (`AGUI_TEXT`, `AGUI_STUDIO_TEXT`); they name a host, an env name or a status, never a value, a path or
  a query.
- **The agent file.** `agui: {endpoint, authKey?, authHeader?}` (`parseAguiLaunch`, `aguiLaunchError`): an `https:` (or,
  for the dev hook's checks to judge, `http:`) URL of at most 2048 characters with no space, control character, userinfo or
  `#`; `authKey` an env name; `authHeader` an RFC 9110 token of at most 64 characters, not hop-by-hop, `Host`, `Content-*`,
  `Accept` or `Accept-Encoding` (Rulings 9), and only with a key. `validateFields` needs an endpoint for `provider: ag-ui`
  (`endpointRequired`, or `launchUnreadable` for an `agui:` that does not parse, which the form never rewrites).
  `AgentStore.aguiOf(name)` reads the provider and launch only (the body is never read for a run), and an AG-UI agent's
  summary carries `remoteHost` (host and a non-default port).
- **The endpoint checks** (`core/agui/aguiEndpoint.ts`, run at Save, Test and every run): `checkUrl`, then `resolveTarget`
  (every address public), `pinnedLookup` and `redirectTarget`, as designed. The address classes, `checkedAddresses` and
  `pinnedLookup` live in the shared guard `core/addressGuard.ts` (re-exported here), which the workflow HTTP step and the
  container's network proxy use too. "Public" is globally reachable unicast and the
  check fails closed: a `reserved` class (240/4 but broadcast, 198.18/15, 192.0.0/24, 192.88.99/24, the documentation nets,
  `fec0::/10`, `2001:db8::/32`, `3fff::/20`, `100::/63`, Teredo `2001::/32`, `2001:2::/48`, `2001:10::/28`, `5f00::/16`
  and the whole `64:ff9b:1::/48`) is refused even under the dev hook, and SIIT and 6to4 addresses are classed by the IPv4
  they carry, like the mapped and NAT64 forms.
- **The client** (`aguiClient.ts`, `postRun`): one POST per run over `node:https` (`node:http` only for the dev hook's
  loopback `http:`), to the pinned address with `agent: false`, SNI set to the name and `rejectUnauthorized: true` asked for,
  so `NODE_TLS_REJECT_UNAUTHORIZED=0` in the env cannot turn verification off (Test's `tls.connect` asks for it too). The
  auth header goes first and `Content-Type`, `Accept: text/event-stream` and `Content-Length` last, so it can never replace
  them; no `Accept-Encoding`.
  `AGUI_LIMITS` holds the design's timeouts and caps, plus `finishGraceMs` 5 s (Rulings 2) and `rounds` 10 (Rulings 4). An
  error status reads its body to 4 KiB and drops it: 401 and 403 name `authKey` (`unauthorized`), any other gives
  `status(code)`; a 200 that is not `text/event-stream` is `notSse`. Errors name the host and an error code, never a message.
  `SseReader` (`aguiSse.ts`) and `applyPatch` (`aguiPatch.ts`, the six RFC 6902 ops, `__proto__` kept a plain key) are
  hand-written. A copy can double the document per op (a 1 KiB delta copying `/a` into `/a/-` 26 times ran the server out
  of memory), so `applyPatch` takes at most 1000 ops and a byte budget, the state cap: each `add`, `replace` and `copy`
  value is measured before it is copied, by a walk that stops at what is left, and the patch fails once what it writes
  would pass the budget. The kept document is not counted (a patch may rewrite a large field), so the result is at most
  the cap twice over before the runner's own cap check drops it.
- **A run** (`aguiRunner.ts`, `startAgui`; `aguiEngine.ts` adapts it). Each run has a fresh `runId` and sends
  `{threadId, runId, protocolVersion: '1.0', state, messages, tools: [], context: [], forwardedProps: {}}`, plus `resume` only
  when it has entries; never `parentRunId` or a system or developer message (Rulings 13). The mapper (`aguiEvents.ts`) is the
  design's message map:
  - a `protocolVersion` whose major is not 1 ends the run, an absent one is fine (Rulings 1);
  - other runs' events (a replay) are dropped, and after our terminal event the body gets 5 s to end, a late `RUN_ERROR` in
    that time failing the run (Rulings 2), as anything unreadable there does;
  - text and tool events that carry `subagentRunId` are dropped (Rulings 6);
  - an empty message gives no reply: Pydantic AI opens and closes one before every tool call, and the next run's transcript
    sends it back as the call's parent;
  - each row is `AguiTool` (`AGUI_TOOL`, shared) with `{tool, args}` (arguments that are not JSON stay as `argsText`, cut at
    20 000 characters), and reads `<tool> (ran on the remote server)` with its arguments under it (`toolLabel`,
    `AGUI_TEXT.remoteTool`); and
    every tool id leaving the handle is tagged with the attempt's request tag, as ACP's are; a call a later round announces
    again opens no second row;
  - a tool result for a call an earlier run made (a resumed approval) lands on that run's row.
- **Outcomes.** Success records the summed `usage` per model with `costUsd` null (Usage shows the tokens unpriced; no context
  event). Pending tool calls are each answered on their stored row with an error result, which every later run resends as a
  `tool` message with `error` (Rulings 7), and one `remote` notice says so (`pendingTools`); a pending id with no row is logged
  and dropped. `cancelled` is stopped. `RUN_ERROR` shows `runError(message, code)`, the message cut to 500 characters with
  control characters made spaces, then scrubbed by `ChatService`. A cut, timed-out, oversize or unreadable stream shows its
  fixed sentence and never a result; a request refused before anything was sent is the turn's `spawnError`.
- **Interrupts.** An interrupt outcome keeps the interrupts in the thread file before any card waits. A mappable one becomes a
  question card (`permissionRequest` as `AskUserQuestion`, after its tool row when that row exists); for AG-UI only, the form
  is first pruned the same way for the card and its answer (a schema with a required property is asked only its required
  ones, so Pydantic AI's approval is one Yes/No and its payload exactly `{approved}`; one with none keeps the optional fields
  a card can show). Any other interrupt is cancelled at once with a `remote` notice naming its reason (`interruptDeclined`,
  cut to 100). One already past `expiresAt` is cancelled with no card, and a timer cancels a waiting card at its `expiresAt`
  (Rulings 5). A repeated interrupt id gets a card key of its own (`<id>#2`). Once every card is settled the next run, inside
  the same handle, sends the history plus each earlier run's transcript, the state and `resume[]` for every interrupt. More
  than 10 rounds end the turn with `tooManyRounds` (Rulings 4). Stop answers nothing, sends nothing more and leaves the
  interrupts stored, so the next send's first run cancels them.
- **The thread file** (`chats/<id>.agui.json`, `ChatStore.loadAgui` / `saveAgui`, 0600, queued, removed with the chat):
  `{v: 1, threadId, state, interrupts}`. It counts only for its own `threadId`, so a new thread (Edit, Resend, Fork, a
  reseed) starts at `{}` with no `resume` (Rulings 3). The state follows `STATE_SNAPSHOT` and `STATE_DELTA`; a failed patch or
  a state over 256 KiB becomes null with one log line and is sent as `{}`. The stored interrupts are cleared once a run that
  sent `resume` reaches `RUN_STARTED`, when the server definitively refuses that request (a 4xx other than 401, 403, 408 or
  429, which would refuse every retry too), and when a late `RUN_ERROR` fails the run that asked them.
- **A turn** (`ChatService`, every `switch (engine)` has its `ag-ui` case). Each attempt refuses before any request, with
  `spawnError`, in this order: `noEndpoint`, `endpointInvalid` (`checkUrl`), `untrusted` (launch trust), `otherEngine`
  (`foreignHistory`: a stretch of the visible items holding work with no AG-UI end stamp, or any other engine's stamp; a
  message marked `engine: 'ag-ui'` counts as its stretch's end stamp, see below),
  `noAttachments` (the turn's own message has some), `authKeyMissing` (not granted) and `authKeyUnusable` (a C0 control but
  tab, DEL, or past U+00FF). The first five also run where the turn locates its engine, so a refused chat keeps the session it
  had. The header is `Authorization: Bearer <value>` (also for an `authHeader` of `authorization` in any case), else
  `<authHeader>: <value>`, and the value is in the scrub map. `messages` are
  `aguiMessages(withReplies(withCommands(history)))`, each message as the agent reads it (its command filled, its reply
  quoted, as a seed reads it), the turn's own too, so one message id carries one text on every run: the user messages,
  the replies and the remote tool rows of earlier AG-UI turns, as `toolCalls` and `tool` messages (ids are ZumiBot's item
  ids, `result-<item id>` for tool messages, `calls-<call id>` for calls with no reply before them), never thinking, notices,
  errors, cards or attachment names; a reseed sends them too, never a seed prompt. No bridge, model, effort, tmp dir, side
  base or pause. A turn records `sessionEngine: 'ag-ui'`, its end stamp carries the mark (one stamp at the last run of an
  interrupt round), and its message gets `engine: 'ag-ui'`, saved before the first request: the end stamp waits for the
  turn's end, so a hard crash mid-turn (kill -9, OOM, power loss) would otherwise leave its saved rows with only an
  `interrupted` notice, and the chat refused for good as `otherEngine` (no other engine writes the mark). A `notice` event
  becomes a `remote` notice, and a planned reseed adds no `expired` notice (`RESEED_IS_NEWS`), since a new thread with the
  visible items is what every rewind is.
- **Launch trust** (1b's `LaunchTrust`): a record is `({provider: 'acp'} & AcpLaunch) | ({provider: 'ag-ui'} &
  AguiLaunch)`, the AG-UI one stored as `{provider, endpoint, authKey, authHeader}` in that order. `agents:save` runs
  `checkUrl` and `resolveTarget` (dev hook honoured) for a remote agent before writing, so an offline Save is refused with
  `resolveFailed`, then confirms by `switch (markEngine(provider))`, queued before any await. An endpoint moved from one host
  to another and saved takes the existing chats along, which the card's `changed` note says (Rulings 12).
- **Agent Studio's remote card** (`AguiCard.tsx`, pure rules in `state/aguiCard.ts`; the shared launch compare and confirm
  pending in `state/acpCard.ts`). Endpoint, Auth key (a `SearchSelect`, as every dropdown is since master 10.5.8: the env
  names of API keys granted to the saved agent, plus a listed one no longer granted) and Auth header; the remote notice with the host; the older-chats note once the Engine select moves a
  saved agent onto it; the confirmed launch beside the form's; and Test. The form gets the card's launch only while it is
  valid, else none, so the card keeps an invalid endpoint or header as typed and names its problem while Save is refused
  (the agent file never holds a launch that does not parse; found by `e2e:agui`, where the card had reset every key typed).
  Meanwhile the editor's error list shows the card's own sentence in place of `endpointRequired` (`saveErrors` with the
  card's `aguiDraftError`, reported up through `onDraftError`).
  `studioCards('ag-ui')` shows the card and the instructions note (the body is not sent) and hides every card the caps take
  away, the daily cap among them.
- **`agents:testAgui(name)`** (`aguiTest.ts`): read and refused as a run is (`notAgui`, `noEndpoint`, `checkUrl`,
  `untrusted`), then `resolveTarget` and a `tls.connect` (Rulings 10; `net.connect` for the dev hook's loopback `http:`) to
  the pinned address with SNI and a 10 s deadline, closed once it completes. No HTTP request is written. It answers `{host,
  addresses, tls, authKey, authKeyGranted, caps, hidden}`, or `testFailed` / `testTimeout`; concurrent Tests of one launch
  share one probe. `agents:aguiLaunch(name)` gives the confirmed endpoint, or null.
- **Zumi Bot** writes `provider: ag-ui` only when asked, never writes, changes or removes `agui:`, and sends the user to
  Agent Studio for the endpoint; it never writes `model`, `tools`, `memory`, `computerUse`, `autoCompactWindow`,
  `dailySpendCap` or a command's `model` for one, and a switch removes `model` and `dailySpendCap`. Where it may keep or add a
  remote agent is in "Where protocol agents can be used".
- **Sync.** `sync.mjs` brings `chats/<id>.agui.json` with a chat whose items come from the VPS and never gives one to a copy
  chat (it starts a new thread), and `copyMeta` carries any stamp's engine, not only Codex's (Rulings 11).
  `protocol-launch.json` stays per machine.
- **Checked.** Unit tests for every module (the address table, the SSE reader, the patch applier, the mapper, the history,
  interrupts, the client and runner against the fake server, `ChatService` against it through the real card path, Test with a
  real TLS server whose self-signed certificate is refused, the card's rules through the agent file). `e2e:agui`
  (`zumi-bot-server/e2e/agui.e2e.mjs`, the harness's `fakeAgui`, fakes only) goes through the UI: Save refused for an
  endpoint with userinfo or `#`, a Vault key granted and picked, Test sending no request, the chip, a chat with reasoning and
  a remote tool row whose requests carry the key in its header only and then the history and the state, a Pydantic-shaped
  approval answered and an unmappable interrupt's notice, Stop with a card open and the next `resume`, `RUN_ERROR`, a cut
  stream and a 401, an Edit's new thread with no `expired` notice, an attachment, an endpoint edited in the file and a Claude
  chat after its agent switched all refused with no request, and the room picker, the `@` menu and the voice default leaving
  the agent out. `smoke:agui` against the scripted Pydantic AI 2.65 server
  (`zumi-bot-server/e2e/fixtures/agui_smoke_server.py`, whose header says how to run it) on
  `http://127.0.0.1:8765/agent` (see [E2E](e2e.md)): all four steps PASS, Stop ending the chat 0.2 s after the press, the
  remote row closed as "did not finish".
- **Rulings taken while building** (each recorded with its reason in the plan's ledger):
  - the thirteen in the plan: the version rule (1), replays and the late `RUN_ERROR` (2), a new thread at `{}` (3), 10
    rounds (4), expiry timers (5), subagent events dropped (6), pending calls answered on their rows (7), "never picked
    automatically" (8: voice never routes to a remote agent, even by name; Zumi Bot may keep one a routine or workflow
    already holds in that place, never add one), the refused header names (9), `node:tls` for Test (10), sync carrying any
    engine (11), a moved endpoint taking its chats (12), no ZumiBot system text (13);
  - the special-purpose ranges as `reserved`, failing closed; a fatal event after our terminal is an error;
  - `authKey` (the env name) travels with the run so a 401 or 403 can name it; a first request refused before anything was
    sent is `spawnError`; the dev hook joins in the run closure;
  - no cost without usage; control characters in remote text become spaces; a repeated interrupt id gets `<id>#2`; an
    interrupt already expired gets no card;
  - a stopped run's state changes stay in memory and are not saved;
  - stored interrupts also clear on a definitive 4xx and a late `RUN_ERROR`;
  - `otherEngine` and `noAttachments` also run at locate; `authKeyUnusable` covers every C0 control but tab, and DEL;
  - `/todo`, and a command that makes to-dos, are refused for an agent without `bridges` where command text is expanded (so
    Resend, routines and workflow steps too), with a sentence of their own (`todoRefusal`, not the cards' `bridgeRefusal`),
    and the `/` menu hides them;
  - a workflow Chat step into a remote agent's chat sends its blocks without `MATERIAL_RULE` (Rulings 13); a local agent's
    chat, or one whose agent can't be read, still gets it;
  - for AG-UI interrupts only, optional properties are pruned, all of them when any property is required;
  - the card hands the form no launch while its draft is invalid (see Agent Studio's remote card).

### Who serves AG-UI today, and the two test servers

AG-UI 1.0 (2026-09) is served by:
- **Vendor-maintained:** Pydantic AI (`pydantic-ai-slim[ag-ui]`, `AGUIAdapter`), Microsoft Agent Framework, Agno and LlamaIndex.
- **In the ag-ui repo:** LangGraph (`ag-ui-langgraph`, `add_langgraph_fastapi_endpoint`), CrewAI, Google ADK, AWS Strands and
  the OpenAI Agents SDK.
- **Others:** the CopilotKit runtime (`POST {base}/agent/{id}/run`), and AWS Bedrock AgentCore as a hosted runtime.
- **In-process only, no HTTP endpoint:** Mastra and the Vercel AI SDK integrations.

**Test servers:**
1. **Pydantic AI.** A six-line Starlette app with a real model. It does approvals through interrupts, the cancelled outcome and
   usage. Needs a model key (its examples use `OPENAI_API_KEY`).
2. **LangGraph FastAPI** with `emit_interrupt_outcome=True`. It needs a key too.

The zero-key fallback for the smoke run is the ag-ui repo's scripted `server-starter-all-features`. *As built,* the smoke ran
Pydantic AI 2.65 itself with no key: its `AGUIAdapter` over a `FunctionModel` that scripts each reply (see [E2E](e2e.md)).

### Agent file, auth and the remote notice

```yaml
provider: ag-ui
agui:
  endpoint: https://agents.example.com/run
  authKey: EXAMPLE_AGENT_KEY       # env name of a Vault API key granted to this agent; never the value
  authHeader: Authorization        # optional; Authorization sends "Bearer <value>", any other header sends the bare value
```

- **The key.** Its value lives only in the Vault. It is read per run, sent only in that header, added to the run's scrub map, and
  never written to the file, a log, a URL or an error.
  - Errors name `authKey`, never the value.
  - A missing or ungranted key fails the send with a fixed sentence naming `authKey`.
  - `authHeader` must be an HTTP token and not a hop-by-hop, `Host` or `Content-*` header.
  - The Vault grant list accepts AG-UI agents for this purpose, though `vaultKeys` (keys as env) stays off.
- **Saving.** Agent Studio offers **Remote agent (AG-UI)** with Endpoint, Auth key (picked from granted Vault keys) and Auth
  header. Saving runs the endpoint checks below.
- **Remote notice.** Agent Studio shows: "Runs outside this machine, at `<host>`. Every message of its chats, and the chat's
  history, is sent there." The chat header and the new-chat screen show a **Remote · `<host>`** chip with the same sentence as
  its tooltip (`remote` cap).
- **Launch trust** applies to `endpoint`, `authKey` and `authHeader`, as above.
- **Zumi Bot** writes `provider: ag-ui` only when asked, and never `agui:`.

### Endpoint checks and transport limits

These are pure checks in `core/agui/aguiEndpoint.ts`, unit-tested, and run at save, Test and every run.

- **URL.** `https:` only, no userinfo, no fragment.
- **Addresses.** The host resolves to at least one address, and **every** address must be public. Refused:
  - loopback (`127/8`, `::1`) and unspecified (`0/8`, `::`);
  - private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) and CGNAT (`100.64/10`);
  - link-local (`169.254/16`, `fe80::/10`);
  - multicast, broadcast, and IPv4-mapped or NAT64 forms of any of these.
- **Pinning.** The request connects to the checked address (a `lookup` that returns it), so a DNS answer cannot change between
  the check and the connect. SNI and `Host` keep the name.
- **Dev hook.** `ZUMIBOT_AGUI_ALLOW_LOCAL=1`, read through `devEnv()` and so ignored in production, allows loopback and
  private addresses, and plain `http:` to loopback only. The fake server and the e2e suite use it.
- **Redirects.** No 301, 302 or 303. Up to two 307 / 308 redirects are followed only to the same scheme, host and port, each
  re-checked. Anything else ends the run with "The endpoint redirected to another host".
- **Timeouts.** Connect 10 s; response headers 30 s; 120 s with no bytes (keep-alive comments count as bytes); a whole run 30 min.
- **Size caps.** Response body 16 MiB; one SSE event 1 MiB (the events a read completed before the oversize one are still
  handed over, `SseTooBig.before`). An error response's body is read to 4 KiB and **not** shown, since it
  may echo the request: the chat shows the status only, with 401 / 403 naming `authKey`.
- **TLS.** Node's default certificate verification, with no option to turn it off.
- **Client.** `node:https` with a hand-written SSE reader that follows the spec: LF framing, one JSON per `data:`, `event:` /
  `id:` / `retry:` and comments ignored. `Accept: text/event-stream` only, because any wider `Accept` opts into protobuf.

### What is sent

`POST` a `RunAgentInput`:
- `threadId`, a fresh `runId`, and `protocolVersion: "1.0"`.
- `messages`: the chat's **complete visible history**, which the protocol requires every run. That is user and assistant text,
  plus the tool calls and results of earlier **AG-UI** turns of this chat (as `toolCalls` and `tool` messages, which ran on the
  remote server anyway). It never carries thinking, notices, other chats, attachments, or anything a local engine produced.
- **A chat that began on another engine does not continue on a remote agent.** If an agent with chats is switched to
  `provider: ag-ui`, a send in one of its older chats is refused with a fixed sentence: start a new chat for the remote agent.
  Sending that history would hand local file contents and command output, quoted in earlier replies, to the remote host.
  Agent Studio says this when the Engine select is switched.
- `tools: []`, `context: []` and `forwardedProps: {}`.
- `state`: the last `STATE_SNAPSHOT` / `STATE_DELTA` result, kept beside the chat in `chats/<id>.agui.json` (cap 256 KiB; past
  that it is dropped and `{}` is sent).

**The agent file's body is not sent.** A remote agent's behaviour is its server's, and sending local instructions would be data
leaving the machine that the user did not expect. Agent Studio says so in place of the instructions editor's hint.

**An attachment refuses the send** with a fixed sentence: attachments are not sent to remote agents in Phase 2.

### Message map (AG-UI 1.0 → ZumiBot)

| AG-UI event | ZumiBot |
| --- | --- |
| `RUN_STARTED` | `init` (session = `threadId`). A `protocolVersion` with a major other than 1 ends the run |
| `TEXT_MESSAGE_START/CONTENT/END`, `TEXT_MESSAGE_CHUNK` | `textDelta` / `assistantText` (role `assistant` only) |
| `REASONING_MESSAGE_*`, `REASONING_START/END` | `thinkingDelta` / `thinking`. `REASONING_ENCRYPTED_VALUE` is not round-tripped in Phase 2 |
| legacy `THINKING_*` | translated to the above, as `@ag-ui/client` does |
| `TOOL_CALL_START/ARGS/END`, `TOOL_CALL_CHUNK` | `toolUse`, built at `TOOL_CALL_END`. Args parse as JSON, else are kept as text. The row says the tool ran on the remote server |
| `TOOL_CALL_RESULT` | `toolResult` |
| `STATE_SNAPSHOT`, `STATE_DELTA` (RFC 6902) | the kept state. A patch that fails to apply drops the state, with one log line |
| `RUN_FINISHED` `success` | turn end; `usage` tokens recorded with no cost |
| `RUN_FINISHED` `success` with `pendingToolCallIds` | ZumiBot offered no tools: the next run answers each id with a `tool` message `error: "ZumiBot runs no tools for this agent"`, and the chat gets a notice |
| `RUN_FINISHED` `interrupt` | cards (see Interrupts) |
| `RUN_FINISHED` `cancelled` | turn end, stopped |
| `RUN_ERROR` | error item: `message` cut to 500 characters and scrubbed, plus `code` |
| stream ends with no terminal event | "The connection ended before the agent finished." Never a synthesized success |
| `MESSAGES_SNAPSHOT`, `ACTIVITY_*`, `STEP_*`, `SUBAGENT_*`, `RAW`, `CUSTOM`, unknown | ignored. A malformed **known** event ends the run, as the spec requires |

### Interrupts (approvals and questions)

A `RUN_FINISHED` with `outcome: interrupt` does **not** end the `RunHandle`. Each interrupt becomes a card, and the answers go
back as one new run on the same `threadId` carrying `resume[]`, inside the same handle. So `ChatService` sees one turn with
cards in it, as it does for Claude.

- **An interrupt with a `responseSchema` that maps as an ACP form does** becomes a question card. Its answers are the `payload`
  of `status: resolved`; Skip is `cancelled`.
  - First, for AG-UI only, the form is pruned, the same way for the card and for its answer:
    - A schema with a required property is asked only its required properties. Pydantic AI's approval (`approved`
      required; `reason` and `editedArgs`, an object, optional) is a plain Yes/No, and its payload is exactly
      `{approved}`: nothing the user did not choose is sent.
    - A schema with none keeps the optional properties a card can show, and is cancelled when none is left.
  - A required property the card cannot show still makes the interrupt unmappable. ACP's own forms are not pruned.
- **Any other interrupt** (no schema, or one that does not map) is answered `cancelled` at once with a notice naming its
  `reason`.
  - Approval payloads are framework-specific: Pydantic `{approved}`, LangGraph legacy `CUSTOM on_interrupt`, the Claude Agent SDK
    adapter `{behavior}`.
  - Guessing one would risk presenting a call as approved when it was not, which the spec forbids.
- `resume[]` always covers every interrupt. One past its `expiresAt` is `cancelled`.
- Stop with cards open answers nothing. The thread keeps the interrupt and the next send cancels it in its `resume[]`.

So `questions` is on for AG-UI, and remote tool approvals work only where the server describes them with a schema. That is an
honest limit, not a gap the adapter papers over.

### Sessions, Edit, Resend and Fork

- `threadId` is a UUID ZumiBot mints, stored as `sessionId` with `sessionEngine: 'ag-ui'`.
- **Edit, Resend and Fork are on.** Every AG-UI run already sends the whole visible history, so a rewind is a new `threadId`
  whose `messages` are the visible items up to the point. That is exactly ZumiBot's reseed, and it is what the protocol does
  every turn anyway. `rewind` (a cut inside the agent's own session) stays off.
- A server that keeps its own history per thread (Pydantic's `manage_message_history='server'`) sees a new thread, so it cannot
  carry the old version's state into the new one.

**Decision for review:** keep Edit, Resend and Fork on for AG-UI, or turn them off like ACP's.

### What a remote agent gets

**Nothing local.**
- `tools: []`: no frontend tools, and no ZumiBot bridges (to-dos, vault list, ask, browser, desktop).
- No files and no attachments. No vault keys beyond its own auth header. No computer use.
- It is never offered as an ask target, and asks nothing.
- Not a room member (`rooms` off), since every other member's words would leave the machine.
- No side questions, Pause or Compact.
- It runs in routines and workflow Agent steps, where the user picked it.

A later safe way to give it something would be a frontend tool that ZumiBot runs only behind a card per call, with the
result shown before it is sent. Nothing in Phase 2 does this.

## Capability table

The 13 existing flags plus seven new ones (bold): six from these phases, and `isolation`, added when master's governance work
(Sandboxed and Container isolation) was merged in. Today's values for Claude and Codex are unchanged.

| Flag | Claude | Codex | ACP | AG-UI | Why, for the protocols |
| --- | --- | --- | --- | --- | --- |
| `pause` | ✓ | ✓ | – | – | Pause blocks a tool call mid-turn through a hook. ACP has no hook, and a declined permission request cannot work: calls the agent runs without asking never reach ZumiBot. AG-UI tools run remotely |
| `btw` | ✓ | ✓ | – | – | A side question is an ephemeral, read-only fork of the live session. ACP has only the unstable whole-session fork, with nothing read-only. An AG-UI side thread could not stop the remote agent's own tools |
| `compact` | ✓ | ✓ | – | – | No client-driven compaction in stable ACP; agents compact themselves. AG-UI has none |
| `rewind` | ✓ | ✓ | – | – | No fork at a point in stable ACP (cursors are a draft). AG-UI has no agent-side session to cut |
| `files` | ✓ | ✓ | ✓ | – | ACP `diff` content gives exact before and after. AG-UI files are on the remote machine |
| `desktop` | ✓ | – | – | – | Forced desktop cards need a client approval the agent cannot skip; neither protocol can force one |
| `vaultKeys` | ✓ | ✓ | – | – | Keys ride only beside a guard (Claude's deny rules and hook, Codex's trusted hook), and neither protocol has one. AG-UI's auth header is a separate, narrower use |
| `rooms` | ✓ | ✓ | ✓ | – | ACP: one prompt per member turn, briefing in `systemPrompt`. AG-UI: the room's words would leave the machine |
| `questions` | ✓ | ✓ | ✓ | ✓ | ACP: stable `elicitation/create` form mode. AG-UI: interrupts with a `responseSchema` |
| `plan` | ✓ | – | – | – | No client-side plan approval with feedback in either protocol |
| `memory` | ✓ | – | – | – | Claude Code's own agent memory |
| `keepWarm` | ✓ | – | – | – | Claude's prompt-cache hour |
| `dispatch` | ✓ | ✓ | – | – | ACP `subagent_update` is unstable. AG-UI `SUBAGENT_*` is stable but read-only progress, left for later |
| **`resend`** | ✓ | ✓ | – | ✓ | Edit, Resend and the version switcher. Claude and Codex reseed where they cannot rewind, so they keep it. ACP is off per the brief. AG-UI resends the history every run anyway (decision for review) |
| **`fork`** | ✓ | ✓ | – | ✓ | Fork from a message: same reasoning as `resend` |
| **`cost`** | ✓ | ✓ | – | – | Every turn reports a USD cost, so spend caps can hold. ACP's `usage_update.cost` is optional, session-cumulative and may be in credits or another currency: 1b records none, Agent Studio hides the daily spend cap and the handler refuses one. AG-UI has tokens, no cost |
| **`models`** | ✓ | ✓ | – | – | The model picker. ACP models are config options, left for later. AG-UI has none |
| **`remote`** | – | – | – | ✓ | Runs outside this machine: the remote notice and chip, no asks, no rooms, never picked automatically |
| **`bridges`** | ✓ | ✓ | – | – | ZumiBot's own MCP bridges (to-dos, vault list, ask, browser). Neither protocol agent gets them in these phases (see Decisions for review) |
| **`isolation`** | ✓ | – | – | – | Sandboxed and Container isolation ([Governance](governance.md) 2.3, 2.4): the sandbox's settings and the container's wrap are the Claude CLI's. ZumiBot cannot hold an ACP agent's own process tree in them, nor a remote server's tools. Off, an agent set to a level has every run refused (`isolationRefusal`), and Agent Studio offers neither level. Codex was already refused this way on master, by name; the cap replaces that test with its sentences unchanged |

**Caps are per engine, not per agent.** ACP agents differ in resume support, `systemPrompt` support and image prompts. Those
differences are handled inside the adapter, never as UI caps:
- no resume → a reseed every turn;
- no `systemPrompt` → a preamble;
- no image capability → the send is refused.

The Test result lists them. So `engineCaps` stays a static `Record<Engine, EngineCaps>`, and the UI never waits on an agent's
`initialize`.

**Effort.** Effort stays `effortFits(engine) = engine === 'claude'`.

**The context meter.** It shows ACP's `usage_update` fill when an agent sends one. AG-UI reports no window, so it shows none.

## Where protocol agents can be used

**One rule:** a protocol agent goes wherever a Codex agent goes, unless a cap says no. Each place reads the cap, not the
engine's name.

| Place | ACP | AG-UI | Gate |
| --- | --- | --- | --- |
| Single chat, routine, workflow Agent and For each steps | ✓ | ✓ | — |
| Room member | ✓ | – | `rooms` |
| Asked agent in an A→B chat (B) | ✓ (its elicitations declined) | – | `remote` |
| Asking another agent (A) | – | – | `bridges` (the ask tool is a bridge) |
| Task-board assignment, review-loop attempts | – | – | `bridges` (task chats rely on the to-do bridge's `ask_user` and `ready_for_review`) |
| Answering an `@agent` card comment | – | – | `bridges` (`commentAskRefusal`; see Governance, connectors and card comments) |
| Sandboxed or Container isolation | – | – | `isolation` (`isolationRefusal`) |
| claude.ai connector switches | – | – | Claude only (`connectorEngineNote`) |
| Side question target | – | – | `btw` |
| `/todo` and a command that makes to-dos | – | – | `bridges` (its request tells the agent to use ZumiBot's to-do tools). The `/` menu hides them (`offersTodo`). The turn itself refuses them with `todoRefusal` before any run (`asksTodos` in `ChatService.runTurn` and `GroupService.post` / `rerunPost`, a room while any member lacks the cap), so Resend, routines and workflow steps are covered; `chats:send` and `chats:edit` also refuse up front so a draft or queue is kept. `readAs(user, reader, bridges)` leaves the request line off for a reader without the cap, so an older `/todo` in a reseeded history never reaches it |
| Picked automatically: voice routing, Jev's agent suggestion, Zumi Bot automations' agent picks | ✓ | – | `remote` (the user's words never go to a remote host the user did not pick for that message) |

How each place reads it (Rulings 8):
- **Voice** filters remote agents out before matching, so even a remote agent the user names reads as unknown, and a remote
  default is `no-agent` (`routeUtterance`, `talkAgents`).
- **Jev** (`jev:suggestAgent`) never offers one.
- **Zumi Bot** may keep a remote agent a routine or workflow already holds, and may not add one: `agentResolver(agents, kept)`
  refuses a new one with `AGUI_TEXT.zumiBotPick(name)`, so it can still edit a workflow that holds one. "Held" is by place: a
  workflow step by its handle (`keptKey(handle, agent)`), a routine's target, so the agent cannot be moved into another step.
- **Voice** is also the server's call: `chats:createVoice` reads a remote agent as unknown.
- **Asks:** `askRoster`, `askableAgents` and `AskService.targetOf` (`REFUSAL.remote`) leave a remote agent out.
- **The chip.** `remoteChip` (`state/agentEngine.ts`) gives `Remote · <host>` with the remote notice as its title;
  `RemoteChip.tsx` shows it after the `EngineInfo` "i" in a chat's pickers row and on the new-chat screen, never in a room.

**Spend caps.**
- An agent's `dailySpendCap` is hidden and refused without `cost`.
- A workflow's or routine's `spendCap` refuses, at save and again at run, a step or routine whose agent's engine lacks `cost`.
  The editors give a fixed sentence naming the agent. A cap that cannot hold is refused, never silently ignored.
- With no cap set, such agents run as usual. 1b records no cost for an ACP turn, so Usage shows none for it.
- Zumi Bot's workflow and routine formats learn the same rule.

## Governance, connectors and card comments (as built, merged with master 10.5.7)

Master's governance (the audit log, Sandboxed and Container isolation), claude.ai connectors and task-card comments landed
while these phases were on a branch. Each place that depends on the engine decides for ACP and AG-UI here, failing closed: a
feature the engine cannot honour is hidden and refused, never silently ignored in a way that weakens safety.

- **Isolation: refused, not ignored.** The `isolation` cap (above). `IsolationService.runFor` refuses a run whose engine lacks
  it when the agent is set to Sandboxed or Container (`{level, refused: isolationRefusal(engine, level)}`; the chat shows it as
  the error, nothing spawns), and `ChatService` keeps a belt after it: a level that ever came back for such an engine is
  refused again before the switch that spawns, never run as Off. `isolation:set` saves only Off for such an agent, and
  `isolation:get` returns `isolationRefusal(engine, null)` as `refused`, so Agent Studio's Isolation section stays shown (an
  agent saved as Sandboxed while it was a Claude agent can be set back to Off there) with both levels disabled and the reason
  above them, as master does for Codex. The setting lives in `audit/isolation.json`, never the agent file, so switching the
  engine in Agent Studio keeps it and the runs are refused until it is Off.
- **The audit log: ACP like Claude, AG-UI as remote.** `AuditEngine` is `Engine`. An ACP run's tool rows, cards and answers go
  through `ChatService`'s permission path and its `AuditTap` exactly as a Claude or Codex run's, recorded under `engine: 'acp'`
  (a call the agent ran without asking is `allowedByMode`: the agent's own mode allowed it). A remote (AG-UI) run is audited
  too, under `engine: 'ag-ui'`, with two decisions of its own: `ranRemotely` for a row its server ran (no approval reached
  ZumiBot, which could neither see it first nor stop it; a muted chip, never a green one), and `deniedByZumiBot` /
  `remoteTools` for a call the server asked ZumiBot to run (answered with `AGUI_TEXT.noTools`, an error only ZumiBot
  writes). A row an interrupt's question card answered keeps `approvedByUser` and the answer. The tap reads the `remote` cap,
  not the engine's name. Events reach the tap after `scrubEvent`, and the auth header's value is in the run's scrub map, so no
  key value is ever written; `chatServiceAgui.test.ts` checks a record set that saw the key in a call's arguments.
- **Connectors: none.** Only Claude's CLI loads claude.ai connectors. `agentRunConfig` (and so `connectorPrefixes` and
  `connectorsOff`) is read for a Claude run only; every other engine gets `NO_RUN_CONFIG`, so no tool of theirs is ever classed
  as a connector call and no connector read is ever auto-allowed for them. `connectors:set` refuses any agent but a Claude one
  (`notSwitchable`, unchanged), Settings › Connectors lists only Claude agents' switches and says per engine why the others
  have none (`connectorEngineNote`: Codex's sentence unchanged, then ACP's and remote agents'), and Agent Studio shows no
  loadout card for an engine without `bridges`. Switches stored while an agent was a Claude agent are kept but unused. An ACP
  agent's own configuration (an ACP adapter of Claude Code, say) may load connectors of its own: ZumiBot neither grants nor
  blocks them, and their calls get the ordinary ACP cards.
- **Card comments with `@agent`.** A mentioned agent answers in a chat for that card that the message points at the
  `zumibot_todos` tools, so only an agent with `bridges` answers: `CommentAsks` refuses the comment, before anything is
  stored, with `commentAskRefusal(engine, name)` when it mentions an ACP or remote agent, and the comment box's `@` list
  offers only `givableAgents` (the same set a card can go to). A reply that names nobody goes on with its thread's agents
  (master 10.5.9, `threadAgents`); one that has lost `bridges` since (moved to ACP or a remote server) is left out there,
  never asked and never a reason to refuse the user's reply. Task cards keep `needsBridges` (now checked before the card
  moves to To do), and remote agents stay out of asks and automatic picks.
- **Background processes.** A run gets the process bridge only with `processes`, `bridges` and isolation Off; ACP and AG-UI
  have neither cap, so they never get it, as before.
- **Optional folder.** A chat with no folder runs in its own `~/zumibot/cache` scratch folder whatever its engine: an ACP
  agent works there; a remote agent is sent no folder at all.
- **What ZumiBot still cannot keep an ACP agent off.** Claude and Codex runs carry the vault guard, which now also denies the
  audit folder (with `isolation.json`) and `connectors.json`. An ACP run has no guard beside it (`vaultKeys` off), so, as for
  the vault files, only the cards its own reads, edits and commands ask for stand between it and those files; the audit log's
  hash chain (Verify chain) shows a changed record.

## Session ids across engines

- **One mark, widened.** `ChatMeta.sessionEngine`, `SessionCut.engine` and `GroupInfo.sessionEngines` widen from `'codex'` to
  `'codex' | 'acp' | 'ag-ui'` (absent is still Claude).
- **Mismatch reseeds.** The rule stays the one Codex introduced: a turn whose agent's engine differs from the mark drops the
  session and reseeds from the visible items, with the `expired` notice.
- **What 1a changes.** The comparisons in `sessionPoints.ts` (`enginesAfter`, `withSessionEngines`), `fork.ts`,
  `groupService.ts`, `sideQuestions.ts` and `deploy/sync.mjs` (`copyMeta` and the copy chat) change from `=== 'codex'` to "the
  stamp's engine, whatever it is", so a fork, a copy chat or a room member carries any engine's mark.
- **An agent's command changes but the engine stays `acp`.** Gemini to opencode, say: the old id reaches the new agent's
  `session/resume` or `load`, which fails with `-32002` or another error, and the turn reseeds once. No session is written into,
  because an ACP load never writes.
- **AG-UI ids** are minted by ZumiBot, so they can never collide with another engine's.
- **Older builds on the other machine.**
  - An older build that syncs a chat with an `acp` or `ag-ui` mark reads it as Claude. It hands the id to `claude --resume`,
    which does not find it and reseeds: harmless, as `codex.md` already notes for Codex.
  - An older build that syncs an agent file with `provider: acp` runs that agent **on Claude**, because its parser only knows
    `codex`. So both machines must be updated together.
- **Unknown `provider:` values keep today's meaning.** `parseProvider` recognises exactly `codex` (1a), then `acp` and `ag-ui`
  (1b, Phase 2). Anything else, `provider: claude` and odd spellings such as `Codex` included, still runs on Claude, as
  `frontmatter.test.ts` and `agentStore.test.ts` pin today. Making unknown values unrunnable would change Claude agents'
  behaviour, so it is not done.

## What the protocols cannot express that the UI needs

**ACP**
- Edit, Resend, Fork and version switches: no rewind at a point in stable v1.
- An approval with edited input, or a plan's "keep planning" feedback: a permission answer is only an option id.
- ZumiBot's own modes (Auto's classifier, Accept edits, Plan): modes are agent-defined ids, and set_mode is not tied to an
  approval.
- Pause and the vault guard: there is no hook to block a call.
- A per-turn cost in USD: cost is optional, session-cumulative and in any currency.
- Which calls ask at all: ZumiBot can pick the agent's `default` mode where one exists, but what a mode means is the
  agent's own (its allow rules still apply in it), and an agent without one decides alone.
- A side question's read-only fork.

**AG-UI**
- Approvals in a generic shape: the payloads are framework-specific.
- Cancel that reaches the server: only abort the stream.
- Cost; a context window.
- Who the remote agent is beyond a URL: there is no discovery endpoint.
- Any local tool without new consent machinery.

## Dependencies

**None new.** Both clients are hand-written, so nothing changes in `package.json`, and the bundle into the one
`dist/server.mjs` is unaffected. `node:child_process`, `node:https`, `node:dns` and `node:net` cover transport and address
checks; *as built,* also `node:http` (the dev hook's loopback `http:` only) and `node:tls` (Test's handshake, Rulings 10).

If review prefers the ACP SDK: pin `@agentclientprotocol/sdk@2.7.0` exactly, use its v1 stable entry only, and declare its zod
peer explicitly (zod 4.6.7 is already in the tree through the Agent SDK). Then confirm `npm run build:server` still yields one
self-contained `dist/server.mjs`. Phase 1 of `engines.md` already showed Vite inlines such a package.

## Tests

**Fixtures** (`backend/tests/fixtures/`):

- **`fake-acp-agent.mjs`.** Driven by `FAKE_ACP_SCRIPT`, like `fake-codex.mjs`. It answers `initialize` with scripted caps,
  `session/new` / `resume` / `load` (with a replay), and replays per prompt:
  - text and thought chunks;
  - a tool call with a diff;
  - a permission request that waits for its answer;
  - an elicitation;
  - a `usage_update`;
  - a bypass-mode report.

  Its edge cases:
  - honours `session/cancel` with `stopReason: cancelled`;
  - can crash mid-turn (exit 1 after a chunk), write a malformed line, or answer `-32000`;
  - leaves a grandchild in its group, to check Stop ends the tree;
  - sends updates in the same write as a session start's answer, before or after it (`beforeStart`, `afterStart`), to check
    the replay boundary and the mode check before the session is known.

  It logs requests to `FAKE_ACP_LOG` and answers to `FAKE_ACP_ANSWERS`.
- **`fake-agui-server.mjs`.** A loopback HTTP server under the dev hook. It streams scripted SSE:
  - text, reasoning and a backend tool call with a result;
  - an interrupt with a `responseSchema`, then checks the `resume[]` it gets;
  - `RUN_ERROR`, and a stream cut with no terminal event;
  - a malformed known event, an oversize event, and a slow drip past the idle timeout;
  - a cross-host redirect, and a 401.

  It records each request's headers and body, so tests can check the auth header and that no value leaked elsewhere.

**Unit tests** (pure modules):
- `acpEvents` (update → `RunEvent`), `acpTools` (classification), `acpAnswers`, `acpElicitation` (schema → card and back), and
  the refused arguments and modes;
- `aguiEvents`, `aguiSse` (framing, comments, caps), `aguiEndpoint` (every address class, IPv6, mapped forms, redirects), and
  `aguiInterrupts`;
- the 1a trait records and `parseProvider`.

**E2E:** `e2e:acp` and `e2e:agui`, fakes only, no quota. Through the UI they check:
- a chat, a card answered, a question answered;
- Stop with a card open, after which no process is left;
- a crash, and a reseed after a failed load;
- hidden Edit, Resend and Fork for ACP;
- the remote chip and notice for AG-UI;
- a refused launch after an outside edit (launch trust);
- for ACP, a room with an ACP member.

**Smoke runs:** `smoke:acp` (the Claude Agent ACP adapter, then Gemini CLI) and `smoke:agui` (Pydantic AI), opt-in like
`smoke:codex` and never part of `npm run e2e`. *As built,* `smoke:acp` runs one agent per run, named by `ZUMIBOT_SMOKE_ACP`
(`<command> <args…>`), so each test agent is a run of its own, and `smoke:agui` one endpoint, named by `ZUMIBOT_SMOKE_AGUI`.

**Unchanged:** every Claude and Codex test and fixture, apart from imports.

## Docs, when each phase lands

- **This doc.** It becomes the area doc for `core/acp/` and `core/agui/`, each with a pointer `CLAUDE.md`.
- **Other docs.**
  - [Codex agents](codex.md) and [Agents](agents.md), where they describe the Engine select and `provider`.
  - [Engines](engines.md), for 1a's exhaustive checks and traits.
  - [Data folder](data.md), for `protocol-launch.json` and `chats/<id>.agui.json`.
  - [E2E](e2e.md), for the new suites and smoke runs.
  - [Vault](vault.md), for the AG-UI auth key.
  - [Chat mode and effort](chat-mode-and-effort.md), for ACP's single mode.
- **Root `CLAUDE.md`.** It keeps its one index line for this doc and stays under 16 KB.

## Decisions for review

1. **Phase 1a first** (the exhaustive engine checks and traits, no behaviour change) as its own change, then the ACP engine.
2. **Edit, Resend and Fork on for AG-UI** (a new thread from the visible history), or off like ACP.
3. **Launch trust:** a command or endpoint confirmed per machine in Agent Studio before any run.
4. **No ACP client fs or terminal methods.**
5. **No new dependency** (hand-written clients), against the ACP SDK.
6. **ACP sign-in with a Vault API key: decided yes (2026-11-17).** `acp.authEnv` (see The run, Environment), so an agent that
   signs in only through an env var (`GEMINI_API_KEY`, `CURSOR_API_KEY`, `KIRO_API_KEY`, Qwen's `OPENAI_API_KEY`) can run on
   a headless VPS.
7. **Installing the test agents.**
   - ACP: Claude Agent ACP adapter 0.108.0 and Gemini CLI 0.68.0 (a Google login or a Gemini API key).
   - AG-UI: Pydantic AI, which needs a model API key. Which keys are available?
8. **Later, not in these phases.**
   - ZumiBot's bridges (to-dos, vault list, ask) for ACP agents as stdio MCP servers in `session/new`.
   - Accept edits for ACP (ZumiBot-side auto-allow of `edit` inside the folder).
   - The ACP model picker.
   - ACP slash commands in the `/` menu.
9. **At the merge with master 10.5.7** (see Governance, connectors and card comments): isolation refused for both protocol
   engines through a new `isolation` cap; ACP audited like Claude, AG-UI audited as `ranRemotely`; no connectors for either;
   card comments answered only by agents with `bridges`.

## Honest limits

- **An ACP agent decides which of its calls ask.** ZumiBot puts it in its `default` mode before every prompt when it has
  one (the Claude adapter's "Manual: always ask before making changes"), but the agent's own settings still apply inside that
  mode (the Claude adapter's `permissions.allow` rules, opencode's permission config), and an agent without a `default` mode
  keeps whatever its settings chose. ZumiBot refuses the known bypass flags and modes, but cannot see the agent's config
  files. Agent Studio says this plainly.
- **Stop ends the process tree, as far as `/proc` can see it.** A child that left the agent's session (`setsid`) is found by
  its ppid link while its parent lives, and kept once seen. What escapes: a process that double-forks away (its parent exits
  at once) between two snapshots; after a crash, a child the agent itself put in a session of its own (the agent is already
  gone when ZumiBot hears of it, and nothing links that child to it; what stays in the agent's session, such as the Claude
  CLI and its shells, is still found); and anything at all where `/proc` cannot be read (not Linux), where only the agent's
  group is ended. A snapshot reads every `/proc/<pid>/stat` synchronously (about 6 ms with 600 processes), a few times per
  attempt.
- **AG-UI cancel only aborts the stream.** Whether the server stops is up to it: Pydantic AI treats the disconnect as a cancel;
  others are unknown.
- **AG-UI approvals work only where the server describes them with a `responseSchema`.**
- **What Phase 1b's build learned:**
  - *No USD cost is recorded.* `usage_update.cost` is session-cumulative, so a turn's cost needs a per-session baseline
    store; 1b keeps `cost` off and Usage shows no cost for ACP turns.
  - *Tool ids are tagged per attempt.* A `toolCallId` is unique only within a session, and every attempt is a new process, so
    stored rows and cards carry the attempt's tag before the agent's own id: a row's id is not the one the agent sent.
  - *A refused mode ends the turn at once,* on the update that reports it. A call the agent ran under that mode before the
    update arrived was never asked about, so ZumiBot cannot undo it.
  - *Test reads `initialize` only.* An agent that is signed out but fails only at `session/new` passes Test, and its first
    send fails with the not-signed-in sentence.
  - *An agent that resumes nothing reseeds every turn,* resending the visible chat each time, so a long chat costs more per
    message. The turn shows no notice (`noResume`); Test's Sessions row is where the user learns it.
  - *A file change is rebuilt from the disk unless the diff is the whole file.* claude-agent-acp 0.108.0's edit diffs are
    the CLI's `structuredPatch` hunks (three context lines), lines joined without the last newline, one `diff` per hunk. A
    short file's one hunk is the whole file; a longer file's before is rebuilt from the disk as a subagent's `Edit` is (see
    Files above). A hunk whose new text is in the file twice (repeated lines inside its context), a file changed again before
    the result was read, or CRLF line endings (the CLI's hunks are LF) leave the before unrebuilt: the panel shows the after
    copy and the hunk's strings, and Restore to before that change is off. A diff whose file cannot be read when the result
    arrives (moved or deleted at once) keeps neither copy, only a lone hunk's strings; fragments are never kept as whole
    files. Only a new file's text (no `oldText`) is taken as sent.
  - *A row is named from the first input that classifies it.* claude-agent-acp sends `rawInput` one top-level field at a time.
    An unclassified call waits for its status, a card or the turn's end, so its row shows the input as it then stands. A
    classified row opens on the first field that classifies it, so a later field is missing from the row (a search whose
    `path` comes after its `pattern`); the card is still classified from the permission request's own fields.
  - *The fake agent is written from the spec,* not recorded from a real one. claude-agent-acp 0.108.0's modes, config
    options, permission options (`allow_once` / `reject_once` only), diffs and process tree are checked by `smoke:acp` and
    direct probes; other agents' shapes, and auth-method shapes (Test's terminal hint), are not.
- **What Phase 2's build learned:**
  - *TLS to real hosts (checked 2026-11-18 with `smoke:agui`, no dev hook).* Runs use `node:https` with verification asked
    for in each request, so not even `NODE_TLS_REJECT_UNAUTHORIZED=0` turns it off; unit tests check the run and Test's
    handshake against a real TLS server whose self-signed certificate is refused with that variable set.
    - `https://example.com/agent`: Test passed (every IPv4 and IPv6 address public, handshake verified), and a run crossed
      pinned TLS to the server, which answered 405; the chat showed only the status sentence. Nothing else was sent.
    - badssl.com: Test refused `self-signed` (`DEPTH_ZERO_SELF_SIGNED_CERT`), `wrong.host` (`ERR_TLS_CERT_ALTNAME_INVALID`),
      `expired` (`CERT_HAS_EXPIRED`) and `untrusted-root` (`SELF_SIGNED_CERT_IN_CHAIN`); the last two at times answered with a
      reset (`ECONNRESET`) before the check, which also fails closed. A run never got past step 1 there, and its client asks
      for the same verification.
    - *Revocation is not checked.* Node verifies the chain, names and dates but asks no OCSP or CRL by default, so a revoked
      certificate (`revoked.badssl.com`) still connects. ZumiBot adds no revocation check.
  - *Test sends no request.* It checks the address and completes a connection, so no message or key leaves the machine; a
    wrong key, a path the server does not serve or a server that speaks something else passes Test, and the first send fails
    with its fixed sentence (a 401 or 403 names `authKey`).
  - *Long tool arguments are resent cut.* A remote row keeps at most 20 000 characters of a call's arguments, and later turns
    rebuild their history from the rows, so a call whose arguments were longer goes back to the server cut, with
    `[output cut]`, as its `toolCalls` entry. The turn's own interrupt rounds resend the full text (the run's transcript).
  - *A stopped run's state is not saved.* State changes a run made before Stop stay in memory and are dropped with the rest of
    its output, so the next send carries the state from before it, even when the server kept the change.
  - *Stored interrupts can be lost on purpose.* They clear when a run that sent `resume` starts, when the server definitively
    refuses that request (a 4xx but 401, 403, 408 and 429, so a stale resume cannot block every later send), and when a late
    `RUN_ERROR` fails the run that asked them. A server that 4xx'd a resume only by mistake loses that one resume.
  - *Only the required fields are asked.* A schema with a required property is asked only its required ones: Pydantic AI's
    approval is a plain Yes/No, and its optional `reason` and `editedArgs` (an object no card can show) are never sent. A
    required field the card cannot show still cancels the interrupt, with its notice.
  - *Approval payloads are framework-specific.* Only a `responseSchema` the card can show is answered; LangGraph's legacy
    `CUSTOM on_interrupt` and a schema-less interrupt are cancelled with a notice naming their reason.
  - *Reserved addresses are refused even under the dev hook.* The special-purpose ranges (the `reserved` class) fail closed,
    so a real but exotic address there cannot be used; the dev hook allows only loopback and private.
  - *`/todo` is refused for agents without `bridges`* (ACP and AG-UI alike), and the `/` menu hides it: its request asks for
    ZumiBot's to-do tools, which such an agent does not have, and Rulings 13 sends a remote host no ZumiBot instructions.
  - *The remote row says where its tool ran.* A remote tool row reads `<tool> (ran on the remote server)`, beside the chip,
    its notice and Agent Studio's card.
  - *Every run resends the whole visible chat,* as the protocol requires, so a long chat costs more per message, and Edit,
    Resend and Fork are each a new thread whose server-side history (Pydantic's `manage_message_history='server'`) starts
    empty.
  - *Usage has tokens, no cost,* and the context meter shows nothing: AG-UI reports neither a price nor a window.
  - *The connect timeout is not tested:* a local test cannot make a TCP connect hang; it shares the tested headers timer's
    code path.
  - *The fake server is written from the spec,* not recorded; Pydantic AI 2.65's shapes (protocol version `1.0`, the empty
    message before each call, the approval interrupt with its schema, `TOOL_CALL_RESULT` in the resumed run) are checked by
    `smoke:agui` and the tests that replay them.
- **Not verified for this design:**
  - Of the AG-UI servers only Pydantic AI 2.65 was run, scripted (a `FunctionModel`, no model key) on loopback `http:`. Of the
    ACP agents only claude-agent-acp 0.108.0 was (signed in with the user's own Claude login).
  - Gemini CLI's sign-in in ACP mode (whether a cached Google login suffices without `authenticate`).
  - opencode's free models without a login.
  - Whether the advertised `session/resume` succeeds with a real id.
  - What a server does on abort: with Pydantic AI the chat ends at once (0.2 s) and the row closes as unfinished, but
    whether its tool went on running server-side was not checked; other servers are unknown.
  - Whether LangGraph's checkpointer keeps per-thread state under `ag-ui-langgraph`.
  - An auth header a real server checks (the real runs were keyless or to a server that ignored it).
  - The rest are what further smoke runs must settle.
- **The draft protocols are moving.** ACP session cursors landed upstream the day before this design. ACP v2 and AG-UI 1.1 are
  drafts. This design uses only ACP v1 stable and AG-UI 1.0.
