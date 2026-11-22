# Voice Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Talk to a ZumiBot agent hands-free on the desk (hotkey → island) and on the phone (`/voice` page, screen on). The agent is picked from what the user says, its answer is spoken back, the conversation keeps listening, and every create/send/delete is confirmed out loud.

**Architecture:** Approach A from the spec, voice mode in the browser. Pure modules decide everything:
- word tables, the agent router, speech text and the conversation state machine live in `shared/src/` and `frontend/src/state/`
- one hook (`useVoiceTalk.ts`) does the I/O
- the phone page and the island popup both use that hook

The server gains:
- a TTS route
- a `voice` flag on chats, which adds a fixed system paragraph and a `PreToolUse` hook that forces a card for changing tool calls
- card handling that never lets saved rules answer those forced cards

The desktop shell gains a global hotkey that starts voice in the island.

**Tech Stack:** TypeScript, React 19, Node (vite-bundled server), Electron, vitest (node env only), OpenRouter (`/api/v1/audio/transcriptions` already used, `/api/v1/audio/speech` new), Claude CLI `--settings` hooks.

**Spec:** `docs/superpowers/specs/2026-11-13-voice-conversations-design.md`. Read it before any task.

## Global Constraints

- **Never commit.** The user's global rule: no `git commit` unless the user says so. Each task ends with tests green and `npm run typecheck` clean, with changes left in the working tree.
- Worktree builds need `node_modules` symlinks to the main checkout before typecheck/build (user memory "worktree build links").
- Run everything from the repo root. Node >= 22. Dependencies are pinned exact; this plan adds **no new dependency**.
- Frontend tests are node-only: logic lives in `frontend/src/state/` or `frontend/src/net/`, never in components or hooks.
- Secrets, audio, transcripts and spoken text never reach logs, URLs, errors or disk. Failure logs carry an HTTP status and a byte or char count only.
- Zero data retention on every OpenRouter call: `provider: { zdr: true }`. No fallback to a non-ZDR provider.
- Never add `--dangerously-skip-permissions` or `bypassPermissions`. Voice answers cards only through the existing `chats.answer` / `chats.answerQuestions`.
- Voice never sends `allow-chat` or `allow-agent`. Only `allow-once` or `deny`.
- The appended system prompt of a chat must not vary between its turns (prompt cache). A voice chat always gets the same voice paragraph.
- Spec values to keep exactly:
  - clip minimum 600 ms (`VOICE_MIN_MS`)
  - quiet after speech ends a clip: ~1500 ms
  - no speech ends the conversation: ~8000 ms
  - spoken lead cap: 400 chars
  - TTS request cap: 1000 chars
  - TTS limits: 2 at once, 30 a minute, own budget
  - TTS format: mp3
  - default desk hotkey: `Ctrl+Alt+Space`
  - chat title: `Voice · <date>`
  - default agent: `work-assistant`
- Comments are short and say *why*. Every changed area updates its `docs/architecture/` doc in the same task (Task 14 writes the new doc; earlier tasks may leave notes for it).

## Review Focus

1. **A hedged or negated yes** ("yes but at 4", "don't", "لا تسوي", "مو هلأ") must be `unclear` or `no`, never `yes`. Test: Task 1 `parseYesNo` cases.
2. **An Arabic request naming an English agent**, in Arabic script ("اسأل وورك اسستنت …") or in Latin letters inside Arabic ("اسأل work assistant …"), must reach that agent through an alias or the loose match. Otherwise it must be "unknown agent", never the default agent with the name swallowed into the request. Test: Task 9.
3. **A reply that is only a table, a code block or a link** must speak "Done, details are on your screen", never markdown or a URL. Test: Task 8 `speakableLead`.
4. **Two cards pending at once, or a card arriving while a reply is spoken,** must be read one at a time, oldest first, each answered before the next. Test: Task 10.
5. **TTS, transcription or the socket failing mid-conversation** must:
   - speak with the browser voice, or show the text, and keep going on a TTS failure
   - end cleanly on repeated transcription failure
   - always release the mic and the wake lock

   Test: Task 10 effects, Task 7 route errors.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `zumi-bot-server/shared/src/voiceWords.ts` (new) | All English/Arabic word tables, `normalizeUtterance`, `parseYesNo`, `isEndPhrase`, `numberOf`, `parseChoice`, `CHANGE_VERBS` |
| `zumi-bot-server/shared/src/voiceConfirms.ts` (new) | `voiceConfirms(toolName, input, o)`: does a voice chat force a card for this call |
| `zumi-bot-server/shared/src/agentMatch.ts` (new) | `matchAgent`: exact, then loose name or display-name match; Zumi Bot refused |
| `zumi-bot-server/shared/src/voice.ts` (modify) | `VoiceTalk` settings type, `parseTalkPatch`, speak route constants |
| `zumi-bot-server/shared/src/types.ts` (modify) | `ChatMeta.voice?: true`, `ZumiBotApi.chats.createVoice`, `voice.set` patch gains `talk` |
| `zumi-bot-server/backend/src/core/voice/voiceGuard.ts` (new) | Hook decision and `--settings` JSON for voice chats |
| `zumi-bot-server/backend/src/core/voice/voiceGuardHook.ts` (new) | Bundled child entry the CLI runs per tool call |
| `zumi-bot-server/backend/src/core/voice/speaker.ts` (new) | OpenRouter TTS client |
| `zumi-bot-server/backend/src/core/voice/voiceSystem.ts` (new) | `VOICE_SYSTEM` paragraph and `voiceChatTitle` |
| `zumi-bot-server/backend/src/http/voice.ts` (modify) | `handleSpeak` |
| `zumi-bot-server/backend/src/core/chat/chatService.ts` (modify) | Voice paragraph, guard settings, forced cards never auto-answered |
| `zumi-bot-server/backend/src/app.ts` (modify) | Wiring, `sideFirstPart`, speak route deps |
| `zumi-bot-server/frontend/src/state/voiceSpeech.ts` (new) | `langOf`, `speakableLead`, `narrateApproval`, `narrateQuestion`, fixed lines |
| `zumi-bot-server/frontend/src/state/voiceRoute.ts` (new) | `routeUtterance` |
| `zumi-bot-server/frontend/src/state/voiceItems.ts` (new) | What changed in the chat that voice must react to |
| `zumi-bot-server/frontend/src/state/endpointer.ts` (new) | End-of-speech detection from level samples |
| `zumi-bot-server/frontend/src/state/voiceTalk.ts` (new) | Conversation state machine (pure `step`) |
| `zumi-bot-server/frontend/src/state/talkPresence.ts` (new) | Which chat a conversation runs in, for presence |
| `zumi-bot-server/frontend/src/useVoiceTalk.ts` (new) | I/O for the machine |
| `zumi-bot-server/frontend/src/components/VoiceTalkView.tsx` (new) | Full-screen phone view and island voice popup body |
| `zumi-bot-desktop/src/main/voiceHotkey.ts` (new) | Global shortcut registration |

---

### Task 1: Word tables and answer parsing

