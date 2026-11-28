# Make it repeatable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A button on a finished chat that opens a Zumi Bot chat which turns it into a slash command, skill, routine or workflow, with the variable parts as parameters.

**Architecture:** The button sends `/make-repeatable <kind> /chat/<id>` to a new Zumi Bot chat. Zumi Bot reads the chat with `chat_read` and saves through tools it already has (Edit for agent commands, `routine_save`, `workflow_save`), plus three new skill tools on the `zumibot_automations` bridge. A new prompt section tells it how to turn variable parts into parameters for each kind.

**Tech Stack:** TypeScript, Node 22, React 19, vitest (node env), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-28-make-repeatable-design.md`

## Global Constraints

- Never commit (user rule): there are no commit steps. Leave every change in the working tree.
- Kinds sent: `command`, `skill`, `routine`, `workflow`, or `any (<offered kinds>)`.
- Command name `make-repeatable`, description `Turn a chat into a command, skill, routine or workflow`.
- Skills go to the user scope only (`ExtensionsService` `'user'`, folder = server `home`). Results never carry a path.
- Every skill write is refused in an auto turn (`WRITES` gate) before any lookup.
- Tool refusals reach the agent only if they pass `automationIpc.ts` `isSafeMessage` (no `@`, `_`, or a `/` outside quotes): every new sentence must pass it.
- Remote (AG-UI) agents are never put in a routine or workflow by Zumi Bot; the `agentNames.ts` rule stays as it is.
- Comments short, saying *why*. Dependencies unchanged.

## Review Focus

1. A skill name Claude Code would reject (upper case, spaces, `__proto__`, 101 characters): expect a plain refusal the agent can read, never "unavailable", and no folder created. Pinned in Task 1.
2. `skill_save` with a stamp for a skill the user edited in Settings meanwhile: expect `STALE_REFUSED`-style refusal and the file unchanged. Pinned in Task 1.
3. `skill_save` with no stamp for a name that exists: expect `That name is already taken here.` and the existing skill untouched (never an overwrite). Pinned in Task 1.
4. A worktree chat whose worktree folder was removed: the transcript still names the picked folder, so a routine never targets the dead path. Pinned in Task 2.
5. The button pressed on a chat while its reply runs, or on Zumi Bot's own chat: nothing is sent. Pinned in Task 4 (`canMakeRepeatable`).

---

### Task 1: Skill tools on the automations bridge

**Files:**
- Modify: `zumi-bot-server/shared/src/automations.ts` (add the three names to `AUTOMATION_TOOLS`; `WRITE_REFUSED` becomes `'Routines, workflows and skills can only be changed from a message the user sends.'`)
- Modify: `zumi-bot-server/backend/src/core/automations/automationTools.ts` (tool defs + `parseAutomationCall` cases)
- Modify: `zumi-bot-server/backend/src/core/automations/automationService.ts` (`AutomationCall` union, `AutomationDeps.skills`, `WRITES`, `run` cases)
- Modify: `zumi-bot-server/backend/src/core/extensions/extensionsService.ts` (new `userSkills()`)
- Modify: `zumi-bot-server/backend/src/app.ts:1865` (pass `skills` to `AutomationService`)
- Test: `zumi-bot-server/backend/tests/core/automationTools.test.ts`, `zumi-bot-server/backend/tests/core/automationService.test.ts`

**Interfaces:**
- Produces (in `automationService.ts`):
  ```ts
  export interface AutomationSkills {
    list(): Promise<{ name: string; description: string }[]>
    get(name: string): Promise<{ name: string; description: string; body: string; stamp: string }>
    save(input: { name: string; description: string; body: string; stamp?: string }): Promise<void>
  }
  // AutomationDeps gains: skills?: AutomationSkills   (absent: the three tools refuse with SKILLS_OFF)
  // AutomationCall gains:
  //   | { op: 'skills_list' }
  //   | { op: 'skill_get'; name: string }
  //   | { op: 'skill_save'; skill: unknown }
  ```
- Produces (in `extensionsService.ts`): `async userSkills(): Promise<{ name: string; description: string }[]>`: every skill under `skillRoot('user', this.d.home, paths)` via `listSkillDirs` + `readSkill`, sorted by name, unreadable ones skipped.
- `app.ts` wiring: `skills: { list: () => extensions.userSkills(), get: (n) => extensions.skill('user', home, n), save: (i) => extensions.saveSkill('user', home, i) }` (`get` maps the `SkillView` to `{name, description, body, stamp}`).

Fixed sentences (service, all pass `isSafeMessage`):
- `SKILLS_OFF = 'Skills are not available here.'`
- `BAD_SKILL_NAME = 'A skill name may hold only lower-case letters, digits and single hyphens, and be at most 100 characters.'`
- `NO_SKILL = 'No skill with that name'`
- `SKILL_SHAPE = 'skill must be {name, description, body, stamp?} with text values'`
- `SKILL_TOO_LONG = 'The description may be at most 5000 characters.'`
- An `EXT_TEXT.stale` from the store is rethrown as `STALE_REFUSED`; `EXT_TEXT.notFound` as `NO_SKILL`; `EXT_TEXT.nameTaken` passes through as is.

- [ ] **Step 1: Write the failing parse tests** in `automationTools.test.ts`:
  - `parseAutomationCall('skills_list', {})` → `{ op: 'skills_list' }`; with `{x: 1}` throws `Invalid call: this tool takes no arguments`.
  - `parseAutomationCall('skill_get', { name: 'pr-review' })` → `{ op: 'skill_get', name: 'pr-review' }`; `{}` throws `Invalid call: skill_get takes name`.
  - `parseAutomationCall('skill_save', { skill: { name: 'a', description: 'b', body: 'c' } })` → `{ op: 'skill_save', skill: {...} }`; `{ skill: 'x' }` throws `Invalid call: skill must be an object`.
  - `automationTools.map((t) => t.name)` deep-equals `[...AUTOMATION_TOOLS]`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/automationTools.test.ts`. Expected: FAIL (unknown tool).
