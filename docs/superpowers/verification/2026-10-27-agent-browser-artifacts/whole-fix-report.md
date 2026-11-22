# Final whole-review fix wave

Status: DONE. Fix base: `4a94b08`. Scope is exactly whole-review findings I1, I2, M1 and M2. No subagents dispatched; controller owns the one scoped re-review and final full suite.

## Changes and contracts

### I1 — ownership periods invalidate references

`BrowserLeases.acquire` now returns `{ epoch, release }`. The monotonically increasing per-profile epoch advances when a grant begins with no owner, including the same turn after explicit release or inactivity. Completing an individual command does not change the epoch. The manager remembers the last epoch for its live generation instead of a chat/turn tuple, and awaits invalidation before executing a command or creating a handoff in a changed epoch. Fresh instances reset the remembered epoch because they already have a fresh browser generation.

The existing operation serialization, pause/drain barrier, handoff lease protection, and bounded invalidation/uncertain-generation retirement remain in place. No timer/default, handoff, viewer ownership or cleanup policy changed. Existing timeout, takeover, pending-handoff and socket lifecycle tests were rerun. Explicit browser release during an active command or protected handoff retains its existing no-op semantics.

Deterministic manager regressions keep a visible viewer attached while the same turn releases or expires. They prove invalidation is awaited before adapter dispatch, stale clicks fail, the browser generation remains alive, and fresh observations work. A separate uninterrupted-command check ensures no unnecessary invalidation. Lease tests explicitly check epoch continuity/change. Two real Chromium tests pass old production-adapter references through the real manager, prove uninterrupted clicks work, then reject them with `stale_reference` after release/expiry and accept freshly observed references in the same generation. Only the lease deadline is explicitly fired in the real inactivity test; browser execution and command deadlines use real time.

### I2 — usable supported upload instructions

The real injected browser prompt now says to use `browser_upload` only for explicitly attached chat files, take opaque file IDs from `<attachments>` notes, and use a fresh observation stamp/reference. User file selection goes through `browser_request_user_action` and the app browser's native picker; filesystem paths are forbidden as browser tool arguments.

Attachment notes now append `[file ID: <opaque ID>]` beside their existing path/name/image annotation. The existing attachment path, `--add-dir` access, image blocks, saved user items, permission response payload and browser transcript redaction behavior are preserved. The additive note flows through ordinary turns, group member turns and expired-session seeds. A chat-service test creates the actual `serveBrowserIpc` turn and inspects the actual runner `--append-system-prompt`, initial attachment text and retry seed. It does not substitute a fake browser prompt. The group attachment test separately asserts discoverable IDs. No model/CLI prompt was submitted.

### M1 — contention evidence begins at the service

Test-only `NODE_OPTIONS` instrumentation observes incoming data on the private `/tmp/cb-b-*/s` IPC server after its production data listener. It writes only a process ID, timestamp, fixed event type and the allowlisted operation name (`observe`/`click`). It does not record request arguments, tokens/capabilities, auth, input, page content, socket paths or owner identities. No production hook/debug endpoint or source transform was introduced.

The real acceptance test snapshots receipt counts, starts the competing calls, and waits for each expected operation to reach the service. Only then does a bounded 250 ms non-completion observation window run. Both manual-control observe/action must remain unfinished; after release observe succeeds and the stale action completes with `stale_reference`. The group observe must reach the service and stay unfinished before the held single turn releases; it then completes. This eliminates the original case where the entire negative interval elapsed before CLI startup/request submission. The checkpoint establishes actual IPC receipt, not an internal scheduler-state probe; deterministic lease/manager tests continue to prove precise serialization.

### M2 — accepted build warnings disclosed

The successful `npm run build` row now explicitly records the existing frontend chunk >500 kB advisory and Electron “renderer config is missing” warning. Checked against retained Task 10 `e2e-browser.log` lines 29/60 and `desktop.log` lines 33/64. No bundle or Electron configuration changed. The instrumentation paragraph also describes the new request-receipt checks.

