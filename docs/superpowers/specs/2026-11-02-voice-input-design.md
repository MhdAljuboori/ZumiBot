# Voice input (dictation): design

Date: 2026-11-02. Built from the user's written request and a short talk. What the user decided is marked **(user)**; everything else is my call and can be changed.

## Why

The phone layout exists, but the composer has no mic, so on a phone the on-screen keyboard is the only way to write a message. Long prompts (a bug description, a card link plus context) are slow to thumb-type. The user wants to speak, review the text, and press Send.

## What was checked first

- **Code.** `Composer.tsx` (Tiptap): `.composer-box` holds `attach-btn`, `composer-field` (with the `@` and `/` menus) and `send-btn`. The message edit box (`MessageEditor.tsx`) is a plain `<textarea>` with its own `/` logic (`textSlashQuery`), not Tiptap. The CSP has `connect-src 'self'`; no `Permissions-Policy` header is sent. The desktop shell's `isPermissionAllowed` (`navigation.ts`) lets through only `clipboard-sanitized-write`; desktop notifications go through the bridge, not a web permission. Presence counts only `keydown`, `pointerdown`, `touchstart` and `wheel` as input (`useNotifications.ts`). The composer has no bidi handling: Arabic shows with an LTR base direction. No speech, mic or voice code existed.
- **Browser speech engines (Web Speech API), tested on this PC with a fake mic.** Chrome 156: `SpeechRecognition` works, through Google's servers (on-device mode is "downloadable" for en-US). Electron 45 (same Chromium): the object exists and `available()` says yes, but `start()` ends in `error: network`; on-device is `unavailable`. So the shell gets nothing from it. Firefox: none. Safari: `webkitSpeechRecognition`, audio to Apple, and not available at all in iOS home-screen web apps (WebKit bug 225298, closed RESOLVED LATER).
- **Hosted transcription.** OpenRouter has `POST /api/v1/audio/transcriptions` (JSON with base64 audio, or multipart), returns `{ text, usage: { seconds, cost, … } }`, accepts `wav mp3 flac m4a ogg webm aac`, caps multipart at 25 MB, and upstream providers time out after 60 s. `provider: { zdr: true }` routes only to zero-data-retention endpoints. OpenAI's own endpoints are excluded from ZDR, so `openai/gpt-4o-transcribe` (OpenAI only) can't be used with it. `elevenlabs/scribe-v2` has a ZDR endpoint, at about $0.22 per hour of audio.

## Goals

1. **A mic button in the composer and in the message edit box, on every layout and in the desktop shell (user).** Tap to start, tap to stop (user).
2. **Speech becomes text on the server, through a hosted model (user):** the browser records, the ZumiBot server sends the clip to OpenRouter and returns the text. One path for every browser and the shell.
3. **English and Arabic (user),** with a small Auto / EN / AR toggle, remembered per device (user).
4. **Arabic reads right:** every paragraph takes its direction from its first letter, in the composer, the edit box and the chat bubbles (user).

## Non-goals

- Live text while speaking. The text appears after the clip is transcribed (usually 1–5 s).
- Transcribing on the VPS or PC itself (whisper.cpp or similar).
- The browser's own speech engine, as a main path or a fallback.
- Hold-to-talk, slide-to-cancel, voice commands ("send it"), translation, playing the clip back.
- Voice in routines, webhooks or anywhere outside the two text boxes.
- Showing transcription cost on the Usage page. OpenRouter's dashboard has it; it can be added later from `usage.cost`.
- Choosing the model in the UI. It is pinned in code, like `JEV_MODEL`.

## Anti-goals

- **Recording without a visible indicator, or starting without a user tap (user).**
- **Dictation sending a message on its own (user).** The one send in this feature is the Send the user pressed while dictation was still running; it waits for the text (see "Send while dictating").
- **Audio stored on disk, logged, or kept after transcription (user).** On the server the clip lives in memory for one request and is never written to a file. Upstream, only zero-data-retention endpoints are used (user).
- **The key in logs, URLs, error messages or the UI (user).**
- **The shell's page getting camera access or any device beyond audio capture, or audio capture for any origin but the connected server (user).**
- **Loosening the CSP without a written reason (user).** None is needed; see "Security".
- **A dead mic button.** Where dictation can't work, there is no button at all (user).

## Decided with the user

