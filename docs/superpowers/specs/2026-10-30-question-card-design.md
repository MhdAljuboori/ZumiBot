# Question card (AskUserQuestion)

## Intent

When an agent calls `AskUserQuestion`, the chat shows a raw approval card with the JSON input and the line "Denied". The server denies the request itself (`UNANSWERABLE_TOOLS` in `controlProtocol.ts`), so the agent never gets an answer. The user wants to answer these questions by clicking radio buttons, and the agent should carry on in the same reply with those answers.

## Goals

- Show `AskUserQuestion` requests as an interactive question card in single chats, group rooms and routine runs.
- While answering, show one question at a time (layout "B" from the mockups). After the answers are sent, show all questions at once, read-only (layout "A").
- Send the answers back over the existing stdio permission protocol so the reply continues. No new user message is posted.

## Non-goals

- `ExitPlanMode` stays in `UNANSWERABLE_TOOLS` and is still denied automatically.
- No "remember my answer" for questions. Remembered approvals and "Allow for this chat" do not apply.
- The composer does not change. While a reply runs it shows Stop, as today; the card is the only way to answer.

## Anti-goals

- Never answer for the user. A question card is never auto-allowed, even if `approvals.json` or chat memory holds a rule for `AskUserQuestion` (a test covers this today for the deny path; keep it for the new path).
- Never send an `updatedInput` the CLI refuses. Validate on the server first (see Constraints).

## Behavior the user decided

1. **First question.** The card shows the first question, its header as a tab, and its options as radio buttons. Clicking a radio picks it and moves to the next question.
2. **Tabs.** Answered questions show a check in their tab. Tabs and a **Back** button let the user return and change a pick.
3. **Other.** Every question has an extra **Other** row. Picking it shows a text box; what the user types is the answer.
4. **Last question.** Has a **Send answers** button, enabled only once every question has an answer. Clicking a radio on the last question picks it but does not send.
5. **Skip.** Every step has **Skip**. It closes the whole card and tells the agent the user will not answer. The card then reads "Skipped".
6. **After sending.** The card shows every question with the user's picks highlighted and the other options dimmed, and the line "Answered". The agent continues the same reply.
7. **Stop or server restart** while the card is open: the card ends as "Not answered", the same as approval cards today.
8. The card counts as a pending approval: sidebar dot, pending counts and the routine run's `waiting` status work as they do for approval cards (`chats:push` `approvals`).
9. **Group rooms: an answer counts as the user taking part.** Other members and the moderator see the answers, and answering restarts the room's hop counter (`room.hops`, the "Agents paused after 15 turns without you" cap), as a user message does. Skip does neither. The asking member gets the answers through the tool result as in a single chat.

Mockups: `.superpowers/brainstorm/22110-1793345691/content/answer-card-v2.html` (git-ignored, local only).

## Constraints: the CLI's answer format

Read from the installed CLI (2.1.299). The answer is a normal allow response, `{ behavior: 'allow', updatedInput }`, where `updatedInput` is the original input plus:

