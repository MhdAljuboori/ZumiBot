# Unread markers: design

Date: 2026-11-02. Built from the user's request and a short talk. What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

## Why

OpenBot has `thread_reads` and read tracking per agent. ZumiBot has nothing like it. Two moments hurt **(user)**:

1. **A routine runs while the user is away.** It makes a chat or adds to one. When the user comes back, nothing shows which chats got something new.
2. **The user works in chat A while chat B gets a reply** (a single chat or a group room). B's sidebar row shows a spinner while it runs. When the reply ends, the row looks like every other row.

Today the sidebar has the spinner, the "Approval needed" badge and the badge's rollups (collapsed agent row, collapsed section header, the phone bar's nav button). Nothing marks a finished reply the user hasn't seen.

## Goals

1. **A chat with agent output the user has not seen gets a marker in the sidebar. Looking at the chat clears it (user).**
2. **What counts as new (user):** an agent turn that ended with a reply or an error, including the turns of a routine run and of each room member. The user's own sends never count.
3. **Read state lives on the server (user).** Reading a chat on the phone clears it on the desktop too. Read state is not per device.
4. **"Looking at the chat" reuses the presence the notifications feature already reports (user):** page visible, window focused, that chat on screen, input in the last 3 minutes.
5. **Collapsed agents and collapsed sections show a combined marker (user)**, the same way the approval badge rolls up.
6. **A "New" line in the chat.** When the user opens an unread chat, a divider labeled **New** sits above the first agent item they have not seen, and the view starts there. (My call: the user approved the rest of the playback without answering this one.)

## Non-goals

- Unread counts. A row shows a dot, not a number.
- A manual "Mark as unread", "Mark as read" or "Mark all as read".
- Unread in the tab title or favicon. Both stay for waiting approvals only (`badgeTitle`, `setFaviconDot`), so they keep meaning "an agent needs you".
- Unread on the Routines sidebar's run rows. The Agents tab gets one dot instead (below).
- Push or desktop notifications for unread. The notifications feature already covers `replied`.
- Read tracking per agent inside a room. `GroupInfo.seen` already tracks what each member has seen. This feature is about the user.
- Marking old chats unread. Chats from before this feature start read.

## Anti-goals

- **The marker gets confused with "Approval needed" (user).** The approval badge stays louder. The unread dot is blue like the compact approval badge (changed on user request; it was neutral at first), so they never share a slot: where a row or rollup qualifies for both, only the approval badge shows, and a collapsed agent row shows unread on its icon, approval at the row's end.
- **The marker flashes on the chat the user is watching.** A reply that ends while someone looks at the chat is read at once, in the same write.
- **Reading a chat moves it in any list or changes sync's newest-wins choice.** Read writes never touch `updatedAt`.
- **A read-state failure breaks a turn.** Every read-state entry point is fire-and-forget, caught and logged, like `NotifyService`.
- **A new RPC method or new data file.** The state rides on `ChatMeta`, which already reaches every tab through `chats:list` and `meta` pushes.

## Data

Two optional fields on `ChatMeta` (`shared/src/types.ts`), both epoch ms from the server clock:

| Field | Meaning | Absent |
|---|---|---|
| `replyAt` | When an agent turn last ended with outcome `ok` or `error` | No such turn since this feature shipped |
| `seenAt` | The user has seen this chat up to this time | Never marked |

**Unread** ⇔ `replyAt !== undefined && replyAt > (seenAt ?? 0)`. One pure helper in a new `shared/src/unread.ts`, used by both sides.

No migration. Old chats have neither field, so they read as read.

## Server

A small service, `ReadMarks` (new file `backend/src/core/chat/readMarks.ts`), built in `app.ts#startServer` next to `NotifyService`. Its dependencies are the `ChatStore`, `presence.lookingAt`, the `push` function, `now` and a log. It has three entry points, each queued and caught like `NotifyService.run`.

| Entry point | Wired from | Does |
|---|---|---|
| `turnEnded(e)` | Single chats: `ChatService`'s `onTurnEnd` in `app.ts`, next to `notify.turnEnded`. Rooms: a new hook from `GroupService.endTurn` (below) | Outcome `stopped`: nothing. Else sets `replyAt = now`, and also `seenAt = now` when `presence.lookingAt(chatId)`. One write, one `meta` push. |
| `started(chatId)` | Presence `onStarted`, next to `notify.started` | When the chat is unread: `seenAt = now`, `meta` push. Else nothing (no write). |
| `stopped(chatId)` | Presence `onStopped`, next to `notify.stopped` | When the chat is running (`inFlight`): `seenAt = now`, `meta` push. Else nothing. |