**Files:**
- Create: `zumi-bot-server/shared/src/voiceWords.ts`
- Test: `zumi-bot-server/shared/tests/voiceWords.test.ts`

**Interfaces:**
- Produces:
  - `normalizeUtterance(text: string): string`: lowercase; strip punctuation, including `؟ ، ؛ . , ! ?`; drop Arabic diacritics and tatweel `ـ`; fold `أ إ آ → ا` and `ى → ي`; collapse whitespace; trim.
  - `type YesNo = 'yes' | 'no' | 'unclear'`, and `parseYesNo(text: string): YesNo`. `yes` only when the **whole** normalized utterance is a yes phrase. `no` when the whole utterance is a no phrase, **or** when it starts with a no word. Everything else is `unclear`.
  - `isEndPhrase(text: string): boolean`: true only when the whole utterance is an end phrase.
  - `numberOf(text: string): number | null`: 1–9 from digits, Arabic-Indic digits, English words or ordinals, Arabic words or ordinals. Optional "option" / "number" / "رقم" / "الخيار" prefix.
  - `parseChoice(text: string, options: readonly string[]): { kind: 'option'; index: number } | { kind: 'other'; text: string }`: a number in range, else the one option whose normalized label equals the normalized text or contains it as whole words, else `other` with the original text trimmed.
  - `CHANGE_VERBS: readonly string[]`, used by Task 2.
  - `ASK_PREFIXES: readonly string[]`: the normalized leading phrases "ask", "tell", "اسال", "قل ل", "قول ل", "خلي". Used by Task 9.

- [ ] **Step 1: Write the failing tests**

```ts
describe('parseYesNo', () => {
  it.each(['yes', 'Yes.', 'yeah', 'yep', 'sure', 'allow', 'allow it', 'go ahead', 'do it', 'ok', 'okay',
    'نعم', 'أيوه', 'ايوا', 'اي', 'إي', 'تمام', 'ماشي', 'اوكي', 'موافق', 'يلا'])('yes: %s', (t) => expect(parseYesNo(t)).toBe('yes'))
  it.each(['no', 'nope', 'deny', 'cancel', "don't", 'do not', 'stop', 'no thanks', 'لا', 'لأ', 'مو', 'مو هلأ', 'بلاش', 'الغي', 'لا تسوي'])('no: %s', (t) => expect(parseYesNo(t)).toBe('no'))
  it.each(['yes but at 4', 'yes no', 'maybe', 'what?', '', 'نعم بس الساعة ٤', 'allow for this chat'])('unclear: %s', (t) => expect(parseYesNo(t)).toBe('unclear'))
})
describe('isEndPhrase', () => {
  it.each(["that's all", 'that is all', 'bye', 'stop', 'thanks', 'thank you', 'خلص', 'بس', 'شكرا', 'مع السلامة'])('%s', (t) => expect(isEndPhrase(t)).toBe(true))
  it('not inside a request', () => expect(isEndPhrase('stop the meeting at 4')).toBe(false))
})
describe('numberOf', () => {
  it.each([['2', 2], ['two', 2], ['second', 2], ['option 3', 3], ['٣', 3], ['ثلاثة', 3], ['الثاني', 2], ['رقم ١', 1]])('%s', (t, n) => expect(numberOf(t as string)).toBe(n))
  it('none', () => expect(numberOf('Obada K')).toBeNull())
})
describe('parseChoice', () => {
  const opts = ['Obada Kh', 'Obada M']
  it('number', () => expect(parseChoice('the second one', opts)).toEqual({ kind: 'option', index: 1 }))
  it('label', () => expect(parseChoice('obada m', opts)).toEqual({ kind: 'option', index: 1 }))
  it('out of range is other', () => expect(parseChoice('5', opts)).toEqual({ kind: 'other', text: '5' }))
  it('ambiguous label is other', () => expect(parseChoice('obada', opts)).toEqual({ kind: 'other', text: 'obada' }))
})
it('normalizeUtterance folds alef and drops marks', () => expect(normalizeUtterance('  أَيْوَه؟ ')).toBe('ايوه'))
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run zumi-bot-server/shared/tests/voiceWords.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `voiceWords.ts`.** Tables as frozen `readonly string[]`, stored already normalized. Phrase matching works on normalized whole strings, and "starts with a no word" on the first token. `CHANGE_VERBS` must contain at least the user's list plus the spec's synonyms: create, update, send, reply, forward, delete, cancel, post, schedule, move, edit, modify, patch, add, remove, trash, archive, share, invite, respond, upload, publish, approve, write, set, rename, merge, push, label, mark.

- [ ] **Step 4: Run tests, expect PASS.** Same command.

---

### Task 2: `voiceConfirms`: which calls a voice chat confirms

**Files:**
- Create: `zumi-bot-server/shared/src/voiceConfirms.ts`
- Test: `zumi-bot-server/shared/tests/voiceConfirms.test.ts`

**Interfaces:**
- Consumes: `CHANGE_VERBS` (Task 1).
- Produces:
  - `toolWords(name: string): string[]`: splits on `_`, `-`, `.`, `/`, whitespace and camelCase; lowercases.
  - `voiceConfirms(toolName: string, input: unknown, o: { memoryRoot: string | null }): boolean`. Rules, in order:
    1. `mcp__zumibot_*` → false.
    2. Other `mcp__<server>__<tool>`: true when any word of `<tool>` is in `CHANGE_VERBS`.
    3. `Write | Edit | MultiEdit | NotebookEdit`: true, unless `file_path` / `notebook_path` resolves under `o.memoryRoot`.
    4. `Bash`: true when any word of `command` is in `CHANGE_VERBS`, when a word is `rm` or `mv`, or when `-X` / `--request` is followed by `POST|PUT|PATCH|DELETE`.
    5. Anything else → false.

- [ ] **Step 1: Write the failing tests**

```ts
const o = { memoryRoot: '/home/u/.claude/agent-memory' }
it.each([
  ['mcp__claude_ai_Google_Calendar__create_event', {}, true],
  ['mcp__b0f8c22b__update_event', {}, true],
  ['mcp__x__deleteEvent', {}, true],
  ['mcp__gmail__send_message', {}, true],
  ['mcp__gmail__create_draft', {}, true],
  ['mcp__slack__slack_send_message', {}, true],
  ['mcp__calendar__list_events', {}, false],
  ['mcp__gmail__search_threads', {}, false],
  ['mcp__zumibot_todos__add', {}, false],
  ['Bash', { command: 'workiom records create --list x' }, true],
  ['Bash', { command: 'workiom records list --list x' }, false],
  ['Bash', { command: 'gh pr create -t x' }, true],
  ['Bash', { command: 'curl -X POST https://x' }, true],
  ['Bash', { command: 'curl https://x' }, false],
  ['Bash', { command: 'rm -rf build' }, true],
  ['Bash', { command: 'ls -la' }, false],
  ['Write', { file_path: '/home/u/.claude/agent-memory/work-assistant/notes.md' }, false],
  ['Write', { file_path: '/home/u/project/a.md' }, true],
  ['Edit', { file_path: '/home/u/.claude/agent-memory/../secrets' }, true],
  ['Read', { file_path: '/x' }, false],
  ['Grep', { pattern: 'delete' }, false],
])('%s', (name, input, want) => expect(voiceConfirms(name, input, o)).toBe(want))
it('unreadable input on a file tool asks', () => expect(voiceConfirms('Write', null, o)).toBe(true))
it('no memory root: every file write asks', () => expect(voiceConfirms('Write', { file_path: '/home/u/.claude/agent-memory/a' }, { memoryRoot: null })).toBe(true))
```

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/shared/tests/voiceConfirms.test.ts`
- [ ] **Step 3: Implement.** Resolve paths with `node:path`'s `posix.resolve` / `posix.relative` only. The module is also loaded by the hook entry, so keep it free of relative imports other than `./voiceWords`.
- [ ] **Step 4: Run, expect PASS.**

