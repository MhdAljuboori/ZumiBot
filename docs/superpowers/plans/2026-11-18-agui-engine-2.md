# AG-UI engine (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an agent whose file says `provider: ag-ui` against a remote AG-UI 1.0 endpoint over HTTPS + SSE, as a fourth
engine. It gets nothing local, every feature it lacks is hidden through `EngineCaps`, and Edit, Resend and Fork stay on.

**Architecture:**
- Pure, defensive modules live in `backend/src/core/agui/`: endpoint checks, an SSE reader, an RFC 6902 applier, the event
  mapper, the history builder and interrupts.
- `aguiClient` makes one pinned POST. `aguiRunner` gives one `RunHandle` per attempt (one run, plus one per interrupt
  round), and `aguiEngine` adapts it.
- `Engine` gains `'ag-ui'`, and every exhaustive switch from 1a and 1b gets its case. Launch trust (1b's store) gets an AG-UI
  record, and `chats/<id>.agui.json` keeps the thread's state and its open interrupts.
- The UI reads `remote` for a chip and for the automatic-pick gates. Agent Studio gets an AG-UI card and `agents:testAgui`.

**Tech Stack:** TypeScript 5, Node 22 (`node:https`, `http`, `dns`, `net`; `tls` per Rulings 10), vitest, React 19. No new
dependency.

**Spec:** `docs/architecture/protocol-engines.md`, read whole.
- The AG-UI part runs from "AG-UI engine (Phase 2 …)" to "What a remote agent gets". Also read the Capability table, "Where
  protocol agents can be used", "Session ids across engines", "What the protocols cannot express", Dependencies, Tests and
  Docs.
- "Phase 1b as built" holds the ACP patterns this plan mirrors.
- Edit, Resend and Fork are on (approved, Decisions for review item 2).

## Global Constraints

- **AG-UI 1.0 only.**
  - Send `protocolVersion: "1.0"`, `tools: []`, `context: []` and `forwardedProps: {}`. Never send `parentRunId`.
  - Send no system or developer message: neither the file's body nor ZumiBot's own system text (Rulings 13).
  - An attachment refuses the send.
- **URL.** `https:` only, with no userinfo and no fragment.
- **Addresses.** The host resolves to at least one address, and **every** address must be public. These are refused:
  - loopback (`127/8`, `::1`) and unspecified (`0/8`, `::`);
  - private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) and CGNAT (`100.64/10`);
  - link-local (`169.254/16`, `fe80::/10`);
  - multicast and broadcast;
  - the IPv4-mapped or NAT64 forms of any of these.
- **Pinning.** The request connects to the checked address, through a `lookup` that returns it. SNI and `Host` keep the name.
- **Dev hook.** `ZUMIBOT_AGUI_ALLOW_LOCAL=1` is read only through `devEnv()`, so production ignores it. It allows loopback
  and private addresses, and plain `http:` to loopback only.
- **Redirects.** No 301, 302 or 303. At most two 307/308 redirects, only to the same scheme, host and port, each checked
  again. Anything else ends the run with "The endpoint redirected to another host".
- **Timeouts.**
  - Connect: 10 s.
  - Response headers: 30 s.
  - No bytes for 120 s ends the run. Keep-alive comments count as bytes.
  - A whole run gets 30 min. A run is one HTTP request, so waiting on cards between runs is not counted.
- **Caps.**
  - Body 16 MiB; one SSE event 1 MiB.
  - An error response's body is read to 4 KiB and **not** shown. The chat shows the status only, and a 401 or 403 names
    `authKey`.
  - State 256 KiB; past that it is dropped and `{}` is sent.
- **TLS.** Node's default certificate verification, with no option to turn it off.
- **Requests.** `Accept: text/event-stream` only.
- **Parsing.** The SSE reader and the RFC 6902 applier are hand-written. The applier takes `add`, `remove`, `replace`, `move`,
  `copy` and `test`. A patch that fails drops the state, with one log line.
- **`RUN_ERROR`.** `message` is cut to 500 characters and scrubbed, and shown with its `code`.
- **The key.**
  - It is read from the Vault per attempt, sent only in its header, and put in the scrub map.
  - It never goes in the file, a log, a URL, a body or an error. Errors name `authKey`.
  - Logs and errors name the host only, never the path or the query.
- **Launch trust** reuses `<data>/protocol-launch.json`, with an AG-UI record `{endpoint, authKey, authHeader}` (stable
  JSON). Only an Agent Studio `agents:save` confirms it.
- **No new dependency.** Claude, Codex and ACP behaviour is unchanged, and their tests pass unchanged apart from imports.
- **A new API method** touches `ZumiBotApi` (`shared/src/types.ts`), `rpc/handlers.ts` (every argument validated),
  `frontend/src/net/api.ts`, and the method list in `backend/tests/rpc/handlers.test.ts`.
- **How to work.**
  - Never commit. Work in the worktree `.claude/worktrees/engine-seam-1a`.
  - Run `npm run build:server` once before `npm test`.
  - Comments are short and say why. Fixed user-facing sentences live in `shared/`.

## Review Focus

1. **History quoting local work reaches the remote host.**
   - A chat whose visible items hold any non-AG-UI turn is refused before any request (`otherEngine`).
   - No body, system text or attachment is sent.
   - *Task 4:* a Claude-stamped chat switched to AG-UI logs no request on the fake server.
   - *Task 2:* `aguiMessages` never emits thinking, notices, errors, approvals or attachment names.
2. **The auth key leaks.** *Task 3:*
   - the fake server's log holds the value in its header only (not in the path, the query or the body);
   - a `RUN_ERROR` echoing the key shows the scrub label;
   - a 401 whose body echoes the key shows only `unauthorized`.
