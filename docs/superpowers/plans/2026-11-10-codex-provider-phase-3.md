# Codex Provider (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex agents get the vault guard and vault API keys, Pause, the Dispatched agents panel, computer use and rooms. Their side answers get a deny-all hook, and the Phase 2 follow-ups (`excludeTurns`, the compact limit above the window, a fork at an interrupted turn) are settled by probe.

**Architecture:** Phase 1–2's seam stays.
- **Hooks.** Codex has `preToolUse` command hooks (`HookEventName`, `ConfiguredHookHandler` in the 0.164.0 protocol). Most of Phase 3 is ZumiBot handing each Codex run its own hooks. These are the same shell commands Claude runs get through `--settings`, read from Codex's hook input instead of Claude's.
- **Subagents.** Codex subagents are separate threads in the same app-server process (`collabAgentToolCall`, `subAgentActivity`). The mapper turns them into the `RunEvent`s the Dispatched agents panel already reads.
- **Rooms.** Rooms run each member through `ChatService.agentTurn`, so a Codex member only needs a per-member session engine and the refusals removed.
- **Gating.** Every feature is probe-gated: its `engineCaps('codex')` flag flips only when its check passes.

**Tech Stack:** TypeScript, Node 22, vitest, React 19, `codex-cli 0.164.0` app-server protocol (no new npm dependency).

**Spec:** `docs/superpowers/specs/2026-11-09-codex-provider-design.md`, the parts this phase implements:
- the Phase 3 rows of "Features by phase";
- probe checks 11–13;
- "Security": until Phase 3, no vault keys and no desktop.

Earlier plans hold the real-CLI facts:
- `docs/superpowers/plans/2026-11-09-codex-provider-phase-1.md` ("Phase 0 results");
- `docs/superpowers/plans/2026-11-09-codex-provider-phase-2.md` ("Phase 2 probe results", "Phase 2 smoke").

This plan adds probe checks 16–18 for the parked Phase 2 follow-ups.

## Global Constraints

