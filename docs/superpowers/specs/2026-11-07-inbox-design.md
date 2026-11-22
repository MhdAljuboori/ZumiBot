# Inbox: design

Date: 2026-11-07. Built from a short talk with the user and two rounds of mockups in the brainstorm companion (`.superpowers/brainstorm/…/inbox-layout.html`, `inbox-stream-v2.html`; the user picked layout **B**, one stream, and approved the detailed v2). What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

This is "project B" that `2026-11-06-todos-page-and-rail-design.md` left for later, but smaller than that note expected: it is not a history of every notification, only a live list of what waits on the user plus the history of workflow Notify messages.

## Why

Things that need the user's answer are spread out today. A tool approval, a question or a plan card sits inside its own chat (a routine's chat, a workflow Agent step's chat, an A→B chat, a room). A workflow Approval sits inside its run view. A desktop or browser handoff sits inside its chat. The rail shows that *something* waits (the Agents approval badge, the Routines and Workflows dots), but the user has to hop between modes and chats to find and answer each one. The user wants **everything that needs their approval in one place (user)**, and to **answer it right there (user)**, with a way to jump to the chat or run for context **(user)**.

Workflow Notify steps are the one notification that carries content (a title and a body the user wrote into the step). Today that text is filled in, sent as a push, and thrown away: it is stored nowhere (`workflowRunner.ts`, the `notify` case of `begin`). Once the phone notification is dismissed it is gone. The user wants to **see the Notify messages in the app (user)** and keep them **as a history they can archive or delete (user)**.

## Goals

### Where it lives

1. **A new rail entry, Inbox, with a bell icon (user, mockup B).** Placed between **To-dos** and **Archived** as in the approved mockup (user). (The To-dos design reserved a slot right under the logo; the later, approved mockup supersedes it.) It is route-driven like To-dos and Archived: `/inbox`, with `switchMode` closing it like the other views and the unsaved-changes guard run once. `aria-current="page"` when it shows.
2. **The rail badge counts only things waiting on the user (user, approved guess)**: the number of entries in the Waiting section (see 6), hidden at 0, `99+` above 99. Unseen Notify messages add a small dot on the bell instead and never raise the number (user, approved guess). When both apply, the number wins the slot (my call, as the Agents approval badge wins over the unread dot).
3. **Existing indicators stay (my call).** The Agents approval badge, the Routines and Workflows waiting dots and the sidebar row badges are unchanged; the Inbox adds a place, it takes nothing away.
4. **Wide screen (my call, from mockup B):** the rail and the stream only; the sidebar column is hidden while the Inbox shows (it has no column of its own, unlike To-dos and Archived). **Phone (my call):** the rail sits in the drawer as everywhere; the Inbox takes the main area as one full-width stream; picking Inbox closes the drawer.

### The page: one stream (user, layout B)

5. **One scrolling page: a header, then "Waiting for you", then "Messages" (user).** The header has the title **Inbox** and filter chips **All · Waiting N · Messages** (the Messages chip shows "N new" while any are unseen) (user, approved mockup). A chip only filters what the stream shows; All is the default each time the page opens (my call: not remembered).

### Waiting for you

