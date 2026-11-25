# Governance: audit log and agent isolation

Status: **Part 1 (audit log) is built** (Phase 1); where the build differs from the Phase 0 design, the text below says what was built. **Part 2 level 2 (Sandboxed) is built** (Phase 2, 2.3), and **level 3 (Container) is built** (Phase 3, 2.4), on this PC only so far. Each later phase updates this doc as it lands.

Two features:

1. **Audit log.** One record per tool call any agent makes, on any engine and in any kind of run, saying who decided it and how.
2. **Isolation.** Per agent, keep its writes to its own folder and its network to an allowlist, by the CLI's own OS sandbox (level 2) or a container (level 3).

Rules that hold in every phase: no `--dangerously-skip-permissions`, no `bypassPermissions`, no `dontAsk`; isolation never loosens approvals on its own (a looser mode for a sandboxed agent is a separate per-agent choice, and a plan is never auto-allowed); agents with isolation off run exactly as today; secrets never reach a log, the audit log, a URL or an error message; only the user changes an agent's isolation or network list (Zumi Bot cannot lower it); no agent tool reads or clears the audit log.

---

## Part 1 — Audit log

### 1.1 Where records come from

Every tool call already passes through one of two event loops, so the log is fed from those, not from the CLI's own logs:

| Run kind | Engine | Event sink | Notes |
| --- | --- | --- | --- |
| Single chat turn | Claude, Codex, ACP, AG-UI | `ChatService` turn loop (`chatService.ts`, `toolUse` / `toolResult` / `permissionRequest` / `result`) | |
| Room member | Claude, Codex, ACP | same loop (`GroupService` runs members through `ChatService`'s turn) | moderator and room summary run no tools: not recorded |
| Routine run | Claude, Codex, ACP, AG-UI | same loop | carries `routine: {id, runId}` |
| Workflow Agent step | Claude, Codex, ACP, AG-UI | same loop | carries `workflow: {id, runId, stepId}`; the run view's own Audit log (`AuditLog.tsx`) stays as it is |
| A→B asked run | Claude, Codex, ACP | same loop | `runKind: 'asked'`, `askedBy` = asking agent |
| Side question (`/btw`) | Claude, Codex | `core/btw/sideRun.ts` `onEvent` | tools are blocked there by the side guard, so most records read `deniedByHook` |
| Dispatched subagent | Claude, Codex | same loop, `subToolUse` / `subToolResult` (Codex: `subAgentActivity`) | `subagent` + `parentToolUseId` link to the Agent row and its dispatch entry |
| Compact, keep-warm ping, moderator, room summary, voice title | — | — | run no tools; not recorded |

**ACP and remote agents** ([Protocol engines](protocol-engines.md), Governance, connectors and card comments). `engine` is any `Engine`. An ACP agent's rows, cards and answers come through the same loop and branches as a Claude agent's, so its records read the same (a call it ran without asking is `allowedByMode`: its own mode allowed it). A remote (AG-UI) agent's tools run on its own server: each of its rows is recorded as `ranRemotely`, a call it asked ZumiBot to run (which ZumiBot never does) as `deniedByZumiBot {remoteTools}`, and a row an interrupt's question card answered keeps `approvedByUser`. The tap picks this by the `remote` cap. Neither engine has side questions or dispatch, so neither has records of those kinds.

One class, `AuditTap` (`core/audit/auditTap.ts`), is handed every `RunEvent` of a run (both sinks call `tap.event(e)` next to their own handling, after the vault scrub) plus the outcome of each permission answer (`tap.decided(requestId, decision, answer?)`), so the record logic lives in one place. `AuditService.tap(run, deps)` (`auditService.ts`) makes one per run: `ChatService.agentTurn` once the chat's meta is read (never for a Compact), and `SideQuestions` for each side run (keep-warm pings run no tools and get none). A routine run's link comes from `RoutineRunner.routineOfChat`; a workflow step's from the chat's `workflow` meta. The run kind is `workflow` (meta.workflow), `asked`, `room` (a member turn has an author), `routine` (`spec.auto`), else `chat`.

### 1.2 The record

One JSON object per line. One record per tool call, written once the call is settled (result, denial, or turn end).

The types are `AuditRecord` and `AuditDecision` in `shared/src/audit.ts`. A record holds `v: 1`, `id` (uuid), `ts` (when the call was announced), `durationMs` (announce → result; null when it never ran), `machine` (first 8 hex of sha256 of host name + data dir), `chatId`, `itemId` (the chat item Show in chat lands on: the call's own tool row, a subagent call's Agent row, null for side runs), `turnId` (a room turn's id, else the user message the reply answers), `agent`, `subagent`, `parentToolUseId`, `engine`, `runKind`, `routine?: {id}`, `workflow?: {id, runId, stepId}`, `mode` (the run's permission mode; `side` for side runs), `isolation` (`'off'` until Phase 2), `tool`, `input` (redacted), `inputCut` (the original JSON length when cut), `decision`, `answer?` (a question card's answers, a plan's approve/feedback), `outcome` (`ok | error | denied | interrupted | noResult`), `error` (redacted, 2 000 chars), `prev` (chain hash).

Decisions as built:

| kind | when |
| --- | --- |
| `allowedByMode` | no permission request reached ZumiBot (the CLI's mode, its own allow rules, rules added from a blocked command's Allow card ([Allow a refused call](chat-mode-and-effort.md#allow-a-refused-call)) or the auto classifier), or a failed call the result did not list as denied |
| `allowedByChatRule` | "Allow for this chat" (card `auto-allowed`) |
| `allowedByAgentRule {rule}` | a remembered agent rule, with its `approvals.json` key |
| `allowedByWorkflowRule` | a workflow step rule |
| `allowedByAllowlist {host}` | a sandboxed agent's `WebFetch` to an on-list host in auto mode (2.3) |
| `allowedByZumiBot {why}` | `todos`, `vault`, `automation`, `ask` (ZumiBot's own bridges, no card), `sideAsk` (a side answer's one allowed tool), `connectorRead` (a claude.ai connector read, see [Connectors](connectors.md)) |
| `approvedByUser {scope}` | `once`, `chat`, `agent`, `step`; also an answered question card and an approved plan |
| `deniedByUser` | Deny, a skipped question, a plan sent back |
| `deniedByRule` | a failed call the run's `result` lists in `permission_denials` with no request |
| `deniedBySandbox {target}` | a sandboxed run's call the sandbox refused: the CLI's `<sandbox_violations>`, `Read-only file system`, the file guard's line, or ZumiBot's off-list `WebFetch` refusal; set ahead of the hook check and over an allow (2.3) |
| `deniedByHook {hook}` | its error names `VAULT_GUARD_TEXT` (`vaultGuard`), `AUDIT_GUARD_TEXT` (`auditGuard`), the spend cap's or pause's text, the side guard's, or a `PreToolUse … hook` error (`other`); Codex's `Blocked` rows the same way |
| `deniedByZumiBot {why}` | `writeRefused`, `questionsDenied`, `sideGuard`, `unknownRequest`, `connectorOff` (a connector off for the agent), `connectorUnattended` (a connector write in an unattended run), `remoteTools` (a remote agent asked ZumiBot to run a tool, answered with `AGUI_TEXT.noTools`) |
| `unanswered` | a card cancelled or left open when the run ended |
| `ranRemotely` | a remote (AG-UI) agent's row: its own server ran it, and no approval reached ZumiBot (a muted chip) |
| `runByUser` | a shell block the user ran with its Run button (tool `Run`, input `{command, cwd}`): no agent call and no card, so the click was the approval. One record per Run, written when it ends by `runAudit.ts` (see [Run button](run-blocks.md)) through `AuditService.record` (a muted chip). `ts` is the start, `itemId` the message, `agent` the block's author; the outcome is `ok`, `error` or `interrupted`, with a code as the error |

Phase 2 adds `allowedByAllowlist {host}` and `deniedBySandbox {host?, path?}`.

**How the decision is worked out.** The tap keeps a map `toolUseId → open record` for the run.

- `toolUse` / `subToolUse` opens a record (`ts`, tool, input).
- `permissionRequest` carries `toolUseId`. The branch `ChatService` takes on it (own todo, own vault, own automation, write refused, questions denied, chat rule, agent rule, workflow rule, card) is reported to the tap at that branch; a card's later `answer` / `answerQuestions` / `answerPlan` reports the user's choice. This is the only place that knows the rule, so the branch calls `tap.decided(toolUseId, decision)` itself rather than the tap guessing from card statuses.
- `toolResult` closes it: `outcome` from `isError`, `durationMs`. If no decision was set, a hook's text in the error makes it `deniedByHook`. A successful call with no decision is written at once as `allowedByMode`; a **failed** one with no decision waits for the run's `result`, since only `permission_denials` there tells a CLI deny rule apart from a command that simply failed. (The CLI's exact hook-error wording was not checked against the real CLI; the hook texts themselves are matched by substring.)
- `result.denials` (the CLI's `permission_denials`) marks still-open records of those ids as `deniedByRule` unless a decision already exists.
- Codex: a `CODEX_BLOCKED_TOOL` row is `deniedByHook` by its stderr text; `auto_review` approvals are `allowedByMode` (Codex's reviewer, trusted as Claude's classifier is).
- Turn end: what is still open is written as `interrupted` (stopped) or `noResult`.

**Honest limit.** `allowedByMode` cannot tell the CLI's mode apart from an allow rule in the user's own Claude Code settings or the auto-mode classifier's yes: none of them reaches ZumiBot. The record carries `mode`, which is what is known.

### 1.3 What is not recorded

Tool **results** are not stored (only `outcome` and, on failure, the error text). A result is often a file or a page; storing it would make the log a second copy of everything an agent read, and the session log already has it. The to-do tools (`zumibot_todos`) are recorded like any other call; they are hidden from the chat but not from the audit.

### 1.4 Redaction (before anything is written)

Pure module `core/audit/auditRedact.ts`, applied in this order:

1. **Vault values.** `scrubValue(input, scrub)` with the run's own scrubber (`scrubBridges.ts`, the same grants the chat items use), so every value becomes `[vault: <name>]`. Answers and error text go through `scrubText`. Side runs use their base agent's grants, as today.
2. **Browser tools.** Input stored as `{}`; error text as the fixed `Browser command failed.` (the dispatch rule).
3. **Desktop tools.** Results as the fixed `Desktop command failed.`; input kept only for its action shape: `desktop_type`'s `text` becomes `{chars: n}`, everything else (coordinates, key names, app names) kept. This is stricter than dispatch, which keeps desktop input whole, because typed text is the one desktop input that can carry a secret.
4. **`browser_fill_from_vault`.** Input as the chat row shows it (`fillRowInput`: item and field names only); a side run has no row helper and stores `{}`.
5. **Known secret shapes** outside the vault (`sk-ant-`, `sk-`, `ghp_`, `github_pat_`, `xox[abp]-`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----`, `Bearer <token>` in a header-looking string): replaced by `[secret]`. A short fixed list in `auditRedact.ts`, tested one by one. It is a net, not a guarantee (see limits).
6. **Cut.** Input JSON over 20 000 characters (dispatch's input cap, reused from `core/dispatch`) is cut: long string fields are shortened from the longest first and marked `…[cut N chars]`, so the JSON stays valid; `inputCut` holds the original length. Error text 2 000 characters, answers 20 000.

Redaction runs in the tap before the record leaves memory; the writer never sees raw input.

### 1.5 Storage

- Folder `<data>/audit/` (0700). Files `audit-<yyyymmdd-hhmmss-mmm>.jsonl` (UTC, 0600), appended through one writer queue per server (`AuditLog`, `core/audit/auditLog.ts`), one `appendFile` per line.
- **Rotation** by size: a file over **16 MiB** is closed and a new one started.
- **Total cap** **512 MiB** (about 1–2 million records): when the folder passes it, the oldest file is deleted (whole files only). Both numbers live in `shared/src/audit.ts`; the total cap is chosen in Settings › Audit log (128 MiB / 512 MiB / 2 GiB) and kept in `<data>/audit/cap.json` (0600, per machine). The oldest file goes whole, so the folder can sit up to one file (16 MiB) over the cap.
- **No time-based expiry** beyond the size cap (the user asked for size rotation).
- A write failure logs only its error code (`audit write failed: ENOSPC`), never fails or slows a turn, and bumps a counter shown on the page ("N records could not be written since start"). The log is fail-open by choice: an audit hiccup should not stop the user's work. (A fail-closed switch is possible later; not in scope.)
- Each file starts with a header line `{v:1, kind:'head', machine, created, prevFile: <name>|null, prevHash}` so the chain runs across files. At start the server reads every file once for its times and counts and the newest file's last hash, so the chain continues across a restart; a log that cannot start counts each later write as a failure and never stops the server.
- `data.md` gains the folder; `deploy/sync.mjs` adds `audit` to `LOCAL_ONLY_EXCLUDES` (rsync there is an exclude list, so without it the log would sync), which also keeps it out of the deploy backup copy.

### 1.6 Keeping agents out of it

Agents run as the same OS user as the server, so with isolation off nothing below is a hard wall; it is the same speed bump the vault files have. With isolation on, it becomes a wall (see Part 2).

- **Guard paths.** The vault guard's path list (`vaultGuard.ts`) grows into a private-paths list: the vault key's folder, `vault.json`, **and `<data>/audit/`**. Same deny rules (`Read`, `Edit`, `MultiEdit`, `Write`, `Grep`, `Glob`) and the same Bash `grep -qF` hook, and the Codex hook on every tool (`GuardPaths.auditDir`, set by `app.ts`). Message text stays `VAULT_GUARD_TEXT` for vault paths; audit paths get their own `AUDIT_GUARD_TEXT`, so the record says which. With the audit folder the hook reads the call's JSON once (`i=$(cat)`) and runs two greps over it; without one it is byte for byte the old command. Not yet done: `vaultGuardProbe.mjs` (real CLI, costs quota) still checks only the vault paths. An ACP agent's run has no guard beside it (no hook protocol; `vaultKeys` off), so only the cards its own reads, edits and commands ask for keep it off the folder, and Verify chain shows a changed record (see [Protocol engines](protocol-engines.md)); a remote agent runs nothing here.
- **No tool.** There is no MCP tool, bridge method or Zumi Bot tool that reads, lists, exports or clears audit records. The RPC methods are served only to signed-in UI sockets, like every other `area:verb`.
- **Hash chain.** Each record's `prev` is the SHA-256 of the previous line's bytes in the file (the header's for the first). The server keeps the last hash of the open file in memory. At start and on demand (a **Verify** button on the page) it walks the files and reports the first broken link: an edited, inserted or deleted line shows as "chain broken at <file>:<line>". A line removed from the very end while the server was off is only caught if the next file's header names a `prevHash` that no longer matches, so deletion of the newest records of the last file before a restart is the one edit the chain cannot see. No key is involved (an agent able to write the file could rebuild the chain), so this detects careless or partial tampering, not a determined same-user attacker.
- **Rotation is the only delete.** Nothing in the UI or API removes records; the size cap drops whole oldest files.

### 1.7 Two machines

The log is **never synced**. The PC and the VPS each keep their own, for the runs that happened on that machine; a chat runs on one machine at a time (see the PC/VPS sync rules), so a record has exactly one home. The page shows this machine's records and names the machine. To view both, export each and concatenate: ids are UUIDs and `machine` says where each came from, so joining is a plain merge sorted by `ts`. Nothing deduplicates, because nothing is ever in both.

### 1.8 UI — Settings › Audit log

`/settings/audit`, after Claude Code (a test pins Claude Code right after Vault). `AuditLogSettings.tsx`; pure rules in `state/auditRecords.ts` (controls to filter, decision words, durations, sizes; `state/auditLog.ts` is the workflow run's own audit view), tested without a DOM. DOM hooks: `audit-page`, `audit-row` (+ `data-tool`, `data-decision`), `audit-search`, `audit-agent`, `audit-chat`, `audit-tool`, `audit-decision`, `audit-outcome`, `audit-range`, `audit-clear`, `audit-record`, `audit-why`, `audit-show-in-chat`, `audit-export`, `audit-cap`, `audit-verify`, `audit-verify-result`, `audit-fresh`, `audit-status`.

- **List**, newest first, 100 rows a page, more on scroll (cursor-based). Row: time, agent (and subagent), chat title, tool, a one-line input summary, decision chip, outcome, duration.
- **Filters**: agent, chat, tool, decision kind, outcome, time range (Last hour / day / week / custom), and **Search** over tool name and the redacted input JSON (case-insensitive substring).
- **Row opens** the full record above the list (pretty JSON, the decision explained in words) with **Show in chat**: App's `openItem` sets the same jump a search hit uses, but with no query, so the list opens the tool runs and scrolls to the call's row (older pages load until it is found). Side runs have no Show in chat. A workflow or routine link shows its ids only; an Open run button is not built. A chat since deleted reads "Deleted chat".
- **Export** writes the current filtered range as JSON Lines (`audit-<from>-<to>.jsonl`), streamed by an HTTP route so a large range never sits in one RPC message.
- **Footer**: this machine's name, folder size against the cap, write failures since start, **Verify chain**.

**API** (each touches `ZumiBotApi` in `shared/src/types.ts`, `rpc/handlers.ts` and `frontend/src/net/api.ts`; handlers check every argument):

- `audit:list(filter, cursor, limit?)` → `{rows: AuditRow[], next: string|null}`. `filter` goes through `parseAuditFilter` (strings at most 300 characters, known decision kinds and outcomes, finite times; unknown fields dropped); `limit` 1–200, default 100. A cursor and each row's `at` are a place, `<file>:<line index>`, checked against the file-name pattern and the folder's own files; lines only grow at a file's end, so a place never moves while new records arrive.
- `audit:get(id, at)` → `AuditRecord | null`: the record at the row's place, only when its id matches.
- `audit:facets()` → agents, tools and chats seen, for the filter menus (built on the first ask by one pass over the files, then kept up to date on append; reset when the cap drops a file).
- `audit:verify()` → `{ok: true, files} | {ok: false, file, line}` (line is 1-based, the file's header being line 1).
- `audit:status()` → `{machine, bytes, cap, failures, records}`.
- `audit:setCap(bytes)` → one of the three choices, then the status.
- `POST /api/audit/export` (`http/auditExport.ts`; JSON body = the filter, at most 8 KiB, never in the URL), behind the session gate and the Origin check like every API write; streams `application/x-ndjson`, oldest first, with back-pressure, as `audit-<from day>-<to day>.jsonl`. GET 405, a bad filter 400, a large body 413.
- Event `audit:changed` (empty payload, at most once a second) so an open page offers "New records — show them" instead of moving the list under the reader.

**Reading.** A page reads whole files (each at most 16 MiB) newest first and walks their lines backward; the last two files read are kept in memory, so scrolling does not reread them. The server keeps per file `{firstTs, lastTs, count}` so a time filter skips whole files. A search over a full cap is a linear scan; fine for a settings page. Export and facets stream line by line. No index file, no database, no new dependency.

### 1.9 Tests (phase 1, built)

- `backend/tests/core/audit/auditRedact.test.ts`: vault tags, browser `{}` and fixed lines, desktop typed text as length, fill rows, secret shapes, cuts that stay valid JSON under the cap.
- `auditTap.test.ts`: decision inference for every event order (mode, branch decision, failure waiting for denials, each hook text, Codex `Blocked`, answers, subagents, end with open calls and cards, request without a tool use id, workflow link).
- `auditLog.test.ts`: 0700/0600, pages and stable cursors while appending, `get` by place, rotation and cap, chain across restart, an edited and a removed line break it, failures counted, cap persists, facets, export filter.
- `auditChat.test.ts`: the real runner and the **fake claude** (`fixtures/fake-claude.mjs`, whose `#PRE_TOOL` now passes a tool input to the hooks) make six calls; the log holds `allowedByMode`, `allowedByAgentRule`, `approvedByUser`, `deniedByUser`, `deniedByHook: auditGuard` (the real guard hook from `--settings`) and `deniedByRule`.
- `vaultGuard.test.ts`: the audit folder in the deny rules; both hook forms block every spelling with the audit text and the vault with its own; without the folder the settings are unchanged.
- `rpc/auditHandlers.test.ts` (argument checks, no clearing handler), `http/auditExport.test.ts`, `shared/tests/audit.test.ts`, `frontend/tests/auditRecords.test.ts`; `sync.test.ts` checks `audit/` never syncs or goes into a backup.
- `npm run e2e:audit` (`e2e/audit.e2e.mjs`, fake claude, built server): file modes, the page lists the calls newest first with decisions, a filter and a search narrow it, a row opens its record and Show in chat lands on the call's tool row, Export gives JSON Lines, Verify chain says intact, the route refuses GET and a bad filter.

---

## Part 2 — Isolation

### 2.1 What Claude Code's own sandbox is (checked 2026-11-17)

Sources: the sandboxing page (code.claude.com/docs/en/sandboxing), the settings reference and precedence pages, the CLI reference, and the `sandbox-runtime` (srt) README. Each claim is **documented** (read in those pages) or **verified** (run on this PC against CLI 2.1.322 at the start of phase 2; `npm run probe:sandbox` re-checks the ones the code rests on).

**What it covers.** Only Bash (and PowerShell, Monitor) **and every process they start**, including Bash inside subagents, which share the parent's configuration. **Not** covered: `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch` (they follow permission rules: "a `denyRead` entry doesn't stop the Read tool, and `allowedDomains` doesn't limit WebFetch"), and **not** hooks, local (stdio) MCP servers, plugin monitors, LSP servers, the status line or `apiKeyHelper`, which "run with your full access". *(documented)*

**Filesystem.** Writes default to the working directory, a per-user temp directory and added directories; reads default to most of the machine, `~/.ssh` included. Keys: `sandbox.filesystem.allowWrite`, `denyWrite`, `denyRead`, `allowRead` (re-opens a path inside a denied region; the narrower path wins). `Edit` allow rules widen writes and `Read`/`Edit` deny rules narrow them, merged into the sandbox. Sandbox paths are absolute or `~/…`; permission-rule paths use `//abs` and `/project-relative`. *(documented)*

**Network.** Every connection goes through a proxy on the host. `sandbox.network.allowedDomains` starts empty, `deniedDomains` always refuses, `strictAllowlist: true` denies an off-list host instead of prompting. Without it, an off-list host prompts in manual and acceptEdits, and in **auto** mode goes to the classifier (which may say yes). Unix sockets: on Linux the path list `allowUnixSockets` is ignored (seccomp cannot filter by path); only `allowAllUnixSockets` exists, and only when the seccomp filter is present; without seccomp, sockets are open with a warning. *(documented; the seccomp filter is present in a sandboxed Bash on this PC: verified)*

**Escape hatch.** Bash's `dangerouslyDisableSandbox` retries a command unsandboxed (after an approval in manual mode, the classifier in auto). `allowUnsandboxedCommands: false` makes the CLI ignore it: a call with it set still ran inside, and its write never reached the host. `excludedCommands` run unsandboxed by design. *(documented; verified)*

**Fail closed.** Missing support or a failed dependency check at start makes the CLI run **unsandboxed** unless `sandbox.failIfUnavailable: true`, which makes it exit at start instead. Failures after start refuse the command. *(documented)*

**Platforms.** macOS (Seatbelt, built in), Linux and WSL2 (`bubblewrap` + `socat`, ripgrep bundled, optional seccomp filter). Not native Windows, not WSL1. Inside Docker it needs `enableWeakerNestedSandbox: true`, which "considerably weakens security"; Ubuntu's AppArmor can block bubblewrap. *(documented)* This PC: Claude Code 2.1.322, `bwrap` 0.9.0 and `socat` in `/usr/bin`, `apparmor_restrict_unprivileged_userns = 1`, and `bwrap --unshare-net` runs as this user. *(verified)*

**Layering.** Precedence, highest first: managed, `--settings`, `.claude/settings.local.json`, `.claude/settings.json`, `~/.claude/settings.json`. Scalars from `--settings` (such as `enabled`, `allowUnsandboxedCommands`, `failIfUnavailable`) cannot be loosened by a project file, but **list keys merge across scopes**, so a project's `allowWrite` or `allowedDomains` entries are added to ZumiBot's. `permissions.blockReadsOutsideWorkingDirectories` / `blockWritesOutsideWorkingDirectories` are honored from any scope. *(documented)*

**Reporting.** No stream-json field marks a sandbox violation. What the probe saw *(verified)*: an off-list host gives the command's own error plus the CLI's block `<sandbox_violations>\ndeny network-outbound api.github.com:443 (host is not on the allow list)\n</sandbox_violations>` in the tool result; a write to a readable-only folder gives `Read-only file system`; a path under a `denyRead` folder reads as `No such file or directory` (indistinguishable from a missing file); a write under a denied folder that is not writable lands in a throwaway layer and never reaches the host, with no error. Permission denials appear as `permission_denied` system messages and in the result's `permission_denials`.

**Two more facts the probe found** *(verified)*: `permissions.blockReadsOutsideWorkingDirectories` (and `…Writes…`) also checks the paths inside **Bash** commands, so with `autoAllowBashIfSandboxed: false` even `curl -o /dev/null` or `cat /etc/hostname` becomes a `can_use_tool` request (`decision_reason_code: outside_reads_blocked`, `classifier_approvable: false`) in auto mode. That rules the block keys out for level 2; ZumiBot's own hook holds the file tools instead (2.3). And an `ask` rule on `WebFetch` reaches the permission prompt even in auto mode and even beside an allow rule, so every fetch does reach ZumiBot; a `WebSearch` deny rule removes the tool.

**What this means for ZumiBot.** The CLI sandbox is a sandbox **for Bash only**. On its own it would leave `Read`/`Edit`/`Write`/`Glob`/`Grep` free to touch any path and `WebFetch` free to reach any host. Level 2 below is therefore three parts used together: the OS sandbox for Bash, permission rules for the file tools, and ZumiBot's own answer to every `WebFetch`. The good news for the bridges: MCP servers and hooks run **outside** the sandbox, so `zumibot_todos`, `zumibot_browser`, `zumibot_vault`, the desktop bridge, the pause hook and the vault guard keep their sockets and files with no extra grants *(verified: the probe's stdio MCP server wrote into the denied data dir, the pause hook blocked a call, and the vault guard blocked the key read, all in a sandboxed run; the hand check ran the to-do and vault bridges in a sandboxed chat)*.

### 2.2 The three levels

| | Level 1 — Off (today) | Level 2 — Sandboxed (CLI's OS sandbox) | Level 3 — Container |
| --- | --- | --- | --- |
| Bash and its children | full user access | bubblewrap / Seatbelt: writes only to the allowed folders, reads denied for the private set, network only through the allowlist proxy | container: only the mounts exist; network only through ZumiBot's proxy |
| Read / Edit / Write / Glob / Grep | full user access (vault guard deny rules only) | ZumiBot's file guard hook: reads and writes outside the run's folders blocked | only what is mounted exists |
| WebFetch / WebSearch | free | WebFetch: ZumiBot answers by the allowlist; WebSearch off unless allowed | same as level 2 |
| stdio MCP servers, hooks | user access | **user access** (outside the sandbox) | inside the container (ZumiBot's bridges and hooks too, with the image's node) |
| Platforms | all | Linux with bwrap+socat, macOS | Linux with rootless Podman and a native `claude` install |
| Cost per turn | none | ~tens of ms | one `podman run` per turn: ~0.1 s on this PC (measured) |
| Setup | none | `bubblewrap`, `socat` packages | a container runtime and a built image |

### 2.3 Level 2 in detail (Sandboxed) — built in phase 2

**Where it is set.** Agent Studio › **Isolation** (`AgentIsolation.tsx`, pure rules in `state/isolationForm.ts`): Off or Sandboxed, the network list, extra folders it may change, extra folders it may only read, **Allow web search**, and **Run sandboxed Bash without asking**. It saves on its own button through `isolation:set`, not with the agent file. The setting lives in `<data>/audit/isolation.json` (`IsolationService`, `core/isolation/isolationService.ts`; `{v: 1, agents: {<name>: AgentIsolation}}`, 0600, written whole), not in the agent's frontmatter as first designed: Zumi Bot edits agent files with its file tools, so a frontmatter key could not be kept from it. The audit folder is already behind the vault guard's deny rules and Bash hook, which therefore cover this file too, it is never synced (per machine, like whether bwrap exists), and only the UI's `isolation:set` writes it (no agent tool or bridge reaches the RPC). An agent with no entry is **Off** and its runs are byte for byte as before. An Agent Studio rename moves the entry in memory before its first await, like approvals; a rename done outside Agent Studio (Zumi Bot editing `name:`) leaves the entry under the old name, so the new name is Off (listed in 2.5). A file that cannot be read refuses **every** run (a damaged entry, that agent's runs) with a line saying to save the agent's Isolation again, never runs agents Off by accident. The global default for agents not set is Off (no setting yet; open question 4).

**Per-run config, never in the user's files.** `ChatService.agentTurn` asks `isolation.runFor(agent, {engine, cwd, tmpDir, addDirs, memoryDir})` on every attempt of a main run (single chats, room members, routines, workflow Agent steps, A→B asked runs), after the chat's temp folder is made and before the spawn. Off: nothing changes. Sandboxed: `sandboxSettings.ts` builds one inline JSON, added as a `--settings` that `oneSettings` merges with the vault guard, pause hook and desktop ask rules. Nothing is written to `~/.claude/settings*.json` or a project's `.claude/`. A Compact runs no tools and gets none; side runs block every tool by their own guard (`SIDE_GUARD_SETTINGS`), so their settings stay as they were.

```jsonc
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,          // never run unsandboxed silently
    "allowUnsandboxedCommands": false,  // dangerouslyDisableSandbox is ignored: no retry outside (verified)
    "autoAllowBashIfSandboxed": false,  // true only with the agent's "Run sandboxed Bash without asking"
    "excludedCommands": [],
    "filesystem": {
      "allowWrite": ["<cwd>", "<claude-tmp/hash>", "<repo or worktree git dirs>", ...extraWrite],
      "denyWrite":  ["<cwd>/.claude/settings.json", "<cwd>/.claude/settings.local.json", "<cwd>/.mcp.json", "<git dir>/hooks", "<git dir>/config"],
      "denyRead":   ["~/", "<data dir>", "<vault key folder>"],
      "allowRead":  [...allowWrite, "<--add-dir folders (attachments)>", ...toolchain, ...extraRead]
    },
    "network": { "allowedDomains": [...networkList], "strictAllowlist": true, "allowLocalBinding": false, "allowAllUnixSockets": false }
  },
  "permissions": {
    "deny": ["Edit|Write|MultiEdit on the denyWrite files and the git dirs", "WebSearch" /* unless allowed */],
    "ask": ["WebFetch"]                 // every fetch reaches ZumiBot (verified in auto mode)
  },
  "hooks": { "PreToolUse": [{ "matcher": "Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob", "hooks": [{ "type": "command", "command": "<node> <dist>/sandboxFileHook.mjs <roots>; [ $? -eq 0 ] && exit 0; exit 2" }] }] }
}
```

**Folders.** Writable: the chat's folder or worktree (the CLI's cwd), its `claude-tmp/<hash>` (`CLAUDE_CODE_TMPDIR`, re-opened inside the denied data dir), and the git dirs `gitDirsOf` finds from the cwd (the nearest `.git` folder, or a worktree's own and common git dir), so `git commit` works while hooks and config stay unwritable. Readable besides those: the system (`/usr`, `/etc`, … stay readable by default), the run's `--add-dir` folders (attachments), and the toolchain under home found on `shellEnv`'s `PATH` (`toolchainReads`: a version folder for a nested `bin` like `~/.nvm/versions/node/v22`, but a `bin` right under home or `~/.local` alone, since `~/.local/share` holds keyrings), plus `~/.gitconfig` and `~/.config/git`. Agent Studio lists every grant. The whole home folder, the data dir and the vault key folder are hidden from Bash.

**The file tools.** The CLI's sandbox does not cover them, and its `blockReads/WritesOutsideWorkingDirectories` keys also catch Bash (2.1), so ZumiBot's own PreToolUse hook (`fileGuard.ts`, built as `dist/sandboxFileHook.mjs` beside the pause hook and started the same way) holds `Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Grep` and `Glob` to the run's folders: reads to the cwd, the temp folder, the agent's memory folder, the `--add-dir` folders and the extra folders; writes to the cwd, the temp folder, the memory folder and the extra writable ones, never into a git dir or the folder's Claude settings. It resolves symlinks (a link out of the folder is caught), checks a Glob pattern that is absolute or climbs with `..`, and blocks on anything it cannot read. Any exit but 0 becomes 2 in the command, so a node that crashes or a missing entry blocks rather than lets the call run; a build without the entry refuses sandboxed runs. Its line is `Blocked by the sandbox: <path> is outside this agent's folders.`

**Network.** The list is host names with optional `*.` wildcards (a wildcard covers sub-domains, not the bare domain), validated by `hostError`: no scheme, port, path or IP except `127.0.0.1` and `localhost`. Bash: the sandbox proxy enforces it with `strictAllowlist`. `WebFetch`: the `ask` rule brings every call to `ChatService`, which refuses an off-list host (or a non-http URL) with `WEBFETCH_BLOCKED`, never a card, so no approval can widen the list mid-turn (audit `deniedBySandbox`). An on-list host runs without a card only in **auto** mode (audit `allowedByAllowlist`), where none was shown before; in every other mode it gets its usual card. `WebSearch` is denied unless **Allow web search** is on. The list is empty by default: no network.

**Approvals unchanged.** The run's permission mode is the chat's, as before. Bash still asks in manual mode (`autoAllowBashIfSandboxed: false`). **Run sandboxed Bash without asking** is the one looser choice, the user's own, per agent, off by default. A plan is still never auto-allowed.

**Settings that widen.** List keys merge across scopes, so at spawn `wideningRefusal` (`projectWiden.ts`) reads `.claude/settings.json` and `.claude/settings.local.json` in the cwd and every parent, the user's `~/.claude/settings*.json` and `/etc/claude-code/managed-settings.json`; a non-empty `sandbox.filesystem.allowWrite`/`allowRead`, `sandbox.network.allowedDomains`/`allowUnixSockets`, `sandbox.excludedCommands` or `permissions.additionalDirectories` refuses the run with a line naming the file and keys. `WebFetch` allow rules do not widen anything, since the `ask` rule beats them. The agent cannot add such keys to its folder's files: they are in `denyWrite`, the deny rules and the file guard's protected list.

**Showing a block.** `sandboxBlocks` (`shared/src/isolation.ts`) reads the CLI's `<sandbox_violations>` block, `WEBFETCH_BLOCKED` and the file guard's line (the CLI prefixes a hook's text, so it is matched anywhere), plus `Read-only file system` only where the caller knows the run was sandboxed (the audit tap). The chat shows `Blocked by the sandbox: <host or path>` under the tool row (`ToolCallRow`) and, while the run of calls is folded, under "Thought for …" (`ToolRun`, `state/sandboxLine.ts`). The audit tap marks such a call `deniedBySandbox` with its target, whoever allowed it, ahead of the hook check, and every record of a sandboxed run carries `isolation: 'sandbox'`. A path under a denied folder reads as `No such file or directory` and gets no label (the CLI cannot tell it apart). Nothing is retried outside the sandbox.

**Unavailable.** `checkSandbox` (`sandboxSupport.ts`): macOS yes; Linux needs `bwrap` and `socat` on the run `PATH` and one `bwrap --unshare-user --unshare-net true` to succeed (AppArmor's user-namespace block fails it); Windows and a server inside Docker or Podman (`/.dockerenv`, `/run/.containerenv`) no. `isolation:status` gives the reason (a failed check is not cached, so installing bwrap needs no restart), Agent Studio disables Sandboxed with it, and an agent already Sandboxed is refused a run with that reason as the chat's error. `failIfUnavailable` is the second lock.

**Codex, ACP and remote agents.** Isolation needs the `isolation` engine cap (`shared/src/engine.ts`), which only Claude has. Sandboxed is refused for any other engine with `isolationRefusal(engine, level)` (Codex's sentence is `CODEX_SANDBOX_REFUSED`, unchanged): `isolation:set` saves only Off for such an agent, Agent Studio shows the section with both levels disabled and `isolationRefusal(engine, null)` as the reason, and an agent Sandboxed while it was a Claude agent and later switched to `provider: codex`, `acp` or `ag-ui` is refused its runs (`runFor`, and a belt in `ChatService` before the spawn), never run as Off. ZumiBot cannot hold an ACP agent's own process tree in the CLI's sandbox, nor a remote server's tools. The Codex `workspace-write` with network off plan stays for a later phase.

### 2.4 Level 3 in detail (Container) — built in phase 3

Code: `core/isolation/containerRunner.ts` (the podman argv, mounts, lifecycle), `authProxy.ts`, `netProxy.ts`, `containerEntry.ts` (PID 1 inside), `containerSupport.ts` (the machine check), `isolationService.ts` (`runFor` for `container`), the image in `zumi-bot-server/container/`. Where the build differs from the approved design, it says so.

**Runtime.** Rootless Podman only (Docker is not used; a rootful Podman is refused). `checkContainer` says why it is unavailable: not Linux, the server itself in a container, no `podman`, rootful, the image not built, or a `claude` that is not the native build. Agent Studio shows the reason; a contained agent's run is refused with it, never run with less.

**Shape (changed from the design).** One container **per turn**, not one per chat: `podman run --rm -i` with the CLI's usual argv, so stdio, the parser, approvals and bridges are unchanged. A cold run measured ~0.1 s here, so a warm container (and its idle timer, `exec` and signal plumbing) bought nothing. The container ends with its turn, so Stop, Pause, archive and server shutdown end it the way they end the CLI: Stop's SIGINT reaches the CLI through podman's signal proxy and the entry (measured: gone 1.7 s after Stop). After each attempt `podman rm -f --ignore` removes a container whose client was killed; at start and at shutdown every container with this server's owner label (`io.zumibot.owner=<first 12 hex of SHA-256 of the data dir>`) is removed. Each attempt's `/tmp/cb-c-*` run folder (`api.sock`, `net.sock`) goes in its `dispose()`; the ones a SIGKILLed or crashed server left are removed by the next start's socket-folder sweep, only while they hold nothing but those sockets and every one refuses a connection, so another server's live run and a folder an agent wrote into stay ([Browser audit tools](browser.md), leftover folders). Every podman call the server makes (the support check, the sweeps, the start-up prune, a turn's `rm`) goes through one `PodmanCalls` (`podmanCalls.ts`); after the shutdown sweep its `close()` refuses new calls, SIGTERMs the ones still running and waits for them (SIGKILL after 3 s). A support check runs `podman info`, which takes over a second, so one from an Agent Studio opened just before a stop used to outlive the server and write Podman storage into its HOME (an e2e harness root came back after `stop()` had removed it). Flags: `--userns=keep-id` (the user's uid inside, non-root), `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--network none`, `--read-only` with a tmpfs `/tmp`, `--pids-limit 4096`. Never `--privileged`, never a container socket, never the host's network, pid or ipc namespace.

**Mounts** (`mountsOf`; each one at the same absolute path, so tool rows, the Files panel and session logs read the same inside and out):
- read-write: the chat's folder, its git dir (and a worktree's common dir), its `claude-tmp/<hash>` (pause flag), the agent's extra write folders, the bridges' private socket folders (`/tmp/cb-?-*`);
- read-only over those: the git dirs' `hooks` and `config`, and the folder's `.claude/settings*.json` and `.mcp.json` (code the host runs later, as in level 2);
- read-only: attachments (`--add-dir`), a worktree's absolute symlink targets outside it (`node_modules`, found to depth 3, at most 50), the extra read folders, ZumiBot's `dist/` (bridge and hook entries), the server's own native `claude` binary at `/usr/local/bin/claude` (so the CLI version always matches the host's; the image has no CLI);
- the fake home: `~/.local/state/zumibot-containers/<owner>/<chatId>/home` mounted **at the user's home path** as `HOME`, holding `.claude/projects/<this folder>` (the real session-log folder, rw, so edit, resend, Files restore and costs read logs where they always are, with no change elsewhere: this replaces the design's per-agent `CLAUDE_CONFIG_DIR`), `.claude/agents/<agent>.md` (ro, from the agents folder), `.claude/agent-memory/<agent>` (rw). ZumiBot makes these mount points itself, as the user, so none ends up owned by a sub-uid; the fake homes of deleted chats are removed at start.
- refused (`mountRefusal`, the run refused with the reason): home itself or any folder holding it (so a chat whose folder **is** home cannot be contained), the data dir (except the run's own temp folder and attachments), the vault key folder, anything under `~/.claude`, a path with a comma or line break. The server's env never crosses: only the names the turn itself set (bridges, the agent's vault keys and own servers' values, temp folder, pause flag) are passed, by name, so no value is in podman's argv.

**Signing in.** The auth proxy, as designed, and the probe passed (CLI 2.1.322, a subscription login): the container holds `ANTHROPIC_API_KEY=cb-run-<48 hex>` (fresh per turn) and `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`; the entry forwards that port to `api.sock` in the run's private `/tmp/cb-c-*` folder; the proxy checks the key, drops it, adds the server's sign-in and sends to `api.anthropic.com`. Sign-in order as the CLI's: `ANTHROPIC_API_KEY` in the server's env, then `CLAUDE_CODE_OAUTH_TOKEN`, then `~/.claude/.credentials.json`'s subscription token, read per request (never copied). Only `/v1/messages`, `/v1/messages/count_tokens` and `/api/hello` are forwarded, so an agent calling the proxy itself with the run key reaches no account endpoint. The token-in-env fallback is not built. Limit: the proxy does not refresh an expired subscription token; the host CLI does that on its own runs (every Off chat, the moderator, titles), so a server that runs only contained agents for longer than the token lives gets a sign-in error until any host run refreshes it.

**Network.** `--network none`; the entry forwards `127.0.0.1:3128` to `net.sock`, `HTTP(S)_PROXY` point there (`NO_PROXY` keeps the model's port local), and the proxy lets through only CONNECT or plain HTTP to a host on the agent's list on port 80 or 443. A listed host must also resolve to public addresses only (`checkedAddresses` in `core/addressGuard.ts`; a mixed answer is refused), and the proxy dials the checked address, so a wildcard pointing at 127.0.0.1 or the LAN is refused and reported like an off-list host; the only exception is an exact `localhost` or `127.0.0.1` entry, which passes to loopback and nothing else. A name that does not resolve is a 502, not a refusal. A refused host is recorded and, when the tool's result arrives, appended to that result as ZumiBot stores it in the sandbox's own `<sandbox_violations>` form (`withNetBlocks`), so the chat shows "Blocked by the sandbox: host" and the audit records `deniedBySandbox`, error or not. `WebFetch` is held exactly as in level 2 (`ask` rule, ZumiBot answers by the list), `WebSearch` is denied unless allowed, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` keeps the CLI's own extra traffic home.

**Approvals.** Unchanged: the container's own `--settings` adds only `ask: [WebFetch]` and the `WebSearch` deny; "Run Bash in the container without asking" (the same per-agent `autoBash` choice) adds `allow: [Bash]` and nothing else. No bypass mode, and a plan is never auto-allowed.

**Inside.** The image (`localhost/zumibot-agent:1`, `npm run container:image`, `node:22-bookworm-slim` pinned by digest plus git, ripgrep, python3, build-essential, curl) is the agent's whole toolchain: the host's PATH, nvm Node versions, global npm tools, `gh` and language servers are not there. ZumiBot's bridges and hooks (to-dos, vault, asks, browser, automations, pause, vault guard, file guard) run inside with the image's node: the server's node path in the args is rewritten to `/usr/local/bin/node`. The user's own `~/.claude/settings.json`, `~/.claude.json` and user-level MCP servers are not there; an agent's own servers come in its args and run inside, so ones needing host programs fail. A custom image per agent is not built.

**Background processes** (`processes.md`) are not offered to a sandboxed or contained agent: the tool and its prompt are left out of its runs, since the server starts those processes on the host, outside any isolation.

**Computer use** is refused for a contained agent (`CONTAINER_DESKTOP_REFUSED`, and Agent Studio greys Container out while it is on). The browser tools keep working through their bridge; the browser runs in the server, and **the agent's network list is not applied to its navigations yet**.

**Codex, ACP and remote agents** cannot be contained (`isolationRefusal(engine, 'container')`; Codex's is `CODEX_CONTAINER_REFUSED`), as with Sandboxed. Nor can the dev-only Agent SDK adapter's runs (`ZUMIBOT_CLAUDE_SDK=1` ignores the wrap).

**Server itself in Docker.** Level 3 is unavailable there (it would need the host's container socket).

### 2.5 What each level still lets an agent do

**Level 1 — Off (every agent not set to Sandboxed).**
- Read and change any file the user can: other projects, `~/.ssh`, `~/.claude`, browser profiles, the data dir; the vault files and audit log only behind the guard's speed bump (deny rules + a `grep` hook that an indirect path, a script or an encoded name gets past).
- Reach any host, send anything it can read.
- Drive the agent desktop from Bash with the inherited capability (as `computer-use.md` already notes).
- Everything else is decided by approvals: the mode, remembered rules, the user's yes.

**Level 2 — Sandboxed (as built).**
- Read system files (`/usr`, `/etc`, world-readable files outside home), its toolchain folders, its attachments and the extra readable folders, from Bash; the file tools only its own folders.
- Write anything inside its folder, including files that run later outside the sandbox: a `package.json` script, a `Makefile`, a CI file. Git hooks and config and the folder's Claude settings are denied, but other "code that runs later" is not.
- Commit to the repo's git dir (objects, refs), which is shared with the user's checkout for a worktree chat.
- Reach every host on its list, and send anything it can read to them (an env API key the vault granted it included). A host on the list that serves user content (a paste site, a git host) is a way out for anything it reads.
- Use its MCP servers and hooks with full user access (they run outside the sandbox): a user MCP server with filesystem or network powers is a way around it. ZumiBot's own bridges are scoped by their capabilities.
- Use the browser tools to reach any site, and computer use (a full desktop): both are outside the sandbox (the browser's own list is not applied yet), and Agent Studio says so.
- Get a renamed agent unsandboxed: a rename outside Agent Studio (Zumi Bot editing `name:` in the file) leaves the setting under the old name, so the new name is Off.
- An Off agent, Zumi Bot included, can still reach `isolation.json` by an indirect Bash path past the guard's speed bump and lower a setting; only Off agents can, since a sandboxed one cannot see the data dir.
- Exploit a kernel or bubblewrap bug. Use up CPU, memory and disk (no quotas).

**Level 3 — Container (as built).**
- Read and change everything mounted: its folder (including files that later run on the host, as in level 2), the repo's git objects and refs, its temp folder, its memory, the session logs of every chat in the same folder, the extra folders; read its attachments, a worktree's linked `node_modules` and ZumiBot's `dist/`.
- Run anything the image has, and anything it downloads from a listed host.
- Reach every host on its list on ports 80 and 443, and send anything it can read to them (its vault-granted keys included).
- Spend the user's subscription through the auth proxy (the run key is in its env), on the Messages API only; it cannot read the token.
- Use ZumiBot's bridges within their capabilities, and the browser tools to reach any site (the list is not applied to the browser yet).
- Use its own MCP servers and hooks inside the container, with the container's limits.
- An Off agent can still lower its setting through `isolation.json`, as in level 2; a contained one cannot see the data dir.
- Exploit a kernel or runtime escape (shared kernel; rootless narrows what that wins). Use CPU, memory and disk up to the machine's (only `--pids-limit` is set).

### 2.6 Recommendation

- **Level 2 as the default for new agents** once Phase 2 lands and is proven on this PC and the VPS: it costs almost nothing per turn, needs only `bwrap` and `socat`, keeps every ZumiBot feature (bridges, hooks, pause, vault guard), and closes the two big holes (writes anywhere, network anywhere) for Bash. Existing agents stay **Off** until the user switches them (the rule that isolation-off agents behave exactly as today). Zumi Bot stays Off: its job is writing into `~/.claude/agents`, which is already its fixed folder and deny-ruled.
- **Level 3 opt-in** for agents that run untrusted code or work on repos the user did not write (built; the auth-proxy probe passed).
- **Computer use stays Off-only** (level 2 shows it as outside the sandbox; level 3 refuses it).

### 2.7 Phase 2 tests (built)

`npm run probe:sandbox` (`e2e/sandboxProbe.mjs`, real CLI, Haiku) and unit tests (`backend/tests/core/isolation/`, `rpc/isolationHandlers.test.ts`, the `agent isolation` block of `chatService.test.ts`, `shared/tests/isolation.test.ts`, `frontend/tests/isolationForm.test.ts`, `sandboxLine.test.ts`) cover the list below; the browser and desktop bridges are not in the probe (they are MCP servers like the probe's own, which ran). Each check runs against the real CLI as a probe (opt-in like the other probes) and the logic as unit tests: a sandboxed Bash cannot read the vault key, the data dir or a file outside the folder, cannot write outside it, cannot `curl` a host off the list (and can one on it); the `Read` tool is denied the same paths; `WebFetch` off-list is denied with the line; `dangerouslyDisableSandbox` does not run outside; a project settings file that widens is refused; `zumibot_todos`, `zumibot_browser`, `zumibot_vault`, the desktop bridge, the pause hook and the vault guard each still work in a sandboxed run; an agent set to Sandboxed on a machine without `bwrap` is refused, not run.

### 2.8 Phase 3 tests (built)

Unit tests: `backend/tests/core/isolation/container.test.ts` (the argv's flags and that no env value or real home is in it, `mountRefusal`, the auth proxy's key swap, refusals and sign-in order against a local upstream, the network proxy's allow and refusals over a real socket, `netProxy.test.ts` (the checked address dialled, a listed name resolving to a local or mixed answer refused, explicit `localhost`), the support check's reasons, a runner's mounts and fake-home mount points, the owner sweep, pruning, `podmanCalls.test.ts` (close ends a running call and waits for it, SIGKILL after the grace, nothing starts after), worktree links, `runFor`'s refusals), the `container` block of `chatService.test.ts` (the wrap reaches the spawn, the container's `--settings`, a refused open, a blocked host on the tool's result), `rpc/isolationHandlers.test.ts`, `shared/tests/isolation.test.ts`, `frontend/tests/isolationForm.test.ts`. By hand on this PC (real CLI, Haiku, Podman 4.9.3): Agent Studio saves Container; a contained chat reached an on-list host, was refused an off-list one by curl and by WebFetch (chat line, `deniedBySandbox`), could not see a file outside its folder from Bash or Read, wrote inside it, used the to-do bridge, ran as uid 1000; Stop ended the container in 1.7 s; nothing was left in `podman ps -a`. Not checked: the vault and browser bridges and Pause in a contained run, the VPS.

---

## Part 3 — Phases and docs

- **Phase 1** — audit log (Part 1), **built**. New `core/audit/` with a pointer `CLAUDE.md`; `data.md`, `vault.md` (the guard's path list), `agents.md` (nothing yet), `deploy-and-sync.md` (the exclude), an index line in `CLAUDE.md`.
- **Phase 2** — level 2 (2.3), **built**. New `core/isolation/` with a pointer `CLAUDE.md`; `agents.md` (Agent Studio's Isolation section), `vault.md` (the guard also covers `isolation.json`), `codex.md` (Sandboxed refused for Codex), `data.md`, `e2e.md` (the probe).
- **Phase 3** — level 3 (2.4), **built** after the user approved 2.4 and installed Podman. `core/isolation/` grew the container files; `agents.md` (Container in Agent Studio), `codex.md` (Container refused), `data.md` (the fake homes outside the data dir), `e2e.md` (the image script).

## Open questions for the user

1. Fail-open audit (a write failure never stops a turn) — keep, or add a fail-closed switch?
2. Audit total cap default 512 MiB — fine?
3. Desktop `desktop_type` text stored as a length only (stricter than dispatch) — fine?
4. New agents default to Sandboxed once Phase 2 ships — or keep Off as the default and switch per agent? (Built: Off for every agent not set; no global default yet.)
5. WebSearch for sandboxed agents off unless switched on — fine?