3. **A request reaches a host the user did not pick:** an endpoint edited outside Agent Studio, a cross-host or 303
   redirect, or a name resolving to a private, loopback or mapped address (a mixed answer too).
   - *Task 2:* the `aguiEndpoint` table, with `::ffff:10.0.0.1`, `64:ff9b::7f00:1` and a mixed answer.
   - *Task 3:* a cross-host 307 never reaches the second host.
   - *Task 4* refuses an untrusted run, and *Task 6* an untrusted Test.
4. **Stop with an interrupt card open.**
   - No further request is sent, and the card becomes `unanswered`.
   - The next send on the same thread sends `resume[]` cancelling every open interrupt. A new thread (an Edit) sends none.
   - *Task 3 and e2e:* checked through the request log.
5. **A stream that never finishes properly:** cut, an idle drip, an oversize event, a malformed known event, or an event
   before `RUN_STARTED`.
   - Each ends with an error item, never a synthesized success.
   - *Task 3:* one test per case, with small `limits`.

## Wire shapes

Checked 2026-11-18 against docs.ag-ui.com `/spec/1.0/schema.json` and `/spec/1.0/basic/transports/http-sse.md`.

```
POST <endpoint>  Content-Type: application/json  Accept: text/event-stream  Authorization: Bearer <v> | <authHeader>: <v>
{"threadId":"<uuid>","runId":"<uuid>","protocolVersion":"1.0","state":{},
 "messages":[{"id":"<item id>","role":"user","content":"text"},
  {"id":"<item id>","role":"assistant","content":"text",
   "toolCalls":[{"id":"call_1","type":"function","function":{"name":"search","arguments":"{\"q\":\"x\"}"}}]},
  {"id":"result-<item id>","role":"tool","toolCallId":"call_1","content":"…"},
  {"id":"result-<item id>","role":"tool","toolCallId":"call_2","content":"","error":"ZumiBot runs no tools for this agent"}],
 "tools":[],"context":[],"forwardedProps":{},
 "resume":[{"interruptId":"int-1","status":"resolved","payload":{"approved":true}},{"interruptId":"int-2","status":"cancelled"}]}
  (required: threadId, runId, messages; resume only when it has entries)

The response:
- 200 with Content-Type: text/event-stream; one JSON event per data: field, LF framing.
- event:, id: and retry: are ignored; ": keep-alive" comments are tolerated.
- The body closes after the last run's terminal event. Replayed runs (another runId) may come before ours.
- Input refused before the run gets an HTTP error status and no stream. No Last-Event-ID.

RUN_STARTED {threadId, runId, protocolVersion?, parentRunId?, input?}
RUN_FINISHED {threadId, runId, result?, outcome?, usage?: TokenUsage[]}
RUN_ERROR {message, code?, usage?}
  outcome: {type:"success", pendingToolCallIds?} | {type:"interrupt", interrupts: Interrupt[>=1]} | {type:"cancelled"}
  An absent outcome is success. An unrecognised one is stripped, so it is success too.
Interrupt {id, reason, message?, toolCallId?, responseSchema?: object, expiresAt?: string, metadata?, subagentRunId?}
ResumeEntry {interruptId, status: "resolved"|"cancelled", payload?, metadata?}
  A resume covers every interrupt of the run it continues, on the same threadId.

TEXT_MESSAGE_START {messageId, role?: assistant (default)|user|system|developer, name?}  _CONTENT {messageId, delta}
TEXT_MESSAGE_END {messageId}   TEXT_MESSAGE_CHUNK {messageId?, role?, delta?, name?}
REASONING_START/REASONING_END {messageId}   REASONING_MESSAGE_START {messageId, role:"reasoning"}
REASONING_MESSAGE_CONTENT {messageId, delta}   _END {messageId}   _CHUNK {messageId?, delta?}
  (legacy 0.x: THINKING_START/END, THINKING_TEXT_MESSAGE_START/CONTENT/END)
TOOL_CALL_START {toolCallId, toolCallName, parentMessageId?}   TOOL_CALL_ARGS {toolCallId, delta}   TOOL_CALL_END {toolCallId}
TOOL_CALL_CHUNK {toolCallId?, toolCallName?, parentMessageId?, delta?}   TOOL_CALL_RESULT {messageId, toolCallId, content}
STATE_SNAPSHOT {snapshot}   STATE_DELTA {delta: [{op, path, value?, from?}]}
TokenUsage {provider?, model?, inputTokens?, outputTokens?, totalTokens?, reasoningTokens?, cachedInputTokens?, cacheWriteInputTokens?}
  (cached, cache-write and reasoning are parts of the totals; an absent count is unknown, not 0)

A stream begins with RUN_STARTED or RUN_ERROR. After RUN_FINISHED only a late RUN_ERROR (the run failed) or a new
RUN_STARTED may come.
```

---

### Task 1: Shared AG-UI vocabulary and the agent file key

**Files:** Create `shared/src/agui.ts`; modify `shared/src/frontmatter.ts`. Tests: `shared/tests/agui.test.ts`,
`shared/tests/frontmatter.test.ts`.

**Produces:**
- **`interface AguiLaunch { endpoint: string; authKey: string | null; authHeader: string | null }`**, with
  `aguiLaunchError(v): string | null` and `parseAguiLaunch(v): AguiLaunch | null`.
  - `endpoint`: at most 2048 characters, with no whitespace, control character or NUL. It must parse with `new URL`, be
    `https:` or `http:` (the dev hook judges `http:` in Task 2), and hold no username, password or `#`.
  - `authKey`: null, or a name `envNameError` accepts.
  - `authHeader`: null, or a 1–64 character RFC 9110 token that `authHeaderError` accepts. It is allowed only with an
    `authKey`.