- Speech becomes text through a **hosted API**, not local whisper.cpp and not the browser's engine. The user's phone is Android Chrome.
- Model: **`elevenlabs/scribe-v2` through OpenRouter with `zdr: true`**. The user first picked `gpt-4o-transcribe`; after hearing it can't run with zero retention, they switched to Scribe.
- Languages English and Arabic, with a small **Auto / EN / AR** toggle remembered per device.
- **A separate mic button beside Send** (not Send turning into a mic).
- **Everywhere:** composer on phones, composer in desktop browsers, composer in the desktop shell, and the message edit box.
- **Tap to start, tap to stop.**
- **Send while dictating:** pressing Send while recording or transcribing stops the recording, shows loading on the mic until the transcript is in, then sends the message at once.
- **RTL fix** in the composer, the edit box and the chat bubbles.
- The behavior table and list below were played back and approved.

## The mic button

- **Composer:** a round button between `composer-field` and `send-btn`, the same size as `attach-btn`. Order: attach, field, mic, send.
- **Edit box:** at the start of the `msg-edit-btns` row, before Cancel and Send.
- **States:**
  - idle: mic icon, `aria-label="Start dictation"`, `aria-pressed="false"`.
  - starting (waiting for the mic or the browser's permission prompt): mic icon, dimmed pulse.
  - listening: red, pulsing, stop square inside, `aria-label="Stop dictation"`, `aria-pressed="true"`.
  - transcribing: spinner, `aria-label="Cancel dictation"`. A tap cancels: the audio and the request are dropped.
- Disabled (not hidden) while the box itself is disabled (`claudeFound` false), like `attach-btn`.
- **Only one dictation at a time** in the page. Starting one in the composer or an edit box drops any other one, as "Chat switch" below does.

## The status strip

While a dictation is not idle, a one-line strip sits above the box, in the place and style of `attach-error` and the reply strip (above both, so the order is: attachments, voice strip, error, reply strip, box):

- listening: `● Listening 0:07 · Auto`. The time counts up.
- transcribing: `Transcribing…`. With a pending Send: `Transcribing, then sending…`.
- The language chip (`Auto`, `EN`, `AR`) is a button: each tap cycles Auto → EN → AR. The choice is stored in `localStorage` (`zumibot.voiceLang`, read and written in try/catch) and is sent with the clip at stop, so it can be changed while recording. The chip is in the strip only, so it needs no space in the phone row.
- A visually hidden live region (`role="status"`, `aria-live="polite"`) announces: "Listening", "Transcribing", "Dictation added", "Dictation cancelled".

## Behavior

The state machine is pure (`frontend/src/state/dictation.ts`), with states **idle → starting → listening → transcribing → idle**, plus **error** (shows a message; the next tap starts again). The component only feeds it events and carries out the effects it returns (start the recorder, release the mic, upload, abort, insert, send, announce).

### Why it stops (user, approved)

| Recording stops because | Audio | Text |
|---|---|---|
| The user taps the mic again | transcribed | inserted |
| 5-minute cap reached | transcribed | inserted, and the strip notes "Stopped at 5:00" for a few seconds |
| Page hidden (app switch, screen off, window minimized) | transcribed | inserted; it is there when the user comes back |
| Send pressed | transcribed | inserted, then the message is sent (see below) |
| Chat switch, new-chat screen left, or the edit box closes | dropped, request aborted | nothing |
| Error (mic blocked, no mic, upload or upstream failure) | dropped | an error line |

- **The mic is released at every stop,** before the upload: every track of the stream is stopped, so the phone's and browser's recording indicators go off at once.
- **A screen wake lock** (`navigator.wakeLock.request('screen')`) is held while listening, so a phone doesn't sleep mid-sentence. Released at stop. Ignored where unsupported or refused.
- A clip shorter than 0.6 s is not uploaded; it ends as "Didn't catch anything".
- Tapping the mic during **starting** cancels: if the permission prompt is then accepted, the stream is released at once and nothing records.
- **Chat switch is an unmount.** `App.tsx` remounts `ChatView` per chat (`key={openChatMeta.id}`), and the new-chat screen and the edit box unmount when left or closed. Unmounting a box with a dictation in it drops the dictation (release, abort, no insert, no send).
- Pressing the mic doesn't move focus (its `mousedown` is prevented, like the menus'): an open phone keyboard stays open and a closed one stays closed, and on desktop the caret stays in the box.

### Where the text goes

