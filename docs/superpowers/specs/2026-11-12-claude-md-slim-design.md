# Slim CLAUDE.md — design

## Why

`CLAUDE.md` is 286 124 bytes (master `c8615d5`) (about 70k tokens). Claude Code loads it into every session in this repo, and into every
ZumiBot agent whose folder is this repo, before any work starts. That costs the cache write each session, takes a
third of a 200K window, and buries the rules that matter on every change (never bypass permissions, secrets never in
logs, a new API method touches three places) under 46 feature paragraphs most sessions never need. It grew one
paragraph per feature (150 commits touched it), and nothing stops it growing.

The user chose this over graphify: graphify adds a generated graph plus CLAUDE.md rules and a hook, while the cost here
is the file that loads up front, and its content is design rules and reasons, not code structure.

## Goals

1. Root `CLAUDE.md` holds only what nearly every change needs, plus an index of area docs. At most 16 384 bytes.
2. Every feature paragraph moves, **byte for byte**, into a doc under `docs/architecture/`. No fact is lost or reworded.
3. Claude finds the right doc without being told: the root index names each doc with the paths that should trigger
   reading it, and a short `CLAUDE.md` in each folder that maps to one area points at its doc (Claude Code loads a
   subfolder's `CLAUDE.md` when it reads a file in that folder).
4. It cannot quietly grow back: a unit test fails when root `CLAUDE.md` passes 16 384 bytes, when a doc is not in the
   index, or when a link or pointer names a missing doc. A rule in root says where new feature text goes.

## Non-goals

- Condensing or rewriting the moved text. A later pass may trim a doc; this change only moves.
- graphify or any generated code graph.
- Editing historic specs and plans in `docs/superpowers/` (they say "update CLAUDE.md"; they are records).
- Editing the user's own agents in `~/.claude/agents/` (`structure-reviewer` reads the base branch's `CLAUDE.md` for
  conventions; the slim root keeps the Conventions section, so it still works).
- Pointer files in the frontend: `components/` and `state/` are flat, so a folder can't name one area. The root index
  covers frontend files by name.

## Anti-goals (a failure even if it works)

- A fact from the old file exists nowhere after the change.
- A paragraph is retyped by a model instead of copied (a silent typo in a 35 KB paragraph is a lost fact).
- A doc exists that no index line or pointer leads to.
- Root `CLAUDE.md` drifts back into feature detail.

## Constraints