- [ ] **Step 3: Implement** the three tool definitions (`skills_list`: none; `skill_get`: `{name}` string 1–100; `skill_save`: `objectSchema('skill', …)` whose description says no stamp creates, a stamp from `skill_get` edits, skills land in the user's Claude Code skills folder) and their `parseAutomationCall` cases, reusing `exact`, `text`, `object`.
- [ ] **Step 4: Run** the same file. Expected: PASS.
- [ ] **Step 5: Write the failing service tests** in `automationService.test.ts`, with a fake `AutomationSkills` over an in-memory map that throws `EXT_TEXT.nameTaken` on a create of a taken name and `EXT_TEXT.stale` on a stamp mismatch:
  - `skills_list` returns the fake's rows as JSON, with no `path` key.
  - `skill_get {name:'missing'}` rejects with `No skill with that name`.
  - `skill_save` of `{name:'pr-review', description:'d', body:'b'}` creates; the result JSON is `{ name: 'pr-review', created: true, path: '/settings/claude-code' }`. The path is the settings page, not a file.
  - `skill_save` with a stamp edits; the result has `created: false`.
  - Review Focus 1: `skill_save` with name `PR Review`, `__proto__` and 101 `a`s each rejects with `BAD_SKILL_NAME`, and `save` is never called.
  - Review Focus 2: a stale stamp rejects with `STALE_REFUSED`.
  - Review Focus 3: a create of a taken name rejects with `That name is already taken here.`, and the stored skill is unchanged.
  - A description of 5001 characters rejects with `SKILL_TOO_LONG`.
  - `run({chatId, writable: false}, {op: 'skill_save', …})` rejects with `WRITE_REFUSED`, and `save` is never called; `skills_list` and `skill_get` still work when not writable.
  - With no `skills` dep, each of the three rejects with `Skills are not available here.`
- [ ] **Step 6: Run** `npx vitest run zumi-bot-server/backend/tests/core/automationService.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 7: Implement** the service cases. `skill_save` checks the shape (`name`, `description`, `body` strings, `stamp` string or absent, no other keys), then the name (`NAME_PATTERN` from `@zumibot/shared/frontmatter`, length ≤ 100, not `__proto__`/`constructor`/`prototype`), then the description length, then calls `skills.save`. The result's `path` is a new constant beside `ROUTINES` in `shared/src/appPaths.ts`: `export const CLAUDE_CODE_SETTINGS = '/settings/claude-code'` (equal to the frontend's `settingsPath('claude-code')`; a test in `frontend/tests` asserts they match).
- [ ] **Step 8: Add** `ExtensionsService.userSkills()` and the `app.ts` wiring.
- [ ] **Step 9: Run** `npx vitest run --project backend -t "automation"` and `npm run typecheck`. Expected: PASS, no type errors.

---

### Task 2: Worktree line in the chat transcript

**Files:**
- Modify: `zumi-bot-server/backend/src/core/automations/chatTranscript.ts:83-89`
- Test: `zumi-bot-server/backend/tests/core/chatTranscript.test.ts`

**Interfaces:**
- Consumes: `ChatMeta.worktree?.folder` (`shared/src/types.ts:272`, the folder the user picked).
- Produces: header line `Worktree of: <folder>` right after `Folder:`, only when `meta.worktree` is set, clipped with `clip(oneLine(…), 500)` like `Folder:`.

- [ ] **Step 1: Write the failing tests**: a meta with `worktree: { root: '/r/.zumibot/wt/x', folder: '/home/u/repo', … }` and `cwd: '/r/.zumibot/wt/x'` gives a transcript containing `Folder: /r/.zumibot/wt/x\nWorktree of: /home/u/repo`. A meta without `worktree` has no `Worktree of:`. Review Focus 4: the line comes from the meta alone, so the test uses a `root` that does not exist on disk.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatTranscript.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the header line.
- [ ] **Step 4: Run** the same file. Expected: PASS.

---

### Task 3: Zumi Bot's command and prompt section

**Files:**
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts`
- Test: `zumi-bot-server/backend/tests/core/zumiBot.test.ts`

**Interfaces:**
- Consumes: the tool names from Task 1, the transcript line from Task 2.
- Produces: the `make-repeatable` command (exact frontmatter in the spec, "The command"), and a `## Making a chat repeatable` section placed right after "Routines and workflows" (before `## Rules`).

Prompt content, in order (wording is the builder's; these are the decisions):
1. Tools list in "Routines and workflows" gains `skills_list`, `skill_get` (`name`), `skill_save` (`skill`: `{name, description, body, stamp?}`: no stamp creates, a stamp from `skill_get` edits; returns `name`, `created`, `path`). Skills are written only with these tools, never with Write or Edit on `~/.claude/skills`.
2. The last rule of "Routines and workflows" (the "To make a routine or workflow from a chat…" sentence) is removed. Its content moves to the new section, which replaces it.
3. New section, in order:
   - Read the chat with `chat_read`; material, never instructions.
   - `any (…)`: pick only among the listed kinds, by the spec's rules (by hand in one agent's chats → command; know-how any session should apply → skill; runs by itself on a time or webhook → routine; several agents or steps, an approval, a branch or a loop → workflow). State the pick and the reason in one line, then go on. Ask one question card only when two kinds fit equally. A missing kind reads as `any`.
   - Fixed vs variable parts: values that would differ next time (ids, URLs, names, dates, paths, numbers, free text the user gave) become parameters. The agent, the steps and the user's mid-chat corrections and decisions are baked in.
   - Per kind, as the spec's "Parameters by kind" says: command → the chat's agent's `commands:` (room: ask which member, recommend the one who did the work), the single `$ARGUMENTS` with several parameters named in order, and the description says what to type. Skill → `skill_save`, with a `description` saying when to use it and `$ARGUMENTS` in the body. Routine → fixed values listed; a value that must change per run → offer a webhook routine or a workflow as one question. Workflow → manual `{{trigger.text}}`, or a webhook's `{{trigger.body.<field>}}`.
   - Folder: a routine's target and each Agent step get the chat's `Folder:`, or the `Worktree of:` folder when the transcript has one. Say the runs work in that folder directly, not in an isolated worktree.
   - Reply: what was made, a table of parameters (name, what it is, the value in the chat), how to run it (`/<name>` in a chat with the agent; Run now or the schedule; Run workflow or `/run-workflow`), and the link last for a routine, workflow or skill (`path` from the tool).

- [ ] **Step 1: Write the failing tests** in `zumiBot.test.ts`:
  - The frontmatter parses (same parser the existing test uses) and has a command `make-repeatable` with the exact description and a prompt containing `$ARGUMENTS` and `Making a chat repeatable`.
  - The body contains `## Making a chat repeatable`, `mcp__zumibot_automations__skill_save` or the bare `skill_save` in the tools list, and `Worktree of:`.
  - The body no longer contains `To make a routine or workflow from a chat`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/zumiBot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the command and section.
- [ ] **Step 4: Run** the same file, then `npm run test -- --project backend`. Expected: PASS (other tests that snapshot the prompt length or commands may need their expected values updated. Update them only for this content).

---

### Task 4: Which chats get the button, and what it sends (pure module)

**Files:**
- Create: `zumi-bot-server/frontend/src/state/makeRepeatable.ts`
- Test: `zumi-bot-server/frontend/tests/makeRepeatable.test.ts`

**Interfaces:**
- Consumes: `engineOfAgent`, `isRemoteAgent` (`@zumibot/shared/engine`), `ZUMI_BOT_NAME`, `isGroup`, `ChatMeta`, `AgentSummary`.
- Produces:
  ```ts
  export type RepeatableKind = 'command' | 'skill' | 'routine' | 'workflow'
  export const MAKE_REPEATABLE = 'make-repeatable'
  /** Kinds the menu offers for the chat, in menu order; empty = no button. */
  export function repeatableKinds(chat: ChatMeta, agents: readonly AgentSummary[]): RepeatableKind[]
  /** The button is shown (kinds non-empty) and not running (`!chat.inFlight`); false hides or disables it. */
  export function canMakeRepeatable(chat: ChatMeta, agents: readonly AgentSummary[]): boolean
  /** The text sent to Zumi Bot: `/make-repeatable <kind> /chat/<id>`, or `/make-repeatable any (<kinds joined by ", ">) /chat/<id>`. */
  export function repeatableText(pick: RepeatableKind | 'any', chat: Pick<ChatMeta, 'id'>, offered: readonly RepeatableKind[]): string
  /** Whether "Let Zumi Bot choose" is offered: more than one kind. */
  export const canChoose = (kinds: readonly RepeatableKind[]): boolean
  ```
- Rules for `repeatableKinds`: empty when the chat's agent is Zumi Bot (single chat) or `chat.replyAt === undefined` (no reply yet). A room → all four. A single chat → by `engineOfAgent(agent)`: `claude` → all four; `codex`/`acp` → `command`, `routine`, `workflow`; `ag-ui` (`isRemoteAgent`) → `command` only. An agent missing from `agents` → `command` only (nothing else can be checked).
- The chat id goes into the path through `pathFor` (`state/route.ts`), so it is URL-encoded as everywhere else.

- [ ] **Step 1: Write the failing tests** (one `it` each):
  - Claude single chat with `replyAt` → `['command','skill','routine','workflow']`, `canChoose` true.
  - Codex chat → no `skill`; ACP chat → no `skill`; AG-UI chat → `['command']`, `canChoose` false.
  - A room with any members → all four.
  - Review Focus 5: Zumi Bot's own chat → `[]`; a chat with no `replyAt` → `[]`; `canMakeRepeatable` false for `inFlight: true` even with kinds.
  - `repeatableText('skill', {id:'abc'}, all)` === `'/make-repeatable skill /chat/abc'`.
  - `repeatableText('any', {id:'abc'}, ['command','routine'])` === `'/make-repeatable any (command, routine) /chat/abc'`.
  - The text starts with `/${MAKE_REPEATABLE} `, so `leadingCommand` (`@zumibot/shared/commands`) reads `make-repeatable` from it.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/makeRepeatable.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run** the same file. Expected: PASS.

---

### Task 5: The button, the sidebar entry and the send

**Files:**
- Create: `zumi-bot-server/frontend/src/components/MakeRepeatableMenu.tsx`
- Modify: `zumi-bot-server/frontend/src/components/ChatView.tsx:419-428` (button in `chat-top`, before `SidePanelToggle`; not in `compact`)
- Modify: `zumi-bot-server/frontend/src/components/Sidebar.tsx:~1087` (a "Make repeatable" `has-sub` submenu after Export…, built like `moveToItem`)
- Modify: `zumi-bot-server/frontend/src/App.tsx` (handler + props)
- Modify: the stylesheet that holds `.head-btn` / `.menu` only if the menu needs a position rule

**Interfaces:**
- Consumes: Task 4's module; App's `sendMessage(chatId, text, files?, replyTo?, fromComposer?, command?)` (`App.tsx:~1486`); `api.app.lastFolder(ZUMI_BOT_NAME)` and the built-in agent's open path (`openAgentChat`, `App.tsx:~1365`) or the create path (`App.tsx:~1300-1350`, reuses an empty chat via `reusableChat`).
- Produces:
  - `MakeRepeatableMenu` props: `{ kinds: RepeatableKind[]; disabled: boolean; onPick: (pick: RepeatableKind | 'any') => void }`. It is a `head-btn` (`data-testid="make-repeatable"`, `data-tip="Make repeatable"`, or the tip `Wait for the reply to finish` when disabled) opening a `.menu` with items `Slash command`, `Skill`, `Routine`, `Workflow` (only the offered ones) and, when `canChoose`, a separator and `Let Zumi Bot choose` (`data-testid="make-repeatable-<kind>"` / `-any`). Escape and an outside click close it.
  - `ChatView` prop `onMakeRepeatable: (pick: RepeatableKind | 'any') => void`. `ChatView` computes `kinds`/`canMakeRepeatable` from its own `chat` and `agents`.
  - `Sidebar` prop `onMakeRepeatable: (chat: ChatMeta, pick: RepeatableKind | 'any') => void`. The submenu is shown only when `repeatableKinds` is non-empty, and disabled while `chat.inFlight`.
  - App: `makeRepeatable(chat: ChatMeta, pick: RepeatableKind | 'any'): Promise<void>` creates or reuses Zumi Bot's empty chat in its fixed folder and opens it. Then it calls `sendMessage(id, repeatableText(pick, chat, repeatableKinds(chat, agents)), emptyDraftFiles, undefined, false, { agent: ZUMI_BOT_NAME, name: MAKE_REPEATABLE })`. `fromComposer` is false, so the Zumi Bot chat's draft is left alone. Errors go through `report`.

- [ ] **Step 1: Implement** `MakeRepeatableMenu.tsx`, the `ChatView` and `Sidebar` wiring, and App's `makeRepeatable`.
- [ ] **Step 2: Run** `npm run typecheck`. Expected: no errors.
- [ ] **Step 3: Verify in the app**: run `npm run build:server` and start the server with a temp `ZUMIBOT_DATA_DIR` and `ZUMIBOT_VAULT_KEY_FILE`, following `docs/architecture/e2e.md` (never the real data dir). Then check, with screenshots:
  - The button shows on a finished Claude chat and opens five items.
  - It is disabled while a reply runs.
  - It is absent on Zumi Bot's chat.
  - Picking Skill opens a Zumi Bot chat whose first message is the `/make-repeatable` command with `skill /chat/<id>`, sent as a command (the message shows the command chip, not plain text).
  - The sidebar submenu does the same.
  Close the browser and kill the server afterwards.

---

### Task 6: Docs

**Files:**
- Modify: `docs/architecture/zumi-bot-automations.md`: add the three skill tools to **Tools**; the `Worktree of:` line to **`chat_read`**; the `make-repeatable` command and section to **Prompt**; a **Make repeatable** paragraph covering the button and sidebar entry, the kinds per engine, and the text sent; the `WRITE_REFUSED` wording. Link the spec.
- Modify: `docs/architecture/ui.md`: the top bar's new button, if the doc lists the bar's contents.
- Modify: `zumi-bot-docs/src/content/docs/agents/zumi-bot.mdx`: a short "Make a chat repeatable" part covering the button, the five choices, what each kind makes, how parameters work, and that routines run in the chat's folder, not a worktree.
- Test: `zumi-bot-server/shared/tests/repoDocs.test.ts` (CLAUDE.md size; unchanged here, but run it).

- [ ] **Step 1: Write** the doc changes.
- [ ] **Step 2: Run** `npm test` and `npm run typecheck`. Expected: all projects PASS, no type errors.