- `onTurnEnd` already skips `/compact` turns and fires once per turn, so routine runs, edits and resends in single chats are covered with no further hooks. The moderator and notices outside a turn (`paused`, `moderator`, `interrupted` after a restart) never mark a chat unread.
- **Room turns are different.** `ChatService.agentTurn` fires `onTurnEnd` *before* `GroupService.endTurn` decides what the turn leaves in the thread. A member that passes (`isPass`) leaves no reply, and usually no tool rows. Passes are common: the moderator and `@everyone` offer turns to members who have nothing to add. So `ReadMarks` ignores `ChatService`'s `onTurnEnd` for room chats. `GroupService` gets its own optional hook, fired at the end of `endTurn` after the turn's items are in the thread, with the chat, the member, the outcome and whether it passed. A pass never marks the room unread, even one that keeps its tool rows and approval cards (the user already answered those cards).
- Notifications keep using `ChatService`'s `onTurnEnd` unchanged. That hook sends `replied` for a pass too. This change leaves that alone.
- `stopped` while running covers a user who watches half a reply and leaves: the part they watched stays above the New line.
- Every write keeps `updatedAt`. That takes a new method inside `ChatStore`'s queue that reads and writes in one step, as `toggleReaction` does. A separate `get` then `update` could roll `updatedAt` back if a turn's write lands in between.
- A chat removed between the event and the write is ignored quietly.
- Presence lives in memory. After a server restart the page reconnects and reports again, and `started` fires for the chat on screen, so a chat the user is looking at is read again with no extra code.

## UI

All new logic goes in a pure module `frontend/src/state/unread.ts` with unit tests (the frontend has no component tests): the unread check for one chat, the rollups and the New-line position.

### Sidebar (`Sidebar.tsx`)

- **Chat row and group row.** Unread: the title is emphasized (full `--fg` colour; a chat row's title is also weight 600, since group titles already are), and a small neutral dot sits in the row's status slot. The status slot keeps its order: approval badge, then the running spinner, then the unread dot. The emphasized title stays while the spinner or badge holds the slot (a room where one member replied and another still runs).
- **Agent row**, collapsed only: an unread dot on the agent's icon (top-right corner) when any of its chats is unread and no approval badge shows there. Like `agentHasPending`.
- **Section header**, collapsed only: the same, over its entries. Like `entryPending`.
- Search results use the same rows, so they get the same markers.
- Each dot has an accessible name ("Unread", "Unread chats").

### Elsewhere

- **Phone bar (`MobileBar.tsx`):** the nav button shows the unread dot when a chat other than the one on screen is unread and no approval badge shows there.
- **Agents tab (`SidebarFoot.tsx`):** while the Routines tab is active, the Agents tab shows the unread dot when any chat is unread. This is the routine case: runs land in chats under the Agents tab.

### New line (`MessageList.tsx`)

- When a chat opens while unread, the client keeps that chat's `seenAt` from before the open as `since`. The server's `started` write arrives a moment later and must not move the line.
- If the chat on screen turns unread while the user is idle and then becomes read when they come back, the client keeps the `seenAt` from before that read, the same way.
- The line sits above the first item with `ts > since` whose type is not `user`. It uses the existing `.divider` look, labeled **New**.
- No line when `since` is absent (the user never saw the chat, such as a new routine chat: all of it is new), or when no item qualifies.
- The line goes away when the user leaves the chat or sends a message in it.
- On open, the view scrolls so the line is near the top, if the line's item is in the loaded page. If it is older than the loaded page, the view opens at the bottom as today. After that, scrolling works as today.

## Sync (`deploy/sync.mjs`)

`mergeChats` picks one side's meta by `updatedAt`. Reads never bump `updatedAt`, so for a chat on both sides it sets `replyAt` and `seenAt` to the larger value of the two sides, each field on its own (absent counts as lower than any number). A kept copy (`copyMeta`) drops both fields: a copy is not news.

## Edge cases

| Case | Result |
|---|---|
| Reply ends while the user looks at the chat | Read in the same write; no dot ever shows |
| Reply ends while the chat is open but the user is idle over 3 min | Unread; clears on their next input on the page; the New line marks where it started |
| Two devices, one looking | Read on both |
| User stops a reply | `stopped` outcome: no change |
| Room member passes | No change, even when the pass keeps tool rows or approval cards |
| Room member replies after others passed | Unread; the New line sits above that reply |
| Routine turn errors | Unread (the error is in the chat). Notifications report it as a routine failure instead; that is unchanged |
| Edit or Resend rerun | Its turn end marks the chat like any reply |
| Version switch, rename, reaction, queued task | No change |
| Fork | The new chat has neither field: read |
| Agent renamed | No change; fields belong to the chat |
| Chat deleted | Fields go with it |

## Testing

- Unit: `ReadMarks` (each entry point; looking vs not looking; `stopped` and compact turns ignored; room chats ignored from `ChatService`'s hook; no write when nothing changes; `updatedAt` kept; `meta` pushed; a store failure is logged and swallowed), `GroupService`'s new hook (fires after the items are in the thread; `passed` true for a pass, with or without kept approval cards), the new `ChatStore` method (keeps `updatedAt` while a concurrent update runs), the shared unread helper, `state/unread.ts` (rollups, approval precedence, New-line position and its absent cases), `mergeChats` (max per field, copies drop both).
- E2E: a new `npm run e2e:unread` (`zumi-bot-server/e2e/unread.e2e.mjs`) on the fake claude, so it costs no quota. One page sits on chat A while chat B replies: B's row shows the dot. A second page (a second device) sees it too. Opening B on the first page clears the dot on both pages and shows the New line. A reply that ends in the chat on screen never shows a dot.
- CLAUDE.md gets a short **Unread** paragraph under Architecture and the new e2e command under Commands.

## Left to the builder

- The dot's exact size and colour within the anti-goal (neutral, distinct from the accent approval dot).
- Where `since` is held on the client and how the scroll-to-line fits `MessageList`'s stick-to-bottom logic.
- How `ReadMarks` queues its writes, as long as they never block a turn.
