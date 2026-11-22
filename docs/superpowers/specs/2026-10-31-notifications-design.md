# Notifications: design

Date: 2026-10-31. Built from the user's written request and a short talk. What the user decided is marked **(user)**; everything else is my call and can be changed.

## Why

Agents often block on the user while they are away: routines at 07:00, webhook runs, the VPS used from a phone. Today the only alert is the amber dot on the Routines tab, and it is seen only by someone already looking at ZumiBot. The routines spec listed notifications as later work (`2026-10-27-routines-design.md`, Non-goals). The codebase has no notification, service worker, Web Push or web manifest code.

## Goals

1. **Tell the user when an agent needs them or finishes, even with no ZumiBot tab open or focused (user).**
2. **Three channels (user):** a count in the tab title with a favicon dot, a system notification from the desktop shell, and Web Push to browsers and phones on the VPS.
3. **Settings per device (user):** an account menu entry **Notifications…** like **Jev decisions…**: enable this device, a toggle per event type, and a "Send test" button.

## Non-goals

- Answering from a notification. No approve/deny action buttons (user).
- Email, SMS, chat-app or any other channel.
- A notification inbox or history.
- Quiet hours, do-not-disturb schedules, per-chat mute.
- Offline use: the service worker exists for push only and has no `fetch` handler or cache.
- Web Push in Local mode. The Local server listens on `127.0.0.1` and is reached only through the desktop shell, which uses its own channel.
- Keeping the desktop shell alive in a tray after its window closes. Today closing the window quits the app (`window-all-closed`), so the shell notifies only while its window is open or minimized.

## Anti-goals

- **A notification that approves, denies or answers anything (user).** Clicking only opens the chat, and the normal session gate still applies.
- **Private content leaving the server in a push (user).** No prompt text, tool input, Bash command, file path, answer, reply text or anything from Jev.
- **Secrets leaking (user).** The VAPID private key and push endpoints (they work as capability URLs) never reach the UI, logs, URLs or error messages.
- **A slower chat (user).** A failed or slow push never blocks or slows a chat, routine or reply.
- **A buzz storm (user).** A burst of events for one chat shows as one notification, not ten.
- **Keys or subscriptions crossing machines (user).** Sync never copies them between PC and VPS.
- **A missed 07:00 approval** because a PC left on overnight still shows that chat.

## Events

Four event kinds, each with its own per-device toggle, all on by default.

| Kind | Toggle label | Fires when |
|---|---|---|
| `waiting` | Needs you | A chat's pending count rises: approval card, question card, plan card or browser handoff, in single chats and group rooms. |
| `replied` | Replied | An agent's turn ends with a successful result. In rooms, **one per agent reply (user)**. |
| `error` | Reply error | An agent's turn ends with an error. |
| `routine-failed` | Routine failed | A routine run is marked `failed`. |

Details:

- **Source of `waiting`:** the `{ kind: 'approvals', pending }` push (`pushApprovals` / `pendingOf` in `chatService.ts`). `pendingOf` already counts permission, question, plan and browser handoff waits, and group members run through `ChatService.agentTurn`, so rooms are covered. It fires on every rise of `pending` (a second card while one is waiting is new news), not on falls.
- **Routine `waiting`:** comes from the same `approvals` push (`routineRunner.chatPush`), so it is the chat's `waiting` event and needs nothing of its own.
- **Not notified:** a turn the user stopped; a `/compact` run; the moderator; a chat marked interrupted by a server restart; a routine run failed by the user's own action (Stopped, Removed from the queue, Replaced by an edit or resend, Chat was deleted); a routine run failed as "Interrupted by a restart" (`RoutineRunner.recover()`), since a restart is usually a deploy or sync and would buzz every device at startup.
- **Routine failed by its turn's error:** one failure is one notification per device. When a routine run fails because its turn errored, the device gets `routine-failed` if that toggle is on, else `error` if that one is on, never both.
- **Routine failed before any chat exists** (agent missing, folder gone): `chatId` is null and the title is the routine's name.

## What a notification carries

The payload is the same on every channel:

```
{ v: 1, kind, tag, chatId, title, agent?, at }
```

- `tag`: the slot (see Coalescing), made of ids only (`chat:<chatId>`, `routine:<routineId>:waiting`, …). It is in the payload because a routine's slot can't be derived from the chat id. Added while planning.

