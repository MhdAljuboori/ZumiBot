# Agent Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each agent a persistent browser that works locally and on the VPS, with viewing only on user request and exclusive manual takeover.

**Architecture:** The backend owns lazy Chromium profiles and arbitrates browser work between turns and human controllers. A scoped MCP stdio bridge exposes tools to Claude; a separate authenticated WebSocket streams the same live page only to subscribed viewers. The shared React frontend implements the viewer and action-required cards; Electron remains a shell.

**Tech Stack:** Existing Node >=22, TypeScript, React 19, ws, Vitest, Playwright Core 1.64.1, Electron 45.0.0. Add backend runtime dependencies `playwright-core: 1.64.1` and `@modelcontextprotocol/sdk: 1.32.2`, pinned exactly; commit resolved transitive dependencies in the existing lockfile. Use the SDK's low-level Server and stdio transport with JSON-schema tool definitions.

**Spec:** [Approved agent-browser design](../specs/2026-10-27-agent-browser-design.md).

**Verification:** [Results, measurements and limitations](../verification/2026-10-27-agent-browser.md).

**Execution:** User selected subagent-driven execution. Tasks 1–10, whole-change review and final corrections are complete and independently approved. Final verification: 1,829 tests passed, one existing opt-in skip; typecheck and build passed. Each task has its own implementation and review gate.

## Global Constraints

