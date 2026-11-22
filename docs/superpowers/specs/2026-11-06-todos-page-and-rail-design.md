# Icon rail and the To-dos page: design

Date: 2026-11-06. Built from the user's request, a short talk and mockups in the brainstorm companion. What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

## Why

Agents add to-dos in many chats every day. The user ticks most of them, but a few stay open each day, and because each list lives inside its own chat's side panel, those leftovers drop out of sight once the user moves on to newer chats. They pile up and get forgotten **(user)**. The user wants every chat's open to-dos in one place, with a count that keeps reminding them they exist, and a way to act on a leftover (ask the agent about it) without hunting for the chat.

At the same time the sidebar footer has grown (Agents/Routines tabs, the account button with usage, Archived… and Settings… behind it). The user wants a vertical icon rail on the far left to hold these ways around, and the To-dos page is its first new entry **(user)**.

## Two projects, in this order (user)

- **A (this design):** the icon rail and the To-dos page.
- **B (later, its own design):** an in-app notifications inbox behind a bell on the rail, with an unread indicator. There is no in-app list of notifications today, only push and desktop ones, so B needs its own storage, read state and sync rules.

## Goals

### The rail

1. **A vertical icon rail on the far left of the window, beside the sidebar column (user).** Top to bottom:
   - the app logo, not clickable **(user)**;
   - *(project B adds the bell here; until then nothing is drawn in its place, my call: no dead control)*;
   - **Agents** **(user)**: the current Agents mode (the chats sidebar). It carries today's Agents-tab indicators: the unread dot and the approval badge (the badge wins the slot, as today);
   - **Routines** **(user)**: the current Routines mode, with today's "a routine is waiting for approval" dot;
   - **To-dos** **(user)**: the new To-dos page, with a count (see 3);
   - **Archived** **(user)**: today's Archived… view (`ArchivedNav` in the sidebar column);
   - stuck to the bottom: **Usage** and **Settings** **(user)**.
2. **The Agents/Routines tabs and the account button leave the sidebar footer.** The rail replaces them. The **Archived…** and **Settings…** items in the account popup go too, since the rail has both.
3. **The To-dos count is every open (not ticked, not removed) to-do across all chats (user), hidden when it is 0 (user).** My calls: archived chats count (that is where things get forgotten); read-only A→B chats count; the badge shows `99+` above 99. The badge is the sum of the To-dos column's counts, computed on the client from the same data, so a chat left out of the column (its agent is gone) is left out of the badge too and the two never disagree.
4. **Usage (user)** opens today's account popup, anchored to the rail button: name, email, Claude status, plan usage limits with the "See all" link to claude.ai, plus a new **Usage details** link **(user)** that opens **Settings › Usage**. My calls: the button is a ring filled to the session limit's percent used (empty ring when no usage is known), the popup still reads the account again on open (as `onAccountOpen` does), and a red dot sits on the ring when the `claude` binary is not found (today's "Claude not found" line moves into the popup head).
5. **Settings (user)** opens Settings, same as `Ctrl+,`, through the unsaved-changes guard.
6. **Which entry is lit:** the one whose view is showing. Settings lights while Settings show; Usage never stays lit (it is a popup).
7. **Phone (my call):** the sidebar is a drawer there; the rail sits at the left edge inside the drawer, so opening the drawer shows rail plus column. The mobile bar's toggle keeps today's roll-up (approval badge, else unread dot); the To-dos count is not added to it.

### The To-dos page (layout A2, user)

8. **Rail → To-dos shows, in the sidebar column, the chats that have at least one open to-do, each with its open count (user, layout A).** Rows look like sidebar rows: the agent's icon (a room's member stack), the title, and the count. My calls:
   - order: the chat whose oldest open to-do is oldest comes first, so leftovers never sink;
   - archived chats are listed, with a small "Archived" tag; opening one from here does not unarchive it (sending does, as everywhere);
   - a chat that reaches 0 open while the page is showing stays in the column (count 0, dimmed) until the user leaves the page or picks another chat, so nothing jumps from under the cursor;
   - while a reply runs in a listed chat, a spinner shows in place of its count (as the mockup showed);
   - a chat whose agent is gone is left out, as the sidebar leaves it out;
   - a chat with a pending approval, question or plan card shows the approval badge on its row (as the sidebar does), and its header says "Waiting for you" next to **Open chat →**, since the cards of a reply not started from this page are not shown here;
   - opening To-dos with no chat in the address selects the top chat on a wide screen (the address is replaced, not pushed); on a phone the drawer stays open on the column until a chat is picked;
   - empty state: "No open to-dos." with nothing selected.