- `title`: **the chat's title (user)**, or the agent's name when the title is still empty; for a routine failure with no chat, the routine's name. The user accepted that a chat title is the first 60 characters of the first message (`makeTitle`) and so passes through Google, Mozilla or Apple.
- `agent`: the agent whose turn it was (the member in rooms). Absent for `routine-failed` with no chat.
- `at`: epoch ms, used for clearing (below).
- Nothing else. The payload type lives in `shared` and one builder function makes it, so a test can check every field.

The device builds the visible text from `kind`:

- `waiting`: "<agent> needs you"
- `replied`: "<agent> replied". In a room, a second reply under the same tag merges the names: "writer, news replied".
- `error`: "<agent>'s reply ended with an error"
- `routine-failed`: "Routine failed"
- `test`: "Notifications work on this device"
- `paused`: "Signed out. Notifications are paused until you sign in again." (see Devices; carries no chat, title "ZumiBot")

## Coalescing and clearing

- **Two slots per chat per device:**
  - `chat:<chatId>:waiting` for `waiting`.
  - `chat:<chatId>` for `replied`, `error` and `routine-failed`.
  - A new event replaces the shown one in its slot and buzzes again (`renotify: true`), so each agent reply buzzes but the tray shows one entry per slot.
  - "Needs you" has its own slot because room members run side by side: member B's reply must never replace member A's pending card in the tray.
- **Routine runs into a new chat each time:** their slots are keyed by routine instead (`routine:<routineId>:waiting` and `routine:<routineId>`), so a frequent schedule or a busy webhook shows one entry per routine, not one per run. A click opens the chat named in the latest payload. Routine failures with no chat use `routine:<routineId>` too.
- **Rate cap per device:** at most 10 non-`waiting` notifications a minute. Extra ones are dropped (counted in the log, nothing else). `waiting` is never capped.
- **Push services coalesce too:** each push carries an RFC 8030 `Topic` header derived from its slot (a hash cut to 32 URL-safe characters), so a phone that was offline gets the latest push per slot, not a backlog. Because `waiting` has its own slot, a 1 h `replied` push never replaces a 12 h `waiting` one at the push service.
- **Clear on answer:** when a chat's pending count falls to 0, a shown `waiting` notification for it is closed. A shown `replied`/`error` one stays.
- **Clear on look:** when the user starts looking at a chat on any device (see Presence), every notification for that chat is closed.
- **How clearing reaches a device:**
  - Live pages: the server sends a `notify:clear` event to every connected tab, and each closes its own device's notifications for that chat (`registration.getNotifications({ tag })` in browsers, the bridge in the shell).
  - Devices with no live page: Web Push can't remove a notification silently (iOS revokes subscriptions that receive pushes without showing one, and Chrome shows a generic one), so no "clear" push is ever sent. When a ZumiBot page next opens on that device, it asks the server which notifications are stale (the chat is no longer waiting, or was looked at after the notification's `at`) and closes them.

## Devices and presence

### Devices

- **A device** is one browser profile, one installed home-screen web app, or one desktop shell. It has a random id (`crypto.randomUUID()`) kept in that origin's `localStorage`. The id is not a secret. An iOS home-screen app has its own storage, so it is its own device (and needs its own sign-in, with password and 2FA).
- **Two channels:**
  - `push`: a browser or home-screen app on the VPS, with a push subscription.
  - `desktop`: the desktop shell, in Local or VPS mode, notified over its live WebSocket.
- **Label:** made on the device from its user agent ("Chrome on Android", "Safari on iPhone", "ZumiBot desktop"). Not renamable in v1.

### Push devices follow the sign-in session (my call; the user handed it to me)

Sessions are fixed 30-day tokens (`authStore.ts`, not sliding). A lost phone must stop showing chat titles once the user presses **Sign out everywhere**, so:

- **Binding:** a `push` device record holds the session key of the connection that enabled or last refreshed it. That is the stored hash `authStore` already uses, never the cookie token.
- **When the session ends** (Sign out, Sign out everywhere, or expiry), the device is **paused**:
  - It gets one last push of kind `paused`, which has no chat and no title.
  - After that, nothing more is sent to it.
  - Logout and logout-all pause the affected devices at once. Expiry is noticed at the next event for that device.
