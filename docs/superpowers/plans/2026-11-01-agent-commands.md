# Agent Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-agent `/` commands: written in the agent file, offered in a composer menu, sent as the command's prompt while the chat shows the short form.

**Architecture:** One shared module (`shared/src/commands.ts`) parses, validates and fills commands; the frontmatter parser carries them as an agent field. The server resolves a sent `/name` against the agent file on the user's send paths only (RPC handlers, through a `CommandResolver`), stores the result on the user item as `command`, and a small `readAs` / `withCommands` pair (same pattern as `reply.ts`) decides what each agent reads. The frontend adds a `/` menu beside the `@mention` menu, a chip + collapsed "Full prompt" on sent messages, and a Commands card in the agent editor.

**Tech Stack:** TypeScript, `yaml` (already a dependency), React 19 + Tiptap, vitest, playwright-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-01-agent-commands-design.md` — read it before any task.

## Global Constraints

- No new dependencies. Pinned versions stay as they are.
- Do not commit. The user's global rule: never commit unless they ask. Leave every task's changes in the working tree; each task ends with its tests green instead.
- Comments are short and say *why*, matching the files you touch.
- Command name pattern = `NAME_PATTERN` from `shared/src/frontmatter.ts` (`/^[a-z0-9]+(-[a-z0-9]+)*$/`). Unique within one agent.
- Placeholder is exactly `$ARGUMENTS`. With none in the prompt, the user's text is appended after a blank line (`\n\n`); with no text typed, the prompt is sent as is.
- `COMMAND_PROMPT_MAX = 8000` characters; a longer prompt makes the command invalid.
- Invalid commands are skipped, never the agent. YAML that does not parse stays a broken agent exactly as today.
- Routine prompts are never resolved as commands (resolution lives only in `chats:send`, `chats:edit`, `chats:resend`).
- A `/word` matching no command is plain text, byte-for-byte as today. Messages without `command` render as today.
- Room routing: the command's agent is added to the user's mentions; nothing else in `planQueue`, the moderator or Jev changes.
- The full prompt is collapsed by default on every render, and shown as plain text (never markdown or HTML).

## Review Focus

- User text containing `$&`, `$1` or `$$` (a pasted URL with `$`) must reach the agent unchanged: `fillPrompt` must not use `String.replace` with a string replacement. Test in Task 1.
- `/check` typed by hand (no menu pick) in a single chat must still resolve; `/Check`, ` /check` (leading space) and `/checkx` must stay plain text. Tests in Tasks 1 and 2.
- A pick whose command was removed or renamed between opening the menu and Send must be refused with a visible error, not silently sent as plain text. Test in Task 2.
- A routine whose prompt starts with `/check` in a chat whose agent owns `check` must send the literal text. Test in Task 3.
- An agent file whose `commands` is a string, a map, or holds an entry with no prompt must still list, load and run; only valid commands appear in its summary. Test in Task 2.

---

### Task 1: Shared commands module, frontmatter field and wire types

**Files:**
- Create: `zumi-bot-server/shared/src/commands.ts`
- Modify: `zumi-bot-server/shared/src/frontmatter.ts` (`AgentFields`, `fieldsOf`, `serializeAgent`)
- Modify: `zumi-bot-server/shared/src/types.ts` (`AgentSummary`, user `ChatItem`, `QueuedTask`, `ZumiBotApi.chats.send`)
- Test: `zumi-bot-server/shared/tests/commands.test.ts` (new), `zumi-bot-server/shared/tests/frontmatter.test.ts`

**Interfaces:**
- Produces (`shared/src/commands.ts`):
  - `interface AgentCommand { name: string; description: string; prompt: string }`
  - `type CommandSummary = Pick<AgentCommand, 'name' | 'description'>`
  - `interface CommandPick { agent: string; name: string }` — what the composer sends
  - `interface SentCommand { agent: string; name: string; prompt: string }` — stored on the user item; `prompt` already filled
  - `const ARGUMENTS = '$ARGUMENTS'`, `const COMMAND_PROMPT_MAX = 8000`
  - `parseCommands(v: unknown): AgentCommand[]` — not an array → `[]`; each entry: a non-object becomes all-empty strings; fields read with `String()`, missing → `''`. Lossless enough for the editor to show bad rows.
  - `commandIssue(list: readonly AgentCommand[], index: number): string | null` — first failing rule, in this order and wording: `'Name must be lowercase letters, digits and single hyphens'`, `` `Another command is already named /${name}` `` (only for a later duplicate), `'Description is required'`, `'Description must be one line'`, `'Prompt is required'`, `` `Prompt is longer than ${COMMAND_PROMPT_MAX} characters` ``.
  - `validCommands(list: readonly AgentCommand[]): AgentCommand[]` — the rows whose `commandIssue` is null, in order.
  - `leadingCommand(text: string): { name: string; args: string } | null` — matches `/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/` at index 0 of the untrimmed text; `args` = the rest, trimmed.
  - `fillPrompt(prompt: string, args: string): string`
- Produces (`frontmatter.ts`): `AgentFields.commands: AgentCommand[] | null` (null = key absent).
- Produces (`types.ts`): `AgentSummary.commands?: CommandSummary[]` (valid only; absent = none); user item `command?: SentCommand`; `QueuedTask.command?: SentCommand`; `ZumiBotApi.chats.send(chatId, text, attachmentIds?, replyTo?, messageId?, command?: CommandPick)`.

- [ ] **Step 1: Write the failing tests** in `shared/tests/commands.test.ts`:

```ts
describe('fillPrompt', () => {
  it('replaces every $ARGUMENTS', () => expect(fillPrompt('A $ARGUMENTS B $ARGUMENTS', 'x')).toBe('A x B x'))
  it('appends after a blank line when the prompt has no placeholder', () => expect(fillPrompt('Check it', 'link')).toBe('Check it\n\nlink'))
  it('sends the prompt alone when nothing was typed', () => expect(fillPrompt('Check it', '')).toBe('Check it'))
  it('keeps $ patterns in the user text', () => expect(fillPrompt('Use $ARGUMENTS', 'a$&b$1c$$')).toBe('Use a$&b$1c$$'))
})
describe('leadingCommand', () => {
  it('reads name and trimmed args', () => expect(leadingCommand('/check  https://x/1 \n more')).toEqual({ name: 'check', args: 'https://x/1 \n more' }))
  it('takes a bare command', () => expect(leadingCommand('/upgrade-check')).toEqual({ name: 'upgrade-check', args: '' }))
  it.each(['/Check x', ' /check x', 'hi /check', '/check-', '//check', '/'])('ignores %j', (t) => expect(leadingCommand(t)).toBeNull())
  it('reads a longer name as its own name', () => expect(leadingCommand('/checkx L')?.name).toBe('checkx'))
})
describe('parseCommands / commandIssue / validCommands', () => {
  it('treats a non-list as no commands', () => { expect(parseCommands('check')).toEqual([]); expect(parseCommands({ a: 1 })).toEqual([]) })
  it('keeps bad rows for the editor and skips them in validCommands', () => {
    const list = parseCommands([{ name: 'check', description: 'd', prompt: 'p' }, { name: 'check', description: 'd', prompt: 'p' }, { name: 'Fix', description: 'd', prompt: 'p' }, { name: 'x', description: 'd' }, 'junk'])
    expect(list).toHaveLength(5)
    expect(commandIssue(list, 1)).toBe('Another command is already named /check')
    expect(commandIssue(list, 2)).toBe('Name must be lowercase letters, digits and single hyphens')
    expect(commandIssue(list, 3)).toBe('Prompt is required')
    expect(validCommands(list).map((c) => c.name)).toEqual(['check'])
  })
  it('caps the prompt', () => expect(commandIssue([{ name: 'a', description: 'd', prompt: 'x'.repeat(8001) }], 0)).toBe('Prompt is longer than 8000 characters'))
  it('wants a one-line description', () => expect(commandIssue([{ name: 'a', description: 'one\ntwo', prompt: 'p' }], 0)).toBe('Description must be one line'))
})
```

  In `shared/tests/frontmatter.test.ts` add:

```ts
it('parses commands and leaves an unchanged file verbatim', () => {
  const raw = '---\nname: a\ndescription: d\ncommands:\n  - name: check\n    description: c\n    prompt: |\n      Use $ARGUMENTS\n---\nbody\n'
  const p = parseAgent(raw); if (!p.ok) throw new Error(p.error)
  expect(p.fields.commands).toEqual([{ name: 'check', description: 'c', prompt: 'Use $ARGUMENTS\n' }])
  expect(serializeAgent(raw, p.fields, 'body\n')).toBe(raw)
})
it('writes commands and removes the key when emptied', () => {
  const raw = '---\nname: a\ndescription: d\n---\nbody\n'
  const p = parseAgent(raw); if (!p.ok) throw new Error(p.error)
  const added = serializeAgent(raw, { ...p.fields, commands: [{ name: 'fix', description: 'f', prompt: 'line1\nline2' }] }, p.body)
  const back = parseAgent(added); if (!back.ok) throw new Error(back.error)
  expect(back.fields.commands).toEqual([{ name: 'fix', description: 'f', prompt: 'line1\nline2' }])
  expect(serializeAgent(added, { ...back.fields, commands: null }, back.body)).toBe(raw)
})
it('an agent whose commands is not a list still parses', () => {
  const p = parseAgent('---\nname: a\ndescription: d\ncommands: nope\n---\n')
  expect(p.ok && p.fields.commands).toEqual([])
})
```

- [ ] **Step 2: Run** `npx vitest run --project shared` — expect FAIL (module and field missing).
- [ ] **Step 3: Implement `shared/src/commands.ts`.** `fillPrompt` uses `prompt.split(ARGUMENTS).join(args)` when the placeholder is present (never `replace` with a string).
- [ ] **Step 4: Add `commands` to `AgentFields`.** `fieldsOf`: `commands: data.commands === undefined || data.commands === null ? null : parseCommands(data.commands)`. `serializeAgent`: add a `sameCommands` check to the verbatim branch; when changed, `null` or `[]` → `doc.delete('commands')`, else `doc.set('commands', doc.createNode(fields.commands))` (the `yaml` library writes multi-line prompts as block scalars). Update `NEW_AGENT_TEMPLATE` only if a test needs it (it should not).
- [ ] **Step 5: Add the `types.ts` fields** listed under Interfaces.
- [ ] **Step 6: Run** `npx vitest run --project shared` and `npm run typecheck` — expect PASS. Typecheck may flag every `AgentFields` literal (frontend/backend tests): add `commands: null` there.

---

### Task 2: Agent summaries, `commandsOf` and the resolver

**Files:**
- Modify: `zumi-bot-server/backend/src/core/agents/agentStore.ts` (`scan`, new `commandsOf`)
- Create: `zumi-bot-server/backend/src/core/chat/commandResolver.ts`
- Test: `zumi-bot-server/backend/tests/core/agentStore.test.ts`, `zumi-bot-server/backend/tests/core/commandResolver.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`parseAgent`, `validCommands`, `leadingCommand`, `fillPrompt`, `AgentCommand`, `CommandPick`, `SentCommand`).
- Produces:
  - `AgentStore.commandsOf(name: string): Promise<AgentCommand[]>` — the valid commands of the loadable agent with that name (error === null in `list()`), read fresh from its file; `[]` when none or missing.
  - `scan()` puts `commands: validCommands(...).map(({ name, description }) => ({ name, description }))` on the summary only when non-empty.
  - `class CommandResolver` with `constructor(d: { store: Pick<ChatStore, 'get' | 'loadItems'>; commandsOf(agent: string): Promise<AgentCommand[]> })`:
    - `forSend(chatId: string, text: string, pick?: CommandPick): Promise<SentCommand | undefined>`
    - `forRerun(chatId: string, userId: string, text: string | null): Promise<SentCommand | undefined>`

