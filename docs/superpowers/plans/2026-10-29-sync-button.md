# Sync Button Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the existing two-way sync from the desktop and hand browser requests to the desktop helper.

**Architecture:** A desktop sync coordinator owns the lifecycle and a dedicated local progress window survives server restarts. A fixed protocol URL requests the same workflow after native confirmation. Ship the existing scripts unchanged as desktop resources, launching them with Electron's Node runtime through a small JSON-message runner.

**Tech Stack:** Electron, TypeScript, React, Node.js, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-sync-button-design.md`

## Global Constraints

- Preserve CLI behavior, backups, merge rules, and browser exclusions.
- No real sync, deployment, installation, or changes to personal data during verification.
- Import only VPS_HOST, VPS_USER, VPS_DIR; never package configuration or credentials.
- Use the approved scope without another approval checkpoint; work in the user's current checkout and leave changes uncommitted for review.

## Review Focus

- Concurrent protocol requests, switching, closing, and retries cannot overlap a sync.
- Unknown local busy state refuses sync; failure after stopping always restores the connection.
- Invalid configuration and protocol parameters never reach command execution.
- Packaged resources work outside a checkout with Electron's Node runtime.
- Missing desktop helpers or older desktop bridges yield useful browser/UI guidance.

### Task 1: Sync coordinator and configuration

**Files:** new `zumi-bot-desktop/src/main/syncFlow.ts`, `syncConfig.ts`, `syncTrigger.ts`; corresponding desktop tests.

**Interfaces:** `createSyncFlow(deps)` returns `run(): Promise<void>` and `active(): boolean`; dependencies handle configuration/confirmation, dirty edits, idle checks, pause, run, restore, and logs. `parseSyncConfig(text)` and `readSyncConfig(file)` return validated VPS settings. `wantsSync(argv)` recognizes only `zumibot://sync` (optional trailing slash).

- [ ] Write failing tests for order, refusal, cancellation, duplicate requests, restoration after failure, invalid protocol arguments and config allowlisting/private storage.
- [ ] Run `npx vitest run zumi-bot-desktop/tests/sync*.test.ts`; expect missing-module failures.
- [ ] Implement the isolated coordinator and config helpers, including rejection of unsupported local data-dir overrides.
- [ ] Run the same tests; expect all passing.

### Task 2: Desktop runtime and progress UI

**Files:** new `zumi-bot-desktop/src/main/syncDesktop.ts`, `syncProcess.ts`, `src/sync/runner.mjs`, `src/pages/sync.{html,js}`; update main, preload, window close guard, build configuration.

**Interfaces:** dedicated file-page bridge exposes status/start/configure only to the progress window. Main app bridge adds optional `sync(): void`. `runSyncProcess(options)` runs the shipped scripts with IPC logs and resolves the exit code.

- [ ] Write and run process tests using a synthetic worker; expect failure before implementation.
- [ ] Implement worker packaging and native configuration/confirmation/progress window, integrate lifecycle guards and protocol dispatch at startup and second-instance.
- [ ] Run desktop tests and typecheck; verify failure restores connection and processes never receive arbitrary page inputs.

### Task 3: Frontend, documentation, integration verification

**Files:** update account menu/shared bridge/icon, add browser handoff dialog, README; add isolated desktop/browser smoke coverage.

- [ ] Add Sync action; older desktop clients receive update guidance, browsers receive a fixed protocol link and explicit progress guidance.
- [ ] Document first-time config import, SSH prerequisites, installed-app requirement, and busy behavior.
- [ ] Run existing sync integration tests, desktop/frontend suites, workspace typecheck, and build.
- [ ] Exercise built desktop progress/IPC with temporary HOME and fake SSH/rsync; verify packaged protocol metadata without installing.
- [ ] Request fresh code review, fix important findings, record verification results.

## Progress

- Plan written after design approval. Implementation proceeds inline; no Git mutations or dependency installs are needed.
