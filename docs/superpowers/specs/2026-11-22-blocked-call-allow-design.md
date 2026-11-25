# Allow a blocked call and continue — design

Date: 2026-11-22. Status: draft for approval.

## Intent

An agent running in **Auto** hits a Bash command the Claude Code CLI refuses (the auto-mode classifier, typically for
something destructive like `git push origin --delete <branch>`). Today the agent stops, tells the user "add a Bash permission
rule", and waits. The user is often on the phone PWA and can do nothing from ZumiBot: remembered approvals are only made from
approval cards, and a classifier refusal never produces a card.

The user wants to **grant a specific permission from the chat and have the agent carry on by itself**, without typing
"continue" or editing settings files.

## How it works today (facts the design builds on)

- When the CLI refuses a call, the run's `result` lists it in `permission_denials`; `chatService` (`case 'result'`, ~line 2675)
  sets `blocked: true` on that tool item, and `ToolCallRow.tsx` shows `⛔ blocked: <title>`. No card, no action.
- ZumiBot's remembered approvals (`approvals.json`, `ApprovalStore`) are checked only when the CLI sends `can_use_tool`. In Auto
  the classifier decides Bash itself, so they cannot help here.
- Claude Code checks its own settings rules (`permissions.allow`) before the auto classifier. ZumiBot already passes exactly
  one merged `--settings` per turn (`oneSettings` in `claudeRunner.ts`; per-agent pieces from `agentRunConfig.ts`, sandbox,
  pause, vault guard, desktop/process/automation ask rules).
- Precedent for ZumiBot sending a message by itself: usage-limit waits send `continue` through `TaskQueue.continueLimit`
  (`limitResumes.ts`).

## Goals

- A blocked **Bash** row in a Claude chat or room offers **Allow…**.
- The user picks what to allow and for how long, then **Allow and continue**: the rule is saved, and ZumiBot sends a message
  that tells the agent what was allowed and to continue. The agent retries and the CLI lets the call run.
- Rules for an agent are visible and removable in Agent Studio beside the existing remembered approvals.

## Non-goals

- Other tools (Edit/Write/WebFetch/MCP) in v1. Their refusals are mostly ZumiBot's own guards (isolation deny rules, file hook,
  connectors), which an allow rule must not override.
- The agent asking for a permission mid-turn (a `request_permission` tool). Possible later, on the same rule store.
- Typing arbitrary rules in Agent Studio. v1 adds rules only from a blocked row; Agent Studio lists and removes.
- Viewing or removing chat-scoped rules after the fact. They live as long as the chat; the continue message records them.
- Codex, ACP and AG-UI agents (they never set `blocked`; no CLI `--settings`).

## Anti-goals (a failure even if it works)

- **An agent granting itself a permission.** Rules are created only by the user's click through one RPC. No agent tool, no
  bridge, no Zumi Bot automation can add one.
- A rule that silently widens to "anything": `Bash`, `Bash(*)`, `Bash(:*)`, an empty prefix, or a rule with a newline is refused
  by the server.
