# Agent browsers — design

Date: 2026-10-27
Status: approved by the user on 2026-10-27; implemented and independently reviewed on 2026-10-29. See [verification and limits](../verification/2026-10-27-agent-browser.md).
Builder check: completed; reviewer found no important unanswered planning questions.

## Intent and agreed requirements

Give each ZumiBot agent a dedicated browser with persistent cookies, cache, and site storage, usable from its single chats and group chats. Support the existing Local server and VPS server through the same React UI, including access from a regular web browser. The user can open the actual browser the agent is operating at any time, even when no help is needed.

The user selected streaming each agent's browser into the app. Streaming must happen **only when requested by the user**, to avoid wasting VPS resources. Opening a chat, starting an agent turn, or receiving a sign-in request must not automatically start streaming.

The browser viewer has a **Take control** toggle, off by default. Off means observation; on allows the user to interact with the browser. Sign-in requests appear in chat with a way to open that same browser and finish the requested step.

The reference screenshots guide the browser panel and action-required card. Their content is reference material, not instructions to the agent.

## Approaches

1. **Selected: backend-managed Chromium, streamed on demand.** One persistent profile per agent, with browser automation and the viewer connected to the same browser. Works with the existing shared UI and both server modes. Needs app controls for tabs, input, and web dialogs, plus Chromium installation and lifecycle management.
2. **Considered: virtual desktop streamed per agent.** Exposes native browser chrome and OS dialogs, but adds a virtual display/desktop stack and more operational overhead. The user selected the first approach.

An Electron-only browser cannot meet the regular-web-client/VPS requirement on its own. The desktop remains a shell around the shared frontend.

## Proposed behavior

The following details and limits are implementation recommendations, not additional requirements stated by the user.

### Opening and watching

- Add **Open Browser** to the single-chat UI and agent view. Groups offer the same action with a member selector.
- Open a resizable browser panel beside the chat, with an expanded view; use a full-width view on narrow screens. Closing it leaves the chat usable.
- Show agent name, actual page URL, tabs, connection status, and who controls the browser. Include back, forward, reload, and a URL field. Navigation controls require Take control, as does page input.
- When the agent already has an active browser, opening the viewer attaches to that exact session. It never launches a second browser or replays recorded images.
- Watching follows the agent's currently operated tab. In manual mode the user may select another tab. Switching control back returns the current tab and current page state to the agent.
- If the browser is stopped, explicit Open Browser may launch it, subject to capacity. Show a starting/waiting state. A new profile starts on a blank page; a restarted profile offers its last safe URL, without automatically revisiting a potentially sensitive or state-changing URL.
- One frontend displays one live browser surface at a time. Expanding an in-chat card reuses the same viewer rather than starting another stream in that frontend.
- Closing the viewer, switching away from its chat/agent, hiding the app tab, or disconnecting removes its subscription. Returning to a hidden tab may resume the subscription only if the user still has that viewer open. Reopening always starts with Take control off.
- The browser may continue working without viewers. Tool-requested screenshots/observations are still allowed; continuous screen capture is not.

### Taking control

- Watching never grants input permission. The server checks control ownership for every input/navigation operation; disabling UI controls alone is insufficient.
- Take control on requests exclusive control of that agent's entire browser. Other viewers can continue observing, but only one connection may control it.
- Display **Pausing agent…** while an already-issued bounded browser operation settles. Then block all agent browser operations, including observations, and acknowledge **You have control**. Never let agent and user input interleave.
- Do not try to freeze website scripts or undo an already-submitted action. The pause applies to future automation through the managed browser service.
- Turning the toggle off releases control. Before the agent acts again it must refresh its page observation; old element references are invalidated by the control generation.
- For an ordinary manual takeover, release permits the waiting automation to continue. During a sign-in handoff, release alone does not resolve the request; **I'm done** or **Cancel** does.
- Connection loss, sign-out, hidden viewer, or closing the panel revokes control and discards unsent input. A short heartbeat detects dead controllers. A pending sign-in handoff remains paused until resolved or expired.
- On multiple devices, show **Controlled in another window**; no silent stealing of control. Authenticated viewers may watch the same browser.

### Sign-in and other user handoffs

