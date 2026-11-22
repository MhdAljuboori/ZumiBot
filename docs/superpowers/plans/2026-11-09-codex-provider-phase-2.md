# Codex Provider (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex agents get real rewinds (Edit, Resend, version switch, Fork through `thread/fork`), Compact, `/btw` side questions, question cards, the Files panel and their plan limits in the Usage popover, and Zumi Bot can write Codex agents.

**Architecture:** Phase 1's seam stays. `runCodex` learns three new ways to start (fork at a turn, ephemeral fork) and one new action (compact), and it owns the per-attempt request-id tagging. The mapper emits an `entry` per completed turn, so the existing `end` stamps and `sessionPoints` drive Codex rewinds unchanged. Side runs get a Codex branch that forks ephemerally and declines every tool call. Each feature is switched on by flipping its `engineCaps('codex')` flag once its probe check passes.

**Tech Stack:** TypeScript, Node 22, vitest, React 19, `codex-cli 0.164.0` app-server protocol (no new npm dependency).

**Spec:** `docs/superpowers/specs/2026-11-09-codex-provider-design.md` (Phase 2 rows of "Features by phase", "Sessions, stamps and rewinds", "Usage and limits"). Phase 1 plan with the real-CLI findings: `docs/superpowers/plans/2026-11-09-codex-provider-phase-1.md` ("Phase 0 results"). This plan adds two probe checks the spec does not list (14 and 15, below); checks 11–13 stay with Phase 3.

## Global Constraints

- **Byte-identical Claude runs.** `backend/tests/core/claudeArgsPinned.test.ts` must pass after every task. No change to what a Claude run receives or how its events are handled.
- **No bypass values.** Never `--dangerously-bypass-approvals-and-sandbox`, sandbox `danger-full-access` or `approvalPolicy: "never"`, side runs included.
- **Probe-gated features.** A feature whose probe check is FAILED or INCONCLUSIVE stays off: its `engineCaps('codex')` flag stays `false`, its task is skipped and the ledger says why. Never switch a flag on against a failed check.
- **Fixed sentences.** Errors shown to the user come from `CODEX_REFUSALS` or the existing fixed sentences (`FORK_IGNORED`, `NOTHING_TO_COMPACT`, ...). Never CLI text, except through the existing redacted error path.
- **Side runs never act.** A Codex side run answers every approval request with a decline and shows no card; it never runs a command, a patch or an MCP call.
- **Stamps carry their engine.** A stamp made by a Codex turn carries `engine: 'codex'`, and every start point built from a stamp sets `ChatMeta.sessionEngine` from it.
- **Existing conventions.** Comments short and say why; dependencies pinned; no new dependency; secrets never in logs or errors.
- **No commits.** The user's rule: never commit unless asked. Each task ends at a **checkpoint**, not a commit.

## Review Focus

1. **Rewind on the other machine.** A Codex chat synced from the VPS has stamps whose thread is not on this PC. Expected: the `thread/fork` fails as missing, the turn reseeds with the `expired` notice, never an endless error. Tested in Task 4 (`fork of a missing thread reseeds`).
2. **Side question during a running Codex turn.** Expected: the answer forks ephemerally from the last completed turn, never from the running one, and the main run is untouched. Tested in Task 6 (`side question while running forks the last completed turn`).
3. **Compact that never finishes.** Codex sends no `thread/compacted`. Expected: there is no timeout: a compaction with no `turn/completed` runs until Stop, as Claude's does, and then `compacting` is cleared and the chat is not stuck in "Compacting…". Tested in Task 5 (`compact with no compacted event clears compacting`).
4. **Patch on a huge or binary file.** Expected: the Files panel records the change as `null` with a `why`, never a guessed old file. Tested in Task 8 (`binary or oversized file gives a null change`).
5. **Question card the user skips.** Expected: Codex gets an empty answer set and the turn goes on; nothing hangs. Tested in Task 7 (`skip answers with no answers`).

---

### Task 0: Probe checks 7–10, 14 and 15

**Files:**
- Modify: `zumi-bot-server/e2e/codexProbe.mjs`, `zumi-bot-server/backend/tests/codexProbe.test.ts`
- Record: `zumi-bot-server/backend/tests/fixtures/codex/codex-check{7,8,9,10,14,15}.jsonl`

**Interfaces:**
- Produces: `judge(check, t)` gains cases 7, 8, 9, 10, 14, 15. A new `--only <list>` flag runs only the named checks (for example `--only 7,8,9,10,14,15`), so the Phase 1 checks are not re-run for nothing.
- Produces: the "Phase 2 probe results" section at the end of this plan.

