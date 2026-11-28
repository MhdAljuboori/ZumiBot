# Hive recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents with `recall:` on get two read-only MCP tools that search and read past chats in their scope, through the existing message search index.

**Architecture:** A per-turn stdio MCP bridge `zumibot_recall` (same shape as `zumibot_processes`), attached only to runs whose agent has recall on. The server-side `RecallService` computes the scope from the token's owner (chat + speaking agent) and asks `SearchIndex` for hits restricted to the chats in scope.

**Tech Stack:** TypeScript, Node 22, `@modelcontextprotocol/sdk`, vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-28-hive-recall-design.md`

## Global Constraints

- Off by default: no `recall:` key = no bridge, no prompt paragraph, no tools.
- Values exactly `agent` or `folder`; anything else parses as off.
- The bridge carries no chat id or agent; the scope comes from the token on the server, re-read per call.
- No message text, token or path in logs or error messages.
- Exact dependency versions; no new dependency.
- Commits: none unless the user asks (user rule overrides the skill).

## Review Focus

- A chat id from another folder or agent passed to `read` → same refusal as a missing chat.
- Recall turned off after the turn started → calls refused with "Recall is off for this agent."
- Room turn of a member with recall off, other member on → that member's run has no recall bridge.
- Worktree chat → folder scope uses `worktree.folder`, so it finds chats of the picked folder.
- Index still building → hits plus a note that results may be incomplete.

---

### Task 1: Shared types, frontmatter key, agent summary

**Files:** Create `zumi-bot-server/shared/src/recall.ts`; modify `shared/src/frontmatter.ts`, `shared/src/types.ts` (`AgentSummary.recall?`), `backend/src/core/agents/agentStore.ts`, `shared/src/audit.ts` (`why: 'recall'`); tests `shared/tests/recall.test.ts`, `shared/tests/frontmatter.test.ts`.

**Produces:** `type RecallScope = 'agent' | 'folder'`, `parseRecall(v: unknown): RecallScope | null`, `RECALL_PAGE = 10`, `RECALL_SERVER = 'zumibot_recall'`, `RECALL_TOOL_PREFIX`, `recallFolderOf(c: Pick<ChatMeta,'cwd'|'worktree'>): string`, `inRecallScope(scope, agent, from: ChatMeta, c: ChatMeta): boolean`; `AgentFields.recall: RecallScope | null`.

- [ ] Tests: `parseRecall('agent'|'folder')` returns it, `'Agent'`, `true`, `null` → null; `inRecallScope` excludes `from`, agent scope matches single chats of the agent and rooms with it as member, folder scope compares `worktree.folder ?? cwd`; frontmatter round-trips `recall: folder` and deletes the key on null.
- [ ] Implement, run `npx vitest run --project shared`.

### Task 2: SearchIndex time range and searchable export

**Files:** modify `backend/src/core/search/searchIndex.ts`; test `backend/tests/core/searchIndex.test.ts` (existing file or new).

**Produces:** `search(raw, offset, listed, limit = SEARCH_PAGE, range?: { from?: number; to?: number })`; exported `searchableOf(it: ChatItem): { role, agent, ts, text } | null` (the current `metaOf`).

- [ ] Test: two matching messages at different `ts`; `range.from` keeps only the newer, `range.to` only the older.
- [ ] Implement the filter in `matching`, run the file.

### Task 3: RecallService, tools, IPC and bridge

**Files:** create `backend/src/core/recall/{recallTools.ts,recallService.ts,recallIpc.ts,recallBridge.ts,recallPrompt.ts,CLAUDE.md}`; modify `backend/vite.config.ts` (entry `recallBridge`), `backend/src/core/browser/browserRuntime.ts` (`recallBridgeEntry`); tests `backend/tests/core/recallService.test.ts`, `backend/tests/core/recallBridge.test.ts`.

**Produces:**
- `RecallCall = { op: 'search'; query: string; since?: string; until?: string; offset?: number } | { op: 'read'; chatId: string; messageId: string }`, `parseRecallCall(name, args)`, `parseRecallWire(call)`, `recallTools` (`search`, `read`).
- `RecallService({ index, store, scopeOf })` with `run(owner: { chatId: string; agent: string }, call: RecallCall): Promise<string>`.
- `serveRecallIpc({ service, socketPath?, runtime? })` → `{ socketPath, createRecallTurn(owner: RecallOwner): RecallTurn, close() }`; `RecallOwner = { chatId; agent: () => string; turn: string; side?: true }`; env `ZUMIBOT_RECALL_CAPABILITY`, `ZUMIBOT_RECALL_IPC`.
- `recallSystem(scope: RecallScope): string`.

- [ ] Service tests: search returns only in-scope hits, excludes the current chat, honours `since`/`until`, refuses when `scopeOf` is null; read returns target and up to 2 neighbours each side, refuses an out-of-scope chat with the missing-chat text.
- [ ] Bridge test (builds the backend like `processBridge.test.ts`): lists `read`, `search`; a call reaches the service with the token's chat and agent; a side owner is refused.
- [ ] Implement, run both files.

### Task 4: Wire into runs and app

**Files:** modify `backend/src/core/chat/chatService.ts`, `backend/src/app.ts`, `backend/src/core/extensions/extensionsService.ts`; test in `backend/tests/core/chatService.test.ts`.

- [ ] Deps: `recallTurns?: { create(owner: RecallOwner): RecallTurn; scopeOf(agent: string): Promise<RecallScope | null> }`.
- [ ] Per attempt, when `caps.bridges` and `scopeOf(spawnedName)` is non-null: create the turn after `proc`, add its args after `proc`'s, its env, its mcp to Codex `mcpServers` after `ask`, dispose with the others, scrub its env values; `sideBase.recall = true` so `sideBrowser` joins a side-owned one; prompt paragraph after the process one.
- [ ] Auto-allow `mcp__zumibot_recall__*` only while bridged (`why: 'recall'`).
- [ ] Test: an agent with recall on gets `--mcp-config` naming `zumibot_recall` and the paragraph; off gets neither.
- [ ] Run `npx vitest run --project backend`.

### Task 5: Agent Studio card and Zumi Bot

**Files:** modify `frontend/src/state/acpCard.ts` (`recall: c.bridges`), `frontend/src/components/AgentForm.tsx`, `frontend/tests/aguiCard.test.ts`, `backend/src/core/agents/zumiBot.ts` (one line: the key exists, set only when asked).

- [ ] Card "Recall" with Off / Own chats / This folder choices writing `fields.recall`.
- [ ] Run `npx vitest run --project frontend`.

### Task 6: Docs, typecheck, full tests

- [ ] New `docs/architecture/recall.md`, index line in root `CLAUDE.md`, pointer `core/recall/CLAUDE.md`, user page in `zumi-bot-docs`.
- [ ] `npm run typecheck` and `npm test` pass.