Rules for `forSend` (owners = `[meta.agentName]` in a single chat, `meta.group.members` in a room):
1. `leadingCommand(text)` null → `undefined` (a pick is ignored).
2. With a pick whose `name` equals the parsed name and whose `agent` is an owner: that agent's command → `{ agent, name, prompt: fillPrompt(cmd.prompt, args) }`; not found → throw `` `${displayName(agent)} has no /${name} command any more` ``.
3. Without a usable pick: owners that have the name. 0 → `undefined`; 1 → it; 2+ → throw `` `Several members have /${name} (${names in display form, comma-joined}): pick one from the / menu` ``.
4. A `commandsOf` rejection counts as no commands for that owner.

Rules for `forRerun`: find the user item `userId` (missing → `undefined`; the queue reports it). `body = text ?? old.text`. Pick = `old.command` when `leadingCommand(body)?.name === old.command.name`. Return `forSend(chatId, body, pick)`; for Resend only (`text === null`), when that returns `undefined` or throws and `old.command` exists, return `old.command` (the saved prompt).

- [ ] **Step 1: Write the failing tests.** `agentStore.test.ts`:
  - `lists only valid commands on the summary`: agent file with `commands` = `[{check,d,p}, {Bad,d,p}, {fix,d}]` → `summary.commands` equals `[{ name: 'check', description: 'd' }]`; `await store.commandsOf('a')` equals `[{ name: 'check', description: 'd', prompt: 'p' }]`.
  - `an odd commands value never breaks the agent`: `commands: nope` and `commands: {a: 1}` → `error === null`, `commands` absent.
  - `commandsOf a missing agent is empty`: `[]`.

  `commandResolver.test.ts` (fake store with one single chat of agent `wk` and one room `['wk', 'rv']`; `commandsOf` from a map `{ wk: [check, fix], rv: [check] }`, `check.prompt = 'Use check on $ARGUMENTS'`):
  - `single chat resolves a hand-typed command`: `forSend(single, '/check L')` → `{ agent: 'wk', name: 'check', prompt: 'Use check on L' }`.
  - `unknown, uppercase and spaced names stay plain`: `'/nope L'`, `'/Check L'`, `' /check L'` → `undefined`.
  - `room: unique owner resolves without a pick`: `forSend(room, '/fix L')` → agent `wk`.
  - `room: duplicate name without a pick is refused`: rejects with `'Several members have /check (Wk, Rv): pick one from the / menu'`.
  - `room: a pick chooses the owner`: `forSend(room, '/check L', { agent: 'rv', name: 'check' })` → agent `rv`.
  - `a stale pick is refused`: map `rv: []`, same call rejects with `'Rv has no /check command any more'`.
  - `resend falls back to the saved prompt`: stored user item `{ text: '/check L', command: { agent: 'wk', name: 'check', prompt: 'old' } }`, map `wk: []` → `forRerun(single, id, null)` → the stored command.
  - `edit re-resolves and keeps the room pick`: room item with `command.agent = 'rv'`, `forRerun(room, id, '/check M')` → `{ agent: 'rv', prompt: 'Use check on M' }`.