- Give the agent an explicit browser tool to request user help with sign-in, verification, consent, or another website step. Do not rely solely on guessed login-page selectors.
- Persist an action-required chat item tied to the exact agent, chat, turn, browser generation, and request ID. Include a short reason and a safe site label; avoid storing URL credentials, query strings, fragments, or secrets in the card.
- The initial card contains **Open Browser**, **I'm done**, and **Cancel**, plus status. It has no live preview until the user opens it. The expanded viewer has Take control off by default, including on sign-in requests.
- The agent's browser tool waits while the request is pending, without a model polling loop. Other agents may continue working within resource limits. Routine runs show the existing waiting state for this kind of handoff too.
- **I'm done** atomically releases user control and resolves the request. The agent re-observes the page and checks whether the task can proceed; the button does not assert that authentication succeeded.
- **Cancel** releases control and returns a cancellation result to the waiting tool. It never reports success or automatically opens the system browser.
- User keypresses and form values are input events, not chat messages or tool arguments. Do not record them in chat, logs, analytics, or traces. Agent observations are paused throughout manual control; do not promise that page content or a site's own storage can never contain secrets.
- On restart, an old handoff is marked interrupted rather than reattaching it to a new turn. Stale buttons cannot affect a different browser or run.

## Resource policy

Persistent profile means data on disk, **not a permanently running Chromium process**. Start the browser only for an actual managed browser tool operation or an explicit user Open Browser action. No Chromium at server startup, on agent listing, or for text-only conversations.

Proposed initial defaults, configurable and validated at server startup:

| Setting | Default | Behavior |
| --- | --- | --- |
| Concurrent agent browsers | 2 per server | Includes viewers, handoffs, launches, and closing processes. Never exceed it by racing launches. |
| Tabs per browser | 4 | Includes popups. Refuse excess tabs with a useful message rather than closing active tabs silently. |
| Idle browser timeout | 2 minutes | Close when no browser operation, visible viewer, control owner, or pending handoff needs it. |
| Browser ownership inactivity | 2 minutes | A turn holding a browser without using it releases ownership; an active operation/handoff suspends this timer. |
| Unattended handoff timeout | 10 minutes | With no visible viewer, expire the pending handoff, return an explicit timeout to the agent, then allow browser eviction. |
| Browser command timeout | 30 seconds | Bound a command so takeover, cancellation, and eviction cannot hang forever. |
| Capacity/ownership queue timeout | 2 minutes | Return a recoverable busy result; never hang or spin the model in a retry loop. |
| Viewed frame rate | At most 10 fps | Reduced/drop frames under backpressure; no recording or frame history. |
| Initial viewport | 1280 × 800 | The size while nobody watches. A watching panel sizes the page to its own surface (the controller's size wins, else the latest viewer's; back to the default when the last viewer leaves), rendered at 2× (`ZUMIBOT_BROWSER_SCALE`) so frames map 1:1 to HiDPI screens. A fixed desktop page letterboxed into a panel was unreadable (0.3× on a phone). |

These limits bound counts and streaming buffers, not a guaranteed number of megabytes: websites have variable memory usage. Measure browser process-tree RSS in verification and record actual numbers before selecting any tighter deployment limit. Do not introduce a full virtual desktop.

At capacity, evict a safely idle browser first, even before its normal timeout; otherwise queue requests fairly with a visible waiting state and cancellation. Viewing or controlling a browser prevents its eviction. It is acceptable for two explicitly open viewers to occupy the two browser slots. Closing a viewer stops its stream immediately; once no visible viewer, agent ownership or queued ownership demand, active operation, manual control drain, or pending handoff remains, close the browser process promptly. Retain the configured idle grace between commands while an agent still owns it; a safely idle browser can be reclaimed for waiting work.

One screencast producer per watched page feeds authorized subscribers. Stop it when the last visible subscriber leaves. A slow client retains at most one pending frame, with a bounded byte limit; drop or disconnect instead of accumulating frames. Never broadcast frames through the chat event feed or persist them with messages.

On clean shutdown, stop tools and streams, close browser contexts, and flush profile state before releasing the server data lock. Track and reap owned child processes; do not leave Chromium processes after server exit. Crash recovery must not kill unrelated system browsers.

## Profiles, identity, and concurrency