- **At the box's caret when the text arrives,** replacing the selection if there is one. The box stays editable while transcribing, so the user can keep typing; the caret they leave is where the text lands. Tiptap keeps its selection while blurred; the textarea keeps `selectionStart`/`selectionEnd`.
- **Spacing:** a space is added before the text when the character before the caret is not whitespace (and the caret is not at the start of a block or line), and it always ends with one space, even before existing whitespace (a harmless double space), so the caret never sits right after an `@word` or `/name`. A pure function computes this for both boxes.
- **Menus:** the inserted text always ends with whitespace or is followed by it, so no `@word` or `/name` is left right before the caret, and neither menu opens. This holds for both `mentionQuery` and `slashQuery`/`textSlashQuery` as they are today.
- The insert is a normal edit of the box (a Tiptap transaction; `setText` plus the caret in the edit box), so the draft is saved, Up-arrow history sees it like typed text, and attachments, the reply strip and queued tasks are untouched. In the composer the text is inserted as plain text (`insertText`), never parsed as markdown.
- An empty transcript (silence) shows "Didn't catch anything". Nothing is inserted.

### Send while dictating (user)

- **Send (button, Enter, or Ctrl/Cmd+Enter) while listening:** the recording stops, the mic shows its transcribing spinner, the strip says "Transcribing, then sending…", and the send is held. When the text arrives it is inserted, then the box is sent through the normal submit (so the `/` pick, queued tasks and `blockedReason` all apply as for a typed message). Pressing Send while already **transcribing** does the same.
- While a send is held, the Send button is disabled, so a second press can't send twice.
- **A dictation counts as content:** while listening or transcribing the Send/Stop button shows **Send**, not Stop, even with an empty box and a reply running. So pressing it can't stop the agent by accident.
- If the held send can't happen when the text arrives (empty transcript and empty box, an error, `blockedReason`, files still staging, `claudeFound` false), nothing is sent: the text (if any) stays in the box and the error or reason shows as usual. A failed transcription never sends the box without the dictated part.
- Chat switch while a send is held: the dictation is dropped and nothing is sent.

### Presence

Dictation counts as input for notification presence. While listening, and when text is inserted, the composer dispatches a `zumibot:input` event on `window`; `useNotifications` adds it to the events it treats as input. While listening it fires at start and then every 30 s, so a long dictation keeps "looking" alive.

### Errors

Shown in the strip's place, in the `attach-error` style with `role="alert"`, until the next tap or 8 s:

| Cause | Message |
|---|---|
| Permission denied by the browser | "Microphone is blocked. Allow it in the browser's site settings." |
| No mic device | "No microphone found." |
| Silence or clip too short | "Didn't catch anything." |
| Network or server unreachable | "Couldn't reach the server. Try again." |
| Upstream failure, timeout | "Transcription failed. Try again." |
| Too long (413) | "That recording is too long." |
| Voice turned off or key removed meanwhile | "Voice input is off." |
| Rate limited | "Too many recordings. Wait a moment." |

### When there is no mic button

The button is not rendered when:

- the server says voice input is off (no key, or switched off), or
- the page can't record: no `navigator.mediaDevices.getUserMedia`, no `MediaRecorder`, or none of the recorder types below is supported (this also covers plain-HTTP pages, where `mediaDevices` is missing), or
- the page runs in the desktop shell and `navigator.permissions.query({ name: 'microphone' })` answers `denied`. That is an older shell whose permission check refuses the mic. In a browser, `denied` means the user blocked it; the button stays and its tap shows the "blocked" error, since the user can fix that.

## Recording

- `MediaRecorder` on `getUserMedia({ audio: true })` (no `video`), with the first supported type of `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4`, and `audioBitsPerSecond: 32000`. Chunks stay in memory and become one `Blob` at stop.
- Why not WAV: Opus at 32 kbps makes a 5-minute clip about 1.2 MB, where 16 kHz WAV makes 9.6 MB, which matters on mobile data. OpenRouter accepts webm, ogg and m4a as they come, so the server needs no converter.
- **Cap: 5 minutes,** then the recording stops as in the table.

## Server

### `POST /api/voice/transcribe`