- [ ] **Step 2: Run** `npx vitest run --project backend tests/core/agentStore.test.ts tests/core/commandResolver.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `commandsOf`, the summary field and `CommandResolver` per the rules above.
- [ ] **Step 4: Run** the same command — expect PASS.

---

### Task 3: Single-chat send path, queue and RPC

**Files:**
- Create: `zumi-bot-server/backend/src/core/chat/commandText.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/taskQueue.ts` (`submit`, `rerun`, `launch`, `launchTask`)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`send`, `rerun`, `sendTurn`, `rerunTurn`, `runTurn`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`HandlerDeps.commands`, `chats:send`, `chats:edit`, `chats:resend`, new `commandPick` validator)
- Modify: `zumi-bot-server/backend/src/app.ts` (build the resolver, pass it to `createHandlers`)
- Modify: `zumi-bot-server/frontend/src/net/api.ts` (`send` passes `command` as the 6th arg)
- Test: `zumi-bot-server/backend/tests/core/commandText.test.ts` (new), `tests/core/taskQueue.test.ts`, `tests/core/chatService.test.ts`, `tests/rpc/handlers.test.ts`, `tests/core/routineRunner.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `CommandResolver`.
- Produces:
  - `readAs(user: Extract<ChatItem, { type: 'user' }>, reader: string): string` — `command.prompt` when `command.agent === reader`, else `text`.
  - `withCommands(items: readonly ChatItem[], reader: string): ChatItem[]` — user items rewritten with `readAs`; others kept by identity.
  - `TaskQueue.submit(chatId, text, stagedIds, replyTo?, messageId?, command?: SentCommand)`; the queued task stores `command`; `launch(..., command)` passes it on.
  - `TaskQueue.rerun(chatId, userId, text: string | null, command?: SentCommand)`.
  - `ChatService.send(chatId, text, attachments = [], replyTo?, messageId?, command?: SentCommand)`; `ChatService.rerun(chatId, userId, text, command?: SentCommand)`.
  - `GroupService.send` / `rerun` get the same extra parameter in Task 4; in this task only thread it through `TaskQueue` to them (typed, unused until Task 4).
  - `HandlerDeps.commands: Pick<CommandResolver, 'forSend' | 'forRerun'>`.