Checks (the spec's text for 7–10, plus two new ones):
- **7. Fork at a turn.**
  - Steps: a three-turn thread (say ALPHA, then BETA, then GAMMA), then `thread/fork {threadId, lastTurnId: <turn 1 id>}` in a new process, then ask "which words did I say?".
  - PASS when the reply has ALPHA and not BETA or GAMMA, the fork's thread id differs from the source's, and a resume of the source still knows GAMMA.
  - FAIL when the fork id equals the source's or the source lost GAMMA.
  - Also record whether `lastTurnId` means "up to and including that turn". The check above assumes it does; if the reply has nothing, try the next turn's id and record which semantics hold.
- **8. Ephemeral fork.** The same fork with `ephemeral: true`. PASS when no rollout file under `$CODEX_HOME/sessions` names the new thread id.
- **9. Compact.**
  - Steps: `thread/compact/start {threadId}` on a resumed thread.
  - Record: the notifications that follow (`thread/compacted`, a `contextCompaction` item, `turn/started` and `turn/completed` or none), whether `thread/compact/start` answers before or after they come, and how long it takes.
  - Also start a thread with `config: {model_auto_compact_token_limit: 100000}` and record whether it is accepted.
  - PASS when a compaction notice arrives within 120 s.
- **10. File changes.**
  - Steps: in auto mode, ask the model to change one line of `a.txt` (three lines), create `b.txt`, and delete `c.txt`.
  - Record each `fileChange` item's `changes[].diff` verbatim.
  - PASS when, for `a.txt`, reversing the diff onto the file now on disk gives back the original three lines exactly.
- **14. Side guard without hooks.**
  - Steps: an ephemeral fork with `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"`, sandbox `read-only` and the probe MCP server configured. Ask the model to run `touch side-marker`, to call `probe_echo`, and to create a file `side-file.txt`.
  - The probe declines every request.
  - PASS when a request arrived for each attempt and none of `side-marker`, `side-file.txt` or `marker-mcp.txt` exists.
  - FAIL when any of them exists.
  - INCONCLUSIVE when the model tried fewer than two of the three.
- **15. Question input.**
  - Steps: run with `--enable default_mode_request_user_input`. Ask the model to use its question tool to ask the user to pick `red` or `blue`.
  - On `item/tool/requestUserInput`, answer `{answers: {<question id>: {answers: ['blue']}}}`.
  - PASS when the request carries `questions[].id/question/options` and the reply says blue.
  - INCONCLUSIVE when no request came.
  - Also record whether the request comes without the `--enable` flag.

- [ ] **Step 1: Write `judge` tests for the six checks** with hand-written transcripts: each check's PASS case and its FAIL or INCONCLUSIVE case, as listed above.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/codexProbe.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the six checks and `--only`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Run the real probe:** `node zumi-bot-server/e2e/codexProbe.mjs --only 7,8,9,10,14,15 --record zumi-bot-server/backend/tests/fixtures/codex`. This uses a few cents of the user's Codex quota (authorised when the user said "Start the next phase"). Write the summary into "Phase 2 probe results" below, with the facts each later task needs:
  - `lastTurnId` semantics;
  - the compaction notification sequence and the auto-compact config key;
  - the `diff` format;
  - the `requestUserInput` shape, and whether it needs the flag.
- [ ] **Step 6: Gate.** Mark each later task GO or SKIP in the results, by its check:
  - check 7 → Task 4;
  - check 8 and check 14 → Task 6;
  - check 9 → Task 5;
  - check 10 → Task 8;
  - check 15 → Task 7.

  Tasks 1–3 and 9–11 always run. Task 12 tests only the features that are GO.
- [ ] **Step 7: Checkpoint.**

### Task 1: Runner modes, request-id tagging and the fake

**Files:**
- Modify: `zumi-bot-server/backend/src/core/codex/codexRunner.ts`, `codexParams.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`. Remove `attemptRequests` and call the runner's new options instead; behaviour must be unchanged.
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-codex.mjs`
- Test: `zumi-bot-server/backend/tests/core/codexRunner.test.ts`, `codexParams.test.ts`, `fakeCodex.test.ts`, `chatService.test.ts` (the existing `codex engine` block must stay green)

**Interfaces:**
- Produces: `export type CodexStart = { kind: 'new' } | { kind: 'resume'; threadId: string } | { kind: 'fork'; threadId: string; lastTurnId: string; ephemeral?: true }`.
- Produces: `export type CodexAction = { kind: 'turn'; prompt: UserContent } | { kind: 'compact' }`.
- Produces: `CodexRunOptions` replaces `threadId` and `prompt` with `start: CodexStart` and `action: CodexAction`, and adds `enable?: string[]` (features passed as `--enable <name>`) and `requestTag?: string`.
  - With `requestTag`, every request id the runner emits (`permissionRequest`, `permissionCancel`, `controlUnknown`) is `${requestTag}:${id}`.
  - `send` accepts only ids carrying that tag and strips it.
  - `ChatService` passes a fresh `randomUUID()` per attempt.
- Produces: `CodexThreadInput` gains `sandbox?: 'read-only' | 'workspace-write'` (default `'workspace-write'`). Side runs pass `permissionMode: 'manual'` and `sandbox: 'read-only'` themselves; no other override is added.
- **Fork.** `thread/fork` is called with `{threadId, lastTurnId, ...threadParams(thread), ...(ephemeral ? {ephemeral: true} : {})}`. Use the `lastTurnId` semantics the Phase 2 probe results recorded; if a turn id must be shifted, do it here and name the reason in a comment.
- **Missing thread.** A missing thread on fork sets `missingSession` (the same `isMissingThread` rule as resume).
- **Compact.** The `compact` action calls `thread/compact/start {threadId}` after resume, then waits for the end the probe recorded, emitting `compacting {on: true}` first and `compacting {on: false}` plus `compacted` at the end. It ends with a synthetic `result {subtype: 'success', isError: false, numTurns: 0, sessionId: threadId, denials: [], windows: {}, uuid: null, cost: null}` so the run finishes like a turn.
- **Fake.** `fake-codex.mjs` handles:
  - `thread/fork`: log `lastTurnId` and `ephemeral`; give a new thread id; with `ephemeral`, write no marker, so a later resume fails;
  - `thread/compact/start`: emit the sequence recorded by probe check 9, or `thread/compacted` when no recording exists;
  - `FAKE_CODEX_FORK_SAME=1`: return the source id from `thread/fork`.

- [ ] **Step 1: Write tests:**
  - `fork` sends `thread/fork` with `lastTurnId` and the thread params;
  - an ephemeral fork sends `ephemeral: true`;
  - a fork of a missing thread gives `missingSession`;
  - `FAKE_CODEX_FORK_SAME=1` gives an `init` whose `sessionId` equals the source;
  - a compact run emits `compacting` on and off, then `compacted`, then `result`, with no `turn/start` in the log;
  - `requestTag` prefixes ids, and `send` with an untagged id returns false;
  - `enable: ['x']` puts `--enable x` in argv;
  - `sandbox: 'read-only'` reaches `thread/start`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexRunner.test.ts zumi-bot-server/backend/tests/core/codexParams.test.ts zumi-bot-server/backend/tests/core/fakeCodex.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then move ChatService onto `start`, `action` and `requestTag`, deleting `attemptRequests`.
- [ ] **Step 4: Run** the three files, `chatService.test.ts` and `claudeArgsPinned.test.ts`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 2: Mapper — turn entries, compaction, questions and file detail

**Files:**
- Modify: `zumi-bot-server/backend/src/core/codex/codexEvents.ts`, `codexAnswers.ts`
- Test: `zumi-bot-server/backend/tests/core/codexEvents.test.ts`, `codexParams.test.ts` (answers)

**Interfaces:**
- **Turn entries.** On `turn/completed` with any status, emit `entry {uuid: turn.id}` before `result`, so ChatService's `tip` is the turn id at the end stamp. Never emit an `entry` before an `assistantText` of the same turn: Codex has no point inside a turn to cut at.
- **File detail.** A completed `fileChange` item's `toolResult` carries `detail: {codexChanges: [{path, kind, movePath, diff}]}` with each `diff` uncapped up to `PATCH_MAX_BYTES` (from `core/files/fileChanges.ts`). The card's capped diff from Phase 1 is unchanged.
- **Questions.** Server request `item/tool/requestUserInput` becomes `permissionRequest {toolName: QUESTION_TOOL, input: {questions: [...]}, requestId, toolUseId: itemId}`, with kind `'userInput'`. The input is in the shape `parseQuestions` (`shared/src/questions.ts`) accepts:
  - each question gets `question`, `header` and `options: [{label, description}]`;
  - `multiSelect` is false;
  - the Codex `id` is kept on each question as `codexId`.
  - A question with `isSecret: true` or no options is still shown; `isOther` maps to the card's own Other field, if `parseQuestions` has one.
  - Questions are mapped only when the feature is GO. Otherwise the Phase 1 behaviour (an error answer) stays.
- **Answering questions.** `codexAnswer('userInput', response, request)`:
  - an allow whose `updatedInput.answers` holds the card's answers maps to `{answers: {[codexId]: {answers: string[]}}}`, using the `QuestionAnswers` shape from `shared/src/questions.ts`;
  - a deny (Skip) maps to `{answers: {}}`;
  - an error response stays a JSON-RPC error.
- **Compaction notices** are mapped as the probe recorded, with no double report (the existing de-dup flags are reset at each turn boundary, fixing the Phase 1 minor).

- [ ] **Step 1: Write tests:**
  - replaying `codex-check7.jsonl` gives one `entry` per turn, each before its `result`;
  - `codex-check10.jsonl`'s `fileChange` result carries `codexChanges` with the full diff;
  - `codex-check15.jsonl`'s request maps to a `QUESTION_TOOL` card whose input `parseQuestions` accepts;
  - `codexAnswer('userInput', allowResponse(id, {...input, answers}), request)` gives `{answers: {<id>: {answers: ['blue']}}}`;
  - **skip answers with no answers:** a deny gives `{answers: {}}`;
  - compaction from `codex-check9.jsonl` gives `compacted` exactly once.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexEvents.test.ts zumi-bot-server/backend/tests/core/codexParams.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 3: Stamps carry their engine

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`SessionCut.engine?: 'codex'`, inherited by `TurnEnd`)
- Modify: `zumi-bot-server/backend/src/core/chat/sessionPoints.ts` (`StartPoint` and `MemberPoint` gain `engine?: 'codex'`, copied from the stamp)
- Modify: `zumi-bot-server/backend/src/core/chat/fork.ts` (the new chat's `sessionEngine` comes from the start point)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`:
  - a Codex turn's `end` stamp carries `engine: 'codex'`;
  - `rerunTurn` and `switchTurn` set `sessionEngine` from the start point they compute, instead of keeping the chat's (fixing the Phase 1 minor);
  - Claude stamps are unchanged, with no `engine` key.
- Modify: `zumi-bot-server/deploy/sync.mjs` only if its chat join drops unknown stamp keys. Check first; change nothing if it keeps them.
- Test: `zumi-bot-server/backend/tests/core/sessionPoints.test.ts`, `fork.test.ts`, `chatService.test.ts`

**Interfaces:**
- Produces: `startBefore` and `startAfterMessage` return `engine` when the stamp has it.

- [ ] **Step 1: Write tests:**
  - `startBefore` over items whose last end stamp has `engine: 'codex'` returns `{sessionId, next: {at}, engine: 'codex'}`;
  - a Claude stamp returns no `engine`;
  - `forkChat` of a Codex chat sets the fork's `sessionEngine: 'codex'`, and a Claude chat's fork has none;
  - a Codex turn's last item gets `end {session, at: <turn id>, engine: 'codex'}`;
  - a Claude turn's end stamp has no `engine` key (deep equal to the old shape);
  - an Edit in a chat whose `sessionEngine` is `'codex'` but whose cut stamp is a Claude one sets `sessionEngine` to undefined.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/sessionPoints.test.ts zumi-bot-server/backend/tests/core/fork.test.ts zumi-bot-server/backend/tests/core/chatService.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, plus `claudeArgsPinned.test.ts`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 4: Codex rewinds through `thread/fork` (GO only if check 7 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (the Codex branch of `agentTurn`)
- Modify: `zumi-bot-server/shared/src/engine.ts` (`engineCaps('codex').rewind = true`)
- Test: `chatService.test.ts`, `shared/tests/engine.test.ts`

**Interfaces:**
- **Cut runs.** A Codex turn with `spec.resumeAt` no longer reseeds. It runs `start: {kind: 'fork', threadId: spec.sessionId, lastTurnId: spec.resumeAt}`. `cutFrom` is set as for Claude, so `FORK_IGNORED` (an `init` whose id equals the source) stops the run with the existing error.
- **Missing thread.** A missing thread on a fork reseeds once, as the Claude cut path does on a missing session.

- [ ] **Step 1: Write tests:**
  - an Edit of the second user message in a Codex chat runs `codex.run` with `start.kind === 'fork'` and `lastTurnId` = turn 1's id;
  - a fork answer with the same id ends with the `FORK_IGNORED` error and no reseed;
  - **fork of a missing thread reseeds:** `missingSession` on a fork leads to one reseed with the `expired` notice;
  - a version switch and a Fork (fork.ts plus the first turn) both fork at the right turn;
  - `engineCaps('codex').rewind === true`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/shared/tests/engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, plus `claudeArgsPinned.test.ts`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 5: Compact (GO only if check 9 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`:
  - `compactTurn` runs the Codex compact action instead of throwing `COMPACT_UNAVAILABLE`;
  - each attempt passes the agent's `autoCompactWindow` as the config key the probe recorded, unless that key was not accepted, in which case `autoCompactWindow` stays unused for Codex and the Agent Studio row stays hidden.
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts`: `chats:compact` no longer refuses a Codex chat.
- Modify: `zumi-bot-server/shared/src/engine.ts`: `compact: true`.
- Modify: `zumi-bot-server/frontend/src/state/agentEngine.ts` and `components/AgentForm.tsx`. Compact at is shown for Codex when the key is supported, and `CODEX_UNUSED_NOTE` becomes `'Tools, memory, computer use and command models are not used by Codex agents.'`. Otherwise both stay as they are.
- Test: `chatService.test.ts`, `rpc/handlers.test.ts`, `frontend/tests/agentEngine.test.ts`

- [ ] **Step 1: Write tests:**
  - Compact on a Codex chat calls `codex.run` with `action.kind === 'compact'` and the chat's thread, and the meter gets `compacted`;
  - **compact with no compacted event clears compacting:** a run that ends without `compacted` clears `ChatMeta.compacting`;
  - `chats:compact` on a Codex chat no longer refuses;
  - the config key appears in the thread params when `autoCompactWindow` is set;
  - the note text is updated.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/backend/tests/rpc/handlers.test.ts zumi-bot-server/frontend/tests/agentEngine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 6: `/btw` side questions (GO only if checks 8 and 14 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`:
  - `SideBase` gains `codex?: {threadId: string; at: string | null; baseInstructions: string; model?: string; mcpServers: McpServerSpec[]}`;
  - a Codex turn publishes its side base, with `at` = the last completed turn id.
- Modify: `zumi-bot-server/backend/src/core/btw/sideRun.ts`. A Codex branch:
  - `runCodex` with `start: {kind: 'fork', threadId, lastTurnId: at, ephemeral: true}`, or `{kind: 'new'}` with the seed prompt when there is no session;
  - `thread: {permissionMode: 'manual', sandbox: 'read-only', ...}`;
  - every `permissionRequest` answered with `denyResponse` at once, and no card;
  - the answer is the turn's text.
- Modify: `zumi-bot-server/backend/src/app.ts`: `baseFor` builds a Codex base for a Codex chat instead of throwing. Keep warm stays off for Codex.
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`btw:ask` and `btw:follow` no longer refuse a Codex chat) and `core/asks/askService.ts` (a `side_question` to a Codex B is allowed).
- Modify: `zumi-bot-server/shared/src/engine.ts` (`btw: true`).
- Test: `sideRun.test.ts`, `sideQuestions.test.ts`, `chatService.test.ts`, `rpc/handlers.test.ts`, `askService.test.ts`

**Interfaces:**
- A Codex A's own side run gets no asking exception: it cannot call `side_question` (no hook can single the tool out), and its note says it can ask nobody. This is accepted for Phase 2 and written in CLAUDE.md in Task 12.

- [ ] **Step 1: Write tests:**
  - a Codex side question runs `codex.run` with an ephemeral fork at the last completed turn, `permissionMode: 'manual'` and `sandbox: 'read-only'`;
  - a `permissionRequest` during it is answered with deny, and no card or approval item is stored;
  - the answer text lands in the entry;
  - **side question while running forks the last completed turn:** with a Codex turn running, the fork's `lastTurnId` is the previous turn's id and the main run's `codex.run` options are untouched;
  - with no session, the side run starts new with the seed prompt;
  - `btw:ask` on a Codex chat no longer refuses;
  - a Claude agent's `side_question` to a Codex B gets B's answer.
- [ ] **Step 2: Run** the five test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, plus `claudeArgsPinned.test.ts` (Claude side runs unchanged). Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 7: Question cards (GO only if check 15 passed)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/codex/codexRunner.ts`: pass `enable: ['default_mode_request_user_input']` when the probe showed the flag is needed. The constant `CODEX_QUESTION_FEATURE` lives in `codexParams.ts`.
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`, only if the question answer path needs a Codex case beyond `send`. Phase 1 already routes answers through `slot.answerQuestions` and `send`, so expect none.
- Modify: `zumi-bot-server/shared/src/engine.ts` (`questions: true`)
- Test: `codexRunner.test.ts`, `chatService.test.ts`

- [ ] **Step 1: Write tests:**
  - against the fake, a `requestUserInput` script request shows a question card;
  - `chats:answerQuestions` with one answer writes `{answers: {<id>: {answers: [...]}}}` to `FAKE_CODEX_ANSWERS`;
  - Skip writes `{answers: {}}` and the turn completes;
  - argv carries `--enable default_mode_request_user_input` when required.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexRunner.test.ts zumi-bot-server/backend/tests/core/chatService.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 8: Files panel (GO only if check 10 passed)

**Files:**
- Create: `zumi-bot-server/shared/src/unifiedDiff.ts`
- Modify: `zumi-bot-server/backend/src/core/files/fileChanges.ts`: `FileTracker` handles an `ApplyPatch` tool result carrying `detail.codexChanges`.
- Modify: `zumi-bot-server/shared/src/engine.ts` (`files: true`)
- Test: `zumi-bot-server/shared/tests/unifiedDiff.test.ts`, `zumi-bot-server/backend/tests/core/fileChanges.test.ts`

**Interfaces:**
- Produces: `export function parseUnifiedDiff(diff: string): PatchHunk[] | null`. It reads the `@@ -a,b +c,d @@` hunks in the format probe check 10 recorded, into the existing `PatchHunk` (`shared/src/files.ts`). It returns null on anything it cannot read exactly.
- Produces: `export function reversePatch(after: string, hunks: PatchHunk[]): string | null`. It rebuilds the old text from the new one, and returns null when a hunk's new lines are not where it says.
- **FileTracker rules per change:**
  - `add`: old is `''`, new is read from disk.
  - `delete`: old comes from the diff's removed lines when the diff holds the whole file, else `null` with a `why`.
  - `update`, with `movePath` honoured: new is read from disk at the (moved) path, using the existing one-file, ≤1 MiB, no-NUL rule; old is `reversePatch(new, hunks)`.
  - Any failure gives a `null` copy with a `why`. Never a guess.
  - One tool item can carry several file changes: use the existing `changes` list on the tool item.

- [ ] **Step 1: Write tests:**
  - `parseUnifiedDiff` of check 10's recorded `a.txt` diff, then `reversePatch` of the file after, gives the original;
  - a diff whose context does not match gives `null`;
  - FileTracker turns an `ApplyPatch` result with add, update and delete into three `FileChange`s whose copies equal the expected texts;
  - **binary or oversized file gives a null change:** a NUL byte or a file over 1 MiB gives `null` with a `why`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/unifiedDiff.test.ts zumi-bot-server/backend/tests/core/fileChanges.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 9: Codex plan limits in the Usage popover

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/streamParser.ts`: `RunEvent` `rateLimit` gains `provider?: 'codex'`. Claude never sets it.
- Modify: `zumi-bot-server/backend/src/core/codex/codexEvents.ts`: emit `rateLimit {provider: 'codex', session: <primary window>, weekly: <secondary window>}` from `account/rateLimits/updated`, in the `UsageWindow` shape the Claude events use (percent and reset in ms).
- Modify: `zumi-bot-server/backend/src/app.ts`, `core/claudeAccount.ts` (or a new `core/codex/codexAccount.ts` holding the latest Codex reading in memory), the account RPC payload in `shared/src/types.ts` (`codex?: UsageReading`), and `frontend/src/components/AccountMenu.tsx`, which gains a "Codex" block shown only when the payload has a Codex reading.
- Test: `codexEvents.test.ts`, `claudeAccount.test.ts` (or `codexAccount.test.ts`), a pure frontend test for the block's rows

- [ ] **Step 1: Write tests:**
  - a rate-limit snapshot maps to `rateLimit {provider: 'codex', ...}` with the right percents and resets;
  - a Codex reading never replaces the Claude one;
  - the payload carries both;
  - the pure row builder for the popover returns two rows for a Codex reading and none without one.
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 10: Zumi Bot writes Codex agents

**Files:**
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts` (prompt and `/make-friendly`)
- Test: `zumi-bot-server/backend/tests/core/zumiBot.test.ts`

- [ ] **Step 1: Write tests** that the prompt:
  - names the `provider: codex` key and says it is written only when the user asks for a Codex agent;
  - says that for a Codex agent `tools:`, `memory`, `computerUse` and command `model:` are not written, `model:` is left out unless the user names a Codex model, and `autoCompactWindow` is still set as for any agent;
  - says `/make-friendly` leaves a Codex agent's `provider` alone, and skips adding the to-do, vault and agent tools to a Codex agent's `tools:` list.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/zumiBot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 11: Phase 1 leftovers and the caps refactor

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts`. A room `/btw` and a room Compact aimed at a member whose agent is now Codex refuse with `CODEX_REFUSALS.room(name)` (rooms stay Claude-only).
- Modify: `zumi-bot-server/frontend/src/components/ChatView.tsx` and `Composer.tsx`:
  - a Codex chat's composer is blocked by a missing `codex` (`codexInfo.found === false`, with `CODEX_REFUSALS.notFound`), not by a missing `claude`;
  - a Claude chat keeps today's rule.
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`. The `onCodex` checks for the flags this phase flips (`rewind`, `compact`, `btw`, `files`, `questions`) read `engineCaps(engine)`, so a SKIPPED task leaves its flag false and the old refusal or reseed in place. Other `onCodex` checks stay.
- Test: `groupService.test.ts`, a pure frontend test for the composer block reason, `chatService.test.ts`

- [ ] **Step 1: Write tests:**
  - a room `/btw` aimed at a Codex member refuses with the room sentence, and a room Compact likewise;
  - the composer block reason is `CODEX_REFUSALS.notFound` for a Codex chat with no codex, and `null` for a Codex chat with codex but no claude;
  - with a flag forced false in a test (inject caps), ChatService keeps the Phase 1 behaviour for that feature.
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS apart from the known flakes.
- [ ] **Step 5: Checkpoint.**

### Task 12: e2e, smoke, UI gates and docs

**Files:**
- Modify: `zumi-bot-server/e2e/codex.e2e.mjs`. For each GO feature: an Edit forks (the fake's log shows `thread/fork` with `lastTurnId`); Compact shows "Compacting…" then the meter's compacted state; a `/btw` answer appears and the fake logs an ephemeral fork with no card shown; a question card answered on the page; a Files panel entry with the diff.
  - The Phase 1 case that asserted these were hidden is updated to assert they now show, and Pause, Desktop and Dispatched stay hidden.
- Modify: `zumi-bot-server/e2e/codexSmoke.mjs` and `smokeGate.mjs`. Add an **edit-heavy** step: ask the agent to change a line in `notes.txt` in the temp folder; the gate allows an `ApplyPatch` card only for paths inside the temp folder; check the file changed and the Files panel lists it. Then add `/btw` and Compact steps for the GO features.
- Modify: `CLAUDE.md` (the Codex agents paragraph: what Phase 2 turned on, the side-run guard, Codex A's side run asking nobody, the rewind semantics) and the spec's "Features by phase" table, marking what shipped.
- Modify: the `frontend` gates only if a flag flip did not already change them (they read `engineCaps`).

- [ ] **Step 1: Write the e2e cases.**
- [ ] **Step 2: Run** `npm run e2e:codex`. Expected: FAIL on the first missing piece, then fix forward.
- [ ] **Step 3: Run the regressions:** `npm test && npm run typecheck && npm run e2e:ask && npm run e2e:todos && npm run e2e:btw && npm run e2e:versions && npm run e2e:files`. Expected: all PASS, with Claude behaviour unchanged.
- [ ] **Step 4: Run** `npm run smoke:codex` on the real CLI (a few cents of quota, authorised), and record the results under "Phase 2 probe results" as "Phase 2 smoke".
- [ ] **Step 5: Checkpoint.** Tell the user Phase 2 is ready to review; they decide on commits, the PR and the version bump.

## Phase 2 probe results

Probe run on `codex-cli 0.164.0` on 2026-11-09: `node zumi-bot-server/e2e/codexProbe.mjs --only 7,8,9,10,14,15 --record zumi-bot-server/backend/tests/fixtures/codex`, all six PASS on the first try. Fixtures: `codex-check{7,8,9,10,14,15}.jsonl`, `codex-check9-auto.jsonl` (the low auto-compact limit thread) and `codex-check15-noflag.jsonl`; no auth data (home, host name and install id scrubbed). Checks 7+ gate features and cost many model turns, so a default run (`npm run probe:codex`, `npm run e2e`) runs only checks 1-6; re-verify the Phase 2 features with `npm run probe:codex -- --only 7,8,9,10,14,15`.

| Check | Verdict | Facts |
|---|---|---|
| 7 Fork at a turn | PASS | `thread/fork {threadId, lastTurnId}` in a new process answers `{thread: {id, turns, ...}}` with a new id. **`lastTurnId` is inclusive**: `lastTurnId: <turn 1 id>` on a three-turn thread (ALPHA, BETA, GAMMA) kept turn 1 (the answer's `thread.turns` held 1 turn, the fork replied "ALPHA" only); no second try with turn 2's id was needed. A `thread/resume` of the source afterwards still knew GAMMA. The fork takes the same thread params as `thread/start` (`cwd`, `sandbox`, `approvalPolicy`, `approvalsReviewer`, `config`). A non-ephemeral fork without `excludeTurns` returns the turns and a resume without it sends a `deprecationNotice` ("Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`"), which is only a notice. |
| 8 Ephemeral fork | PASS | **An ephemeral fork is refused unless `excludeTurns: true` is also sent**: the error is "ephemeral paginated thread/fork requires `excludeTurns: true`" (the first run, without it, was INCONCLUSIVE for that reason). With `{ephemeral: true, excludeTurns: true, lastTurnId}` the answer has `thread.ephemeral: true`, `thread.path: null`, and a turn on it works (reply "ALPHA"). No rollout file under `$CODEX_HOME/sessions` names the fork's id, while the source's rollout was found (so the search can see rollouts). |
| 9 Compact | PASS | `thread/compact/start {threadId}` on a resumed thread **answers at once** (`{}` within 1-10 ms), then the server sends `thread/goal/cleared`, `thread/status/changed` (active) and a real **`turn/started`** (a new turn with no items), then `item/started` `contextCompaction` (0.8-1.8 s after the request), then `item/completed` `contextCompaction` (about 5-6 s later; a tiny thread took 6.7-7.1 s in all), then `thread/tokenUsage/updated` (unchanged totals for a tiny thread), `thread/status/changed` (idle) and `turn/completed` (`completed`). **No `thread/compacted` notification came** (it is deprecated: "Use `ContextCompaction` item type instead"): the compaction notice is the `contextCompaction` item, whose `item/started` and `item/completed` both carry `threadId` and `turnId`. **Auto-compact key: `model_auto_compact_token_limit`**, in `config` of `thread/start`, is accepted and checked by type (a string gave "failed to load configuration: invalid type: string \"abc\", expected i64"; an unknown key like `no_such_key_xyz` is silently accepted, so the typed error proves this one is known). It also works: a thread started with `1000` compacted during its second turn (`item/started` and `item/completed` `contextCompaction`, no `thread/compacted`); a first turn alone did not compact (the limit is checked as a later request is made). `AutoCompactTokenLimitScope` (`total` or `body_after_prefix`) exists in the protocol's `Config`; the default was not changed or probed. |
| 10 File changes | PASS | In auto mode (`on-request` + `auto_review`) the model used its patch tool, with no approval request, and made **one `fileChange` item** (`status: "completed"`) holding all three changes, in `item/completed` (plus `turn/diff/updated` notifications, which a client may ignore). Each change is `{path, kind, diff}` with an **absolute `path`** and `kind` `{type: 'update', move_path: null}`, `{type: 'add'}` or `{type: 'delete'}`. **`diff` formats differ by kind**: an `update` is a unified diff of **hunks only, no `---`/`+++` headers**: `"@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n line three\n"`; an `add` is the **whole new file text** (`"brand new\n"`, no hunk marker) and a `delete` is the **whole old file text** (`"to be deleted\n"`). Reversing `a.txt`'s diff onto the file on disk (`reverseDiff` in the probe: hunks applied from the last up, checking each hunk's new side against the file) gave back the original three lines exactly. No shell command ran. |
| 14 Side guard without hooks | PASS | An ephemeral fork (`ephemeral: true, excludeTurns: true`, `approvalPolicy: 'untrusted'`, `approvalsReviewer: 'user'`, `sandbox: 'read-only'`, the probe MCP server in `config['mcp_servers.probe']`) asked about all three attempts and the probe declined each: `item/commandExecution/requestApproval` (`/bin/bash -lc 'touch side-marker'`), `mcpServer/elicitation/request` (`Allow the probe MCP server to run tool "probe_echo"?`) and `item/fileChange/requestApproval` (the patch for `side-file.txt`; params carry `itemId` of the `fileChange` item). Answers used: `{decision: 'decline'}` for command and file change, `{action: 'decline', content: null, _meta: null}` for the elicitation. None of `side-marker`, `side-file.txt` or `marker-mcp.txt` exists afterwards. The model started a `commandExecution`, an `mcpToolCall` and a `fileChange` item, then wrote DONE. |
| 15 Question input | PASS (needs the flag) | With `codex app-server --enable default_mode_request_user_input` (the `initialize` kept `experimentalApi: false`, so no experimental capability is needed) the server sent **`item/tool/requestUserInput`** with params `{threadId, turnId, itemId, questions: [{id: "color", header: "Color", question: "Which color do you pick?", isOther: true, isSecret: false, options: [{label: "Red", description: "Pick red."}, {label: "Blue", description: "Pick blue."}]}], isBlocking: false, autoResolutionMs: null}` (note **`isBlocking: false`**, **`isOther: true`**, option labels are capitalised). The answer `{answers: {color: {answers: ["blue"]}}}` was accepted (the server then sent `serverRequest/resolved`), and the model replied "blue" in the same turn. **Without the flag no request comes**: the model's question appears as an `agentMessage` item with `phase: "final_answer"`, `delivery: "async"`, `text: "Which color do you pick?\n- red\n- blue"` and `questions: [{title, options: ["red", "blue"]}]` (the `AsyncUserInputQuestion` type), followed by a `sleep` item (`durationMs: 60000`): the turn did not end within 60 s and the probe interrupted it (`turn/interrupted` ended it in about 20 ms). |

### Facts the later tasks need

- **Task 4 (rewinds).** `thread/fork {threadId, lastTurnId, ...threadParams}` keeps the turn named by `lastTurnId` and drops the later ones, so the stamp's last entry (the turn's own id) is the value to send, never the turn before. A fork has its own thread id and leaves the source intact. The fork's answer and a later `thread/resume` of the source need no special handling. A missing source thread was not probed in Phase 2 (Phase 1 recorded `no rollout found for thread id <id>` with code -32600 for a resume; the same wording is expected on a fork, so the missing test must accept it).
- **Task 5 (Compact).** Send `thread/compact/start {threadId}` after a resume; the answer is an empty object and comes first. Then a turn runs: `turn/started` and `turn/completed` bracket it, `contextCompaction` `item/started` and `item/completed` show the compaction, and **there is no `thread/compacted`** (the mapper must treat the `contextCompaction` item as the compaction notice, and a missing one must still end at `turn/completed`). Allow at least 7-10 s on a tiny thread, longer on a big one. A client that waits for `thread/compacted` would never finish. The key for the agent's "Compact at" is `model_auto_compact_token_limit` (an integer) in the `config` of `thread/start`, `thread/resume` and `thread/fork`; it was probed on `thread/start` only, so check it on resume before relying on it there (the instruction fields were ignored on resume in Phase 1, `config` is a different path).
- **Task 6 (`/btw`).** Fork the last completed turn with `{ephemeral: true, excludeTurns: true, lastTurnId}` (`excludeTurns` is mandatory with `ephemeral`), `approvalPolicy: 'untrusted'`, `approvalsReviewer: 'user'`, `sandbox: 'read-only'` and the run's MCP `config`, and decline every server request by method (shapes in the check 14 row; an unknown request method needs a safe generic decline). No rollout is written. A side run always asks first in this mode, so "never acts" holds without hooks; a decline cannot be undone by the model within the turn (the files stayed absent).
- **Task 7 (questions).** Needs `--enable default_mode_request_user_input` on `codex app-server`. The request is `item/tool/requestUserInput` with the shape above; answer `{answers: {<question id>: {answers: string[]}}}`. `isOther: true` means a free-text answer is allowed. The skip case (an empty `answers` object) was not probed; Task 7's own test covers it. Without the flag the question is only text (`delivery: 'async'`) and the turn then sleeps, so a Codex run must always start with the flag once questions are on, or the agent will hang waiting.
- **Task 8 (Files).** `fileChange` items arrive complete in `item/completed` (`changes[]` with absolute `path`). An `update` diff is hunks only with no headers and an `add` or `delete` carries the whole file text, so the old file for an update is rebuilt with the same reverse the probe uses (new file on disk plus hunks; null with a `why` when the file is gone, changed since, binary or too large), and for a `delete` the old file is the `diff` itself. A `kind.move_path` was not exercised.

### Gate

| Task | Check | Verdict |
|---|---|---|
| 4 Rewinds | 7 | GO |
| 5 Compact | 9 | GO |
| 6 `/btw` | 8 and 14 | GO |
| 7 Questions | 15 | GO (with the `--enable` flag) |
| 8 Files | 10 | GO |

Tasks 1-3 and 9-11 always run; Task 12 tests all the features above.

### Phase 2 smoke

`npm run smoke:codex` on `codex-cli 0.164.0` on 2026-11-09 (Task 12): the built server and web UI with the real `codex` and its existing login, manual permission mode, one run, no retry, all six steps PASS (exit 0, about 77 s). Every card went through `smokeGate.mjs`; none was denied. Afterwards no `codex app-server`, `sleep`, server or Chrome of the run was left, and its temp folders were gone.

| Step | Verdict | Facts |
|---|---|---|
| 1 `ls` behind a card | PASS | One Bash card, `/bin/bash -lc ls` (a one-word command unquoted), allowed once; the reply streamed and said 3 files; the chat kept a `codex` session. |
| 2 To-do bridge | PASS | The item "smoke test" was added through `zumibot_todos` with no card and no tool row. |
| 3 Stop during `sleep 60` | PASS | `/bin/bash -lc 'sleep 60'` allowed; Stop about 4.3 s later gave the stopped notice, and no app-server or `sleep` was left in the folder. |
| 4 Edit behind an `ApplyPatch` card | PASS | **Real codex asks before a patch in `untrusted` mode**: one `ApplyPatch` card, a single `update` of `notes.txt` by its absolute path in the temp folder, no move; the gate allowed it (every path inside the folder, links resolved). The file changed as asked, the tool row was no error, and the Files panel showed `-line two` / `+line TWO changed`, so `reversePatch` rebuilt the old file from the real hunk-only diff. |
| 5 `/btw` about the edit | PASS | The side answer, "I changed the line `line two` to `line TWO changed` in `notes.txt`.", came from the ephemeral read-only fork: state `done`, no card shown, the chat's items unchanged (14 before and after), no app-server left. |
| 6 Compact | PASS | No note field; "Compacting…" showed, then the ring read "Compacted · exact size after the next reply" (context `used: null`, window 258 400) with no item added and no error. The next turn (no tool) answered "notes.txt" on the compacted thread. |