- **Signing in again on that device resumes it:** the page-load refresh rebinds the record to the new session and clears `paused`.
- **The page-load refresh never creates a device.** Only **Enable** does. So a device removed from elsewhere with **Remove** stays removed. When the server holds no record for a device whose browser still has a subscription, the page unsubscribes it and shows Off.
- **The dialog** shows a paused device as "Paused: signed out".
- **`desktop` devices need none of this.** They are reached only over a live socket, which the gate already ties to a valid session.

### Who gets notified (user)

- **Devices are independent (user).** Every enabled device whose toggle for the event is on gets it, even while the user is active on another device.
- **Except when the user is looking at that exact chat:** if any device is looking at the chat the event is about, no device is notified for that event. The card is already in front of them. (My call, offered in the playback and not objected to.)
- **"Looking"** means a tab whose page is visible, whose window is focused, which shows that chat, and which saw input (key, pointer, touch, scroll) in the last 3 minutes. The input window keeps a PC left on overnight, showing the routine's chat, from swallowing the 07:00 buzz.
- **Held back, then sent:** an event held back because someone was looking is kept per chat and slot (the latest only). It is dropped if the looking tab sees input after the event's time: the user saw it. If looking ends (3 minutes idle, blur, hidden, closed) with no such input, the event is sent then, if it still holds. A `waiting` still holds while the chat's pending count is above 0. So "send a task, walk away, approval 90 seconds later" buzzes at most 3 minutes after the last input, never not at all.
- **The test notification** ignores presence and toggles, and goes to the asking device only.

### Presence

- Each tab tells the server, on every change, which device it is on, which chat it shows (or none) and whether it is looking. Its looking state drops to false after 3 minutes without input.
- The server keeps this per connection, in memory only, and drops it when the socket closes.
- The RPC hub today calls handlers with the arguments only. Presence needs to know which connection called, and `notify:show` needs to reach one connection rather than every tab. How the hub provides that is the builder's call.

## Channels

### 1. In-tab title and favicon (user)

- **Title:** `(N) ZumiBot` when N chats are waiting on the user, `ZumiBot` at 0. N counts chats, not cards.
- **Favicon:** the normal icon with an amber dot (the Routines tab's dot colour) while N > 0; drawn on a canvas and set as a `data:` URL (the CSP's `img-src` already allows `data:`). Back to `/favicon.png` at 0.
- **Initial counts:** the browser learns pending counts only from `approvals` pushes (`App.tsx`), so a reload starts at 0 today. The page fetches the current counts on load and after each reconnect.
- **Code placement:** the title text, the dot decision and the stale-notification check are pure functions in a module under `frontend/src/state/` with unit tests. Only the canvas drawing lives in a component or hook.

### 2. Desktop shell

- **New optional bridge methods** in `shared/src/desktop.ts`, optional like `sync?` so an older installed shell can load a newer UI:
  - `notify?(n)`: show or replace by tag.
  - `closeNotifications?(chatId)`.
  - `onNotificationClick?(cb)`: the shell calls back with the chat id.
- **Main process:** Electron's `Notification`, keeping a reference per tag (a replace closes the old one first). A click shows and focuses the window, then tells the renderer to open the chat.
- **No fallback for an older shell.** Every installed shell up to 3.5.0 refuses every permission but `clipboard-sanitized-write` (`isPermissionAllowed` in `navigation.ts`), so the renderer's HTML5 `Notification` can't work there. A shell without `notify` gets "Update the desktop app to get notifications" in the dialog, and no `desktop` device is registered for it. The new shell keeps refusing the HTML5 permission; the bridge is the only path.
- **Delivery:** the server sends a `notify:show` event to one live connection of each enabled `desktop` device that is not suppressed. It never broadcasts it.
- **Permission:** none needed in Electron. Enabling the device in the dialog is the opt-in.

### 3. Web Push (VPS, browsers and phones)