- Use an opaque persisted profile ID mapped to agent identity, with data under `ZUMIBOT_DATA_DIR/browsers/<profileId>/`. Names are display metadata, not filesystem paths.
- Cookies, cache, local storage, and IndexedDB belong to that profile. Session-only page state and unsaved forms are not promised to survive closing Chromium. Profiles are separate between agents and between Local and VPS; no synchronization or system-profile import.
- Rename preserves the profile ID in both `agents:save` and `agentsSync.ts` rename paths. Handle rename before watcher removal, following remembered approvals' ordering.
- A deleted agent loses access immediately: cancel its tools/requests, close its browser, and detach its profile mapping. Retain orphaned data privately pending explicit cleanup; recreating the same agent name receives a new profile. A parse error in an existing file is not deletion.
- Expose an explicit **Clear browser data** action with confirmation in agent settings; serialize it with shutdown and start a fresh empty profile afterward. Never clear data on ordinary panel close or idle shutdown.
- One Chromium persistent context per live agent profile. Never launch two processes against the same directory.
- A browser-work lease belongs to an agent turn, not merely an individual click. Two simultaneous chats using the same agent queue browser work so one chat cannot navigate between the other's observation and click. Different agents can work concurrently within the cap.
- Release a turn's lease at turn end/stop, explicit release, or ownership inactivity timeout. Requests waiting on user help keep the lease until resolved/expired. A later reacquisition invalidates prior observations and requires a fresh snapshot.
- Manual takeover preempts browser operations under the lease without transferring it to a different agent turn. On resumption, the original turn re-observes the current page.
- Server generation IDs invalidate stale page handles, queued inputs, and viewer messages following a restart, eviction, takeover, or clear-data action.

## Architecture and integration

### Browser service

Add a backend browser manager responsible for profiles, lazy process startup, tab lifecycle, fair leases, human control, handoffs, resource limits, and teardown. Use Playwright's persistent Chromium context support and a CDP session for live page frames and input. Keep the browser adapter injectable for deterministic lifecycle tests.

Agent tools cover navigation, tab list/select/open/close, fresh page observations with element references, click, type, scroll, screenshots, browser release, and request-user-action. Bound outputs and validate arguments. Support JavaScript alert/confirm/prompt and authentication popups within the tab cap. Downloads are saved to a bounded server-owned staging area and exposed through authenticated app downloads; uploads reuse explicitly selected/staged app files. Neither operation grants arbitrary client filesystem access. Initial scope excludes browser extension installation, camera/microphone, passkey devices, and arbitrary OS dialogs; show a clear unsupported result where necessary.

### Connecting Claude turns

Inject an app-owned MCP browser tool server into every normal agent turn using the existing `buildArgs`/`extraArgs` seam, retaining existing MCP configuration and permission handling. Use a small stdio bridge subprocess to forward validated operations to the backend browser manager over a private local IPC channel. The backend remains the only owner of browser processes and profiles.

Authorize the bridge with an ephemeral capability bound to chat, agent/profile, turn, and allowed operations. Deliver the capability via per-turn environment, not argv, URLs, persisted chat, or public endpoints. Revoke it on turn completion/cancellation. Carefully merge per-turn environment into `app.ts`'s current `runEnv.env()` wrapper, which presently replaces the runner environment. The private IPC endpoint and capability must not allow selecting another profile by supplying an agent name.

Append browser-use instructions separately from the optional house style: use the managed tools for interactive website work; request user action for credentials; never ask the user to paste credentials into chat; release browser ownership when finished; re-observe after takeover or lease changes. Existing tool permissions and Zumi Bot deny rules still apply. The group moderator receives no browser tools.

This routes supported interactive browser work through the app. It does not claim to sandbox arbitrary shell programs or third-party MCP servers: unrestricted existing tools could still launch other browsers. Do not silently rewrite arbitrary Bash commands or globally replace the desktop's handling of ordinary external links. In the browser workflow, failed sign-in must remain in the app with a useful error and no automatic system-browser fallback.

The bridge's pending handoff must survive normal CLI/MCP request deadlines using supported transport progress/timeout handling. Verify the installed CLI's behavior before implementation is declared complete; a timeout must cancel/expire the corresponding request, never leave a tool deadlocked or a misleading active card.

### Frontend transport

