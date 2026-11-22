# Chat and room archive: design

Date: 2026-11-04. Built from the user's request and a short talk. What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

## Why

The sidebar fills up with chats and rooms the user is done with. Deleting them loses the history, the cost and the context. The user wants to put them away, out of the list, and still be able to open them later **(user)**.

## Goals

1. **Right-click (or long-press) a chat row or a room row → Archive. It leaves the sidebar at once (user).** On every device, since the flag lives on the server.
2. **Nothing is lost (user).** Opening an archived chat shows the old conversation, its cost chip, its context meter, Files and side questions, exactly as before.
3. **The archive is reached from the account menu (the profile button in the sidebar footer) (user):** an **Archived…** item next to **Settings…**.
4. **Archived… takes the sidebar's place, as Settings does (user, approved playback):** Back to chats, a title with a count, a search box, and the archived chats and rooms, newest archived first. Each row shows the title, the agent (or the room's members), the folder and when it was archived. The main area shows the chat opened from the list. It has its own address (`/archived`, `/archived/<id>`), so reload, Back and Forward work.
5. **Unarchive (user, approved playback)** from the list row's menu or from the note over an archived chat. A room goes back to the section spot it had.
6. **Delete stays available** from the list row's menu, with the same confirmation as the sidebar.
7. **Any new activity brings a chat back (user, approved playback):** sending a message, a routine run landing in it, a room member's turn, a compact. So an approval card or a reply never hides in the archive.
8. **No unread noise (user, approved playback):** an archived chat never lights a dot on a row, an agent, a section, the drawer toggle or the Agents tab.

## Non-goals

- Archiving an agent. Agents stay; only their chats are archived.
- Auto-archiving old chats.
- Bulk archive.
- A read-only archived chat. The composer stays, and sending brings the chat back.

## Rules (my calls)

- **Refused while the chat runs** (a reply, a compact, a room turn). The menu item is disabled with a tooltip; the server refuses too (`ARCHIVE_RUNNING`), checked inside the store's queued write so a turn can't start between the check and the write. Pending approvals exist only while a chat runs, so that covers them.
- **The open chat stays open** when it is archived (from this device or another): the note shows over it, with Unarchive.
- **Opening Archived… empties the main area**, so a live chat never shows beside the archived list. Back to chats keeps whatever was opened from the list.
- **A chat opened from a notification or a `/chat/<id>` address** closes the archive view.
- **A single chat whose agent is gone** is left out of the list, as the sidebar leaves it out: it could not open.
- **Reusing an empty chat** (clicking an agent) never picks an archived one.
- **Fork and Clone room** make a fresh chat, never archived.

## Data

Two times on `ChatMeta`, both kept once set: `archivedAt` and `unarchivedAt`. A chat is archived while `archivedAt` is later (`shared/src/archive.ts` `isArchived`). Each new time lands past the other one even when that is ahead of the clock (synced from a faster machine), as `markUnread` does. Neither write moves `updatedAt`, so the sidebar order is unchanged.

`ChatStore.updateLocked` adds `unarchivedAt` whenever a patch sets `inFlight: true` on an archived chat. Every turn path goes through it, so none can miss it.

`chats:archive(chatId, on)` sets one or the other through `patchInPlace` and pushes the meta to every tab.

The sidebar layout is untouched: an archived room's key stays where it was stored, and the sidebar only skips it. Layout writes keep stored keys they don't list, so the spot survives until the room comes back.

**Sync** keeps the later of each time from either side, like `replyAt`/`seenAt`, so the later of an archive and an unarchive wins whichever meta is newer. A kept copy keeps the archive state of the side it copies.

## UI pieces

- `Sidebar.tsx`: **Archive** in the chat/room menu, before Delete.
- `AccountMenu.tsx`: **Archived…** above Settings….
- `ArchivedNav.tsx`: the list in the sidebar's place (drawer on a phone), row menu by right-click or ⋯ (Unarchive, Delete).
- `ChatView.tsx`: the note in the chat's top bar: "Archived. Sending a message brings it back." + **Unarchive**.
- `App.tsx`: `archive` state, the address, and `liveChats(chats)` for the sidebar and every unread roll-up.
- Pure logic: `shared/src/archive.ts`, `frontend/src/state/archive.ts` (`liveChats`, `archivedRows`, `archivedLabel`), `state/route.ts` (`archivedFromPath`, `archivedPath`).

## Tests

Unit: `shared/tests/archive.test.ts`, `frontend/tests/archive.test.ts`, route and `reusableChat` cases, `ChatStore` auto-unarchive, the `chats:archive` handler, and the sync merge. End to end: `npm run e2e:archive` (fake claude, no quota).
