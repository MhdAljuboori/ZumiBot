# Whole-change browser review

Reviewed 2026-10-29. **Base `d447615`; head `4a94b08`**, including the required `task-9-sync-integration.patch` and its corresponding working-tree browser exclusions. This is the whole feature review, not a Task 10-only gate. Paths below are repository-relative.

Requirements: `docs/superpowers/specs/2026-10-27-agent-browser-design.md`, `docs/superpowers/plans/2026-10-27-agent-browser.md`, their Global Constraints and five Review Focus items, and the controller's binding refinements in `context.md`/`progress.md`. The Linux-only lifecycle, conservative startup uncertainty, permanent attempt revocation, same-profile rename/retry behavior, and retained-source reservation rulings were treated as requirements.

### Strengths

- The production separation is sound: the application creates capabilities and a private IPC service without starting Chromium; only a demand creates a worker, and only the worker loads Playwright. Explicit runtime setup and copied worker/bridge/Playwright assets support the Electron and server artifacts without a development installation. Exact dependency pins agree between the backend manifest and lockfile (`playwright-core` 1.64.1, MCP SDK 1.32.2).
- Control is enforced at the service boundary. Takeover drains the current lease operation, disconnect aborts the exact viewer lifetime, and manual work rechecks identity and page stamps when it executes. Input admission preserves receive order across asynchronous authentication, while release/unwatch discard queued typing. The close/reopen tests exercise stale takeover acknowledgments at manager, transport, and frontend boundaries.
- Process retirement fails conservatively. Controlled-launch public CDP identities and Linux PID/start proof are used instead of argv heuristics; failed cleanup reserves capacity. The single-flight initial global recovery includes orphan profiles before any launch. Profile IDs survive rename and do not revive on clear/delete/recreation. Existing real-worker assertions cover forced parent/worker death and unrelated near-prefix profiles.
- Files have a coherent authority chain: authenticated session → current controlling viewer or authorized chat turn → opaque file ID → private path. Source-plus-copy reservations remain held through failure, expiry, clear, and missing cleanup confirmation; verified worker teardown and scratch removal provide the final retirement path. The source-transfer ACK and oversized-download tests check meaningful cleanup boundaries rather than merely successful return values.
- Handoff persistence is integrated into current single/group item references, routine waiting counts, restart interruption, and attempt disposal. Actual permission input remains private and intact while app-owned browser tool/approval transcript rows are sanitized. Existing MCP configurations and Zumi Bot deny rules are preserved, and moderator turns do not receive browser tools.
- Evidence is unusually explicit about its limits. The acceptance runner uses the actual injected bridge and real sandboxed Chromium, while the verification note identifies the fake CLI and short resource samples. The installed-Claude discovery check is separately reported as passed without a model request; it is not confused with proof of long live-model waits.

### Issues

#### Critical (Must Fix)

None found.

#### Important (Should Fix)

**I1. A new lease held by the same turn accepts references from its previous lease.**

- **Files:** `zumi-bot-server/backend/src/core/browser/browserManager.ts:174`, `:186`, `:220`; `zumi-bot-server/backend/src/core/browser/browserLeases.ts:45`, `:59`.
- **Trigger:** a turn observes, calls `browser_release`, then reacquires with a click/type/upload using the old stamp. The same problem applies when ownership inactivity expires while a visible viewer keeps the browser alive and that turn later reacquires before another turn uses it.
- **Effect:** release/expiry clears `lease.owner`, but the manager retains the same `lastOwner` chat/turn key. Invalidation only runs when that key changes, so the old observation remains valid across the new lease. This violates the explicit requirement that later reacquisition invalidate prior observations and require a fresh snapshot. A stale action can therefore operate on a page whose state changed while ownership was relinquished.
- **Evidence:** a narrow read-only, in-memory reproduction loaded the production `BrowserManager`/`BrowserLeases` and existing `FakeBrowserAdapter`, with inert timers and an in-memory profile seam. `observe → release → click(old stamp)` printed `{"result":{"ok":true,"data":null},"referenceInvalidations":0,"commands":["observe","click"]}`. No browser, profile, or test file was created. The real adapter likewise accepts an unchanged observation ID; existing tests cover takeover and different-owner invalidation, not this same-owner reacquisition.
- **Fix:** expose a lease epoch or an explicit new-lease indication from acquisition, and await reference invalidation when that epoch changes, including same-turn release and inactivity reacquisition. Keep the existing bounded invalidation/uncertain-generation retirement behavior. Merely setting `lastOwner` to `undefined` on release is insufficient because the existing truthiness guard skips invalidation. Add focused regressions for both explicit release and inactivity expiry, while proving successive commands within one uninterrupted lease still work.

