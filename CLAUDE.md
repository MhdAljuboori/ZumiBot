# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ZumiBot is a UI for chatting with Claude Code agents (`~/.claude/agents/*.md`), alone or in group chats. It runs as a Node server reached from a browser (VPS mode, behind a reverse proxy) or from a thin Electron shell (Local mode, which starts the same server on the PC).

## Commands

Run everything from the repo root (npm workspaces, Node >= 22).

```bash
npm test                         # all unit tests (vitest projects: shared, frontend, backend, zumibot)
npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts   # one file
npx vitest run --project backend -t "some test name"                      # one project, filtered by name
npm run typecheck                # tsc --noEmit in every workspace
npm run build:server             # frontend (vite) then backend -> zumi-bot-server/backend/dist/
npm run build                    # build:server + desktop shell (electron-vite)
npm run dev                      # build:server, then electron-vite dev for the desktop shell
npm run build:deb                # .deb in zumi-bot-desktop/dist/
npm run bump:patch               # bump every workspace + add a CHANGELOG section (also :minor, :major, bump:set -- X.Y.Z)
npm run desktop:check            # computer use: desktop programs found or missing
```

E2E suites, probes and the Codex smoke run: [docs/architecture/e2e.md](docs/architecture/e2e.md). After every Claude Code update run `npm run e2e` (it checks the hidden `--resume-session-at`/`--fork-session` flags edit and resend use) and `probe:sandbox`. `npm run sync` and the desktop Sync window: [Deploy and sync](docs/architecture/deploy-and-sync.md).

## Layout

- `zumi-bot-server/shared` – types and pure helpers used by both sides. Imported as `@zumibot/shared/<file>` (raw `.ts`, no build step). `types.ts` holds `ZumiBotApi`, the contract between UI and server.
- `zumi-bot-server/backend` – Node server, auth, CLI. Built by Vite into one self-contained `dist/server.mjs` (all deps bundled), with `dist/login/` and `dist/web/` (the built frontend) copied next to it.
- `zumi-bot-server/frontend` – React 19 UI (Tiptap composer, react-markdown with KaTeX math and Mermaid diagrams). Markdown rendering: see [App shell UI](docs/architecture/ui.md). Same UI for browser and desktop. A second Vite build (`vite.sw.config.ts`) makes the service worker `dist/sw.js`, because a worker must be one classic file at an unhashed URL.
- `zumi-bot-desktop` – Electron shell (package name `zumibot`). It never bundles the UI; it loads pages from the connected server.
- `zumi-bot-docs` – Astro Starlight site: the end-user docs for `https://docs.zumibot.run`.
- `docs/superpowers/` – specs, plans and handoff notes. The spec explains the why of most decisions; its phone/tablet non-goal is out of date.
- `docs/architecture/` – one doc per feature area, moved out of this file; see Docs by area.

## Architecture

**Transport.** One WebSocket per tab at `/ws`. The frontend's `net/api.ts` implements `ZumiBotApi` on top of `net/rpc.ts`, which sends `{id, method, args}` (`shared/src/rpc.ts`). The backend's `rpc/hub.ts` sends each call to a handler in `rpc/handlers.ts` keyed by `'area:verb'` (`chats:send`, `agents:save`, ...). Handlers check every argument themselves (`str()`, `strings()`, ...), since args arrive as untyped JSON. Server events (`chats:push`, `agents:changed`) are broadcast to every connected tab. `chats:send` settles only when its turn ends, so a dropped socket rejects it while the turn runs on: when its message is already stored that rejection is quiet (`quietRejection` in `state/sendFailure.ts`), since the reply or its error item arrives after the reconnect (`e2e:resilience` checks it). A new API method touches three places: `ZumiBotApi` in `shared/src/types.ts`, the handler in `rpc/handlers.ts`, and the mapping in `frontend/src/net/api.ts`. Uploads (`/api/attachments/stage`) and attachment downloads are plain HTTP routes in `http/server.ts`.

**Chat items as deltas.** `rpc/itemsFeed.ts` keeps each chat's last pushed item list and sends only the items past the shared prefix, with a `seq`. The client (`frontend/src/state/itemSync.ts`, `resync.ts`) splices the deltas in and reloads when it sees a gap. Pages load newest-first (`ITEMS_PAGE`), and older pages load on scroll up. A jump to an old message loads in one request (`until`, see [Message search](docs/architecture/message-search.md)). After stored items are rewritten without a push (for example an agent rename), call `feed.reset()`.

