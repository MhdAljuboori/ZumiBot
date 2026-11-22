# Clean Voice Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Settings › Voice input switches, both off by default, that cut filler words and let Claude Haiku rewrite each transcript, for dictation and voice conversations alike.

**Architecture:** The server cleans in `handleTranscribe`, after Scribe answers: a pure filler filter (`stripFillers`, shared) and an OpenRouter chat call (`core/voice/cleaner.ts`) that falls back to the filtered text on any failure. The switches live in `voice.json` as `clean`; a request header lets voice talk refuse the rewrite while answering a card.

**Tech Stack:** TypeScript, Node fetch, vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-13-voice-cleanup-design.md`

## Global Constraints

- No commits (the user's rule); every "commit" step is skipped.
- Both switches default to `false`; an old `voice.json` reads as both off.
- Rewrite model `anthropic/claude-haiku-5.5`, `temperature: 0`, `provider: { zdr: true }`, one fixed system prompt, transcript inside `<transcript>` tags.
- Header `X-ZumiBot-Voice-Clean`, values `full` | `light`, absent = `full`, anything else = 400 `bad-request`.
- The rewrite is skipped for `light`, and for 3 words or fewer.
- "Fix mistakes with AI" on also runs the filler filter (so short and `light` clips and failed rewrites are still cut).
- The transcript, the cleaned text and the key never reach logs, URLs or errors: a log line has the status and the character count only.
- Run commands from `zumi-bot-server/`'s repo root (`npx vitest run <file>`).

## Review Focus

- Arabic `اه`/`آه`, `mhm`, `mm-hmm`, `uh-huh` mean yes and must survive the filter (test in Task 1).
- A clip that is only filler ("Um.") becomes `''`: dictation inserts nothing and voice talk listens again, as for noise (test in Task 1).
- A rewrite that answers the transcript instead of cleaning it (much longer output, the tag echoed) falls back (test in Task 3).
- A 5-minute dictation: the rewrite times out at 20 s (raised from the design's 10 s so long dictation fits; my call) and the filtered text is used (test in Task 3).
- An older open page sends no clean header and still gets `full` (test in Task 4).

---

### Task 1: Shared types and the filler filter

**Files:**
- Modify: `shared/src/voice.ts`, `shared/src/types.ts:515`, `shared/src/voiceWords.ts`
- Test: `shared/tests/voice.test.ts`, `shared/tests/voiceWords.test.ts`

**Interfaces:**
- Produces (`voice.ts`): `interface VoiceClean { fillers: boolean; rewrite: boolean }`, `DEFAULT_CLEAN: VoiceClean` (both false), `VoiceStatus.clean: VoiceClean`, `type VoiceCleanMode = 'full' | 'light'`, `VOICE_CLEAN_MODES`, `VOICE_CLEAN_HEADER = 'X-ZumiBot-Voice-Clean'`, `parseCleanPatch(v: unknown): Partial<VoiceClean> | null`.
- Produces (`voiceWords.ts`): `FILLER_WORDS` (normalised table), `stripFillers(text: string): string`.
- `ZumiBotApi.voice.set` patch gains `clean?: Partial<VoiceClean>`.

- [ ] **Step 1: Failing tests.** `parseCleanPatch`: `{fillers: true}` → same; `{rewrite: false}` → same; `{}` → `{}`; `{fillers: 'yes'}`, `{other: true}`, `null`, `[]` → null. `stripFillers`:
  - `'Um, so, uh, I want to go.'` → `'So, I want to go.'`
  - `'I want to go, um.'` → `'I want to go.'` (a dropped token's end mark moves onto the previous word, replacing its comma)
  - `'Ummm hmmm okay'` → `'Okay'` (letter runs of 3+ fold to 2 before the lookup)
  - `'مم بدي امممم اجتماع'` → `'بدي اجتماع'`
  - unchanged: `'اه'`, `'آه'`, `'Mhm.'`, `'Mm-hmm.'`, `'Uh-huh.'`, `'umbrella'`, `'I like it, you know.'`, `'يعني'`, `'أم'`
  - `'Um.'` → `''`; `''` → `''`
  - `FILLER_WORDS` joins the existing "every table is normalised" test.
- [ ] **Step 2: Run** `npx vitest run shared/tests/voice.test.ts shared/tests/voiceWords.test.ts` — FAIL (missing exports).
- [ ] **Step 3: Implement.** `FILLER_WORDS = table('uh', 'uhh', 'um', 'umm', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hm', 'hmm', 'mm', 'امم', 'مم', 'اا')` (never `ام`: "أم" is a word). `stripFillers` splits on whitespace, drops a token whose `normalizeUtterance` is one word that, after folding letter runs of 3+ to 2, is in the table; moves a dropped token's trailing `.?!؟…` onto the previous kept token (replacing a trailing comma); joins with single spaces; uppercases the first letter when the text's first letter was uppercase.
- [ ] **Step 4: Run** the same command — PASS. Then `npm run typecheck` shows only the expected `clean` errors in backend/frontend (fixed in Tasks 2 and 5).

### Task 2: Store and `voice:set`

**Files:**
- Modify: `backend/src/core/voice/voiceStore.ts`, `backend/src/rpc/handlers.ts:424-438`
- Test: `backend/tests/core/voiceStore.test.ts`, `backend/tests/rpc/handlers.test.ts`

**Interfaces:** Consumes Task 1's `VoiceClean`, `DEFAULT_CLEAN`, `parseCleanPatch`. Produces `VoiceStore.clean(): Promise<VoiceClean>` and `set({clean?})` merging over the saved value.

- [ ] **Step 1: Failing tests.** Store: a file without `clean` → `status().clean` equals `{fillers: false, rewrite: false}`; `{clean: {fillers: 'x', rewrite: true}}` → `{fillers: false, rewrite: true}`; `set({clean: {rewrite: true}})` then `set({clean: {fillers: true}})` → both true, key and talk untouched; `clean()` returns the saved value. Handler: `voice:set` with `{clean: {fillers: true}}` saves it; `{clean: {fillers: 1}}` rejects with `bad clean settings`.
- [ ] **Step 2: Run** `npx vitest run backend/tests/core/voiceStore.test.ts backend/tests/rpc/handlers.test.ts -t voice` — FAIL.
- [ ] **Step 3: Implement.** `readClean(raw)` field by field (as `readTalk`); `VoiceFile.clean`; `status` carries it; `voicePatch` accepts `clean` through `parseCleanPatch`.
- [ ] **Step 4: Run** the same command — PASS.

### Task 3: The cleaner

**Files:**
- Create: `backend/src/core/voice/cleaner.ts`
- Test: `backend/tests/core/cleaner.test.ts`

**Interfaces:**
- Consumes `stripFillers`, `VoiceClean`, `VoiceCleanMode`, and `OPENROUTER_ORIGIN` from `transcriber.ts`.
- Produces `CLEAN_MODEL = 'anthropic/claude-haiku-5.5'`, `CLEAN_TIMEOUT_MS = 20_000`, `CLEAN_SYSTEM` (the live-check prompt, `scratchpad/system.txt`, as a constant), `interface Cleaner { rewrite(text: string, signal?: AbortSignal): Promise<string | null> }`, `createCleaner(d: { key(): Promise<string | null>; origin?: string; fetch?: typeof fetch; timeoutMs?: number; log?(l: string): void }): Cleaner`, and `cleanTranscript(text: string, o: { switches: VoiceClean; mode: VoiceCleanMode; cleaner: Pick<Cleaner, 'rewrite'>; signal?: AbortSignal }): Promise<string>`.

- [ ] **Step 1: Failing tests** (fake fetch, as `transcriber.test.ts` does):
  - `rewrite` posts to `${origin}/api/v1/chat/completions` with `model: CLEAN_MODEL`, `temperature: 0`, `provider: {zdr: true}`, a system message equal to `CLEAN_SYSTEM`, and a user message `<transcript>\n…\n</transcript>`; returns the trimmed `choices[0].message.content`.
  - null, with one log line holding the status and length but never the text, for: no key (no request), HTTP 500, non-JSON body, no content, a timeout (`timeoutMs: 5`).
  - null for a suspicious answer: empty, longer than `input.length * 1.5 + 40`, or containing `<transcript`/`</transcript>`.
  - a caller abort → null and no log.
  - `cleanTranscript`: both off → text unchanged and no rewrite call; fillers only → `stripFillers`; rewrite on → the filter, then the rewrite of the filtered text; rewrite on with `mode: 'light'` → filtered, no call; with 3 words or fewer after the filter → no call; a rewrite answering null → the filtered text.
- [ ] **Step 2: Run** `npx vitest run backend/tests/core/cleaner.test.ts` — FAIL.
- [ ] **Step 3: Implement** with the transcriber's shape: `AbortSignal.any([signal, timeout])`, `res.text()` then `JSON.parse`, `max_tokens: 4096`, an error body cancelled, never read.
- [ ] **Step 4: Run** the same command — PASS.

### Task 4: Route and wiring

**Files:**
- Modify: `backend/src/http/voice.ts` (`VoiceRoute`, `handleTranscribe`), `backend/src/app.ts:232,1233`
- Test: `backend/tests/http/voice.test.ts`

**Interfaces:** `VoiceRoute` gains `clean(): Promise<VoiceClean>` and `cleaner: Pick<Cleaner, 'rewrite'>`. `app.ts` builds `createCleaner({key: () => voiceStore.key(), origin: <the same test origin>, log})` and passes `clean: () => voiceStore.clean()`.

- [ ] **Step 1: Failing tests** (the `start` helper defaults to `clean: async () => DEFAULT_CLEAN` and a cleaner fake that records calls): with both off, `'Um, hello there friend'` comes back unchanged; with `fillers` on → `'Hello there friend'`; with `rewrite` on → the fake's answer, and the fake got the filtered text and the request's signal; header `light` with rewrite on → filtered, no rewrite call; no header → treated as `full`; header `loud` → 400 and no transcription.
- [ ] **Step 2: Run** `npx vitest run backend/tests/http/voice.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Check the header next to the language header (before `on()`); after a successful transcription, `cleanTranscript(out.text, {switches: await v.clean(), mode, cleaner: v.cleaner, signal: abort.signal})`; skip the answer when aborted, as now.
- [ ] **Step 4: Run** the same command, then `npx vitest run --project backend` — PASS.

### Task 5: Frontend

**Files:**
- Modify: `frontend/src/net/voice.ts`, `frontend/src/state/voiceTalk.ts`, `frontend/src/useVoiceTalk.ts:420-445`, `frontend/src/useDictation.ts:255`, `frontend/src/components/VoiceSettings.tsx`
- Test: `frontend/tests/net/voice.test.ts`, `frontend/tests/voiceTalk.test.ts`

**Interfaces:** `transcribeClip(fetchImpl, clip, contentType, lang, clean: VoiceCleanMode, signal, onSignedOut?)` sends `VOICE_CLEAN_HEADER: clean`. The talk effect becomes `{ type: 'transcribe'; run: number; clean: VoiceCleanMode }`.

- [ ] **Step 1: Failing tests.** `transcribeClip` headers include `'X-ZumiBot-Voice-Clean': 'full'` (and `'light'` when asked). The talk machine: `clipDone` while `listening` emits `transcribe` with `clean: 'full'`; while `answering` (a card being answered) with `clean: 'light'`.
- [ ] **Step 2: Run** `npx vitest run frontend/tests/net/voice.test.ts frontend/tests/voiceTalk.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Dictation passes `'full'`; `useVoiceTalk` passes the effect's `clean`. `VoiceSettings` adds, while `status.on`, a "Clean up speech" group (`data-testid="voice-clean"`) with two switches saved like `saveTalk` through `api.voice.set({clean})`: "Remove filler words" (hint: "Cuts uh, um, hmm and اممم from what you say.") and "Fix mistakes with AI" (hint: "Claude Haiku tidies each clip: drops fillers and false starts and keeps only your correction. About a second slower; sent with zero data retention."). The `api.ts` mapping needs no change (it passes the patch through); check.
- [ ] **Step 4: Run** the same command, then `npm test` and `npm run typecheck` — PASS.

### Task 6: Docs

**Files:** `docs/architecture/voice-input.md`, `docs/architecture/voice-conversations.md`, `docs/architecture/data.md`

- [ ] **Step 1:** voice-input.md: the `clean` settings, the filter, the rewrite (model, ZDR, fallback, logs), the header and the 3-word skip. voice-conversations.md: card answers send `light`. data.md: `voice.json` also holds `clean`.
- [ ] **Step 2: Run** `npx vitest run shared/tests/repoDocs.test.ts` — PASS.