**I2. Every real agent turn is still told that the implemented upload feature is unsupported.**

- **File:** `zumi-bot-server/backend/src/core/browser/browserPrompt.ts:3`.
- **Trigger:** a user attaches a file and asks an agent to upload it through its browser.
- **Effect:** the injected system instructions say, “File uploads are not supported yet.” Task 8 now exposes `browser_upload` and authorizes attached chat file IDs, so the agent receives directly conflicting guidance and may refuse a supported task. The deterministic fake CLI bypasses this decision and therefore cannot validate it.
- **Fix:** replace the obsolete sentence with the actual supported contract: upload only explicitly attached chat files using their opaque IDs and fresh element stamps; use the user handoff/native picker when the user must choose a file; never accept arbitrary filesystem paths. Ensure the instructions make the attachment-ID source usable. Add a focused assertion against the actual injected browser prompt so an earlier implementation placeholder cannot survive another feature slice. No paid model prompt is needed.

#### Minor (Nice to Have)

**M1. Two end-to-end negative checks can pass before the competing request reaches the service.**

- **Files:** `zumi-bot-server/e2e/browser.e2e.mjs:170`, `:231`.
- **Trigger/effect:** on a slow machine, the 250/300 ms sleeps may finish before the fake CLI has submitted the blocked observe/action or group request. Absence of a result then does not prove contention. This is the deferred Task 10 minor, not a demonstrated serialization failure; focused service tests provide stronger coverage.
- **Fix:** add a test-only request/admission checkpoint and wait for it before asserting non-completion, then release the owning controller/turn and require completion. Keep instrumentation free of input, capability, and page-content logging.

**M2. The final verification note omits successful-build warnings.**

- **File:** `docs/superpowers/verification/2026-10-27-agent-browser.md:42`.
- **Evidence/effect:** retained `task-10-evidence/e2e-browser.log:29` and `:60`, and `desktop.log:33` and `:64`, contain the frontend chunk >500 kB advisory and Electron “renderer config is missing” warning. The note lists build success without acknowledging these accepted existing warnings, making the final record less precise than the underlying logs.
- **Fix:** briefly disclose both warnings beside the build results and identify them as existing configuration/advisory output. No unrelated bundle or desktop configuration refactor is requested.

### Review focus and verification

The review was performed in bounded passes: requirements/rulings and range; manager/lease/handoff/profile lifecycle; private worker/process/file boundaries; authenticated socket and frontend input/frame lifetimes; CLI/chat/group/routine integration; packaging, sync supplement, and risk-specific assertions/evidence. Production paths were read directly. Test review concentrated on behavioral assertions at the named risks, rather than treating test names or passing totals as proof.

| Review focus | Assessment |
| --- | --- |
| Close/reopen during takeover | Connection identity, abort lifetime, manager pause/release, client epoch, and stale-ack tests align. No stale connection grant found. |
| Same-agent single/group serialization | Turn lease spans command sequences and same-owner pending handoffs reject further agent work. The same-owner **new-lease reference boundary is defective (I1)**; the E2E admission proof can improve (M1). |
| Popups/dialogs/files/IME | Tab caps apply to popup tracking; modal-triggering agent and manual operations yield to permit answers; file resolution and transfer accounting remain private/bounded. Actual upload instructions are stale (I2). DOM composition/native Linux paste evidence does not prove native OS IME or macOS. |
| Corrupt/rename/delete/crash/signout cleanup | Disabled metadata path preserves text operation; fresh attempt IDs and cached profile identity prevent retry rebinding; initial global recovery and actual process proof protect isolation/capacity. Auth revocation closes the matching session's watches and drops control; pending handoffs then follow their explicit terminal/expiry lifecycle. |
| Hidden/stalled viewer | Hidden state unwatches; reconnect returns read-only. One decode/newest pending JPEG on the client, one in-flight/newest pending frame at the socket, byte limits, heartbeat, and sustained-pressure disconnect are implemented. Real hidden behavior and deterministic blocked-write assertions complement each other. |