---

### Task 3: Shared agent matcher

**Files:**
- Create: `zumi-bot-server/shared/src/agentMatch.ts`
- Modify: `zumi-bot-server/backend/src/core/automations/agentNames.ts` (`agentResolver` uses `matchAgent`; messages and behavior unchanged)
- Test: `zumi-bot-server/shared/tests/agentMatch.test.ts`. Existing `backend/tests/core/automations*` tests must stay green.

**Interfaces:**
- Produces:
  - `type AgentMatch = { ok: true; name: string } | { ok: false; reason: 'unknown' | 'zumi-bot' }`
  - `matchAgent(named: string, agents: readonly Pick<AgentSummary, 'name' | 'error'>[]): AgentMatch`. Same rules as today's `agentResolver`:
    - broken agents and Zumi Bot are excluded from candidates
    - exact name after trim and leading `@` strip
    - then case-insensitive name or `displayName` with whitespace collapsed
    - Zumi Bot by name or display name → `zumi-bot`
    - zero or several hits → `unknown`

- [ ] **Step 1: Failing tests:**
  - `matchAgent('@Work Assistant', agents)` → `{ ok: true, name: 'work-assistant' }`
  - `matchAgent('zumi bot', agents)` → `{ ok: false, reason: 'zumi-bot' }`
  - a broken agent → `unknown`
  - two agents with the same display name → `unknown`
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/shared/tests/agentMatch.test.ts`
- [ ] **Step 3: Implement `matchAgent`.** Make `agentResolver` call it, throwing `ZUMI_BOT_REFUSED` or `unknownAgent(...)` exactly as before.
- [ ] **Step 4: Run** `npx vitest run zumi-bot-server/shared/tests/agentMatch.test.ts && npx vitest run --project backend -t "agent"`. Expected: PASS.

---

### Task 4: Forced-ask hook and the CLI probe

**Files:**
- Create: `zumi-bot-server/backend/src/core/voice/voiceGuard.ts`
- Create: `zumi-bot-server/backend/src/core/voice/voiceGuardHook.ts`
- Modify:
  - `zumi-bot-server/backend/vite.config.ts` (input `voiceGuardHook`)
  - `zumi-bot-server/backend/src/core/browser/browserRuntime.ts` (`voiceGuardEntry: entry('voiceGuardHook')`)
- Create: `zumi-bot-server/e2e/voiceAskProbe.mjs`, modeled on `e2e/desktopAskProbe.mjs`
- Modify: root `package.json` `e2e` script (append `&& node zumi-bot-server/e2e/voiceAskProbe.mjs --soft`)
- Test: `zumi-bot-server/backend/tests/core/voiceGuard.test.ts`

**Interfaces:**
- Consumes: `voiceConfirms` (Task 2).
- Produces (all in `voiceGuard.ts`):
  - `VOICE_ASK_REASON = 'Voice chat: ZumiBot asks you out loud before this runs.'`
  - `voiceGuardDecision(raw: string, memoryRoot: string | null): 'ask' | 'pass'`. Parses `{tool_name, tool_input}`. Unreadable JSON → `'ask'` (fail toward asking). A call from inside a subagent (`agent_id` set) is still judged.
  - `runVoiceGuard(o: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; exit(code: number): void; memoryRoot: string | null; timeoutMs?: number }): void`
    - On `ask`, writes `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":VOICE_ASK_REASON}}` and exits 0.
    - On `pass`, writes nothing and exits 0.
    - No input in 10 s → `ask`.
    - Same once-only exit discipline as `runPauseHook`.
  - `voiceGuardSettings(o: { node: string; entry: string; electronNode: boolean; memoryRoot: string }): string`. Returns `{"hooks":{"PreToolUse":[{"matcher":"mcp__.*|Bash|Write|Edit|MultiEdit|NotebookEdit","hooks":[{"type":"command","command":…}]}]}}`. The command passes `memoryRoot` as a quoted argv (same quoting as `pauseSettings.ts`).
  - `voiceGuardOf(rt: { node: string; voiceGuardEntry: string; electronNode: boolean }, memoryRoot: string, exists: (p: string) => boolean): { settings: string } | null`. Null when the entry is missing or a path is relative.

- [ ] **Step 1: Failing tests:**
  - `voiceGuardDecision` returns `ask` for `{"tool_name":"mcp__gmail__send_message","tool_input":{}}`
  - `pass` for `list_events`
  - `ask` for `"{"` (unreadable)
  - `runVoiceGuard` with a `PassThrough` stdin writes the exact JSON above for an ask, and writes nothing for a pass; both exit 0
  - `voiceGuardSettings` parses as JSON with that matcher
  - `voiceGuardOf` returns null for a relative entry
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/voiceGuard.test.ts`
- [ ] **Step 3: Implement** `voiceGuard.ts`. `voiceGuardHook.ts` is a 6-line entry like `pauseHook.ts`: delete `ELECTRON_RUN_AS_NODE`, then call `runVoiceGuard` with `process.argv[2] ?? null` as `memoryRoot`. Add the vite input and the runtime entry.
- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Write `voiceAskProbe.mjs`.**
  - Same shape and exit codes as `desktopAskProbe.mjs`: 0 PASS, 1 FAILED, 2 INCONCLUSIVE, `--soft`, skip env `ZUMIBOT_SKIP_VOICE_PROBE=1`.
  - It runs real `claude -p --permission-mode auto --permission-prompt-tool stdio` with `--settings voiceGuardSettings(...)` built from `backend/dist`, against the probe stub MCP server in `e2e/fixtures/`. Add a `send_message` tool to it, or a new `probe-voice-mcp.mjs`.
  - PASS when a `can_use_tool` control request arrives for the stub's `send_message`.
  - Also run with `--with-allow-rule`, an allow rule for that tool in the same settings, to show the hook's ask beats an allow.
- [ ] **Step 6: Build and run the probe.** `npm run build:server && node zumi-bot-server/e2e/voiceAskProbe.mjs`. Expected: `PASS`.

  If it prints FAILED: switch `voiceGuardSettings` to the spec's fallback before going on, and note the switch in the Task 14 doc:
  - `permissions.ask` for every `mcp__*` server prefix, from the agent's loadout
  - plus `Bash(workiom <verb>:*)` for each change verb

---

### Task 5: Voice chats on the server

**Files:**
- Create: `zumi-bot-server/backend/src/core/voice/voiceSystem.ts`
- Modify:
  - `zumi-bot-server/shared/src/types.ts`: `ChatMeta.voice?: true // a voice conversation's chat: its turns get VOICE_SYSTEM and the voice guard`. `ZumiBotApi.chats.createVoice(agentName: string): Promise<ChatMeta>`.
  - `zumi-bot-server/backend/src/core/store/chatStore.ts`: `create(agentName, cwd, extra?: { title?: string; voice?: true })`
  - `zumi-bot-server/backend/src/rpc/handlers.ts`: `'chats:createVoice'`
  - `zumi-bot-server/frontend/src/net/api.ts`: map `createVoice`
  - `zumi-bot-server/backend/src/core/chat/chatService.ts`:
    - the `systemPrompt` at the spec-building block near line 1189: `...(meta.voice ? { systemPrompt: VOICE_SYSTEM } : {})`
    - `extraArgs` near line 2098: `--settings voiceGuard` when `meta.voice && !onCodex && !spec.compact`
    - `askEveryTime` near line 1759
    - the kept-decision line near 1504
  - `zumi-bot-server/backend/src/app.ts`:
    - `sideFirstPart` returns `VOICE_SYSTEM` for `meta.voice`
    - build `voiceGuard` once via `voiceGuardOf(resolveBrowserRuntime(), memoryRoot, existsSync)`, where `memoryRoot` is the root `core/memory/memoryStore.ts` builds near its line 31 (`<claude dir>/agent-memory`)
    - pass it to `ChatService` deps as `voiceGuard?: { settings: string }`, plus `memoryRoot?: string | null`
  - `zumi-bot-server/frontend/src/state/approvals.ts`: `approvalChoices(toolName, o?: { step?; input?; voice?: boolean })` → `chat: false, agent: false` when `o.voice && voiceConfirms(toolName, o.input, { memoryRoot: null })`. Pass `voice: !!chat?.voice` from `ApprovalCard`'s caller.