- [ ] **Step 1: Write the failing tests.**
  - `commandText.test.ts`: `readAs` returns the prompt for the owner and the text for anyone else; `withCommands` keeps non-user items and command-less user items by identity (`toBe`).
  - `chatService.test.ts`:
    - `the agent reads the command prompt, the chat keeps the short form`: `send(id, '/check L', [], undefined, undefined, { agent: <chat agent>, name: 'check', prompt: 'Use check on L' })` → `calls[0].stdin` is `'Use check on L'`; the stored user item has `text: '/check L'` and that `command`.
    - `a reply quote goes in front of the prompt`: reply to an assistant item `pong` → stdin `'<reply_to>\npong\n</reply_to>\n\nUse check on L'`.
    - `a reseed shows the agent the prompt of its own earlier command`: with an expired session, `buildSeedPrompt` input holds `User: Use check on L` for the earlier command message.
    - `rerun stores the new command, not the old one`: rerun with a new `command` → new version's item has it; rerun without → item has no `command`.
  - `taskQueue.test.ts`: `a queued command keeps its prompt`: submit while running with a `command` → task in meta has it; when pumped, `chats.send` receives it as 6th arg.
  - `handlers.test.ts`:
    - `chats:send resolves the command before queueing`: fake `commands.forSend` returns a `SentCommand`; `tasks.submit` receives it last; `forSend` got `(chatId, text, { agent, name })`.
    - `chats:send refuses a malformed pick`: 6th arg `{ agent: 1 }` rejects with `'Invalid command'`.
    - `chats:send rejects what the resolver rejects` (error reaches the client).
    - `chats:edit` / `chats:resend` call `forRerun(chatId, itemId, text | null)` and pass its result to `tasks.rerun` as 4th arg.
  - `routineRunner.test.ts`: `a routine prompt starting with a command name is sent as plain text`: the runner's `submit` call has no 6th argument.