- **`authHeaderError(name)`** refuses, case-insensitively:
  - `host` and `content-*`;
  - the hop-by-hop headers `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `proxy-connection`,
    `te`, `trailer`, `transfer-encoding` and `upgrade`;
  - `accept` and `accept-encoding` (Rulings 9).
- **`aguiLaunchRecord(l)`.** Stable JSON of `{endpoint, authKey, authHeader}`, in that order.
- **`aguiHost(endpoint)`.** `URL.host`, or null.
- **`AguiThread`.** `{v: 1; threadId; state: unknown | null; interrupts: {id; expiresAt: string | null}[]}`, with
  `parseAguiThread`.
- **`AguiTestInfo`.** `{host; addresses: string[]; tls: boolean; authKey: string | null; authKeyGranted: boolean; caps;
  hidden: string[]}`. `AguiTestResult = AguiTestInfo | {error}`.
- **`AGUI_API_KEY_NOTE`** = "API keys reach a remote agent only as its auth key, in one request header".
- **`AGUI_TEXT`** names a host, an env name or a status, never a value, path or query.
  - The design's own wording, kept as written: `untrusted` ("This agent's endpoint changed outside Agent Studio. Open it in
    Agent Studio and save to confirm."), `redirected`, `cut` ("The connection ended before the agent finished."), `noTools`
    ("ZumiBot runs no tools for this agent") and `remoteNotice(host)`.
  - The launch: `noEndpoint`, `endpointRequired`, `endpointInvalid`, `launchUnreadable` (fix it in the Raw view),
    `authKeyInvalid`, `authHeaderInvalid(name)`, `authHeaderWithoutKey`, `authKeyMissing(name)`, `authKeyUnusable(name)`.
  - The network: `resolveFailed(host)`, `notPublic(host)`, `status(code)`, `unauthorized(code, authKey | null)`, `notSse`,
    `connectTimeout(host)`, `headersTimeout`, `idleTimeout`, `runTimeout`, `bodyTooBig`, `eventTooBig`,
    `network(host, code)`.
  - The stream: `unreadable` ("The agent sent an event ZumiBot could not read."), `protocol`, `runError(message, code)`.
  - The turn: `noAttachments`, `otherEngine` ("This chat began on another engine … start a new chat for this agent"),
    `pendingTools`, `interruptDeclined(reason)`, `tooManyRounds`, `toolUnfinished`, `zumiBotPick(name)`, and
    `forkIgnored` (never shown).
  - Test: `notAgui`, `testUnavailable`, `testTimeout(host)`, `testFailed(host, code)`.
- **`AGUI_STUDIO_TEXT`.**
  - `remote`: the notice.
  - `body`: "This agent's instructions are not sent: a remote agent's behaviour is its server's".
  - `header`: "Authorization sends Bearer <value>, any other header the bare value".
  - `testNote`: "Test checks the address and connects. It sends no request, so no message or key leaves this machine".
  - `olderChats`, plus 1b's `unused`, `confirmed`, `current`, `unconfirmed`, `changed`, `noKeys`, `notGranted`,
    `testSaveFirst` and `testUnsaved`.
- **The file key.**
  - `AgentFields.agui: AguiLaunch | null` is read from `agui:`.
  - `ParsedAgent.aguiEditable` is false when `agui:` does not parse, and Save keeps that key byte for byte, as for `acp:`.
  - `serializeAgent` writes a nested map, with `authKey` and `authHeader` only when non-null. Null deletes the key.
  - `validateFields(fields, acpReadable, aguiReadable = true)`. Its required-endpoint check comes in Task 4.
- [ ] Tests:
  - every launch shape: userinfo, `#`, `ftp:`, 2049 characters, a header without a key, `Content-Type`, `Host`, `Accept`,
    `X-Api-Key`;
  - the record's key order, and `parseAguiThread`;
  - `agui:` round-trips; an unreadable `agui:` survives another field's Save; `acp:` stays untouched.
- [ ] Implement. `npx vitest run --project shared` passes.

### Task 2: Pure AG-UI modules (backend)

**Files:** Create, in `backend/src/core/agui/`: `aguiEndpoint.ts`, `aguiSse.ts`, `aguiPatch.ts`, `aguiEvents.ts`,
`aguiMessages.ts`, `aguiInterrupts.ts`, and `CLAUDE.md` (pointing to `protocol-engines.md`). Tests:
`backend/tests/core/agui*.test.ts`.

**Consumes:**
- `RunEvent`, `ChatItem`, `CODEX_TOOL_OUTPUT_MAX` and `QUESTION_TOOL`.
- `elicitationQuestions` / `elicitationAnswer` (`core/acp/acpElicitation.ts`). Their input fits as `{mode: 'form',
  requestedSchema: interrupt.responseSchema, message: interrupt.message}`.

**Produces:**
- **`aguiEndpoint.ts`**
  - `addressClass(ip)` gives `public`, `loopback`, `unspecified`, `private`, `cgnat`, `linkLocal`, `multicast` or
    `broadcast`. It reads IPv4 and IPv6. `::ffff:a.b.c.d` (and its hex form), `::a.b.c.d`, `64:ff9b::/96` and
    `64:ff9b:1::/48` are classed by the IPv4 address they hold.
  - `allowedClass(c, allowLocal)`: public always; loopback and private only with `allowLocal`.
  - `checkUrl(raw, allowLocal)` gives `{url}` or `{error}`. It allows `http:` only with `allowLocal`, and only for a
    loopback literal or `localhost`.
  - `resolveTarget(url, allowLocal, lookup = dns.lookup {all: true})` gives `{host, port, addresses}` or `{error}`. A
    literal IP is checked directly. No answer is `resolveFailed`; any refused answer is `notPublic`.
  - `pinnedLookup(a)` must answer both call forms. Node 22 calls `lookup` with `{all: true}` (autoSelectFamily), which wants
    `[{address, family}]`; any other call wants `(null, address, family)`.
  - `redirectTarget(from, status, location)` gives a `URL` or `{error}`. Only 307 and 308; the location is resolved against
    `from` and must keep its protocol, hostname and port, with no userinfo or fragment.