- Test:
  - `zumi-bot-server/backend/tests/core/chatService.test.ts`, voice cases, following the file's existing workflow-paragraph tests
  - `zumi-bot-server/backend/tests/rpc/handlers*.test.ts` (wherever `chats:create` is tested)
  - `zumi-bot-server/frontend/tests/approvals.test.ts`

**Interfaces:**
- Consumes: `voiceConfirms` (Task 2), `voiceGuardOf` (Task 4), `matchAgent` (Task 3), `engineOfAgent` (`shared/src/engine.ts`).
- Produces:
  - `VOICE_SYSTEM: string`. Exact copy:
    > "This conversation is spoken. The user hears your reply read aloud. Begin every reply with one or two short, plain sentences that answer the user, in the language they used, with no markdown, links, lists or emoji in those sentences. Put any detail after a blank line; it is shown on screen, not read. Before any action that creates, sends, changes or deletes something, the user is asked out loud by ZumiBot itself, so do not ask them to confirm in text; just call the tool."
  - `voiceChatTitle(now: number, timeZone: string): string` → `Voice · Nov 13` (`en-US`, `month: 'short', day: 'numeric'`, the given zone).
  - `chats:createVoice(agentName)`:
    - resolves the folder like the new-chat screen (`d.builtInCwd(name) ?? settings lastFolderByAgent[name] ?? home`)
    - refuses with a plain `Error` for an unknown or broken agent, Zumi Bot (`matchAgent`), or a Codex agent (`engineOfAgent(a) === 'codex'`): `"<display name> runs on Codex, so voice can't ask you before it acts"`
    - creates with `{ title: voiceChatTitle(Date.now(), settings.timeZone()), voice: true }`

- [ ] **Step 1: Failing tests:**
  - `voiceChatTitle(Date.UTC(2026,10,13,12), 'UTC')` → `'Voice · Nov 13'`
  - a voice chat's run args contain `VOICE_SYSTEM` in `--append-system-prompt`, and the same string on its second turn
  - a voice chat's run args contain one merged `--settings` whose `hooks.PreToolUse` has the voice matcher
  - a non-voice chat has neither
  - in a voice chat, a `can_use_tool` for `mcp__gmail__send_message`:
    - with a chat rule and an agent rule both allowing it, stays `pending` (not `auto-allowed` / `auto-allowed-agent`)
    - answered `allow-chat` is stored as `allowed-once` and adds no chat rule
  - in a voice chat, a `can_use_tool` for `mcp__calendar__list_events` with a chat rule is still `auto-allowed` (only forced calls skip rules)
  - `chats:createVoice('Codex Agent')` rejects with the Codex sentence
  - `chats:createVoice('Zumi Bot')` rejects
  - `approvalChoices('mcp__gmail__send_message', { voice: true, input: {} })` → `{ chat: false, agent: false, step: false }`
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/frontend/tests/approvals.test.ts`
- [ ] **Step 3: Implement.** In `chatService.ts`:
  - `askEveryTime = needsUser || confirmOnly(e.toolName) || (meta.voice === true && voiceConfirms(e.toolName, e.input, { memoryRoot }))`, where `memoryRoot` comes from deps
  - at line ~1504, the same predicate maps any non-deny decision to `'allow-once'`
  - Jev's risk hint stays off for these cards, as `askEveryTime` already does
- [ ] **Step 4: Run tests and `npm run typecheck`, expect PASS.**

---

### Task 6: Talk settings

**Files:**
- Modify:
  - `zumi-bot-server/shared/src/voice.ts`
  - `zumi-bot-server/backend/src/core/voice/voiceStore.ts`
  - `zumi-bot-server/backend/src/rpc/handlers.ts` (`voicePatch`)
  - `zumi-bot-server/frontend/src/components/VoiceSettings.tsx`
- Test:
  - `zumi-bot-server/backend/tests/core/voiceStore.test.ts`
  - `zumi-bot-server/shared/tests/voice.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `interface VoiceTalk { enabled: boolean; defaultAgent: string | null; aliases: Record<string, string[]> }`, with `DEFAULT_TALK: VoiceTalk = { enabled: true, defaultAgent: 'work-assistant', aliases: {} }`
  - `VoiceStatus` gains `talk: VoiceTalk` and `talkOn: boolean`, where `talkOn = on && talk.enabled`
  - `parseTalkPatch(v: unknown): Partial<VoiceTalk> | null`. Limits: agent names ≤ 100 chars, ≤ 50 agents with aliases, ≤ 10 phrases each, each phrase 1–60 chars after trim, no control chars. Invalid → null; the handler throws `bad talk settings`.
  - `api.voice.set(patch: { enabled?; key?; talk?: Partial<VoiceTalk> })`
  - `voice.json` becomes `{ enabled, key, talk }`. A missing or partly wrong `talk` reads as `DEFAULT_TALK`, field by field. Still 0600.