## RED / GREEN evidence

Raw logs: `.superpowers/sdd/2026-10-27-agent-browser/whole-fix-evidence/`.

- **I1 RED:** `npx vitest run zumi-bot-server/backend/tests/core/browserManager.test.ts -t 'ownership period'` — exit 1, 2 failed / 1 passed / 44 skipped. Both release and inactivity expected `{ok:false, code:'stale_ref'}` but received `{ok:true}`. `i1-red.log`.
- **I1/I2 initial GREEN:** `npx vitest run zumi-bot-server/backend/tests/core/browserManager.test.ts zumi-bot-server/backend/tests/core/browserLeases.test.ts zumi-bot-server/backend/tests/core/attachmentContent.test.ts zumi-bot-server/backend/tests/core/chatService.test.ts` — exit 0, 4 files / 152 passing. `i1-i2-green.log`.
- **I1 real GREEN:** `npx vitest run zumi-bot-server/backend/tests/core/chromiumAdapter.test.ts -t 'real same-turn'` — exit 0, 2 passing / 21 skipped; production manager and sandboxed Chromium. `i1-real-green.log`.
- **I2 prompt RED:** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts -t 'injects the real upload'` — exit 1, 1 failed / 90 skipped. Actual appended prompt lacked `browser_upload` and contained “File uploads are not supported yet.” `i2-red.log`.
- **I2 ID RED:** `npx vitest run zumi-bot-server/backend/tests/core/attachmentContent.test.ts` — exit 1, 3 failed / 5 passed. Exact ordinary/seed notes lacked the expected file-ID suffix. `i2-ids-red.log`.
- **M1 RED:** `node zumi-bot-server/e2e/browser.e2e.mjs` after adding receipt assertions but before receipt instrumentation — exit 1, `Timed out: competing observe and click reached private IPC service`. `m1-red.log`. This proves a missing receipt cannot silently satisfy the strengthened check.
- **M1 initial GREEN:** the same command, after test-only instrumentation — final output `{"result":"PASS","checks":31,...}`. `acceptance-green.log`. The process completed during the usage-limit interruption; its session was unavailable on resume, so the retained final result was inspected instead of restarting that run.
- **M1 final GREEN:** the same command against the final bounded post-receipt window — exit 0, final output `{"result":"PASS","checks":31,...}`; `acceptance-final.log` and `acceptance-final-evidence.json`.
- **M2 RED inspection (documentation-only):** a Python read/assert check confirmed the successful build row omitted both retained warnings; `m2-red.log`. This was an omission check, not an invented failing unit test.
- **M2 GREEN inspection:** a Python assertion checked the successful build row contains `PASS`, `existing`, `chunk >500 kB` and `renderer config is missing`; exit 0. `m2-green.log`.

## Affected verification

All affected backend suites, including real Chromium, passed with no unexpected warning/error output:

```sh
npx vitest run \
  zumi-bot-server/backend/tests/core/browserLeases.test.ts \
  zumi-bot-server/backend/tests/core/browserManager.test.ts \
  zumi-bot-server/backend/tests/core/browserIpc.test.ts \
  zumi-bot-server/backend/tests/core/browserBridge.test.ts \
  zumi-bot-server/backend/tests/core/browserHandoffs.test.ts \
  zumi-bot-server/backend/tests/core/chatService.test.ts \
  zumi-bot-server/backend/tests/core/groupService.test.ts \
  zumi-bot-server/backend/tests/core/attachmentContent.test.ts \
  zumi-bot-server/backend/tests/core/browserFiles.test.ts \
  zumi-bot-server/backend/tests/core/browserFileIpc.test.ts \
  zumi-bot-server/backend/tests/http/browserSocket.test.ts \
  zumi-bot-server/backend/tests/core/chromiumAdapter.test.ts