- `answers`: an object keyed by the exact `question` text. Each value is a string (at most 8192 chars) or, for `multiSelect` questions only, an array of strings with at most `options.length + 1` entries (each at most 8192 chars).
- Optional `annotations` (per question: `preview` must be one of that question's option previews, `notes` at most 8192 chars), `response`, and `followUp`. This design does not send them.
- The input must not already contain `answers`. Every other field must match the original input exactly. Total answer text at most 32768 chars.

If the CLI refuses an `updatedInput`, the question fails for the agent. The server checks these rules before replying and rejects the RPC call on a bad payload, leaving the card pending.

Skip is a deny response: `denyResponse(requestId, <message>)`. Suggested message: "The user chose not to answer these questions."

The CLI also has an extended question shape: each question may carry `kind` (`choice` (default), `text`, `number`), plus `description`, `placeholder`, `min`, `max`, `step`, `defaultValue`, `unit`. Answers are still strings.

## Shape of the change

- **Shared types.** `ApprovalStatus` gains `answered` and `skipped`. The approval item gains an optional `answers` field holding what was sent, so the read-only view survives reload. `ZumiBotApi` gains a method to send answers or skip, for example `chats:answerQuestions(chatId, requestId, answers | null, agent?)` with `null` meaning Skip.
- **Server.** Remove `AskUserQuestion` from `UNANSWERABLE_TOOLS`. Its `permissionRequest` always becomes a pending card, skipping the chat-memory and agent-rule checks. The new method validates the payload, replies, sets the status and stores `answers`. `chats:answer` must not answer a question card with an allow decision (that would send the input without answers).
- **Group rooms.** `threadEntries` (`groupPrompts.ts`) today passes other members, and so the moderator, only user messages and other members' assistant text. An answered question card must reach them too, as an entry from the user that names the asking member and lists each question with its answer, in time order with the rest of the thread. The answer path must also reset `room.hops` in `GroupService` for that room. `GroupService` owns the room, so `ChatService` needs a way to tell it an answer happened (for example a callback on the turn spec); the builder picks the mechanism.
- **Frontend.** A question card component rendered by `MessageList` for `AskUserQuestion` approvals, with its logic (parsing the input defensively, step navigation, building and checking answers) in a pure module under `src/state/`, so it can be unit-tested. The in-progress picks must survive delta pushes that re-render the list.

## Left to the builder (my calls, not the user's)

- **Multi-select** questions use checkboxes plus a **Next** button, since ticking a box cannot move on. The answer is an array of labels, with the Other text as one more entry. The CLI's validator accepts arrays and joins them itself (its tool text calls them "comma-separated"), so a label containing ", " stays unambiguous. Confirm with one real `claude` call before relying on it; fall back to a plain string if the array is refused.
- **Server strictness:** the server requires an answer for every question (the UI does too), on top of the CLI's rules.
- **`chats:answer` on a question card:** `deny` acts as Skip; allow decisions are ignored.
- **Cards saved before this change** (status `denied`, no `answers`) and cards ending as `skipped` or `unanswered` render in the read-only layout with no picks highlighted and their status line.
- **`title`:** if the input carries the CLI's optional `title`, it is the card's heading. Otherwise the heading names the agent and the number of questions, also used for the tray row (exact wording is the builder's).
- **Previews** render as plain preformatted text, never as HTML or markdown.
- **Previews:** an option's `preview` shows under it, in a monospace block, once selected.
- **Extended kinds:** `text` shows a text box, `number` a number input within `min`..`max` (sent as a string), `description` a line under the question. This keeps the card working if the CLI sends that shape; it is not a user requirement.
- Picking **Other** does not move on by itself; the user types, then presses **Next** (or **Send answers** on the last step).
- Skip has no confirmation step.
- Unsent picks live only in the open page. A reload shows the card from its first question again.
- A malformed input (no `questions` array, a question without text) shows a short message and only **Skip**.
- The card must fit phone width, in light and dark themes, using the existing tokens (`--ring`, `--sel-bg`, `--sel-border`, ...).
- Exact component, module and RPC names, and whether the raw-input toggle stays on the card.

## Testing

- Backend unit tests (`chatService.test.ts`, `controlProtocol.test.ts`): a question request becomes pending; answering sends `allow` with `answers`; Skip sends `deny`; bad payloads are rejected and the card stays pending; question cards are never auto-allowed; Stop ends them as `unanswered`; group turns answer the right member's request.
- Group tests (`groupPrompts`, `groupService`): an answered card shows up in other members' thread and the moderator's input; a skipped one does not; answering resets the hop counter.
- Handler tests for the new RPC's argument checks.
- Frontend unit tests for the pure question module.
- An e2e check with the fake claude (a `can_use_tool` line for `AskUserQuestion` plus `#WAIT_RESPONSE`): answer through the card and see the reply continue; Skip and see "Skipped". No real `claude` quota needed.
- `npm test`, `npm run typecheck`, `npm run build:server`.

## Approval

Approved by the user on 2026-10-30, including the group-room behavior (answers shared, hop counter reset).