- Local and VPS, including ordinary web clients; separate profiles between environments and agents.
- Streaming must happen **only when requested by the user**. No automatic viewer/stream from chat opening, agent work, or handoff cards.
- Take control off by default. Agent actions and observations pause before acknowledging human control.
- Defaults: 2 concurrent browsers, 4 tabs each, 2-minute idle shutdown, 2-minute ownership inactivity, 10-minute unattended handoff timeout, 30-second browser command timeout, 2-minute capacity/ownership queue timeout, at most 10 viewed frames/sec, viewport 1280 × 800.
- Persistent profile means disk state, not a permanently running process. No Chromium for startup or text-only chats; no frame history/recording.
- Respect existing CLI permissions, MCP configuration, and Zumi Bot deny rules. Preserve `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- Keep Chromium sandboxing enabled. Do not expose CDP publicly, relax existing CSP/preload boundaries, or forward credentials to chat/logs.
- Website memory varies; report measurements rather than asserting a hard RAM ceiling from process/tab counts.
- Do not install the `.deb`, change the live VPS, use sudo, or handle real password/2FA without the repository-required permission. Local source changes and synthetic tests are in scope.

## Review Focus

1. Closing/reopening a viewer during an in-flight takeover must not grant a stale connection control (Tasks 2, 5, 7).
2. A same-agent group turn and single-chat turn must never interleave observation/action sequences (Tasks 2, 6, 10).
3. Popups, redirects, dialogs, downloads, and input-method composition must not escape the browser service or hang takeover (Tasks 3, 8, 10).
4. Unreadable profiles, renamed/deleted agents, crashes, and sign-out during a pending handoff must preserve isolation and release resources (Tasks 1, 4, 5, 6, 9).
5. A stalled/hidden viewer must not accumulate frames, retain human control, or silently resume it on reconnect (Tasks 5, 7, 10).

## File structure and common interfaces

Keep browser code in focused modules under `backend/src/core/browser/`: `config.ts`, `profileStore.ts`, `types.ts`, `browserManager.ts`, `browserLeases.ts`, `browserHandoffs.ts`, `chromiumAdapter.ts`, `browserWorker.ts`, `workerAdapter.ts`, `browserTools.ts`, `browserCapabilities.ts`, `browserIpc.ts`, `browserBridge.ts`, `browserFiles.ts`, `browserRuntime.ts`, and `browserPrompt.ts`.

Shared wire types/validators live in `shared/src/browser.ts`. Browser WebSocket handling is `backend/src/http/browserSocket.ts`; use the existing HTTP server for its authenticated upgrade. The frontend gains `net/browser.ts`, `state/browserView.ts`, `components/BrowserPanel.tsx`, `components/BrowserActionCard.tsx`, `components/BrowserFiles.tsx`, and `useAgentBrowser.ts`.

Use these names across tasks (type declarations go in Task 1; implementations belong to their task):

- `BrowserConfig`: `maxBrowsers`, `maxTabs`, `idleMs`, `leaseIdleMs`, `handoffIdleMs`, `commandMs`, `queueMs`, `fps`, `width`, `height`, `executablePath: string | null`.
- `BrowserTarget = { agent: string; chatId?: string; requestId?: string }`; every target is resolved against actual agent/chat membership server-side. `BrowserOwner = { profileId: string; chatId: string; turnId: string }` is server-generated.
- `BrowserStamp = { generation: string; tabId: string; observationId: string }`. Browser generation changes on relaunch; observation ID changes on navigation, tab ownership change, or takeover. All element references require an exact stamp match.
- `BrowserStatus`: `agent`, `profileId`, `generation`, `state: 'stopped'|'queued'|'starting'|'ready'|'closing'|'unavailable'`, `tabs: { id: string; title: string; url: string }[]`, `activeTabId: string|null`, `control: 'agent'|'pausing'|'you'|'other'`, `pendingRequestId: string|null`, `error: string|null`. Construct `control` separately per viewer.
- `BrowserCommand` discriminated union uses `op`: `navigate(url)`, `back`, `forward`, `reload`, `tabs`, `newTab(url?)`, `selectTab(tabId)`, `closeTab(tabId)`, `observe`, `screenshot`, `click(stamp, ref)`, `type(stamp, ref, text)`, `scroll(deltaX, deltaY)`, `dialog(accept, text?)`, `upload(stamp, ref, fileIds)`, `release`, `requestUserAction(reason)`. Fields in parentheses are properties, not positional wire arguments. Strings/arrays/coordinates have explicit bounds in validators.
- `BrowserResult = { ok: true; data: unknown } | { ok: false; code: string; message: string }`; validated observations contain a stamp and bounded element references. Private filesystem paths and capabilities never appear in results.
- `BrowserInput`: typed mouse down/up/move/wheel, key down/up, and committed text events. Include browser generation and tab ID on every viewer command. Keyboard composition sends committed text once, rather than replaying raw composition keystrokes.
- `BrowserHandoff`: immutable `id`, `profileId`, `generation`, `chatId`, `turnId`, `site`, `reason`, `createdAt`; mutable `agent` display metadata and `status: 'pending'|'done'|'cancelled'|'expired'|'interrupted'`. Persist as `ChatItem.type = 'browser-action'` with `id`, `ts`, `agent`, optional live `turn`, and `handoff`. `handoff.turnId` survives group unstamp.
- `BrowserAdapter.launch(profileDir: string, config: BrowserConfig): Promise<BrowserInstance>`; instances expose `execute(command: BrowserCommand, signal: AbortSignal): Promise<BrowserResult>`, `startFrames(onFrame: (frame: BrowserFrame) => void): Promise<void>`, `stopFrames(): Promise<void>`, `onChanged(cb): () => void`, `close(): Promise<void>`. Manager handles lease/handoff/release commands before adapter dispatch. `BrowserFrame = { generation: string; tabId: string; sequence: number; width: number; height: number; jpeg: Uint8Array }`.
- `BrowserManager`: `status(agent: string): Promise<BrowserStatus>`; `run(owner, command, signal): Promise<BrowserResult>`; `watch(target, viewer): Promise<BrowserSubscription>`; `takeControl(viewerId): Promise<void>`; `releaseControl(viewerId): Promise<void>`; `input(viewerId, input): Promise<void>`; `navigate(viewerId, command): Promise<BrowserResult>`; `answer(viewerId, requestId, decision: 'done'|'cancel'): Promise<void>`; `endTurn(turnId): Promise<void>`; `clear(agent): Promise<void>`; `renameAgent(from,to): Promise<void>`; `removeAgents(names): Promise<void>`; `close(): Promise<void>`.
- `BrowserViewer = { id: string; sessionKey: string; sendStatus(status: BrowserStatus): void; sendFrame(frame: BrowserFrame): void }`; `BrowserSubscription.close(): Promise<void>`. Only the server creates viewer IDs. Read-only `BrowserApi.status(agent): Promise<BrowserStatus>` and `clear(agent): Promise<void>` use ordinary RPC; viewing, control, input, navigation, and handoff answers use the browser socket with caller identity. Answer-only socket messages can resolve a card without subscribing to frames.

## Task 1: Profile storage, configuration, and protocol validation

**Files:** Create shared `src/browser.ts`, `tests/browser.test.ts`; backend `src/core/browser/{config,profileStore,types}.ts`, `tests/core/{browserConfig,browserProfileStore}.test.ts`. Modify `backend/src/config.ts`, `shared/src/types.ts`, `frontend/src/net/api.ts`, `backend/src/rpc/handlers.ts` when adding the optional browser API seam.

**Interfaces:** `loadBrowserConfig(env: NodeJS.ProcessEnv): BrowserConfig`; `BrowserProfileStore(dataDir, newId)` with `load()`, `ensure(agent): Promise<{id:string;dir:string}>`, `renameAgent(from,to)`, `detachAgents(names)`, `agents(): string[]`, `replace(agent)`; all mutation methods return Promises. Validators `parseBrowserCommand(value: unknown): BrowserCommand`, `parseBrowserInput(value: unknown): BrowserInput` reject unknown operations and oversized fields. `safeBrowserSite(url: string): string` returns an origin-only label.

- [x] Write failing tests asserting distinct agent profile IDs, stable ID after reload/rename, fresh ID after delete/recreate, rename collision rejection, atomic writes, private directory/file modes (0700/0600), and no overwrite after EACCES/corrupt state. Reject path traversal, non-finite coordinates, unsupported URL schemes, URL credentials, and oversized input; `safeBrowserSite('https://x.test/a?secret=1#token') === 'https://x.test'`.
- [x] Run `npx vitest run zumi-bot-server/shared/tests/browser.test.ts zumi-bot-server/backend/tests/core/browserConfig.test.ts zumi-bot-server/backend/tests/core/browserProfileStore.test.ts`; confirm missing implementation failures.
- [x] Implement the named interfaces using atomic persistence and opaque UUID directories. Parse `ZUMIBOT_BROWSER_MAX_BROWSERS`, `MAX_TABS`, `IDLE_MS`, `LEASE_IDLE_MS`, `HANDOFF_IDLE_MS`, `COMMAND_MS`, `QUEUE_MS`, `FPS`, `WIDTH`, `HEIGHT`, `EXECUTABLE_PATH` with the common prefix on every name; validate positive bounded integers, fps <=10, viewport <=1920×1080. Errors name the variable, not its raw value. Default values match Global Constraints. Keep status queries lazy.
- [x] Run those tests plus `npm run typecheck`; expect all passing. Update existing typed API fakes when adding contract methods, without giving fakes launch side effects.
- [x] Commit the protocol/storage/configuration slice and its tests.

## Task 2: Lazy browsers, turn leases, takeover, and handoff lifecycle

**Files:** Create backend `src/core/browser/{browserManager,browserLeases,browserHandoffs}.ts`, `tests/core/{browserManager,browserLeases,browserHandoffs}.test.ts`, `tests/support/fakeBrowser.ts`.

**Interfaces:** Implement `BrowserManager` against the Task 1 adapter contract. Constructor dependencies are `profiles`, `adapter`, `config`, `now`, `newId`, `resolveTarget(target): Promise<profile>`, `onHandoff(handoff): Promise<void>`, and injectable timers. `BrowserHandoffs.request(owner, generation, site, reason, signal): Promise<BrowserResult>` and `answer(requestId, profileId, generation, decision): Promise<void>` back manager methods. A manager callback may be registered per turn for persistence in Task 6.

- [x] Write failing tests with fake timers: zero launches at construction/status; concurrent watch/run for one profile launches once; three agents never exceed two live/launching/closing slots; fifth tab rejected; idle closes at 120000 ms and preserves profile directory; queued acquisition expires at 120000 ms; cancelled requests never launch later.
- [x] Add ownership tests: two turns for one profile serialize multi-command work; inactivity releases after 120000 ms; manual takeover waits for the current command, blocks subsequent agent operations/observations, and invalidates refs on release. Late takeover acknowledgments after viewer close do not assign control. Different profiles progress independently.
- [x] Add handoff tests: pending request creates zero frame producers; done/cancel resolve once; unattended request expires at 600000 ms; visible viewing suspends that inactivity timer; ending a turn interrupts requests/releases waiters; answer requires exact profile/generation/request; clear-data and removal invalidate stale operations.
- [x] Run `npx vitest run zumi-bot-server/backend/tests/core/browserManager.test.ts zumi-bot-server/backend/tests/core/browserLeases.test.ts zumi-bot-server/backend/tests/core/browserHandoffs.test.ts`; expect initial failure.
- [x] Implement the manager, FIFO queues, per-profile leases and control barriers. Expire idle owners without cancelling active commands/handoffs. Prioritize safe idle eviction at capacity. Abort overdue commands and invalidate their page before granting takeover if completion cannot be established. Handoff waiting is excluded from the 30-second browser command timer. Expose lifecycle counters for test instrumentation, never website content.
- [x] Run those tests and backend typecheck; expect passing. Commit the lifecycle slice.

## Task 3: Real Chromium adapter and process ownership

**Files:** Create backend `src/core/browser/{chromiumAdapter,browserWorker,workerAdapter,browserRuntime}.ts`, `tests/core/{chromiumAdapter,workerAdapter,browserRuntime}.test.ts`; add `e2e/fixtures/browser-site.mjs`. Modify backend `package.json`, root `package-lock.json`, and backend `vite.config.ts` to emit the worker and ship its runtime.

**Interfaces:** `createChromiumAdapter(): BrowserAdapter` implements the adapter inside a worker; `createWorkerAdapter(runtime: BrowserRuntime): BrowserAdapter` is used by the manager. `BrowserRuntime = { node: string; workerEntry: string; bridgeEntry: string; playwrightDir: string; executablePath: string|null; electronNode: boolean }`; `resolveBrowserRuntime(): BrowserRuntime` works from source builds and packaged artifacts.

- [x] Write adapter tests for tab/popup limits, stamped element references, stale reference rejection, operation timeouts, dialogs that do not deadlock the command queue, and screencast start/stop. Worker tests assert EOF/parent disappearance closes Chromium, errors propagate without secrets, process exit frees capacity only after teardown, and unrelated browser processes are never killed.
- [x] Run `npx vitest run zumi-bot-server/backend/tests/core/chromiumAdapter.test.ts zumi-bot-server/backend/tests/core/workerAdapter.test.ts zumi-bot-server/backend/tests/core/browserRuntime.test.ts`; confirm missing implementation failures.
- [x] Add the exact Playwright runtime dependency and implement persistent headless Chromium with `chromiumSandbox: true`, fixed viewport, private profile directory, and tracked pages. Use CDP page screencast and input APIs; do not launch capture in `launch()`. Observe through bounded accessibility/DOM descriptions with role/name/text and ephemeral server-generated element refs; limit observation text to 32000 characters and images to existing inline-image byte limits. Password values are never included in observations.
- [x] Emit a small browser worker per live profile. It owns Chromium, watches parent IPC disconnection, and closes on EOF/signals. Parent has bounded graceful/forced cleanup; stale-process recovery verifies PID start identity and owned profile path before termination. Pass `ELECTRON_RUN_AS_NODE=1` only when spawning the worker/bridge under Electron; the normal Claude environment remains scrubbed.
- [x] Copy the complete `playwright-core` package into `dist/node_modules/playwright-core` and externalize it from the Vite server/worker bundles. Bundle worker support code; tests must import from a temporary artifact outside repository module resolution. A missing binary is an unavailable browser result, not a server startup failure.
- [x] Run the adapter tests, backend build, and a real-Chromium fixture smoke: navigate, observe/click, cookie persistence after close/relaunch, isolated profiles, dialog, popup, and capture only after subscription. Report sandbox/missing-browser prerequisites explicitly; do not disable sandboxing to pass.
- [x] Commit the adapter/runtime slice.

## Task 4: Scoped MCP bridge and bounded human waits

**Files:** Create backend `src/core/browser/{browserCapabilities,browserIpc,browserTools,browserBridge,browserPrompt}.ts`, `tests/core/{browserCapabilities,browserIpc,browserBridge}.test.ts`; modify backend `package.json`, root lockfile, and `vite.config.ts` for the bridge entry.

**Interfaces:** `BrowserCapabilities.issue(owner): {token:string;revoke():void}`, `resolve(token): BrowserOwner|null`; `serveBrowserIpc({manager,capabilities,socketPath}): Promise<{close():Promise<void>}>`; `createBrowserTurn(owner, onHandoff): Promise<{args:string[];env:NodeJS.ProcessEnv;prompt:string;dispose():Promise<void>}>`. Tool registration maps `browser_<operation>` to the Task 1 commands, including `browser_request_user_action` and `browser_release`.

- [x] Write failing tests using an SDK stdio client: initialization/tool discovery launches no Chromium; unknown/revoked capabilities and cross-agent IDs fail; malformed/oversized IPC input fails; cancellation and stdin EOF abort pending calls; progress does not expose content; environment values never appear in argv/logs/results. Test tool requests through the real bridge subprocess to a fake manager.
- [x] Run `npx vitest run zumi-bot-server/backend/tests/core/browserCapabilities.test.ts zumi-bot-server/backend/tests/core/browserIpc.test.ts zumi-bot-server/backend/tests/core/browserBridge.test.ts`; expect failures.
- [x] Add SDK 1.32.2 exactly. Implement a private Unix socket with mode 0600 and a 0700 parent directory; use a short random runtime directory to avoid Unix socket path limits, removed on shutdown. Authenticate once per bridge connection using a random per-turn capability. Track bounded request IDs, cancellation, and connection cleanup. Browser IPC never accepts a caller-selected owner/profile.
- [x] Configure the injected MCP server as `zumibot_browser`, using an absolute bridge entry and inherited `ZUMIBOT_BROWSER_CAPABILITY`/`ZUMIBOT_BROWSER_IPC`. Add server-scoped `timeout: 86400000` (24-hour transport ceiling); keep app-owned 30-second command, 2-minute queue, and 10-minute unattended handoff limits. Emit non-sensitive progress every 30 seconds only while a requested wait is pending. On transport cancellation, expire/interupt the request and release its waiters. Leave background tasks disabled. Merge into existing MCP config with `--mcp-config`; do not set strict MCP mode.
- [x] Add the browser-use prompt separately from house style. No raw credential requests, no system-browser fallback, fresh observation after takeover, release after use. Inject the installed CLI's `--no-chrome` option to avoid its separate Chrome integration competing with the app browser; preserve unrelated MCP configuration. Ensure CLI session resumes and retries receive new capabilities and revoke the old attempt's capability.
- [x] Run bridge tests and build the bridge. Check the installed CLI can discover the injected server/config without a model request; verify timeout/background settings against the linked Claude docs and fixture cancellation tests. If live CLI timing cannot be proven without a real model call, document that acceptance limitation rather than claiming it passed.
- [x] Commit the bridge slice.

## Task 5: Authenticated on-demand streaming and input transport

**Files:** Create backend `src/http/browserSocket.ts`, `tests/http/browserSocket.test.ts`; modify `src/http/server.ts`, `src/auth/guard.ts`, `src/app.ts`, `tests/http/helpers.ts` and `tests/auth/guard.test.ts` for the browser hub seam. Add wire message types in shared `src/browser.ts`.

**Interfaces:** `createBrowserHub({manager,isValid,now}): BrowserHub`; `BrowserHub.attach(ws,sessionKey)`, `closeSession(key|'all')`, `drain()`, `closeAll(code)`, `dispose()`. Upgrade path `/ws/browser` uses the same Gate/session key as `/ws`. Client messages are request envelopes with `id`, `op`, and validated fields for `watch`, `unwatch`, `takeControl`, `releaseControl`, `input`, `navigate`, `answer`; server sends response/status/frame envelopes. Frame binary encoding includes bounded metadata followed by JPEG bytes.

- [x] Write failing tests for Local cookie/VPS session auth, bad Origin, expired sessions, sign-out revocation, fabricated controller IDs, stale generations/tabs, unauthorized agent/chat targets, input outside viewport, and navigation without control. Answer-only calls resolve cards without acquiring a frame subscription.
- [x] Add resource tests: opening the socket alone captures nothing; two subscribers share one producer; final unwatch stops it immediately; slow viewers retain at most one queued frame; >2 MiB socket buffered bytes drops frames and sustained pressure disconnects. Reject >64 KiB command messages; cap input at 120 events/sec per viewer, close abusive senders; coalesce mouse moves/wheel events. Throttle forwarded frames to 10 fps and cap individual JPEGs at 1 MiB.
- [x] Run `npx vitest run zumi-bot-server/backend/tests/http/browserSocket.test.ts`; confirm failures.
- [x] Implement the hub with server-generated connection IDs, 10-second ping/heartbeat and revocation after two missed heartbeats. Revalidate sessions before granting control/answering handoffs, and periodically for viewers. Compose chat and browser revocation in auth wiring, retaining the current chat hub interface to other callers.
- [x] Run browser socket/auth/HTTP tests and typecheck. Commit transport changes.

## Task 6: Agent turn, chat persistence, rename, and routine integration

**Files:** Modify backend `src/app.ts`, `src/core/chat/{chatService,claudeRunner,groupService,seedPrompt}.ts`, `src/core/store/chatStore.ts`, `src/rpc/handlers.ts`, `src/core/agents/agentsSync.ts`, `src/core/routines/routineRunner.ts`, shared `src/types.ts`, and frontend `src/state/chatView.ts`/`src/net/api.ts`. Extend their existing tests.

**Interfaces:** Add optional `ChatServiceDeps.browserTurns` with `create(owner,onHandoff)` returning Task 4's turn handle. Give every CLI attempt a unique turn capability ID, including single chats and expired-session retries. Add `TurnSlot.browserPending: Set<string>` and include it in aggregate waiting count while preserving permission-only handling for `chats:answer`.

- [x] Write failing tests: text-only turn does not launch Chromium; merged runner environment retains PATH and browser scope but excludes app secrets; tools injected for group members, not moderator; house-style toggle does not remove browser instructions; stop/failure/retry revokes the correct capability. Handoff updates append through the current `ItemsRef`, do not overwrite concurrent group messages, and contribute to routine waiting state.
- [x] Add tests for pending card recovery after restart, safe card seed serialization, rename during a live browser turn, file deletion/recreation, and startup reconciliation when an agent file is malformed. Explicit clear requires an existing agent and closes its browser before changing identity; old viewers/requests are invalid afterward.
- [x] Run `npx vitest run --project backend -t 'browser|handoff'`; confirm the new assertions fail before integration.
- [x] Wire manager/IPC/turn handles in `app.ts`. Fix environment merging at the run wrapper. Persist card changes through each turn's existing save/push mechanism; store recovery marks pending browser cards interrupted. Extend rename paths before watcher removal and include profile names in startup reconciliation; detach deleted profiles without hard-deleting orphaned data.
- [x] Add `browsers:status`/`browsers:clear` RPC mappings. Await browser stop/stream drain during server shutdown before releasing locks; cover startup rollback too. Update group unstamp/seed handling to preserve immutable handoff identity without treating cards as tool permission requests.
- [x] Run affected chat/group/store/sync/routine/API tests and `npm run typecheck`; expect passing. Commit application integration.

## Task 7: Viewer, Take control, and in-chat browser cards

**Files:** Create frontend `src/net/browser.ts`, `src/state/browserView.ts`, `src/useAgentBrowser.ts`, `src/components/{BrowserPanel,BrowserActionCard}.tsx`, `tests/net/browser.test.ts`, `tests/browserView.test.ts`. Modify `src/App.tsx`, `src/styles.css`, `src/components/{ChatView,MessageList,AgentIntro,AgentEditor,NewChatView}.tsx` as needed, and shared API fakes.

**Interfaces:** `createBrowserClient({url,makeSocket,onStatus,onFrame}): BrowserClient` exposes `watch(target)`, `unwatch()`, `takeControl(on)`, `input(input)`, `navigate(command)`, `answer(requestId,decision)`, `close()`. `BrowserViewState` holds `target`, `open`, `expanded`, `visible`, `status`, `controlPending`, and connection generation; `reduceBrowserView(state,event)` resets manual input on any disconnect/unwatch/generation change. `useAgentBrowser` owns the single app-wide client/viewer and frame disposal.

- [x] Write failing pure-state/socket tests: initial UI/chat/card mount sends no watch; explicit Open Browser subscribes; hidden/unmounted/switched view unsubscribes; reconnect returns read-only; stale take-control ack cannot re-enable input; failed control request retains observer mode. Frame decode completion from an old tab is discarded and object URLs/bitmaps are disposed.
- [x] Run `npx vitest run zumi-bot-server/frontend/tests/net/browser.test.ts zumi-bot-server/frontend/tests/browserView.test.ts`; expect failures.
- [x] Implement socket lifecycle with the shared auth-close behavior and no replay of input after reconnect. Add responsive resizable panel, agent selector for groups, tabs/URL/status/navigation, expand/close, and an accessible Take control switch with Pausing agent…/You have control/Controlled in another window labels. Pointer scaling must account for letterboxing; forward keyboard shortcuts only when the page surface is focused and owned. Preserve app shortcuts and stop browser keypresses reaching the chat composer.
- [x] Add Open Browser to agent/single-chat entry points and member selection for groups. Render action cards with no automatic preview; opening expands the one shared viewer. Done/Cancel use answer-only socket requests when necessary. Add confirmed Clear browser data in agent settings. Display capacity, missing-runtime, expired/interrupted handoff, and connection errors inline.
- [x] Run frontend tests/typecheck and a built-app fixture UI check at desktop and narrow widths; verify keyboard focus, toggle defaults, close/reopen, and no automatic stream. Commit viewer integration.

## Task 8: Web dialogs and bounded browser file transfers

**Files:** Create backend `src/core/browser/browserFiles.ts`, `tests/core/browserFiles.test.ts`; frontend `src/components/BrowserFiles.tsx`. Modify browser command/socket validators, Chromium adapter, existing attachment store/HTTP route seams, BrowserPanel, and their tests.

**Interfaces:** `BrowserFiles.stageDownload(owner, source, name): Promise<{id:string;name:string;size:number}>`, `resolveUpload(owner,fileIds): Promise<string[]>`, `discardTurn(turnId): Promise<void>`. Only server-internal code receives filesystem paths. Viewer uploads carry staged attachment IDs; agent uploads may use attachments explicitly attached to its chat. Staged manual uploads bind to profile/generation/viewer and cannot be reused by another profile.

- [x] Write failing tests: hostile download filename cannot escape staging; >25 MiB transfer aborts during streaming; per-profile staging capped at 100 MiB/10 files; upload rejects arbitrary paths and another profile's IDs; partial transfers disappear on abort; downloads need authentication and expire after 1 hour or restart. No frame/control subscription is granted by a download request.
- [x] Run `npx vitest run zumi-bot-server/backend/tests/core/browserFiles.test.ts`; expect failures.
- [x] Implement bounded streaming transfers using the existing attachment limits and safe-name approach. Enforce limits while bytes arrive, not only after download completes. Provide authenticated download links and a native file picker in the app for site upload controls. Integrate alert/confirm/prompt/file-chooser UI with exclusive control; pending dialogs block only the affected operation and remain resolvable during takeover.
- [x] Run file/attachment tests and Chromium fixture UI cases for upload, download, dialog, popup, and Unicode/Arabic text composition. Commit file/dialog support.

## Task 9: Install/check commands, packaged artifacts, and operating documentation

**Files:** Modify backend `src/cli.ts`, `vite.config.ts`, `src/core/browser/browserRuntime.ts`, `tests/{cli,deploy}.test.ts`, root `package.json`, desktop `electron-builder.yml`, `e2e/local.e2e.mjs`, `README.md`, and server `deploy/SETUP-VPS.md`. Create backend `tests/browserPackaging.test.ts`.

**Interfaces:** `zumibot-server browser-check` checks runtime assets, executable and an ephemeral sandboxed launch; `browser-install` explicitly invokes the shipped pinned Playwright CLI to install Chromium into `<dataDir>/browser-runtime`, without sudo. `ZUMIBOT_BROWSER_EXECUTABLE_PATH` overrides that managed binary. Setup/check processes never use real agent profiles or start the normal app server.

- [x] Write failing packaging tests that copy the artifact outside the repo and run the bridge, worker, and check command without repository node_modules/PATH assumptions. Verify missing binary gives a useful error while serve/text chat still works; a missing OS dependency never triggers automatic installation; paths with spaces work. Verify parent termination closes the browser process tree in the packaged runtime.
- [x] Run `npx vitest run zumi-bot-server/backend/tests/browserPackaging.test.ts zumi-bot-server/backend/tests/cli.test.ts`; expect initial failures for new commands.
- [x] Add CLI routing/help and explicit setup commands. Document Chromium download/disk needs, OS library setup by the operator, sandbox requirements, all resource variables, profile location, separate Local/VPS sign-ins, idle state loss, and default two-slot behavior. Package runtime/worker/bridge with `dist`; deployment already rsyncs the whole directory. Desktop includes the same artifact and does not download on startup.
- [x] Run `npm run build`, packaging tests, and `npm run e2e:desktop` in the allowed environment. Do not run install/deploy commands against the user's installed app/VPS. Commit packaging/docs.

## Task 10: End-to-end acceptance, performance evidence, and whole-change review

**Files:** Create `zumi-bot-server/e2e/browser.e2e.mjs`, `zumi-bot-server/backend/tests/fixtures/fake-browser-claude.mjs`, `docs/superpowers/verification/2026-10-27-agent-browser.md`; modify root `package.json` to add `e2e:browser` and reuse `e2e/harness.mjs` without requiring real Claude messages.

**Interfaces:** E2E fake Claude invokes the actual MCP bridge using injected args/env and emits compatible stream-json, so tests cover CLI plumbing without paid/model-driven browser actions. Local fixture website supplies synthetic login, cookie check, navigation, delayed actions, popup, dialog, upload, and download pages.

- [x] Write acceptance assertions before completing the feature: unseen agent work has zero screencasts; opening viewer shows the same page/tab; takeover blocks agent action and observation; manual input updates that page; release refreshes refs before agent continuation; handoff done/cancel/timeout works in single/group/routine runs; restart retains cookies but interrupts old cards; second agent has no first-agent cookies.
- [x] Add multi-client/memory cases: two watchers one producer, close/hidden last watcher zero producers, stalled viewer bounded queue, two-browser cap with a queued third, two chats sharing one agent serialize correctly, idle cleanup returns browser process count to zero, and sign-out/forced parent exit frees controller/processes. Run Local and VPS-style fixture auth without touching the live VPS.
- [x] Run `npm run e2e:browser`; fix only evidence-backed failures. Then run `npm run typecheck`, `npm test`, `npm run build`, relevant existing group/routine/resilience suites, and packaged desktop acceptance. Distinguish existing suites that use real Claude; do not silently spend quota on them when fake-browser fixtures cover the needed path.
- [x] Measure and record Chromium process-tree RSS and CPU for zero browsers, active-unviewed, active-viewed, and post-idle cleanup, alongside test machine/runtime versions. Record frame rate/bytes and bounded buffers; avoid reading personal profiles or logging fixture credentials.
- [x] Run whole-change review with focus on all five Review Focus items, including actual-diff verification of no automatic capture, generation checks, cleanup, and credential redaction. Address findings and rerun only affected checks; list any unavailable environment-dependent checks honestly.
- [x] Update plan checkboxes and verification notes, commit completed work, and hand over the feature with test evidence and deployment prerequisites. Installation/live deployment still needs the repository-required permission.


## Self-review and execution handoff

### Named regression anchors

These are the smallest required regression examples for the tasks above, in addition to their listed cases. Fixture variables are local test setup owned by that task, not new production interfaces; use the existing Vitest/Playwright harness patterns. `vi` is Vitest's fake clock/mock API; E2E uses Node's strict `assert`.

```ts
// Task 1 — shared/tests/browser.test.ts
it('keeps credentials and query tokens out of handoff site labels', () => {
  expect(safeBrowserSite('https://x.test/a?secret=1#token')).toBe('https://x.test')
})

