# Agent browser verification — Task 10

Executed 2026-10-29 on the local Linux test machine. Design/plan date: 2026-10-27. Baseline: `b675b72` (Tasks 1–9 already reviewed). These are synthetic acceptance results, not live VPS deployment evidence. Independent task, whole-change and scoped correction reviews are complete; final handover results are recorded below.

## Final verification and handover

The integrated whole-change review found two production gaps: references could survive same-turn lease reacquisition, and upload instructions contradicted the implemented feature while omitting attachment IDs. Both were corrected and independently re-reviewed. Test-only service-receipt checkpoints and build-warning disclosure were also completed. A final packaging assertion was corrected to verify the actual owned profile/processes while preserving unrelated temporary files; production cleanup did not change.

Final checks on the completed source:

- `npm test`: **132 files, 1,829 passed, one existing opt-in skip**, exit 0, 33.73 seconds.
- All-workspace typecheck: exit 0; the test-only packaging amendment also passed backend typecheck.
- Combined review corrections: 346 affected tests passed / one existing skip, 54 final lease checks passed, 31 Local/VPS service acceptance checks passed.
- Final packaging correction: 9/9 tests passed and independent scoped review found no issues.
- Final source build and its accepted pre-existing warnings are retained in `2026-10-27-agent-browser-artifacts/final-build.log`.

The original 31 service/CLI plus 16 viewer checks, packaged desktop acceptance, authentication, routine and resilience evidence remain below. Native OS input, live-model long waits, soak and live deployment limitations remain explicit; a passing synthetic fixture is not proof of those environments.

[Durable evidence and review index](2026-10-27-agent-browser-artifacts/README.md) · [Execution decisions](2026-10-27-agent-browser-artifacts/rulings-final.md) · [Applied external sync supplement](2026-10-27-agent-browser-artifacts/task-9-sync-integration.patch)

## Result and reproducibility

`npm run e2e:browser` passed: a complete build, 31 browser service/CLI checks across Local and VPS-style authentication, and 16 reused viewer acceptance checks. A final affected `node zumi-bot-server/e2e/browser.e2e.mjs` run also passed all 31 checks after strengthening sign-out process cleanup. Both use sandboxed real Chromium with throwaway profiles and synthetic local websites. No model requests were made.

The new `backend/tests/fixtures/fake-browser-claude.mjs` reads the actual injected `--mcp-config`, launches its configured bridge command/arguments, expands its injected environment placeholders, initializes MCP, discovers tools, and calls the real tools over stdio. It checks `--no-chrome`, the 86,400,000 ms MCP ceiling, disabled background tasks, disabled MCP auto-backgrounding, and absence of the app's local secret. It emits compatible Claude stream-json and handles group moderator JSON deterministically. Capability tokens, IPC paths, injected environments, and typed input are not logged by instrumentation.

`e2e/browser.e2e.mjs` reuses `e2e/harness.mjs` and `e2e/fixtures/browser-site.mjs`. The existing `browser-viewer.e2e.mjs` supplies the detailed viewer/input/files/popup/dialog acceptance rather than duplicating it. `fixtures/browser-instrumentation.mjs` is loaded only by this test's `NODE_OPTIONS`; only a worker imports/wraps Playwright. It traces actual `Page.startScreencast`/`Page.stopScreencast`, context close, sandbox setting and operation names. The contention checks now wait for private IPC service receipt of the competing operation names before a bounded non-completion check, then require completion after release. There are no product debug endpoints or production instrumentation changes, and text-only parent startup remains lazy.

Raw reproducible logs and measurements remain under `docs/superpowers/verification/2026-10-27-agent-browser-artifacts/task-10-evidence/` (committed handover artifacts). `evidence.json` contains the final measurements; `browser-final.log`, `e2e-browser.log`, `viewer.log`, `tests.log`, `typecheck.log`, `affected-tests.log`, `routines.log`, `resilience.log`, `auth.log`, and `desktop.log` record commands/results. Viewer screenshots and its 16-check evidence are under `zumi-bot-server/e2e/screenshots/browser-task7/` (git ignored).

## Acceptance matrix