- [ ] **Step 2: Run** `npx vitest run --project backend` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** `commandText.ts`; thread `command` through `TaskQueue`; in `ChatService.sendTurn` / `rerunTurn` put `...(command ? { command } : {})` on the user item (`rerunTurn` never copies `old.command`); in `runTurn` read `readAs(user, meta.agentName)` where it reads `user.text` today, and seed from `withReplies(withCommands(history, meta.agentName))`. Handlers: `chats:send` becomes `async`, validates the 6th arg with `commandPick(v): CommandPick | undefined` (undefined/null → undefined; an object with string `agent` and `name` → it; else throw `'Invalid command'`), awaits `commands.forSend`, then `tasks.submit(..., command)`. Edit/Resend await `commands.forRerun` first. `app.ts`: `new CommandResolver({ store: chats, commandsOf: (n) => agents.commandsOf(n) })`. `api.ts`: pass `command` through.
- [ ] **Step 4: Run** `npx vitest run --project backend` and `npm run typecheck` — expect PASS.

---

### Task 4: Group rooms: routing and per-member reading

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts` (`send`, `rerun`, `post`, `rerunPost`, `InboxEntry`, `route`, `runTurn` turn/seed building)
- Test: `zumi-bot-server/backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: Task 3 `withCommands`, `SentCommand`.
- Produces: `GroupService.send(chatId, text, attachments = [], replyTo?, messageId?, command?: SentCommand)`, `GroupService.rerun(chatId, userId, text, command?: SentCommand)`; `InboxEntry.commandAgent?: string`.

- [ ] **Step 1: Write the failing tests** (room `['ui', 'wk', 'ps']`, command `{ agent: 'wk', name: 'check', prompt: 'Use check on L' }`, text `'/check L'`):
  - `the command's owner reads the prompt, others read the short form`: moderator picks `wk` and `ps` (`par('wk', 'ps')`); `wk`'s stdin turn message contains `Use check on L` and not `/check L`; `ps`'s contains `/check L` and not `Use check on L`.
  - `the moderator reads the short form and sees the owner as mentioned`: the moderator input's messages hold `/check L`, and its `mentioned` equals `['wk']`.
  - `with no moderator answer the owner still runs`: moderator fails → `wk` is queued and runs.
  - `@mentions in a command message still count`: text `'/check L @ps'` → `mentioned` equals `['wk', 'ps']`.
  - `rerun keeps routing to the new command's owner`: `rerun(room, id, '/check M', { ...cmd, prompt: 'Use check on M' })` → `wk` reads `Use check on M`.