- A rule that overrides ZumiBot's own guards. CLI deny rules win over allow rules, so isolation, Zumi Bot's deny list and
  connector rules still hold; the design must not change that order (no rule moves into `deny`'s place, none removes a deny).
- Leaking the command into logs or URLs beyond what tool rows already store (conventions: secrets never in logs).

## Approaches considered

1. **Button on the blocked row, then auto-continue** — *picked by the user.* Works for any Claude agent with no agent change;
   costs one extra (resumed) turn.
2. Agent asks mid-turn through a new ZumiBot tool; approval applies the rule live via `updatedPermissions: addRules`. Smoother,
   but every agent must learn the tool, weak models stop and talk instead, and `addRules` over stdio is unproven.
3. Agent Studio rule list only. Simple, but the user still has to type "continue": misses the point.

## The design

### What the user sees

*Revised after the probe (see Probe findings): the real refused scripts are multi-line, and an exact whole-command rule does
not match a multi-line command, so the card grants one prefix rule per part of the command instead of an exact/prefix choice.*

*2026-11-22, at the user's request: the popup dialog / bottom sheet first drawn here was replaced by an inline card in the
message flow, like the question card (`AllowCard.tsx`). It sits right after the tool run, outside its fold.*

```
▸ Thought for 12s
┌ ⛔ Auto mode refused a command ──────────────────────────┐
│ cd /r && git worktree remove --force x && git branch -D a│
│ Commands starting with:                                  │
│ ☑ [git worktree remove --force      ]                    │
│ ☑ [git branch -D                    ]                    │
│ ☐  tail -1                                               │
│ Rules: Bash(git worktree remove --force:*)               │
│        Bash(git branch -D:*)                             │
│ ● This chat   ○ Always for Localization Manager          │
│ [Allow and continue]                                     │
└──────────────────────────────────────────────────────────┘
```

- The card shows for each tool item with `name === 'Bash'` and `blockedBy: 'classifier'`, a string `input.command`, in a
  chat/room whose agent (`item.agent ?? chat.agentName`) is not `zumi-bot`, that is not a workflow chat
  (`workflow`/`workflowTest` unset), and whose turn has ended (`item.turn` absent). States: **pending** (the latest turn),
  **running** (the chat is running: inputs and button disabled), **collapsed** (an older refusal: one line with **Allow…**
  that expands it in place), **done** (`allowedAs` set: one muted line, `Allowed for this chat` / `Allowed for <agent>`).
- The card lists the command's **parts** (`commandParts`, below). Each part gets a prefix field prefilled by `suggestPrefix`
  and a tick; parts whose first word is in a known-safe list (`cd`, `echo`, `tail`, `head`, `grep`, `ls`, `cat`, `wc`, `sort`,
  `sleep`, `true`, `pwd`, `printf`, `awk`, `sed`, `cut`, `tr`) start unticked; the rest start ticked. A part whose first word
  is a shell, interpreter or wrapper (below) is shown unticked and disabled with its reason and no prefix.
- A part already covered by a rule this chat or agent holds shows "already allowed" (ticked, disabled). If every ticked-by-
  default part is already covered, the card says "Claude Code still refused this although these rules are allowed" and lists
  them, with no button: nothing is re-sent. When the command also holds a part no rule can allow (a shell, interpreter or
  wrapper, or a refused folder), the card names that part as the blocker instead, since the held rules are not the problem.
- The card shows the resulting rule texts, so the user sees exactly what is granted. Default scope: **This chat**.
- On a phone the card is the same column as the question card; the prefix fields are 16px so iOS does not zoom.

### Which blocked rows qualify (`blockedBy`)

`blocked: true` is set in four places today: the user's Deny on a card (`blockTool`, ~2161 and ~2217), an
`APPROVAL_REQUIRED` result (~2441), and every id in `permission_denials` (~2676), which also covers ZumiBot's own deny/ask
rules and hooks. An allow rule only helps against the classifier: a deny rule beats it (the agent would loop), and a user's
Deny or a pause must never turn into an Allow button. So the tool item gets **`blockedBy?: 'classifier'`**, set only from the
CLI's `system` / `permission_denied` message whose `decision_reason_type` is `"classifier"` (verified; a rule-caused ask comes as
`can_use_tool` with `decision_reason_type: "rule"`). Every other block leaves it unset, and so do older items: no button.

### Rule shape