- No commits unless the user says so (user's global rule). No `git stash`.
- Pointer `CLAUDE.md` files sit in source folders; none of them may reach a build. Checked: `electron-builder.yml`
  ships `out/**` only, the backend ships Vite's `dist/`, and `deploy.sh` rsyncs `backend/dist`.
- No in-flight branch ahead of `master` touches `CLAUDE.md` today (checked 2026-11-12), so landing now conflicts with
  nothing. A branch that later merges a paragraph into the old file is resolved by moving that paragraph into its doc.

## Decisions (my calls; the user said "just do it")

- **Canonical text lives in `docs/architecture/<area>.md`**, one folder, readable by people too. Folder `CLAUDE.md`
  files only point; they hold no feature text, so there is one place to update.
- **Each doc** is `# <Title>`, a blank line, then the moved paragraphs in their original order, separated by one blank
  line, unchanged except the cross-reference links below.
- **Cross-references.** Every `see <Section>` (in parentheses or not) naming a section that now lives in another doc
  becomes a link on the section's words, nothing else changed: `see Codex agents` → `see [Codex agents](codex.md)`
  inside `docs/architecture/`, `see [Codex agents](docs/architecture/codex.md)` in root. A reference to the doc it sits
  in stays plain text. Sections: Codex agents → `codex.md`, Vault → `vault.md`, Workflows → `workflows.md`, To-dos →
  `todos.md`, Rail and Command palette → `ui.md`, Pause and Resume → `pause-resume.md`, Commands → `e2e.md` (the probes
  it means are there), Zumi Bot automations → `zumi-bot-automations.md`, Agents and Agent memory → `agents.md`,
  Agent asks → `agent-asks.md`, Browser audit tools → `browser.md`, Dynamic island → `desktop-shell.md`, Saved history
  → `definition-history.md`, Spend caps → `spend-caps.md`. Left alone: `see Hooks` (inside the Codex paragraph itself), `` see `deploy.env.example` ``,
  `` see `agents:save` and `agentsSync.ts` ``. The full list comes from `grep -o 'see [A-Z][A-Za-z -]*' CLAUDE.md`
  run on the old file; a match not in this list is left plain and reported.
- **Root keeps** verbatim: the title and two intro lines; the Commands code block; Layout (plus one new line for
  `docs/architecture/`); from Architecture: Transport, Chat items as deltas, Wiring, Running claude, Single chats vs.
  groups, Dev/test hooks; Testing notes; Conventions. New root text: two lines after the Commands block pointing to
  `e2e.md` (keeping "run `npm run e2e` after every Claude Code update") and `deploy-and-sync.md`; one line under
  Architecture, Data: the data dir and default, a pointer to `data.md` for its files, and a note that a few per-chat files
  (such as `chats/<id>.dispatch.json`) are described only in their feature's doc; a Conventions bullet carrying the secrets rule; and a
  `## Docs by area` section (rules, then the index).
- **Root rules text** (`## Docs by area`, exact):
  > Feature detail lives in `docs/architecture/`, one doc per area. Before changing an area, read its doc; a folder that
  > belongs to one area has a `CLAUDE.md` pointing to it. When a change lands, update that doc in the same change. A new
  > area gets a new doc, an index line here, and a pointer `CLAUDE.md` if it has a folder of its own. Never put feature
  > detail in this file: it stays under 16 KB, and `zumi-bot-server/shared/tests/repoDocs.test.ts` fails past that.
  Then one sentence: frontend files have no pointers, so match the area by name prefix (`Workflow*`, `Routine*`, `Vault*`,
  `Todo*`, `Inbox*`, `Island*`) or run `grep -l <FileName> docs/architecture/*.md`.
- **Guard test** lives in the `shared` vitest project (neutral, node env, already reads files with `node:fs`).

## Mapping

Paragraphs are found by how they start (line numbers drift; starts don't). "Read when" is the index line's trigger.

| Doc | Title | Paragraphs (by start) | Read when touching |
|---|---|---|---|
| `e2e.md` | E2E suites, probes and smoke runs | `E2E suites build first` | `zumi-bot-server/e2e/`, any `e2e:*` script, probes, fake CLIs in `backend/tests/fixtures/` |
| `deploy-and-sync.md` | Deploy and sync | `` `npm run deploy` ``, `` `npm run sync` ``, `**Settings › Sync & server**` | `zumi-bot-server/deploy/`, desktop `sync*.ts` |
| `codex.md` | Codex agents | `**Codex agents` | `core/codex/`, `shared/src/engine.ts`, anything engine-aware (`provider: codex`) |
| `edit-resend-fork.md` | Edit, Resend, Fork | `**Edit, Resend, Fork.**` | `versions.ts`, `fork.ts`, `sessionPoints.ts`, version switcher |
| `room-clone.md` | Room clone | `**Room clone.**` | `roomClone.ts`, `roomSummary.ts`, `CloneRoomDialog.tsx` |
| `agent-commands.md` | Agent commands | `**Agent commands.**` | `shared/src/commands.ts`, `commandResolver.ts`, `/` menu, `ModelPicker.tsx` |
| `side-questions.md` | `/btw` side questions | ``**`/btw` side questions.**`` | `core/btw/`, `SidePanel.tsx`, `SideThreadView.tsx` |
| `context-and-compact.md` | Context meter, Compact and keep warm | `**Context meter and Compact.**` | `ContextMeter.tsx`, `ColdNotice.tsx`, `keepWarm.ts`, Compact |
| `ui.md` | App shell UI | `**Settings (`, `**Side panel.**`, `**Command palette`, `**Rail (`, `**File viewer`, `**Tool rows.**`, `**Agent names in the UI` (original order) | `Settings.tsx`, `Rail.tsx`, `CommandPalette.tsx`, `FileViewer.tsx`, `ToolCallRow`, `agentNames.ts`, side panel (`SidePanelMenu`, `state/sidePanel.ts`) |
| `routines.md` | Routines | `**Routines.**` | `core/routines/`, `core/hooks/`, `RoutineEditor.tsx` |
| `workflows.md` | Workflows | `**Workflows (` | `core/workflows/`, `shared/src/workflow*.ts`, `WorkflowEditor.tsx`, `StepInspector.tsx`, `net/useWorkflows.ts`, run view, Audit log |
| `workflow-steps.md` | HTTP, Transform, Sub-workflow, failure path and Room step | `**HTTP request, Transform`, `**Room step (` | `httpCalls.ts`, `httpStep.ts`, `workflowRooms.ts`, `stepRules.ts` |
| `workflow-canvas.md` | Workflow canvas, notes and groups | `**Workflow canvas controls` | `WorkflowCanvas.tsx`, `state/workflow*.ts`, `WorkflowNotes.tsx`, `WorkflowGroups.tsx` |
| `definition-history.md` | Saved history of workflows and routines | `**Saved history of workflows and routines` | `core/history/`, `HistoryDialog.tsx` |
| `usage.md` | Usage | `**Usage (` | `core/usage/`, `UsageView.tsx`, `CostChip.tsx`, `pricing.ts` |
| `jev.md` | Jev | `**Jev (` | `core/jev/`, `JevSettings.tsx` |
| `notifications.md` | Notifications | `**Notifications (` | `core/notify/`, service worker, `NotificationsSettings.tsx` |
| `files-panel.md` | Files panel and Restore | `**Files panel.**` | `core/files/`, `FilesPanel`, `fileRestore.ts` |
| `dispatched-agents.md` | Dispatched agents | `**Dispatched agents (` | `core/dispatch/`, `shared/src/dispatch.ts` |
| `pause-resume.md` | Pause and Resume | `**Pause and Resume (` | `pause*.ts`, `chatTmp.ts`, Pause/Resume UI |
| `spend-caps.md` | Spend caps | `**Spend caps (` | `core/caps/`, `shared/src/spendCaps.ts`, `SpendCapInput.tsx`, `dailySpendCap:` |
| `usage-limit-waits.md` | Usage limit waits | `**Usage limit waits (` | `limitResumes.ts`, `limitNotice.ts` |
| `unread-and-archive.md` | Unread markers and Archive | `**Unread markers.**`, `**Archive.**` | `readMarks.ts`, `unread.ts`, `archive.ts`, `ArchivedNav.tsx` |
| `message-search.md` | Message search | `**Message search (` | `core/search/`, `shared/src/search.ts`, `MessageHits.tsx` |
| `chat-export.md` | Chat export | `**Chat export (` | `core/export/`, `chatExport.ts`, `ExportDialog.tsx` |
| `todos.md` | To-dos and the To-dos page | `**To-dos.**`, `**To-dos page (` | `core/todos/`, `shared/src/todos.ts`, `Todos*.tsx` |
| `inbox.md` | Inbox | `**Inbox (` | `Inbox*.tsx`, `state/inbox.ts`, `workflowMessages.ts` |
| `agent-asks.md` | Agent asks | `**Agent asks (` | `core/asks/`, `AskCard.tsx`, `AskedBar.tsx` |
| `zumi-bot-automations.md` | Zumi Bot automations | `**Zumi Bot automations (` | `core/automations/`, `zumiBot.ts` prompt |
| `voice-input.md` | Voice input | `**Voice input (` | `core/voice/`, `useDictation.ts` |
| `agents.md` | Agents, memory and remembered approvals | `**Remembered approvals.**`, `**Agents.**`, `**Agent memory (` | `core/agents/`, `core/memory/`, `approvalStore.ts`, Agent Studio |
| `computer-use.md` | Computer use | `**Computer use (` | `core/desktop/`, `DesktopPanel.tsx` |
| `browser.md` | Browser audit tools | `**Browser audit tools (` | `core/browser/` |
| `vault.md` | Vault | `**Vault (` | `core/vault/`, `shared/src/vault.ts`, `deploy/vaultSync.mjs`, `VaultSettings.tsx` |
| `auth.md` | Auth | `**Auth (` through `Error messages name the env var` (4 lines) | `backend/src/auth/` |
| `data.md` | Data folder | `**Data.**` | `ZUMIBOT_DATA_DIR`, any new file in the data dir |
| `desktop-shell.md` | Desktop shell, island and tray | `**Desktop shell (`, `**Dynamic island and tray (` | `zumi-bot-desktop/src/`, `IslandView.tsx`, `state/island*.ts`, `IslandSettings.tsx` |

## Pointer `CLAUDE.md` files

One per folder below, each naming its docs by repo-root path (`docs/architecture/<doc>`), nothing else.

`backend/src/core/` (all under `zumi-bot-server/`): `codex` → codex; `workflows` → workflows, workflow-steps;
`vault` → vault; `desktop` → computer-use; `asks` → agent-asks; `automations` → zumi-bot-automations; `btw` →
side-questions, context-and-compact; `dispatch` → dispatched-agents; `notify` → notifications; `todos` → todos;
`usage` → usage; `search` → message-search; `memory` → agents; `agents` → agents; `voice` → voice-input; `export` →
chat-export; `history` → definition-history; `jev` → jev; `routines` → routines; `hooks` → routines, workflows; `files`
→ files-panel; `caps` → spend-caps; `browser` → browser, vault (the fill path). `chat` names a doc per file: `pauseSettings.ts`,
`pauseHook.ts`, `chatTmp.ts` → pause-resume; `limitResumes.ts` → usage-limit-waits; `versions.ts`, `fork.ts`,
`sessionPoints.ts` → edit-resend-fork; `roomClone.ts`, `roomSummary.ts` → room-clone; `taskQueue.ts` →
pause-resume, usage-limit-waits, edit-resend-fork; `groupService.ts` → pause-resume, codex; `readMarks.ts` →
unread-and-archive; `commandResolver.ts`, `commandText.ts` → agent-commands; one line names how a run is built (the per-turn stdio bridges, the merged `--settings`, the run's env, the appended
system prompt that must not vary) → todos, vault, pause-resume, computer-use, codex; everything else → root "Running
claude" and "Single chats vs. groups", plus the doc of the feature being changed.

Elsewhere: `zumi-bot-server/backend/src/auth` → auth; `zumi-bot-server/e2e` → e2e; `zumi-bot-server/deploy` →
deploy-and-sync, vault (for `vaultSync.mjs`); `zumi-bot-desktop/src/main` → desktop-shell, deploy-and-sync (for
`sync*.ts`); `zumi-bot-desktop/src/preload` → desktop-shell, notifications (the notify bridge); `zumi-bot-desktop/src/pages`
→ desktop-shell; `zumi-bot-desktop/src/sync` → deploy-and-sync; `zumi-bot-server/backend/src/http` names a doc per
file: `hooks.ts` → routines, workflows; `files.ts` → files-panel; `export.ts` → chat-export; `voice.ts`, `headers.ts` →
voice-input; `desktopSocket.ts` → computer-use; `static.ts` → notifications; everything else (`server.ts`, `upload.ts`,
`attachments.ts`, `body.ts`, `browserSocket.ts`, `browserFiles.ts`, `login/`) → root "Transport". A qualifier on a doc
name is one parenthesis, e.g. "(repo-root path; for `sync*.ts`)". The guard test expects at least 32 pointer files.

## Other references to update

- `zumi-bot-server/backend/src/core/chat/chatTmp.ts:7` comment `(see CLAUDE.md, Data)` →
  `(see docs/architecture/data.md)`.
- `zumi-bot-server/deploy/SETUP-VPS.md:114` "see the Vault paragraph in `CLAUDE.md`" → `docs/architecture/vault.md`.
- Not ours: `deploy/sync.mjs` (`~/.claude/CLAUDE.md`), `deploy/workflows/w5-design-audit.mjs` (another repo's).

## Left to the builder

The split script's shape (it lives in the scratchpad and is not kept); index line wording within the "Read when"
column; the wording of each pointer file beyond naming its docs.
