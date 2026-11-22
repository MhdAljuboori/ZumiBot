# Plan card (ExitPlanMode)

## Intent

When an agent in plan mode calls `ExitPlanMode`, the server denies it automatically (`UNANSWERABLE_TOOLS` in `controlProtocol.ts`). The chat shows a dead approval card that already reads "Denied", and the agent can never leave plan mode. The user wants to read the plan in the chat and either approve it, so the agent carries on in the same reply, or send it back with feedback.

This follows the question card (`2026-10-30-question-card-design.md`, commit `c85d682`). Copy its structure wherever it fits.

## Goals

- Show `ExitPlanMode` requests as an interactive plan card in single chats, group rooms and routine runs.
- The card shows the plan as markdown. It has two actions: **Approve** and **Keep planning**, with an optional feedback box.
- The answer goes back over the existing stdio permission protocol, so the reply continues. No new user message is posted.

## Non-goals

- No choice of permission mode on approval. The CLI restores the mode the agent had before plan mode by itself (see Constraints).
- No editing of the plan text in the card.
- No "remember" option. Neither "Allow for this chat" nor "Allow always for this agent" applies.

## Anti-goals

- Never approve for the user. A plan card is never auto-allowed, even if `approvals.json` or chat memory holds a rule for `ExitPlanMode` (`chatService.test.ts:760` adds such a rule today; keep that test meaningful for the new path).
- No Jev risk hint on a plan card (it runs nothing; skip it the way questions are skipped).
- Never render the plan as raw HTML. Use the same safe markdown renderer as assistant messages.

## Constraints: what the CLI does (read from installed CLI 2.1.299)

- `normalizeToolInput` merges `{ plan, planFilePath }`, read from the plan file on disk, into the `ExitPlanMode` input. The stream's `tool_use` input carries `plan` the same way. So the `can_use_tool` request should carry `input.plan` (string) and `input.planFilePath`. The base schema is `{ allowedPrompts? }` (deprecated) and passthrough. **Confirm with one real `claude` call before relying on it** (see Testing). The card must still work if `plan` is missing: say no plan text was sent, and show `planFilePath` if present.
- **Approve** = `allowResponse(requestId, input)`, the input sent back unchanged. The tool's `call()` then sets the permission mode back to `prePlanMode ?? 'default'` and returns "User has approved your plan. You can now start coding…". No `setMode` or other extra response field is needed.
- **Keep planning** = `denyResponse(requestId, message)`. The agent stays in plan mode, revises the plan and calls `ExitPlanMode` again, which makes a new card. Message wording is the builder's call. Suggested:
  - with feedback: `The user did not approve the plan yet. Stay in plan mode, revise the plan based on their feedback, then call ExitPlanMode again.\n\nFeedback: <text>`
  - without: `The user did not approve the plan yet. Stay in plan mode, and end your reply so the user can say what to change.`
- Cap the feedback length on the server (for example 8192 chars) and reject longer ones before anything is sent, leaving the card pending.

## Behavior