// Task 2 — backend/tests/core/browserManager.test.ts (adapter is the injected fake)
it('does not launch a browser for a status query', async () => {
  await manager.status('researcher')
  expect(adapter.launch).not.toHaveBeenCalled()
})

// Task 3 — backend/tests/core/workerAdapter.test.ts
it('closes an owned browser when the parent IPC connection ends', async () => {
  parentConnection.destroy()
  await workerExited
  expect(await ownedBrowserPidExists()).toBe(false)
  expect(await unrelatedBrowserPidExists()).toBe(true)
})

// Task 4 — backend/tests/core/browserCapabilities.test.ts
it('revokes a completed turn capability', () => {
  const issued = capabilities.issue(owner)
  expect(capabilities.resolve(issued.token)).toEqual(owner)
  issued.revoke()
  expect(capabilities.resolve(issued.token)).toBeNull()
})

// Task 5 — backend/tests/http/browserSocket.test.ts
it('stops capture when the final watcher leaves', async () => {
  await first.watch(target)
  await second.watch(target)
  expect(capture.activeProducerCount()).toBe(1)
  await first.unwatch()
  expect(capture.activeProducerCount()).toBe(1)
  await second.unwatch()
  expect(capture.activeProducerCount()).toBe(0)
})

// Task 6 — backend/tests/core/chatService.test.ts
it('marks a routine waiting while its browser handoff is pending', async () => {
  await emitBrowserHandoff(pendingHandoff)
  expect((await routineStore.snapshot()).runs[routineId][0].status).toBe('waiting')
  await resolveBrowserHandoff('done')
  expect((await routineStore.snapshot()).runs[routineId][0].status).toBe('running')
})