- **Byte-identical Claude runs.** `backend/tests/core/claudeArgsPinned.test.ts` must pass after every task. No change to what a Claude run receives (argv, env, `--settings`, prompt) or how its events are handled. A shared helper refactor (for example the vault guard's command) must keep Claude's JSON byte-identical, with a test that pins it.
- **No bypass values.** Never `--dangerously-bypass-approvals-and-sandbox`, sandbox `danger-full-access` or `approvalPolicy: "never"`, side runs included.
- **No hook-trust bypass.** Never `--dangerously-bypass-hook-trust`. It would also run the user's and any project's unvetted hooks (`HookSource` `user`/`project`) in every agent run. If check 11 shows ZumiBot's own hooks cannot run without it, Tasks 2–5 are SKIP and the controller stops and asks the user.
- **ZumiBot hooks only.** A Codex run gains only the hooks ZumiBot writes. It never trusts, edits or adds hooks in `~/.codex` or a project's `.codex`.
- **Hooks fail closed.** A ZumiBot hook that cannot read its input, times out reading it, or meets a shape it does not know blocks the call. A run whose hook entry is missing from the build gets no feature that relies on it:
  - no Pause (refused as `PAUSE_UNAVAILABLE` says);
  - no vault API keys in the env;
  - side runs keep decline-all.
- **Probe-gated features.** A feature whose probe check is FAILED or INCONCLUSIVE stays off: its `engineCaps('codex')` flag stays `false`, its task is SKIP and the ledger says why. Never switch a flag on against a failed check.
- **Fixed sentences.** Errors shown to the user come from `CODEX_REFUSALS` or the existing fixed sentences (`VAULT_GUARD_TEXT`, `PAUSE_BLOCK_TEXT`, `PAUSE_UNAVAILABLE`, …), never CLI text, except through the existing redacted error path.
- **Side runs never act.** A Codex side run still declines every request with no card. The deny hook (Task 5) is an extra wall, not a replacement.
- **Rooms' moderator stays Claude.** Only member turns may run on Codex.
- **Existing conventions.** Comments are short and say why. Dependencies stay pinned, with no new dependency. Secrets never go in logs or errors.
- **No commits.** The user's rule: never commit unless asked. Each task ends at a **checkpoint**, not a commit.

## Review Focus

1. **Vault read by an auto-run command.**
   - Input: in auto mode Codex runs a "known safe" read such as `cat ~/.config/zumibot-vault/vault.key` without asking.
   - Expected: the vault hook still runs and blocks it, and the model sees `VAULT_GUARD_TEXT`.
   - Probe: check 11 runs such a read.
   - Test: Task 3 (`an auto-run read of the key is blocked`).
2. **Pause while a Codex subagent works.**
   - Expected: the subagent's calls keep running when check 11 can tell them apart. The main thread's calls are blocked with `PAUSE_BLOCK_TEXT`. The pause lands once the turn ends, and Resume continues the same thread.
   - Test: Task 4 (`pause blocks the main thread and lets a subagent finish`).
3. **Stop during a Codex subagent.**
   - Expected: `turn/interrupt` ends the main turn and every child thread. No `codex app-server` is left, and the dispatch entries end `stopped`.
   - Test: Task 6 (`stop ends every subagent`).
4. **A room member switched to Codex after its Claude session.**
   - Expected: the member's next turn reseeds with the `expired` notice (per-member engine mismatch). A Claude session id never reaches `runCodex`, and a thread id never reaches `claude --resume`. A room rewind (`GroupService.rerun`) forks Codex members and cuts Claude members.
   - Test: Task 8 (`a member's engine switch reseeds only that member`).
5. **A hook entry missing from the build.**
   - Expected: no Codex run gets a hook that points at a missing file. Pause is refused, API keys stay out of the env, and runs still work.
   - Test: Task 2 (`no hook entry gives no hooks`).

---

### Task 0: Probe checks 11, 12, 13, 16, 17 and 18

**Files:**
- Modify: `zumi-bot-server/e2e/codexProbe.mjs`, `zumi-bot-server/backend/tests/codexProbe.test.ts`
- Record: `zumi-bot-server/backend/tests/fixtures/codex/codex-check{11,12,13,16,17,18}.jsonl`

**Interfaces:**
- Produces: `judge(check, t)` gains cases 11, 12, 13, 16, 17, 18. These run only with `--only` (the default run stays checks 1–6).
- Produces: the "Phase 3 probe results" section at the end of this plan.

Checks (the spec's text for 11–13, plus three new ones). Every check runs in a temp git folder with a temp `CODEX_HOME` holding no `config.toml` hooks, so no user or project hook can mix in. The login still comes through codex itself, and the probe never reads `~/.codex`.

- **11. PreToolUse hook.**
  - **Hook source.** Pass one `preToolUse` command hook per request. Try `thread/start`'s `config` first, then `-c hooks…` on the app-server command line. The probe's hook appends its stdin to a log file. It exits 2 with `BLOCKED-BY-PROBE` on stderr when the input names `blocked-marker`, else exits 0.
  - **Steps:**
    - Ask the model to run `echo ok`, then `touch blocked-marker`.
    - Call the probe MCP tool.
    - Create `patch-marker.txt` with its patch tool.
    - In **auto** mode, run `cat` on a file outside the project.
  - **Record:**
    - the exact config shape and source that worked;
    - each hook stdin JSON verbatim (tool name and input fields);
    - whether `hooks/list` shows the hook as `trusted`, `untrusted` or `sessionFlags`;
    - which exit code blocks;
    - what the model and the item's result see when blocked (the stderr text?);
    - whether `hook/started` / `hook/completed` notifications come;
    - whether the hook fires for the auto-run `cat`, for MCP calls and for patches;
    - the hook's timeout field and what a hook timeout does.
  - **Subagent identity.** With `multi_agent` enabled, ask the model to spawn one subagent that runs `echo sub`. Record whether the hook input tells the subagent's call apart from the main thread's: a thread id, `agent_id`, agent path or other field.
  - **PASS** when the hook ran from a per-run source **without** `--dangerously-bypass-hook-trust`, blocked `touch blocked-marker` (the file does not exist) and ran for the shell, MCP and patch calls.
  - **FAIL** when the blocked command ran.
  - **INCONCLUSIVE** when the hook only runs with the trust bypass, or never ran. Gate: Tasks 2–5 SKIP, and the controller asks the user.
- **12. Forced MCP approval.**
  - **Steps:** in **auto** mode, configure the probe MCP server with a per-tool approval setting for `probe_echo`. Try `mcp_servers.probe.tools.probe_echo.approval_mode` with each of `"prompt"` and `"approve"` (`AppToolApproval`), then any other per-tool key the bindings name. Ask the model to call it.
  - **PASS** when an `mcpServer/elicitation/request` (or another approval request) arrives before the tool runs (`marker-mcp.txt` absent until accepted), and a decline keeps it from running.
  - **INCONCLUSIVE** when no config makes it ask. Computer use then stays off.
  - **Record:** the working key and value, and the request's shape.
- **13. Subagents.**
  - **Steps:** with `--enable multi_agent` (not disabled), ask the model to spawn a subagent that runs `echo child` and reports back.
  - **Record:**
    - every notification's `threadId`;
    - the `collabAgentToolCall` items (`tool`, `status`, `receiverThreadIds`, `agentsStates`, `prompt`);
    - `subAgentActivity` (`kind`, `agentThreadId`, `agentPath`);
    - whether the child's own `item/*` notifications arrive on this connection (with the child's `threadId`);
    - whether a child's command approval reaches the client in manual mode, and with which `threadId`;
    - whether `turn/completed` waits for the child.
  - **Then, Stop:** start a child running `sleep 60`, send `turn/interrupt` for the main turn, and record whether the child ends (`subAgentActivity` `interrupted`, no `sleep` process left after the process closes).
  - **PASS** when the collab items arrive and Stop leaves no child running.
  - **FAIL** when a child outlives the closed process.
- **16. `excludeTurns` on resume and fork.**
  - **Steps:** a two-turn thread (ALPHA, BETA). Run `thread/resume {excludeTurns: true}` and ask "which words did I say?". Then run a non-ephemeral `thread/fork {lastTurnId, excludeTurns: true}` and ask the same.
  - **PASS** when both replies still name the kept words and the answers carry no `turns`.
- **17. Compact limit above the window.**
  - **Steps:** `thread/start` with `config.model_auto_compact_token_limit` set to `modelContextWindow + 100000`. Use the window from check 1's token usage.
  - **Record:** whether codex accepts it, clamps it (any notice), or errors.
  - **PASS** when it is accepted. The record decides whether Phase 2's F2 guard stays; it stays either way unless codex clamps visibly.
- **18. Fork at an interrupted turn.**
  - **Steps:** a turn interrupted mid-`sleep`, then `thread/fork {lastTurnId: <interrupted turn id>}`.
  - **Record:** whether codex accepts it and what the fork remembers.
  - **PASS** when it is accepted, and also PASS when it is refused with an error (Phase 2's F4 reseeds). FAIL only when it hangs.

- [ ] **Step 1: Write `judge` tests for the six checks** with hand-written transcripts: each check's PASS case and its FAIL or INCONCLUSIVE case, as listed above.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/codexProbe.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the six checks.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Run the real probe:** `node zumi-bot-server/e2e/codexProbe.mjs --only 11,12,13,16,17,18 --record zumi-bot-server/backend/tests/fixtures/codex`. This uses a few cents of the user's Codex quota, authorised when the user said "continue with phase 3".
  - Scrub the fixtures: no auth, home path, host name or install id.
  - Write "Phase 3 probe results" below, with the facts each later task needs.
- [ ] **Step 6: Gate.** Mark each later task GO or SKIP by its check:
  - check 11 → Tasks 2–5;
  - check 11's subagent identity → the subagent half of Task 4 (otherwise a Codex Pause also blocks subagent calls, documented);
  - check 12 → Task 7;
  - check 13 → Task 6;
  - check 16 → Task 1's `excludeTurns` step.

  Task 1 (apart from `excludeTurns`), Task 8 and Task 9 always run.
- [ ] **Step 7: Checkpoint.**

### Task 1: Runner hooks, `multi_agent` switch and `excludeTurns`

**Files:**
- Modify: `zumi-bot-server/backend/src/core/codex/codexRunner.ts`, `codexParams.ts`, `codexEvents.ts`
- Test: `codexRunner.test.ts`, `codexParams.test.ts`, `codexEvents.test.ts`, `fakeCodex.test.ts`
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-codex.mjs`

**Interfaces:**
- Produces: `export interface CodexHook { event: 'preToolUse'; matcher: string | null; command: string; timeoutSec: number }` in `codexParams.ts`.
- Produces: `CodexThreadInput.hooks?: CodexHook[]`. It is turned into the source check 11 found (`config` or `-c` arguments), in one function `hookConfig(hooks: CodexHook[])`. With none, the request and argv are byte-identical to today.
- Produces: `CodexRunOptions.subagents?: boolean`. When true, the runner omits `--disable multi_agent`. `FIXED` still drops `multi_agent` from `enable`, so only this option turns it on.
- Produces: resume and non-ephemeral fork send `excludeTurns: true`, when check 16 passed.
- `hook/started` and `hook/completed` map to nothing (dropped), unless check 11 showed they are the only place a block's text appears. In that case the mapper attaches the text to the blocked item's result so `PAUSE_MARKER` and `VAULT_GUARD_TEXT` reach the tool row.

- [ ] **Step 1: Write tests:**
  - `hookConfig` of one hook gives exactly check 11's recorded shape;
  - no hooks gives today's request (pinned by a snapshot);
  - `subagents: true` drops `--disable multi_agent` and `enable: ['multi_agent']` still cannot;
  - a resume and a non-ephemeral fork carry `excludeTurns: true`;
  - a blocked command's tool result carries the hook's stderr text (fake replays check 11's fixture).
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement.** The fake learns to run a configured `preToolUse` hook command, the same way `fake-claude.mjs`'s `#PRE_TOOL` does: through `sh -c` with the run's env, the input shaped as check 11 recorded, and exit 2 meaning blocked. That lets later tasks test real hook commands.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 2: Codex hook builders and hook input

**Files:**
- Create: `zumi-bot-server/backend/src/core/codex/codexHooks.ts`
- Modify: `zumi-bot-server/backend/src/core/vault/vaultGuard.ts`, `zumi-bot-server/backend/src/core/chat/pauseSettings.ts`, `zumi-bot-server/backend/src/pauseHook.ts`
- Test: `zumi-bot-server/backend/tests/core/codexHooks.test.ts`, `vaultGuard.test.ts`, `pauseSettings.test.ts`

**Interfaces:**
- Consumes: `CodexHook` (Task 1).
- Produces:
  - `export function vaultGuardCommand(o: {keyFile, vaultFile, home}): string` in `vaultGuard.ts`. It is the `grep -qF … exit 2` command. `vaultGuardSettings` builds from it and stays byte-identical (test).
  - `export function codexVaultHooks(o: {keyFile, vaultFile, home}): CodexHook[]`. It runs `vaultGuardCommand` for every tool check 11 showed carries a command or a path (shell, patch, MCP), with the matcher check 11 recorded.
  - `export function codexPauseHook(rt: {node, pauseHookEntry, electronNode}): CodexHook | null`. It uses the same `[ -e "$ZUMIBOT_PAUSE_FILE" ] || exit 0; exec node pauseHook.mjs` command. Null when `pauseHookOf` would be null.
  - `export const CODEX_SIDE_DENY_HOOK: CodexHook`. It blocks every call with `No tools in a side answer` (the side guard's text).
  - `export function codexBlocks(input: string): boolean` in `pauseSettings.ts`. It applies the pause rule to Codex hook input: false only for a call check 11 identified as a subagent's; true for the main thread, unknown shapes and unreadable input. `pauseHook.mjs` picks `codexBlocks` when its env has `ZUMIBOT_HOOK_INPUT=codex` (set only on Codex runs), else today's `blocks`.

- [ ] **Step 1: Write tests:**
  - the vault command blocks check 11's recorded stdin naming the key file and passes one that does not;
  - `vaultGuardSettings` output is unchanged (snapshot taken before the refactor);
  - `codexBlocks` returns true for the main thread's recorded input, false for the subagent's (if check 11 found a field), and true for `{}` and for `not json`;
  - `runPauseHook` with `ZUMIBOT_HOOK_INPUT=codex` blocks the main thread's input;
  - **no hook entry gives no hooks:** `codexPauseHook` returns null when the entry file is missing.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexHooks.test.ts zumi-bot-server/backend/tests/core/vaultGuard.test.ts zumi-bot-server/backend/tests/core/pauseSettings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 3: Vault guard and API keys for Codex agents (GO only if check 11 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (the Codex branch of `agentTurn`: hooks and env)
- Modify: `zumi-bot-server/shared/src/engine.ts` (`vaultKeys: true`)
- Modify: `zumi-bot-server/frontend/src/state/agentEngine.ts` (`CODEX_VAULT_NOTE`) and the Vault editor's agent list, which stops marking Codex agents
- Test: `chatService.test.ts`, `agentEngine.test.ts`, the vault settings state test

**Interfaces:**
- Consumes: `codexVaultHooks` (Task 2), `CodexThreadInput.hooks` (Task 1), `vaultEnvOf` (`core/vault/vaultEnv.ts`).

Rules:
- Every Codex main run (single chat, routine, A→B asked run, room member after Task 8) gets the vault hooks.
- A granted agent's API keys go into the env first, exactly as for Claude, and only when the vault hooks were attached. A run with no guard gets no keys (fail closed).
- Compact and side runs get no keys, as for Claude.
- `CODEX_VAULT_NOTE` becomes the same honest-limit wording Claude agents have: the guard is a speed bump, not a wall.

- [ ] **Step 1: Write tests:**
  - a Codex turn's thread request carries the vault hooks;
  - a granted key is in the Codex process env, and its value is scrubbed from a reply as `[vault: <name>]`;
  - **an auto-run read of the key is blocked:** the fake runs the hook on check 11's auto-run `cat` input naming the key file, and the tool row's result holds `VAULT_GUARD_TEXT`;
  - a run whose hooks could not be built gets no key;
  - `engineCaps('codex').vaultKeys` is true;
  - the Vault editor lists Codex agents like any other.
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 4: Pause for Codex agents (GO only if check 11 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`canPause`, the Codex branch's hooks and env: `ZUMIBOT_PAUSE_FILE`, `ZUMIBOT_HOOK_INPUT=codex`)
- Modify: `zumi-bot-server/shared/src/engine.ts` (`pause: true`)
- Test: `chatService.test.ts`, `taskQueue.test.ts` if its pause path reads the cap, `rpc/handlers.test.ts`

**Interfaces:**
- Consumes: `codexPauseHook`, `codexBlocks` (Task 2); the existing pause machinery (`TaskQueue.pause`, `setPauseFlag`, `finishPause`, the safety cap counting blocked results that carry `PAUSE_MARKER`).

Rules:
- A Codex main run gets the pause hook beside the vault hooks.
- `canPause` needs the hook (null hook → `PAUSE_UNAVAILABLE`), as for Claude.
- The safety cap (`PAUSE_BLOCK_CAP` rounds) counts Codex blocked results. Codex has no per-response message id, so a round starts at each `agentMessage` or `reasoning` item that follows a tool item: the tool calls of one model response share a round, as Claude's calls of one `message.id` do. A round counts when it had a blocked main-thread call. Check 11 records what a blocked result carries.
- Without check 11's subagent identity, a Codex pause blocks subagent calls too. `PausingLine` then counts none. Document this in Task 9.

- [ ] **Step 1: Write tests:**
  - with the flag file present, the fake's hook blocks the main thread's command and its result carries `PAUSE_MARKER`;
  - the turn ends and the chat lands `paused` with the `userPaused` notice;
  - Resume sends `Continue` on the same thread (`thread/resume`);
  - **pause blocks the main thread and lets a subagent finish:** only when check 11 found the field and Task 6 is GO; the subagent's input passes;
  - the cap stops a run after `PAUSE_BLOCK_CAP` blocked rounds;
  - `chats:pause` on a Codex chat no longer refuses with `CODEX_REFUSALS.pause` while the cap is on, and still does when the cap is forced false (Phase 2's injected caps).
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 5: Side-run deny hook (GO only if check 11 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/btw/sideRun.ts` (the Codex branch)
- Test: `sideRun.test.ts`

**Interfaces:**
- Consumes: `CODEX_SIDE_DENY_HOOK` (Task 2).

Rule: every Codex side run (user side questions, follow-ups, a Claude A's `side_question` to a Codex B) gets the deny hook. It closes the honest limit that `untrusted` auto-runs known-safe reads in a side answer. Decline-all stays.

- [ ] **Step 1: Write tests:**
  - a Codex side run's fork carries the deny hook;
  - the fake's hook blocks an auto-run `cat` in a side run;
  - a declined approval request still gets `decline` with no card.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/sideRun.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 6: Dispatched agents panel (GO only if check 13 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/codex/codexEvents.ts` (collab mapping), `codexRunner.ts` (child-thread requests)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (pass `subagents: caps.dispatch`; child approval cards)
- Modify: `zumi-bot-server/shared/src/engine.ts` (`dispatch: true`)
- Test: `codexEvents.test.ts`, `codexRunner.test.ts`, `chatService.test.ts`, `dispatchRecorder.test.ts` (only if a gap shows)

**Interfaces:**
- Consumes: `CodexRunOptions.subagents` (Task 1); the existing `RunEvent`s the `DispatchRecorder` reads: `toolUse {name: 'Agent'}`, `taskStarted`, `taskProgress`, `taskUpdated`, `subText`, `subToolUse`, `subToolResult`.

Mapping, using check 13's facts:
- A `collabAgentToolCall` with `tool: 'spawnAgent'` becomes a `toolUse {name: 'Agent', input: {description, prompt}}` keyed by the item id, plus `taskStarted` per `receiverThreadIds` entry.
- Its completion becomes the `toolResult`, with the report taken from `agentsStates` / the child's last message.
- Other collab tools (`wait`, `sendInput`, `closeAgent`, …) become plain tool rows, not dispatches.
- A child thread's `item/*` notifications become `subText`, `subToolUse` and `subToolResult` with `parent` = the spawn item's id.
- `subAgentActivity` `completed`, `interrupted` becomes `taskUpdated`.
- A child's approval request becomes a normal card whose label names the subagent. Its request id is tagged like any other (`requestTag`).
- A child's `fileChange` result goes through `FileTracker.ownPatch` with the subagent's label, so the Files panel lists a subagent's patches as it does a Claude subagent's `Edit`/`Write`.

- [ ] **Step 1: Write tests:**
  - check 13's fixture replays into the expected `RunEvent` sequence;
  - a Codex turn with a spawned child records one dispatch entry with its steps and report (`dispatch:list`/`dispatch:get`);
  - **stop ends every subagent:** Stop during a child's `sleep` sends `turn/interrupt`, the entry ends `stopped`, and no fake process is left;
  - a child's command approval shows a card and is answered by id;
  - a child's patch shows in the Files panel with its subagent label;
  - with `dispatch` forced false, the runner still passes `--disable multi_agent`.
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 7: Computer use for Codex agents (GO only if check 12 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (the Codex branch's desktop turn: today it uses `noDesktopTurn`)
- Modify: `zumi-bot-server/backend/src/core/desktop/desktopIpc.ts` (expose the turn's `McpServerSpec` as the other bridges do, if it does not yet)
- Modify: `zumi-bot-server/backend/src/core/codex/codexParams.ts` (the forced-approval config for the 8 action tools, in check 12's shape)
- Modify: `zumi-bot-server/shared/src/engine.ts` (`desktop: true`)
- Modify: `zumi-bot-server/frontend/src/components/AgentDesktop.tsx` and `state/agentEngine.ts` (`CODEX_UNUSED_NOTE` stops naming computer use)
- Test: `chatService.test.ts`, `codexParams.test.ts`, `agentEngine.test.ts`

**Interfaces:**
- Consumes: the desktop action tool names behind `DESKTOP_ASK_SETTINGS` (the same 8). The answer path for elicitations already exists from Phase 1. A desktop elicitation names its tool, so its card is the normal desktop card (`desktopActionSummary`, Show on desktop).

Rules:
- A Codex agent with `computerUse: true` gets the `zumibot_desktop` bridge and its capability env.
- Each of the 8 action tools always asks, in auto mode too, through check 12's config.
- Looking tools follow the mode.
- Side runs get the bridge as Claude side runs do, plus the deny hook (Task 5) when GO.

- [ ] **Step 1: Write tests:**
  - a Codex turn of a `computerUse: true` agent carries `mcp_servers.zumibot_desktop` and the per-tool approval config for exactly the 8 action tools, in auto mode;
  - a `desktop_click` elicitation from the fake shows the desktop card and Deny declines it;
  - the stored tool result is `Desktop command completed.`;
  - the Agent Studio switch is enabled for a Codex agent.
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 8: Rooms with Codex members

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts`: `GroupInfo.sessionEngines?: Record<string, 'codex'>`, the room's per-member equivalent of `ChatMeta.sessionEngine`.
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts`:
  - drop the `engineOf` refusal at ~196;
  - per-member engine on run, rerun and Compact;
  - drop `refuseCodex` for room `/btw` and Compact.
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (the room branch of `agentTurn` reads and writes the member's engine), `sessionPoints.ts` (member start points carry the stamp's engine), `fork.ts` and `roomClone.ts` (copy `sessionEngines` as sessions are copied)
- Modify: `zumi-bot-server/backend/src/core/groupMembers.ts` (`refuseCodexMembers` refuses only while `engineCaps('codex').rooms` is false), `rpc/handlers.ts`, `core/routines/routineRunner.ts`, `core/btw/sideQuestions.ts` (room `/btw` to a Codex member)
- Modify: `zumi-bot-server/shared/src/engine.ts` (`rooms: true`; `chatEngine` for a room takes a member)
- Modify: `zumi-bot-server/frontend/src/` member pickers (the member picker leaves Codex agents out only while the cap is off)
- Modify: `zumi-bot-server/deploy/sync.mjs` (`copyMeta` and the room join keep `sessionEngines` per member, mirroring the stamp's engine like Phase 2's F5)
- Test: `groupService.test.ts`, `chatService.test.ts`, `sessionPoints.test.ts`, `fork.test.ts`, `roomClone.test.ts`, `groupMembers.test.ts`, `sync.test.ts`, the frontend member picker test

**Interfaces:**
- Consumes: Phase 2's start points (`{sessionId, next, engine?}`) and the injectable caps.

Rules:
- The moderator stays Claude.
- A Codex member's briefing (`buildBriefing`, the handoff, the role) goes into `baseInstructions` as its appended prompt does for Claude.
- A member's stamps carry `engine: 'codex'`.
- `GroupInfo.next[member]` forks for a Codex member and cuts for a Claude member.
- A member whose engine differs from its stored session engine reseeds alone, with the `expired` notice.
- Room Pause (Task 4) and the room's tray work per member as today.

- [ ] **Step 1: Write tests:**
  - creating a room with a Codex member works and the member's turn runs over the fake;
  - **a member's engine switch reseeds only that member;**
  - a room rewind forks the Codex member at its stamp and cuts the Claude member;
  - Clone room copies no sessions, as today;
  - sync's room copy keeps each member's engine with its session;
  - the moderator's call is still `claude`;
  - with `rooms` forced false, every Phase 2 room refusal returns.
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS apart from the known load flakes.
- [ ] **Step 5: Checkpoint.**

### Task 9: e2e, smoke and docs

**Files:**
- Modify: `zumi-bot-server/e2e/codex.e2e.mjs`, for each GO feature:
  - a granted key in the Codex env and the hook blocking a read of the key file;
  - Pause, then the `userPaused` notice, then Resume;
  - the Dispatched agents panel with a fake child;
  - a desktop card in auto mode (fake desktop programs as `e2e:computer` uses);
  - a room with a Claude and a Codex member;
  - a side answer whose hook blocked a read.

  The case that asserted Pause, Desktop and Dispatched hidden flips per GO.
- Modify: `zumi-bot-server/e2e/codexSmoke.mjs` and `smokeGate.mjs` (real CLI):
  - a vault step: a dummy key file in a temp vault-key folder; the agent is asked to `cat` it in auto mode, and the hook must block it;
  - a Pause step: pause during an approved `sleep 30`, then Resume;
  - a room step: one Codex member answers.

  The gate stays strict and anchored.
- Modify: `CLAUDE.md`:
  - the "Codex agents" paragraph: hooks, what each one does, the vault guard's honest limits for Codex, Pause and subagents, computer use, rooms;
  - the "Vault" honest limits (Codex no longer unguarded);
  - "Pause and Resume", "Computer use", "Dispatched agents" and "Single chats vs. groups", each one line on Codex.
- Modify: the spec's "Features by phase" table, marking what shipped.

- [ ] **Step 1: Write the e2e cases.**
- [ ] **Step 2: Run** `npm run e2e:codex`. Expected: FAIL on the first missing piece, then fix forward.
- [ ] **Step 3: Run the regressions:** `npm test && npm run typecheck && npm run e2e:pause && npm run e2e:vault && npm run e2e:computer && npm run e2e:dispatch && npm run e2e:group && npm run e2e:btw && npm run e2e:versions`. Expected: all PASS, with Claude behaviour unchanged. (`e2e:group` drives the real `claude`; run it last and note its cost.)
- [ ] **Step 4: Run** `npm run smoke:codex` on the real CLI once (a few cents of quota, authorised), and record the results under "Phase 3 probe results" as "Phase 3 smoke".
- [ ] **Step 5: Checkpoint.** Tell the user Phase 3 is ready to review. They decide on commits, the PR, the version bump and the deploy.

## Phase 3 probe results

Probe run on `codex-cli 0.164.0` on 2026-11-10: `node zumi-bot-server/e2e/codexProbe.mjs --only 11,12,13,16,17,18 --record zumi-bot-server/backend/tests/fixtures/codex`, one run (exit 2, because check 12 was INCONCLUSIVE). Checks 11, 13, 16, 17 and 18 passed on the first try. Check 12 was INCONCLUSIVE twice: the probe's own retry, with no manual rerun.

**Fixtures:**
- `codex-check{11,12,13,16,17,18}.jsonl`;
- `codex-check11-config.jsonl` and `codex-check11-cli.jsonl` (the two hook sources that did not fire);
- `codex-check11-subagent.jsonl` (the subagent identity run);
- `codex-check12-approval_mode-prompt.jsonl` and `codex-check12-approval_mode-approve.jsonl` (`codex-check12.jsonl` is the last variant tried, `default_tools_approval_mode = "prompt"`).

The home path, host name and install id are scrubbed, and the fixtures hold no token. Check 11's `meta.files['hook-log']` holds every hook stdin verbatim.

**Probe setup.** The probe keeps the real `CODEX_HOME` (a temp home has no login). Instead, check 11 calls `hooks/list` and keeps only names and sources.
- **No user or project hooks found.** `hooks/list {cwds: [<probe workspace>]}` listed no hook at all without the probe's flags. With them, it listed only the probe's own `sessionFlags` hook. `facts.otherHooks` was `[]`.
- The probe never used `--dangerously-bypass-hook-trust` or `bypass_hook_trust`.

| Check | Verdict | Facts |
|---|---|---|
| 11 PreToolUse hook | PASS | **Source:** `-c` on the app-server command line, trusted by its own hash through a second `-c hooks.state=…` (details below). **Hook runs for:** shell, MCP, patch, the auto-run read and the collab tools. **Blocks:** exit 2 only. **A blocked call has no item;** its text reaches the client only in `hook/completed`. **Timeout and exit 1 fail open.** **Subagent field:** `agent_id`. |
| 12 Forced MCP approval | INCONCLUSIVE | No per-tool setting made a request reach the client in auto mode. `approval_mode = "prompt"` is honoured, but the approval goes to the thread's reviewer. In auto mode that is Codex's `auto_review`, which approved the call itself. |
| 13 Subagents | PASS | Child threads stream on the same connection under their own `threadId`, and their approvals reach the client. The spawn shows as `subAgentActivity`; the only `collabAgentToolCall` is `wait`. **Stop:** `turn/interrupt` of the main turn does **not** stop a child; the child ends when the app-server process exits. |
| 16 `excludeTurns` | PASS | `thread/resume {excludeTurns: true}` and a non-ephemeral `thread/fork {lastTurnId, excludeTurns: true}` both answer with `thread.turns: []`. The resume sent no `deprecationNotice`. The model still remembers: the resume replied "ALPHA BETA"; the fork at turn 1 replied "ALPHA" and has a new id. |
| 17 Compact limit above the window | PASS | Window 258 400 (`tokenUsage.modelContextWindow`). `thread/start` with `config.model_auto_compact_token_limit: 358400` was accepted, with no notification, warning or stderr line. Codex does not clamp it visibly. |
| 18 Fork at an interrupted turn | PASS (accepted) | `thread/fork {lastTurnId: <interrupted turn id>}` answered in 62 ms with a new thread. The fork's `turns` hold the completed turn and the interrupted one (`status: "interrupted"`). The fork remembers what the interrupted turn's user message said ("ALPHA BETA"). |

### Check 11: hooks

**Source and exact shape that worked.** Each source was tried in a fresh process, with one `echo ok` turn to see whether the hook fires.

1. **`thread/start` `config: {hooks: {PreToolUse: [...]}}`.**
   - Silently ignored: `hooks/list` does not show it (before or after `thread/start`), and the hook never fired.
2. **`-c 'hooks.PreToolUse=[{hooks=[{type="command",command="<cmd>",timeout=5}]}]'`.**
   - `hooks/list` shows it with:
     - `key: "/<session-flags>/config.toml:pre_tool_use:0:0"`;
     - `source: "sessionFlags"`, `trustStatus: "untrusted"`;
     - `timeoutSec: 5`, `matcher: null`;
     - `currentHash: "sha256:…"`.
   - **It never runs.** No `hook/*` notification, no warning, no stderr line: it is skipped silently.
3. **The same `-c` plus `-c 'hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:<currentHash>"}}'`.**
   - `trustStatus: "trusted"`, and it runs. This is the source used for every step below.
   - The hash came from a `hooks/list` in a first app-server process started with the same `-c hooks.PreToolUse` argument. That process starts no model and costs no quota.
   - **The inline-table form is required.** The dotted form `-c 'hooks.state."<key>".trusted_hash="…"'` is ignored, and codex says so on stderr ("Codex is ignoring 1 unrecognized configuration setting … `hooks.state."<key>"` is ignored").
   - It trusts only that exact hook: the hash is per hook content, and nothing in `~/.codex` is read or written.

Shape notes:
- **The key** is `<sourcePath>:<event in snake case>:<group index>:<handler index>`.
- **The hash** changes with the command, the timeout, the matcher and the event, but not with the hook's position. It is not a plain sha256 of the command or of the obvious JSON forms. Get it from `hooks/list`, don't compute it.
- **TOML has no null:** leave `matcher` out for every tool. The handler's timeout key is `timeout` (seconds); the default is 600.
- **Consequence for Tasks 1–2:**
  - **Hash.** The runner must get the hash from a model-free `hooks/list` process run with the same `-c hooks.PreToolUse` value. Cache it per exact hook set and codex version.
  - **Trust check.** In the real process, after `initialize`, the runner must check with `hooks/list` that each of its hooks is `trusted`. An untrusted hook is skipped silently, so the run must **fail closed**: no vault keys, no Pause.
  - **Untested:** whether the `-c hooks.state` table replaces the user's own `hooks.state` for that run (there are no user hooks to see it with).

**Hook stdin, verbatim** (one JSON line per call, auto mode, from `meta.files['hook-log']`; `transcript_path` scrubbed). Every input has:
- `session_id`: the thread id;
- `turn_id`;
- `transcript_path`: the rollout under `$CODEX_HOME/sessions`;
- `cwd`;
- `hook_event_name: "PreToolUse"`;
- `model`;
- `permission_mode: "default"`, in auto **and** manual mode;
- `tool_name`, `tool_input`;
- `tool_use_id`: the same id as the item that then runs (`exec-…`, `call_…` for collab tools).

| Call | `tool_name` | `tool_input` |
|---|---|---|
| shell | `Bash` | `{"command": "echo ok"}`: the bare command, not the `/bin/bash -lc '…'` the item shows |
| MCP | `mcp__probe__probe_echo` | `{"text": "hook"}`: the call's arguments |
| patch | `apply_patch` | `{"command": "*** Begin Patch\n*** Add File: /tmp/codex-probe-…/ws/patch-marker.txt\n+x\n*** End Patch"}`: absolute paths |
| auto-run read outside the project | `Bash` | `{"command": "cat /var/tmp/codex-probe-far-…/read.txt"}` |
| subagent spawn and wait | `collaborationspawn_agent`, `collaborationwait_agent` | (the collab call's arguments) |

The full first line:

```
{"session_id": "01a1c284-c34a-…", "turn_id": "01a1c284-c527-…", "transcript_path": "/home/user/.codex/sessions/2026/11/10/rollout-…-01a1c284-c34a-….jsonl", "cwd": "/tmp/codex-probe-4EIde6/ws", "hook_event_name": "PreToolUse", "model": "gpt-6-astra", "permission_mode": "default", "tool_name": "Bash", "tool_input": {"command": "echo ok"}, "tool_use_id": "exec-643cfbf0-…"}
```

**Blocking:**
- **Exit 2 blocks.** `touch blocked-marker` never ran, and no item exists for it: no `item/started` or `item/completed` at all.
- **What the client sees.** The block's stderr appears only in `hook/completed`: `run.status: "blocked"`, `run.entries: [{kind: "feedback", text: "BLOCKED-BY-PROBE"}]`, and `run.id: "pre-tool-use:0:/<session-flags>/config.toml:<tool_use_id>"`, which is the only link to the call.
- **What the model sees.** It quoted `Script error:\nCommand blocked by PreToolUse hook: BLOCKED-BY-PROBE. Command: touch blocked-marker`. The stderr text reaches the model, so `PAUSE_BLOCK_TEXT` and `VAULT_GUARD_TEXT` will too.
- **For Task 1's mapper.** `hook/completed` is the only place the block text appears. There is no item to attach it to, so a blocked call must become its own tool row, built from `hook/completed` (`status: "blocked"`). The tool's name and command are not in it; only the `tool_use_id` inside `run.id` is.

**Exit 1 and timeouts do not block (fail open):**
- **Exit 1.** `touch exit1-marker` ran. The hook shows `status: "failed"`, `entries: [{kind: "error", text: "hook exited with code 1"}]`.
- **Timeout.** The hook slept past its 5 s timeout. Codex killed it at 5 001 ms with `status: "failed"`, `entries: [{kind: "error", text: "hook timed out after 5s"}]`, and **`touch timeout-marker` ran**.
- **So, for Task 2:**
  - every ZumiBot hook path that must block exits 2 (never 1, never a crash);
  - the hook's own input deadline (`runPauseHook`'s 10 s) must be well below the codex `timeout` given in the config, for example 30 s, so codex never times it out.

**Notifications.** `hook/started` (`status: "running"`) and `hook/completed` come for every hook run, before the call's `item/started`. Each has:
- `threadId`, and `turnId`;
- `run`: `id`, `eventName: "preToolUse"`, `handlerType: "command"`, `executionMode: "sync"`, `scope: "turn"`, `sourcePath: "/<session-flags>/config.toml"`, `source: "sessionFlags"`, `status`, `durationMs`, `entries`.

A subagent's hook notifications carry the **child's** `threadId`.

**Where it fires:**
- **Shell, MCP and patch:** yes, all three.
- **The auto-run read outside the project:** yes. It ran with no approval request; the hook saw it first and could have blocked it.
- **The collab tools** (spawn, wait): yes.
- **Manual mode:** the hook runs **before** the approval request. `touch blocked-marker-manual` with `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"` was blocked, and no `requestApproval` was ever sent. A blocked call never shows a card.

**Subagent identity: `agent_id`.** With `--enable multi_agent` the model ran `echo main` itself and spawned a subagent that ran `echo sub`.
- **Only in the subagent's input:** `agent_id` (the child thread id, equal to `subAgentActivity.agentThreadId`) and `agent_type: "default"`.
- **The same in both:** `session_id` (the parent thread id).
- **Different:** `turn_id`, `tool_use_id`, `transcript_path` (the child's own rollout).

This is the same rule as Claude: a top-level `agent_id` marks a subagent's call. The main thread's input never carried it.

### Check 12: forced MCP approval

Each variant ran in a fresh process with the probe MCP server in `thread/start` `config['mcp_servers.probe']`, in auto mode (`on-request`, `auto_review`). A decline turn came first. None of the variants sent a request to the client, so there was never an accept turn. All three keys were accepted silently: no warning, no stderr line.

| Key and value | Client request | What happened |
|---|---|---|
| `mcp_servers.probe.tools.probe_echo.approval_mode = "prompt"` | none | The call went to Codex's reviewer: `item/autoApprovalReview/started`, then `guardianWarning` "Automatic approval review approved (risk: low, …)", then `item/autoApprovalReview/completed` with `decisionSource: "agent"` and `review.status: "approved"`. The tool then ran. |
| `mcp_servers.probe.tools.probe_echo.approval_mode = "approve"` | none | The tool ran at once, with no review. |
| `mcp_servers.probe.default_tools_approval_mode = "prompt"` | none | The same as `prompt` above: auto-reviewed, approved, ran. |

**Request shape:** no client request came. The reviewer's notification is:

```
item/autoApprovalReview/started {threadId, turnId, startedAtMs, reviewId, targetItemId: <mcpToolCall item id>, review: {status: "inProgress", riskLevel: null, userAuthorization: null, rationale: null}, action: {type: "mcpToolCall", server: "probe", toolName: "probe_echo", connectorId: null, connectorName: null, toolTitle: null}}
```

`item/autoApprovalReview/completed` adds `completedAtMs`, `decisionSource` and the final `review`.

**Not probed:**
- An MCP-server-level `approvals_reviewer`. The binary's MCP server config names none; app configs have one.
- A `preToolUse` hook answering `hookSpecificOutput.permissionDecision: "ask"`. It is in the hook output schema, but it may also be routed to the auto reviewer.

Manual mode (`approvalsReviewer: "user"`) already sends the `mcpServer/elicitation/request` (check 5), but for every tool.

### Check 13: subagents

The run used `--enable multi_agent`, manual mode, and every request accepted.

**The spawn:**
- **On the main thread:** `item/started` and `item/completed` `subAgentActivity` with:
  - `kind: "started"`;
  - `agentThreadId`: the child thread id;
  - `agentPath: "/root/<name the model chose>"` (`/root/echo_child`);
  - `model`.
- **No `spawnAgent` item.** No `collabAgentToolCall` with `tool: "spawnAgent"` came.
- **The model's wait** is `collabAgentToolCall {tool: "wait", status: "inProgress" → "completed", senderThreadId: <main>, receiverThreadIds: [], agentsStates: {}, prompt: null}`.
- **When the child ends:** `subAgentActivity` `kind: "completed"` (`model: null`).

**The child's own notifications** arrive on the same connection with the child's `threadId`:
- `thread/status/changed`, `mcpServer/startupStatus/updated`;
- `turn/started` and `turn/completed`;
- `item/started` and `item/completed` (`reasoning`, `agentMessage`, `commandExecution`);
- `item/agentMessage/delta`.

**The child's command approval reaches the client** in manual mode: `item/commandExecution/requestApproval` with the **child's** `threadId` (`/bin/bash -lc 'echo child'`), then `serverRequest/resolved`.

**`turn/completed` timing.** The main `turn/completed` came 3 240 ms after the child's `turn/completed`, because the model waited (`wait`). Whether the main turn ends before a child it did not wait for was not probed.

**Stop:**
- **The setup.** The child ran an approved `sleep 60`; 4 processes in the workspace matched it.
- **The interrupt.** `turn/interrupt` of the main turn answered at once, and the main `turn/completed` (`interrupted`) came 4 ms later. **Nothing came for the child:** no `turn/completed`, no `subAgentActivity` `interrupted`, no item.
- **After 3 s** the child's `sleep 60` was **still running**.
- **After closing stdin,** the app-server exited (code 0) within 5 s, and **no `sleep` was left**. This is the PASS condition.
- **For Task 6:**
  - Stop works only because the runner ends the process at turn end, as it already does.
  - The dispatch entries must be ended `stopped` by the runner. Codex sends no end for them.
  - **Untested:** a direct `turn/interrupt` of each child thread, with the child's turn id from its `turn/started`.

### Check 16: `excludeTurns`

- **Resume.** `thread/resume {…threadParams, threadId, excludeTurns: true}` answered `thread.turns: []` and sent no `deprecationNotice`; the next turn knew "ALPHA BETA".
- **Fork.** `thread/fork {…threadParams, threadId, lastTurnId: <turn 1>, excludeTurns: true}` (not ephemeral) answered `thread.turns: []` with a new id; the next turn knew "ALPHA" only, so `lastTurnId` is still inclusive.

### Check 17: compact limit above the window

- **The value.** `model_auto_compact_token_limit: 358400` (window 258 400 + 100 000) was accepted at `thread/start`.
- **No notice.** No `configWarning`, `warning`, `deprecationNotice` or `error` came within 2 s, and stderr said nothing about it.
- **Not run near the window.** Nothing ran close to the window, so a silent clamp at compaction time cannot be ruled out.
- **The F2 guard stays.** Codex does not clamp visibly.

### Check 18: fork at an interrupted turn

- **The setup.** Turn 1 remembered ALPHA. Turn 2 ("remember BETA, then `sleep 30`") was interrupted during the sleep (`status: "interrupted"`).
- **The fork.** `thread/fork {threadId, lastTurnId: <turn 2 id>}` in a new process was **accepted** (62 ms). The answer's `turns` were the completed turn and the interrupted one (`status: "interrupted"`). The fork's next turn knew "ALPHA BETA".
- **For the app.** A fork at an interrupted turn keeps that turn's user message. Phase 2's F4 reseed is therefore not needed for this case, but stays harmless.

### Gate

| Task | Check | Verdict |
|---|---|---|
| 1 `excludeTurns` step | 16 | GO |
| 2 Hook builders | 11 | GO: `-c` hook plus `-c hooks.state` trust by hash (pre-flight `hooks/list`), `trusted` checked before use, exit 2 on every block path, codex `timeout` above the hook's own deadline |
| 3 Vault guard and keys | 11 | GO: the hook sees the auto-run outside read before it runs; keys only when `hooks/list` shows the guard `trusted` |
| 4 Pause | 11 (subagent half: 11 + 13) | GO, subagent half included: `agent_id` marks a subagent's call; spawn and wait are hooked too, so a pause blocks new spawns |
| 5 Side deny hook | 11 | GO |
| 6 Dispatched agents | 13 | GO: map `subAgentActivity` started/completed and the child's own thread notifications; Stop relies on ending the process, and the runner ends open entries `stopped` |
| 7 Computer use | 12 | SKIP: no setting forces a client approval in auto mode; `prompt` goes to Codex's auto reviewer |
| 8 Rooms | — | always |
| 9 e2e, smoke, docs | — | always |

### Phase 3 smoke

`npm run smoke:codex` on `codex-cli 0.164.0` on 2026-11-10 (Task 9): the built server and web UI with the real `codex` and its existing login, one run, no retry, all nine steps PASS (exit 0, about 142 s). Steps 1-8 ran in manual permission mode; step 9 ran on a second server in auto mode. Every card went through `smokeGate.mjs`, and none was denied. The vault key was the harness's own temp one, made by saving a dummy API key; nothing under `~/.config/zumibot-vault` or `~/.codex` was read. Room step 8 also made the real `claude` moderator call that every room makes. Afterwards no `codex app-server`, `sleep`, server or Chrome of the run was left, and its temp folders were gone.

| Step | Verdict | Facts |
|---|---|---|
| 1 `ls` behind a card | PASS | One Bash card, `/bin/bash -lc ls`, allowed once. The reply streamed and said 3 files, and the chat kept a `codex` session. |
| 2 To-do bridge | PASS | "smoke test" was added through `zumibot_todos` with no card and no tool row. |
| 3 Stop during `sleep 60` | PASS | The card was allowed, and Stop was pressed while 4 `sleep` processes ran in the folder. The stopped notice came 4.4 s after the approval; no app-server or `sleep` was left. |
| 4 Edit behind a gated patch card | PASS | One `ApplyPatch` card for `notes.txt` inside the temp folder, allowed. The file changed as asked, and the Files panel showed the diff. |
| 5 `/btw` side answer | PASS | Answered from the ephemeral fork, which named the edited line. No card, no chat item, no process left. |
| 6 Compact | PASS | No note field, "Compacting…" seen, then the ring read compacted (`used: null`, window 258 400). No item was added. The follow-up answered "notes.txt" with no card. |
| 7 Pause and Resume | PASS | `/bin/bash -lc 'sleep 30'` was allowed, and Pause was pressed 4 s into it. The sleep finished, and the model made no further call (0 `Blocked` rows), so the hook had nothing to block. The turn landed `paused` with the Paused notice and Resume. Resume sent Continue on the same thread, and the agent replied that the sleep had finished. The pause then cleared; no errors and no process left. |
| 8 Room with a Codex member | PASS | A room of two Codex agents; the mentioned one replied "Hello!" and the other wrote nothing. `GroupInfo.sessionEngines` = `{smoke-codex: 'codex'}` with a session stored; no card, no error, no process left. |
| 9 Vault hook in auto mode | PASS | Asked to `cat` the temp vault key, the call was blocked by the vault hook: one `Blocked` row with `VAULT_GUARD_TEXT`, and no call naming the key folder ran. The key's text was nowhere in the chat or on the page, and no card showed. The server never logged the unguarded fallback, so the run went with its hooks trusted. The agent said the command was blocked and nothing was read. |