- **`aguiSse.ts`.** `class SseReader(maxEventBytes)`, with `push(chunk: Buffer): string[]` (the data payloads) and `end()`.
  It throws `SseTooBig`.
  - Lines split on LF. A trailing CR and one leading BOM are dropped.
  - A `data:` value loses one leading space. Several `data` lines join with `\n`, and a blank line dispatches.
  - Other fields and comments are ignored. Bytes are counted before decoding (`StringDecoder`).
- **`aguiPatch.ts`.** `applyPatch(doc, ops)` gives `{ok: true, doc}` or `{ok: false}`.
  - It patches a deep copy, using RFC 6901 pointers (`~1`, `~0`, and `-` for add).
  - Any bad op or path gives `ok: false`. `test` compares deep JSON equality.
  - Values are set with `Object.defineProperty`, so `__proto__` is only a key.
- **`aguiEvents.ts`.** `class AguiEventMapper({threadId, runId})`.
  - `event(raw)` gives `{events: RunEvent[]; state?; terminal?; fatal?}`, and `close()` gives `RunEvent[]`.
  - `transcript()` gives this run's assistant and tool messages, by the server's ids, for a resume run's input.
  - **Runs.** Another `runId`'s events are a replay, and are dropped until its terminal event (Rulings 2). Before any
    `RUN_STARTED`, anything other than `RUN_ERROR` is fatal (`unreadable`).
  - **`RUN_STARTED`.** Ours gives `init {sessionId: threadId}` and `entry {uuid: runId}`. The entry stamps the turn's `end`
    with `engine: 'ag-ui'`, which Task 4's history check reads. Another `threadId` is fatal, and so is a declared
    `protocolVersion` whose major is not 1. An absent version is fine (Rulings 1).
  - **Text.** Assistant text gives `textDelta`, then one `assistantText` per message at its END. A chunk run ends at the
    first event that is not a chunk of the same message. Other roles are dropped.
  - **Reasoning.** `REASONING_MESSAGE_*` and legacy `THINKING_*` give `thinkingDelta`, then `thinking`. Encrypted values are
    dropped.
  - **Tool calls.** A call gives `toolUse {id: toolCallId, name: 'AguiTool', input}` at END. `input` is `{tool, args}` when
    the arguments parse as JSON, else `{tool, args: null, argsText}`, cut at 20 000 characters as ACP rows are.
  - **Tool results.** `TOOL_CALL_RESULT` gives `toolResult`: the text parts joined, `[<type>]` for any other part, capped at
    `CODEX_TOOL_OUTPUT_MAX`.
  - **Ignored:** events carrying `subagentRunId` (Rulings 6), `MESSAGES_SNAPSHOT`, `ACTIVITY_*`, `STEP_*`, `SUBAGENT_*`,
    `RAW`, `CUSTOM` and anything unknown.
  - **Fatal:** a known event missing a required field or with one of the wrong type; an interrupt outcome with no
    interrupts or with duplicate ids.
- **`aguiMessages.ts`.**
  - `aguiMessages(items, turn: {id, text})` builds the input messages.
    - A `user` item becomes `{id, role: 'user', content}`. The turn's own item gets `turn.text`, which holds the reply quote.
      No attachments are sent.
    - An `assistant` item takes the `tool` items right after it as `toolCalls`. A tool run with no reply before it gets
      `{id: 'calls-<first tool id>', role: 'assistant', toolCalls}`.
    - Each call is followed by `{id: 'result-<item id>', role: 'tool', toolCallId, content}`. An `isError` or missing
      result also gets `error`: the result text, or `toolUnfinished`.
    - `untag(id)` (what follows the first `:`) gives back the server's id. The function name is `input.tool`, and its
      `arguments` are `argsText ?? JSON.stringify(args)`.
    - Thinking, notices, errors, approvals, browser and vault items are never sent.
  - `foreignHistory(items)` is true when a stretch between two `user` items holds an assistant, thinking or tool item and
    no `end` stamp with `engine: 'ag-ui'`, or holds an `end` or `cut` stamp from another engine.