// Task 7 — frontend/tests/net/browser.test.ts
it('never replays manual input after reconnect', async () => {
  await client.watch(target)
  await client.takeControl(true)
  disconnectAndReconnect()
  await flushSocketEvents()
  expect(sentSinceReconnect.filter(m => m.op === 'input')).toEqual([])
  expect(latestStatus.control).not.toBe('you')
})

// Task 8 — backend/tests/core/browserFiles.test.ts
it('rejects a file staged for another profile', async () => {
  const file = await files.stageDownload(ownerA, downloadStream, 'report.txt')
  await expect(files.resolveUpload(ownerB, [file.id])).rejects.toThrow()
})

// Task 9 — backend/tests/browserPackaging.test.ts
it('keeps text serving available when Chromium is missing', async () => {
  const result = await runIsolatedArtifact({ executablePath: '/missing/chromium' })
  expect(result.serverStarted).toBe(true)
  expect(result.browserStatus.state).toBe('unavailable')
  expect(result.childBrowserCount).toBe(0)
})

// Task 10 — e2e/browser.e2e.mjs (instrumentation is test-only)
assert.equal(await instrumentation.screencastCount(), 0)
await page.getByRole('button', { name: 'Open Browser', exact: true }).click()
await waitForLiveFrame(page)
assert.equal(await instrumentation.screencastCount(), 1)
await page.getByRole('button', { name: 'Close browser', exact: true }).click()
await waitForNoScreencasts()
assert.equal(await instrumentation.screencastCount(), 0)
```

Coverage checked: lifecycle/resource policy (1–3), scoped tools (4,6), authenticated viewing (5,7), handoffs and groups/routines (2,6,7), files/dialogs (3,8), runtime packaging and cleanup (3,9), and measured Local/VPS acceptance (10). Public interface names above are shared by the tasks; protocol additions are validated at both IPC and viewer boundaries. The work is one integrated feature, so these are sequential tasks in one plan rather than independently deployed subsystems.

Recommended execution: **Native**, implementing tasks in this session, followed by independent whole-change review. Browser lifecycle, tools, transport, and UI share tightly coupled ownership/generation interfaces, so a single implementer reduces handoff churn. Subagent-driven execution remains an option if the user wants independent per-task implementation/review.

The user approved the design and selected subagent-driven execution after reviewing this plan. Planning changed documentation only; implementation follows the task review gates above.

## References checked during planning

- [Claude MCP tool timeouts and backgrounding](https://code.claude.com/docs/en/mcp#time-limits-on-mcp-tool-calls): per-server timeout is a hard ceiling; progress cannot extend it. Retain the app's existing background-task disable setting.
- [MCP cancellation/timeouts](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#timeouts): bound requests and propagate cancellation.
- [Published SDK metadata](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.32.2): pinned SDK and Node compatibility.
- [Playwright persistent Chromium](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context): persistent directory and explicit Chromium sandbox setting. Also inspected the repository's installed Playwright 1.64.1 types and current Claude CLI `--help`.
