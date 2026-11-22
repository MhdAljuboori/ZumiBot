# Voice conversations — design

Date: 2026-11-13. Status: draft for approval.

## Intent

Talk to ZumiBot agents hands-free, as with a voice assistant, and hear the answer back.

The example: say *"Ask Work Assistant to set a meeting with Obada tomorrow after 3pm"*. ZumiBot sends it to the `work-assistant` agent, the agent does the job (calendar lookups, then creating the event), and the answer is **spoken back**. ZumiBot then **keeps listening**, so the user can carry on ("make it 4 instead") the way they would with a person. It is a back-and-forth, not one command.

Two places, both decided by the user:

- **Desk:** a global hotkey on the desktop app opens the island, which starts listening.
- **Phone:** the installed web app (Android, Chrome PWA), **with the screen on**. A locked-screen or driving mode is a later project (see Non-goals).

Languages: **English and Arabic**, including dialect (the user's own choice).

## Goals

1. Start a voice conversation with one action: the hotkey on the desk, one tap (or the app-icon shortcut) on the phone.
2. Pick the agent from what the user says ("Ask Work Assistant to …", "اسأل مساعد العمل …"); with no agent named, a default agent (Work Assistant to start, changeable).
3. Each voice conversation is a new, normal ZumiBot chat with that agent, so it can be read and continued on screen later.
4. The agent's answer is spoken: one or two plain sentences, in the language the user spoke. Details (tables, links, long lists) stay on screen in the chat.
5. After speaking, it listens again; follow-ups go to the same chat.
6. **Anything that creates, sends or deletes asks out loud first** (the user's rule): approval cards are read aloud and answered by voice. Agent questions (`AskUserQuestion`) are read aloud with numbered options and answered by voice.
7. Works in English and Arabic for input, spoken output, yes/no answers and agent names.

## Non-goals

- Phone with the screen locked, driving, wake word ("Hey ZumiBot"), Android Auto. Needs a native Android app (phone default-assistant role); a later project that can reuse this one's pure modules.
- Alexa, Google Assistant, Siri, Tasker or any outside caller. No new public API, no MCP endpoint, no new auth.
- Group rooms by voice. Voice targets single-agent chats only.
- Plan cards by voice (too long to listen to): voice says "Plan ready, check your screen" and waits.
- Switching agents mid-conversation. A conversation stays with the agent it started with; to talk to another, end and start again.
- Choosing among many TTS voices, or a voice per agent. One voice for now.

## Anti-goals (a failure even if it "works")

- **A misheard "yes" allowing an action.** An unclear answer is never treated as yes.
- **Voice saving a permanent rule.** Voice never offers or performs Allow for this chat / Allow always for this agent; only Allow once or Deny. Rules stay a screen action.
- Audio, transcripts, spoken text or the key reaching logs, URLs, errors, or disk (the voice-input rule, kept).
- A voice reply that reads out markdown syntax, URLs or tables.
- Voice mode changing how normal typed chats behave.

## Constraints (from the project)

- Voice input already exists (`core/voice/`, `useDictation.ts`, `state/dictation.ts`; see `docs/architecture/voice-input.md`): MediaRecorder → `POST /api/voice/transcribe` → OpenRouter `elevenlabs/scribe-v2` with zero data retention. Clip cap 8 MB, 2 at once, 30 a minute. Same key, same gate, same privacy rules apply here.
- Chrome stops the mic when the page is hidden or the screen locks; dictation already stops then. Voice mode must keep the screen awake (Screen Wake Lock API) while a conversation runs.
- Frontend tests cover only pure modules in `src/state/` and `src/net/` (no DOM tests): keep decisions in pure modules, hooks do I/O only.
- The island is a server-served page (`/island`, `IslandView.tsx`) in a second shell window; the shell allows the mic for the connected origin when only audio is asked (`navigation.ts`). Shell on Linux X11, where Electron `globalShortcut` works.
- Approvals already have RPCs: `chats.answer(chatId, requestId, 'allow-once' | 'deny', agent?)`, `chats.answerQuestions(...)`. Card text helpers exist: `shared/src/toolSummary.ts`, `state/toolLabel.ts`.
- The only loose agent-name match (file name or display name) is the backend's `agentResolver` (`backend/src/core/automations/agentNames.ts`); it throws on a miss and refuses Zumi Bot. `frontend/src/state/agentNames.ts` has no loose matcher (exact handles only).
- Per-turn instructions go through `--append-system-prompt`. It is built in `chatService.ts` and again for side questions and keep-warm in `app.ts` (`sideFirstPart`). It must stay the same across a chat's turns so the prompt cache holds.
- **Production runs `--permission-mode auto`** (`app.ts`, manual is a dev hook only). In auto mode the CLI lets most tool calls through with **no card**, and ZumiBot's saved "Allow for this chat / always for this agent" rules answer the cards that do appear. Forcing a card takes explicit `ask` rules passed through `--settings`; computer use does this (`DESKTOP_ASK_SETTINGS`, `core/desktop/desktopIpc.ts`). Codex agents have no way to force a card for an MCP tool.
- On the desk the island is shown without focus and never takes it, and presence counts a chat as looked at only when its window has focus (`isLooking`, `state/notifications.ts`). With no agent picked for the island, the shell makes no island window at all (`islandWanted`, `zumi-bot-desktop/src/main/island.ts`).
- OpenRouter has text-to-speech at `POST /api/v1/audio/speech` (OpenAI Audio Speech format, raw audio back, priced per character). Same key as transcription.
- Never add `--dangerously-skip-permissions` or bypass modes. Voice answers cards through the same path as the buttons.

## Approaches

Three were considered:

- **A. Voice mode in the app (chosen).** The phone page and the desktop island run voice mode in the browser. They reuse dictation's recording and transcription, send through the normal `chats.send`, watch the chat's items for the reply and cards, speak through one new server TTS route, and answer cards through the existing RPCs. The server barely changes. Trade-off: a later native Android app can't reuse the browser hooks as-is (it can reuse the pure modules' logic).
- **B. Server-side voice API.** A server service runs the whole conversation (audio in → route → turn → narration → TTS out); clients only record and play. Ready for native apps and outside callers. Trade-off: about twice the work, new per-conversation server state, and the server turning a spoken "yes" into an Allow is a new sensitive path.
- **C. MCP from another voice app** (for example the Claude mobile app calling a ZumiBot MCP server). Dropped: a second AI would sit between the user and their approvals and could answer "allow" itself, breaking the ask-out-loud rule. It also needs a public, OAuth-protected MCP endpoint.

**User picked A.** Reason: both surfaces are browser pages that are already signed in. A reuses the most and adds the least new risk. B can be built later from A's pure modules if the native app happens.

## Design

### The conversation loop

A pure state machine (`frontend/src/state/voiceTalk.ts`, my naming), driven by a hook (`useVoiceTalk.ts`) that does only I/O:

```
idle → listening → transcribing → (routing, first utterance only) → sending → waiting
waiting → speaking (reply)  → listening
waiting → speaking (card)   → listening for answer → answering → waiting
listening → (silence timeout, "that's all" / "خلص", stop tap) → ended
any → error → speaking ("Something went wrong, check the chat") → ended
```

- **Listening** reuses dictation's recorder settings and `/api/voice/transcribe`. New: **end-of-speech detection**. A WebAudio level meter stops a clip after about 1.5 s of quiet following speech. The conversation ends after about 8 s with no speech at all. Clips under 0.6 s are dropped, as dictation does. The thresholds live in the pure module.
- **While speaking**, the mic is off: no barge-in by voice, to avoid hearing itself. A tap stops the speech and starts listening.
- **End words** (English and Arabic: "that's all", "stop", "bye", "خلص", "بس", "شكرا"…) end the conversation when they are the whole utterance. They are never sent to the agent.
- **Wake lock** is held from start to end, and released on end, error or unmount.
- **Presence:** while a conversation runs, the page reports a new `talking` presence for its chat that counts as looking whatever the window's focus, so no push or desktop notification is sent for a reply or card the user is hearing. This is needed because the desk island never has focus. `talking` ends with the conversation. Voice mode also dispatches `zumibot:input`, as dictation does.
- Voice turns are ordinary user messages; they are not `auto`.

### Picking the agent

The pure function `routeUtterance(text, agents, aliases, defaultAgent) → { agent, request } | { unknown: name }`:

- It recognises leading phrases in English ("ask X to …", "tell X to …", "X, …") and Arabic ("اسأل X …", "قل لـ X …", "خلي X …"). X is matched loosely against agent file names and display names, and against **spoken aliases** the user sets per agent in Settings, for example `مساعد العمل → work-assistant`. Aliases matter because Scribe may write an English agent name in Arabic script when spoken in Arabic.
- When no leading phrase is found, everything goes to the default agent.
- A phrase naming an unknown agent gets the spoken reply "I don't know an agent called X" and listening resumes. Nothing is sent.
- Only the first utterance is routed. Follow-ups go to the same chat unchanged.
- The loose matching moves out of the backend's `agentResolver` into a pure `shared/src/` function that returns a result instead of throwing. The resolver and the voice router both use it.
- **Codex agents are refused** by voice ("X runs on Codex, so voice can't ask you before it acts"), because a card can't be forced for them. The same goes for Zumi Bot and broken agents.

### The chat

- The first routed utterance creates a new single chat (`chats.create(agent, cwd)`). It uses the folder the agent last used, as the new-chat screen does.
- The chat is marked `voice: true` (a new optional `ChatMeta` field) and titled `Voice · <date>`. The sidebar shows a small mic mark.
- Every turn of a voice chat gets one fixed extra system paragraph, the **voice paragraph**. It is fixed so the cache prefix holds. It says: your reply is read aloud. Start with one or two short, plain sentences that answer the user, in the language they used, with no markdown, links or lists in those sentences. Put any detail after a blank line; it stays on screen. The paragraph does **not** ask the agent to confirm in text before acting: the forced cards do that (see Forcing the ask), and a typed-out "yes" would skip `parseYesNo`. It goes in both places the system prompt is built (`chatService.ts` and `app.ts`'s `sideFirstPart`), so `/btw` and keep-warm in a voice chat keep the cache.
- If the user later types in that chat on screen, the paragraph still applies. That's acceptable: the reply still has its detail after the first paragraph.

### What gets spoken

- **Reply:** the pure function `speakableLead(markdown)` takes the first paragraph of the turn's final assistant message, strips markdown, URLs and emoji, caps it at about 400 characters, and returns `null` when nothing speakable is left. When it is null, voice says "Done, details are on your screen."
- **Approval card:** the pure function `narrateApproval(item, agentDisplayName)` produces, for example, "Work Assistant wants to create the event 'Meeting with Obada', Friday at 3:30 pm. Allow?" It is built from `toolSummary` / `toolLabel` plus a few well-known input fields (title or summary or subject, start time, recipients), in the user's language. Cards are read one at a time, oldest first.
- **Question card:** reads the question, then "Option 1: …, option 2: …", and says the user can answer with a number, an option's name, or their own words.
- **Plan card:** "Plan ready, check your screen." Listening stays paused until the card is answered on screen.
- **Error item:** "Something went wrong, check the chat," then the conversation ends.

### Answering by voice

- The pure function `parseYesNo(text) → 'yes' | 'no' | 'unclear'`. Yes words in English and Arabic, dialect included (yes, yeah, allow, go ahead, do it, sure / نعم، أيوه، اي، تمام، ماشي، اوكي، موافق). No words (no, don't, stop, cancel, deny / لا، لأ، مو، بلاش، الغي). Anything mixed, negated ("don't do it") or other is `unclear`. A yes needs the whole utterance to be a yes phrase; "yes but at 4" is `unclear`, and the agent is told nothing.
- `yes` → `chats.answer(chatId, requestId, 'allow-once', agent)`. `no` → `'deny'`.
- `unclear` → ask once more ("Sorry, allow or not?"). Unclear a second time → "I'll leave it on your screen." The card stays pending and voice waits for it to be answered on screen.
- **Never** `allow-chat` or `allow-agent` by voice.
- Questions: `parseChoice(text, options)` matches a number word (English and Arabic, digits included) or an option label loosely. Anything else becomes the free-text "other" answer. The answer goes through `chats.answerQuestions`. Multi-question cards are read and answered one question at a time.

### Forcing the ask

In auto mode most actions run with no card, and saved rules answer the cards that do come up (see Constraints). So voice chats force a card for every action that changes something. **The user picked "any change, decided by name"** over a fixed tool list.

- **Which calls:** the pure function `voiceConfirms(toolName, input): boolean` (`shared/src/`), with one word table and tests.
  - **MCP tools** (`mcp__<server>__<tool>`): the tool part is split into words (on `_`, `-`, camelCase). It asks when any word is a change verb. The user's list: create, update, send, reply, forward, delete, cancel, post, schedule, move. The obvious synonyms are added in the same table (edit, modify, patch, add, remove, trash, archive, share, invite, respond, upload, publish, approve…).
  - **Bash:** asks when the command runs the Workiom CLI with a change subcommand, when any word of the command is a change verb (`gh pr create`, `curl -X POST`), or when it uses `rm`/`mv`.
  - **File writes** (`Write`, `Edit`, `NotebookEdit`) ask, except inside the agent's own memory folder.
  - **ZumiBot's own bridges** (`mcp__zumibot_*`: to-dos, asks, automations, vault) are left out. They are ZumiBot-internal, and vault and automation deletes already have their own cards.
  - Everything else (reads, searches, lookups) runs as it does today.
- **How:** a `PreToolUse` hook on voice chats' turns returns `ask` when `voiceConfirms` is true. Hook plumbing already exists: `pauseHook.ts`, `vaultGuard.ts`, `agentRunConfig.ts`. A hook can read the input, which a `--settings` ask rule can't do for Bash. The builder confirms with an e2e probe that a hook's `ask` in auto mode reaches ZumiBot as a stdio permission request, the way `DESKTOP_ASK_SETTINGS` cards do. If it doesn't, the fallback is per-chat `--settings` ask rules for MCP tools plus `Bash(workiom <verb>:*)` prefixes.
- **Saved rules don't apply (my call, not objected to):** in a voice chat, a card that `voiceConfirms` forced is never answered by a saved "Allow for this chat / always for this agent" rule, nor by auto-allow. It always waits for the user, like the existing `askEveryTime` path for `confirmOnly` tools. Reason: with voice, a misheard name or time is more likely, so the extra yes is worth it.
- **Scope:** only chats marked `voice: true`. The guard stays on for later typed turns in that chat; those cards just show on screen as usual. Typed chats are untouched.
- **Codex:** can't force a card, so Codex agents are refused by voice (see Picking the agent).

### Speaking (server)

- New route `POST /api/voice/speak` in `http/voice.ts`, behind the gate like every route. Body `{ text }`, at most 1,000 characters. It returns mp3 bytes (OpenRouter's speech endpoint offers `mp3` or `pcm`). It has its own limits, separate from transcription's: 2 at once, 30 a minute.
- `core/voice/speaker.ts` calls OpenRouter `/api/v1/audio/speech` with one pinned multilingual model and voice that handle Arabic and English. It sends `provider: { zdr: true }`, as the transcriber does. If no zero-retention provider serves the model, it fails rather than falling back.
- Text and audio are held in memory only and are never logged. A failure log has the status and the text length.
- An upstream answer that isn't audio is a plain 502 `upstream`.
- **Fallback:** if `/api/voice/speak` fails, the client speaks with the browser's `speechSynthesis` when a voice for that language exists. Otherwise it shows the text and plays a short tone.

### Starting it

- **Desk:** the shell registers a global shortcut (default `Ctrl+Alt+Space`, set in **Settings › Island**). Pressing it opens the island popup in voice mode and starts listening; pressing it again ends the conversation. The shell sends a `startVoice` event over the island bridge (a new optional `IslandBridge` member, so older pages ignore it). If the shortcut can't be registered (taken by another app), Settings says so. The hotkey works even with no agent picked for the island: the shell then makes the island window on demand, shows only the voice popup (no strip), and drops the window when the conversation ends. The voice popup can show any agent's voice chat, picked or not; the strip still shows only picked agents. The island still never takes focus (see Presence).
- **Phone:** a mic button in the top bar opens a full-screen voice view (`/voice`). It shows big status text (Listening / Thinking / Speaking), the live transcript of each turn, a Stop button, and a link to the chat. The web app manifest gets a `shortcuts` entry, "Talk", pointing to `/voice?start=1`, so a long-press on the app icon starts listening at once. If Chrome blocks sound until a tap, the first screen shows "Tap to start."
- Both places run the same `useVoiceTalk` hook and pure modules.

### Settings

**Settings › Voice input** gets a "Voice conversations" part:

- on/off (needs voice input on and a key)
- default agent
- spoken aliases (agent → phrase list)
- the desk hotkey, shown in the Island section

Stored in `voice.json` next to `{enabled, key}`: `talk: { enabled, defaultAgent, aliases }`. The hotkey lives in the shell's `island.json`. `voice:changed` is broadcast as today.

### Cost and limits

- TTS is billed per character. Speaking only the first paragraph (≤ about 400 characters) keeps it small.
- Transcription is billed per clip, as today.
- The existing usage page doesn't track OpenRouter voice spend; that stays as is.

## Decided by the user

- Surfaces: desk hotkey + phone with screen on; locked screen later.
- Approvals and questions: asked out loud before anything is created, sent or deleted.
- Languages: English and Arabic.
- Approach A: voice mode in the app.
- Which actions ask: any change, decided by the action's name (not a fixed list).

## My calls (stated in the conversation, not objected to)

- Each voice conversation is a new chat titled `Voice · <date>`.
- With no agent named, Work Assistant is the default (changeable).
- The spoken reply is one or two sentences; detail stays on screen.
- The loop ends on an end word, about 8 s of silence, or Stop.
- Voice never offers "always allow".
- Plan cards are not read aloud.
- Spoken output uses OpenRouter TTS with the existing key, with the browser voice as a fallback.
- In voice chats, forced cards ignore saved "Allow always" rules.

## My calls (new in this doc, check them)

- Spoken aliases per agent, for Arabic and misheard names.
- A conversation stays with one agent; there's no mid-conversation switching.
- No barge-in by voice; tap to interrupt.
- `Ctrl+Alt+Space` as the default desk hotkey.
- A fixed voice paragraph on voice chats (chosen over a separate model summarising the reply: no extra call, no extra latency).
- Screen wake lock while a conversation runs on the phone.
- The `/voice` page and the "Talk" app-icon shortcut.
- A `talking` presence that counts as looking, instead of letting the island take focus.
- The desk hotkey works with no agent picked for the island; the voice popup shows any agent.
- Codex agents are refused by voice.
- TTS has its own limits: 2 at once, 30 a minute, mp3.
- The synonyms added to the change-verb list, Bash `rm`/`mv`, file writes asking except in the agent's memory folder, and ZumiBot's own bridges left out.
- A `PreToolUse` hook as the way to force cards, with `--settings` ask rules as the fallback.

## Left to the builder

- The exact TTS model and voice (multilingual, Arabic-capable, available with zero data retention), and the audio format.
- End-of-speech thresholds, tuned by trying them.
- The exact English and Arabic word lists for yes/no, end words, routing phrases and number words. Keep them in one shared table with tests.
- Which input fields `narrateApproval` reads for the user's common tools (the calendar create and update tools, sending email, sending a Slack message).
- UI details of the `/voice` view and the island's voice state.
- Docs: a new `docs/architecture/voice-conversations.md` (or extending `voice-input.md`), an index line in `CLAUDE.md`, and `data.md` for the `voice.json` change.