- Behind `createGate` (session and `Origin`), next to `/api/attachments/stage` in `http/server.ts`. Only `POST`.
- **Request:** the clip as the raw body. `Content-Type` must be one of `audio/webm`, `audio/ogg`, `audio/mp4` (codec parameters ignored), mapped to OpenRouter's `webm`, `ogg`, `m4a`; anything else is 415. The language comes in the `X-ZumiBot-Voice-Lang` header: `auto`, `en` or `ar` (anything else is 400).
- **Caps:** body at most 8 MB, counted while reading; past it the read stops and the answer is 413. At most 2 transcriptions run at once (a third is 429) and at most 30 a minute (429). An empty body is 400.
- **In memory only.** The body is read into a `Buffer`, sent upstream, and dropped. No temp file, no attachment staging. The transcript is not stored or logged.
- **Upstream call** (JSON, not multipart, because OpenRouter takes the `provider` routing options, and so `zdr`, only in the JSON form): `POST https://openrouter.ai/api/v1/audio/transcriptions`, `Authorization: Bearer <key>`, JSON body `{ model: 'elevenlabs/scribe-v2', input_audio: { data: <base64>, format }, language?: 'en' | 'ar', provider: { zdr: true } }` (`language` left out for Auto). Timeout 60 s (an `AbortController`), aborted too when the client goes away.
- **Response:** 200 `{ text }` (trimmed, possibly empty). Errors are `{ error: <code> }` with 400, 413, 415, 429, `503 off` (voice off or no key), `502 upstream` (OpenRouter answered with an error or a bad body), `504 timeout`. The UI maps codes to the messages above. An upstream error body is never passed through.
- **Logs:** one line per failure with the status and the clip size only. Never the key, the audio, the transcript or the upstream body.
- **Dev hook:** `ZUMIBOT_TEST_VOICE_URL` (read through `devEnv()`, so ignored in production) replaces the OpenRouter URL, for the e2e's fake endpoint. Only an `http://127.0.0.1` URL is accepted, like `ZUMIBOT_TEST_PUSH_ORIGIN`.

### Settings: `voice.json` and **Voice input…**

- `voice.json` in the data dir, written 0600 like `jev.json`: `{ enabled: boolean, key: string | null }`. The key never reaches the UI, logs, URLs or errors. Voice gets its **own** OpenRouter key, not Jev's, so turning Jev off or rotating its key can't break dictation, and OpenRouter can cap each key's spending separately.
- **Account menu → Voice input…**, a dialog in the style of **Jev decisions…**: an on/off switch, the key field (write-only; it shows "Key saved" with Replace and Remove), a **Check key** button, and one line saying "Speech is sent to ElevenLabs Scribe v2 through OpenRouter, with zero data retention. Audio is never stored."
- **Check key** calls `GET https://openrouter.ai/api/v1/key` with the key and reports valid, invalid or unreachable. It costs nothing.
- Voice is **on** only when enabled and a key is saved. A change broadcasts `voice:changed`, so every tab shows or hides its mic at once.
- **Sync:** `voice.json` stays on each machine, like `jev.json` today (`sync.mjs` neither merges nor pushes it). The key is set once on the VPS and once on the PC.

### API

New handlers under `voice:`, arguments checked like every handler, with entries in `ZumiBotApi` and `net/api.ts`:

- `voice:status()` → `{ on: boolean, enabled: boolean, keySaved: boolean }`.
- `voice:set({ enabled?: boolean, key?: string | null })`: `key: null` removes it. Returns the new status.
- `voice:check()` → `{ ok: true } | { ok: false, reason: 'invalid' | 'unreachable' | 'nokey' }`.
- Event `voice:changed` with the status.

The upload is the HTTP route above, not RPC, because it carries binary audio.

## Desktop shell

- `isPermissionAllowed(permission, requestingUrl, origin, mediaTypes?)` (or a sibling function) also allows `media` when the requesting URL is the connected server's origin **and** the requested media types are exactly audio: `details.mediaTypes` non-empty and every entry `'audio'`. Any `'video'` is refused. In the check handler, `media` is allowed only with `details.mediaType === 'audio'` and the same origin.
- Nothing else changes: no camera, no screen capture, no other origin, no `file:` page.
- Unit tests in `tests/navigation.test.ts`: audio from the server allowed; video, audio+video, an empty list, another origin, and `file:` refused; the check handler likewise.
- Older shells refuse the mic in their check handler, so the page hides the button there (see "When there is no mic button"). The shell is updated through the shared version bump, as usual.

## RTL (user)

- Composer: paragraphs, list items, blockquotes and headings in `.composer-input` get `unicode-bidi: plaintext; text-align: start`, so each block takes its direction from its first strong letter.
- Edit box: the `<textarea>` gets `dir="auto"` and `unicode-bidi: plaintext`.
- Chat bubbles: the same rule for paragraphs, list items, blockquotes and headings inside rendered messages (user and agent). Code blocks and inline code stay LTR.
- The e2e checks that an Arabic transcript in an empty box renders right-aligned, and that Arabic dictated into an English line lands at the caret in the right order.

## Security

