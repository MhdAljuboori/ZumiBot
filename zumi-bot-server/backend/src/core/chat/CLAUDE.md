# chat — docs

Before changing a file here, read the doc for its feature (repo-root paths):

- `pauseSettings.ts`, `pauseHook.ts`, `chatTmp.ts`: `docs/architecture/pause-resume.md`
- `limitResumes.ts`: `docs/architecture/usage-limit-waits.md`
- `versions.ts`, `fork.ts`, `sessionPoints.ts`: `docs/architecture/edit-resend-fork.md`
- `roomClone.ts`, `roomSummary.ts`: `docs/architecture/room-clone.md`
- `taskQueue.ts`: `docs/architecture/pause-resume.md`, `docs/architecture/usage-limit-waits.md`, `docs/architecture/edit-resend-fork.md`
- `groupService.ts`: `docs/architecture/pause-resume.md`, `docs/architecture/codex.md`
- `readMarks.ts`: `docs/architecture/unread-and-archive.md`
- `thinkingDisplay.ts`, and thinking in `streamParser.ts`/`chatService.ts`: `docs/architecture/thinking.md`
- `allowRules.ts` (and `shared/src/allowRules.ts`): `docs/architecture/chat-mode-and-effort.md`
- `commandResolver.ts`, `commandText.ts`: `docs/architecture/agent-commands.md`
- `acknowledge.ts` (the ack line a turn opens with): `docs/architecture/ui.md`
- How a run is built (the per-turn stdio bridges, the one merged `--settings` from `oneSettings`, the run's env, and the appended system prompt that must not vary): `docs/architecture/todos.md`, `docs/architecture/vault.md`, `docs/architecture/pause-resume.md`, `docs/architecture/computer-use.md`, `docs/architecture/codex.md`.
- Everything else: root `CLAUDE.md` ("Running claude" and "Single chats vs. groups"), plus the doc of the feature being changed (see "Docs by area" there).