**Wiring.** `backend/src/app.ts#startServer` builds every service by hand (no DI framework) and listens on `127.0.0.1` only. That address is fixed: the proxy or the desktop shell is the only way in. It also takes a lock on the data dir, recovers interrupted chats, clears staged attachments, and serves a control socket or pipe (`control.ts`). Installer, sync and desktop use that socket to ask how many replies are running. Entry: `main.ts` → `cli.ts` (`serve | busy | set-password | setup-2fa`).

**Running claude.** `core/chat/claudeRunner.ts` spawns the `claude` CLI per turn: `-p --agent <name> [--resume <sessionId>] --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`. `streamParser.ts` reads the output. Tool permission requests come back over stdio (`controlProtocol.ts`) and appear in the UI as approval cards. `AskUserQuestion` gets a question card instead; the answers go back as `updatedInput.answers` (`chats:answerQuestions`). `ExitPlanMode` gets a plan card (`PlanCard.tsx`): Approve sends the input back unchanged, and the CLI itself restores the earlier permission mode (a chat started in Plan mode gets `setMode` to the server's instead, see [Chat mode and effort](docs/architecture/chat-mode-and-effort.md)); Keep planning denies with optional feedback, so the agent revises and asks again (`chats:answerPlan`). A plan is never auto-allowed or remembered. Never add `--dangerously-skip-permissions` or `bypassPermissions`. The runner closes stdin at the `result` event and spawns with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: background tasks (async subagents, `run_in_background`, Monitor) would keep the CLI alive past its result, so the chat would stay running after the reply. `claudeLocator.ts` finds the binary, and `shellEnv.ts` takes `PATH` from the user's interactive shell. Tests run against fake claude/moderator scripts and recorded stream fixtures in `backend/tests/fixtures/`.

**Single chats vs. groups.** `ChatService` runs one agent per chat. `GroupService` runs group rooms. Group sends never go through `ChatService.send`: its claim on the chat would collide with the room's. A moderator (`moderator.ts`, a separate `claude` call with a JSON schema) picks the next speakers from `@mentions`, the queue (`groupQueue.ts`) and a hop cap. A member may be a Codex agent: its turns run on Codex while the moderator stays a `claude` call (see [Codex agents](docs/architecture/codex.md)). Renaming an agent must move remembered approvals first, synchronously, so the agents-folder watcher's removal pass finds the rules already moved; then running group rooms, stored chats, settings and the sidebar; voice talk settings, then routines last, both caught and logged (see `agents:save` and `agentsSync.ts`).

**Dev/test hooks.** Read them through `devEnv()` (`backend/src/devEnv.ts`), which ignores them when `NODE_ENV=production`: `ZUMIBOT_PERMISSION_MODE=manual`, `ZUMIBOT_TEST_PICK_FOLDER`, and so on. `ZUMIBOT_TEST_VOICE_URL` and `ZUMIBOT_TEST_WAIT_SCALE`: see [E2E](docs/architecture/e2e.md). The packaged desktop sets `NODE_ENV=production`. `ZUMIBOT_VAULT_KEY_FILE` is not a dev hook (production reads it too), but every test that starts a server points it at a temp folder, as the e2e harness does, so nothing touches the real `~/.config/zumibot-vault`.

**Data.** `ZUMIBOT_DATA_DIR`, default `~/.local/share/zumibot`. [data.md](docs/architecture/data.md) lists its files; a few per-chat files are described only in their feature's doc.

## Docs by area

Feature detail lives in `docs/architecture/`, one doc per area. Before changing an area, read its doc; a folder that belongs to one area has a `CLAUDE.md` pointing to it. When a change lands, update that doc in the same change. A new area gets a new doc, an index line here, and a pointer `CLAUDE.md` if it has a folder of its own. Never put feature detail in this file: it stays under 16 KB, and `zumi-bot-server/shared/tests/repoDocs.test.ts` fails past that. Frontend files have no pointers: match the area by name prefix (`Workflow*`, `Routine*`, `Vault*`, `Todo*`, `Inbox*`, `Island*`), or run `grep -l <FileName> docs/architecture/*.md`.

- [Engines](docs/architecture/engines.md): `core/engines/`, `shared/src/engine.ts`
- [Protocol engines](docs/architecture/protocol-engines.md): ACP and AG-UI, `core/acp/`, `core/agui/`
- [E2E suites, probes and smoke runs](docs/architecture/e2e.md): `zumi-bot-server/e2e/`, any `e2e:*` script, fake CLIs in `backend/tests/fixtures/`
- [Updates and showcase](docs/architecture/updates.md): `core/update/`, `shared/src/update.ts`, `Update*.tsx`, `useUpdate.ts`, `zumi-bot-site/`, `CHANGELOG.md`, `release.yml`
- [User docs](docs/architecture/user-docs.md): `zumi-bot-docs/`; a change users can see updates its page there
- [Deploy and sync](docs/architecture/deploy-and-sync.md): `zumi-bot-server/deploy/`, desktop `sync*.ts`
- [Install and first-run setup](docs/architecture/install.md): `setupServer.ts`, `auth/setup*.ts`, `Dockerfile`, `install.sh`
- [Codex agents](docs/architecture/codex.md): `core/codex/`, `shared/src/engine.ts`, anything engine-aware (`provider: codex`)
- [Git worktrees and the git chip](docs/architecture/worktrees.md): `core/git/`, `shared/src/worktree.ts`, `GitChip.tsx`, `GitChangesPanel.tsx`, `useGitStatus.ts`, `state/gitStatus.ts`
- [Review loop](docs/architecture/review-loop.md): `core/attempts/`, `core/github/`
- [Edit, Resend, Fork](docs/architecture/edit-resend-fork.md): `versions.ts`, `fork.ts`, `sessionPoints.ts`, version switcher
- [Mid-turn messages](docs/architecture/mid-turn-messages.md): `steer.ts`, `sendKeys.ts`
- [Room clone](docs/architecture/room-clone.md): `roomClone.ts`, `roomSummary.ts`, `CloneRoomDialog.tsx`
- [Agent commands](docs/architecture/agent-commands.md): `shared/src/commands.ts`, `commandResolver.ts`, `/` menu, `ModelPicker.tsx`, `/later`
- [Chat mode and effort](docs/architecture/chat-mode-and-effort.md): `shared/src/chatRun.ts`, `runPickers.ts`, `ChoicePicker.tsx`, Plan mode's approval
- [`/btw` side questions](docs/architecture/side-questions.md): `core/btw/`, `SidePanel.tsx`, `SideThreadView.tsx`
- [Thinking](docs/architecture/thinking.md): `thinkingDisplay.ts` (`--thinking-display`), `ThoughtRow.tsx`, `thought`, `thoughtBy`
- [Context meter, Compact and keep warm](docs/architecture/context-and-compact.md): `ContextMeter.tsx`, `ColdNotice.tsx`, `keepWarm.ts`, Compact
- [App shell UI](docs/architecture/ui.md): `Settings.tsx`, `Rail.tsx`, `CommandPalette.tsx`, `FileViewer.tsx`, `ToolCallRow`, `agentNames.ts`, `liveTurns`, `SidePanelMenu`, `state/sidePanel.ts`
- [Routines](docs/architecture/routines.md): `core/routines/`, `core/hooks/`, `RoutineEditor.tsx`
- [Workflows](docs/architecture/workflows.md): `core/workflows/`, `shared/src/workflow*.ts`, `WorkflowEditor.tsx`, `StepInspector.tsx`, `TriggerInspector.tsx`, `net/useWorkflows.ts`, `workflowEvents.ts`, `fileWatchers.ts`, `mailWatchers.ts`, `shared/src/runWorkflow.ts` (`/run-workflow`)
- [HTTP, Transform, Sub-workflow, failure path, Room step and routine parity](docs/architecture/workflow-steps.md): `httpCalls.ts`, `httpStep.ts`, `workflowRooms.ts`, `stepRules.ts`, `workflowChat.ts`, `freshStart.ts`
- [Workflow canvas, notes and groups](docs/architecture/workflow-canvas.md): `WorkflowCanvas.tsx`, `state/workflow*.ts`, `WorkflowNotes.tsx`, `WorkflowGroups.tsx`
- [Saved history of workflows and routines](docs/architecture/definition-history.md): `core/history/`, `HistoryDialog.tsx`
- [Usage](docs/architecture/usage.md): `core/usage/`, `UsageView.tsx`, `CostChip.tsx`, `pricing.ts`
- [Jev](docs/architecture/jev.md): `core/jev/`, `JevSettings.tsx`
- [Notifications](docs/architecture/notifications.md): `core/notify/`, service worker, `NotificationsSettings.tsx`
- [Files panel and Restore](docs/architecture/files-panel.md): `core/files/`, `FilesPanel`, `fileRestore.ts`
- [Dispatched agents](docs/architecture/dispatched-agents.md): `core/dispatch/`, `shared/src/dispatch.ts`
- [Background processes](docs/architecture/processes.md): `core/processes/`, `shared/src/processes.ts`, `Process*.tsx`
- [Run button](docs/architecture/run-blocks.md): `runBlock.ts`, `runResults.ts`
- [Pause and Resume](docs/architecture/pause-resume.md): `pause*.ts`, `chatTmp.ts`, Pause/Resume UI
- [Spend caps](docs/architecture/spend-caps.md): `core/caps/`, `shared/src/spendCaps.ts`, `SpendCapInput.tsx`, `dailySpendCap:`
- [Usage limit waits](docs/architecture/usage-limit-waits.md): `limitResumes.ts`, `limitNotice.ts`
- [Unread markers and Archive](docs/architecture/unread-and-archive.md): `readMarks.ts`, `unread.ts`, `archive.ts`, `ArchivedNav.tsx`
- [Message search](docs/architecture/message-search.md): `core/search/`, `shared/src/search.ts`, `MessageHits.tsx`
- [Chat export](docs/architecture/chat-export.md): `core/export/`, `chatExport.ts`, `ExportDialog.tsx`
- [To-dos, cards and the task board](docs/architecture/todos.md): `core/todos/`, `shared/src/todos.ts`, `Todo*.tsx`
- [Inbox](docs/architecture/inbox.md): `Inbox*.tsx`, `state/inbox.ts`, `workflowMessages.ts`
- [Agent asks](docs/architecture/agent-asks.md): `core/asks/`, `AskCard.tsx`, `AskedBar.tsx`
- [Zumi Bot automations](docs/architecture/zumi-bot-automations.md): `core/automations/`, `zumiBot.ts` prompt
- [Voice input](docs/architecture/voice-input.md): `core/voice/`, `useDictation.ts`
- [Voice requests](docs/architecture/voice-conversations.md): `voiceTalk*`, `useVoiceTalk.ts`, `voiceRoute.ts`, `voiceTitle.ts`, `voiceWords.ts`, `VoiceTalkView.tsx`
- [Agents, memory and remembered approvals](docs/architecture/agents.md): `core/agents/`, `core/memory/`, `approvalStore.ts`, Agent Studio
- [Computer use](docs/architecture/computer-use.md): `core/desktop/`, `DesktopPanel.tsx`
- [Browser audit tools](docs/architecture/browser.md): `core/browser/`
- [Vault](docs/architecture/vault.md): `core/vault/`, `shared/src/vault.ts`, `deploy/vaultSync.mjs`, `VaultSettings.tsx`
- [Channels](docs/architecture/channels.md): `core/channels/`
- [Connectors](docs/architecture/connectors.md): `core/connectors/`, `shared/src/connectors.ts`, `ConnectorsSettings.tsx`, `state/connectors.ts`
- [Governance](docs/architecture/governance.md): `core/audit/`, `core/isolation/`
- [Servers, plugins, skills and hooks](docs/architecture/extensions.md): `core/extensions/`, `shared/src/extensions.ts`, `ExtensionsSettings.tsx`, `AgentLoadout.tsx`, `AgentOwnExtensions.tsx`, `state/extensions*.ts`, `extensionForms.ts`, `agentLoadout.ts`
- [Auth](docs/architecture/auth.md): `backend/src/auth/`
- [Data folder](docs/architecture/data.md): `ZUMIBOT_DATA_DIR`, any new file in the data dir
- [Desktop shell, island and tray](docs/architecture/desktop-shell.md): `zumi-bot-desktop/src/`, `IslandView.tsx`, `state/island*.ts`, `IslandSettings.tsx`

## Testing notes

- All vitest projects use the `node` environment. Frontend tests cover only the pure modules in `src/state/` and `src/net/` (there are no component/DOM tests), so keep logic out of components where you can.
- The backend's HTTP/WebSocket tests use `tests/http/helpers.ts`. The frontend's socket tests use `tests/net/fakeSocket.ts`.

## Conventions

- Secrets never go into logs, URLs or error messages; error messages name the env var, never its value.
- Dependencies are pinned to exact versions, and every workspace shares one version number (use the `bump:*` scripts).
- Comments are short and say *why* (an ordering constraint, a race, a security reason). Keep that style.
- The previous Electron app at `/home/mhdaljuboori/Developments/Desktop/ClaudeBot` is read-only reference. Never edit it.
- Ask before installing the `.deb`, touching the VPS, using sudo, changing DNS, or handling the real password/2FA.