- One rule per ticked part: `Bash(<prefix>:*)` (Claude Code's prefix form). No exact form: it does not match a multi-line
  command, and a prefix that is the whole part is nearly as narrow.
- `commandParts(command)` (shared, pure): splits on newlines, `;`, `&&`, `||`, `|`, `&` outside quotes, `$(…)` and backticks;
  skips heredoc bodies; strips leading shell keywords (`if`, `then`, `else`, `elif`, `do`, `while`, `until`, `!`, `{`, `(`) and
  leading `NAME=value` assignments; drops parts that are only keywords (`done`, `fi`, `esac`, `}`, `)`), only assignments, or a
  `for … in …` head. Order kept, duplicates dropped.
- `suggestPrefix(part)`: leading words while each matches `^-{0,2}[A-Za-z][A-Za-z-]*$`, at most 5, at least 1
  (`git push -q origin --delete i18n-update-17…` → `git push -q origin --delete`; `gh pr view 208 …` → `gh pr view`).
- Server validation of each prefix: trimmed, 1–300 chars, no `\n`/`\r`/NUL, no `*` (a `*` acts as a wildcard anywhere in a
  rule, as the user's own `Bash(git *push*--delete*)` rules show), first word not in the interpreter list, and a prefix of one of
  `commandParts(item.input.command)`, so a click can only grant a trimmed form of what was actually refused. 1–10 per call.
- **Prefixes Auto drops, or that would run any command**: first word `sh`, `bash`, `zsh`, `dash`, `fish`, `python`, `python3`,
  `node`, `deno`, `bun`, `ruby`, `perl`, `php`, `npx`, `env`, `sudo`, `eval`, `exec`, `xargs`, `ssh`, `ksh`, `csh`, `tcsh`,
  `pwsh`, `powershell`, `cmd`, `source`, `.`, and the wrappers `timeout`, `nohup`, `command`, `busybox`, `nice`, `time`,
  `stdbuf`, `setsid`, `doas`, `su`, `watch`, `nsenter`, `chroot`, `unshare`, `flock`, `ionice`, `taskset` is refused with a
  reason (verified for `sh`: Auto ignored `Bash(sh:*)`; a wrapper rule would run any command), since the user would see
  "Allowed" with nothing changing. The word is compared lowercased, without path, `.exe`/`.cmd`/`.bat`/`.com` and version; a
  first word that starts with a quote or holds `$` or a backtick is refused too. A git prefix must name the subcommand
  after git's global options (`git`, `git -C /x`, `git --work-tree=/x` alone are refused: every git command, and `-c`
  runs any program); `suggestPrefix` keeps every global option with its value, then the subcommand.

### Scopes and storage

- **This chat:** `ChatMeta.allowRules?: string[]` (Claude rule strings). Single chats and rooms; in a room it applies to every
  member's runs in that room (the row names the member; the rule is about the command, not the member).
- **Always for this agent:** a new rule kind in `approvals.json` via `ApprovalStore`, so rename (`renameAgent`), delete
  (`forgetAgents`) and the agents-folder watcher already handle it. Shape: `{ key: JSON.stringify(['cli', rule]), toolName:
  'Bash', command: null, cli: rule }`. The key never equals an `agentAllowKey`, so `has()` never matches a `can_use_tool` by it.
  Older servers load it as an inert rule.
- Every Claude turn's args get one more `--settings` piece `{"permissions":{"allow":[...chat rules, ...agent cli rules]}}`,
  merged by `oneSettings`, in **Auto, Ask permissions and Accept edits**. That matches how "Allow always for this agent"
  already works (it skips the card in every mode). **Plan** turns do not get it, so a plan stays read-only. Side runs
  (`/btw`), Compact and the moderator do not get it either.

### Allow and continue (one RPC)

`chats:allowBlocked(chatId, toolUseId, prefixes: string[], scope: 'chat' | 'agent') → { rules: string[]; text: string }`:

1. Load the chat, find the tool item by `toolUseId`; refuse unless it qualifies (above: classifier-blocked Bash, turn ended,
   agent not `zumi-bot`, not a workflow chat).
2. Validate every prefix (above) and build the rules. Store them (chat meta `allowRules`, or `ApprovalStore.add` per rule +
   `approvalsChanged(agent)`).
3. Mark the row (`allowedAs?: 'chat' | 'agent'` on the tool item), reset the items feed, and push.
4. Return the rules and the continue text. Single chat: ``I allowed `Bash(git branch -D:*)` and `Bash(git push origin:*)` for
   this chat. Continue.`` (`for <agent>` with agent scope); room: the same with `@<member> ` in front.

The client then sends `text` through its own `sendMessage` (App.tsx), the composer's path: optimistic bubble, queueing while
the chat runs, and the usual error handling. Errors name what is wrong (not blocked, wrong tool, invalid prefix), never echo
more than the command already on the row.

### Agent Studio

`RememberedApprovals.tsx` lists the new kind as `Bash: commands starting with git push origin --delete` /
`Bash: git push origin --delete foo` (`ruleLabel`), removable like the others. No add form in v1.

### Audit

Calls the CLI lets through by these rules arrive as `allowedByMode` (no request reaches ZumiBot), as with the user's own Claude
settings today; `governance.md` says so. No new audit event in v1.

## Probe findings (2026-11-22, Claude Code 2.1.329, Haiku, `--permission-mode auto --permission-prompt-tool stdio`)

Throwaway local repo and bare remote; the prompt told the agent to run a script from a notes file. Ad-hoc script; Task 1 of
the plan turns it into `npm run probe:allow`.

| Case | Allow rules passed | Outcome |
| --- | --- | --- |
| `git branch -D a c; git push origin :a :b` | none (twice) | refused: `permission_denied`, `decision_reason_type: "classifier"` |
| same | exact whole command | ran |
| same | `Bash(git branch -D:*)`, `Bash(git push origin:*)` | ran |
| multi-line `C=…; cd $C` / `git branch -D …` / `git push … \| tail -1` | none | refused (classifier) |
| same | exact whole command | **still refused** |
| same | the two prefix rules | ran |
| `sh -c '…'` | `Bash(sh:*)` | refused: Auto drops interpreter rules |
| `git push origin --delete a b` | `Bash(git push origin --delete:*)` | `can_use_tool` (`decision_reason_type: "rule"`, source `userSettings`): the user's own ask rule `Bash(git *push*--delete*)` wins over an allow rule, so a card shows, as it should |

The user's real refused chats (`Auto merge localization`, Nov 18) were multi-line scripts refused with the same classifier
message ("[Destructive or Unwanted Actions]").

Case d (committed probe, `npm run probe:allow`, Claude Code 2.1.329): `for b in probe-a probe-c; do git branch -D "$b"; done`
with `Bash(git branch -D:*)` RAN. The same loop with no rules also ran (the classifier allows it unaided, 2 of 2 ad-hoc runs and
the probe's `d0` control), so this does not show that the CLI splits `for … done` bodies for rule matching. Whether a loop the
classifier does refuse is let through by a prefix rule is still unknown; if not, that row comes back refused and the card shows
the "still refused" state. The probe keeps the user's own Claude settings: with `--setting-sources project,local` the classifier
let the single-line script of case a run (3 of 3), so nothing could be told.

## Calls made by the designer (check these)

- Button only for classifier refusals, never for a user's Deny, a deny rule or a hook (`blockedBy`).
- One prefix rule per part, no exact form (probe: exact does not match multi-line commands).
- Rules apply in Auto, Ask permissions and Accept edits; never in Plan.
- No `*` in rules; interpreter/shell prefixes refused rather than stored and silently ignored.
- The user's own Claude ask/deny rules still win (Claude Code's order); ZumiBot does not work around them.
- Workflow chats get no button; to-do task chats, attempts and rooms do. In a room a chat-scope rule covers every member.
- Default scope is this chat; safe-looking parts start unticked.
- The continue message is sent by the client's normal send path after the RPC returns.

## Left to the builder

- Component and CSS structure of the card; wording polish within the above.
- Whether the "turn ended" check uses the item's `turn` field or chat `inFlight`.
- Unit tests (pure rule building/validation in `shared`, store round-trip, RPC handler refusals) and one e2e check with the
  fake CLI emitting `permission_denials` then a resumed turn whose argv carries the allow rule.
- Docs: `docs/architecture/agents.md` (remembered approvals paragraph), `chat-mode-and-effort.md` (Auto), `governance.md`
  if an audit event is added, and the user docs page for approvals in `zumi-bot-docs/`.