- [ ] **Step 2: Run** `npx vitest run --project backend tests/core/groupService.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** `post` / `rerunPost` put `command` on the user item and `commandAgent: command?.agent` on the `InboxEntry` passed to `enter`. In `route`: `const all = uniq([...(entry.commandAgent && members.includes(entry.commandAgent) ? [entry.commandAgent] : []), ...findMentions(entry.text, members)])` (use the file's existing de-dup helper if there is one). In `runTurn`: `threadEntries(withNotes(withReplies(withCommands(items, m)), pathOf), seenId, m)` and `seedHistory(withReplies(withCommands(history, m)), seenId, m)`. The moderator call keeps `withReplies(upTo(...))` as is.
- [ ] **Step 4: Run** `npx vitest run --project backend` — expect PASS.

---

### Task 5: Agent renames move `command.agent`

**Files:**
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts` (`renameAgent`: `renameItem` and each chat's `tasks`)
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts` (`renameAuthors`, `renameAgent` for inbox `commandAgent`)
- Test: `zumi-bot-server/backend/tests/core/chatStore.test.ts`, `tests/core/groupService.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `chatStore.test.ts` `rename moves stored and queued commands`: a single chat of `wk` with a user item and a queued task both carrying `command.agent = 'wk'`, plus a hidden version holding one → after `renameAgent('wk', 'wk2')` all three read `wk2`; a command of another agent is untouched.
  - `groupService.test.ts` `a rename while a command waits to be routed follows it`: post a command for `wk` while the room is busy, `renameAgent('wk', 'wk2')` (and the store's), then let routing run → `wk2` is mentioned and reads the prompt.
- [ ] **Step 2: Run** them — expect FAIL.
- [ ] **Step 3: Implement**: in `renameItem`, `if (out.type === 'user' && out.command?.agent === oldName) out = { ...out, command: { ...out.command, agent: newName } }`; map `c.tasks` the same way in both the single and the group branch (mark `changed`). In `renameAuthors` do the same for user items; in `GroupService.renameAgent` rename each inbox / routing entry's `commandAgent`.
- [ ] **Step 4: Run** `npx vitest run --project backend` — expect PASS.

---

### Task 6: Composer `/` menu and sending the pick

**Files:**
- Create: `zumi-bot-server/frontend/src/state/commandInput.ts`
- Modify: `zumi-bot-server/frontend/src/components/Composer.tsx` (menu, keys, pick state, `onSend(text, pick?)`)
- Modify: `zumi-bot-server/frontend/src/composerExtensions.ts` (new `CommandHighlight`)
- Modify: `zumi-bot-server/frontend/src/components/ChatView.tsx`, `NewChatView.tsx`, `App.tsx` (`sendMessage`, `startChat`, `startGroup`)
- Modify: `zumi-bot-server/frontend/src/styles.css`
- Test: `zumi-bot-server/frontend/tests/commandInput.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`CommandSummary`, `CommandPick`, `leadingCommand`), `AgentSummary.commands`.
- Produces:
  - `interface CommandOption { agent: AgentSummary; command: CommandSummary }`
  - `slashQuery(before: string, firstBlock: boolean): string | null` — `before` = the caret block's text before the caret; null unless `firstBlock` and `before` matches `/^\/([a-z0-9-]*)$/` (returns the captured query, `''` right after `/`).
  - `filterCommands(query: string, agents: readonly AgentSummary[]): CommandOption[]` — agents in the given order, skipping `error !== null`; per agent, commands whose name starts with the query (file order), then those not yet listed with a description word (split on non-letters/digits, lowercased) starting with the query.
  - `groupOptions(options: readonly CommandOption[]): { agent: AgentSummary; options: CommandOption[] }[]`
  - `keepPick(text: string, pick: CommandPick | null): CommandPick | null` — the pick while `leadingCommand(text)?.name === pick.name`, else null.
  - `Composer` props: `commandAgents?: AgentSummary[]` (single chat / new chat: `[agent]`; room: its loadable members); `onSend: (text: string, pick?: CommandPick) => void`. Room headers show when `mentionMembers` is set.
  - `App.sendMessage(chatId, text, files?, replyTo?, fromComposer = true, command?: CommandPick)` → `api.chats.send(..., item.id, command)`; `startChat(pick?)`, `startGroup(pick?)`; `NewChatView`'s `onSend(pick?: CommandPick)`.

- [ ] **Step 1: Write the failing tests** in `frontend/tests/commandInput.test.ts` (agents `wk` with `check` "Check a built card…" and `fix` "Fix one bug…", `rv` with `check` "Review a change…", and a broken agent with `check`):
  - `slashQuery` → `''` for `'/'`, `'ch'` for `'/ch'`; null for `'x /ch'`, `'/ch '`, and when `firstBlock` is false.
  - `filterCommands('', [wk])` → `check, fix` in file order.
  - `filterCommands('ch', [wk, rv, broken])` → `[wk/check, rv/check]` (the broken agent skipped).
  - `filterCommands('bug', [wk])` → `[wk/fix]` (description match after no name match).
  - `groupOptions` keeps agent order and groups per agent.
  - `keepPick('/check L', pick)` → pick; `keepPick('/chec L', pick)` → null; `keepPick('hello', pick)` → null.
- [ ] **Step 2: Run** `npx vitest run --project frontend tests/commandInput.test.ts` — expect FAIL.
- [ ] **Step 3: Implement `state/commandInput.ts`.**
- [ ] **Step 4: Run** the same — expect PASS.
- [ ] **Step 5: Wire the composer.** Compute the slash query from the editor state like `editorQuery` (first block = `$from.index(0) === 0` and not in a code block). Render a second menu in the mention menu's place (`className="menu mention-menu command-menu"`, `role="listbox"`, `aria-label="Commands"`, `data-testid="command-menu"`); each row a `role="option"` button with `data-testid="command-option"`, `data-agent-name`, `data-command-name`, two lines: `.command-name` (`/name`, monospace) and `.command-desc`. In a room, a non-interactive header per agent (`data-testid="command-agent"`: `BotIcon` + `displayName`). Keys exactly as the mention menu (↑↓, Enter/Tab pick, Esc closes and stays closed for that `/`). Picking replaces `/query` with `/name ` and sets `pick`; every draft change runs `keepPick`; send passes `pick ?? undefined` and clears it. Only one of the two menus can be open (mentions need `@`, commands need `/` at the start).
- [ ] **Step 6: Add `CommandHighlight`** (pattern of `MentionHighlight`): tints a leading `/name` in the first block with `--mention` of the pick's agent, or of the single owner when exactly one of `commandAgents()` has the name; no tint otherwise.
- [ ] **Step 7: Thread the pick** through `ChatView` (both composers), `NewChatView` (`commandAgents` = the selected agent in single mode, the picked loadable members in group mode) and `App` as listed under Interfaces.
- [ ] **Step 8: Styles** in `styles.css` next to `.mention-menu`: two-line rows, agent headers with a top separator after the first, works at phone width and in both themes with existing tokens.
- [ ] **Step 9: Run** `npm run typecheck` and `npx vitest run --project frontend` — expect PASS. Then check by hand in the built app (`npm run build:server`, local mode): `/` opens the menu, room shows grouped headers.

---

### Task 7: Sent command chip and the "Full prompt" toggle

**Files:**
- Create: `zumi-bot-server/frontend/src/components/CommandBubble.tsx`
- Modify: `zumi-bot-server/frontend/src/components/UserText.tsx` (optional leading chip)
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx` (`renderUser`)
- Modify: `zumi-bot-server/frontend/src/styles.css`

**Interfaces:**
- Consumes: user item `command?: SentCommand`, `AgentSummary.commands`, `leadingCommand`.
- Produces:
  - `UserText({ text, mentions, lead? }: { ...; lead?: { name: string; node: ReactNode } })` — when `lead` is given and the first paragraph's first text node starts with `/${lead.name}`, renders `lead.node` in its place followed by the rest of that text.
  - `CommandBubble({ text, command, agent, inRoom, mentions }: { text: string; command: SentCommand; agent: AgentSummary | undefined; inRoom: boolean; mentions: UserMentions | null })` — renders, as a fragment: the `div.bubble.user` (with `UserText` + chip lead), a toggle button, and when open the prompt box. Local `useState(false)`: collapsed on every mount.

- [ ] **Step 1: Implement `CommandBubble`.** Chip: `<button type="button" className="mention command-chip" data-testid="command-chip" aria-expanded={open}>` with `--mention` = agent color; in a room a 14px `BotIcon` before `/name`. Grey (`broken` class, like `.mention.broken`) when `agent` is missing, has `error`, or its `commands` lacks `command.name`. Toggle: `<button type="button" className="full-prompt-toggle" data-testid="full-prompt-toggle" aria-expanded={open}>` with a caret and the label `Full prompt`. Open: `<div className="full-prompt" data-testid="full-prompt">{command.prompt}</div>` (`white-space: pre-wrap`, plain text). Chip and toggle both flip `open`.
- [ ] **Step 2: Use it** in `MessageList.renderUser`: when `item.command` is set, `bubble` = `<CommandBubble … />` instead of the plain bubble (same for the dimmed/pending branch). Items without `command` are untouched.
- [ ] **Step 3: Styles**: toggle muted, 12px, aligned under the bubble's right edge; prompt box raised panel, mono 12.5px, max width of a user bubble, phone width safe, both themes.
- [ ] **Step 4: Run** `npm run typecheck`; check by hand in the built app: chip, collapsed toggle, open/close by toggle and by chip, a renamed-away command shows grey and still opens.

---

### Task 8: Agent editor Commands card

**Files:**
- Create: `zumi-bot-server/frontend/src/components/CommandsCard.tsx`
- Modify: `zumi-bot-server/frontend/src/components/AgentForm.tsx` (render it after "Capabilities & Tools" in the same column)
- Modify: `zumi-bot-server/frontend/src/components/EditorIcon.tsx` only if a new icon name is needed (reuse `list` otherwise)
- Modify: `zumi-bot-server/frontend/src/styles.css`
- Test: `zumi-bot-server/frontend/tests/editorState.test.ts`

**Interfaces:**
- Consumes: `AgentFields.commands`, `commandIssue`, `editFields`.
- Produces: `CommandsCard({ commands, onChange }: { commands: AgentCommand[]; onChange: (next: AgentCommand[]) => void })`; `AgentForm` calls `onFields({ commands: next.length > 0 ? next : null })`.

- [ ] **Step 1: Write the failing test** in `editorState.test.ts`: `editing commands rewrites only the commands key`: `editFields(state, { commands: [{ name: 'check', description: 'c', prompt: 'p' }] })` → `raw` parses back to that list, `body` unchanged; then `editFields(next, { commands: null })` → `raw` equals the original file.
- [ ] **Step 2: Run** `npx vitest run --project frontend tests/editorState.test.ts` — expect FAIL until Task 1's serializer handles it (if it passes already, keep it as a guard and move on).
- [ ] **Step 3: Implement `CommandsCard`.** `section.card` with `CardHead` (title `Commands`, meta = count of valid commands). One row per command (`data-testid="command-row"`): name input (`command-name`, monospace, `/` prefix shown outside the input), description input (`command-description`), prompt textarea (`command-prompt`, via `forTextarea`), remove button (`remove-command`). `+ Add command` button (`add-command`) appends an all-empty row. A row's `commandIssue` shows under it once any of its inputs was touched (same pattern as the form's `touched`). Hint under the list: `$ARGUMENTS marks where your text goes; without it, your text goes at the end.` Saving is not blocked by issues (invalid rows are skipped at run time).
- [ ] **Step 4: Run** `npm run typecheck` and `npx vitest run --project frontend` — expect PASS; check by hand: add, edit, remove, save, reopen.

---

### Task 9: Zumi Bot writes and owns commands

**Files:**
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts` (`zumiBotContent`)
- Test: `zumi-bot-server/backend/tests/core/zumiBot.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `Zumi Bot has its own commands`: `parseAgent(zumiBotContent(dir))` is ok and `validCommands(fields.commands ?? []).map((c) => c.name)` equals `['new-agent', 'edit-agent', 'suggest-commands']`.
  - `its prompt documents commands`: the body contains `commands:`, `$ARGUMENTS` and `prompt: |`.
- [ ] **Step 2: Run** `npx vitest run --project backend tests/core/zumiBot.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Frontmatter gets the three commands (each `prompt: |`):
  - `new-agent` — "Create a new agent" — `Create a new agent. Here is what it should do:\n\n$ARGUMENTS`
  - `edit-agent` — "Change an existing agent" — `Edit an existing agent: $ARGUMENTS`
  - `suggest-commands` — "Propose commands for an agent's main jobs" — `Read the agent $ARGUMENTS, then propose commands for its main jobs: a name, a one-line description and a prompt for each. Ask me before writing them into its file.`

  Body: add `commands` to "Agent file format" (the YAML list with `name`, `description`, `prompt: |`, the name rule, `$ARGUMENTS` and the append rule); in "Creating an agent" a step that writes commands for the agent's main jobs (a handful, its judgement) and a line telling the user which commands it added; in "Editing an agent" that it adds, changes or removes commands when asked; a rule to always write `prompt` as a block scalar (`prompt: |`).
- [ ] **Step 4: Run** `npx vitest run --project backend` — expect PASS (`ensureZumiBot` rewrites existing installs because the content differs).

---

### Task 10: End-to-end suite and docs

**Files:**
- Create: `zumi-bot-server/e2e/commands.e2e.mjs`
- Modify: `package.json` (root: `"e2e:commands": "npm run build && node zumi-bot-server/e2e/commands.e2e.mjs"`)
- Modify: `CLAUDE.md` (the e2e list sentence, and a short **Agent commands** paragraph in Architecture)

- [ ] **Step 1: Write the suite** on `harness.mjs` `start({ fake: true, agentsDir, env })`, following `routines.e2e.mjs`'s shape. Agents dir: `wk.md` with `check` (`Use check on $ARGUMENTS`) and `fix`, `rv.md` with `check`. `FAKE_STDIN_OUT` set to a temp file. Checks:
  1. New single chat with `wk`: type `/` → `command-menu` shows `command-option` rows `check`, `fix` with descriptions, no `command-agent` header.
  2. Type `ch`, Enter → composer text is `/check `; type `https://x/1`, send → the fake claude's stdin holds `Use check on https://x/1` and not `/check`.
  3. The bubble shows `command-chip` `/check`; `full-prompt` absent; click `full-prompt-toggle` → `full-prompt` text is `Use check on https://x/1`; click the chip → closed.
  4. Type `/nope hi` and send → stdin is exactly `/nope hi`; no chip.
  5. New group (`wk`, `rv`) on the new-chat screen: type `/` → two `command-agent` headers in member order, `check` under both (do not send).
- [ ] **Step 2: Run** `npm run e2e:commands` — expect every check to pass. Kill any Chrome it leaves (user's rule: leave no browser processes running).
- [ ] **Step 3: Docs.** `CLAUDE.md`: add `e2e:commands` to the e2e sentence ("uses only the fake claude, so it costs no quota"), and an **Agent commands** paragraph: commands live in the agent's frontmatter (`commands:` list, `shared/src/commands.ts`), resolved only on the user's send/edit/resend in the RPC handlers (`CommandResolver`; routines never), stored on the user item as `command`, read by its agent through `readAs`/`withCommands`, routed in rooms as a user mention; the composer's `/` menu sends a `CommandPick`.
- [ ] **Step 4: Final check**: `npm test`, `npm run typecheck`, `npm run e2e:commands` all green.