- **Implementation:** hand-rolled on `node:crypto`, no new dependency (my call; the user handed it to me). It covers:
  - RFC 8291 message encryption, `aes128gcm` content coding only. Every current browser, Safari included, uses it.
  - RFC 8292 VAPID: an ES256 JWT (`aud` = the endpoint's origin, `exp` at most 12 h ahead, `sub` = `ZUMIBOT_ORIGIN`) in `Authorization: vapid t=…, k=…`.
  - A unit test with RFC 8291 Appendix A's test vector, byte for byte.
- **Request headers:**
  - `TTL`: 12 h for `waiting`, 1 h for the others, 60 s for the test.
  - `Urgency`: `high` for `waiting`, `normal` otherwise.
  - `Topic` as above.
- **Responses:**
  - 201: success.
  - 404 or 410: the subscription is removed at once (user). The device record stays, marked "needs enabling again".
  - 413: logged as a bug.
  - 429 and 5xx: one retry after `Retry-After`, capped at 60 s, then give up.
  - Each request times out after 10 s.
- **Logging:** a failure is logged with the device label and the status, never the endpoint.
- **Endpoint check on subscribe:** `https:` only, a host name that is not an IP literal or `localhost`, at most 2048 characters, `p256dh` a 65-byte uncompressed P-256 point, `auth` 16 bytes. A dev hook read through `devEnv()` (for example `ZUMIBOT_TEST_PUSH_ORIGIN`) also allows one `http://127.0.0.1:<port>` origin for the e2e suite; `NODE_ENV=production` ignores it.
- **VAPID keys:** made on the first push subscribe, so a Local-mode server never makes any. The public key goes to the UI (it is public); the private key never does.

#### Service worker `/sw.js`

- **Scope:** `/`, served from the web root, not hashed `/assets/`. It goes through `createGate` like every other route (user). The existing `no-cache` header for non-hashed files is right for it.
- **Events it handles:**
  - `install` / `activate`: `skipWaiting` and `clients.claim`.
  - `push`: always shows a notification. It parses the payload, builds the text, merges room reply names with an existing notification of the same tag, and sets `tag`, `renotify`, icon, badge and `data: { chatId, kind, at }`.
  - `notificationclick`: closes the notification, then focuses an open ZumiBot window and routes it to `/chat/<id>` (or opens one). That is all it does.
- **What it doesn't have:** no `fetch` handler and no action buttons.
- **Subscription refresh:** on every page load the page sends its current push subscription for this device. The server updates an existing record if it differs and rebinds the session (see Devices), but never creates a record. That covers browsers that rotate subscriptions, without a `pushsubscriptionchange` HTTP route.
- **Build:** whether it is a hand-written file in `public/` or a second Vite entry that reuses `shared` code (the payload-to-text function, say) is the builder's call. Pure logic should be testable either way.

#### Web app manifest

- `/manifest.webmanifest`: name and short name ZumiBot, `start_url` and `scope` `/`, `display: standalone`, 192 and 512 px PNG icons made from the existing app icon, theme and background colours from the light theme.
- `<link rel="manifest" … crossorigin="use-credentials">`. Without `use-credentials` the browser fetches the manifest without the session cookie, and the gate refuses it. Add an `apple-touch-icon` link too.
- `static.ts` gets the `.webmanifest` content type (`application/manifest+json`).
- iOS supports Web Push only for an installed home-screen app, iOS 16.4+ (user). The dialog says so on iPhone and iPad Safari when it is not running standalone.

### CSP

No change. `worker-src` falls back to `script-src 'self'` and `manifest-src` to `default-src 'self'`, which allow both files. The push endpoint is called by the server, not the page. The builder confirms this in a browser and changes `headers.ts` only if something is actually blocked.

## Settings: **Notifications…** (user)

An account menu item next to **Jev decisions…**, opening a dialog in the same style.

- **This device:**
  - The state: On, Off, Blocked by the browser, Not supported, or "On iPhone, add ZumiBot to the Home Screen first".
  - **Enable** asks for browser permission from the click, subscribes and registers the device. In the shell it only registers.
  - **Turn off** unsubscribes and removes the device record.
- **Four toggles** for this device: Needs you, Replied, Reply error, Routine failed. **Per device (my call; the user handed it to me)**, so a phone can take only "Needs you" while the PC takes everything.
- **Send test:** this device only.
- **Other devices:** label, channel and last seen, each with **Remove**, for a lost phone.
- **Local mode:** the dialog offers only the desktop device. There is no push section.

## Data

Two new files in the data dir, both written 0600 like `jev.json`, both kept away from the UI, logs, URLs and errors:

- `notify-devices.json`: per device id, the channel, label, enabled flag, the four toggles, created and last-seen times, and for `push` devices the subscription (endpoint, `p256dh`, `auth`), the bound session key and the `paused` flag. At most 20 devices; registering a 21st drops the one seen least recently.
- `notify-vapid.json`: the VAPID key pair. Push devices only.

What the UI gets about devices: id, label, channel, toggles, last seen, and whether a push subscription is held. Never the endpoint or keys.

## Sync (user)

`sync.mjs` never copies either file. Each side keeps its own, like `auth.json`:

- Pull: both names join `PULL_EXCLUDES`, so they never leave the VPS, not even into the temp folder.
- Push: they are not in the upload list. Keep it that way.
- Tests next to the existing sync tests check both directions.

The desktop **Sync…** gets the same behaviour, since it runs the same `sync.mjs`.

## Failures (user)

- Event handling is fire-and-forget from the chat, routine and turn code. The notify service is called through a wrapper that catches everything, so an exception there can't reach `ChatService`, `GroupService` or `RoutineRunner`.
- Pushes to different devices run in parallel, each with its own timeout.
- A failed desktop or HTML5 notification is logged on the device and ignored.

## API

New handlers under `notify:`, args checked like every handler, plus their entries in `ZumiBotApi` and `net/api.ts`:

- `notify:status(deviceId)`: whether push is available (VPS mode), the VAPID public key or null, this device's record, the other devices.
- `notify:enable(deviceId, { channel, label, subscription? })`: register or update, from the **Enable** click only.
- `notify:refresh(deviceId, subscription | null)`: the page-load refresh. Updates and rebinds an existing record, never creates one, and tells the page when there is no record.
- `notify:disable(deviceId)`: turn this device off and remove it. `notify:remove(deviceId)` does the same for another device.
- `notify:setPrefs(deviceId, toggles)`.
- `notify:test(deviceId)`.
- `notify:presence(deviceId, chatId | null, looking)`: per connection.
- `notify:state()`: pending counts per chat, for the title, plus what the page needs to close stale notifications.
- Events:
  - `notify:show`: sent only to the chosen desktop connections.
  - `notify:clear { chatId, waitingOnly }`: broadcast to every tab.

## Testing

- **Backend unit tests:**
  - The event-to-notification decision: kinds, toggles, routine-failed vs error, user-caused failures skipped, stopped turns skipped.
  - Coalescing and clearing: the two slots per chat, routine slots, the rate cap, `notify:clear` on pending 0 and on look, staleness.
  - Presence suppression: looking on one device silences all for that chat; other chats still notify; the 3-minute input window; disconnect drops presence; the test ignores presence; a held-back event sent when looking ends, and dropped after input.
  - Session binding: logout and logout-all pause at once with one `paused` push; expiry pauses at the next event; refresh rebinds and resumes; refresh never creates; removed stays removed.
  - RFC 8291 encryption against the Appendix A vector, and the VAPID JWT (header, claims, signature verifies with the public key).
  - The push sender: headers, 404/410 removal, retry on 429/5xx, timeout, nothing logged with the endpoint.
  - Subscribe validation, including the dev hook ignored in production.
  - Store files written 0600, and the device cap.
- **Sync tests:** neither file is pulled or pushed.
- **Frontend unit tests:** the title and favicon state module, the stale-notification check, the user-agent label, and the payload-to-text function (wherever it lives).
- **`e2e:notifications`** (user): fake claude only, so it costs no quota.
  - A `can_use_tool` line plus `#WAIT_RESPONSE` in its script, as in `e2e:routines`.
  - The browser gets notification permission over CDP.
  - A local fake push endpoint records requests, and the device's subscription points at it, with keys the test generated.
  - It checks that a real encrypted push arrives, decrypts it, and finds only the allowed fields and no prompt text. The VAPID header must verify.
  - It checks the title shows `(1) ZumiBot`.
  - A tab looking at the chat suppresses the push.
  - Answering clears.
  - A 410 removes the subscription.
  - The service worker shows a notification with the right tag: deliver the payload with CDP `ServiceWorker.deliverPushMessage`, then read `registration.getNotifications()`.
  - Headless Chrome can't make a real FCM subscription, so how the test registers its fake one is the builder's call (a direct RPC with the test's session, say).
- **`CLAUDE.md`:** an Architecture paragraph, the two files under **Data**, and `e2e:notifications` under **Commands** (user).
- After any Playwright or Chrome run, every process started is killed (user).

## Left to the builder

- How the hub exposes the calling connection and sends to one connection.
- Where exactly turn ends and routine failures are observed, and how a failure's "caused by the user" flag is carried.
- The service worker's build (plain file or Vite entry).
- Module layout under `core/notify/`, `frontend/src/state/` and `shared/`.
- Icon generation for the manifest, and the exact dialog layout within the existing style tokens.
- The exact wording of notification text and dialog hints, within the above.
