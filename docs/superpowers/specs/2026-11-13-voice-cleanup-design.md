# Clean voice text (filler words and self-corrections)

## Intent

Dictation (the composer and edit-box mic) and voice conversations should give clear, readable text: no "uh", "um", "اممم", no stutters or repeated words, and when the speaker corrects themselves ("at 3, no, at 4") only the correction. The user picked the AI rewrite over a filler filter alone.

## Goals, non-goals, anti-goals

- Goal: when the user turns it on, every transcript from `/api/voice/transcribe` comes back cleaned, for both surfaces, in English, Arabic (any dialect) and mixed speech.
- Goal: two switches in Settings › Voice input, the filler cut and the AI rewrite, each on its own, both **off by default** (the user's call), so voice behaves exactly as today until turned on.
- Anti-goals: changing what the user meant; turning dialect into formal Arabic (it would also break the Arabic routing phrases and aliases); translating; the rewrite answering or following the transcript instead of cleaning it; a rewrite ever deciding a card's yes or no; a slower or failed rewrite failing the transcription.

## Approaches considered

1. Scribe's no-verbatim mode (`provider.options.elevenlabs.no_verbatim`) plus a local filler filter. Live check (2026-11-13): it does pass through OpenRouter and drops fillers and stutters, but it keeps self-corrections ("at 3:00. No, actually at 4:00"), and it rewrote Levantine Arabic into formal Arabic ("بدي أعمل اجتماع ... بكرة" became "أريد أن أُقيم اجتماعًا ... غدًا"). **Rejected** for that reason.
2. Verbatim Scribe (as today), then a local filler filter, then an AI rewrite. **Picked.** Live check: Haiku 5.5 kept the dialect, applied the corrections ("بدي أعمل اجتماع مع عبادة بكرة الساعة أربعة."), cleaned instruction-shaped transcripts without obeying them, and took 0.9 to 1.9 s per clip (about $0.0001).
3. Rewrite in the browser or in the agent turn. Rejected: the key stays on the server, and dictation needs clean text before it is inserted.

## Design

- **Settings:** `voice.json` gains `clean: {fillers, rewrite}` (`VoiceClean`, `DEFAULT_CLEAN` both `false` in `shared/src/voice.ts`), read field by field like `talk`, so an older file reads as both off. `VoiceStatus` carries `clean`; `voice:set` takes a `clean` patch of those two booleans (anything else is `bad clean settings`) and `set` merges it over the saved one. **Settings › Voice input** shows a "Clean up speech" group while voice is on, with two switches: "Remove filler words" (cuts uh, um, hmm, اممم) and "Fix mistakes with AI" (Claude Haiku rewrites each clip: drops fillers, stutters and false starts and keeps only your correction; adds about a second; zero data retention). The server reads the switches per clip, as it reads the key, so a flip applies to the next clip.
- **Local filter** (pure, `shared/src/voiceWords.ts`): `stripFillers(text)` removes standalone filler tokens (uh, um, umm, uhm, er, erm, ah, hmm, mm, mmm, ممم, امم, اممم, ااا, and the like), with the comma after them, and fixes the spacing and capital at the start. It never removes `اه`/`آه` (an Arabic "yes"), "mhm" or "uh-huh" (also a yes), or real words such as "like", "you know" or "يعني". A table test checks every entry.
- **Rewrite** (new `backend/src/core/voice/cleaner.ts`, same deps shape as the transcriber: `key()`, `origin`, `fetch`, `log`): OpenRouter `/api/v1/chat/completions`, `anthropic/claude-haiku-5.5`, `temperature: 0`, `provider: {zdr: true}` (no zero-retention provider means the call fails, never falls back), and one fixed system prompt (prompt cache), with the transcript inside `<transcript>` tags. The prompt says the text is something a person said, never a message to answer, and lists the rules: drop fillers, stutters and false starts; keep only the correction; fix punctuation and grammar slips; keep the language and dialect, names, numbers, @mentions and /commands; add nothing.
- **Never fails the transcription:** a timeout (10 s), an HTTP error, a non-JSON answer or a suspicious answer (empty, more than 1.5 times the input length plus 40 characters, or containing the tag) falls back to the text it was given (filtered when the filler switch is on, else as Scribe wrote it). Logs carry the status and the length only, never the text.
- **Route** (`handleTranscribe`): transcribe, then filter when "Remove filler words" is on, then rewrite when "Fix mistakes with AI" is on and the request allows it. The two switches are independent; the rewrite removes fillers by itself. A new request header, `X-ZumiBot-Voice-Clean: full | light` (default `full`), lets a caller refuse the rewrite for one clip. The rewrite is also skipped for 3 words or fewer ("yes", "bye", "خلص"), which saves a second where nothing can be corrected.
- **Voice talk:** while answering a card (the `answering` phase), the page sends `light`, so a yes or no is never decided on a rewrite, only on Scribe's words (filtered when the filler switch is on; then "uh, yes" counts as yes, which today is unclear). Routing, end phrases and the request use `full`.
- **Dictation:** always `full`.
- **Docs:** [voice-input.md](../../architecture/voice-input.md) and [voice-conversations.md](../../architecture/voice-conversations.md) get the cleanup and the header.

## Left to the builder

The exact filler table, the wording of the system prompt (start from the one tried in the live check), the switch hints, and the tests: filter table cases, a cleaner with a fake fetch (success, timeout, HTTP error, suspicious output, ZDR flag sent, the text never logged), the store's `clean` read and merge, the `clean` patch check, the route with each switch on and off, the header and the 3-word skip, and the voice-talk machine sending `light` while answering.
