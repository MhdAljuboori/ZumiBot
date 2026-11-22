# Chat To-dos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-chat to-do list, shown in the side panel, that agents fill and tick through ZumiBot's own MCP tools and that the user ticks and removes, with the agent told the list's state on its next turn.

**Architecture:** The list lives in `chats/<id>.todos.json`, read and written through `ChatStore` like the side-question file, with a `TodoService` doing every change and broadcasting `todos:changed`. Agents reach it through a per-attempt stdio MCP bridge (`zumibot_todos`) over a Unix-socket IPC with a capability token, copied from the `zumibot_browser` pattern. `ChatService.agentTurn` adds the fixed system paragraph, the state note and the bridge to every turn, auto-allows the tools, hides their tool rows and stamps a `todos` touch on the reply.

**Tech Stack:** TypeScript, Node 22, `@modelcontextprotocol/sdk` (already a dependency), React 19, vitest, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-04-chat-todos-design.md`

## Global Constraints

- **Start point:** the working tree holds someone else's uncommitted routine-command work (`forRoutine`, `commandResolver.ts`, `rpc/handlers.ts`, routine editor). Start only after it is committed, on a branch from that commit. Do not build beside it.
- **No commits** unless the user asks (user's global rule). Each task ends with its tests green instead of a commit.
- The MCP server name is `zumibot_todos`. The tools are `list`, `add`, `check`, `remove`, seen by the agent as `mcp__zumibot_todos__list` etc.
- Item text: one line, at most 300 characters. At most 50 items per `add`. At most 200 open items per chat. Done and removed items have no cap and are never pruned.
- Panel Done section shows the newest 100, then "Show more". Undo shows about 6 seconds.
- `todo` is a reserved command name, like `btw`.
- Routine runs never set `todo`, and `/todo` in a routine prompt stays plain text.
- The to-do tools never show an approval card, are never stored as a rule and never get a Jev risk hint.
- Every agent gets the to-do MCP server on every attempt, side runs included (prompt-cache prefix).
- The capability token and item text never go into logs, URLs, error messages or notification payloads.
- Comments are short and say why (repo convention). Dependencies stay pinned; add none.
- Don't touch anything the user didn't ask to change.

## Review Focus

1. **The user ticks while the agent's turn runs.** Both writes go through the store queue: nothing is lost, `rev` rises once per change, and the agent's next tool result shows the user's tick. Test: Task 3, `serializes a user tick and an agent add`.
2. **Agent text that is long, multi-line or raw HTML.** Stored as one line cut to 300 characters. The panel renders it as sanitised inline markdown: no images, no block elements. Tests: Task 2 `normalizes text`, Task 8 `inline only`.
3. **The chat is deleted while a bridge call is in flight.** The call fails with a plain error and no file is recreated. Test: Task 3, `refuses a change to a deleted chat`.
4. **Undo after another device already changed the item.** `restore` of an item that is not removed changes nothing and does not bump `rev`. Test: Task 2, `restore is a no-op on a live item`.
5. **`/todo` look-alikes.** `/todos x`, `x /todo` and `/todo` inside `/btw …` are not to-do requests. A bare `/todo` is: the agent gets the request line with empty text. Test: Task 2, `splitTodo`.

---

### Task 1: Real-CLI spike (throwaway)

Settles three facts the plan depends on. No product code.

**Files:**
- Create (scratch, outside the repo): a 40-line stdio MCP server exposing one tool `list`, an `--mcp-config` JSON for it, a temp agents dir with two agents (one plain, one with `tools: Read, mcp__zumibot_todos__list`).
- Modify: `docs/superpowers/specs/2026-11-04-chat-todos-design.md`, adding a short "Spike results" section at the end.

- [ ] **Step 1:** Run the real `claude -p --agent plain --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode manual` with **two** `--mcp-config` flags: the scratch server plus a second dummy server. Ask it to call `mcp__zumibot_todos__list`. Record whether both servers load (the `init` event's `mcp_servers` / `tools`).
- [ ] **Step 2:** In the same run, record that a `can_use_tool` control request arrives for the MCP tool, and that answering `allowResponse(requestId, input)` lets it run. Repeat with `--permission-mode auto`.
- [ ] **Step 3:** Run the agent with the `tools:` list and record whether `mcp__zumibot_todos__list` is in its tools.
- [ ] **Step 4:** Write the three answers into "Spike results". Two rules for later tasks:
  - **Two `--mcp-config` flags:** if they don't both load, Task 6 merges the browser's and the to-do server's `mcpServers` into one JSON.
  - **`tools:` lists:** if an MCP name in one is ignored, Task 10 hides `/todo` for agents with a `tools:` list instead of adding names.

### Task 2: Shared model and pure operations

**Files:**
- Create: `zumi-bot-server/shared/src/todos.ts`
- Modify: `zumi-bot-server/shared/src/commands.ts` (`todos` flag, reserved `todo`)
- Modify: `zumi-bot-server/shared/src/types.ts` (user item `todo?: true`, `todos?: TodoTouch` on the item intersection beside `memory`, `QueuedTask.todo?: true`)
- Test: `zumi-bot-server/shared/tests/todos.test.ts`, `zumi-bot-server/shared/tests/commands.test.ts`

**Interfaces (Produces):**
```ts
export const TODO_NAME = 'todo'
export const TODO_TEXT_MAX = 300, TODO_ADD_MAX = 50, TODO_OPEN_MAX = 200, TODO_DONE_SHOWN = 100
export const TODO_TOOLS = ['mcp__zumibot_todos__list', 'mcp__zumibot_todos__add', 'mcp__zumibot_todos__check', 'mcp__zumibot_todos__remove'] as const
export type TodoBy = 'user' | string            // agent name otherwise
export type TodoAction = 'added' | 'ticked' | 'unticked' | 'removed' | 'restored'
export interface TodoSource { turn: string; itemId: string | null; label: string; at: number }
export interface TodoItem {
  id: string; text: string; group: string | null; from: TodoSource; addedBy: string
  done: { at: number; by: TodoBy } | null; removed: { at: number; by: TodoBy } | null
  last: { action: TodoAction; by: TodoBy; at: number }; rev: number; updatedAt: number
}
export interface TodoFile { v: 1; rev: number; items: TodoItem[]; seen: Record<string, number> }
export interface TodoTouch { added: number; ticked: string[]; unticked: string[]; removed: string[] } // texts
export const emptyTodos = (): TodoFile
export function splitTodo(text: string): { todo: boolean; rest: string }
export function normalizeTodoText(text: string): string
export function addTodos(f: TodoFile, input: { text: string; group?: string | null }[], by: string, from: TodoSource, now: number, newId: () => string): { file: TodoFile; added: TodoItem[]; skipped: string[] }
export function checkTodos(f: TodoFile, ids: string[], done: boolean, by: TodoBy, now: number): { file: TodoFile; changed: TodoItem[] }
export function removeTodos(f: TodoFile, ids: string[], by: TodoBy, now: number): { file: TodoFile; changed: TodoItem[] }
export function restoreTodos(f: TodoFile, ids: string[], by: TodoBy, now: number): { file: TodoFile; changed: TodoItem[] }
export function liveTodos(f: TodoFile): TodoItem[]          // not removed
export function openTodos(f: TodoFile): TodoItem[]          // not removed, not done
export function changesSince(f: TodoFile, rev: number, except: string): TodoItem[] // item.rev > rev and item.last.by !== except
export function withTodoTools(tools: string[] | null): string[] | null // null stays null; else adds TODO_TOOLS once
```
`AgentCommand`, `CommandSummary` and `SentCommand` each gain `todos?: true`.

- [ ] **Step 1: Write the failing tests**
```ts
test('splitTodo', () => {
  expect(splitTodo('/todo /my-day')).toEqual({ todo: true, rest: '/my-day' })
  expect(splitTodo('/todo')).toEqual({ todo: true, rest: '' })
  expect(splitTodo('/todo\n  hi')).toEqual({ todo: true, rest: 'hi' })
  expect(splitTodo('/todos x').todo).toBe(false)
  expect(splitTodo('x /todo').todo).toBe(false)
  expect(splitTodo(' /todo x').todo).toBe(false) // index 0 only, like leadingCommand
})
test('normalizes text', () => {
  expect(normalizeTodoText('  a\nb\r\n c ')).toBe('a b c')
  expect(normalizeTodoText('x'.repeat(400))).toHaveLength(300)
})
test('add skips an open item with the same text and caps', () => {
  // second add of ' Reply to Morjan ' is in skipped, not added; a done item with that text does not block a new one
  // 51 inputs throws 'At most 50 items per add'; reaching 201 open throws 'This chat has 200 open to-dos'
})
test('add bumps rev once per call and stamps every item with it', ...)
test('check, untick and remove set done/removed and last', ...)
test('restore is a no-op on a live item', () => {
  // restoreTodos on an item with removed === null: changed is [], file.rev unchanged
})
test('changesSince leaves out the reader\'s own changes', ...)
test('withTodoTools', () => {
  expect(withTodoTools(null)).toBeNull()
  expect(withTodoTools(['Read', 'mcp__zumibot_todos__list'])).toEqual(['Read', ...TODO_TOOLS])
})
```
In `commands.test.ts`: `parseCommands` keeps `todos: true` and drops `todos: 'yes'`; `commandIssue` rejects the name `todo` with `` `/todo is built in` ``.

- [ ] **Step 2:** Run `npx vitest run --project shared` and expect the new tests to FAIL.
- [ ] **Step 3:** Implement `todos.ts` and the `commands.ts` and `types.ts` changes. `splitTodo` uses `/^\/todo(?=\s|$)/`; the rest is trimmed. Group text is normalized like item text and capped at 60 characters.
- [ ] **Step 4:** Run `npx vitest run --project shared` and `npm run typecheck`. Expect PASS.

### Task 3: Store file and TodoService

**Files:**
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts`
  - add `todosPath(id)` (`${id}.todos.json`, same `ID_RE` check);
  - add `loadTodos(id): Promise<TodoFile>` and `updateTodos(id, fn: (f: TodoFile) => TodoFile): Promise<TodoFile>`, both inside `this.run`;
  - delete the file in `delete`;
  - in `renameAgent`, rewrite `addedBy`, `done.by`, `removed.by`, `last.by` and the `seen` key;
  - write mode 0600.
