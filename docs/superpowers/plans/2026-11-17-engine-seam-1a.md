# Engine seam completion (Phase 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every place that decides by engine name becomes exhaustive or names Claude/Codex positively, so a third engine can never silently fall into Claude's (or Codex's) machinery — with no behaviour change.

**Architecture:** One vocabulary in `shared/src/engine.ts`: `Provider` (every engine but Claude), `parseProvider`, `sessionMark`/`markEngine`, `ENGINE_LABEL` and `ENGINES` (from a `Record<Engine, …>`), `assertNever`, and `engineCaps` as a record lookup. Binary `onCodex ? codexThing : claudeThing` sites become an exhaustive `switch`/`Record`; one-sided sites name their engine positively (`engine === 'claude'` for Claude-only machinery, `=== 'codex'` for Codex-only). The adapter registry replaces the launch ternary in `ChatService.agentTurn`.

**Tech Stack:** TypeScript 5, Node 22, vitest, React 19.

**Spec:** `docs/architecture/protocol-engines.md` ("What exists, and what a third engine still needs").

## Global Constraints

- No behaviour change: every existing test and fixture passes unchanged apart from imports.
- Claude and Codex behaviour must not change.
- No new dependency.
- Never commit (the user commits).
- Comments short and say why.

## The rule each site follows

| Site shape | Becomes |
| --- | --- |
| `x === 'codex' ? codexThing : claudeThing` (both sides engine-specific) | exhaustive `switch (engine)` ending in `assertNever`, or a `Record<Engine, …>` |
| `!onCodex` / `x !== 'codex'` guarding Claude-only machinery | `engine === 'claude'` |
| `onCodex` guarding Codex-only machinery | `engine === 'codex'` |
| "holds a session of another engine" (`sessionEngine === 'codex'`) | `sessionEngine !== undefined` (generic: any non-Claude mark) |
| writing a mark (`engine === 'codex' ? {engine} : {}`) | `sessionMark(engine)` |
| a gate whose cap exists (`caps('codex').rooms`) | the member's own engine's cap, with a per-engine refusal text |

`onCodex` and `!== 'codex'` disappear from `backend/src`, `shared/src` and `frontend/src`; a source-scan test keeps them out.

## Review Focus

1. A Codex chat whose stored `sessionEngine` is `'codex'` must still resume its thread (not reseed): `markEngine` must read the mark back as the same engine.
2. A Claude chat with no mark must not gain `sessionEngine: undefined` writes it never had (the `engineMark` patch shape stays exactly as today).
3. The Claude side base must still be dropped when a Codex run of the same agent happens, and the other way round.
4. Room refusals must keep the exact `CODEX_REFUSALS.room` text for Codex members.
5. Agent Studio's Engine select must still write `provider: codex` / remove the key, and still drop a model the other engine can't use.

---

### Task 1: Shared engine vocabulary

**Files:** Modify `zumi-bot-server/shared/src/engine.ts`, `types.ts`, `frontmatter.ts`, `chatModel.ts`, `chatRun.ts`, `extensions.ts`. Test `zumi-bot-server/shared/tests/engine.test.ts` (create if missing).