- [ ] **Step 1: Failing tests:**
  - `parseTalkPatch({ aliases: { 'work-assistant': ['مساعد العمل'] } })` round-trips
  - a 61-char phrase → null
  - `defaultAgent: ''` → null
  - the store reads an old `{enabled,key}` file as `talk: DEFAULT_TALK`
  - `set({ talk: { defaultAgent: 'x' } })` keeps `aliases`
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/voiceStore.test.ts zumi-bot-server/shared/tests/voice.test.ts`
- [ ] **Step 3: Implement.** In `VoiceSettings.tsx`, add a "Voice conversations" part, shown only when voice input is on:
  - on/off switch
  - default agent `<select>` (single agents, excluding Zumi Bot and Codex)
  - an alias list per agent: one text input per phrase, add/remove
- [ ] **Step 4: Run tests and typecheck, expect PASS.**

---

### Task 7: Speaking route

**Files:**
- Create: `zumi-bot-server/backend/src/core/voice/speaker.ts`
- Modify:
  - `zumi-bot-server/backend/src/http/voice.ts` (`handleSpeak`)
  - `zumi-bot-server/backend/src/http/server.ts` (route)
  - `zumi-bot-server/backend/src/app.ts` (deps, own limiter)
  - `zumi-bot-server/shared/src/voice.ts` (constants)
  - `zumi-bot-server/frontend/src/net/voice.ts` (`speakText`)
- Test:
  - `zumi-bot-server/backend/tests/core/speaker.test.ts`
  - `zumi-bot-server/backend/tests/http/voice.test.ts`
  - `zumi-bot-server/frontend/tests/net/voice.test.ts`

**Interfaces:**
- Produces:
  - `SPEAK_ROUTE = '/api/voice/speak'`, `SPEAK_MAX_CHARS = 1000`
  - `TTS_MODEL` and `TTS_VOICE` in `speaker.ts`. Before pinning, pick with `GET https://openrouter.ai/api/v1/models?output_modalities=speech`: a model whose `supported_voices` includes a voice that reads Arabic and English, and that a ZDR provider serves. Candidates: `openai/gpt-4o-mini-tts-2025-12-15`, `google/gemini-3.1-flash-tts-preview`. Record the choice and the reason in a comment.
  - `createSpeaker(d: TranscriberDeps): { speak(text: string, signal?: AbortSignal): Promise<{ ok: true; audio: Buffer } | { ok: false; error: 'off' | 'upstream' | 'timeout' }> }`. It POSTs `${origin}/api/v1/audio/speech` with `{ model, voice, input: text, response_format: 'mp3', provider: { zdr: true } }`.
    - A non-2xx answer, or a `content-type` not starting `audio/`, → `upstream`. The body is cancelled, never read.
    - Same timeout and logging rules as the transcriber: log the status and `text.length` only.
    - It reuses `testVoiceOrigin`, so `ZUMIBOT_TEST_VOICE_URL` covers it.
  - `handleSpeak(req, res, v: { on(): Promise<boolean>; speaker: Pick<Speaker,'speak'>; limiter: VoiceLimiter })`:
    - POST only, JSON `{ text: string }`, body ≤ 8 KiB
    - text 1..`SPEAK_MAX_CHARS` after trim, else 400 `bad-request`
    - off → 503; busy → 429; upstream → 502; timeout → 504
    - 200 with `Content-Type: audio/mpeg` and `Cache-Control: no-store`
    - the limiter is `createVoiceLimiter({ concurrent: 2, perMinute: 30 })`, a separate instance from transcription's
  - `speakText(fetchImpl: typeof fetch, text: string, signal: AbortSignal, onSignedOut?): Promise<{ ok: true; audio: Blob } | { ok: false; error: VoiceError }>`

- [ ] **Step 1: Failing tests:**
  - the speaker sends `provider.zdr === true` and `response_format: 'mp3'`
  - a `text/html` 200 → `upstream`
  - a log line never contains the input text
  - the route: 1001 chars → 400; a third concurrent call → 429; success → `audio/mpeg` bytes
  - transcription's limiter is untouched by speak calls
  - `speakText` maps 429 → `busy`, and 401 calls `onSignedOut`
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/speaker.test.ts zumi-bot-server/backend/tests/http/voice.test.ts zumi-bot-server/frontend/tests/net/voice.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 8: What gets spoken

**Files:**
- Create: `zumi-bot-server/frontend/src/state/voiceSpeech.ts`
- Test: `zumi-bot-server/frontend/tests/voiceSpeech.test.ts`

**Interfaces:**
- Consumes: `toolSummary` (`shared/src/toolSummary.ts`), `parseQuestions` (`shared/src/questions.ts`), `displayName` (`shared/src/frontmatter.ts`).
- Produces:
  - `type SpeechLang = 'en' | 'ar'`
  - `langOf(text: string): SpeechLang`: `'ar'` when Arabic letters are ≥ 30% of letters.
  - `speakableLead(markdown: string, max = 400): string | null`. Takes the first paragraph that has words after stripping:
    - code fences, tables (lines starting `|`), headings marks, emphasis marks, link targets (keep the link text), bare URLs, emoji, list bullets
    - a paragraph that is only a table, code or a URL is skipped

    It cuts at the last sentence end ≤ `max`, else at a word boundary. Returns null when nothing is left.
  - `narrateApproval(card: { toolName: string; input: unknown; description: string | null }, agent: string, lang: SpeechLang): string`.
    - Reads, in order: `summary|title|subject|name`, `start|start_time|startTime|when|date` (as written), `to|attendees|recipients|channel`. At most 3 fields, each ≤ 80 chars.
    - With none of those fields, falls back to `toolSummary(...)` with the `mcp__server__` prefix dropped and `_` turned into spaces.
    - English: `"<Agent> wants to <verb phrase> <fields>. Allow?"` Arabic: `"<Agent> بدو <…>. أوافق؟"`
  - `narrateQuestion(q: { question: string; options: { label: string }[] }, lang: SpeechLang): string`. English example: `"Which Obada? Option 1: Obada Kh. Option 2: Obada M. Say a number, a name, or your own answer."`
  - `type VoiceLine = 'done-see-screen' | 'allow-again' | 'left-on-screen' | 'plan-on-screen' | 'error' | 'unknown-agent' | 'codex-refused' | 'no-agent' | 'bye'`
  - `voiceLine(key: VoiceLine, lang: SpeechLang, vars?: { name?: string }): string`. Exact English copy:
    - "Done, details are on your screen."
    - "Sorry, allow or not?"
    - "I'll leave it on your screen."
    - "Plan ready, check your screen."
    - "Something went wrong, check the chat."
    - "I don't know an agent called {name}."
    - "{name} runs on Codex, so voice can't ask you before it acts."
    - "Who should I ask? Say: ask, then an agent's name."
    - "Bye."

    Arabic copies are the implementer's translation, reviewed in Task 14.

