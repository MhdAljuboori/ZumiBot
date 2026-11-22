# Allow a Blocked Call and Continue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Auto-mode classifier refuses a Bash call, the user taps **Allow…** on the row, grants prefix rules for the command's parts (this chat or always for the agent), and the agent continues by itself.

**Architecture:** The stream parser surfaces the CLI's `permission_denied` reason, and the tool item gets `blockedBy: 'classifier'`. Granted rules are stored on the chat meta (`allowRules`) or as a new kind of rule in `approvals.json`, and are passed to every later non-Plan Claude turn as one more `--settings` `permissions.allow` piece, which `oneSettings` merges. One RPC validates and stores the rules and returns the continue text. The client sends that text through its normal `sendMessage`.

**Tech Stack:** TypeScript, Node 22, React 19, vitest (`node` env), npm workspaces. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-22-blocked-call-allow-design.md`. Read it first, especially the Probe findings table.

## Global Constraints

- **No commits.** The user commits by hand (global rule). Every task ends with tests passing and the change left uncommitted.
- No new dependencies. Versions stay pinned.
- Comments are short and say *why*. Never log rule text, commands or chat text. Errors name the problem, never echo more than the row's command.
- Never add `--dangerously-skip-permissions` or `bypassPermissions`. Rules are created **only** by the user's RPC call: no agent tool, bridge or Zumi Bot automation may add one.
- Rule form is exactly `Bash(<prefix>:*)`. Prefix: trimmed, 1–300 chars, no `\n`/`\r`/`\0`, no `*`, first word not in `INTERPRETERS`, and equal to one of `commandParts(command)` or a word-boundary prefix of it (`part.startsWith(prefix + ' ')`). 1–10 prefixes per call.
- `INTERPRETERS` = `sh bash zsh dash fish python python3 node deno bun ruby perl php npx env sudo eval exec xargs ssh ksh csh tcsh pwsh powershell cmd source .` plus the wrappers `timeout nohup command busybox nice time stdbuf setsid doas su watch nsenter chroot unshare flock ionice taskset`; the first word is compared lowercased, without path, `.exe`/`.cmd`/`.bat`/`.com` and version, and one that starts with `$`, a backtick or a quote is refused too. `git -C`/`git -c` alone is refused.
- `SAFE_HEADS` = `cd echo tail head grep ls cat wc sort sleep true pwd printf awk sed cut tr`.
- Rules apply to turns in Auto, Ask permissions and Accept edits; **never Plan**. Never to side runs (`/btw`), Compact or the moderator.
- Root `CLAUDE.md` stays under 16 KB: feature detail goes into `docs/architecture/*.md` only.
- New API method touches three places: `ZumiBotApi` in `shared/src/types.ts`, `rpc/handlers.ts`, `frontend/src/net/api.ts`.

## Review Focus

1. **Quotes and heredocs.** `git commit -m "a; b | c"` is one part. A heredoc body (`cat <<EOF … EOF`) contributes no parts. *(Task 2 tests)*
2. **Double submit / two tabs.** A second `allowBlocked` for a row that already has `allowedAs` is refused with `ALREADY_ALLOWED`, and no rules are duplicated. *(Task 5 test)*
3. **Plan mode.** A chat whose run mode is `plan` gets no allow `--settings`, even with rules stored. *(Task 4 test)*
4. **Agent rename/delete.** CLI rules move with `renameAgent` and go with `forgetAgents`, like other approvals. *(Task 4 test)*
5. **Rooms.** The row's agent is `item.agent`. The continue text starts with `@<member> `. A chat-scope rule reaches every member's run. *(Task 5 and Task 4 tests)*

---

### Task 1: Commit the real-CLI probe as `npm run probe:allow`

**Files:**
- Create: `zumi-bot-server/e2e/allowRuleProbe.mjs`
- Modify: `package.json` (scripts `probe:allow`; append `&& node zumi-bot-server/e2e/allowRuleProbe.mjs --soft` to `e2e`)
- Modify: `docs/architecture/e2e.md` (one line under probes)

**Interfaces:** Produces nothing that other tasks import. This task is the regression guard for the CLI behaviour the feature relies on.

- [ ] **Step 1: Write the probe.**
  - Model it on `processAskProbe.mjs`: same header comment style, `--soft`, `ZUMIBOT_PROBE_CLAUDE`/`CLAUDE_BIN`, exit 0/1/2, one retry when inconclusive, kill the process group.
  - Start from the ad-hoc script at `/tmp/claude-1000/-home-mhdaljuboori-Developments-AI-ZumiBot--claude-worktrees-permission-rule-addition-7e0680/788527fe-9040-4310-9a0b-5994c612ca3a/scratchpad/allowProbe.mjs` (throwaway repo with a bare remote, NOTES.md holds the script, Haiku, `--permission-mode auto --permission-prompt-tool stdio`, answer every `can_use_tool` with deny).
  - Run in the throwaway repo with `--setting-sources project,local`, so the user's own ask rules (`Bash(git *push*--delete*)`) do not interfere. Use `git push origin :<branch>` deletes.
  - Cases and their PASS conditions:
    - (a) single-line `;` script with no rules: `permission_denied` with `decision_reason_type === 'classifier'` (otherwise INCONCLUSIVE: the classifier may allow).
    - (b) the multi-line `C=…; cd $C` script with `Bash(git branch -D:*)` and `Bash(git push origin:*)`: ran (branches gone), no classifier denial. **FAIL** otherwise.
    - (c) `Bash(sh:*)` with `sh -c '…'`: refused or asked. **FAIL** if it ran (the INTERPRETERS list would be wrong).
    - (d) a `for b in a c; do git branch -D "$b"; done` loop with `Bash(git branch -D:*)`: report RAN or REFUSED as information only, never a FAIL.
- [ ] **Step 2: Run it.** Run `node zumi-bot-server/e2e/allowRuleProbe.mjs`. Expected: `PASS`, with (d) reported.
- [ ] **Step 3:** Add the package.json scripts and the e2e.md line. Record the (d) result in the spec's Probe findings ("Not yet known" line).

---

### Task 2: Shared rule helpers (`shared/src/allowRules.ts`)

**Files:**
- Create: `zumi-bot-server/shared/src/allowRules.ts`
- Test: `zumi-bot-server/shared/tests/allowRules.test.ts`

**Interfaces — Produces:**
- `INTERPRETERS: readonly string[]`, `SAFE_HEADS: readonly string[]` (values in Global Constraints)
- `commandParts(command: string): string[]`
- `suggestPrefix(part: string): string`
- `ruleOfPrefix(prefix: string): string` → `` `Bash(${prefix}:*)` ``
- `prefixOfRule(rule: string): string | null`: the inverse. Null for anything not exactly `Bash(<p>:*)` with a valid-looking `p` (no `*`, no newline).
- `checkPrefix(prefix: string, command: string): string | null`: an error message, or null when valid (Global Constraints rule).
- `coveredBy(part: string, rules: readonly string[]): string | null`: the first rule whose prefix `p` gives `part === p || part.startsWith(p + ' ')`.
- `isSafePart(part: string): boolean`: first word in `SAFE_HEADS`.
- `continueText(rules: readonly string[], scope: 'chat' | 'agent', agent: string, member: string | null): string`

- [ ] **Step 1: Write failing tests** (`allowRules.test.ts`), with these exact assertions:
  - `commandParts('git branch -D a c; git push origin :a :b')` → `['git branch -D a c', 'git push origin :a :b']`
  - `commandParts('C=/r; cd $C\ngit branch -D a\ngit push origin :a 2>&1 | tail -1')` → `['cd $C', 'git branch -D a', 'git push origin :a 2>&1', 'tail -1']`
  - `commandParts('git commit -m "a; b | c" && echo ok')` → `['git commit -m "a; b | c"', 'echo ok']`
  - `commandParts("x=$(awk '{print $3}' f); git push origin :$x")` → `['git push origin :$x']`. A pure assignment is dropped, and nothing inside `$(…)` is split.
  - `commandParts('for b in a c; do git branch -D "$b"; done')` → `['git branch -D "$b"']`
  - `commandParts('if git diff --quiet; then echo same; fi')` → `['git diff --quiet', 'echo same']`
  - `commandParts('cat <<EOF > f\nrm -rf /\nEOF\ngit status')` → `['cat <<EOF > f', 'git status']`
  - `commandParts('FOO=1 git push origin :a')` → `['git push origin :a']`
  - `suggestPrefix('git push -q origin --delete i18n-update-1794831697271')` → `'git push -q origin --delete'`
  - `suggestPrefix('gh pr view 208 --repo $R')` → `'gh pr view'`
  - `suggestPrefix('git worktree remove --force /tmp/oc-batch')` → `'git worktree remove --force'`
  - `suggestPrefix('./run.sh x')` → `'./run.sh'` (at least the first word)
  - `checkPrefix('git branch -D', 'cd x; git branch -D a')` → `null`
  - `checkPrefix('git bra', 'git branch -D a')` → error (not on a word boundary)
  - `checkPrefix('git push origin', 'git branch -D a')` → error (not part of the command)
  - `checkPrefix('git *', …)`, `checkPrefix('', …)`, `checkPrefix('a\nb', …)` → errors
  - `checkPrefix('sh -c', "sh -c 'x'")` → an error mentioning that Auto ignores such rules
  - `ruleOfPrefix('git branch -D')` → `'Bash(git branch -D:*)'`. `prefixOfRule` round-trips it, and returns null for `'Bash(git:*) x'`, `'Bash(a*b:*)'` and `'Edit(x)'`.
  - `coveredBy('git branch -D a', ['Bash(git branch -D:*)'])` → that rule. `coveredBy('git branch -Dx', …)` → null.
  - `continueText(['Bash(a:*)'], 'chat', 'loc', null)` → ``'I allowed `Bash(a:*)` for this chat. Continue.'``
  - `continueText(['Bash(a:*)', 'Bash(b:*)', 'Bash(c:*)'], 'agent', 'loc', 'loc')` → ``'@loc I allowed `Bash(a:*)`, `Bash(b:*)` and `Bash(c:*)` for loc. Continue.'``
- [ ] **Step 2: Watch them fail.** Run `npx vitest run zumi-bot-server/shared/tests/allowRules.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `allowRules.ts`.
  - `commandParts` is a single left-to-right scanner. It tracks single quotes, double quotes, backslash escapes, `$(`…`)` depth and backticks. It splits at top level on `\n`, `;`, `&&`, `||`, `|` (not `||`) and a lone `&` (never the `&` of a redirection: `2>&1`, `>&2`, `&>f`, `&>>f`).
  - When a part contains `<<WORD` or `<<-WORD` (quotes around WORD allowed), the following lines up to a line equal to WORD (trimmed for `<<-`) are skipped.
  - Then normalise each part: trim; strip leading keywords and `NAME=value` words repeatedly; drop parts that are empty, only keywords (`done fi esac } )`), or start with `for ` / `case `.
  - Dedupe, keeping order.
- [ ] **Step 4: Watch them pass.** Run the command from Step 2. Expected: PASS.

---

### Task 3: Mark classifier refusals (`blockedBy`)

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (tool item: `blockedBy?: 'classifier'`, `allowedAs?: 'chat' | 'agent'`)
- Modify: `zumi-bot-server/backend/src/core/chat/streamParser.ts` (`RunEvent` and `case 'system'`)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (handle the new event beside `case 'result'`)
- Create: `zumi-bot-server/backend/tests/fixtures/stream/tool-classifier.jsonl` (copy `tool-blocked.jsonl` and change its `permission_denied` line to `"decision_reason_type":"classifier","decision_reason":"[Destructive or Unwanted Actions]"`, with the spec's message text)
- Test: `zumi-bot-server/backend/tests/core/streamParser.test.ts`, `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces — Produces:**
- `RunEvent` member `{ kind: 'denied'; toolUseId: string; reasonType: string }`, emitted for `type: 'system', subtype: 'permission_denied'` with a string `tool_use_id` (`reasonType` is `String(m.decision_reason_type ?? '')`)
- Tool items get `blockedBy: 'classifier'` (and `blocked: true`) when `reasonType === 'classifier'`

- [ ] **Step 1: Write failing tests.**
  - streamParser: `events('tool-classifier')` contains `{kind:'denied', toolUseId:<id>, reasonType:'classifier'}`, and `events('tool-blocked')` contains one with `reasonType:'other'`.
  - chatService, using the existing fake-claude/recorded-stream pattern in that file: after a turn replaying `tool-classifier`, the stored tool item has `blocked: true, blockedBy: 'classifier'`. After `tool-blocked`, it has `blocked: true` and no `blockedBy`. After a card the user denies, it has no `blockedBy`.
- [ ] **Step 2: Watch them fail.** Run `npx vitest run --project backend -t "classifier"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Parser branch in `case 'system'`, before the `init` guard.
  - In chatService, `case 'denied'`: `if (e.reasonType === 'classifier') patchTool(e.toolUseId, () => ({ blocked: true, blockedBy: 'classifier' }))`, then `saveAndPush(false)`.
  - The ACP/AG-UI/Codex runners never emit it.
- [ ] **Step 4: Watch them pass.** Run the command from Step 2, then `npm run typecheck`. Expected: PASS.

---

### Task 4: Store the rules and pass them to Claude turns

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`AgentRule.cli?: string`, `ChatMeta.allowRules?: string[]` with a trailing comment like its neighbours)
- Modify: `zumi-bot-server/backend/src/core/store/approvalStore.ts` (`isRule` accepts an optional string `cli`; new `cliRules`)
- Create: `zumi-bot-server/backend/src/core/chat/allowRules.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`
  - deps `agentRules` gains `cli(agent: string): string[]`
  - `claudeRun` `extraArgs` gains `...allowArgs`
- Modify: `zumi-bot-server/backend/src/app.ts` (`agentRules.cli: (a) => approvals.cliRules(a)`)
- Test: `zumi-bot-server/backend/tests/core/approvalStore.test.ts`, `zumi-bot-server/backend/tests/core/allowRules.test.ts`, `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: `prefixOfRule` (Task 2)
- Produces:
  - `ApprovalStore.cliRules(agent: string): string[]` (the `cli` of every rule that has one, in stored order)
  - Agent CLI rule stored as `{ key: JSON.stringify(['cli', rule]), toolName: 'Bash', command: null, cli: rule }`
  - `allowSettingsArgs(chatRules: readonly string[] | undefined, agentRules: readonly string[], mode: RunMode): string[]`
    - returns `[]` when `mode === 'plan'` or when no valid rule remains
    - otherwise returns `['--settings', JSON.stringify({ permissions: { allow: [...] } })]`, chat rules first, deduped, keeping only rules `prefixOfRule` accepts

- [ ] **Step 1: Write failing tests.**
  - approvalStore: an `add` with a `cli` rule round-trips through a reload, and `cliRules` returns it.
  - approvalStore: `has(agent, <any agentAllowKey>)` stays false for it.
  - approvalStore: `renameAgent` moves it, and `forgetAgents` drops it.
  - approvalStore: a file written by the old shape (no `cli`) still loads.
  - `allowRules.test.ts`: `allowSettingsArgs(['Bash(a:*)'], ['Bash(a:*)','Bash(b:*)'], 'auto')` → `['--settings','{"permissions":{"allow":["Bash(a:*)","Bash(b:*)"]}}']`. Mode `'plan'` → `[]`. Junk `['Edit(x)', 'Bash(*)']` → `[]`.
  - chatService: a chat with `allowRules: ['Bash(git branch -D:*)']` spawns claude with a `--settings` value (after `oneSettings` merging) whose `permissions.allow` contains it. The same chat with `permissionMode: 'plan'` does not.
  - chatService: a room member's run gets the room's `allowRules`.
- [ ] **Step 2: Watch them fail.** Run `npx vitest run --project backend -t "allow"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Read the chat's `allowRules` from the stored meta once per attempt, where the agent's own run config (`own`) is resolved.
  - Compute `allowArgs = allowSettingsArgs(meta.allowRules, this.d.agentRules?.cli(ruleAgent()) ?? [], <the run mode passed to claude.start>)`.
  - Leave side runs and Compact untouched (they do not use `claudeRun`'s extraArgs; confirm this in the code).
- [ ] **Step 4: Watch them pass.** Run the command from Step 2, then `npm run typecheck`. Expected: PASS.

---

### Task 5: `chats:allowBlocked` RPC

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.chats.allowBlocked`)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (method `allowBlocked`, error constants)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`'chats:allowBlocked'`: check args with `str()`/`strings()`, scope must be `'chat'|'agent'`, then `writable(id)`; on agent scope call `d.approvalsChanged(agent)`)
- Modify: `zumi-bot-server/frontend/src/net/api.ts` (map `allowBlocked`)
- Modify: `zumi-bot-server/backend/src/app.ts` (`agentRules.addCli: (a, rule) => approvals.add(a, { key: JSON.stringify(['cli', rule]), toolName: 'Bash', command: null, cli: rule })`, awaited, then `approvalsChanged(a)`)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts` (or `tests/rpc/handlers` beside the `approvals:*` tests)

**Interfaces:**
- Consumes: `commandParts`, `checkPrefix`, `ruleOfPrefix`, `continueText` (Task 2), the stored-rule shape and `agentRules.cli` (Task 4), `blockedBy` (Task 3)
- Produces:
  - chatService deps `agentRules.addCli(agent: string, rule: string): Promise<void>` (awaited; the existing `add` stays fire-and-forget for cards)
  - `ZumiBotApi.chats.allowBlocked(chatId: string, toolUseId: string, prefixes: string[], scope: 'chat' | 'agent'): Promise<{ rules: string[]; text: string }>`
  - `ChatService.allowBlocked(chatId, toolUseId, prefixes, scope): Promise<{ rules: string[]; text: string; agent: string }>`
  - Error messages exported as constants: `NOT_ALLOWABLE` ("This call was not refused by Auto mode, so a rule cannot help"), `CHAT_BUSY` ("Wait for the reply to finish"), `ALREADY_ALLOWED`, and the `checkPrefix` message, unchanged.

- [ ] **Step 1: Write failing tests.**
  - **Success, chat scope** (single chat): meta gains `allowRules`; the item gains `allowedAs: 'chat'`; `push` sees `kind: 'items'` and `kind: 'meta'`; the result `text` equals `continueText(...)`.
  - **Success, agent scope**: `approvals.cliRules(agent)` contains the rule, and `allowRules` is unchanged.
  - **Success, room**: the `text` starts with `@<item.agent> `.
  - **Refused**:
    - a tool row without `blockedBy` → `NOT_ALLOWABLE`
    - a non-Bash row → `NOT_ALLOWABLE`
    - agent `zumi-bot` → `NOT_ALLOWABLE`
    - a chat with `workflow` set → `NOT_ALLOWABLE`
    - `meta.inFlight` → `CHAT_BUSY`
    - a second call for the same row → `ALREADY_ALLOWED`
    - a prefix `sh -c` → the interpreter message
    - 0 or 11 prefixes → error
  - Every refusal leaves meta, items and `approvals.json` unchanged.
- [ ] **Step 2: Watch them fail.** Run `npx vitest run --project backend -t "allowBlocked"`. Expected: FAIL.
- [ ] **Step 3: Implement the method.**
  - Load meta and refuse when `inFlight`. Load the items and find a `type === 'tool'` item with that `id`. Check the conditions. Validate every prefix against `item.input.command`.
  - Store the rules. Chat scope: `store.patchInPlace` merging deduped `allowRules`. Agent scope: `await this.d.agentRules.addCli(agent, rule)` for each rule.
  - Patch the item with `allowedAs`, then `store.saveItems` + `push({chatId, kind:'items', items, clearStreaming: false})` + push meta, following `finishPause`'s pattern.
- [ ] **Step 4: Watch them pass.** Run the command from Step 2, then `npm run typecheck`. Expected: PASS.

---

### Task 6: UI — Allow button, sheet, continue, Agent Studio label

**Files:**
- Create: `zumi-bot-server/frontend/src/state/allowBlocked.ts` (pure)
- Create: `zumi-bot-server/frontend/src/components/AllowBlockedSheet.tsx`
- Modify:
  - `zumi-bot-server/frontend/src/components/ToolCallRow.tsx` (button or "Allowed…" line under a qualifying row)
  - `ToolRun.tsx` (folded head line `⛔ Auto mode refused a command` + button, next to `sandboxRunLine`)
  - `MessageList.tsx` and `App.tsx` (thread an `onAllowBlocked(item)` handler and the chat; App opens the sheet, and on success calls its existing `sendMessage(chatId, text, …)` the way the composer does, not from the composer, so the draft is untouched)
  - `zumi-bot-server/frontend/src/state/approvals.ts` (`ruleLabel` for `cli` rules)
  - the matching `styles/*.css` (bottom sheet on phone, like the other phone menus)
- Test: `zumi-bot-server/frontend/tests/allowBlocked.test.ts`, `zumi-bot-server/frontend/tests/approvals.test.ts`

**Interfaces:**
- Consumes: `api.chats.allowBlocked` (Task 5), `api.approvals.list` (for the agent's held CLI rules), `commandParts`, `suggestPrefix`, `isSafePart`, `coveredBy`, `ruleOfPrefix`, `checkPrefix` (Task 2)
- Produces (in `state/allowBlocked.ts`):
  - `canAllowBlocked(item: ChatItem, chat: ChatMeta, running: boolean): boolean`: the spec's button conditions; `running` = the chat is in flight
  - `sheetRows(command: string, held: readonly string[]): { part: string; prefix: string; ticked: boolean; heldBy: string | null }[]`
  - `allHeld(rows): boolean`: every row that would start ticked is already held → the "still refused" state

- [ ] **Step 1: Write failing tests.**
  - `canAllowBlocked`: true only for a Bash tool item with `blockedBy: 'classifier'`, a string command, no `turn`, no `allowedAs`, agent not `zumi-bot`, a chat without `workflow`/`workflowTest`, and `running === false`. Write one false case per condition.
  - `sheetRows('C=/r; cd $C\ngit branch -D a\ngit push origin :a | tail -1', [])` → 4 rows; `cd $C` and `tail -1` unticked; `git branch -D a` row prefix `git branch -D`, ticked.
  - With `held = ['Bash(git branch -D:*)']`, that row has `heldBy` set and `ticked: true`. `allHeld` is true when the held rules also cover `git push origin`.
  - `ruleLabel({ key: '["cli","Bash(git branch -D:*)"]', toolName: 'Bash', command: null, cli: 'Bash(git branch -D:*)' })` → `'Bash: commands starting with git branch -D'`. Older rule labels stay unchanged.
- [ ] **Step 2: Watch them fail.** Run `npx vitest run --project frontend -t "allowBlocked|ruleLabel"`. Expected: FAIL.
- [ ] **Step 3: Implement the state module, the sheet and the wiring.** Copy and DOM hooks:
  - Sheet title: `Allow for <agent label>`. Group label: `Commands starting with:`.
  - Show the rules as code. Scope radios: `This chat` (default) and `Always for <agent label>`. Buttons: `Cancel` and `Allow and continue`.
  - Validate prefixes inline with `checkPrefix` and disable the button while any ticked prefix is invalid or none is ticked.
  - When `allHeld`, show `Claude Code still refused this although these rules are allowed:` with the list, and no Allow button.
  - Show RPC errors in the sheet.
  - DOM hooks (`data-testid`): `allow-blocked`, `allow-blocked-sheet`, `allow-blocked-part` (+ `data-part`), `allow-blocked-scope`, `allow-blocked-submit`, `allowed-as`.
- [ ] **Step 4: Watch them pass.** Run the command from Step 2, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Check it by hand.**
  - Run `npm run build:server` and start the preview server (`.claude/launch.json` if present; otherwise ask).
  - With a fake-CLI chat (Task 7's fixture), confirm the row and the folded-run button, the sheet on desktop and at the mobile size, that Allow sends the continue message, and that the row then reads `Allowed for this chat`.
  - Take a screenshot as proof.

---

### Task 7: E2E check and docs

**Files:**
- Create: `zumi-bot-server/e2e/allowBlocked.e2e.mjs` (harness like `resilience.e2e.mjs`). Create `zumi-bot-server/backend/tests/fixtures/fake-allow-claude.mjs`:
  - On the first turn it emits a Bash `tool_use`, a `system`/`permission_denied` with `decision_reason_type: 'classifier'`, the classifier error `tool_result`, and a `result` whose `permission_denials` lists it.
  - On later turns it writes its argv to `FAKE_ARGV_FILE` and replies `ok`.
- Modify: `package.json` (`e2e:allow`)
- Modify docs:
  - `docs/architecture/agents.md`: the Remembered approvals paragraph gets a CLI-rule sentence and a link to a new `## Allow a refused call` section in `docs/architecture/chat-mode-and-effort.md` (Auto). That section holds the flow, `blockedBy`, storage, Plan exclusion, the user's own ask/deny rules winning, and `probe:allow`.
  - `docs/architecture/governance.md`: the `allowedByMode` row also covers rules added this way.
  - `docs/architecture/data.md`: `approvals.json` gains the `cli` kind; `ChatMeta.allowRules`.
  - `docs/architecture/e2e.md`: `e2e:allow`.
  - `docs/architecture/ui.md`: `ToolCallRow` button.
  - User docs: `zumi-bot-docs/src/content/docs/chatting/approvals-questions-plans.mdx` gets a short section; `zumi-bot-docs/src/content/docs/agents/memory-and-approvals.mdx` gets one line on the new list entries.

- [ ] **Step 1: Write the e2e.** Checks:
  1. After the first message, `[data-testid=allow-blocked]` is visible on the folded run.
  2. Open the sheet, keep the defaults, submit.
  3. A user message `I allowed \`Bash(git branch -D:*)\` for this chat. Continue.` appears and a reply `ok` arrives.
  4. `FAKE_ARGV_FILE`'s `--settings` holds `"allow":["Bash(git branch -D:*)"]`.
  5. The row shows `[data-testid=allowed-as]`.
- [ ] **Step 2: Run it.** Run `npm run e2e:allow`. Expected: all checks PASS.
- [ ] **Step 3: Update the docs** listed above. Run `npx vitest run zumi-bot-server/shared/tests/repoDocs.test.ts`. Expected: PASS.
- [ ] **Step 4: Run the full verification.** Run `npm run typecheck && npm test`. Expected: all pass. Then stop: leave everything uncommitted for the user.