| Requirement | Evidence | Result |
| --- | --- | --- |
| Startup/text work/status do not launch Chromium | Both real auth modes start with zero owned Chrome processes; application/manager lazy-launch unit tests | PASS |
| Unseen navigate/observe and pending cards produce zero screencasts | Real CLI→MCP→worker instrumentation before explicit viewer; answer-only completion paths | PASS |
| Explicit viewer shows agent's same live page/tab | Generation, active tab ID and fixture URL equal MCP observation; live canvas 1280×800 | PASS |
| Multiple viewers use one producer; final close stops it | Real two-client watcher check and actual CDP start/stop count | PASS |
| Takeover blocks agent observation and action | Concurrent real MCP observe/click remain unfinished during human control; resume after release | PASS |
| Manual input reaches same page; release refreshes references | Synthetic text read through MCP after manual input; changed observation ID; old reference rejected | PASS |
| Quick release retains live generation while discarding stale queued typing | Actual UI burst/immediate toggle in both modes; two >16-pending revocation tests plus held-active-input test | PASS |
| Single/group/routine handoff done/cancel/timeout | Nine real CLI→MCP cases per auth mode; routing and error codes checked; routine waiting→done checked | PASS |
| Pending cards/restart/session persistence | Restart marks old card interrupted, rejects old answer; synthetic cookie survives idle and server restart | PASS |
| Separate agents remain isolated | Second agent has no first agent's synthetic cookie in both modes | PASS |
| Same-agent single/group turns serialize | Group observe cannot complete until the held single-chat sequence releases ownership | PASS |
| Two-browser cap queues third profile | Two watched pending handoffs pin two profiles; third reaches queued state and starts only after a slot is released | PASS |
| Idle cleanup returns to zero processes | Actual owned Chrome process count and RSS return to zero after shortened idle deadline in both modes | PASS |
| Hidden/stalled viewers remain bounded and lose control | Real hidden-panel unwatch/read-only return; existing deterministic socket stalled-write and pressure tests | PASS |
| Authentication and sign-out | Real Local/VPS-style cookie and hostile-Origin checks; existing expired-session socket tests; VPS signout closes controller at 4401, stops capture, then timeout/idle returns Chrome to zero | PASS |
| Forced parent death retires owned browsers | SIGKILL with Chrome confirmed alive; owned Chrome processes reach zero; packaged desktop normal close also ends worker/Chrome | PASS |
| Popups/navigation dialogs/upload/download | Existing real Chromium adapter/file tests and production viewer fixture upload, Arabic dialog, authenticated download | PASS |
| IME and clipboard | Reused viewer: DOM composition committed exactly once; native Linux Ctrl+V; synthetic Cmd+V/AltGraph/Option default events | PASS within stated limits |
| Concurrent first launches share global recovery | Gated recovery spy: both profiles starting, no adapter launch until gate, one scan; two launches then replacement third launch without rescan | PASS |
| Corrupt/unreadable/deleted/renamed profiles, file ownership and credential boundaries | Existing full unit/packaging suites; Task 10 self-review only reviews Task 10 diff; whole-change review is archived with the final corrections | PASS tests and independent review |

The stalled-client proof deliberately uses the existing deterministic socket boundary: one blocked write and 99 subsequent synthetic frames produce only the first frame plus the latest pending frame (sequence 100). Frames over 1 MiB are rejected. Above 2 MiB socket buffered output, new frames are discarded; sustained pressure for 10 seconds disconnects. This is a reproducible backpressure test, not a claim that a modest low-byte fixture saturated a real TCP socket. The real hidden-viewer test proves unsubscribe/control revocation; reconnect never replays input.

## Task 10 results before whole-review corrections

| Command | Result |
| --- | --- |
| `npm run e2e:browser` | PASS: build +31 Local/VPS service checks +16 viewer checks |
| `node zumi-bot-server/e2e/browser.e2e.mjs` (final affected sign-out assertion) | PASS: 31 checks |
| `npm run typecheck` | PASS: every workspace |
| `npm test` | PASS: 132 files; 1,822 tests passed, 1 skipped; 33.89 s |
| `npm run build` | PASS, executed by browser alias and packaged desktop command; existing frontend chunk >500 kB advisory and Electron “renderer config is missing” configuration warning remain |
| `npx vitest run .../browserApplication.test.ts .../browserSocket.test.ts .../groupService.test.ts .../routineRunner.test.ts` | PASS: 4 files /170 tests; 5.88 s |
| `node zumi-bot-server/e2e/routines.e2e.mjs` | PASS: fake Claude routine/webhook/approval checks |
| `node zumi-bot-server/e2e/resilience.e2e.mjs` | PASS after stale palette expectation correction; 38.6 s |
| `node zumi-bot-server/e2e/auth.e2e.mjs` | PASS: synthetic VPS login/signout/draft recovery |
| `npm run e2e:desktop` | PASS: `electron-builder --linux --dir`, copied production runtime/MCP bridge, intercepted installer (no download/install), packaged Local browser and full shutdown |
| `node zumi-bot-server/e2e/browser-viewer.e2e.mjs` | PASS:16 checks, native Linux paste/DOM IME/files/dialogs included |
| `git diff --check` | PASS for Task 10 edits |

`e2e`/`web.e2e.mjs` and `e2e:group`/`group.e2e.mjs` use real Claude and were intentionally not run. Fake CLI group handoffs/contention and existing fake `groupService` tests cover the required paths without quota. The one skipped unit test is opt-in installed-Claude MCP integration. The explicit installer test intercepts its downloader and performs no network installation.

## Evidence-backed fix and assertion history

Acceptance assertions preceded the fake driver: `node .../browser.e2e.mjs` failed with ENOENT for missing `fake-browser-claude.mjs`, then passed after the driver was implemented. Fixture iterations corrected the WebSocket path/4401 auth contract and avoided awaiting a long-running `chats:send` before releasing its own test gate. A cap test initially checked after 300 ms and saw `stopped` before the fake CLI reached the queue; it now waits for the observable queued state.