- [ ] **Step 1: Failing tests:**
  - `speakableLead('| a | b |\n|---|---|\n| 1 | 2 |')` → `null`
  - `speakableLead('Done, **Friday 3:30** with [Obada](https://x).\n\nDetails…')` → `'Done, Friday 3:30 with Obada.'`
  - a 900-char paragraph → ≤ 400 chars ending at a sentence end
  - `speakableLead('```ts\nx\n```')` → null
  - `langOf('تم، الجمعة ٣:٣٠')` → `'ar'`
  - `narrateApproval({ toolName: 'mcp__cal__create_event', input: { summary: 'Meeting with Obada', start: 'Friday 3:30 PM' }, description: null }, 'Work Assistant', 'en')` contains `'Meeting with Obada'`, `'Friday 3:30 PM'` and ends with `'Allow?'`
  - `narrateQuestion` numbers options from 1
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/frontend/tests/voiceSpeech.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 9: Picking the agent

**Files:**
- Create: `zumi-bot-server/frontend/src/state/voiceRoute.ts`
- Test: `zumi-bot-server/frontend/tests/voiceRoute.test.ts`

**Interfaces:**
- Consumes: `normalizeUtterance`, `ASK_PREFIXES` (Task 1); `matchAgent` (Task 3); `engineOfAgent`; `VoiceTalk` (Task 6).
- Produces:
  - `type VoiceRoute = { kind: 'agent'; agent: string; request: string } | { kind: 'unknown'; named: string } | { kind: 'codex'; agent: string } | { kind: 'no-agent' }`
  - `routeUtterance(text: string, agents: readonly AgentSummary[], talk: Pick<VoiceTalk, 'defaultAgent' | 'aliases'>): VoiceRoute`. Algorithm:

```
n = normalizeUtterance(text)
for each prefix in ASK_PREFIXES where n starts with prefix + ' ':
  rest = n after prefix
  // longest alias or agent name (normalized name and display name) that rest starts with, word-aligned
  hit = longest match over aliases (normalized) and agents' names/display names
  if hit: request = original text with the prefix and the matched name removed, plus a leading "to"/"ان"/"," trimmed
          return codex check → {codex} | {agent, request}
  else:   named = rest up to the first " to " / " ان " / "," (or the first 3 words)
          return { kind: 'unknown', named }
no prefix: a vocative "<name>, …" with a known name counts the same way
otherwise: talk.defaultAgent ? { agent: default, request: text } : { no-agent }
```

- [ ] **Step 1: Failing tests:**
  - `'Ask Work Assistant to set a meeting with Obada tomorrow after 3pm'` → `{ kind: 'agent', agent: 'work-assistant', request: 'set a meeting with Obada tomorrow after 3pm' }`
  - `'اسأل مساعد العمل يحجز اجتماع مع عبادة'` with alias `{ 'work-assistant': ['مساعد العمل'] }` → `agent: 'work-assistant'`, and the request starts with `'يحجز'`
  - `'اسأل work assistant …'` → `work-assistant`
  - `'Ask Bob to do x'` → `{ kind: 'unknown', named: 'bob' }`, never the default
  - `'set a meeting tomorrow'` → the default agent, request unchanged
  - a Codex agent named → `{ kind: 'codex' }`
  - no default and no prefix → `{ kind: 'no-agent' }`
  - `'Work Assistant, what is on my calendar'` → `work-assistant`
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/frontend/tests/voiceRoute.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 10: Conversation machine

**Files:**
- Create:
  - `zumi-bot-server/frontend/src/state/endpointer.ts`
  - `zumi-bot-server/frontend/src/state/voiceItems.ts`
  - `zumi-bot-server/frontend/src/state/voiceTalk.ts`
- Test:
  - `zumi-bot-server/frontend/tests/endpointer.test.ts`
  - `zumi-bot-server/frontend/tests/voiceItems.test.ts`
  - `zumi-bot-server/frontend/tests/voiceTalk.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 8, 9.
- Produces:
  - `endpointer.ts`:
    - `SPEECH_LEVEL = 0.02` (RMS 0..1, tune live)
    - `QUIET_AFTER_SPEECH_MS = 1500`, `NO_SPEECH_MS = 8000`, `MAX_CLIP_MS = 60_000`
    - `type EndpointState = { startedAt: number; heardAt: number | null; quietSince: number | null }`
    - `endpoint(s: EndpointState, level: number, now: number): { state: EndpointState; out: null | 'clip-done' | 'no-speech' | 'too-long' }`
  - `voiceItems.ts`. `type ApprovalItem = Extract<ChatItem, { type: 'approval' }>`; `type VoiceCue = { kind: 'card'; requestId: string; card: ApprovalItem } | { kind: 'question'; requestId: string; input: unknown } | { kind: 'plan'; requestId: string } | { kind: 'reply'; text: string } | { kind: 'error' }`. `voiceCues(items: readonly ChatItem[], since: string | null): VoiceCue[]` covers items after the user message id `since`:
    - pending approval items, oldest first, mapped by `toolName` (`QUESTION_TOOL` → question, `PLAN_TOOL` → plan, else card)
    - plus, when the turn has ended (an item carries `end`), a final `reply` holding the last assistant item's text after `since`, or an `error` when the turn ended in an error item
    - a card no longer pending is not a cue
  - `voiceTalk.ts`: a pure `step(s: TalkState, e: TalkEvent): { state: TalkState; effects: TalkEffect[] }`, `TALK_IDLE: TalkState`.
    - `TalkState`:
      - `phase: 'idle' | 'listening' | 'transcribing' | 'sending' | 'waiting' | 'speaking' | 'answering' | 'held' | 'ended'`
      - `run`, `chatId: string | null`, `agent: string | null`, `lang: SpeechLang`
      - `sinceItem: string | null`, `pending: VoiceCue | null`, `retried: boolean`, `failures: number`, `spoken: string[]` (cue keys already handled)
    - `TalkEvent`:
      - `start`, `stop`, `tap`
      - `heard{text}`, `noSpeech`, `transcribeFailed`
      - `routed{route}`, `chatReady{chatId, agent}`, `sent{itemId}`, `sendFailed`
      - `cues{list}`, `spokeDone`, `speakFailed`, `answered`
    - `TalkEffect`:
      - `acquire` (wake lock + mic), `release`
      - `listen`, `transcribe`
      - `createChat{agent}`, `send{text}`, `speak{text, lang}`
      - `answer{requestId, decision: 'allow-once'|'deny'}`, `answerQuestion{requestId, answers}`
      - `talking{chatId|null}` (presence)
    - Rules:
      - **First heard text:**
        - an end phrase → `speak bye` → `ended`
        - otherwise `routeUtterance` gives a `route` event; the hook supplies the agents and the talk settings
        - an agent route → `createChat` → `send(request)`
        - unknown, codex or no-agent → `speak` the line → `listening`
      - **Later heard text:** an end phrase → `bye` → `ended`. While `held` or `waiting`, heard text is ignored and listening is off. Otherwise `send(text)` to the same chat.
      - **Cues:** one cue at a time, never one already in `spoken`.
        - card → `speak(narrateApproval)` → `listening` for the answer
          - `parseYesNo` yes → `answer allow-once`; no → `answer deny`
          - unclear and not yet retried → `speak allow-again`
          - unclear again → `speak left-on-screen` → `held` until `cues` no longer lists that card
        - question → read each sub-question in turn; collect with `parseChoice`; send the answers once all are collected
        - plan → `speak plan-on-screen` → `held`
        - reply → `speak(speakableLead ?? done-see-screen)` → `listening`
        - error → `speak error` → `ended`
      - **Silence and taps:** `noSpeech` while `listening` → `ended`. `tap` while `speaking` → stop the audio → `listening`.
      - **Failures:** `transcribeFailed` twice in a row → `speak error` → `ended`. `speakFailed` → the hook falls back (browser voice, else on-screen text plus a tone), and the machine treats it like `spokeDone`.
      - **Release:** `ended` and `stop` always emit `release` and `talking{null}`; `acquire` comes only from `start`.

- [ ] **Step 1: Failing tests**, mirroring `frontend/tests/dictation.test.ts`'s style:
  - endpointer: speech then 1500 ms quiet → `clip-done`; 8000 ms of no speech → `no-speech`; 60 s → `too-long`
  - `voiceCues`:
    - two pending cards come back in ts order
    - an answered card is gone
    - a turn end with an assistant item gives `reply` with that text
    - an error item with `end` gives `error`
  - `step`:
    - **happy path:** `start → heard('Ask Work Assistant to …') → routed(agent) → chatReady → sent → cues([reply 'Done, Friday 3:30.']) → spokeDone` lands in `listening`, with effects in order `acquire, listen, transcribe, createChat, send, speak, listen`
    - **card yes:** `cues([card]) → spokeDone → heard('yes')` → effect `answer{allow-once}`
    - **card unclear twice:** `heard('maybe') → heard('hmm')` → effects `speak(allow-again)` then `speak(left-on-screen)`, phase `held`, and no `answer` effect
    - **card no:** `heard('لا')` → `answer{deny}`
    - **two cards:** the second is spoken only after the first's `answered`
    - **cue repeats:** a cue already in `spoken` arriving again in the next `cues` event is not spoken twice
    - **end phrase:** `heard('خلص')` → `speak(bye)`, then `ended`, `release`, `talking{null}`
    - **silence:** `noSpeech` → `ended` with `release`
    - **transcription failures:** two `transcribeFailed` → `speak(error)` → `ended`
    - **speak failure:** `speakFailed` while speaking a reply → `listen`, exactly as `spokeDone`
    - **stop:** `stop` from any phase → `release`
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/frontend/tests/endpointer.test.ts zumi-bot-server/frontend/tests/voiceItems.test.ts zumi-bot-server/frontend/tests/voiceTalk.test.ts`
- [ ] **Step 3: Implement the three modules.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 11: "Talking" presence

