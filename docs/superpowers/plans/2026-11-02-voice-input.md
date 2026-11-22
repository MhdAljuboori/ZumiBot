# Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tap-to-start, tap-to-stop mic in the composer and the message edit box that records a clip, has the ZumiBot server transcribe it through OpenRouter (`elevenlabs/scribe-v2`, zero data retention), and inserts the text at the caret.

**Architecture:** The browser records Opus/webm (or ogg/mp4) with `MediaRecorder` and POSTs the raw clip to a new gated route, `/api/voice/transcribe`. The server holds it in memory, forwards it to OpenRouter as base64 JSON with `provider: { zdr: true }`, and returns `{ text }`. A pure state machine in `frontend/src/state/dictation.ts` drives a `useDictation` hook shared by both text boxes. Settings live in `voice.json` (0600), edited from a **Voice input…** dialog like **Jev decisions…**. The desktop shell starts allowing audio-only `media` for the connected origin.

**Tech Stack:** TypeScript, React 19, Tiptap/ProseMirror, Node `http`, vitest (node env), Electron 45, playwright-core with system Chrome.

**Spec:** `docs/superpowers/specs/2026-11-02-voice-input-design.md` (read it first; this plan argues from it).

## Global Constraints

- **No commits** (user's global rule). Each task ends with its tests passing, not with a commit.
- No new dependencies.
- OpenRouter URLs: `https://openrouter.ai/api/v1/audio/transcriptions` (POST) and `https://openrouter.ai/api/v1/key` (GET, key check). Model `elevenlabs/scribe-v2`. Body `{ model, input_audio: { data, format }, language?, provider: { zdr: true } }`; `language` only for `en`/`ar`, omitted for `auto`.
- Content types: `audio/webm` → `webm`, `audio/ogg` → `ogg`, `audio/mp4` → `m4a` (codec parameters ignored). Others → 415.
- Language header `X-ZumiBot-Voice-Lang`: `auto` | `en` | `ar`; anything else → 400.
- Caps: body 8 MB (`8 * 1024 * 1024`) → 413; 2 concurrent and 30 per rolling minute → 429; upstream timeout 60 000 ms → 504; clip cap 5 min (300 000 ms); clips under 600 ms are never uploaded.
- Route errors are `{ error: code }`: 400 `bad-request`, 413 `too-large`, 415 `bad-type`, 429 `busy`, 503 `off`, 502 `upstream`, 504 `timeout`. An upstream body is never passed through.
- `voice.json` in the data dir, written 0600: `{ enabled: boolean, key: string | null }`. Default `{ enabled: true, key: null }`. Not synced (no `sync.mjs` change).
- The key, the audio and the transcript never appear in logs, URLs, error messages or anything sent to the UI. Failure logs carry the HTTP status and the clip size only.
- Dev hook `ZUMIBOT_TEST_VOICE_URL`, read through `devEnv()`: an `http://127.0.0.1:<port>` origin (no path) that replaces `https://openrouter.ai`. Anything else is ignored.
- CSP unchanged. New header `Permissions-Policy: camera=(), microphone=(self), geolocation=()`.
- Recorder: first supported of `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4`; `audioBitsPerSecond: 32000`; `getUserMedia({ audio: true })`, never `video`.
- Language toggle stored in `localStorage` key `zumibot.voiceLang`; every read and write in try/catch; default `auto`; cycle Auto → EN → AR → Auto.
- Error copy, verbatim:
  - `blocked`: "Microphone is blocked. Allow it in the browser's site settings."
  - `nomic`: "No microphone found."
  - `empty`: "Didn't catch anything."
  - `network`: "Couldn't reach the server. Try again."
  - `upstream`, `timeout`, `failed`: "Transcription failed. Try again."
  - `too-large`: "That recording is too long."
  - `off`: "Voice input is off."
  - `busy`: "Too many recordings. Wait a moment."
- Announcements, verbatim: "Listening", "Transcribing", "Dictation added", "Dictation cancelled".
- Button labels: idle "Start dictation", listening "Stop dictation", transcribing "Cancel dictation". `aria-pressed` is true only while listening.
- Frontend unit tests run in node, with no DOM: keep logic in `src/state/` and `src/net/`.
- Comments are short and say why (the repo's style). Code reads like its neighbours.
- After any e2e or browser run, kill every Chrome/Electron process started (user's rule).

## Review Focus

1. **A late result after a drop:** a mic permission granted after the user cancelled or left the chat, or a transcript that arrives after a chat switch, must release the mic and insert nothing. The machine ignores events whose `run` is stale (Task 5 test `ignores events from an older run`), and the hook stops any stream that arrives for a stale run (Task 7, step 3).
2. **The held send must carry the dictated text:** Composer's `draft` prop lags the editor, so a send right after the insert would go out without the transcript. Composer submits the editor's latest text (Task 7), and the e2e checks that the sent message contains the transcript (Task 12, "send while listening").
3. **Send pressed twice while a send is held** must send once. The machine emits no second `send` (Task 5 test `a second send while held changes nothing`), Send is disabled while held, and the e2e counts exactly one user message (Task 12).
4. **Upstream answers that aren't the JSON we expect** (a proxy's HTML 502, `{}` with no `text`, a non-string `text`) must give 502 `upstream`, with no passthrough. Task 2 tests each one.
5. **A client that disconnects mid-request** must abort the upstream call and free its limiter slot. Task 3 test `an aborted request frees its slot` sends two requests, aborts one, then expects a third to get 200.

---

### Task 1: Shared voice types and `VoiceStore`

**Files:**
- Create: `zumi-bot-server/shared/src/voice.ts`
- Create: `zumi-bot-server/backend/src/core/voice/voiceStore.ts`
- Test: `zumi-bot-server/backend/tests/core/voiceStore.test.ts`

**Interfaces:**
- Produces (`@zumibot/shared/voice`):
  - `type VoiceLang = 'auto' | 'en' | 'ar'`, `VOICE_LANGS: readonly VoiceLang[]` (in cycle order)
  - `interface VoiceStatus { on: boolean; enabled: boolean; keySaved: boolean }`
  - `type VoiceCheck = { ok: true } | { ok: false; reason: 'invalid' | 'unreachable' | 'nokey' }`
  - `type VoiceRouteError = 'bad-request' | 'too-large' | 'bad-type' | 'busy' | 'off' | 'upstream' | 'timeout'`
  - `type VoiceFormat = 'webm' | 'ogg' | 'm4a'`, `VOICE_TYPES: Record<string, VoiceFormat>` (the three content types)
  - `VOICE_LANG_HEADER = 'X-ZumiBot-Voice-Lang'`, `VOICE_ROUTE = '/api/voice/transcribe'`
  - `VOICE_MAX_BYTES = 8 * 1024 * 1024`, `VOICE_MAX_MS = 300_000`, `VOICE_MIN_MS = 600`, `VOICE_KEY_MAX = 512`
- Produces (backend): `class VoiceStore { constructor(dataDir: string); status(): Promise<VoiceStatus>; key(): Promise<string | null>; set(patch: { enabled?: boolean; key?: string | null }): Promise<VoiceStatus> }`. `on = enabled && keySaved`.

- [ ] **Step 1: Write the failing tests** in `voiceStore.test.ts` (temp dir per test, like `tests/core/jevStore` tests if present, else `mkdtemp`):
  - `defaults to enabled with no key`: `status()` → `{ on: false, enabled: true, keySaved: false }`; `key()` → `null`.
  - `saves the key 0600 and never returns it in status`: `set({ key: 'sk-or-abc' })` → `{ on: true, enabled: true, keySaved: true }`; `JSON.stringify(status)` does not contain `sk-or-abc`; `(await stat(file)).mode & 0o777` is `0o600`; `key()` → `'sk-or-abc'`.
  - `removes the key`: `set({ key: null })` → `keySaved: false, on: false`.
  - `the switch turns it off without dropping the key`: `set({ enabled: false })` → `on: false, keySaved: true`; `key()` still returns it.
  - `a corrupt or odd file reads as defaults`: write `'{nope'`, then `{ enabled: 'yes', key: 5 }` → defaults.
- [ ] **Step 2:** Run `npx vitest run zumi-bot-server/backend/tests/core/voiceStore.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Write `shared/src/voice.ts` with the exports above, plus `voiceOn = (s: Pick<VoiceStatus,'enabled'|'keySaved'>) => s.enabled && s.keySaved`. Write `VoiceStore` the way `JevStore` is written: a serial queue, read on every call, `writeFileAtomic(file, json, 0o600)`.
- [ ] **Step 4:** Run the test again. Expected: PASS.

### Task 2: OpenRouter transcriber

**Files:**
- Create: `zumi-bot-server/backend/src/core/voice/transcriber.ts`
- Test: `zumi-bot-server/backend/tests/core/transcriber.test.ts`

**Interfaces:**
- Consumes: `VoiceFormat`, `VoiceLang`, `VoiceCheck` (Task 1).
- Produces:
  - `VOICE_MODEL = 'elevenlabs/scribe-v2'`, `OPENROUTER_ORIGIN = 'https://openrouter.ai'`, `VOICE_TIMEOUT_MS = 60_000`
  - `type TranscribeResult = { ok: true; text: string } | { ok: false; error: 'off' | 'upstream' | 'timeout' }`
  - `interface Transcriber { transcribe(audio: Buffer, format: VoiceFormat, lang: VoiceLang, signal?: AbortSignal): Promise<TranscribeResult>; check(): Promise<VoiceCheck> }`
  - `createTranscriber(d: { key(): Promise<string | null>; origin?: string; fetch?: typeof fetch; timeoutMs?: number; log?(line: string): void }): Transcriber`
  - `testVoiceOrigin(raw: string | undefined): string | null`: returns the origin only for `http://127.0.0.1:<port>` with path `/` and no query; otherwise `null`.

- [ ] **Step 1: Write the failing tests** with a fake `fetch` (`vi.fn`) that records `(url, init)`:
  - `posts base64 JSON with zdr and the model`: `transcribe(Buffer.from('abc'), 'webm', 'auto')` → url `https://openrouter.ai/api/v1/audio/transcriptions`; method POST; `Authorization` `Bearer k`; `Content-Type` `application/json`; parsed body `{ model: 'elevenlabs/scribe-v2', input_audio: { data: 'YWJj', format: 'webm' }, provider: { zdr: true } }` with no `language` key. Fake answers `{ text: ' hi ' }` → result `{ ok: true, text: 'hi' }`.
  - `sends language for en and ar`: body `language` is `'en'` / `'ar'`.
  - `no key is off, with no request`: `key()` → null → `{ ok: false, error: 'off' }`; fetch not called.
  - `bad upstream answers are upstream errors`: status 500 with an HTML body; 200 `'<html>'`; 200 `{}`; 200 `{ text: 5 }` → each `{ ok: false, error: 'upstream' }`.
  - `timeout`: a fetch that never resolves until aborted, `timeoutMs: 20` → `{ ok: false, error: 'timeout' }`.
  - `caller abort`: an aborted `signal` → fetch receives an aborted signal; the result is `upstream` (the route never answers it anyway).
  - `logs status and size only`: on a 500 whose body contains `SECRETBODY` (key `sk-or-SECRET`, transcript irrelevant), the logged lines contain `500` and do not contain `sk-or-SECRET`, `SECRETBODY`, or the base64 audio.
  - `check`: GET `https://openrouter.ai/api/v1/key` with the bearer key; 200 → `{ ok: true }`; 401 → `{ ok: false, reason: 'invalid' }`; fetch rejects → `unreachable`; no key → `nokey`.
  - `origin override`: with `origin: 'http://127.0.0.1:9'` both URLs start with it.
  - `testVoiceOrigin`: `'http://127.0.0.1:4555'` → same; `'http://127.0.0.1:4555/x'`, `'https://127.0.0.1:1'`, `'http://localhost:1'`, `'http://10.0.0.1:1'`, `undefined` → `null`.
- [ ] **Step 2:** Run `npx vitest run zumi-bot-server/backend/tests/core/transcriber.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `transcriber.ts`. Timeout and caller abort combine through one `AbortController` (`AbortSignal.any` is fine on Node 22). Read the answer with `res.text()` and then `JSON.parse` in try/catch, so an HTML body is an `upstream`.
- [ ] **Step 4:** Run the test. Expected: PASS.

### Task 3: `/api/voice/transcribe` route

**Files:**
- Create: `zumi-bot-server/backend/src/http/body.ts` (shared capped body reader)
- Modify: `zumi-bot-server/backend/src/http/upload.ts` (use `readBody`, behaviour unchanged)
- Create: `zumi-bot-server/backend/src/http/voice.ts`
- Modify: `zumi-bot-server/backend/src/http/server.ts` (option `voice?: VoiceRoute`, route after the gate and origin check)
- Modify: `zumi-bot-server/backend/tests/http/helpers.ts` (`startRig` passes `voice` through)
- Test: `zumi-bot-server/backend/tests/http/voice.test.ts`; existing `upload.test.ts` and `attachments.test.ts` must still pass

**Interfaces:**
- Consumes: `Transcriber`, `TranscribeResult` (Task 2); `VOICE_*` constants (Task 1).
- Produces:
  - `readBody(req: IncomingMessage, max: number): Promise<Buffer | null>`: `null` = over the cap. It is the drain-then-destroy loop from `handleStage`, moved.
  - `interface VoiceLimiter { take(): boolean; done(): void }`, `createVoiceLimiter(o?: { now?(): number; concurrent?: number; perMinute?: number }): VoiceLimiter` (defaults 2 and 30).
  - `interface VoiceRoute { on(): Promise<boolean>; transcriber: Pick<Transcriber, 'transcribe'>; limiter: VoiceLimiter }`
  - `handleTranscribe(req: IncomingMessage, res: ServerResponse, v: VoiceRoute): Promise<void>`

- [ ] **Step 1: Write the failing tests** in `voice.test.ts` on `startRig({ voice })`, with a fake transcriber that records calls:
  - `needs a session and our origin`: `allowGate(false)` → 401; a non-GET with a bad origin → 403 (the server already does both; the test pins it for this path).
  - `POST only`: GET → 405.
  - `checks type and language`: `text/plain` → 415 `{ error: 'bad-type' }`; `audio/webm;codecs=opus` with lang `fr` → 400 `bad-request`; no lang header → 400; an empty body → 400.
  - `too large`: a declared `Content-Length` over 8 MB → 413 `too-large`; a chunked body that grows past 8 MB → 413.
  - `off`: `on()` false → 503 `off`, transcriber not called.
  - `passes format and language through`: `audio/mp4` with `ar` → transcriber called with format `m4a`, lang `ar`, and the exact bytes; answers 200 `{ text: 'مرحبا' }`.
  - `maps errors`: transcriber `upstream` → 502; `timeout` → 504; `off` → 503.
  - `limits`: limiter with `concurrent: 2` and a transcriber that waits on a promise → third concurrent request 429 `busy`; a limiter with `perMinute: 2` and a fake `now` → third request 429, and after `now` moves 60 s on, 200.
  - `an aborted request frees its slot`: start two waiting requests, abort one client-side (`AbortController` on `fetch`), resolve the other; a new request then gets 200. The aborted call's `signal` was aborted.
  - `writes nothing to disk`: after a successful call, the rig's `root` and `os.tmpdir()` entries are unchanged, apart from the rig's own dir, compared before and after with `readdir`.
- [ ] **Step 2:** Run `npx vitest run zumi-bot-server/backend/tests/http/voice.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Move the body loop to `body.ts` and use it in `handleStage`. Run `npx vitest run zumi-bot-server/backend/tests/http/upload.test.ts zumi-bot-server/backend/tests/http/attachments.test.ts`. Expected: PASS, unchanged.
- [ ] **Step 4:** Implement `voice.ts`. Order: method → type → language → `on()` → `limiter.take()` → `readBody` → empty → transcribe with an `AbortController` aborted on `req` `close` before the response ends → map → `done()` in `finally`. Mount it in `server.ts`: `if (pathname === VOICE_ROUTE && o.voice) return handleTranscribe(req, res, o.voice)`, next to `/api/attachments/stage`. Without `o.voice`, the path stays 404.
- [ ] **Step 5:** Run the voice, upload and attachments tests. Expected: PASS.

### Task 4: `voice:` RPC, API contract, wiring, `Permissions-Policy`

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.voice`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (deps `voice`, handlers, `voiceKey()` check)
- Modify: `zumi-bot-server/backend/src/app.ts` (store, transcriber, limiter, `voiceChanged` broadcast, server `voice` option)
- Modify: `zumi-bot-server/frontend/src/net/api.ts`
- Modify: `zumi-bot-server/backend/src/http/headers.ts`
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`, `zumi-bot-server/backend/tests/http/headers.test.ts`, `zumi-bot-server/frontend/tests/net/api.test.ts` (if it lists methods)

**Interfaces:**
- Consumes: `VoiceStore` (Task 1), `createTranscriber`, `testVoiceOrigin` (Task 2), `createVoiceLimiter`, `VoiceRoute` (Task 3).
- Produces (`ZumiBotApi.voice`): `status(): Promise<VoiceStatus>`; `set(patch: { enabled?: boolean; key?: string | null }): Promise<VoiceStatus>`; `check(): Promise<VoiceCheck>`; `onChanged(cb: (s: VoiceStatus) => void): () => void` (event `voice:changed`).
- Handler deps: `voice: { store: Pick<VoiceStore, 'status' | 'set'>; check(): Promise<VoiceCheck> }` and `voiceChanged(s: VoiceStatus): void`.

- [ ] **Step 1: Write the failing tests.**
  - In `handlers.test.ts`, add `'voice:status', 'voice:set', 'voice:check'` to the handler-name list. Then:
    - `voice:set trims the key and never returns it`: `voice:set({ key: '  sk-or-XYZ\n' })` stores `sk-or-XYZ`, the result has no key, and `voiceChanged` is called once with that status.
    - `voice:set rejects bad input`: `{ key: 'a b' }`, `{ key: 'x'.repeat(513) }`, `{ enabled: 'yes' }` and `{ other: 1 }` throw. The error message never contains the key.
    - `voice:set({ key: null })` removes it.
  - In `headers.test.ts`, add `'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()'` to the pinned object.
- [ ] **Step 2:** Run `npx vitest run zumi-bot-server/backend/tests/rpc/handlers.test.ts zumi-bot-server/backend/tests/http/headers.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement:
  - The handlers, mirroring `jev:*`. `voiceKey()` mirrors `jevKey()`, using `VOICE_KEY_MAX` and the message "That does not look like an OpenRouter key".
  - The header.
  - The api mapping: `rpc.on('voice:changed', …)`.
  - In `app.ts`:
    - `const voiceStore = new VoiceStore(dataDir)`
    - `const transcriber = createTranscriber({ key: () => voiceStore.key(), origin: testVoiceOrigin(devEnv('ZUMIBOT_TEST_VOICE_URL')) ?? undefined, log: (l) => console.error(l) })`
    - `const voiceChanged = (payload) => hub.broadcast({ event: 'voice:changed', payload })`
    - pass `voice: { on: async () => (await voiceStore.status()).on, transcriber, limiter: createVoiceLimiter() }` to `createAppServer`.
- [ ] **Step 4:** Run the two tests plus `npx vitest run --project backend` and `npm run typecheck`. Expected: PASS, and `tests/app.test.ts` still passes.

### Task 5: Dictation state machine

**Files:**
- Create: `zumi-bot-server/frontend/src/state/dictation.ts`
- Test: `zumi-bot-server/frontend/tests/dictation.test.ts`

**Interfaces:**
- Consumes: `VOICE_MAX_MS`, `VOICE_MIN_MS` (Task 1).
- Defines here, so `state/voice.ts` can import from this module without a cycle: `type VoiceError = 'blocked' | 'nomic' | 'empty' | 'network' | 'upstream' | 'timeout' | 'failed' | 'too-large' | 'off' | 'busy'` and `voiceErrorText(e: VoiceError): string` (the copy table from Global Constraints). `state/voice.ts` re-exports both.
- Produces:
  ```ts
  export type DictationPhase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'error'
  export interface DictationState { phase: DictationPhase; run: number; startedAt: number | null; sendAfter: boolean; capped: boolean; error: VoiceError | null }
  export type DictationEvent =
    | { type: 'tap'; now: number } | { type: 'granted'; run: number; now: number } | { type: 'denied'; run: number; error: 'blocked' | 'nomic' | 'failed' }
    | { type: 'tick'; now: number } | { type: 'hidden' } | { type: 'send' } | { type: 'drop' } | { type: 'dismiss' }
    | { type: 'recorded'; run: number; ms: number } | { type: 'result'; run: number; text: string } | { type: 'failed'; run: number; error: VoiceError }
  export type DictationEffect =
    | { type: 'acquire'; run: number } | { type: 'finish'; run: number } | { type: 'release' } | { type: 'upload'; run: number }
    | { type: 'abort' } | { type: 'insert'; text: string } | { type: 'send' } | { type: 'announce'; text: string }
  export const IDLE: DictationState // run 0
  export function step(s: DictationState, e: DictationEvent): { state: DictationState; effects: DictationEffect[] }
  export const holdsSend = (s: DictationState): boolean => s.phase === 'listening' || s.phase === 'transcribing'
  ```
  `finish` stops the recorder so it delivers its clip. `release` stops every track and the wake lock. `upload` sends the finished clip. `abort` discards the clip and aborts any upload.

- [ ] **Step 1: Write the failing tests** (`run` values are the state's own):
  - `tap starts a new run`: IDLE + tap → `starting`, run 1, effects `[acquire(1)]`.
  - `granted starts listening`: → `listening`, `startedAt` = now, effects `[announce('Listening')]`.
  - `tap while starting cancels`: → `idle`, `[release]`; a later `granted(1)` changes nothing and returns `[release]` (the stale stream is let go).
  - `denied shows the error`: `denied(1,'blocked')` → `error`, `error: 'blocked'`, `[release, announce(<blocked copy>)]`.
  - `tap while listening transcribes`: → `transcribing`, `[finish(1), release, announce('Transcribing')]`.
  - `hidden while listening transcribes` (same effects); `hidden` in `starting`, `idle` and `transcribing` changes nothing.
  - `the cap stops at 5:00`: tick at `startedAt + 299_999` changes nothing; tick at `startedAt + 300_000` → `transcribing`, `capped: true`, `[finish, release, announce('Transcribing')]`.
  - `a short clip is not uploaded`: `recorded(1, 599)` → `error`, `error: 'empty'`, `[abort, announce(<empty copy>)]`; `recorded(1, 600)` → `[upload(1)]`.
  - `result inserts`: `result(1,'hello')` → `idle`, `[insert('hello'), announce('Dictation added')]`.
  - `an empty result is "empty"`: `result(1,'  ')` → `error`, `error: 'empty'`, no `insert`.
  - `failed shows the error and never sends`: with `sendAfter` set, `failed(1,'upstream')` → `error`, effects have no `send`.
  - `send while listening holds it`: → `transcribing`, `sendAfter: true`, `[finish, release, announce('Transcribing')]`; then `result(1,'hi')` → `[insert('hi'), announce('Dictation added'), send]` in that order.
  - `send while transcribing holds it`: → `sendAfter: true`, effects `[]`.
  - `a second send while held changes nothing`: state unchanged, effects `[]`.
  - `an empty result with a held send still sends the box`: `result(1,'')` with `sendAfter` → `error 'empty'`, effects include `send`, and no `insert`.
  - `send while starting drops the dictation`: → `idle`, `[release]`, and `holdsSend` was false before it (so the caller sends normally).
  - `tap while transcribing cancels`: → `idle`, `sendAfter: false`, `[abort, announce('Dictation cancelled')]`.
  - `drop from every phase`: from `starting`, `listening` and `transcribing` → `idle`, effects `[release, abort]`, with no `insert` or `send`, even with `sendAfter` set; from `idle` → nothing.
  - `ignores events from an older run`: after a drop and a new tap (run 2), `result(1,'x')`, `recorded(1, 900)` and `failed(1,'upstream')` change nothing and emit nothing.
  - `error then tap starts again; dismiss clears`: `error` + tap → `starting` run+1; `error` + dismiss → `idle`.
- [ ] **Step 2:** Run `npx vitest run zumi-bot-server/frontend/tests/dictation.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `step` as a switch on `e.type`, then on `s.phase`. Announcement texts come from the constraints; an error announces `voiceErrorText(error)`. Add a `voiceErrorText` test here covering all ten codes, so Task 6 needn't repeat it.
- [ ] **Step 4:** Run the test. Expected: PASS.

### Task 6: Text spacing, availability, language, copy, upload

**Files:**
- Create: `zumi-bot-server/frontend/src/state/voice.ts`
- Create: `zumi-bot-server/frontend/src/net/voice.ts`
- Test: `zumi-bot-server/frontend/tests/voice.test.ts`, `zumi-bot-server/frontend/tests/net/voice.test.ts`

**Interfaces:**
- Produces (`state/voice.ts`):
  - `spaceDictation(text: string, before: string | null, after: string | null): string`. `before`/`after` are the characters next to the selection, or `null` at a block or line edge. It adds `' '` before when `before` is a non-whitespace character, and always ends with one `' '` (even before existing whitespace, so the caret never sits right after an `@word` or `/name`). The text is trimmed first.
  - `insertIntoText(value: string, start: number, end: number, text: string): { value: string; caret: number }`: for the textarea. A `\n` neighbour counts as a line edge (`null`) for the leading space only; the trailing rule still applies, so the text ends in whitespace before a `\n`. The caret goes after the inserted text, including its trailing space.
  - Re-exports `VoiceError` and `voiceErrorText` from `./dictation`.
  - `nextLang(l: VoiceLang): VoiceLang`, `loadLang(storage?: Pick<Storage,'getItem'>): VoiceLang`, `saveLang(l: VoiceLang, storage?: Pick<Storage,'setItem'>): void`; both swallow errors, and a bad stored value reads as `auto`.
  - `pickRecorderType(isSupported: (t: string) => boolean): string | null`: the first of the three types, in order.
  - `micShown(o: { status: VoiceStatus | null; canRecord: boolean; shell: boolean; micPermission: 'granted' | 'denied' | 'prompt' | 'unknown' }): boolean`: false when `status` is null or not `on`, when `!canRecord`, or when `shell && micPermission === 'denied'`.
  - `contentTypeOf(recorderType: string): string`: strips codec parameters (`'audio/webm;codecs=opus'` → `'audio/webm'`).
- Produces (`net/voice.ts`): `transcribeClip(fetchImpl: typeof fetch, clip: Blob, contentType: string, lang: VoiceLang, signal: AbortSignal, onSignedOut?: () => void): Promise<{ ok: true; text: string } | { ok: false; error: VoiceError }>`.

- [ ] **Step 1: Write the failing tests.**
  - spacing:
    - `spaceDictation('hi', null, null)` → `'hi '`
    - `('hi', 'a', null)` → `' hi '`
    - `('hi', ' ', 'b')` → `'hi '`
    - `('hi', 'a', ' ')` → `' hi '`
    - `(' hi  ', null, null)` → `'hi '`
    - Arabic: `spaceDictation('مرحبا', 'o', null)` → `' مرحبا '`
  - insertIntoText:
    - `insertIntoText('ab', 1, 1, 'X')` → `{ value: 'a X b', caret: 4 }`
    - `('ab', 0, 2, 'X')` → `{ value: 'X ', caret: 2 }`
    - `('a\nb', 2, 2, 'X')` → `'a\nX b'`
  - menus never open: for each of `'/check'`, `'hello @ed'`, `'@'`, insert into `''` and into `'x '`, then assert `mentionQuery(value, caret) === null` and `textSlashQuery(value, caret, caret) === null`.
  - language:
    - `nextLang` cycles auto → en → ar → auto
    - `loadLang` on a throwing storage → `'auto'`; on `'ar'` → `'ar'`; on `'xx'` → `'auto'`
    - `saveLang` on a throwing storage doesn't throw
  - `pickRecorderType`: only mp4 supported → `'audio/mp4'`; none → `null`.
  - `micShown`:
    - status off → false
    - `canRecord` false → false
    - shell with `denied` → false
    - browser with `denied` → true
    - shell with `granted` → true
    - null status → false
  - `net/voice.test.ts` (fake fetch):
    - POSTs to `/api/voice/transcribe` with headers `Content-Type: audio/webm` and `X-ZumiBot-Voice-Lang: ar`, and the blob as body
    - 200 `{ text }` → ok
    - error codes: 401 → `onSignedOut` is called and the result is `failed`; 413 → `too-large`; 429 → `busy`; 503 → `off`; 502 → `upstream`; 504 → `timeout`; 400 and 415 → `failed`
    - a rejected fetch → `network`
    - an `AbortError` → `failed` (the caller ignores it, since its run is stale)
    - a 200 with non-JSON → `failed`
- [ ] **Step 2:** Run `npx vitest run zumi-bot-server/frontend/tests/voice.test.ts zumi-bot-server/frontend/tests/net/voice.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement both modules. `transcribeClip` follows `net/upload.ts` (raw body, `redirectToLogin` default).
- [ ] **Step 4:** Run the tests. Expected: PASS.

### Task 7: `useDictation`, the button and strip, the composer, presence

**Files:**
- Create: `zumi-bot-server/frontend/src/useDictation.ts`
- Create: `zumi-bot-server/frontend/src/components/Dictation.tsx` (`DictationButton`, `DictationStrip`)
- Modify: `zumi-bot-server/frontend/src/components/Composer.tsx`
- Modify: `zumi-bot-server/frontend/src/useNotifications.ts` (inputs list)
- Modify: `zumi-bot-server/frontend/src/styles.css`

**Interfaces:**
- Consumes: `step`, `IDLE`, `holdsSend` (Task 5); `voice.ts` helpers, `transcribeClip` (Task 6); `api.voice` (Task 4).
- Produces:
  - `useVoiceOn(): boolean`: module-level cache of `api.voice.status()` (one request per page) plus `api.voice.onChanged`, combined with `micShown` (`canRecord` = `!!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined' && pickRecorderType(MediaRecorder.isTypeSupported) !== null`; `shell` = `!!api.desktop`; in the shell only, `navigator.permissions.query({ name: 'microphone' as PermissionName })` in try/catch, else `'unknown'`).
  - `useDictation(o: { insert(text: string): void; send(): void }): Dictation` where `interface Dictation { state: DictationState; elapsedMs: number; lang: VoiceLang; tap(): void; cycleLang(): void; requestSend(): boolean }`. `requestSend()` returns true when the dictation took over the send (`holdsSend` was true); false means "send now yourself" (it also feeds `send` to the machine, which drops a dictation in `starting`).
  - `const DICTATION_INPUT_EVENT = 'zumibot:input'` (exported from `useDictation.ts`, imported by `useNotifications.ts`).
  - `DictationButton({ d, disabled }: { d: Dictation; disabled: boolean })` and `DictationStrip({ d }: { d: Dictation })`.

- [ ] **Step 1: Write the hook.** The state lives in a ref. `dispatch(e)` runs `step` synchronously, stores the new state in the ref, calls `setState` so React renders it, and then runs the effects in order. Running them synchronously is what lets the unmount cleanup drop a dictation, and lets a held send see the text it just inserted. The effects:
  - `acquire`: `getUserMedia({ audio: true })` →
    - if the run is stale when it resolves, stop its tracks at once (Review Focus 1);
    - else build the `MediaRecorder` (type from `pickRecorderType`, `audioBitsPerSecond: 32000`), start it, take a wake lock (try/catch), and dispatch `granted`.
    - `NotAllowedError`/`SecurityError` → `denied 'blocked'`; `NotFoundError` → `'nomic'`; else `'failed'`.
  - `finish`: `recorder.stop()`; on its `stop` event, dispatch `recorded` with `ms = Date.now() - startedAt` and keep the Blob.
  - `release`: stop every track and release the wake lock.
  - `upload`: `transcribeClip` with a fresh `AbortController`, then dispatch `result` or `failed`.
  - `abort`: abort that controller and drop the Blob.
  - `insert`/`send`: call the options through a ref.
  - `announce`: set the live-region text.
  - Timers: a 250 ms interval while listening dispatches `tick`. `visibilitychange` to hidden dispatches `hidden`. Unmount dispatches `drop` (effects run synchronously in cleanup). An `error` state dispatches `dismiss` after 8 s.
  - Single active dictation: a module-level `let active: { drop(): void } | null`. A `tap` from idle/error drops the other one first.
  - Presence: dispatch `new Event(DICTATION_INPUT_EVENT)` on `window` at `granted`, every 30 s while listening, and at `insert`.
- [ ] **Step 2: Wire the composer.**
  - `const voiceOn = useVoiceOn()`. Call `useDictation` unconditionally; render the button only when `voiceOn`.
  - `insert`: read the editor selection `{ from, to }`. `before` = the character at `from - 1` when `$from.parentOffset > 0`, else `null`. `after` = the character at `to` when `$to.parentOffset < $to.parent.content.size`, else `null`. Run `editor.chain().command(({ tr }) => { tr.insertText(spaceDictation(text, before, after), from, to); return true }).run()` with no `.focus()`.
  - Split `submit` into `submitText(text: string)`. Both the button and the held send call it with `unseen.current.at(-1) ?? draft` (the editor's latest text; Review Focus 2). `canSend` is computed from that text.
  - `submit` (the user's press: the button or Enter) first calls `dictation.requestSend()` and returns if it is true. The hook's `send` option calls `submitText` directly, never `submit`.
  - `DictationButton disabled={!claudeFound}`. In the edit box, use `disabled={busy}`.
  - `const dictating = holdsSend(dictation.state)`. `empty` becomes `draft.trim() === '' && !hasReady && !dictating`, so the button shows Send, not Stop.
  - Send is disabled while `dictation.state.sendAfter`.
  - Order in `.composer-box`: attach, field, `DictationButton`, send. Put `DictationStrip` right before the attach error.
  - The mic's `onMouseDown` calls `e.preventDefault()`.
- [ ] **Step 3: Write the button and strip.**
  - Button: `data-testid="dictation-button"`, `data-phase={phase}`, the aria labels from the constraints, `aria-pressed`.
  - Strip: `data-testid="dictation-strip"`.
    - While listening: `● Listening m:ss · <lang chip>`, where the chip is a button `data-testid="dictation-lang"` showing `Auto`/`EN`/`AR`.
    - While transcribing: `Transcribing…`, or `Transcribing, then sending…` while `sendAfter`.
    - While capped: "Stopped at 5:00" for 4 s.
    - On error: `data-testid="dictation-error"`, `role="alert"`, class `attach-error`.
  - A visually hidden `role="status" aria-live="polite"` element (`className="sr-only"`) holds the announcement.
  - CSS:
    - `.dictation-btn` sized like `.attach-btn`.
    - `.dictation-btn[data-phase="listening"]` red (`var(--error)`) with a `@keyframes` pulse that `prefers-reduced-motion` turns off.
    - The strip styled like the reply strip.
- [ ] **Step 4:** In `useNotifications.ts`, add `DICTATION_INPUT_EVENT` to the window listeners as a separate `addEventListener` with the same `onInput`. Window events from `dispatchEvent` aren't in the `inputs` const's DOM event types, so give it its own line and its own removal.
- [ ] **Step 5:** Run `npm run typecheck` and `npx vitest run --project frontend`. Expected: PASS. A quick manual look happens in Task 12's e2e run.

### Task 8: Mic in the message edit box

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/MessageEditor.tsx`

**Interfaces:**
- Consumes: `useVoiceOn`, `useDictation`, `DictationButton`, `DictationStrip` (Task 7); `insertIntoText` (Task 6).

- [ ] **Step 1:** Keep `const latest = useRef(text)`, updated in `change()` and in `insert`.
  - `insert`: `const r = insertIntoText(latest.current, box.selectionStart, box.selectionEnd, t)`, then `setText(r.value)`, `setCaret({ start: r.caret, end: r.caret })`, and set the textarea selection in the existing `useLayoutEffect`, or a new one if there isn't one for this.
  - The held `send` calls `submit` with `latest.current`.
  - `submit` first checks `dictation.requestSend()`.
  - Put `DictationButton` first in `.msg-edit-btns`, and `DictationStrip` above that row.
  - Cancel and Esc unmount the editor, so the hook's unmount drop covers "edit box closes".
- [ ] **Step 2:** Run `npm run typecheck` and `npx vitest run zumi-bot-server/frontend/tests/messageEdit.test.ts`. Expected: PASS.

### Task 9: **Voice input…** dialog

**Files:**
- Create: `zumi-bot-server/frontend/src/components/VoiceDialog.tsx`
- Modify: `zumi-bot-server/frontend/src/components/AccountMenu.tsx`, `zumi-bot-server/frontend/src/components/MenuIcon.tsx` (add `mic`)

**Interfaces:**
- Consumes: `api.voice` (Task 4), `VOICE_KEY_MAX`.

- [ ] **Step 1:** Write `VoiceDialog` the way `JevDialog` is written: same classes, Esc closes, a `run()` wrapper, `errorMessage`.
  - Testids: `voice-dialog`, `voice-enabled` (checkbox "Use voice input"), `voice-key`, `voice-key-save`, `voice-key-state`, `voice-key-test` ("Check key"), `voice-key-remove`, `voice-note`, `voice-close`.
  - Message line, verbatim: "Speech is sent to ElevenLabs Scribe v2 through OpenRouter, with zero data retention. Audio is never stored."
  - Check results:
    - ok: "OpenRouter accepted the key."
    - `invalid`: "OpenRouter refused the key."
    - `unreachable`: "Couldn't reach OpenRouter."
    - `nokey`: "No key saved."
  - Save runs the check afterwards, like Jev's.
- [ ] **Step 2:** In AccountMenu, add the item `data-testid="voice-settings"`, labelled "Voice input…" with `MenuIcon name="mic"`, after **Jev decisions…**. Then render `{voice && <VoiceDialog onClose={closeVoice} />}`.
- [ ] **Step 3:** Run `npm run typecheck`. Expected: PASS.

### Task 10: RTL rendering

**Files:**
- Modify: `zumi-bot-server/frontend/src/styles.css`
- Modify: `zumi-bot-server/frontend/src/components/MessageEditor.tsx` (`dir="auto"` on the textarea)

- [ ] **Step 1:** Add one rule:
  ```css
  /* Each block takes its direction from its first strong letter, so Arabic lines read right to left. */
  :is(.composer-input, .sent-text, .markdown, .bubble.user) :is(p, li, blockquote, h1, h2, h3, h4, h5, h6),
  .bubble.user, .msg-edit-input { unicode-bidi: plaintext; text-align: start; }
  ```
  Then keep `pre` and `code` LTR with `:is(.composer-input, .sent-text, .markdown) :is(pre, code) { direction: ltr; unicode-bidi: isolate; }`. Put `dir="auto"` on the textarea.
- [ ] **Step 2:** This is checked in Task 12 (an Arabic transcript renders right-aligned, so its computed `text-align` resolves to right in the box). Run `npm run build:server`. Expected: the build succeeds.

### Task 11: Desktop shell allows audio only

**Files:**
- Modify: `zumi-bot-desktop/src/main/navigation.ts`
- Modify: `zumi-bot-desktop/src/main/index.ts:330-336`
- Test: `zumi-bot-desktop/tests/navigation.test.ts`

**Interfaces:**
- Produces: `interface MediaAsk { mediaTypes?: readonly string[]; mediaType?: string }` and `isPermissionAllowed(permission: string, requestingUrl: string, origin: string, media: MediaAsk = {}): boolean`. `media` is allowed only for the same origin, and only when `mediaTypes` is non-empty and every entry is `'audio'`, or (for checks, with no `mediaTypes`) `mediaType === 'audio'`.

- [ ] **Step 1: Write the failing tests** (replace the line that expects `media` false):
  - `isPermissionAllowed('media', o + '/', o, { mediaTypes: ['audio'] })` → true
  - `{ mediaTypes: ['video'] }`, `['audio', 'video']` and `[]` → false
  - `{}` → false
  - `('media', 'https://evil.test/', o, { mediaTypes: ['audio'] })` → false
  - `('media', 'file:///x', o, { mediaTypes: ['audio'] })` → false
  - check form: `{ mediaType: 'audio' }` → true; `{ mediaType: 'video' }` and `{ mediaType: 'unknown' }` → false
  - `notifications`, `display-capture` and `screen-wake-lock` stay false
- [ ] **Step 2:** Run `npx vitest run zumi-bot-desktop/tests/navigation.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. In `index.ts`:
  - pass `{ mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined }` in the request handler;
  - pass `{ mediaType: details.mediaType }` in the check handler.
  - Update the comment above the handlers: "A remote page runs in this app: it gets the clipboard and, for dictation, the microphone, nothing else."
  - Update the doc comment on `isPermissionAllowed`.
- [ ] **Step 4:** Run the test and `npm run typecheck`. Expected: PASS.

### Task 12: `e2e:voice`

**Files:**
- Modify: `zumi-bot-server/e2e/harness.mjs`: `start({ chromeArgs = [] })` passes them to `chromium.launch({ args })`, and `h.newContext(options)` makes a context with the same `cb_local` cookie and error watchers.
- Create: `zumi-bot-server/e2e/voice.e2e.mjs`
- Modify: `package.json` (root): `"e2e:voice": "npm run build && node zumi-bot-server/e2e/voice.e2e.mjs"`

**Interfaces:**
- Consumes: every testid above, plus the existing `composer-input`, `send-button`, `message-editor-*` and new-chat testids (see `commands.e2e.mjs`).

- [ ] **Step 1: Write the suite**, in the shape of `notifications.e2e.mjs`: header comment, `ok()`, `assert`, `waitFor`, a `finally` that stops everything, and a 3-minute overall timeout.
  - **Fake OpenRouter:** a local `http.createServer` on `freePort()`. It records each request's parsed JSON and headers. It answers `POST /api/v1/audio/transcriptions` from a queue the test sets (`{ text }`, `{ status: 500 }`, or `{ delayMs, text }`).
  - **Setup:** write `voice.json` `{ enabled: true, key: 'e2e-dummy-key' }` into a fresh data dir. Then `start({ fake: true, dataDir, chromeArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: { ZUMIBOT_TEST_VOICE_URL: fake.origin } })`.
  - **Track check:** an init script on every context wraps `navigator.mediaDevices.getUserMedia` and keeps every returned track in `window.__tracks`.
  - **Contexts:** run the composer cases on a desktop context and on a phone context, `h.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })`.
  - Cases:
    1. **Off:** with `voice.json` `enabled: false` (rewrite the file, then reload), there is no `dictation-button`. Turn it back on and reload.
    2. **Tap, wait, tap:** type `start ` first, then tap. `data-phase` goes `listening` and the strip's time passes `0:01`. Tap again, `Transcribing…` shows, and the fake answers `world`. The box reads `start world `. Send still shows Send, no user message was sent, and every `__tracks` entry has `readyState === 'ended'`.
    3. **Request shape:** the fake saw `model: 'elevenlabs/scribe-v2'`, `provider.zdr === true`, `format: 'webm'`, no `language` (Auto), a non-empty base64 `data`, and the bearer `e2e-dummy-key`. Tap the lang chip twice (to `AR`) and dictate again: `language: 'ar'`.
    4. **Send while listening:** with a reply running (the fake claude script waits; reuse `#WAIT_RESPONSE` as `e2e:routines` does) and an empty box, the button shows Send while listening. Press it: Send is disabled, the strip shows `Transcribing, then sending…`, the fake answers after 1 s, and exactly one new user message holding the transcript appears (as a queued task).
    5. **Send with an upstream error:** the fake answers 500. `dictation-error` shows "Transcription failed. Try again.", nothing is sent, and the box keeps its text.
    6. **Chat switch while listening:** click another chat in the sidebar. The fake gets no request (or the request is aborted before it answers), and neither chat's box gets text. All tracks have ended.
    7. **Page hidden while listening:** set `document.visibilityState` to `hidden` (`Object.defineProperty`) and dispatch `visibilitychange`. The fake gets the clip and the text is in the box.
    8. **Menus:** transcripts `/check` (in an empty box) and `hello @ed`. Neither `command-menu` nor `mention-menu` is visible.
    9. **RTL:** transcript `مرحبا بكم`. The composer paragraph's computed `text-align` is `right` (or `direction` resolves to rtl via `getComputedStyle`; `unicode-bidi: plaintext` makes `text-align: start` resolve to right). After Send, the user bubble's paragraph is also right-aligned.
    10. **Edit box:** hover a sent message, press Edit, dictate `again`. The textarea holds the text with spacing. Press its Send, and the new version shows the text.
    11. **Blocked:** a new context whose init script makes `getUserMedia` reject with `new DOMException('x', 'NotAllowedError')` shows "Microphone is blocked. Allow it in the browser's site settings."
    12. **Draft survives reload:** after a dictation, reload; the box still has the text.
- [ ] **Step 2:** Run `npm run e2e:voice`. Expected: every `ok …` line prints and the process exits 0. Fix and rerun until it does.
- [ ] **Step 3:** Run `pgrep -fa 'chrome.*cb-e2e|zumi-bot-server/backend/dist/server.mjs'`. Expected: no output. Kill anything left over.

### Task 13: Docs and full verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Edit CLAUDE.md, in its existing style:
  - Commands: add `e2e:voice` to the e2e list sentence, and a sentence saying it uses only the fake claude, a fake OpenRouter (`ZUMIBOT_TEST_VOICE_URL`) and Chrome's fake mic, so it costs no quota.
  - Architecture: a **Voice input (`core/voice/`)** paragraph covering:
    - the mic in the composer and edit box;
    - `MediaRecorder` → `/api/voice/transcribe` (gated, 8 MB, 2 at once, 30 a minute, memory only) → OpenRouter `elevenlabs/scribe-v2` with `zdr: true`;
    - the pure machine in `state/dictation.ts`;
    - stop reasons;
    - the held Send;
    - `zumibot:input` for presence;
    - **Voice input…**;
    - the shell allowing audio-only `media`;
    - the `Permissions-Policy` header;
    - the RTL rule.
  - Data: `voice.json` (0600, not synced).
  - Dev hooks: `ZUMIBOT_TEST_VOICE_URL`.
- [ ] **Step 2:** Run `npm test`. Expected: all projects pass.
- [ ] **Step 3:** Run `npm run typecheck`. Expected: no errors.
- [ ] **Step 4:** Run `npm run e2e:voice`. Expected: exit 0. Then check that no Chrome or server processes are left (Task 12, step 3).
- [ ] **Step 5:** Ask the user to set the real key in **Voice input…** themselves. Then dictate once in English and once in Arabic, on the phone and in the shell (the shell needs a rebuilt shell, `npm run dev`). This confirms that Scribe accepts webm through the ZDR route. If OpenRouter refuses, report its error status, not its body.