- Create: `zumi-bot-server/backend/src/core/todos/todoService.ts`
- Test: `zumi-bot-server/backend/tests/core/chatStore.test.ts`, `zumi-bot-server/backend/tests/core/todoService.test.ts`

**Interfaces (Produces):**
```ts
export interface TodoServiceDeps { store: Pick<ChatStore, 'get' | 'loadTodos' | 'updateTodos'>; now(): number; newId(): string; onChanged(chatId: string, rev: number): void }
export class TodoService {
  list(chatId: string): Promise<{ rev: number; items: TodoItem[] }>                 // liveTodos
  userCheck(chatId: string, ids: string[], done: boolean): Promise<void>
  userRemove(chatId: string, ids: string[]): Promise<void>
  userRestore(chatId: string, ids: string[]): Promise<void>
  // Agent side, called by the IPC; `turn` is the logical turn key that collects the touch.
  agentList(chatId: string, agent: string): Promise<string>                          // the tool's text answer
  agentAdd(chatId: string, agent: string, turn: string, label: string, items: { text: string; group?: string | null }[]): Promise<string>
  agentCheck(chatId: string, agent: string, turn: string, ids: string[], done: boolean): Promise<string>
  agentRemove(chatId: string, agent: string, turn: string, ids: string[]): Promise<string>
  touch(turn: string): TodoTouch | null                                              // null when nothing changed
  settle(chatId: string, turn: string, itemId: string | null): Promise<void>        // fills from.itemId of items added by `turn`
  markSeen(chatId: string, agent: string): Promise<void>
  note(chatId: string, agent: string, o: { force: boolean; asked: boolean }): Promise<string | null>
  endTurn(turn: string): void                                                        // drops the touch record
}
```
`note` returns null when there's nothing to say: `!force && !asked && rev <= seen[agent]` and no changes by others. Otherwise it returns a block headed `To-do list of this chat (ids are for the zumibot_todos tools only):`:
- the open items as `- [id] (group) text`;
- `Since your last turn:` lines (`ticked by the user: …`, `removed by Planner: …`) built from `changesSince`.
Past 4 000 characters it cuts the lines and ends with `More items: call list.`. Every agent tool answer ends with the open list in the same short form.

