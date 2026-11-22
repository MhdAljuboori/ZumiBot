# Jev decisions: design

Date: 2026-10-30. The user asked to add Jev to ZumiBot for four uses and said to go ahead without questions, so every call below is mine unless marked otherwise.

## What Jev is

Jev (TypeSafe AI, served through OpenRouter) is a decision model. It writes no text. It answers typed questions about a `state`:

- `noul`: is a statement true? Returns the probability of yes.
- `choice`: which of these named options? Returns the winner, a probability for each option and a confidence.
- `score`: where on an ordered scale of 2 to 10 levels? Returns a weighted position and a probability for each level.

The API is `POST https://openrouter.ai/api/alpha/decisions` with `Authorization: Bearer <OpenRouter key>`, body `{ model, state, questions }`, response `{ id, model, answers, usage }`. Questions in one call are answered independently.

## Why

Some of ZumiBot's decisions are small choices from a known list. Today they cost a `claude -p --model haiku` run (seconds and plan quota) or a full agent turn, or they are not made at all. Jev answers them in one HTTPS call.

## The four uses (user's request)

1. **Webhook routine condition.** A webhook routine can have a condition in plain words ("the CI run failed"). Before a webhook call starts a run, Jev reads the call and says whether the condition holds. If not, the run is recorded as `skipped` and no chat is made.
2. **Group moderator fast path.** Before the Haiku moderator runs, Jev tries to settle the easy cases. When it is not sure, Haiku runs as today.
3. **Approval risk hint.** A pending approval card shows Jev's guess of how risky the tool call is: low, medium or high. It is a hint only.
4. **Agent suggestion.** On the new-chat screen, while no agent is picked, Jev suggests one from what the user typed. One click picks it.

## Rules

- **Jev never approves a tool call.** The risk hint is shown on the card and nothing else reads it. Tool input can carry prompt injection, so a model's opinion must never stand in for the user's click (the same reason ZumiBot never uses `bypassPermissions`).
- **A Jev failure changes nothing.** No key, a network error, a timeout, a bad answer or a low-confidence answer means: the moderator falls back to Haiku, a webhook run starts anyway (the run says the condition was not checked), the card has no hint, no agent is suggested.
- **The key stays on the server.** It never goes to the browser, into logs, URLs or error messages. The UI only learns whether one is set.
- **Off without a key.** With no key, ZumiBot behaves exactly as before.
- **A master switch (user's request).** "Use Jev" turns all of it off at once, key kept. Off, nothing calls Jev: the moderator is Haiku only, every webhook call runs and its condition is ignored (no check recorded on the run), approval cards get no hint, no agent is suggested. The routine editor says a saved condition is ignored while Jev is off.

## Calls I made

- **Where the key lives:** `jev.json` in the data dir, written with mode 0600, next to the three on/off switches. It is set from a dialog in the account menu, so it works in both VPS and Local mode with no env plumbing. Sync copies it with the other data files, so both machines get the same key.
- **Switches:** the master switch and one each for the moderator fast path, approval risk hints and agent suggestions, all on by default, so saving a key is the opt-in. The webhook condition has no switch of its own (it only applies to routines that have one) and follows the master switch. "Test key" calls Jev even while the master switch is off: it sends a fixed sentence, no user data.
- **Model:** pinned to `typesafe/jev-1.14`, like the pinned dependencies. One constant to change.
- **Timeouts:** 8 s for every call. The moderator's Haiku fallback still has its own 30 s.
- **Thresholds:**
  - Webhook condition: runs when p(yes) ≥ 0.5.
  - Moderator: the room must be idle (nobody working, nothing queued) and the message not `@everyone`, and an agent's message must mention nobody. Then Jev's top pick must have probability ≥ 0.85, p("more than one member or a wait") ≤ 0.2, and for an agent's message p("asks the user to decide") either ≤ 0.2 (answer as picked) or ≥ 0.85 (`askUser`). Anything else goes to Haiku. A user's message for which Jev picks "nobody" goes to Haiku, since a user message always gets an answer.
  - Risk: the most likely level, shown only when its probability is ≥ 0.6.
  - Agent suggestion: the top agent's probability must be ≥ 0.6, the text at least 12 characters, and the call debounced 700 ms.
- **What is sent:** the moderator sends the same thread excerpt Haiku gets (last 20 messages, 1500 characters each). The risk hint sends the tool name, input (JSON cut to 4000 characters), description and reason. The webhook condition sends method, query and body (JSON cut to 16000 characters, which keeps it out of Jev's slower long-context mode). The agent suggestion sends the draft text (first 2000 characters) and each agent's name and description.
- **Webhook answer:** still `202`, now with `{ runId, skipped: true }` when the condition did not hold.
- **"Run now"** on a webhook routine ignores the condition: the user asked for that run.
- **Check before the run cap:** the condition is checked before the run takes one of the routine's five start slots, so a slow check never makes other calls fail with "Too many runs".
- **Skipped history:** of the 50 runs kept per routine, at most 10 are skipped ones, so a noisy webhook does not push out the real runs.

## Not in scope

- Jev writing anything (titles, notes, summaries).
- Replacing the Haiku moderator.
- Auto-approving or auto-denying tool calls.
- An env-var way to set the key.