Actual fast typing plus immediate release uncovered a product bug: 14 characters emit 42 down/text/up inputs. The transport rejected `releaseControl`/`unwatch` at the ordinary 16-pending-command threshold before cancelling queued typing. Socket closure aborted active input and retired the browser generation. Focused RED: both new tests failed `expected 3 to be 1` (closed instead of open). The narrow fix exempts only release/unwatch from the 16-command threshold. The absolute 128-pending bound, 120 inputs/second bound, other-command threshold, ordering and synchronous cancellation stay enforced. GREEN: complete socket suite and held-input regression pass; real quick-toggle scenarios preserve generation in both modes. The text-arrival assertion waits for its first synthetic text burst's ACKs, then a separate fresh burst is released immediately to keep the race covered.

The first existing resilience run failed its old `rgb(18,18,18)` dark-theme assertion. The pre-feature palette is already `#0e1013`; only the expected value and success label were corrected to `rgb(14,16,19)`. No production theme code changed; the affected suite then passed.

## Measured Chromium resources

Machine: Ubuntu 24.04.5 LTS, Linux 7.0.0-38-generic, x64, Intel(R) Core(TM) i5-10500 CPU @ 3.10GHz, 12 logical CPUs, 31986 MiB RAM. Runtime: Node v22.23.3 (V8 12.4.254.21-node.57), Google Chrome 156.0.8078.47, Playwright Core 1.64.1, Electron 45.0.0, MCP SDK 1.32.2.

Only Chromium descendants belonging to this test's agent workers are summed. The browser used to drive the app/viewer and all other applications are excluded. The collector follows worker descendants (Chrome has its own process group), retains PID/start identities across parent death, reads RSS with `ps`, and derives CPU from `/proc/<pid>/stat` ticks and `CLK_TCK`. Zero means zero owned Chromium processes, not zero Node/server memory. Summed process RSS can double-count shared mappings and is not proportional/unique resident memory.

| State | Chrome processes | Summed RSS MiB | CPU (% one core) | Sample ms |
| --- | ---: | ---: | ---: | ---: |
| local: zero browsers | 0 | 0.0 | 0.00% | 1544 |
| local: active unviewed | 10 | 976.7 | 5.83% | 1545 |
| local: active viewed | 10 | 1006.3 | 20.71% | 1545 |
| local: post idle zero | 0 | 0.0 | 0.00% | 1540 |
| vps: zero browsers | 0 | 0.0 | 0.00% | 1541 |
| vps: active unviewed | 10 | 973.5 | 4.53% | 1546 |
| vps: active viewed | 10 | 999.7 | 19.35% | 1550 |
| vps: post idle zero | 0 | 0.0 | 0.00% | 1541 |

These are short samples of one 1280×800 profile on a modest local HTML form with a background color change every 100 ms. The viewed state has two clients sharing one producer. The unviewed browser still runs page JavaScript. These measurements are host/load/page-specific; no hard RAM saving or RAM ceiling follows from two browsers/four tabs.

| Auth mode | Frames received | Window ms | Observed FPS | Bytes received | Largest encoded frame bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| local | 7 | 1100 | 6.36 | 90,332 | 12,952 |
| vps | 8 | 1100 | 7.27 | 103,118 | 12,952 |

Frame counts/bytes are from one real watcher, including the binary frame envelope; actual rate depends on page changes. Production limits remain 10 frames/second, JPEG ≤1 MiB plus ≤1,028 envelope bytes, at most one in-flight send plus one latest pending frame per watch, and a 2 MiB socket high-water check. Existing deterministic tests verify those bounds and sustained-pressure disconnect. No stream starts merely because the app/chat/card opens, and the measured no-viewer/post-idle cases have zero producers.

## Limits and deployment prerequisites

The acceptance suite shortens idle cleanup to 2,500 ms, handoff idle expiry to 3,000 ms, lease inactivity to 20,000 ms and queue timeout to 15,000 ms. Production defaults remain two browsers, four tabs, 120,000 ms idle/ownership inactivity, 600,000 ms unattended handoff, 30,000 ms command, 120,000 ms queue and 10 FPS. Unit tests cover defaults/fake-clock timeout mechanics. A live model waiting 10 minutes, the 24-hour CLI boundary, long-running service soak, native macOS clipboard/OS IME, and a native Linux OS IME were not proved. DOM IME and real Linux paste are proved; synthetic Cmd+V events do not establish macOS integration.

VPS-style auth was exercised on loopback with synthetic password/TOTP, not through a live VPS/TLS reverse proxy. No real profile, password, 2FA, VPS, `.deb` install, sudo or deployment was used. Before deployment: ship the complete built worker/bridge/Playwright artifacts, provide a supported sandbox-capable Chromium executable or perform the explicit approved runtime setup, and run `browser-check` as the service user. Preserve distinct per-environment profile storage and exclude profiles from sync/backups as previously reviewed. Installation/live deployment still requires repository-required permission.