**Produces:**
- `type Provider = Exclude<Engine, 'claude'>`
- `ENGINE_LABEL: Record<Engine, string>` (`{claude: 'Claude', codex: 'Codex'}`), `ENGINES: readonly Engine[]` (its keys)
- `parseProvider(v: unknown): Provider | null` (exact match against a `Record<Provider, true>`; anything else null, as today)
- `sessionMark(engine: Engine): Provider | undefined`, `markEngine(mark: Provider | undefined): Engine`
- `providerOf(engine: Engine): Provider | null` (Agent Studio's write)
- `assertNever(x: never): never`
- `engineCaps` reads `Record<Engine, EngineCaps>`; `engineOfAgent` is `a?.provider ?? 'claude'`
- `AgentSummary.provider`, `SessionCut.engine`, `GroupInfo.sessionEngines`, `ChatMeta.sessionEngine`, `AgentFields.provider`, extensions' `engine` typed through `Provider` / `Engine`

- [ ] Tests: `parseProvider('codex') === 'codex'`; `parseProvider('Codex'|'claude'|'codex '|undefined) === null`; `sessionMark('claude') === undefined`, `sessionMark('codex') === 'codex'`; `markEngine(undefined) === 'claude'`, `markEngine('codex') === 'codex'`; `ENGINES` equals `['claude', 'codex']`; `engineCaps` values unchanged for both.
- [ ] Implement; `chatModel.ts` model test becomes a `switch`; `frontmatter.ts` parses through `parseProvider`.
- [ ] `npx vitest run --project shared` passes; existing frontmatter/agentStore provider tests unchanged.

### Task 2: Backend sites outside the turn path

**Files:** `backend/src/core/chat/sessionPoints.ts`, `groupService.ts`, `core/groupMembers.ts`, `core/btw/sideRun.ts`, `core/btw/sideQuestions.ts`, `core/extensions/extensionsService.ts`, `core/extensions/sanitize.ts`, `core/attempts/attemptSets.ts`, `core/codex/isCodexChat.ts`, `app.ts`, `rpc/handlers.ts`.

- `sessionPoints`: marks typed `Provider`; "this stamp carries an engine" is `engine !== undefined`; whether a reply's end stamp is its cut point (Codex) is `ENDS_AT_TURN: Record<Engine, boolean>` read through `markEngine`.
- Rooms: `refuseCodexMembers` / `GroupService.refuseOn` judge each member by its own engine's `rooms` cap; the text comes from `roomRefusal(engine, member)` (exhaustive; Codex keeps `CODEX_REFUSALS.room`).
- `handlers.ts`: `engineOf` uses `engineOfAgent`; "every engine has the cap" uses `ENGINES.every`.
- `isCodexChat` becomes `holdsNonClaude` semantics under its existing name and callers: a non-Claude mark or a non-Claude engine (`!== undefined`, `!== 'claude'` read positively).
- Extensions: `guardHook` target and the probe builder become exhaustive switches; sanitize's unsupported text a `switch`.
- `sideRun`/`sideQuestions`: a base's engine is `sideBaseEngine(base)`; point comparisons go through `markEngine`; keep-warm's skip is `engine !== 'claude'` rewritten positively.
- [ ] `npx vitest run --project backend` passes.

### Task 3: The turn path in `ChatService`

**Files:** `backend/src/core/chat/chatService.ts`.

- `const engine: Engine = spec.engine ?? 'claude'`; no `onCodex`.
- `engineMark` from `sessionMark`; the turn model by `switch`.
- One-sided sites become positive (`engine === 'claude'`: automations, Claude pause settings, vault guard settings, side-base live point, `cut` stamps, compaction sizes, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, run config, cost baseline, tmp dir, thinking probe, drops, `promptUuid`, `onRunWithoutCost`, `sent`; `engine === 'codex'`: Codex pause hook, Codex vault hooks, compact limit, `definitionOf`).
- Exhaustive: the vault key env policy, the side base build, the launch (adapter registry), "the prompt reached the agent" (`todoSpawned`), locate, the not-found text, the missing-session test, the fork-ignored text, the exited label (`ENGINE_LABEL`), `canPause`'s per-engine hook need.
- [ ] `npx vitest run backend/tests/core/chatService.test.ts` and the codex/engines tests pass unchanged.

### Task 4: Frontend sites

**Files:** `frontend/src/state/agentEngine.ts`, `contextMeter.ts`, `commandModel.ts`, `runPickers.ts`, `commandPalette.ts`, `agentLoadout.ts`, components `AgentForm.tsx`, `AgentEditor.tsx`, `AgentLoadout.tsx`, `TodoAttempts.tsx`, `VaultSettings.tsx`.

- Tags from `engineTag(engine): string | null` (a `Record<Engine, string | null>`); `engineChoices` built from `ENGINES` with per-engine availability (`switch`); `modelAfterEngineSwitch(…, to: Engine)` a `switch`; `vaultGrantNote` by the agent's engine caps with per-engine text; `readOnlyNote` a `switch`.
- `compactNoteShown` is `engine === 'claude'`; cold contexts skip any mark (`!== undefined`).
- `AgentEditor`: Claude-only cards gated `engine === 'claude'`, not `provider !== 'codex'`.
- [ ] `npx vitest run --project frontend` passes.

### Task 5: Guard, proof and docs

- [ ] `backend/tests/core/engineChecks.test.ts` (or shared): scans `backend/src`, `shared/src`, `frontend/src` (`.ts`, `.tsx`) and fails on `onCodex` or `!== 'codex'`.
- [ ] Proof: temporarily add `'acp'` to `Engine`, run `npm run typecheck`, record which files fail (each must be a decision point listed above), then revert.
- [ ] `npm test`, `npm run typecheck`, `npm run build:server` all pass.
- [ ] Docs: `engines.md` gets a "Phase 4 — exhaustive engine checks" section (the rule table, the proof's list, what stays positive); `protocol-engines.md` marks 1a done and notes the new caps move to 1b with their first reader; `codex.md` sentence on "two gates still judge by name" updated.