1. **Pending.** The card shows a heading naming the agent ("Plan from <agent>", exact wording is the builder's), the plan as markdown, **Approve**, and **Keep planning**. Clicking **Keep planning** opens a feedback textarea with **Send** and **Cancel**. Feedback is optional.
2. **Long plans** stay readable: full text in the card, no truncation. A max height with its own scroll, or a collapse toggle, is the builder's call. It must fit phone width, in light and dark themes, using the existing tokens.
3. **After Approve.** The card is read-only: the plan, plus the status line "Approved".
4. **After Keep planning.** Read-only: the plan, the status line "Sent back", and the feedback quoted if there was any.
5. **Stop or server restart** while pending: "Not answered", the same as approval cards today.
6. **Pending counts.** Sidebar dot, pending counts, the tray row (`WorkingTray`) and a routine run's `waiting` status work as they do for approval and question cards.
7. **Cards saved before this change** (`ExitPlanMode`, status `denied`, no decision fields) render read-only with a neutral status line such as "Not approved".
8. **`chats:answer` on a plan card:** `allow-once` approves, `deny` sends it back with no feedback, `allow-chat` / `allow-agent` approve once and store no rule. Check which UI paths can send these (tray, keyboard shortcuts) and make sure none of them can save a rule.
9. **Group rooms: a decision counts as the user taking part**, as an answered question does. Approve and Keep planning both reset the room's hop counter (`spec.onAnswered` or an equivalent), and other members and the moderator see one user entry in `threadEntries` (`groupPrompts.ts`), in time order: "Approved <agent>'s plan." or "Sent <agent>'s plan back: <feedback>" (no `@`, so it never reads as a mention). The plan body is not copied into the entry, to keep prompts small. The asking member gets the decision through the tool result, as in a single chat.

## Shape of the change

- **Shared.** A small `shared/src/plans.ts` (like `questions.ts`): `PLAN_TOOL = 'ExitPlanMode'`, a defensive `parsePlan(input)` returning `{ plan: string | null, planFilePath: string | null }`, the feedback cap and its check. `ApprovalStatus` gains what the builder needs (for example `approved` and `sent-back`; or reuse `allowed-once` / `denied`, but then item 7 must still read sensibly). The approval item gains optional `feedback`. `ZumiBotApi` gains `chats:answerPlan(chatId, requestId, approve: boolean, feedback?: string, agent?)` or an equivalent.
- **Server.** Remove `ExitPlanMode` from `UNANSWERABLE_TOOLS`. `UNANSWERABLE_TOOLS` may end up empty; keep or remove it as the code reads best. A plan `permissionRequest` always becomes a pending card, skipping the chat-memory and agent-rule checks. The new method validates its args, replies, sets the status, stores `feedback`, and calls the group hook. The handler checks every argument (`str()`, booleans, ...), as every handler does.
- **Frontend.** A `PlanCard` component rendered by `MessageList` for `ExitPlanMode` approvals, using `Markdown.tsx`. Its logic (status line, which buttons show, building the request) goes in a pure module under `src/state/` with unit tests, since frontend tests cover only pure modules. An open feedback draft must survive delta pushes that re-render the list.
- **Docs.** Update the comment at `controlProtocol.ts:9`, and the "Running claude" paragraph of `CLAUDE.md`, which today says only `AskUserQuestion` gets a card.

## Testing

- **One real CLI check first** (cheap model, scratch dir, never the user's projects): run `claude -p --model haiku --permission-mode plan --permission-prompt-tool stdio --input-format stream-json --output-format stream-json --verbose`, ask for a tiny plan (for example "plan adding hello.txt, then call ExitPlanMode"), and log the `can_use_tool` request. Confirm `input.plan` is present, then confirm approve lets the agent continue out of plan mode and deny-with-feedback brings a second `ExitPlanMode` request. Fix the constraints above if the CLI behaves differently.
- Backend unit tests (`chatService.test.ts`, `controlProtocol.test.ts`): a plan request becomes pending (replace "ExitPlanMode is denied automatically"); approve sends `allow` with the unchanged input; Keep planning sends `deny` with the feedback in the message; too-long feedback is rejected and the card stays pending; plan cards are never auto-allowed by chat memory or agent rules; `chats:answer` with `allow-chat`/`allow-agent` stores no rule; Stop ends them as `unanswered`; group turns answer the right member's request.
- Group tests (`groupPrompts`, `groupService`): approved and sent-back cards show up in other members' thread and the moderator's input; a decision resets the hop counter.
- Handler tests for the new RPC's argument checks, and the `net/api.ts` mapping test.
- Frontend unit tests for the pure plan module.
- An e2e check with the fake claude (a `can_use_tool` line for `ExitPlanMode` plus `#WAIT_RESPONSE`), next to the question card's check in `routines.e2e.mjs`: approve and see the reply continue; Keep planning with feedback and see "Sent back".
- `npm test`, `npm run typecheck`, `npm run build:server`, `npm run e2e:routines`.

## Approval

Asked for by the user on 2026-10-30 ("build it"). Group-room behavior mirrors the approved question card design.