9. **Picking a chat shows its to-dos in the main area (user, layout A):** a header with the chat title, the agent (or members) and the open count, plus **Open chat →** which opens the chat itself. Under it the open to-dos, each with a checkbox, its text, its age and a remove button; the ticked ones fold under **Done** as the side panel does (same per-device open state, newest 100 then Show more). Ticking, unticking, removing (with the 6 s Undo toast) and adding a to-do by hand all work as in the chat's To-dos panel, through the same RPCs. My calls:
   - **age** is from the item's `from.at`: "today", "1 day", "N days"; amber once it is older than 3 days;
   - items are not grouped by reply here (the page is about what's left, not where it came from); open items are oldest first;
   - **Ask** shows on hover (always visible on touch): it adds the to-do's text to the message box below as a Markdown quote (`> <text>` and a new line, appended to whatever is typed), puts the caret after it and focuses the box. It never sends;
   - the chat's To-dos side panel view is unchanged;
   - the selected chat is part of the address: `/todos` and `/todos/<chatId>`, so reload, Back and Forward work as they do for chats, Settings and Archived. `/todos/<id>` for a chat with no open to-dos still opens it (empty list, Done folded).
10. **Below the to-dos: a message box for the selected chat, and the exchange it starts (user, A2).** The box sends into that chat like the chat's own composer. **Nothing from the chat's history is shown there automatically (user)** (the client may load the chat's items in the background, as send logic and live pushes need them, but never draws them): the area is empty until the user sends from this page; then it shows the user's message and the agent's reply streaming in under it, and every later message and reply sent from here. My calls:
    - the box is the normal `Composer` for that chat: `@` mentions and colors in rooms, `/` commands, `/todo` (a typed `/btw` still asks a side question, but its answer lives in the chat's Side questions view, not here, and it starts no exchange), attachments, the mic, Enter to send. It shares the chat's draft, so a half-typed message (or an Ask quote) is still there when the user opens the chat itself;
    - the exchange shows what the chat view would show for those items: tool rows, approval, question and plan cards (answerable here), errors, the working tray. Items before the first message sent from this page are never shown;
    - sending while the chat runs queues the message as the chat does (task tray behaviour unchanged), and it shows here as queued;
    - the exchange is kept per chat in memory for this tab: switching to another chat and back shows it again; a reload or leaving the To-dos page clears it;
    - read-only chats (A→B, `asked` set) get no box: their to-dos can still be ticked, with **Open chat →**;
    - while an exchange from this page is on screen, the page reports presence as looking at that chat (so its reply does not mark it unread or notify another device). Before any send, the page does not count as looking at the chat: just seeing its to-dos is not reading it. It never counts as opening the chat, so it never ends a **Mark unread**.
11. **Live:** the column, the counts and the rail badge follow changes from any tab, any device and any agent without a reload, as the side panel does (`todos:changed`).

## Non-goals

- The notifications inbox (project B).
- Due dates, reminders or push notifications for old to-dos.
- Editing a to-do's text.
- Bulk tick / bulk remove.
- Search across to-dos.
- Showing the chat's earlier history in the exchange area **(user)**.
- A count on the phone's drawer toggle.

## Anti-goals (would make it a failure even if it works)

- A rail count that is stale or wrong: it must match the column's counts at all times.
- Rows that move or vanish under the cursor while the user is ticking.
- Anything that sends a message the user did not press send for (Ask only fills the box).
- Loading every chat's items or every to-do file on each change in a way that makes the page or the server slow with hundreds of chats.

## Constraints

- Every existing rule of to-dos holds: `TodoService` and `ChatStore.updateTodos` stay the only writers, `todos:changed` is still sent on every change and after `settle` with the same rev (clients refetch on every event, never dedupe by rev), tombstones are never pruned, a deleted chat's file is gone.
- No new data files and nothing new for `sync.mjs`: the overview is derived from the existing `chats/<id>.todos.json` files. After a sync restarts the VPS service, the overview is rebuilt from disk.
- Same UI for browser and desktop shell. The CSP is unchanged.
- A new RPC touches the three usual places (`ZumiBotApi`, `rpc/handlers.ts`, `net/api.ts`), and handlers check every argument.
- Frontend tests cover only pure modules, so the page's rules (column order, ages, the count, which items the exchange shows) live in `src/state/`.

## Suggested shape (the builder may change it)

**Server.** A `todos:overview` RPC returning, for every chat with at least one open item, `{chatId, open, oldestAt}` (and nothing for chats with none). The server keeps this as an in-memory map: built once at start by reading each chat's to-do file (only chats that have one), and updated from the file just written on **every** write of a to-dos file, not only `TodoService` mutations: Fork's copy, an agent rename, a deleted chat. Hooking it where `ChatStore` writes or removes the file is the safe place. No extra disk reads per change. The client sums `open` over the chats it lists for the rail badge (see goal 3). Clients refetch the overview on `todos:changed` (debounced) and on chat deletes and pushes that change titles or archive state; the selected chat's list keeps using `todos:list`.

**Client.**
- `Rail.tsx` replaces the mode tabs and the account button of `SidebarFoot.tsx` (which may go entirely). `RailMode` stays `agents | routines` (the remembered mode); To-dos is its own route-driven state like Archived and Settings, and leaving it returns to the remembered mode. The rail just lights the active one.
- The account popup becomes the Usage popover (`AccountMenu.tsx` body reused), with **Usage details** → `settingsPath('usage')`.
- `TodosNav.tsx` (the column) and `TodosPage.tsx` (the main area), over a pure `state/todosPage.ts` (column order, age label, amber threshold, sticky zero rows, which items belong to the exchange) and a `useTodosOverview.ts` hook.
- `state/route.ts` gets `todosFromPath` / `todosPath` beside the archived ones.
- The exchange reuses the chat item sync and `MessageList` for the selected chat, and shows only items from the first message sent from this page onward (remember that item's id, or the send time, per chat in the page's memory).

**Tests.** Backend: the overview map (start-up scan, every mutation path including agent tools, delete, a file with only ticked or removed items). Frontend pure: `todosPage.ts`, the route helpers, the badge text. E2E (fake claude, no quota), extending `e2e:todos` or a new `e2e:todos-page`: the rail badge appears and hides at 0, the column lists chats oldest-first, ticking on the page updates the chat's panel and the badge, an agent tick from a running chat updates the page live, Ask fills the box, a send shows only the new exchange (no older history), a reply's approval card is answerable on the page, and `/todos/<id>` survives a reload.

**Docs.** A **To-dos page** paragraph and a **Rail** paragraph in `CLAUDE.md`, and the Settings paragraph updated (the account menu no longer holds Archived… and Settings…).

## Left to the builder

Icon drawings (in the style of today's mode icons), rail width and spacing, tooltips, keyboard order and `aria` labels for the rail, the debounce interval, how the exchange area is split from the list (scroll each separately, or one scroll), and the exact wording of empty states.