- **`aguiInterrupts.ts`.**
  - `interruptQuestions(i)` gives the AskUserQuestion input, or null.
  - `resumeEntry(i, answer, now)` gives `{status: 'resolved', payload: content}` for an allow that `elicitationAnswer`
    accepts. Anything else, or an `expiresAt` at or before `now`, is `cancelled`.
  - `isExpired` uses `Date.parse`. A value that is not a date never expires (the schema's note).
- [ ] Write the tests first:
  - every address class over IPv4, IPv6 and the mapped and NAT64 forms; the dev hook; `http:` without it; redirects;
  - SSE: CRLF, a split UTF-8 character, multi-line data, comments, the cap;
  - each patch op, a failing `test`, a bad path, and `__proto__`;
  - one mapper test per row of the design's message map, plus replays, chunks, malformed events and the version rule;
  - the builder over a mixed list; `foreignHistory` with Claude, Codex, ACP and AG-UI stamps; interrupts and expiry.
- [ ] Implement. `npx vitest run zumi-bot-server/backend/tests/core/agui*.test.ts` passes.

### Task 3: Fake server, client, runner and adapter

**Files:** Create `backend/tests/fixtures/fake-agui-server.mjs`, `core/agui/aguiClient.ts`, `core/agui/aguiRunner.ts` and
`core/engines/aguiEngine.ts`. In `core/chat/streamParser.ts`, `RunEvent` gains `{kind: 'notice'; text: string}`, which
Claude and Codex never emit. Tests: `aguiClient.test.ts`, `aguiRunner.test.ts`, `aguiEngine.test.ts`.

**The fake server.**
- **Start.** It listens on `127.0.0.1:0` and prints `FAKE_AGUI_PORT=<n>` first.
- **Script.** `FAKE_AGUI_SCRIPT` is read for each request: `{requests: Step[][]}`. Request *i* plays entry *i*, and the last
  entry repeats.
- **Log.** `FAKE_AGUI_LOG` records `{path, query, headers, body}` per request and `{abort: i}` per abort.
- **Steps:**
  - events: `raw` (with `$threadId` and `$runId`), `text`, `reasoning`, `tool {id, name, args, result}`,
    `state {snapshot | delta}`;
  - endings: `finish {outcome?, usage?}`, `error`, `cut`, `lateError`, and `replay` (a whole run under another `runId`,
    first);
  - faults: `malformed`, `oversize`, `comment`, `sleep {ms}`, `hold`;
  - HTTP: `status {code, body}`, `redirect {status, location}`, `contentType`.

**`postRun(o, onData)`** gives `{kind: 'ended'}` or `{kind: 'error'; text}`.
- `o = {url, body, headers, allowLocal, lookup?, limits, signal}`.
- It checks and resolves the target, then POSTs with `pinnedLookup` and `agent: false`, over `node:https` (`node:http` only
  for `http:`).
- `AguiLimits` defaults:
  - `connectMs 10_000`, `headersMs 30_000`, `idleMs 120_000`, `runMs 1_800_000`;
  - `bodyBytes 16 MiB`, `eventBytes 1 MiB`, `errorBodyBytes 4096`, `stateBytes 256 KiB`;
  - `redirects 2`, `finishGraceMs 5_000` (Rulings 2), `rounds 10` (Rulings 4).

**`startAgui(o: AguiRunOptions): RunHandle`.** `o = {endpoint, headers, threadId, messages, thread, onThread(t), requestTag,
allowLocal, lookup?, limits?, onEvent}`.
- **The thread file.** The state and the open interrupts come from `thread` only when its `threadId` matches; otherwise the
  state is `{}` and nothing is open.
- **Runs.** Each run gets a fresh `runId`. The first run's `resume` cancels every open interrupt.
- **Ids.** Every tool id that leaves the handle is tagged `<requestTag>:` (as in `acpRunner`), and `send` answers only tagged
  request ids.
- **`onThread`.** It clears the interrupts once a run that sent `resume` reaches `RUN_STARTED`. It also runs after every
  terminal event, and before any card waits.
- **State.** A snapshot replaces it, and a delta goes through `applyPatch`. A failed patch, or a state over 256 KiB, sets it
  to null with one log line.
- **After our terminal event,** the body gets up to `finishGraceMs` to end. A late `RUN_ERROR` in that window is an error.

**Outcomes:**
- **success.**
  - `result.cost = {totalUsd: 0, models}` holds the summed `usage`, keyed by `model ?? 'unknown'`: `input` is
    `inputTokens − cachedInputTokens − cacheWriteInputTokens` (at least 0), and `cacheRead` and `cacheWrite` are the cached
    and cache-write counts.
  - `costUsd` is null, so Usage shows the tokens unpriced. No `context` event is sent.
  - Each pending id that has a row gets `toolResult {content: noTools, isError: true}`, and the run sends one `notice`
    (Rulings 7).
- **interrupt.** `onThread` keeps the interrupts first.
  - A mappable one gives `permissionRequest {requestId: tag + id, toolName: QUESTION_TOOL}`, with `toolUseId` the tagged
    `toolCallId` when that row exists, else null.
  - Any other is cancelled, with a `notice`: `interruptDeclined(reason)`, the reason cut to 100 characters.
  - A timer at `expiresAt` cancels its card (`permissionCancel`).
  - Once every card is settled, the next run sends `messages + transcript()`, the state and the full `resume[]`. More than
    `rounds` rounds ends the turn with `tooManyRounds`.
- **cancelled** sets `stopped`.
- **`RUN_ERROR`** sets `stderr` to `runError`, cut to 500 characters with control characters stripped. `ChatService` scrubs
  it.
- **A cut, malformed, timed-out or oversize stream** sets `stderr` to its fixed sentence, and `result` stays null.
- **A refusal before any byte is sent** sets `spawnError`.
- **Stop** aborts the request, turns every open card into `permissionCancel`, sends nothing more, and sets `stopped`.
- **The end** flushes text and thought, closes open rows with `toolUnfinished`, and emits one `result`. `missingSession` is
  never set.

**`aguiEngine({caps, locate, run})`** is the `EngineAdapter<AguiTurnConfig>`.
- `AguiTurnConfig = Pick<AguiRunOptions, 'endpoint' | 'headers' | 'messages' | 'thread' | 'onThread' | 'requestTag'>`.
- `aguiStartOf(start, mint = randomUUID)`: `new` mints a thread id, and `resume` uses `sessionId`. A `fork` or a compact
  throws, since `rewind` and `compact` are off.
- [ ] Tests first, against the fake:
  - text, reasoning, and a remote tool row with its result;
  - state kept across two handles on one thread, and `{}` on a new one;
  - the header only (Review Focus 2);
  - an answered interrupt: the same `threadId`, a new `runId`, and `resume` resolved with the payload;
  - an unmappable interrupt (a notice, then `cancelled`), and an expired one;
  - Stop with a card open, then the next handle cancels it (Review Focus 4);
  - pending tool calls, and usage without cost;
  - a `RUN_ERROR` echoing the key;
  - 401 with a body, 500, a 200 that is not SSE, a 303 against a same-origin 307, and a cross-host 307 (Review Focus 3);
  - cut, idle, oversize, malformed, and an event before `RUN_STARTED` (Review Focus 5);
  - a replay, a late `RUN_ERROR`, a version-2 producer, and the rounds cap.
- [ ] Implement. The tests pass.

### Task 4: `ag-ui` as an engine: caps, the turn, the thread file, launch trust, the auth key

**Files:**
- **shared:** `engine.ts`, `chatModel.ts`, `frontmatter.ts`, and `types.ts`. In `types.ts`, `NoticeKind` gains `'remote'`
  (with its `NOTICE_TEXT`), and `AgentSummary` gains `remoteHost?: string`.
- **backend:**
  - `devEnv.ts`: `aguiAllowLocal(raw = devEnv('ZUMIBOT_AGUI_ALLOW_LOCAL')) => raw === '1'`.
  - `agentStore.ts`: `aguiOf(name)` gives `{provider, launch} | null`, and an AG-UI agent's summary gets `remoteHost`.
  - `chatStore.ts`: `aguiPath`, `loadAgui(id)` and `saveAgui(id, t | null)`, written 0600 and queued like dispatch. Null
    removes the file, and so does `remove()`.
  - `launchTrust.ts`: `LaunchRecord` becomes `({provider: 'acp'} & AcpLaunch) | ({provider: 'ag-ui'} & AguiLaunch)`.
    `recordOf`, `same` and `confirm` go by provider, and `aguiRecord` is added.
  - `chatService.ts`, and `sessionPoints.ts` (`END_IS_CUT['ag-ui'] = false`).
  - `extensionsService.ts` and `sanitize.ts`: `VAULT_GUARD_ON` null; `buildAgui`, with `EXT_TEXT.aguiUnsupported` in every
    section; `READERS`; `unsupportedText`.
  - `app.ts`: the deps, and `baseFor` gives null. `rpc/handlers.ts`: `agents:save`.
- **frontend** (the exhaustive sites):
  - `agentEngine.ts`: `cliMissing` and `unavailable` null, `CHOICE_LABEL` "Remote agent (AG-UI)", `ENGINE_TAG` "Remote",
    `apiKeyNote` = `AGUI_API_KEY_NOTE`, `modelAfterEngineSwitch` null;
  - `agentLoadout.ts` and `commandModel.ts`;
  - `runPickers.ts`: `AUTO_OFFERED` false. The `MODE_HINT` says the remote server decides what runs, and a card shows only
    for an interrupt the server describes.

**Vocabulary.**
- `ENGINE_LABEL['ag-ui'] = 'AG-UI'`. `PROVIDERS` gains it.
- `AGUI_CAPS`: true only for `questions`, `resend`, `fork` and `remote`. `processes` is off too.
- `AGUI_REFUSALS` (btw, compact, pause, resend, fork, room), and its cases in `roomRefusal`, `capRefusal`,
  `spendCapRefusal` ("runs on a remote server that reports no cost") and `bridgeRefusal`.
- `modelFits` is false.
- `validateFields`: `provider: ag-ui` needs an endpoint, else `endpointRequired` (or `launchUnreadable`).

**The turn.** Every `switch (engine)` in `ChatService` gets `case 'ag-ui'`.
- **Deps.** `agui?: {definitionOf; trust(agent, launch): LaunchCheck; allowLocal: boolean; run; thread: {load, save}}`.
- **Refusals.** Each attempt refuses with `spawnError`, in this order:
  1. `noEndpoint`;
  2. `endpointInvalid` (`checkUrl`);
  3. `untrusted`;
  4. `otherEngine` (`foreignHistory(history)`);
  5. `noAttachments` (the turn's own user item has some);
  6. `authKeyMissing` (not in `vaultKeys(ruleAgent()).env`);
  7. `authKeyUnusable` (CR, LF, NUL, or a character above U+00FF).
- **The header** is `Authorization: Bearer <v>` when `authHeader` is null or `authorization`, else `<authHeader>: <v>`. The
  value is in `scrub` already.
- **Messages** are `aguiMessages(history, {id: turnMessage, text: <spec.prompt's text blocks joined by "\n\n">})`. They are
  built once per turn. A reseed attempt uses them too, never `seedPrompt`.
- **The thread** is loaded per attempt, and `onThread` queues `thread.save`.
- **Everything else.**
  - `keyEnv`: none. Side base: none. The turn model is `{}`.
  - `pauseReady` and `sessionGone` are false, and `promptReached` is `attemptSession !== null`.
  - Locate gives the endpoint or null.
  - A turn records `sessionEngine: 'ag-ui'`, and the `notice` event becomes `addNotice('remote', text)`.
- **Reseeds.** A planned reseed adds no `expired` notice: `RESEED_IS_NEWS: Record<Engine, boolean>` is false for `ag-ui`. That
  covers Edit, Resend, Fork, a version switch and a `seed` next. `fresh` still shows.
- **`agents:save`.**
  - For `provider: ag-ui` with a launch, it runs `checkUrl` and `resolveTarget` (dev hook honoured) before writing, and
    refuses with the sentence.
  - Trust uses `switch (markEngine(provider))`: `acp` → `acpRecord`, `ag-ui` → `aguiRecord`, anything else → `remove`, with
    an exhaustive default. It is queued before any await.
- [ ] Tests:
  - chatService, through the `agui.run` deps against the fake:
    - the session mark is `ag-ui`;
    - the second turn sends the first turn's messages on the same thread;
    - an Edit sends a new `threadId` with the visible items, and no `expired` notice;
    - Review Focus 1;
    - an attachment, an untrusted launch, and a missing or unusable key are refused;
    - a question card is answered through the real card path.
  - `launchTrust` with mixed records.
  - `agents:save` refuses a private endpoint and confirms a good one.
  - Deleting a chat removes its `agui.json`.
- [ ] `npm run typecheck` and `npm test` pass.

### Task 5: The UI's cap readers, the remote chip and the automatic-pick gates

- **The chip.** `remoteChip(agent, caps = engineCaps)` in `state/agentEngine.ts` gives `{label: 'Remote · <host>', title:
  remoteNotice(host)}`, or null. `components/RemoteChip.tsx` shows it in ChatView's pickers row, after `EngineInfo`, and in
  NewChatView's. A room never shows it, since rooms have no AG-UI member.
- **Never an ask target** (`remote`).
  - `askableAgents` (`state/agentAsk.ts`) and `askRosterOf` (`app.ts`) drop remote agents.
  - `AskService.targetOf` refuses one with `REFUSAL.remote(name)` (`askPrompt.ts`).
- **Never picked automatically** (`remote`).
  - Voice: `routeUtterance` (`state/voiceRoute.ts`) filters agents before `candidates` and `defaultRoute`, and `talkAgents`
    (`state/talkSettings.ts`) drops them (Rulings 8).
  - Jev: `jev:suggestAgent` filters `usable`.
  - Zumi Bot: `agentResolver(agents, kept)` (`core/automations/agentNames.ts`) resolves a remote agent only when the
    stored routine or workflow already names it; `automationService.ts` passes those names. Otherwise it refuses with
    `zumiBotPick(name)`, which passes `SAFE_MESSAGE`.
- **Spend caps and Usage need nothing new.** `cost` is off, so the existing readers hide or refuse a cap
  (`dailyCapAfterEngineSwitch`, `capEngines.ts`, `CapBlocked`), and the tokens show as unpriced.
- [ ] Tests:
  - `remoteChip`, `askableAgents` and `talkAgents`;
  - `routeUtterance`: a named remote agent is `unknown`, and a remote default is `no-agent`;
  - the askService refusal and the Jev filter;
  - `agentResolver`: a kept agent resolves, a new one is refused.

### Task 6: Agent Studio, `agents:testAgui`, `agents:aguiLaunch` and Zumi Bot

- **The card.** `components/AguiCard.tsx`, with the pure rules in `state/aguiCard.ts` (`aguiDraftOf`, `editAguiDraft`,
  `keyChoices`, `aguiTestBlocked`, `aguiTestKey`), mirroring `acpCard.ts`.
  - Fields: Endpoint; Auth key (the env names of API keys granted to the agent, plus a listed name no longer granted); Auth
    header.
  - Notes: the remote notice with its host, `header`, `olderChats` (shown once the Engine select switches) and `unused`.
  - `studioCards` gains `agui` and `instructionsNote` (`body`, in place of the instructions hint).
  - It uses 1b's `launchCompare` and `confirmPending`.
- **`agents:aguiLaunch(name): AguiLaunch | null`.** The launch Save confirmed on this machine. The name is checked as
  `agents:acpLaunch` checks it.
- **`agents:testAgui(name)`** (`core/agui/aguiTest.ts`, `createAguiTest(deps)`; controller ruling 1).
  - It reads the saved file as a run does (`notAgui`, `noEndpoint`, `endpointInvalid`, `untrusted`), then runs
    `resolveTarget`.
  - It opens a TLS connection (TCP under the dev hook) to the pinned address, with SNI set to the host and a 10 s deadline,
    and closes it. No HTTP request is sent, so no message and no key leaves the machine.
  - It returns `{host, addresses, tls, authKey, authKeyGranted, caps, hidden: missingFeatures(caps)}`, or a fixed error.
    Concurrent Tests of one launch share a probe.
- **Zumi Bot** (`core/agents/zumiBot.ts`).
  - It writes `provider: ag-ui` only when asked, and never writes, changes or removes `agui:`. It sends the user to Agent
    Studio to set the endpoint.
  - It never writes `model`, `tools`, `memory`, `computerUse`, `autoCompactWindow`, `dailySpendCap` or a command's `model`
    for this agent. A switch to AG-UI removes `model` and `dailySpendCap`.
- [ ] Tests:
  - the handler: untrusted refused; the fake server's log empty after a Test; an argument that is not a string rejected;
    both methods in the method list;
  - the card's rules, and `studioCards('ag-ui')`;
  - Zumi Bot's prompt, as `zumiBot.test.ts` pins ACP's.

### Task 7: E2E, smoke run, sync and docs

- **The harness.** `harness.mjs` gets `fakeAgui` (true, or a fixture path). It starts the fake server as a child and reads
  its port, adds `ZUMIBOT_AGUI_ALLOW_LOCAL=1` to the server env, returns `agui: {url, script, log}`, and kills the server
  in `stop()`.
- **`e2e:agui`.** `zumi-bot-server/e2e/agui.e2e.mjs`, run by `npm run e2e:agui` and never by `npm run e2e`. Through the UI:
  - **Saving.** A Vault key is granted to the agent. The card refuses an endpoint with userinfo or `#`, and a good Save
    confirms the launch. Test shows the host and the granted key, and the fake log stays empty.
  - **The chip.** The notice, and the chip with its tooltip, on the new-chat screen and in the chat header.
  - **A chat.**
    - A streamed reply with reasoning and a remote tool row; the request carries the header, the history and the state.
    - A question card answered (`resume` resolved), and an unmappable interrupt's notice.
    - Stop with a card open, then the next send's `resume` is `cancelled`.
    - `RUN_ERROR`, a cut stream, and a 401 that names `authKey`.
  - **Rewinds and refusals.**
    - Edit, Resend and Fork are shown, and an Edit uses a new `threadId` with no `expired` notice.
    - An attachment is refused, and so is a Claude chat continued after its agent switched to AG-UI.
    - An endpoint edited in the file is refused, then confirmed again by Save.
  - **Not offered.** The room member picker, the `@` menu and the voice default leave the agent out, and there is no daily
    cap card.
- **`smoke:agui`.** `zumi-bot-server/e2e/aguiSmoke.mjs`, opt-in like `smoke:acp`.
  - `ZUMIBOT_SMOKE_AGUI` is the endpoint URL. `ZUMIBOT_SMOKE_AGUI_KEY` names the env variable that holds the key (its
    value is never printed). `ZUMIBOT_SMOKE_AGUI_HEADER` is optional.
  - Steps: Save and Test; a chat that answers; an interrupt if the server sends one (INCONCLUSIVE otherwise); Stop
    mid-run.
  - It exits 0, 1 or 2, as `acpSmoke.mjs` does.
- **Scripts.** `package.json` gets `e2e:agui` and `smoke:agui`.
- **`deploy/sync.mjs`.**
  - `${id}.agui.json` joins `${id}.json` in the `fromVps` copy. It is not copied for `m.copies`, since a copy starts a new
    thread. The runner ignores a file whose `threadId` does not match.
  - `copyMeta` carries any stamp's engine (Rulings 11).
- **Docs.**
  - `protocol-engines.md`: "Phase 2 as built", with its limits: TLS is checked only by the smoke run, and arguments over
    20 000 characters are resent cut on later turns. Record the rulings taken.
  - `data.md`: `chats/<id>.agui.json`, and the AG-UI records in `protocol-launch.json`.
  - `e2e.md`, `vault.md` (the auth key), `agents.md` and `codex.md` (the Engine select).
  - The root `CLAUDE.md` index line gains `` `core/agui/` `` and stays under 16 384 bytes, which `repoDocs.test.ts` checks.
- [ ] `npm run build:server`, `npm test`, `npm run typecheck` and `npm run e2e:agui` pass.

## Rulings (decided by the controller, 2026-11-18)

Every recommendation below is taken as written; the implementer follows each. They are binding like Global Constraints.

1. **`protocolVersion`.** The design ends the run on a major other than 1. The spec says a consumer proceeds (and SHOULD
   warn) on a newer or unreadable version, and treats an absent one as an older peer. *Decided:* keep the design, with an
   absent version allowed, since a 2.x stream may change meanings the 1.0 mapper can't see.
2. **Several runs in one response.** The design is silent. The spec allows replays ahead of the requested run, and a late
   `RUN_ERROR` after `RUN_FINISHED`. *Decided:* drop the events of other `runId`s. After our terminal event, wait up to 5 s
   for the body to end, and treat a late `RUN_ERROR` as an error.
3. **State and interrupts on a new thread** (Edit, Resend, Fork, a reseed). *Decided:* start at `{}` with no `resume`.
   The kept state is the old thread's latest, not the state at the point being rewound to.
4. **Interrupt rounds in one turn.** A server that answers every cancelled resume with a new interrupt loops with no user.
   *Decided:* allow at most 10 rounds, then end with `tooManyRounds`.
5. **An interrupt that expires while its card waits.** *Decided:* a timer cancels the card at `expiresAt`, and the resume
   entry is `cancelled`.
6. **Text and tool events that carry `subagentRunId`.** *Decided:* drop them, as `SUBAGENT_*` is dropped, so a subagent's
   words never mix into the reply. Interrupts that carry it are still handled.
7. **`pendingToolCallIds`.** The brief keeps them in `agui.json`. *Decided:* answer each through its stored row instead:
   an error `toolResult` that `aguiMessages` resends as a tool message with `error` on every later run, even after an Edit.
   `agui.json` then holds only the thread id, the state and the open interrupts. A pending id with no row is logged and
   dropped.
8. **What "never picked automatically" covers.** *Decided:*
   - Voice never routes to a remote agent, even one the user names; the name reads as unknown.
   - Zumi Bot may keep a remote agent a routine or workflow already holds in that place, but may not add one, like the
     email-account rule. Refusing every remote agent would stop it editing any workflow that holds one.
9. **The auth header's refused names.** The design refuses hop-by-hop headers, `Host` and `Content-*`. *Decided:* also
   refuse `Accept` and `Accept-Encoding`, which would break "`Accept: text/event-stream` only" and the plain-text read.
10. **The module for Test's handshake.** The brief lists `https`, `http`, `dns` and `net`, but a TLS handshake with no HTTP
    request is `tls.connect`. *Decided:* allow `node:tls` (built in). The alternative, an `https.request` destroyed on
    `secureConnect` before `end()`, relies on Node internals.
11. **`sync.mjs` disagrees with the design.** `copyMeta` (lines 150 and 162) still tests `=== 'codex'`, though the design
    says 1a carries any stamp's engine. An ACP or AG-UI copy loses its mark: harmless, since it reseeds, but wrong.
    *Decided:* fix it in Task 7.
12. **An endpoint moved from host A to host B and saved.** Older chats' history then goes to B, and the design is silent.
    *Decided:* allow it, and have the card's `changed` note say that existing chats continue at the new host.
13. **ZumiBot's own system text** (house style, a workflow step's paragraph). The design withholds only the file's body.
    *Decided:* send none. A workflow step then gets no "your reply is this step's output" paragraph, which it does not
    need to run.