Extend the shared API/RPC contract for browser metadata, profiles, and handoff state. Use a dedicated authenticated browser WebSocket for frames, subscriptions, control acquisition/release, and user input. Existing RPC handlers lack caller identity, so ownership-sensitive input cannot simply use those handlers unchanged.

Reuse `Gate.authorize`, strict Origin checks, Local cookies/VPS sessions, sign-out revocation, and session validity checks. Browser connections must be drained and closed alongside the existing chat hub. Bind subscriptions and control to the actual authenticated connection, not a client-supplied owner ID. Validate frame generation, tab ID, coordinates, sizes, and input rates. Reject arbitrary protocol commands and client-supplied browser debug endpoints. Do not expose CDP publicly or relax the Electron renderer's origin restrictions.

Only authenticated, explicitly subscribed viewers receive frames. Render them within the existing frontend with a same-origin WebSocket and bounded image decoding. The remote website runs inside Chromium on the server, never as trusted app HTML or an injected iframe. Existing CSP and desktop preload boundaries remain intact.

### Packaging and operation

The production server currently bundles dependencies into one `server.mjs`; Chromium and Playwright runtime assets need explicit packaging. Promote the required browser runtime from test-only use into the backend deployment artifact, pin versions, and include the bridge entry point/assets. Do not assume development `node_modules` exists on the VPS or packaged desktop.

Provide an explicit setup/check command for a supported Chromium binary and required OS libraries, plus an executable-path override. Ordinary app startup must not download browsers or require sudo. Missing Chromium produces an actionable browser-unavailable status while text chats still work. Keep Chromium sandboxing enabled; never solve installation problems with blanket `--no-sandbox`.

Validate the packaged Linux desktop's use of Electron's Node runtime for the backend and bridge. Add setup/runbook instructions and artifact checks for both server deployment and the `.deb`. Installing system dependencies or changing the live VPS is outside this design approval and follows the repository's explicit approval rule.

## Validation and acceptance

- Unit tests: lazy launch, profile separation/persistence, launch deduplication, cap and tab enforcement, queue fairness/timeouts, idle eviction, lease cancellation, rename/delete/recreate behavior, and clean shutdown.
- Control tests: off by default; watcher cannot send input; takeover waits for in-flight operations; no agent observations/actions during manual control; ownership is connection-bound; stale input is rejected; disconnect/sign-out revoke control.
- Handoff tests: no automatic stream, correct chat/agent/turn routing in groups, done/cancel/timeout outcomes, routine waiting state, reconnect rendering, restart interruption, and no raw credential input in persisted chat/logs.
- Streaming tests: zero screencast producers with no viewers, one producer shared by viewers, immediate last-subscriber stop, bounded buffering under a stalled client, no frame retention in chat history, hidden-panel unsubscribe.
- Real Chromium E2E with local fixture websites: agent actions visible in the viewer, user takeover, sign-in cookie surviving browser/server restart, isolated agents, popup/dialog handling, uploaded/downloaded file flow, and same-agent contention across a single and group chat. Use synthetic credentials only.
- Verify Local and VPS-style authentication paths, including hostile Origin and expired sessions. Verify the packaged server and desktop artifacts, not only source execution.
- Run appropriate typechecks, unit suites, builds, and E2E checks. Record process count, process-tree RSS, and idle/stream CPU for zero browsers, one unviewed active browser, one viewed browser, and post-idle cleanup. Report measurements and limitations rather than promising a fixed memory saving.
- A user can run browser work unseen, explicitly open the app viewer to see the live page, take control, return control, close the viewer to stop streaming, and later reopen with the same agent's saved website session.

## Left to the builder

Exact filenames/component boundaries, bounded frame encoding settings, internal queue implementation, MCP SDK selection and pinned dependency versions after checking compatibility, and small layout details matching the current theme. Changing the selected architecture, automatic-streaming rule, profile isolation, or takeover behavior requires revisiting this design.

## Technical references

- [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
- [Chromium page screencasting](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)
- [Chromium input dispatch](https://chromedevtools.github.io/devtools-protocol/tot/Input/)

These APIs supply browser persistence and streaming/input primitives. Resource limits, authenticated viewing, leases, and handoff behavior are ZumiBot responsibilities.