- [ ] **Step 1: Write the failing tests**
  - `chatStore.test.ts`:
    - `todos file is created on first update, 0600, removed with the chat`;
    - `renameAgent moves to-do names and seen`.
  - `todoService.test.ts`:
    - `serializes a user tick and an agent add`: start both without awaiting. `rev` is 2, both changes are present, and `onChanged` was called twice in order.
    - `refuses a change to a deleted chat`: `store.get` returns undefined, so it rejects with `'Chat not found'` and `updateTodos` is never called.
    - `touch collects added count and ticked/removed texts for one turn only`.
    - `note is null when nothing changed since seen, and lists the user's tick after it`.
    - `note with force lists open items even when seen is current`.
    - `note is cut past 4000 characters`.
    - `settle sets itemId on that turn's items only`.
- [ ] **Step 2:** Run `npx vitest run --project backend -t "todo"` and expect FAIL.
- [ ] **Step 3:** Implement. The `touch` map is in memory only, keyed by turn.
- [ ] **Step 4:** Run `npx vitest run --project backend` and expect PASS.

### Task 4: RPC, API contract and the event

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts`. `ZumiBotApi` gains:
  ```ts
  todos: { list(chatId): Promise<{ rev: number; items: TodoItem[] }>; check(chatId, ids: string[], done: boolean): Promise<void>; remove(chatId, ids): Promise<void>; restore(chatId, ids): Promise<void>; onChanged(cb: (chatId: string, rev: number) => void): () => void }
  ```
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts`. Add `'todos:list' | 'todos:check' | 'todos:remove' | 'todos:restore'`, checking args with the existing `str()`. Ids go through a new `ids()` that allows 1–200 strings of at most 64 chars each; `done` must be a boolean.
- Modify: `zumi-bot-server/backend/src/app.ts`. Build `TodoService` with `onChanged: (chatId, rev) => hub.broadcast({ event: 'todos:changed', payload: { chatId, rev } })` and pass it to the handlers.
- Modify: `zumi-bot-server/frontend/src/net/api.ts`. Add the mapping; `onChanged` uses `rpc.on('todos:changed', …)`.
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `todos:check rejects a non-boolean done`.
  - `todos:remove rejects 201 ids`.
  - `todos:list returns live items only`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run --project backend` and `npm run typecheck`. Expect PASS.

### Task 5: The MCP bridge and its IPC

**Files:**
- Create: `zumi-bot-server/backend/src/core/todos/todoTools.ts`. Holds the four tool definitions (name, description, JSON input schema), `parseTodoCall(name: string, args: unknown): TodoCall`, which throws on bad input, and the per-tool description text that tells the agent the rules from the spec's "fixed paragraph" in one sentence each.
- Create: `zumi-bot-server/backend/src/core/todos/todoIpc.ts`. Provides `serveTodoIpc({ service, socketPath? })`, which returns `{ socketPath, createTodoTurn(owner: TodoOwner): TodoTurn, close() }`.
  - `TodoOwner = { chatId: string; agent: () => string; turn: string; label: string }`.
  - `TodoTurn = { args: string[]; env: NodeJS.ProcessEnv; dispose(): void }`.
  - Copy `browserIpc.ts`'s hardening as it is: owned 0700 dir, 0600 socket, auth line within 5 s, `requestLimit` 65536, pending limit 16, `exact()` key checks.
  - The token comes from `randomBytes(32).toString('hex')`, lives in a `Map<token, TodoOwner>` and is revoked in `dispose`.
  - Env keys: `ZUMIBOT_TODOS_CAPABILITY` and `ZUMIBOT_TODOS_IPC`.
  - `args` is `['--mcp-config', JSON.stringify({ mcpServers: { zumibot_todos: { type: 'stdio', command: node, args: [bridgeEntry], env: { ZUMIBOT_TODOS_CAPABILITY: '${ZUMIBOT_TODOS_CAPABILITY}', ZUMIBOT_TODOS_IPC: '${ZUMIBOT_TODOS_IPC}', ...(electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } } } })]`.
- Create: `zumi-bot-server/backend/src/core/todos/todoBridge.ts`. A stdio MCP `Server` named `zumibot_todos`: ListTools returns `todoTools`, and CallTool sends `{type:'run', id, call}` over IPC and returns `{ content: [{ type: 'text', text }] }`, with `isError: true` and the service's plain message on failure.
- Modify: `zumi-bot-server/backend/vite.config.ts` (add `todoBridge` input) and `backend/src/core/browser/browserRuntime.ts` (add `todoBridgeEntry: entry('todoBridge')` to the runtime and to its readable-files check).
- Modify: `zumi-bot-server/backend/src/app.ts` (start `serveTodoIpc` beside the browser IPC and close it on server stop).
- Test: `zumi-bot-server/backend/tests/core/todoIpc.test.ts`, `zumi-bot-server/backend/tests/core/todoBridge.test.ts`, `zumi-bot-server/backend/tests/browserPackaging.test.ts` (the built `todoBridge.mjs` exists)

- [ ] **Step 1: Write the failing tests.**
  - `todoIpc.test.ts`:
    - `rejects a wrong token`;
    - `rejects a line over the limit before parsing`;
    - `a revoked turn's socket is closed`;
    - `a call runs as the turn's chat and agent and cannot name another chat` (a `chatId` key in the call is refused by `exact()`);
    - `the service error text reaches the caller, nothing else`.
  - `todoBridge.test.ts`:
    - spawn the bridge entry with a fake IPC;
    - `tools/list` returns the four names;
    - `tools/call add` with 51 items returns `isError` and `At most 50 items per add`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run --project backend` and `npm run build:server`. Expect PASS, and `backend/dist/todoBridge.mjs` exists.

### Task 6: Wire the to-dos into every agent turn

**Files:**
- Create: `zumi-bot-server/backend/src/core/todos/todoPrompt.ts`. Exports `TODO_SYSTEM` (the spec's fixed paragraph, one string), `TODO_REQUEST` (the request line) and `withTrailingText(content: UserContent, text: string): UserContent`, which appends to a string with a blank line or adds a text block to a block array.
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`:
  - **Deps:** `todos?: Pick<TodoService, 'note' | 'markSeen' | 'touch' | 'settle' | 'endTurn'>` and `todoTurns?: { create(owner: TodoOwner): TodoTurn }`.
  - **Turn key and label, at `agentTurn` start:** the logical turn key is `const todoKey = randomUUID()`, shared by every attempt of this turn so a reseed retry adds to the same touch. The label comes from the latest user item in `history`: `/${command.name}` when it has a command, otherwise the first 40 characters of `splitTodo(text).rest`.
  - **System prompt:** `system` gains `TODO_SYSTEM` when `this.d.todoTurns` is set, so side runs inherit it through `sideBase.args.appendSystemPrompt`.
  - **State note (not for `spec.compact`):**
    - `const note = await todos.note(chatId, agent, { force: spec.sessionId === null || !!spec.reseed, asked })`, where `asked` is true when the user item that started this turn has `todo`. In a room, `asked` is true when any user item after the member's `seen` has `todo`.
    - Pass it as a new optional `spec.todoAsked`, set by the callers in Task 7.
    - The CLI gets `withTrailingText(spec.prompt, note)`. A reseed gets `withTrailingText(spec.seedPrompt(history), forcedNote)`, where `forcedNote` comes from a second `note` call with `force: true`.
  - **Per attempt:** next to the browser block, `const todoTurn = this.d.todoTurns?.create({ chatId, agent: ruleAgent, turn: todoKey, label })`.
    - Its `args` go into `extraArgs` (merged per the Task 1 result).
    - Its `env` merges with the browser's.
    - Its token joins `browserSecrets`.
    - `dispose` runs in the attempt's `finally`.
  - **Permissions:** `const todoTool = (n: string) => n.startsWith('mcp__zumibot_todos__')`. In `permissionRequest`, first: if `todoTool(e.toolName)`, then `reply(allowResponse(e.requestId, e.input))` and `break`. No card, no rule, no risk.
  - **Tool rows:** in `toolUse` and `toolResult`, skip `todoTool` names entirely: no row and no memory accounting.
  - **`finally`, after the memory touch:**
    - `const t = todos.touch(todoKey)`. When `t` is set and `lastWork !== null`, set `todos: t` on that item.
    - `await todos.settle(chatId, todoKey, lastWork)`. It is the same item the touch lands on, so the chip and Show in chat point at one reply.
    - When an attempt was spawned and the turn is not compact, `await todos.markSeen(chatId, agent)`.
    - Then `todos.endTurn(todoKey)`.
    - Each runs through `finishStep`.
  - **`sideBrowser`:** returns the browser turn merged with a fresh to-do turn (args concatenated or merged per Task 1, env merged, dispose both), and still returns a to-do-only turn when there is no browser. `sideBase.browser` becomes true when either exists.
- Modify: `zumi-bot-server/backend/src/app.ts` (pass `todos` and `todoTurns`).
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`, `zumi-bot-server/backend/tests/core/todoPrompt.test.ts`

- [ ] **Step 1: Write the failing tests** (fake runner and fake `todoTurns`, as the browser tests do):
  - `adds TODO_SYSTEM and the to-do mcp args on every attempt, also when the agent never used them`.
  - `a can_use_tool for mcp__zumibot_todos__add is allowed with no approval item, in manual mode`.
  - `to-do tool_use and tool_result add no tool row`.
  - `the turn's todos touch lands on its last assistant item`.
  - `a user tick before the turn puts the state note on stdin; an unchanged list puts none`.
  - `a reseed gets the forced note`.
  - `markSeen runs after a spawned attempt and not after a spawn error`.
  - `compact turns get no note`.
  - `the capability env value never appears in a logged error` (spawn error path).
  - `todoPrompt.test.ts`: `withTrailingText` on a string, and on blocks with an image.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run --project backend` and expect PASS (existing browser and btw tests included).

### Task 7: `/todo` from the composer to the agent

**Files:**
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts`:
  - `chats:send`: `const { todo, rest } = splitTodo(body)`, then `const command = await commands.forSend(id, rest, pick)`. It passes `todo || command?.todos === true` to `tasks.submit` as a new last parameter, only when true.
  - `chats:edit`: the same, from the new body.
  - `chats:resend`: passes nothing; the services keep the old item's `todo`.
- Modify: `zumi-bot-server/backend/src/core/chat/commandResolver.ts`:
  - `built()` copies `todos: true` from the agent command.
  - `forRerun` resolves on `splitTodo(body).rest`.
  - `forRoutine` is unchanged: routines pass no `todo`.
- Modify: `zumi-bot-server/backend/src/core/chat/taskQueue.ts`:
  - `submit`, `rerun` and `launch` take an optional trailing `todo?: true`;
  - `QueuedTask` stores it;
  - keep the "no trailing undefined" rule: only append it when set.
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` and `zumi-bot-server/backend/src/core/chat/groupService.ts`:
  - `send` / `rerun` / `sendTurn` / `rerunTurn` / `post` / `rerunPost` take `todo?: true` and put `todo: true` on the user item.
  - A rerun with `text === null` keeps `old.todo`.
  - They set `spec.todoAsked`. Single chat: `user.todo === true`. Room: any user item in `threadEntries(…)` since `seen` has `todo`.
- Modify: `zumi-bot-server/backend/src/core/chat/commandText.ts`. `readAs(user, reader)` reads the command prompt if it's the reader's own command, otherwise `splitTodo(user.text).rest` when `user.todo`, otherwise `user.text`. When `user.todo` it then appends `\n\n${TODO_REQUEST}`. `withCommands` maps every user item that has the reader's command or `todo` through `readAs`.
- Test: `zumi-bot-server/backend/tests/core/commandText.test.ts`, `zumi-bot-server/backend/tests/core/commandResolver.test.ts`, `zumi-bot-server/backend/tests/rpc/handlers.test.ts`, `zumi-bot-server/backend/tests/core/taskQueue.test.ts` (or wherever `submit` is tested now), `zumi-bot-server/backend/tests/core/groupService.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `'/todo /my-day' resolves my-day and stores todo: true with text kept as typed`.
  - `a flagged command without /todo stores todo: true`.
  - `a routine run of a flagged command stores no todo`: `RoutineRunner` → `tasks.submit` without a `todo` argument.
  - `resend keeps todo, edit to plain text drops it`.
  - `readAs strips /todo and appends TODO_REQUEST for every reader; the moderator path (text) is unchanged`.
  - `a queued /todo message keeps todo when it starts`.
  - `in a room, the member answering a /todo message gets todoAsked; a member whose seen is past it does not`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` and expect PASS.

### Task 8: The To-dos panel

**Files:**
- Create: `zumi-bot-server/frontend/src/state/todosPanel.ts`. Pure logic:
  ```ts
  export interface TodoGroupView { key: string; label: string; at: number; itemId: string | null; showInChat: boolean; sections: { heading: string | null; items: TodoItem[] }[] }
  export function panelView(items: TodoItem[], visibleIds: ReadonlySet<string>): { open: TodoGroupView[]; done: TodoItem[]; left: number }
  export function doneShown(done: TodoItem[], expanded: boolean): TodoItem[]  // newest 100 unless expanded
  export function tickedByLabel(item: TodoItem, room: boolean): string | null // 'by agent', member display name in a room, null for the user
  ```
  - Groups are keyed by `from.turn`, newest `from.at` first.
  - Sections keep first-appearance order of `group`; items keep add order.
  - `done` is sorted newest `done.at` first.
  - `showInChat` is `itemId !== null && visibleIds.has(itemId)`.
- Create: `zumi-bot-server/frontend/src/components/useTodos.ts`. Loads `api.todos.list(chatId)`, refetches on `onChanged` for that chat and on reconnect, and exposes `{ items, failed, retry }`.
- Create: `zumi-bot-server/frontend/src/components/TodosPanel.tsx`. Same frame as `SidePanel.tsx` (`files-panel side-panel` classes, `SideBackButton`, ✕, Esc).
  - Header: `To-dos · {left} left`.
  - Groups with label, time and **Show in chat**; headings; rows with a checkbox, inline text and ✕.
  - **Undo:** the toast calls `api.todos.restore` within 6 s.
  - **Done fold:** `Done · N`. Its open state is stored in `localStorage` key `zumibot.todos.doneOpen`, wrapped in try/catch.
  - **Empty state:** `No to-dos yet. Start a message with /todo to make one.`
  - **Item text:** `Markdown` in an inline mode that renders links and emphasis only. If `Markdown` has no inline mode, add a prop that maps block elements to spans and drops images.
- Modify: `zumi-bot-server/frontend/src/state/sidePanel.ts`. `SideView` gains `'todos'`, and `chatViews` includes it.
- Modify: `zumi-bot-server/frontend/src/components/SidePanelMenu.tsx`. Add an **Open To-dos** item (`data-testid="side-open-todos"`) with `{left} left` when left > 0.
- Modify: `zumi-bot-server/frontend/src/App.tsx`. Render `TodosPanel` for `side === 'todos'` the same way as `'btw'`, including the phone sheet. Add `todosFocus` (a group key) for the chip in Task 9.
- Modify: `zumi-bot-server/frontend/src/styles.css`.
- Test: `zumi-bot-server/frontend/tests/todosPanel.test.ts`, `zumi-bot-server/frontend/tests/sidePanel.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `groups newest first, sections in first-seen order`.
  - `ticked items leave their group for done, newest done first`.
  - `showInChat false when the reply is not visible`.
  - `doneShown caps at 100 until expanded`.
  - `tickedByLabel: user null, agent 'by agent', room member name`.
  - `closeSide on 'todos' brings a browser back`.
  - `inline only`: a pure helper `inlineTodoText`, or the `Markdown` inline prop's element map, turns `![x](y)`, `# h` and `<b>` into plain text, and keeps `[a](https://b)` as a link.
- [ ] **Step 2:** Run `npx vitest run --project frontend` and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run --project frontend`, `npm run typecheck` and `npm run build:server`. Expect PASS.

### Task 9: Composer `/todo`, bubble chip and reply lines

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/commandInput.ts`:
  - `CommandOption` gains `{ builtin: 'todo'; description: string }` (description: `Put this reply's action items on the chat's to-do list`).
  - `filterCommands(query, agents, opts?: { afterTodo?: boolean })` lists the `todo` builtin at the top level only. After `/todo ` it lists agent commands only (no `btw`, no `todo`), and drops `todo` from agent lists like `btw`.
  - `slashQuery` accepts `^(?:\/todo\s+)?\/([a-z0-9-]*)$` and reports `afterTodo`. Change the signature to return `{ query: string; afterTodo: boolean } | null` and update its callers in `Composer.tsx`, `MessageEditor.tsx` and `PromptField.tsx`. `PromptField` (the routine editor) never offers `todo`.
  - `insertCommandName` keeps a leading `/todo ` before the inserted name.
  - `keepPick` reads `leadingCommand(splitTodo(text).rest)`.
  - Commands with `todos` show a ☑ mark in `CommandMenu.tsx`.
- Modify: `zumi-bot-server/frontend/src/state/commandBubble.ts` and `zumi-bot-server/frontend/src/components/CommandBubble.tsx` / `UserText.tsx`. A user item with `todo` shows a `/todo` chip, then the command chip when present, using `startsWithCommand` on the rest.
- Create: `zumi-bot-server/frontend/src/state/todoLine.ts`. `todoLines(touch: TodoTouch | undefined, roomAgent: string | null): { chip: string | null; lines: string[] }`:
  - `chip` is `☑ ${added} new to-do${added === 1 ? '' : 's'}`;
  - lines are `☑ Ticked: x`, `☐ Unticked: x` and `✕ Removed: x`;
  - in a room each is prefixed with `${roomAgent}: `.
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx`. Render them under the reply beside the memory line. The chip calls a new `onOpenTodos(turnKey)` prop. The item stores no turn key, so the chip opens the panel scrolled to the group whose `from.itemId` equals this item's id.
- Test: `zumi-bot-server/frontend/tests/commandInput.test.ts`, `zumi-bot-server/frontend/tests/commandBubble.test.ts`, `zumi-bot-server/frontend/tests/todoLine.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `slashQuery('/todo /my', true)` returns `{ query: 'my', afterTodo: true }`.
  - `slashQuery('/to', true)` returns `{ query: 'to', afterTodo: false }`.
  - `filterCommands('', agents, { afterTodo: true })` has no builtins.
  - `insertCommandName('/todo /m', 8, 'my-day')` returns `{ text: '/todo /my-day ', caret: 14 }`.
  - `keepPick('/todo /my-day x', { agent: 'work-assistant', name: 'my-day' })` keeps the pick.
  - `todoLines`: 1 added gives `'☑ 1 new to-do'`, and room lines are prefixed.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run --project frontend` and `npm run typecheck`. Expect PASS.

### Task 10: Command flag in Agent Studio, tools lists, Zumi Bot

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/CommandsCard.tsx`. A per-row **Makes to-dos** checkbox writes `todos: true`, or omits the key when unticked.
- Modify: the agent-file writer that serializes `commands` (find it from `parseCommands` callers, in `shared/src/frontmatter.ts` or `agentStore.ts`). It writes `todos: true` after `description` and before `prompt: |`.
- Modify: the `agents:save` path. Tools go through `withTodoTools` before writing, so any non-empty `tools:` list gets the four names. `ToolsPicker.tsx` leaves `TODO_TOOLS` out of its visible list.
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts`. Add the five rules from the spec's "Zumi Bot" section to the commands rules near "Never name a command `btw`". Also add one line to the `tools` rule: "When you write a `tools` list, also add `mcp__zumibot_todos__list, mcp__zumibot_todos__add, mcp__zumibot_todos__check, mcp__zumibot_todos__remove`."
- If Task 1 found that MCP names in `tools:` are ignored, swap the two bullets above for two others:
  - `filterCommands` hides the `todo` builtin for an agent with a `tools` list;
  - the server ignores `todo` for such an agent.
- Test: `zumi-bot-server/backend/tests/core/zumiBot.test.ts`, `zumi-bot-server/shared/tests/frontmatter.test.ts`, `zumi-bot-server/backend/tests/core/agentStore.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `the Zumi Bot prompt names todos: true, the reserved /todo and the four tool names`.
  - `a command with todos round-trips through write and parse with prompt still a block scalar`.
  - `saving tools [Read] writes Read plus the four to-do tools; saving no tools writes no tools key`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` and expect PASS.

### Task 11: Fork and sync

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/fork.ts`. After the side questions, load the source list and keep the items with `!removed && from.itemId !== null && keep.has(from.itemId)`. Write them with `seen: {}` and `rev` kept. Room clone stays untouched (no list).
- Modify: `zumi-bot-server/deploy/sync.mjs`. Add an exported `mergeTodos(local, vps)` beside `mergeSide`:
  - union by `id`;
  - per item, the later `updatedAt` wins (tombstones included), with a tie going to this PC;
  - `rev` = max of both + 1;
  - `seen[agent]` = min of both, absent when either side lacks it.
  - Add `todos.json` to the copy-chat loop (a copy chat gets the whole list), to the `fromVps` copy list, and a `todoWrites` pass after `fromVps`, like `sideWrites`.
- Test: `zumi-bot-server/backend/tests/core/fork.test.ts`, `zumi-bot-server/backend/tests/sync.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `fork at an earlier message copies only items whose source reply was copied, ticks kept, tombstones dropped, seen empty`.
  - `fork at the last message copies every live item`.
  - `clone room has no todos file`.
  - `mergeTodos keeps a removal made on either side`.
  - `mergeTodos later updatedAt wins a tick/untick race`.
  - `mergeTodos seen takes the smaller rev`.
  - `sync writes the joined todos file for a chat on both sides and copies one only on the VPS`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` and expect PASS.

### Task 12: End-to-end

**Files:**
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-claude.mjs`. Add the directive `#MCP_CALL {"server": "...", "tool": "...", "args": {...}, "id": "toolu_x"}`:
  - Read `--mcp-config` values from `process.argv`, find the named server and spawn it with its `command`, `args` and `env` (expanding `${VAR}` from `process.env`).
  - Speak JSON-RPC over its stdio: `initialize`, `notifications/initialized`, `tools/call`.
  - Write an assistant `tool_use` line with that id, then a user `tool_result` line with the returned text and `is_error`.
  - Keep one spawned server per name for the run.
- Create: `zumi-bot-server/e2e/todos.e2e.mjs`. Script files follow `files.e2e.mjs`. Each turn's script has a `can_use_tool` control request for the to-do tool plus `#WAIT_RESPONSE`, then `#MCP_CALL`. It checks, in order:
  1. **`/todo` turn.** A `/todo /my-day` send with a flagged `my-day` command on the test agent adds 3 items. The panel shows them under `/my-day`. The reply has `☑ 3 new to-dos`. No approval card appeared.
  2. **User tick reaches the agent.** Tick one in the panel. The next turn's `FAKE_STDIN_OUT` contains `ticked by the user` and the item text.
  3. **Agent tick.** An agent `check` turn shows `☑ Ticked:` under its reply, and the panel shows `by agent` in Done.
  4. **Remove and Undo.** ✕ removes, Undo brings the item back, a second ✕ keeps it removed.
  5. **Flag only.** A plain `/my-day` (flag on, no `/todo`) puts `TODO_REQUEST` on stdin.
  6. **Fork and clone.** Fork copies the list. Clone room (a room variant) starts empty.
  7. **Persistence.** The list survives a reload.
  8. **Second device.** A second browser context sees a tick live.
- Modify: `package.json` (root). Add `"e2e:todos": "npm run build && node zumi-bot-server/e2e/todos.e2e.mjs"`.
- Modify: `zumi-bot-server/e2e/web.e2e.mjs` (real CLI). Add one probe turn asking the agent to call `mcp__zumibot_todos__list` and asserting no approval card and no tool row. Add a second probe with a temp agent whose `tools:` list names the to-do tools, unless Task 1 ruled that out.

- [ ] **Step 1:** Write `todos.e2e.mjs` and the fake-claude directive.
- [ ] **Step 2:** Run `npm run e2e:todos` and expect PASS (headless system Chrome, no quota).
- [ ] **Step 3:** Run `npm run e2e:btw`, `npm run e2e:files` and `npm run e2e:commands` (all fake). Expect PASS: side runs still get the same args, and command chips still work.
- [ ] **Step 4:** Ask the user before running `npm run e2e`, since it uses the real CLI and quota. Run it on their yes and expect PASS.

### Task 13: Docs and the user's agents

**Files:**
- Modify: `CLAUDE.md`:
  - a **To-dos** paragraph in Architecture: file, service, bridge, auto-allow, note, `/todo`, flag, panel and sync rule;
  - `chats/<id>.todos.json` in Data;
  - `e2e:todos` in the e2e list;
  - the `sync.mjs` paragraph's file list.
- Modify (outside the repo, after the build passes): `~/.claude/agents/work-assistant.md`. Add `todos: true` to `my-day`, `check-inbox`, `slack-catch-up` and `workiom-notifications`, then read it back and check every `prompt: |` is intact.
- Modify (outside the repo): `~/.claude/agents/structure-reviewer.md` and `~/.claude/agents/ui-ux-specialist.md`. Append the four to-do tool names to `tools:`, unless Task 1 ruled that out.

- [ ] **Step 1:** Edit the docs. Run `npm test` and `npm run typecheck`, and expect PASS.
- [ ] **Step 2:** Edit the three agent files, then check that ZumiBot's agent list still loads all three with no error: start the dev server, or run the `agentStore` parse on them in a one-off script.
- [ ] **Step 3:** Report to the user. Ask before any `bump:*`, deploy or sync (memory: bump before deploy, ask the level).