```

Exit 0; **12 files, 346 passed, 1 skipped**, 33.53 s (`affected-tests.log`). Skip is the existing opt-in installed-Claude check; no paid model call was made.

`npm run typecheck` — exit 0, every workspace (`typecheck.log`).

`npm run build -w @zumibot/backend` — exit 0, 477 modules transformed, built in 149 ms (`backend-build.log`). Only the changed backend needed rebuilding for the actual acceptance run; prior frontend/desktop build warnings are disclosed, not rerun/refactored.

After strengthening the deterministic invalidation gate assertion, `npx vitest run zumi-bot-server/backend/tests/core/browserManager.test.ts zumi-bot-server/backend/tests/core/browserLeases.test.ts` was rerun (`lease-final.log`). Exit 0, 2 files / 54 passing, 848 ms.

`git diff --check` passed. No broad full-suite rerun performed by this implementer; controller owns it. No new viewer product code changed, so the unchanged standalone 16-check viewer suite was not redundantly rerun; the full 31-check service acceptance includes actual UI manual input/takeover/hidden-viewer/signout paths.

## Files owned by this wave

1. `zumi-bot-server/backend/src/core/browser/browserLeases.ts`
2. `zumi-bot-server/backend/src/core/browser/browserManager.ts`
3. `zumi-bot-server/backend/src/core/browser/browserPrompt.ts`
4. `zumi-bot-server/backend/src/core/attachments/content.ts`
5. `zumi-bot-server/backend/tests/core/browserLeases.test.ts`
6. `zumi-bot-server/backend/tests/core/browserManager.test.ts`
7. `zumi-bot-server/backend/tests/core/chromiumAdapter.test.ts`
8. `zumi-bot-server/backend/tests/core/chatService.test.ts`
9. `zumi-bot-server/backend/tests/core/attachmentContent.test.ts`
10. `zumi-bot-server/backend/tests/core/groupService.test.ts`
11. `zumi-bot-server/e2e/browser.e2e.mjs`
12. `zumi-bot-server/e2e/fixtures/browser-instrumentation.mjs`
13. `docs/superpowers/verification/2026-10-27-agent-browser.md`

This ignored report and raw logs are handoff artifacts. Controller plan/spec, external `CLAUDE.md`, deploy files, root package sync hunk, untracked sync implementation/test remain untouched and excluded. The required Task 9 sync supplement remains intact.

## Self-review and limits

Read the entire scoped diff. Epochs are internal per-profile ownership identities, not exposed wire/capability data; they are acquired under the existing exclusive command grant. Both normal execution and request-user-action compare epochs under the existing bounded invalidation path. New-generation reset cannot revive old generation stamps. Attachment authority is still checked by the existing file service, not by trusting prompt text. Test instrumentation remains opt-in and accepts no commands of its own.

Real-browser tests use Linux system Chromium with sandboxing enabled and synthetic local pages/throwaway profiles. No installation, deployment, sudo, real credentials or model prompts. No new proof of native OS IME/macOS, long live-model waits, non-Linux lifecycle, soak/resource ceilings or live VPS/TLS is claimed. Existing limits in the Task 10 verification note remain applicable. New acceptance resource samples are incidental under concurrent test load; they do not replace Task 10's retained measurement table. The original `task-10-evidence/evidence.json` was backed up before successful acceptance completion and restored byte-for-byte after separately saving this wave's `acceptance-final-evidence.json`.

## Commit

`bc4fbcb` — `fix(browser): invalidate renewed leases and correct upload guidance`. Exactly 13 scoped files, 212 insertions / 43 deletions. Staged path inspection and `git diff --cached --check` passed before commit. Post-commit `git status --short` shows only the preserved external/controller changes listed above. No fix-owned file remains dirty.

No unresolved implementation concern found in self-review. Independent scoped re-review and final full suite remain controller-owned.