- **CSP: no change.** `getUserMedia` and `MediaRecorder` aren't governed by CSP; the upload goes to `'self'` (`connect-src 'self'`); OpenRouter is called by the server, not the page. The clip is never played, so no `media-src` is needed.
- **New `Permissions-Policy` header:** `camera=(), microphone=(self), geolocation=()`. It tightens what is allowed today (no header means every feature is allowed to the top page): only the ZumiBot page itself may use the mic, nothing may use the camera or location. It goes into `SECURITY_HEADERS`, with a test.
- The route sits behind the gate, so only a signed-in session from the right origin can spend the key. The rate cap limits what a stolen session could spend.

## Testing

- **Frontend unit tests** (node only, no DOM):
  - `state/dictation.ts`: every transition; each stop reason's effects (transcribe or drop, release first); the 0.6 s minimum; the 5-minute cap; tap during starting; a held send (sent on success, not sent on error, empty or blocked); chat switch during a held send; one dictation at a time; language cycling and its storage fallback.
  - The spacing/insert function: start, middle, end of a line; before and after spaces and newlines; a replaced selection; Arabic in English text; the result never leaves an `@word` or `/name` before the caret (checked with `mentionQuery` and `slashQuery`).
  - The "show the mic?" decision from status, capabilities, shell, and permission state.
  - The error code → message map.
- **Backend tests:**
  - `tests/http/voice.test.ts` on `tests/http/helpers.ts`: gate required (no session, wrong origin); method; 415 for other types; 400 for a bad language or empty body; 413 past 8 MB; 503 when off; 429 for concurrency and rate; the upstream request body (`model`, `format`, `language` only when not Auto, `zdr: true`) and its `Authorization` header, against a fake `fetch`; 502 and 504 mapping; no key, audio or transcript in logged lines; nothing written to the data dir or the temp dir.
  - The voice store: 0600, status, set and remove key, enabled flag; the key absent from every status.
  - `voice:` handlers: argument checks, `voice:changed` broadcast.
  - The dev hook ignored with `NODE_ENV=production`, and only `http://127.0.0.1` accepted.
  - `headers.test.ts`: the `Permissions-Policy` value.
- **Desktop tests:** the permission handler cases above.
- **`e2e:voice`** on `e2e/harness.mjs`, fake claude only, so it costs no quota:
  - Chrome with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` (a real `MediaRecorder` clip of Chrome's test tone), the server with `ZUMIBOT_TEST_VOICE_URL` pointing at a local fake transcription endpoint. The fake records each request (checks model, format, language, `zdr: true`, a non-empty base64 clip) and answers a canned transcript, an error, or after a delay, as the test sets.
  - Voice set on through the RPC with a dummy key. With voice off, there is no mic.
  - Phone viewport (375×812, touch) and desktop viewport.
  - Tap, wait, tap: the strip shows Listening and a running time, then Transcribing; the text lands at the caret; the Send button is still Send; nothing is sent until Send is pressed.
  - Send while listening: the message is sent once the fake answers, with the transcript in it; Send disabled meanwhile.
  - Send with an upstream error: nothing sent, the error shows, the box keeps its text.
  - Chat switch while listening: no request reaches the fake (or it is aborted), no text appears in either chat.
  - Page hidden while listening (CDP `Emulation.setFocusEmulationEnabled` plus a dispatched `visibilitychange`, or `Page.setWebLifecycleState: frozen`): the clip is transcribed and the text is in the box.
  - A transcript starting with `/check` or ending with `@ed` opens neither menu.
  - An Arabic transcript renders right-aligned.
  - Edit box: dictate into an edited message, then Send.
  - Mic released after stop: no live audio track remains (an init script wraps `getUserMedia` and records each track's `readyState`).
  - Permission denied (an init script makes `getUserMedia` reject with `NotAllowedError`): the blocked message shows.
  - The dictated text stays in the chat's draft after leaving the chat and coming back (drafts live in memory per tab, so a reload loses typed and dictated drafts alike).
- `npm test`, `npm run typecheck` and `npm run e2e:voice` pass before the work is called done. Every browser process started is killed (user).
- **Manual check with the real key** (the user enters it in the dialog themselves): one English and one Arabic dictation on the phone and in the shell, to confirm Scribe accepts webm and the ZDR route works.
- **`CLAUDE.md`:** a short "Voice input" paragraph under Architecture, `voice.json` under Data, the dev hook, and `e2e:voice` under Commands (user).

## Left to the builder

- Module layout under `frontend/src/state/`, `frontend/src/components/` (a shared `DictationButton` and hook for both boxes is expected), `backend/src/core/voice/` and `shared/`.
- How the component carries out the state machine's effects (a hook over `MediaRecorder` and `fetch`).
- The exact icons, pulse animation and strip layout within the existing style tokens.
- Exact wording of hints and announcements, within the above.