6. **Every card that waits on the user, from anywhere, drawn in full and answerable in place (user).** Kinds:
   - **Tool approvals** (`approval` items, status `pending`, any tool other than the two below): **Allow once**, **Allow for this chat**, **Allow always for this agent**, **Deny**, exactly as `ApprovalCard` (including the Jev risk hint); its desktop **Show on desktop** / **Open Desktop** buttons jump to the chat and open the desktop view there (my call: no live view inside the Inbox);
   - **Questions** (`AskUserQuestion`): the choices plus **Other** with a typed answer (user), exactly as `QuestionCard` (it already supports Other, multi-select and several questions);
   - **Plans** (`ExitPlanMode`): **Approve** / **Keep planning** with optional feedback, as `PlanCard`, but the plan is **folded to a few lines with "Show full plan" (user, approved mockup)**;
   - **Workflow approvals** (an Approval step's visit, status `waiting`): the question, the text (editable when the step is), the note, **Approve** / **Reject**, as `ApprovalBox` in `VisitPanel.tsx`;
   - **Desktop and browser handoffs** (`browser-action` items whose handoff is `pending`): **I'm done** and **Cancel** answered in place (they need no open view, as `BrowserActionCard` already does), and **Open Desktop** / **Open Browser** which here jumps to the chat and opens the view there (my call: no live desktop or browser view inside the Inbox).
   
   Sources: single chats, rooms, routine chats, workflow Agent step chats and A→B chats all count; they are all chats. Archived chats count too (a running chat is never archived, so in practice none are).
7. **Each card has a header line (user, approved mockup):** the agent's icon and `@name` (in a room, the member that asked), the chat's title, how long it has waited ("waiting 12 min", from the item's `ts`, or the visit's `startedAt`), and **Open chat →** (for a workflow approval: the workflow's name › the step's name, and **Open run →**). An A→B chat's card says whom it is for: `@B, asked by @A in <source title>` (my call, so the user knows which conversation it belongs to). Open chat/run navigates the way a sidebar click does and leaves the Inbox.
8. **Order: oldest first (user, approved guess)**, so what has waited longest is on top. Workflow approvals and chat cards are mixed by that one time.
9. **Live both ways.**
   - A card answered anywhere else (the chat itself, another tab, another device, a routine's own run view, the run view's approval box) **leaves the stream at once (user)**.
   - A card answered here shows a short result line in its place ("✓ Allowed once · npm test · @deployer"), then leaves after about 4 seconds (user, approved guess; the exact time is the builder's). If the answer fails (the turn ended meanwhile, the visit was already answered), the card shows the error the chat would show and leaves once the item is no longer pending.
   - A card that stops being pending without an answer (the turn was stopped, the run was stopped) leaves silently.
   - New cards appear as they arrive, without a reload.
10. **No double entries.** An A→B chat's cards appear once, under the A→B chat (where they live), never again under the asking chat whose pending count also includes them. A workflow run that is `waiting` only because one of its Agent step chats has a card shows that card once, as a chat card; only Approval step visits become workflow approval entries.
11. **Empty state:** "Nothing is waiting for you." (wording the builder's).

### Messages (workflow Notify history)

12. **Every Notify step that fires stores a message (user)**: `{id, workflowId, workflowName, runId, stepName, title, body?, at}`, the title and body exactly as sent in the push (already filled and cut to 80 / 200 characters), the names as they were at that time. This happens whether or not any device has notifications on (my call: the Inbox is the record; the push is only a ping).
13. **Messages section (user, approved mockup):** newest first; each shows the workflow's name, the time, the title, the body, and **Open run →**, **Archive**, **Delete**. Open run is hidden once the run is gone (runs are pruned to the newest 30 per workflow) or the workflow is deleted (my call).
14. **New messages** get a blue left edge until the user has seen the Inbox (user, approved guess). Seen state is one `seenAt` time stored on the server (shared by every device, my call, like a chat's `seenAt`): a message is new while `at > seenAt`. The page sets `seenAt` when it opens and is visible, but keeps the blue edges it showed on open until the page is left, so nothing changes under the reader (my call, like the chat's New line). The bell's dot (goal 2) and the "N new" on the chip read the same rule.
15. **Archive and Delete (user).**
   - **Archive** moves a message out of the stream into **Show archived (N)** at the end of the Messages section, which unfolds the archived ones (newest first) with **Unarchive** and **Delete** (my call).
   - **Delete** removes it, with a 6 second **Undo** toast like a removed to-do (my call: no confirm dialog). A deleted message never comes back, not after a restart and not after a sync (see Constraints).
   - Bulk actions (archive all, delete all archived) are out of scope for now (non-goal).
16. **History limit (my call):** the newest 500 messages are kept (archived ones included), so a workflow that notifies every few minutes cannot grow the file without end. A deleted message keeps only its id and times once the Undo window has passed (its title and body are dropped), and that tombstone is kept for a year, so a machine that has not synced for months still cannot bring it back; tombstones do not count toward the 500.
17. **A Notify push opens the Inbox at that message (my call).** Today a Notify push opens the run, whose view does not show the message. The push payload gets the message id; a click opens the Inbox scrolled to that message with a short highlight. In the desktop shell, whose `onNotificationClick` passes only a chat id today (the known gap in `CLAUDE.md`), the bridge gets an optional way to pass the target, so a Notify notification opens the Inbox there too; a shell without it keeps today's behaviour. Approval, waiting and other pushes keep opening what they open now.

## Non-goals

- A history of other notifications (replies, errors, routine failures, waiting cards once answered). The Waiting section is live state only; Messages are workflow Notify steps only.
- Answering from a push notification (a notification still never answers anything).
- Holding pushes back while the Inbox is open **(user)**. The Inbox counts as looking at no chat: presence, read marks and every push (waiting cards, workflow approvals, Notify messages) behave exactly as today, so a card that appears in front of the user on the Inbox still notifies their other devices and the desktop shell.
- Removing or changing the Agents badge, the Routines/Workflows dots, the sidebar row badges or **Settings › Notifications**.
- Showing the chat's conversation around a card (Open chat → is the way to read it).
- A live browser or desktop view inside the Inbox.
- Bulk archive/delete, search, or filters beyond the three chips.
- Notify messages from any source other than a workflow's Notify step (routines have none).

## Anti-goals (would make it a failure even if it works)

- A card that is still shown after it was answered elsewhere, or that can be answered twice.
- A rail number that disagrees with the Waiting section.
- Any answer the user did not press (no auto-allow, no "allow all").
- A deleted message coming back from the other machine after a sync.
- Message text in logs, URLs or error messages (the message id may be in a URL; the title and body never).
- Loading every chat's items, or every run's visits, to build the page; or the page slowing down with hundreds of chats.

## Constraints

- **Answering goes through today's RPCs only:** `chats:answer`, `chats:answerQuestions`, `chats:answerPlan` with the card's own chat id (an A→B card with the A→B chat's id, as `AskCard` does), `workflows:approve` for a workflow approval, and the desktop/browser socket's `answer` for a handoff. "Allow for this chat" applies to the card's own chat, "Allow always" to the card's agent, as in the chat.
- **Pending cards exist only while their turn runs** (the server keeps pending counts in memory for running turns; `resyncApprovals` rebuilds them from in-flight chats' items after a reconnect). The Waiting section is built from that same state, not from a new store.
- **Messages are a new data file**, `workflow-messages.json` (my call on the name) in the data dir, written 0600 through the same atomic write as the other stores, since a body can carry webhook text. `sync.mjs` joins it by message id: the later `updatedAt` wins per message (archive, unarchive and delete each bump it), a delete is a tombstone (`deletedAt`) so it stays deleted, `seenAt` keeps the later side, and the 500 cap and one-year tombstone rule are applied after the join. It is copied like a data file, never left on one machine (workflows run on the VPS, but a manual run on this PC may notify too).
- **Restart safety:** the message is written before the push is sent, and its id is the Notify visit's id, so writing it is idempotent. `recover()` today marks a running Notify done without sending it again ("a duplicate is worse than a missing one"); it now also stores the message if that visit has none, and still sends no push. The filled title and body are not on the visit today, so they are stored on it when the visit begins (my call, as an Approval visit's `question` is), and `recover()` reads them from there instead of filling the templates again.
- **Privacy:** the push payload stays as it is (the Notify body is already the one place a notification carries content) plus the message id. The Inbox shows message text only to the signed-in user, over the existing socket.
- A new RPC touches the three usual places (`ZumiBotApi` in `shared/src/types.ts`, `rpc/handlers.ts`, `frontend/src/net/api.ts`), and handlers check every argument.
- Frontend tests cover only pure modules, so the stream's rules live in `src/state/`.
- Same UI in browser and desktop shell; the CSP is unchanged.

## Suggested shape (the builder may change it)

**Server.**
- `core/workflows/workflowMessages.ts` (or `core/inbox/`): a store over `workflow-messages.json` with `add` (idempotent by id), `list`, `archive`, `unarchive`, `remove` (tombstone), `markSeen`, and the cap. The `notify` case in `WorkflowRunner.begin` adds the message before `notify.message(...)`; `recover()` adds it for a running Notify visit that has none.
- RPCs: `inbox:messages` (the kept, non-deleted messages and `seenAt`), `inbox:archive`, `inbox:unarchive`, `inbox:delete`, `inbox:undelete` (for Undo), `inbox:seen`; broadcast `inbox:changed` on every change. Message bodies go only to the list RPC, never into broadcasts (the event carries no text), matching how `workflows:changed` carries summaries only.
- A small `workflows:approvals` RPC returning only the waiting Approval visits across all runs (`{workflowId, workflowName, runId, visit: {id, question, input, startedAt}, step: {name, editable}}`), so the Inbox does not fetch whole runs with every visit's output. Refetched on `workflows:changed`.
- `NotifyService` adds the message id to the Notify payload; the service worker opens the Inbox address for it.
- `sync.mjs`: the join described under Constraints, with tests beside the existing todos/btw join tests.

**Client.**
- `Rail.tsx`: the `inbox` entry and its badge/dot; `state/route.ts`: `inboxFromPath` / `inboxPath` (plus a way to name a message for the push click, e.g. `/inbox?m=<id>` or a hash; the builder's choice).
- `InboxPage.tsx` over a pure `state/inbox.ts`: builds the Waiting list from (a) the `approvals` map, (b) the loaded items of each chat with pending > 0, and (c) `workflows:approvals`; drops A→B doubles; orders oldest first; gives the badge number from that same list; holds the "answered here" result lines; and the Messages rules (new vs seen, archived fold).
- `resyncApprovals` (after a reconnect) counts only `approval` items today, so pending handoffs and the A→B roll-up are lost until the next push; the Inbox's list does not depend on it (it reads each chat's own items), but the count it seeds is fixed to include pending `browser-action` handoffs (my call).
- Loading a chat's items for its cards reuses what `AskCard` does (`loadAsked` / `chatViews` in `App.tsx`): load the items of each chat whose pending count is above 0, and reload when its count moves. Only running chats can have pending cards, so this stays small.
- The cards are today's `ApprovalCard`, `QuestionCard`, `PlanCard` (inside a fold wrapper), `ApprovalBox` and the handoff's done/cancel, each inside an `InboxCard` frame with the header line of goal 7.
- `useInboxMessages.ts`: fetch on connect and on `inbox:changed`.

**Tests.**
- Backend: the message store (idempotent add, cap, tombstones, archive round trip, seen), the runner storing before the push and on `recover()` without a push, the new RPCs' argument checks, `workflows:approvals` (Approval visits only, not Agent step waits).
- Sync: join by id, a delete beating an older archive, tombstones kept, cap after join, `seenAt` later wins.
- Frontend pure: `state/inbox.ts` (A→B dedupe, workflow-agent dedupe, order, badge = list length, new/seen hold, answered-here lines), route helpers.
- E2E (fake claude and fake workflow claude, no quota), a new `e2e:inbox`: a tool approval from a `can_use_tool` line plus `#WAIT_RESPONSE` shows in the Inbox and is allowed there (the chat shows it answered); a question card answered with **Other** text (the fake sees the typed answer); a card answered in the chat leaves the Inbox live; the rail number follows; a workflow Approval approved from the Inbox with an edited text; a Notify step's message appears with the blue edge, archive / unarchive / delete with Undo, and survives a restart; a push click (via the local fake push endpoint) opens the Inbox at the message.

**Docs.** An **Inbox** paragraph in `CLAUDE.md`, the Rail paragraph (new entry), the Workflows paragraph (Notify now stores a message; the push click), the Data list (`workflow-messages.json`) and the sync paragraph.

## Left to the builder

The bell drawing (in the style of the other rail icons), the exact wording of headers and empty states, how long the "answered" line stays, how many lines a folded plan shows, the chip styling, the push-click address format, the debounce of refetches, keyboard order and `aria` labels.