**Files:**
- Create: `zumi-bot-server/frontend/src/state/talkPresence.ts`
- Modify:
  - `zumi-bot-server/frontend/src/state/notifications.ts` (`isLooking`)
  - `zumi-bot-server/frontend/src/useNotifications.ts` (pass `talking`; re-report on change)
- Test: `zumi-bot-server/frontend/tests/notifications.test.ts`

**Interfaces:**
- Produces:
  - `talkPresence: { get(): string | null; set(chatId: string | null): void; subscribe(cb: () => void): () => void }`, a module-level store
  - `isLooking(s: { visible; focused; chatId; lastInputAt; now; talking?: string | null })` → true when `s.talking !== null && s.talking === s.chatId`, whatever the visibility or focus; otherwise as today
  - while talking, the reported `chatId` is the talking chat, even when the page shows another

- [ ] **Step 1: Failing test:** `isLooking({ visible: true, focused: false, chatId: 'c1', lastInputAt: 0, now: 999_999, talking: 'c1' })` → `true`; with `talking: 'c2'` → `false`.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/frontend/tests/notifications.test.ts`
- [ ] **Step 3: Implement.** Check that the island page runs `useNotifications`, which is mounted in `App.tsx` near line 1812. If the island path skips it, mount the presence reporting part for the island too.
- [ ] **Step 4: Run, expect PASS.**

---

### Task 12: `useVoiceTalk`, the phone page, and the e2e

**Files:**
- Create:
  - `zumi-bot-server/frontend/src/useVoiceTalk.ts`
  - `zumi-bot-server/frontend/src/components/VoiceTalkView.tsx`
- Modify:
  - `zumi-bot-server/shared/src/appPaths.ts` (`VOICE = '/voice'`, `voiceFromPath(pathname, search): { start: boolean } | null`)
  - `zumi-bot-server/frontend/src/state/route.ts` (re-export)
  - `zumi-bot-server/frontend/src/App.tsx` (route → full-screen `VoiceTalkView`; a mic button in the top bar, shown when `talkOn`)
  - `zumi-bot-server/frontend/public/manifest.webmanifest` (`"shortcuts": [{ "name": "Talk", "url": "/voice?start=1", "icons": [{ "src": "/icon-192.png", "sizes": "192x192" }] }]`)
  - `zumi-bot-server/e2e/voice.e2e.mjs`
- Test:
  - `zumi-bot-server/shared/tests/appPaths*.test.ts` (or the file that tests the other `*FromPath`)
  - the e2e

**Interfaces:**
- Consumes: Tasks 7 to 11; `api.chats.createVoice`, `api.chats.send`, `api.chats.answer`, `api.chats.answerQuestions`, `api.chats.onPush` / the chat's item sync; `transcribeClip`; `pickRecorderType`; `contentTypeOf`; `DICTATION_INPUT_EVENT`.
- Produces: `useVoiceTalk(o: { agents: AgentSummary[]; talk: VoiceTalk }): { state: TalkState; transcript: { who: 'you' | 'agent'; text: string }[]; start(): void; stop(): void; tap(): void }`. It is the only place doing I/O for voice:
  - `getUserMedia({ audio: true })`; `MediaRecorder` with dictation's type pick; `AudioContext` + `AnalyserNode` RMS at ~50 ms feeding `endpoint`
  - `navigator.wakeLock.request('screen')` on `acquire`, re-requested on `visibilitychange` back to visible, released on `release`
  - `speakText` → an `Audio` from an object URL, revoked after play; fallback `speechSynthesis` with a voice whose `lang` starts with `ar` or `en`, else none
  - `talkPresence.set`; `DICTATION_INPUT_EVENT` dispatched on each heard utterance
  - unmount → `stop`

`VoiceTalkView` shows, minimal and within the existing theme tokens:
- status text: Listening / Thinking / Speaking / Waiting for you on screen
- the transcript lines, a big Stop button, and an "Open chat" link
- "Tap to start" while the page has no user activation yet (`?start=1` from the shortcut may land without one)

- [ ] **Step 1: Failing test:** `voiceFromPath('/voice', '?start=1')` → `{ start: true }`; `voiceFromPath('/voices', '')` → `null`.
- [ ] **Step 2: Run, expect FAIL**, then implement the path helpers. Run, expect PASS.
- [ ] **Step 3: Implement the hook, the view, the App route, the top-bar button and the manifest shortcut.** Also add a small mic mark on sidebar rows of chats with `voice: true`, next to where other row marks render.
- [ ] **Step 4: Extend `voice.e2e.mjs`** with a "voice conversation" step. Its fake OpenRouter answers `/api/v1/audio/speech` with a short valid mp3 (add one under `e2e/fixtures/`). Its fake claude script:
  - replies `"Done, Friday 3:30 with Obada.\n\nDetails here."`
  - on the second turn emits a `can_use_tool` for `mcp__cal__create_event` with `#WAIT_RESPONSE`

  The step:
  - opens `/voice?start=1` and taps start
  - queues transcripts `"Ask Work Assistant to set a meeting"`, `"yes"`, `"that's all"`
  - asserts:
    - a chat titled `Voice · …` with `voice: true` exists
    - the speak request's `input` equals `"Done, Friday 3:30 with Obada."`
    - the card's status ends `allowed-once`
    - the page ends in `ended`
    - no `/api/voice/speak` body or transcript appears in the server log