No public CDP listener, `--no-sandbox`, CSP/preload relaxation, parent Playwright startup import, automatic viewer/capture, or automatic browser download was found in the feature. Ordinary app-owned manual input does not enter chat persistence; page content/site storage after control release remains subject to the documented limit on that guarantee.

The sync supplement was checked against the actual external file: root-level `browsers/` and `browser-runtime/` exclusions apply to whole-data pull, local backup, and remote backup; final push uses the existing explicit chat/settings/attachment list. The unrelated external sync implementation was not treated as browser-owned work. **The supplement is part of this review and must remain part of the delivered change; the committed range alone does not contain those untracked-file edits.**

Retained evidence inspected: 132 files / 1,822 passing tests / 1 opt-in skip, typecheck results, 31 service acceptance checks, 16 viewer checks, packaged desktop execution, and build-warning logs. Task 4's final report separately records the installed-Claude discovery pass (22 scoped tests with the opt-in enabled). Broad suites, build/install/deploy, and model calls were not rerun for this review. The only new execution was the targeted in-memory I1 reproduction; it is service-boundary evidence, not real-browser acceptance.

### Recommendations

Address I1 and I2 in the combined fix wave, and include the two small deferred minors if practical. Validate the changed lease boundary with deterministic same-turn tests, verify the actual injected upload prompt, and rerun only affected suites/acceptance portions. Preserve the sync supplement, final measurement logs, and the stated environment limits in the durable handoff before removing temporary review artifacts.

### Declined to judge

- Native Linux OS IME, native macOS clipboard/IME, and non-Linux browser process lifecycle: unavailable environment; Linux lifecycle scope was explicitly authorized, and DOM-event tests do not establish native integration.
- Live-model behavior across the normal 10-minute unattended wait or 24-hour MCP ceiling: no real model prompts authorized/performed; real CLI discovery and synthetic progress/cancellation cover different claims.
- Long-running service soak and a hard RAM/CPU ceiling: no soak evidence; the plan requires measured workload-specific resources, not a universal memory guarantee.
- Live VPS/TLS reverse-proxy operation: loopback VPS-style authentication is evidenced, but no live deployment was authorized.
- Actual managed Chromium network installation, ARM64 execution, other Linux OS/library images, or installation of the `.deb`: intercepted installer, x64 system Chromium, and unpacked Electron artifact tests do not prove those environments; no installation was authorized.
- Browser extensions, camera/microphone, passkey devices, and arbitrary OS dialogs: explicitly excluded from the initial feature scope.
- Confinement of arbitrary shell programs or third-party MCP tools: the design explicitly scopes supported interactive work through the managed browser and preserves existing independent tool permissions.
- Correctness of unrelated external sync/deploy work beyond the narrow browser transfer/backup exclusions: outside this feature's ownership; only the required supplement was reviewed for browser isolation.
- Exhaustive manual inspection of lockfile transitive metadata or every unchanged baseline test: bounded review focused on exact new runtime pins, actual copied assets, production interfaces, and risk-specific changed assertions; no independent upstream dependency audit was requested.

### Assessment

**Ready to merge? With fixes.**

The integrated design and evidence support the intended Linux Local/VPS browser architecture, but I1 leaves a required reference-safety boundary unenforced and I2 contradicts a shipped user-facing capability. Correct those two issues and verify their focused regressions before merging; the listed environment limits remain explicit acceptance limits rather than implied passes.