- [ ] **Step 5: Run** `npm run e2e:voice`. Expected: all steps PASS.

---

### Task 13: Desk hotkey and island voice

**Files:**
- Create:
  - `zumi-bot-desktop/src/main/voiceHotkey.ts`
  - `zumi-bot-desktop/tests/voiceHotkey.test.ts`
- Modify:
  - `zumi-bot-desktop/src/main/islandPrefs.ts` (`voiceHotkey: string | null`, default `'Ctrl+Alt+Space'`)
  - `zumi-bot-desktop/src/main/island.ts` (`islandWanted` gains `voice: boolean`; voice-only window; `island:voice` send; `island:voiceEnded` IPC)
  - `zumi-bot-desktop/src/main/index.ts` (register, re-register on settings change, unregister on quit)
  - `zumi-bot-desktop/src/preload/index.ts` (bridge members)
  - `zumi-bot-server/shared/src/island.ts` (`IslandSettings.voiceHotkey?: string | null`; `IslandBridge.onVoice?(cb: (on: boolean) => void): () => void`; `IslandBridge.voiceEnded?(): void`)
  - `zumi-bot-server/shared/src/islandLayout.ts` (`islandBounds` with `icons: 0` and `open: true` gives a popup with no strip)
  - `zumi-bot-server/frontend/src/App.tsx` / `IslandView.tsx` (voice popup renders `VoiceTalkView` compact)
  - `zumi-bot-server/frontend/src/components/IslandSettings.tsx` (hotkey field)
- Test:
  - `zumi-bot-desktop/tests/island.test.ts`
  - `zumi-bot-desktop/tests/islandPrefs.test.ts`
  - `zumi-bot-server/shared/tests/islandLayout.test.ts`
  - `zumi-bot-server/shared/tests/island.test.ts`

**Interfaces:**
- Produces:
  - `islandWanted(s: { origin; picked; ready; icons; voice: boolean }): IslandState`:
    - `origin === null` → `'none'`
    - `picked === 0 && !voice` → `'none'`
    - shown when `ready && (icons > 0 || voice)`
  - `cleanHotkey(v: unknown): string | null`: an Electron accelerator from an allow-listed grammar (modifiers `Ctrl|Alt|Shift|Super` plus one key `A-Z|0-9|F1-F12|Space`), at least one modifier, ≤ 40 chars. Anything else → null.
  - `createVoiceHotkey(d: { register(acc: string, cb: () => void): boolean; unregister(acc: string): void; onPress(): void }): { set(acc: string | null): { ok: boolean }; dispose(): void }`
  - Shell behavior:
    - a press while no conversation runs sets `voice = true`, applies (creating the window if needed), and sends `island:voice true`
    - a press while one runs sends `island:voice false`
    - the page calls `voiceEnded()` when its machine reaches `ended` → `voice = false` → apply (a voice-only window is dropped)
    - the island still uses `showInactive()`
  - `IslandSettings.voiceHotkey` goes through `get/set`. `set` returns `{ ok: false }` in the settings result when registration fails, and the UI shows "That shortcut is taken by another app."

- [ ] **Step 1: Failing tests:**
  - `islandWanted({ origin: 'o', picked: 0, ready: true, icons: 0, voice: true })` → `'shown'`
  - the same with `voice: false` → `'none'`
  - `cleanHotkey('Ctrl+Alt+Space')` → same; `cleanHotkey('Space')` → null; `cleanHotkey('Ctrl+Alt+Space; rm')` → null
  - `parseIslandPrefs({})` has `voiceHotkey: 'Ctrl+Alt+Space'`
  - `islandBounds({ ..., icons: 0, open: true })` gives a popup rect and a zero-height strip
  - `createVoiceHotkey`:
    - `set('Ctrl+Alt+Space')` registers once
    - `set(null)` unregisters
    - a failed `register` returns `{ ok: false }` and keeps nothing registered
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run --project zumibot && npx vitest run zumi-bot-server/shared/tests/islandLayout.test.ts zumi-bot-server/shared/tests/island.test.ts`
- [ ] **Step 3: Implement.** `register` / `unregister` are Electron's `globalShortcut` in `index.ts`.
- [ ] **Step 4: Run, expect PASS.** Then `npm run build` and check by hand in `npm run dev`:
  - the hotkey opens the island listening with no agent picked
  - a spoken request runs
  - "that's all" closes it

  Run `npm run e2e:desktop` if it exists for the island and keep it green.

---

### Task 14: Docs and the full check

**Files:**
- Create:
  - `docs/architecture/voice-conversations.md`
  - `zumi-bot-server/backend/src/core/voice/CLAUDE.md` pointer (update the existing one to list both docs)
- Modify:
  - `CLAUDE.md` (one index line under "Docs by area": `- [Voice conversations](docs/architecture/voice-conversations.md): voiceTalk*, useVoiceTalk.ts, voiceGuard*, speaker.ts, voiceWords.ts, VoiceTalkView.tsx`)
  - `docs/architecture/voice-input.md` (one line pointing to the new doc)
  - `docs/architecture/data.md` (`voice.json` gains `talk`; `ChatMeta.voice`)
  - `docs/architecture/desktop-shell.md` (hotkey, voice-only island)
  - `docs/architecture/notifications.md` (talking presence)
  - `docs/architecture/e2e.md` (`voiceAskProbe.mjs`, the e2e:voice step)

- [ ] **Step 1: Write `voice-conversations.md`** in the repo's one-paragraph-per-area style. Cover:
  - the loop and the pure modules
  - routing and aliases
  - spoken lead and narration
  - forced asks (hook, matcher, `voiceConfirms` rules, saved rules ignored, allow-once only, probe)
  - TTS route limits and ZDR
  - the phone page and shortcut, the desk hotkey
  - presence
  - Codex refused
  - the design link

  Also review the Arabic copies of `voiceLine` against the English ones.
- [ ] **Step 2: Run** `npm test && npm run typecheck`. Expected: all projects PASS, including `shared/tests/repoDocs.test.ts`, which fails if root `CLAUDE.md` passes 16 KB.
- [ ] **Step 3: Run** `npm run e2e`. Expected: PASS, with `voiceAskProbe` PASS (not INCONCLUSIVE). Then kill any Chrome or playwright processes left behind (user rule).
