# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the user when an agent needs them, replies, errors, or a routine fails. It works through the tab title and favicon, the desktop shell, and Web Push to browsers and phones on the VPS, even when no ZumiBot tab is open or focused.

**Architecture:**
- **Server:** `core/notify/` holds a `NotifyService`. It turns chat, turn, routine and session signals into per-device deliveries, filtered by per-device toggles, presence (who is looking at which chat), a rate cap and slot coalescing.
- **Delivery:** push devices get hand-rolled RFC 8291/8292 Web Push. Desktop devices get a `notify:show` event on one live socket, which the shell turns into an Electron `Notification` through the new optional bridge.
- **Every tab:** reports presence, keeps `(N) ZumiBot` and a favicon dot, and closes stale notifications.

**Tech Stack:** TypeScript, Node 22 `node:crypto`, React 19, Electron, Service Worker + Push API, vitest, playwright-core e2e. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-notifications-design.md`

## Global Constraints

- **Commits, bumps, deploys:** never commit, bump versions or deploy. The user does that. End each task with its tests green and a short summary. Ask before touching the VPS or using sudo.
- **Dependencies:** none added.
- **Permissions:** never add `--dangerously-skip-permissions` or `bypassPermissions`.
- **Payload:** exactly `{ v: 1, kind, tag, chatId, title, agent?, at }`.
  - `title` is the chat title (else the agent name, else the routine name for a routine failure with no chat), cut to 100 characters.
  - `agent` is also cut to 100 characters.
  - Never prompt text beyond the title, tool input, commands, paths, answers, reply text or anything from Jev.
- **Kinds:** `waiting | replied | error | routine-failed | test | paused`.
- **Toggles:** `{ waiting, replied, error, routineFailed }`, all `true` by default.
- **Secrets:** `notify-devices.json` and `notify-vapid.json` are written 0600 through `writeFileAtomic(file, data, 0o600)`. The VAPID private key, endpoints, `p256dh`, `auth` and session keys never reach the UI, logs, URLs or error messages. Log a push failure as `push to "<label>" failed: <status>`.
- **No answering:** a notification has no action buttons. A click only opens `/chat/<id>`.
- **Failures:** every call into the notify service from chat, routine, turn or gate code is fire-and-forget and wrapped so it can't throw back.
- **Constants (exact):**
  - presence: `LOOK_IDLE_MS = 180_000`, `INPUT_REPORT_MS = 30_000`, `DROP_GRACE_MS = 10_000`
  - devices: `DEVICE_CAP = 20`
  - rate cap: `RATE_CAP = 10` non-`waiting` per device per `60_000` ms
  - push: `PUSH_TIMEOUT_MS = 10_000`, `RETRY_CAP_MS = 60_000`, record size `4096`
  - `TTL`: `43_200` s for `waiting`, `3_600` s for others, `60` s for `test` and `paused`
  - `Urgency`: `high` for `waiting`, `normal` for others
  - VAPID JWT `exp`: now + 12 h
  - subscription: endpoint at most `2048` characters, `p256dh` 65 bytes decoded, `auth` 16 bytes decoded
- **Dev hook:** `ZUMIBOT_TEST_PUSH_ORIGIN`, read only through `devEnv()`, allows exactly that one `http://127.0.0.1:<port>` origin for endpoints. `NODE_ENV=production` ignores it.
- **New API methods:** each touches `ZumiBotApi` (`shared/src/types.ts`), a handler (args checked there), and `frontend/src/net/api.ts`.
- **Frontend tests:** pure modules only (`frontend/src/state/`). There are no DOM tests.
- **Comments:** short and *why*-only, matching the surrounding code.
- **Browser and Chrome runs:** after any Playwright or Chrome run, kill every process started.

## Review Focus

1. **Same browser, new device id.** Cleared `localStorage` gives a new device id while the browser keeps its push subscription. Expected: enabling with an endpoint another record holds replaces that record, so pushes never arrive twice. *Test in Task 4.*
2. **Socket blip while looking.** A reconnect drops presence for a moment. Expected: no held event fires during the `DROP_GRACE_MS` grace if the tab is looking again by then, and the tab re-sends presence after every reconnect. *Tests in Tasks 5 and 11.*
3. **Long title or agent name.** Expected: both are cut to 100 characters, so the encrypted body always fits one 4096-byte record. *Test in Task 1.*
4. **One device, two live connections** (a desktop shell reconnect overlap). Expected: exactly one `notify:show`, sent to the newest connection. *Test in Task 6.*
5. **Chat deleted while an event is held, or before a push builds its title.** Expected: the event is dropped, with no push for a chat that's gone. *Test in Task 6.*

---

## File Map

**Shared**
- `zumi-bot-server/shared/src/notify.ts` (new): payload and toggle types, `slotTag`, `buildPayload`, `notifyText`, `mergeAgents`, validators. Used by the backend, the frontend and the service worker.
- `zumi-bot-server/shared/src/desktop.ts`: optional `notify?`, `closeNotifications?`, `onNotificationClick?`.
- `zumi-bot-server/shared/src/types.ts`: `ZumiBotApi.notify`; `approvals` push gains `agent?`.
- `zumi-bot-server/shared/src/rpc.ts`: `notify:show` and `notify:clear` events.

**Backend, `core/notify/`**
- `webPush.ts`: RFC 8291 encryption and RFC 8292 VAPID.
- `pushSender.ts`: one HTTP push, with retry and outcome.
- `notifyStore.ts`: both data files.
- `subscription.ts`: subscribe validation.
- `presence.ts`: per-connection presence.
- `decide.ts`: pure per-device decisions and the rate cap.
- `notifyService.ts`: orchestration.

**Backend, other files**
- `rpc/hub.ts`: connection-aware handlers, `sendTo`, `onDisconnect`.
- `rpc/notifyHandlers.ts` (new).
- `app.ts`: wiring.
- `auth/guard.ts`: `sessionEnded`.
- `chat/chatService.ts`: `onTurnEnd`, approvals `agent`.
- `routines/routineRunner.ts`: `onFailed`, `routineOfChat`.
- `http/static.ts`: `.webmanifest` type.

**Frontend**
- `state/notifications.ts` (new): the title, the dot, `isLooking`, `presenceToSend`, `staleTags`, `deviceLabel`, `deviceIdFrom`.
- `net/push.ts` (new): service worker and push glue.
- `useNotifications.ts` (new): the hook.
- `components/NotificationsDialog.tsx` (new).
- `components/AccountMenu.tsx`.
- `App.tsx`.
- `src/sw/sw.ts` (new), `tsconfig.sw.json` (new), `vite.sw.config.ts` (new).
- `public/manifest.webmanifest`, `public/icon-192.png`, `public/icon-512.png` (new).
- `index.html`, `package.json`, `tsconfig.json`.

**Desktop**
- `zumi-bot-desktop/src/main/notifications.ts` (new).
- `src/main/index.ts`.
- `src/preload/index.ts`.

**Other**
- `zumi-bot-server/deploy/sync.mjs`.
- `zumi-bot-server/e2e/notifications.e2e.mjs` (new).
- root `package.json`.
- `CLAUDE.md`.

---

### Task 1: Shared notify module

**Files:**
- Create: `zumi-bot-server/shared/src/notify.ts`
- Test: `zumi-bot-server/shared/tests/notify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NotifyKind = 'waiting' | 'replied' | 'error' | 'routine-failed'
  export type NotifyPayloadKind = NotifyKind | 'test' | 'paused'
  export interface NotifyToggles { waiting: boolean; replied: boolean; error: boolean; routineFailed: boolean }
  export const DEFAULT_TOGGLES: NotifyToggles
  export type NotifyChannel = 'push' | 'desktop'
  export interface NotifyPayload { v: 1; kind: NotifyPayloadKind; tag: string; chatId: string | null; title: string; agent?: string; at: number }
  export const PAYLOAD_KEYS: readonly string[] // ['v','kind','tag','chatId','title','agent','at']
  export interface DeviceSummary { id: string; label: string; channel: NotifyChannel; toggles: NotifyToggles; lastSeenAt: number; subscribed: boolean; paused: boolean; current: boolean }
  export interface NotifyStatus { pushAvailable: boolean; vapidPublicKey: string | null; devices: DeviceSummary[] }
  export interface NotifyState { pending: Record<string, number>; lookedAt: Record<string, number> }
  export interface SubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }
  export interface TurnEnd { chatId: string; agent: string; outcome: 'ok' | 'error' | 'stopped' }
  export interface RoutineFailure { routineId: string; chatId: string | null; cause: 'start' | 'turn' | 'user' | 'restart' }
  export function slotTag(o: { kind: NotifyPayloadKind; chatId: string | null; routineId: string | null }): string
  export function buildPayload(o: { kind: NotifyPayloadKind; tag: string; chatId: string | null; title: string; agent?: string; at: number }): NotifyPayload
  export function notifyText(p: NotifyPayload, agents?: readonly string[]): { title: string; body: string }
  export function mergeAgents(prev: readonly string[] | undefined, agent: string | undefined): string[]
  export function isToggles(v: unknown): v is NotifyToggles
  export function isPayload(v: unknown): v is NotifyPayload
  ```

- [ ] **Step 1: Write the failing tests** in `shared/tests/notify.test.ts`:
  - `slotTag` returns:
    - `chat:c1:waiting` for `{kind:'waiting', chatId:'c1', routineId:null}`
    - `chat:c1` for `replied`, `error` and `routine-failed` with a chat
    - `routine:r1:waiting` and `routine:r1` when `routineId: 'r1'` is given (the routine wins over the chat)
    - `routine:r1` for `routine-failed` with `chatId: null`
    - `test` and `paused` for those kinds
  - `buildPayload` cuts `title` and `agent` to 100 characters. It omits `agent` when undefined. `Object.keys(result)` ⊆ `PAYLOAD_KEYS`. `JSON.stringify(buildPayload({…title: 'x'.repeat(5000), agent: 'y'.repeat(5000)…})).length < 3993`.
  - `notifyText` returns the spec's copy:
    - `waiting`: `{ title: 'Fix login', body: 'news needs you' }`
    - `replied` with agents `['writer','news']`: body `'writer, news replied'`
    - `error`: `"news's reply ended with an error"`
    - `routine-failed`: `'Routine failed'`
    - `test`: `'Notifications work on this device'`
    - `paused`: title `'ZumiBot'`, body `'Signed out. Notifications are paused until you sign in again.'`
    - Without an agent, `waiting` reads `'An agent needs you'` and `replied` reads `'An agent replied'`.
  - `mergeAgents(['writer'], 'news')` → `['writer','news']`. `mergeAgents(['news'], 'news')` → `['news']`. `mergeAgents(undefined, undefined)` → `[]`.
  - `isToggles`: true for `DEFAULT_TOGGLES`; false for a missing key or a non-boolean value.
  - `isPayload` round-trips `buildPayload` output and rejects extra keys.

- [ ] **Step 2: Run them, expecting failures.**
  Run: `npx vitest run zumi-bot-server/shared/tests/notify.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `shared/src/notify.ts`** with the signatures above. Pure: no Node or DOM APIs, because the service worker bundles it.

- [ ] **Step 4: Run the tests, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/shared/tests/notify.test.ts`
  Expected: PASS.

---

### Task 2: Web Push crypto (RFC 8291 + RFC 8292)

**Files:**
- Create: `zumi-bot-server/backend/src/core/notify/webPush.ts`
- Test: `zumi-bot-server/backend/tests/core/webPush.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface VapidKeys { publicKey: string; privateKey: string } // base64url: 65-byte uncompressed point, 32-byte scalar
  export function generateVapidKeys(): VapidKeys
  export function encryptPayload(plaintext: Buffer, sub: { p256dh: string; auth: string }, o?: { salt?: Buffer; serverPrivateKey?: Buffer }): Buffer // full aes128gcm body
  export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): string // 'vapid t=<jwt>, k=<publicKey>'
  export const b64url: { encode(b: Buffer): string; decode(s: string): Buffer }
  ```

- [ ] **Step 1: Write the failing tests.**
  - `encrypts the RFC 8291 Appendix A example byte for byte`:
    - Inputs: plaintext, `ua_public`, `auth_secret`, `as_private`, salt.
    - Expected: the final message body, base64url.
    - Copy every value verbatim from https://www.rfc-editor.org/rfc/rfc8291#appendix-A. Don't type them from memory.
  - `round-trips through a test-only decrypt`: write a `decrypt(body, uaPrivate, auth)` helper in the test file, following RFC 8291 §3.4 in reverse. Random keys and plaintext come back equal. Byte 21 of the body is the key id length, `65`. The record size field (bytes 16–19) is `4096`.
  - `vapidAuthorization`:
    - The header matches `/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/`.
    - The JWT header is `{"typ":"JWT","alg":"ES256"}`.
    - The claims are `{ aud: 'https://fcm.googleapis.com', exp: floor(now/1000)+43200, sub }` for endpoint `https://fcm.googleapis.com/fcm/send/abc`.
    - The signature verifies with `crypto.verify('sha256', …, { key: <public JWK>, dsaEncoding: 'ieee-p1363' })`.
    - `k` equals `keys.publicKey`.
  - `generateVapidKeys` gives a 65-byte public key starting with `0x04` and a 32-byte private key.

- [ ] **Step 2: Run, expecting failures.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/webPush.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `webPush.ts`.** Use `createECDH('prime256v1')`, `hkdfSync('sha256', …)`, `createCipheriv('aes-128-gcm', …)`, and the private key as a JWK through `createPrivateKey({ format: 'jwk' })` for `sign(..., { dsaEncoding: 'ieee-p1363' })`. The steps (RFC 8291 §3.3–3.4, RFC 8188 §2):
  ```
  ecdh = ECDH(as_private, ua_public)
  ikm  = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua_public||as_public, 32)
  cek  = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: aes128gcm\0", 16)
  nonce= HKDF(salt=salt, ikm=ikm, info="Content-Encoding: nonce\0", 12)
  ct   = AES-128-GCM(cek, nonce, plaintext || 0x02) || tag
  body = salt(16) || uint32be(4096) || uint8(65) || as_public(65) || ct
  ```
  With no `o`, use a random 16-byte salt and a fresh ECDH key per message.

- [ ] **Step 4: Run, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/webPush.test.ts`
  Expected: PASS.

---

### Task 3: Push sender

**Files:**
- Create: `zumi-bot-server/backend/src/core/notify/pushSender.ts`
- Test: `zumi-bot-server/backend/tests/core/pushSender.test.ts`

**Interfaces:**
- Consumes: `encryptPayload`, `vapidAuthorization`, `VapidKeys` (Task 2); `NotifyPayload` (Task 1).
- Produces:
  ```ts
  export type PushOutcome = 'sent' | 'gone' | 'failed'
  export interface PushTarget { endpoint: string; p256dh: string; auth: string }
  export function topicOf(tag: string): string // sha256(tag) base64url, first 32 chars
  export function pushOptions(kind: NotifyPayloadKind): { ttl: number; urgency: 'high' | 'normal' }
  export async function sendPush(o: {
    target: PushTarget; payload: NotifyPayload; vapid: VapidKeys; subject: string
    fetch: typeof fetch; now(): number; sleep(ms: number): Promise<void>; timeoutMs?: number
  }): Promise<{ outcome: PushOutcome; status: number | null }>
  ```

- [ ] **Step 1: Write the failing tests** with a fake `fetch` that records calls:
  - **Request:** a POST to the endpoint with these headers:
    - `Content-Encoding: aes128gcm`
    - `Content-Type: application/octet-stream`
    - `TTL: 43200` and `Urgency: high` for `waiting`; `TTL: 3600` and `Urgency: normal` for `replied`; `TTL: 60` for `test`
    - `Topic` equal to `topicOf(payload.tag)`, which matches `/^[A-Za-z0-9_-]{1,32}$/`
    - `Authorization` starting with `vapid t=`
  - **Outcomes:** 201 → `sent`; 404 → `gone`; 410 → `gone`; 413 → `failed`.
  - **Retry:**
    - 429 with `Retry-After: 5` → sleeps 5000 ms, retries once, and 201 → `sent`.
    - 503 then 503 → `failed` after exactly 2 calls.
    - `Retry-After: 999` → sleeps `60_000`.
  - **Timeout:** a fetch that never resolves → `failed` after `timeoutMs` (use 50 in the test), through an `AbortSignal`.
  - **No leaks:** the result object and any thrown error message contain no part of the endpoint.

- [ ] **Step 2: Run, expecting failures.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/pushSender.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `pushSender.ts`.** A network error is `failed`, never a throw.

- [ ] **Step 4: Run, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/pushSender.test.ts`
  Expected: PASS.

---

### Task 4: Notify store and subscription validation

**Files:**
- Create: `zumi-bot-server/backend/src/core/notify/notifyStore.ts`, `zumi-bot-server/backend/src/core/notify/subscription.ts`
- Test: `zumi-bot-server/backend/tests/core/notifyStore.test.ts`, `zumi-bot-server/backend/tests/core/subscription.test.ts`

**Interfaces:**
- Consumes: `generateVapidKeys`, `VapidKeys` (Task 2); `NotifyToggles`, `NotifyChannel`, `DEFAULT_TOGGLES`, `isToggles` (Task 1).
- Produces:
  ```ts
  // notifyStore.ts
  export interface PushBinding { endpoint: string; p256dh: string; auth: string; sessionKey: string; paused: boolean }
  export interface DeviceRecord { id: string; channel: NotifyChannel; label: string; toggles: NotifyToggles; createdAt: number; lastSeenAt: number; push?: PushBinding }
  export class NotifyStore {
    constructor(dataDir: string)
    devices(): Promise<DeviceRecord[]>
    get(id: string): Promise<DeviceRecord | null>
    put(rec: DeviceRecord): Promise<void>          // cap DEVICE_CAP by least lastSeenAt; drops other records holding the same push endpoint
    patch(id: string, fn: (r: DeviceRecord) => DeviceRecord): Promise<DeviceRecord | null>
    remove(id: string): Promise<void>
    vapid(): Promise<VapidKeys>                     // creates notify-vapid.json on first call
    vapidPublicKey(): Promise<string | null>        // never creates
  }
  // subscription.ts (SubscriptionInput from shared/src/notify.ts)
  export function checkSubscription(v: unknown, testOrigin: string | null): SubscriptionInput // throws TypeError with a message that never echoes the endpoint
  export const DEVICE_ID_RE: RegExp // /^[A-Za-z0-9-]{8,64}$/
  ```

- [ ] **Step 1: Write the failing tests.**
  - **Store:**
    - Both files exist with `(statSync(f).mode & 0o777) === 0o600` after `put` and after `vapid()`.
    - `vapid()` returns the same keys on the second call and from a new `NotifyStore` on the same dir.
    - `vapidPublicKey()` is `null` before `vapid()` and creates no file.
    - Putting a 21st device drops the one with the smallest `lastSeenAt`.
    - Putting device B with device A's endpoint removes A.
    - A corrupt JSON file reads as no devices.
    - `remove` of an unknown id is a no-op.
  - **`checkSubscription`:**
    - Accepts a valid `https://fcm.googleapis.com/...` subscription with a 65-byte `p256dh` and a 16-byte `auth`.
    - Rejects `http://` URLs, `https://127.0.0.1/...`, `https://[::1]/...`, `https://localhost/...`, `https://10.0.0.1/...`, an endpoint longer than 2048 characters, a 64-byte `p256dh`, a 15-byte `auth`, and non-objects.
    - Accepts `http://127.0.0.1:5555/x` only when `testOrigin === 'http://127.0.0.1:5555'`.
    - No error message contains the endpoint string.

- [ ] **Step 2: Run, expecting failures.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/notifyStore.test.ts zumi-bot-server/backend/tests/core/subscription.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement both files.** `NotifyStore` serializes operations through a promise queue like `JevStore.run`, and writes with `writeFileAtomic(..., 0o600)`.

- [ ] **Step 4: Run, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/notifyStore.test.ts zumi-bot-server/backend/tests/core/subscription.test.ts`
  Expected: PASS.

---

### Task 5: Presence

**Files:**
- Create: `zumi-bot-server/backend/src/core/notify/presence.ts`
- Test: `zumi-bot-server/backend/tests/core/presence.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PresenceReport { deviceId: string; chatId: string | null; looking: boolean; inputAgoMs: number }
  export class Presence {
    constructor(o: { now(): number; setTimer(fn: () => void, ms: number): { clear(): void }; onStopped(chatId: string): void; onStarted(chatId: string): void })
    update(connId: string, r: PresenceReport): void
    drop(connId: string): void                  // stop-looking is reported after DROP_GRACE_MS unless the chat is looked at again
    lookingAt(chatId: string): boolean
    inputSince(chatId: string, t: number): boolean // any connection on chatId with lastInputAt > t
    lookedAt(): Record<string, number>          // last time each chat was looked at
    connsOf(deviceId: string): string[]         // newest last
    deviceOf(connId: string): string | null
  }
  ```

- [ ] **Step 1: Write the failing tests** with a fake clock and fake timers:
  - After `update('c1', {deviceId:'d1', chatId:'x', looking:true, inputAgoMs:0})`, `lookingAt('x')` is true and `onStarted('x')` is called once.
  - Moving to `chatId:'y'` calls `onStopped('x')` and `onStarted('y')`.
  - `looking:false` on the last looking connection calls `onStopped`. With two connections looking at `x`, one stopping doesn't call it.
  - `inputSince('x', 1000)`: true when the report came at now=5000 with `inputAgoMs: 2000` (input at 3000); false with `inputAgoMs: 4500`.
  - `drop('c1')` calls nothing at once. After 10 000 ms it calls `onStopped('x')`. If `update('c2', {…chatId:'x', looking:true})` arrives within the grace, nothing is called.
  - `connsOf('d1')` lists connections oldest first.
  - `lookedAt()['x']` is the last time `x` was looked at.

- [ ] **Step 2: Run, expecting failures.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/presence.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `presence.ts`.** Memory only.

- [ ] **Step 4: Run, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/presence.test.ts`
  Expected: PASS.

---

### Task 6: Decisions and NotifyService

**Files:**
- Create: `zumi-bot-server/backend/src/core/notify/decide.ts`, `zumi-bot-server/backend/src/core/notify/notifyService.ts`
- Test: `zumi-bot-server/backend/tests/core/notifyDecide.test.ts`, `zumi-bot-server/backend/tests/core/notifyService.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  ```ts
  // decide.ts
  export function kindFor(t: NotifyToggles, kind: NotifyKind, cause: RoutineFailure['cause'] | null): NotifyPayloadKind | null
  export class RateCap { constructor(now: () => number); allow(deviceId: string, kind: NotifyPayloadKind): boolean }
  // notifyService.ts (TurnEnd, RoutineFailure come from shared/src/notify.ts)
  export interface NotifyServiceDeps {
    store: NotifyStore; presence: Presence; mode: ServerMode; subject(): string
    chats: { get(id: string): Promise<ChatMeta | null> }
    routines: { get(id: string): Promise<Routine | null> }
    routineOfChat(chatId: string): string | null
    sessionValid(key: string): Promise<boolean>
    sendTo(connId: string, e: RpcEvent): boolean
    broadcast(e: RpcEvent): void
    send: (o: Omit<Parameters<typeof sendPush>[0], 'fetch' | 'now' | 'sleep'>) => Promise<{ outcome: PushOutcome; status: number | null }>
    now(): number
    log(line: string): void
  }
  export class NotifyService {
    constructor(d: NotifyServiceDeps)
    chatPush(p: ChatPush): void                 // 'approvals' only
    turnEnded(e: TurnEnd): void
    routineFailed(e: RoutineFailure): void
    chatRemoved(chatId: string): void
    sessionEnded(key: string | 'all'): void
    started(chatId: string): void               // Presence.onStarted
    stopped(chatId: string): void               // Presence.onStopped
    test(deviceId: string): Promise<'sent' | 'none'>
    state(): NotifyState
  }
  ```

- [ ] **Step 1: Write the failing `decide` tests.**
  - `kindFor`:
    - Off toggles give `null`.
    - `routine-failed` with cause `'turn'` gives `routine-failed` when `routineFailed` is on, `'error'` when only `error` is on, and `null` when both are off.
    - `routine-failed` with cause `'user'` or `'restart'` gives `null`.
  - `RateCap`:
    - 10 `replied` are allowed and the 11th is refused within 60 s.
    - `waiting` is always allowed.
    - After the clock passes 60 s, it allows again.
    - Each device is counted separately.

- [ ] **Step 2: Write the failing `NotifyService` tests.** Fakes:
  - an in-memory store
  - a real `Presence` with fake timers
  - `send` recording targets and payloads
  - `sendTo` and `broadcast` recording events
  - chat `c1`: `{ title: 'Fix login', agentName: 'news' }`

  Cases:
  - **Waiting:**
    - `chatPush({chatId:'c1', kind:'approvals', pending:1, agent:'news'})` sends a push to each push device whose `waiting` toggle is on.
    - Payload: `{ kind:'waiting', tag:'chat:c1:waiting', chatId:'c1', title:'Fix login', agent:'news' }`.
    - Pushes again on a rise to 2, and not on a fall to 1.
  - **Clear on answer:** a fall to 0 broadcasts `{event:'notify:clear', payload:{chatId:'c1', waitingOnly:true}}`.
  - **Desktop:** a desktop device gets `sendTo(<newest conn of that device>, {event:'notify:show', payload})` exactly once when it has two connections. With no connection, nothing is sent.
  - **Looking:**
    - While any connection is looking at `c1`, `waiting` and `replied` for `c1` send nothing to any device.
    - `replied` for `c2` still goes out.
    - Calling `started('c1')` broadcasts `notify:clear` with `waitingOnly:false`.
  - **Held events:**
    - An event held while looking is sent when `stopped('c1')` fires and no input came after its `at`.
    - It's dropped when `inputSince` is true.
    - A held `waiting` is dropped if pending is 0 by then.
    - A held event for a chat whose `chats.get` now returns null is dropped (Review Focus 5).
    - `chatRemoved('c1')` drops its held events and pending count, and broadcasts `notify:clear` with `waitingOnly:false`.
  - **Turn ends:**
    - `turnEnded({outcome:'ok'})` → `replied`.
    - `'error'` → `error`.
    - `'stopped'` → nothing.
    - `'error'` while `routineOfChat('c1')` returns `'r1'` → nothing (the routine failure follows).
  - **Routine slots:** `routineOfChat` returns `r1`, and routine `r1` has target `{kind:'new-chat'}` → tag `routine:r1`. With target `{kind:'chat'}` → tag `chat:c1`.
  - **Routine failures:**
    - `routineFailed({cause:'turn', chatId:'c1'})` with `routineFailed:false, error:true` toggles → an `error` payload.
    - Cause `'user'` or `'restart'` → nothing.
    - `chatId:null` → title = routine name, tag `routine:r1`.
  - **Rate cap:** the 11th `replied` in a minute to one device is not sent, and logs a line without the endpoint.
  - **Gone:** a `gone` outcome removes `push` from the record (`store.get(id).push === undefined`) and logs `push to "<label>" failed: 410`.
  - **Sessions:**
    - `sessionEnded('k1')` sends one `paused` push to devices bound to `k1` and sets `paused:true`. Later events send them nothing.
    - `sessionEnded('all')` pauses every push device.
    - An event for a device whose `sessionValid` is now false sends `paused` instead, once.
  - **Test:** `test(id)` ignores toggles and presence, and returns `'none'` for an unknown device.
  - **State:** `state()` returns pending counts per chat and `presence.lookedAt()`.
  - **Failures:** a throwing `send` or `chats.get` never throws out of any public method.
  - **Local mode:** `mode:'local'` never calls `send` and never calls `store.vapid()`.

- [ ] **Step 3: Run, expecting failures.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/notifyDecide.test.ts zumi-bot-server/backend/tests/core/notifyService.test.ts`
  Expected: FAIL.

- [ ] **Step 4: Implement `decide.ts` and `notifyService.ts`.**
  - Every public method runs its async work inside `void work().catch(err => d.log(...))`.
  - Held events are kept per chat and tag, latest only.
  - Pending counts and held events live in memory.
  - `subject()` gives the VAPID `sub` (`config.origin`).

- [ ] **Step 5: Run, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/notifyDecide.test.ts zumi-bot-server/backend/tests/core/notifyService.test.ts`
  Expected: PASS.

---

### Task 7: Signals from chats, routines and sign-out

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`ChatServiceDeps`, `pushApprovals` at ~602, end of `agentTurn` at ~945)
- Modify: `zumi-bot-server/shared/src/types.ts:212` (`approvals` push gains `agent?: string`)
- Modify: `zumi-bot-server/backend/src/core/routines/routineRunner.ts` (`RoutineRunnerDeps`, `finish`, `finishById`, `settle`, `recover`, `run`)
- Modify: `zumi-bot-server/backend/src/auth/guard.ts:113-125` (`createGate` options)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`, `zumi-bot-server/backend/tests/core/routineRunner.test.ts`, `zumi-bot-server/backend/tests/auth/` (the existing logout test file)

**Interfaces:**
- Consumes: `TurnEnd` and `RoutineFailure` from `shared/src/notify.ts` (Task 1).
- Produces:
  - `ChatServiceDeps.onTurnEnd?(e: TurnEnd): void`. It is called once per `agentTurn`, after its `finally` block. It is never called for `spec.compact`. `agent` is `spec.author ?? spec.agentName`. `outcome` is `stopped` when `stopped` is true, else `ok` or `error`. A throw from it is caught.
  - The approvals push is `{ chatId, kind: 'approvals', pending, agent: spec.author ?? spec.agentName }`.
  - `RoutineRunnerDeps.onFailed?(e: RoutineFailure): void`, with these causes:
    - `'start'`: the cap's "Too many runs", the `run()` catch, the `submit` rejection
    - `'turn'`: `settle` with an error item
    - `'user'`: Stopped, Removed from the queue, Replaced by an edit or resend, Chat was deleted
    - `'restart'`: `settle`'s interrupted branch and `recover()`
  - `RoutineRunner.routineOfChat(chatId: string): string | null`: the `routineId` of an active run in that chat (the first one), else null.
  - `createGate({ …, sessionEnded?(key: string | 'all'): void })`, called inside the `closeSession` wrapper after the hubs close.

- [ ] **Step 1: Write the failing tests.**
  - `chatService.test.ts`:
    - `onTurnEnd` gets `{chatId, agent:'a', outcome:'ok'}` after a basic fixture turn.
    - It gets `'error'` for an error result.
    - It gets `'stopped'` after `stop()`.
    - It is not called for a compact run.
    - A throwing `onTurnEnd` leaves the turn's result unchanged.
    - The approvals push carries `agent`.
  - `routineRunner.test.ts`: each failure path calls `onFailed` once with the cause listed above. `routineOfChat` returns the routine id while its run is active, and null after it finishes.
  - Auth test: logout calls `sessionEnded(<sessionKeyOf(token)>)` and logout-all calls `sessionEnded('all')`.

- [ ] **Step 2: Run, expecting failures.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/backend/tests/core/routineRunner.test.ts zumi-bot-server/backend/tests/auth`
  Expected: the new tests FAIL.

- [ ] **Step 3: Implement the hooks.** In `routineRunner.ts`, pass `cause` through `finish`/`finishById` as a new last parameter, and call `onFailed` only when the status becomes `failed`.

- [ ] **Step 4: Run, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/backend/tests/core/routineRunner.test.ts zumi-bot-server/backend/tests/auth`
  Expected: PASS.

---

### Task 8: Hub, RPC handlers, API and wiring

**Files:**
- Modify: `zumi-bot-server/backend/src/rpc/hub.ts`
- Create: `zumi-bot-server/backend/src/rpc/notifyHandlers.ts`
- Modify: `zumi-bot-server/shared/src/rpc.ts`, `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.notify`)
- Modify: `zumi-bot-server/frontend/src/net/api.ts`
- Modify: `zumi-bot-server/backend/src/app.ts`
- Modify: `zumi-bot-server/backend/src/http/static.ts` (TYPES gains `'.webmanifest': 'application/manifest+json'`)
- Test: `zumi-bot-server/backend/tests/rpc/hub.test.ts` (existing file), `zumi-bot-server/backend/tests/rpc/notifyHandlers.test.ts`, `zumi-bot-server/backend/tests/http/` (existing static test)

**Interfaces:**
- Produces:
  ```ts
  // hub.ts
  export interface ConnInfo { id: string; sessionKey: string }
  export type ConnHandlers = Record<string, (conn: ConnInfo, ...args: unknown[]) => Promise<unknown>>
  createHub(handlers, o: { …existing; connHandlers?: ConnHandlers; onDisconnect?(connId: string): void })
  Hub.sendTo(connId: string, e: RpcEvent): boolean
  // shared/src/rpc.ts RpcEvent gains
  | { event: 'notify:show'; payload: NotifyPayload }
  | { event: 'notify:clear'; payload: { chatId: string; waitingOnly: boolean } }
  // ZumiBotApi.notify
  notify: {
    status(deviceId: string): Promise<NotifyStatus>
    enable(deviceId: string, o: { channel: NotifyChannel; label: string; subscription?: SubscriptionInput }): Promise<NotifyStatus>
    refresh(deviceId: string, subscription: SubscriptionInput | null): Promise<{ known: boolean }>
    disable(deviceId: string): Promise<NotifyStatus>
    remove(deviceId: string): Promise<NotifyStatus>          // another device
    setPrefs(deviceId: string, t: NotifyToggles): Promise<NotifyStatus>
    test(deviceId: string): Promise<'sent' | 'none'>
    presence(deviceId: string, chatId: string | null, looking: boolean, inputAgoMs: number): Promise<void>
    state(): Promise<NotifyState>
    onShow(cb: (p: NotifyPayload) => void): () => void
    onClear(cb: (p: { chatId: string; waitingOnly: boolean }) => void): () => void
  }
  ```
  - `SubscriptionInput` is imported from `shared/src/notify.ts` (Task 1). `subscription.ts` in Task 4 imports it from there too, rather than declaring its own.

- [ ] **Step 1: Write the failing tests.**
  - **Hub:**
    - A method in `connHandlers` gets `{id, sessionKey}`, with ids unique per socket.
    - `sendTo` reaches only that socket and returns false after it closes.
    - `onDisconnect(id)` fires on close.
    - Plain `handlers` still work.
    - A name present in both maps uses `connHandlers`.
  - **`notifyHandlers`**, against fakes:
    - Each method rejects a bad `deviceId` (`DEVICE_ID_RE`), bad toggles, a bad `inputAgoMs` (not a finite number ≥ 0), and a `chatId` that isn't a string or null.
    - `enable` with `channel:'push'` in local mode throws `Push is not available in Local mode`.
    - `enable` stores `push.sessionKey = conn.sessionKey`.
    - `refresh` for an unknown device returns `{known:false}` and creates nothing.
    - `refresh` rebinds `sessionKey` and clears `paused`.
    - `status` never contains `endpoint`, `p256dh`, `auth` or `sessionKey` (assert on `JSON.stringify`). It marks `current` for the asking device.
    - `presence` forwards to `Presence.update(conn.id, …)` and bumps `lastSeenAt` at most once a minute.
  - **Static:** `GET /manifest.webmanifest` gets `application/manifest+json`.

- [ ] **Step 2: Run, expecting failures.**
  Run: `npx vitest run --project backend -t "hub|notifyHandlers|static"`
  Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - **Wiring in `app.ts`:**
    - Build `NotifyStore(dataDir)`.
    - Build `Presence({ onStarted: (c) => notify.started(c), onStopped: (c) => notify.stopped(c), … })`.
    - Build `NotifyService({ subject: () => config.origin, sessionValid: config.mode === 'vps' ? (k) => auth.checkSessionKey(k) : async () => true, send: (o) => sendPush({ ...o, fetch, now: Date.now, sleep }), … })`.
  - **Calls into it:**
    - `push` calls `notify.chatPush(payload)`.
    - `ChatService` gets `onTurnEnd: (e) => notify.turnEnded(e)`.
    - `RoutineRunner` gets `onFailed: (e) => notify.routineFailed(e)`.
    - `createGate` gets `sessionEnded: (k) => notify.sessionEnded(k)`.
    - Chat deletion calls `notify.chatRemoved(id)`, wherever `runner.chatRemoved` is called today.
    - The hub gets `connHandlers: createNotifyHandlers(...)` and `onDisconnect: (id) => presence.drop(id)`.
  - Add `notify` to `ZumiBotApi` and `net/api.ts` (`onShow`/`onClear` through `rpc.on`).
  - `testOrigin` comes from `devEnv('ZUMIBOT_TEST_PUSH_ORIGIN') ?? null`.

- [ ] **Step 4: Run the tests and the typecheck, expecting a pass.**
  Run: `npx vitest run --project backend && npm run typecheck`
  Expected: PASS.

---

### Task 9: Sync keeps notify files on each side

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs:22` (`PULL_EXCLUDES`)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

**Interfaces:**
- Produces: `PULL_EXCLUDES` contains `--exclude=notify-devices.json` and `--exclude=notify-vapid.json`. The upload list (`sources`, ~428) and the swap's `for f in …` line stay without them.

- [ ] **Step 1: Write the failing test** next to the `auth.json` cases (~230/286):
  - `notify-devices.json` and `notify-vapid.json` written on the VPS side never appear in the PC's data dir, nor in the sync's temp `vps` folder.
  - Written on the PC side, they never appear on the VPS.
  - Each side's own copy is unchanged after sync (same bytes, same mode).

- [ ] **Step 2: Run, expecting a failure.**
  Run: `npx vitest run zumi-bot-server/backend/tests/sync.test.ts`
  Expected: the new test FAILS.

- [ ] **Step 3: Add both names to `PULL_EXCLUDES`,** and extend the comment above it in the same why-style ("each side keeps its own push keys and subscriptions, like auth.json").

- [ ] **Step 4: Run, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/backend/tests/sync.test.ts`
  Expected: PASS.

---

### Task 10: Frontend pure state

**Files:**
- Create: `zumi-bot-server/frontend/src/state/notifications.ts`
- Test: `zumi-bot-server/frontend/tests/notifications.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LOOK_IDLE_MS = 180_000
  export const INPUT_REPORT_MS = 30_000
  export function waitingChats(pendingByChat: Record<string, number>): number
  export function badgeTitle(base: string, waiting: number): string           // '(2) ZumiBot' | 'ZumiBot'
  export function showDot(waiting: number): boolean
  export function isLooking(s: { visible: boolean; focused: boolean; chatId: string | null; lastInputAt: number; now: number }): boolean
  export interface SentPresence { chatId: string | null; looking: boolean; at: number; inputAt: number }
  export function presenceToSend(prev: SentPresence | null, next: { chatId: string | null; looking: boolean; lastInputAt: number; now: number }): boolean
  export interface ShownNotification { tag: string; chatId: string | null; kind: NotifyPayloadKind; at: number }
  export function staleTags(shown: readonly ShownNotification[], s: NotifyState): string[]
  export function deviceLabel(ua: string, desktop: boolean): string
  export function deviceIdFrom(storage: { getItem(k: string): string | null; setItem(k: string, v: string): void }, newId: () => string): string // key 'zumibot.deviceId'
  ```

- [ ] **Step 1: Write the failing tests.**
  - **Title and dot:**
    - `waitingChats({a:2, b:1, c:0})` → 2.
    - `badgeTitle('ZumiBot', 0)` → `'ZumiBot'`.
    - `badgeTitle('ZumiBot', 3)` → `'(3) ZumiBot'`.
    - `showDot(0)` false, `showDot(1)` true.
  - **`isLooking`:**
    - Needs `visible && focused && chatId !== null && now - lastInputAt < 180_000`.
    - Exactly 180 000 ms is false.
  - **`presenceToSend`:**
    - True on the first call, a chat change or a looking change.
    - True when looking, `lastInputAt > prev.inputAt` and `now - prev.at >= 30_000`.
    - False for new input within 30 s of the last send.
  - **`staleTags`:**
    - A `waiting` notification closes when `s.pending[chatId]` is 0 or missing.
    - Any kind closes when `s.lookedAt[chatId] > n.at`.
    - `test` and `paused` never close.
    - A notification with a null `chatId` stays.
  - **`deviceLabel`:**
    - Chrome on Android UA → `'Chrome on Android'`.
    - iPhone Safari UA → `'Safari on iPhone'`.
    - Firefox on Linux UA → `'Firefox on Linux'`.
    - `desktop:true` → `'ZumiBot desktop'`.
    - An unknown UA → `'Browser'`.
  - **`deviceIdFrom`:** returns the stored id, else stores and returns `newId()`. A throwing storage still returns `newId()`.

- [ ] **Step 2: Run, expecting failures.**
  Run: `npx vitest run zumi-bot-server/frontend/tests/notifications.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `state/notifications.ts`.**

- [ ] **Step 4: Run, expecting a pass.**
  Run: `npx vitest run zumi-bot-server/frontend/tests/notifications.test.ts`
  Expected: PASS.

---

### Task 11: Service worker, manifest and the page side

**Files:**
- Create:
  - `zumi-bot-server/frontend/src/sw/sw.ts`
  - `zumi-bot-server/frontend/tsconfig.sw.json`: lib `["ES2022","WebWorker"]`, include `src/sw/**/*` and `../shared/src/notify.ts`
  - `zumi-bot-server/frontend/vite.sw.config.ts`: entry `src/sw/sw.ts` → `dist/sw.js`, `format: 'iife'`, `emptyOutDir: false`, no hash
  - `zumi-bot-server/frontend/public/manifest.webmanifest`
  - `zumi-bot-server/frontend/public/icon-192.png`, `zumi-bot-server/frontend/public/icon-512.png`: made from the app icon, `public/favicon.png` or the desktop shell's icon, at those exact sizes
  - `zumi-bot-server/frontend/src/net/push.ts`
  - `zumi-bot-server/frontend/src/useNotifications.ts`
  - `zumi-bot-server/frontend/src/components/NotificationsDialog.tsx`
- Modify:
  - `zumi-bot-server/frontend/tsconfig.json`: exclude `src/sw`
  - `zumi-bot-server/frontend/package.json`: `build: "vite build && vite build -c vite.sw.config.ts"`, `typecheck: "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.sw.json"`
  - `zumi-bot-server/frontend/index.html`: `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">`, `<link rel="apple-touch-icon" href="/icon-192.png">`, `<meta name="theme-color" …>`
  - `zumi-bot-server/frontend/src/App.tsx`: call `useNotifications`
  - `zumi-bot-server/frontend/src/components/AccountMenu.tsx`: a **Notifications…** item, `data-testid="notify-settings"`, after **Jev decisions…**

**Interfaces:**
- Consumes: Tasks 1, 8 and 10.
- Produces:
  - `sw.ts`:
    - `install` runs `skipWaiting`; `activate` runs `clients.claim`.
    - `push` parses with `isPayload`. An invalid payload still shows `notifyText` of a `test`-like fallback, because a push must show something. It merges `data.agents` from an existing notification with the same tag (`mergeAgents`), and shows `{ tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { chatId, kind, at, agents } }`.
    - `notificationclick` closes the notification. Then, for a focused or first window client, it calls `client.focus()` and `client.postMessage({ type: 'open-chat', chatId })`; with no client, it calls `clients.openWindow('/chat/' + encodeURIComponent(chatId))`. When `chatId` is null, it opens `/`.
    - No `fetch` listener and no `actions`.
  - `push.ts`:
    - `registerWorker(): Promise<ServiceWorkerRegistration | null>`
    - `currentSubscription(reg): Promise<SubscriptionInput | null>`
    - `subscribe(reg, vapidPublicKey): Promise<SubscriptionInput>`
    - `unsubscribe(reg): Promise<void>`
    - `shownNotifications(reg): Promise<ShownNotification[]>`
    - `closeTags(reg, tags): Promise<void>`
    - `pushSupport(): 'ok' | 'unsupported' | 'ios-needs-install' | 'denied'`
  - `useNotifications({ api, openChatFromNotification(chatId: string): void, viewChatId: string | null, pendingByChat })`:
    - Owns the device id.
    - Sends presence through `presenceToSend`: on visibility, focus/blur, chat change and input (keydown, pointerdown, touchstart, wheel), plus a 30 s check. It re-sends after `rpc` reconnects (`onStatus('connected')`).
    - Sets `document.title` with `badgeTitle` and swaps the favicon `<link>` to a canvas-drawn `data:` URL with an amber dot.
    - Seeds pending counts from `api.notify.state()` on load and on reconnect, merged with the push counts.
    - On `notify:clear`, closes this device's matching notifications.
    - On visible, closes `staleTags`.
    - On page load, calls `refresh` for push devices. When the result is `{known:false}`, it unsubscribes locally.
    - In the shell, routes `notify:show` to `desktop.notify`.
    - Routes service worker `open-chat` messages and `desktop.onNotificationClick` to `openChatFromNotification`.
    - Registers the worker only in a browser (no `window.zumibotDesktop`) on the VPS.
  - `NotificationsDialog`, in the `JevDialog` layout, with these `data-testid`s:
    - `notify-state`
    - `notify-enable`
    - `notify-disable`
    - `notify-toggle-<waiting|replied|error|routineFailed>`
    - `notify-test`
    - `notify-device-row` (with `data-device-id`)
    - `notify-device-remove`
  - Dialog text:
    - States: On, Off, Blocked by the browser, Not supported, `On iPhone, add ZumiBot to the Home Screen first`, `Paused: signed out`.
    - In a shell without `notify`: `Update the desktop app to get notifications`.
    - Local mode shows no push wording.

- [ ] **Step 1: Write the service worker, the manifest and the build config.**

- [ ] **Step 2: Check that the worker bundles and type-checks.**
  Run: `npm run build:server && ls zumi-bot-server/backend/dist/web/sw.js zumi-bot-server/backend/dist/web/manifest.webmanifest && npm run typecheck`
  Expected: both files are listed and the typecheck passes. `grep -c "import " zumi-bot-server/backend/dist/web/sw.js` prints `0` (an IIFE with no imports).

- [ ] **Step 3: Write `push.ts`, `useNotifications.ts`, the dialog, the account menu item, the `index.html` links and the `App.tsx` call.**
  - `openChatFromNotification` uses the same path a `/chat/<id>` address takes (`setRouteChat`), so a missing chat falls back to the empty view.

- [ ] **Step 4: Run the full checks.**
  Run: `npm test && npm run typecheck && npm run build:server`
  Expected: PASS.

- [ ] **Step 5: Look at it in a real browser.**
  - Run `npm run shot`, or start the built server in VPS mode with the e2e harness, and confirm:
    - the tab title is `ZumiBot`
    - the dialog opens from the account menu
    - the CSP blocks nothing (no console CSP errors for `sw.js` or the manifest)
  - Then kill the server and Chrome.

---

### Task 12: Desktop shell bridge

**Files:**
- Modify: `zumi-bot-server/shared/src/desktop.ts`
- Create: `zumi-bot-desktop/src/main/notifications.ts`
- Modify: `zumi-bot-desktop/src/main/index.ts` (IPC next to `desktop:setTheme`), `zumi-bot-desktop/src/preload/index.ts`
- Test: `zumi-bot-desktop/tests/notifications.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/src/desktop.ts: all optional, like sync?
  export interface DesktopNotification { tag: string; chatId: string | null; kind: NotifyPayloadKind; title: string; body: string }
  notify?(n: DesktopNotification): void
  closeNotifications?(chatId: string, waitingOnly: boolean): void
  onNotificationClick?(cb: (chatId: string | null) => void): () => void
  // zumi-bot-desktop/src/main/notifications.ts
  export interface NotificationLike { show(): void; close(): void; on(e: 'click', cb: () => void): void }
  export function createDesktopNotifier(o: { create(opts: { title: string; body: string; silent: boolean }): NotificationLike; onClick(chatId: string | null): void }): {
    show(n: DesktopNotification): void
    close(chatId: string, waitingOnly: boolean): void
  }
  export function checkDesktopNotification(v: unknown): DesktopNotification | null // strings ≤ 200 chars, known kind
  ```
  - IPC channels: `desktop:notify` and `desktop:closeNotifications` (renderer → main, checked with `fromApp(e)`), and `desktop:notificationClick` (main → renderer).
  - A click calls `shell.win.show()`, then `focus()`, then sends `desktop:notificationClick`.

- [ ] **Step 1: Write the failing tests** with a fake `create`:
  - Showing tag `chat:c1` twice closes the first notification before showing the second.
  - `close('c1', true)` closes only the `waiting` one for `c1`. `close('c1', false)` closes all of `c1`'s.
  - A click calls `onClick('c1')` and drops the reference.
  - `checkDesktopNotification` rejects an unknown kind, a non-string title, and a title over 200 characters.

- [ ] **Step 2: Run, expecting failures.**
  Run: `npx vitest run zumi-bot-desktop/tests/notifications.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement the notifier,** with Electron's `Notification` behind `create`, then the IPC and the preload.
  - Leave `isPermissionAllowed` as it is: the HTML5 permission stays refused.
  - `useNotifications` (Task 11) builds `title`/`body` with `notifyText` and merges agents per tag before calling `desktop.notify`.

- [ ] **Step 4: Run the tests, the typecheck and the shell's e2e, expecting a pass.**
  Run: `npx vitest run --project zumibot && npm run typecheck && npm run e2e:desktop`
  Expected: PASS. Kill any leftover Electron processes afterward.

---

### Task 13: `e2e:notifications`

**Files:**
- Create: `zumi-bot-server/e2e/notifications.e2e.mjs`
- Modify: root `package.json`: `"e2e:notifications": "npm run build && node zumi-bot-server/e2e/notifications.e2e.mjs"`

**Interfaces:**
- Consumes: `start({ mode: 'vps', fake: true, env: { ZUMIBOT_TEST_PUSH_ORIGIN } })` and `unexpectedErrors` from `harness.mjs`; the fake claude's `can_use_tool` + `#WAIT_RESPONSE` script lines (as in `routines.e2e.mjs`); the `data-testid`s from Task 11.

- [ ] **Step 1: Write the suite.**
  - **Header:** a comment block in the style of `routines.e2e.mjs`: hard rules, the DOM hooks it relies on, the stored state it reads, a 3-minute overall timeout, and `finally` stopping the server, Chrome and the fake push server.
  - **Fake push server:** a `node:http` server on `127.0.0.1:<freePort>` that records `{ path, headers, body }`. It answers 201, or 410 for paths marked gone.
  - **Steps:**
    1. Grant notification permission with `context.grantPermissions(['notifications'], { origin })`, which goes through CDP `Browser.grantPermissions`.
    2. Make a P-256 key pair and a 16-byte auth secret in Node.
    3. Read the page's device id from `localStorage['zumibot.deviceId']`.
    4. Register the device by running, in the page, a raw `/ws` RPC call: `notify:enable(deviceId, { channel: 'push', label: 'e2e', subscription: { endpoint: '<fake>/d1', keys } })`. Headless Chrome can't make a real FCM subscription.
    5. Send a message whose text is `'Notify check ' + MARKER` with `MARKER` placed after character 60, while the page shows the chat. Wait for the approval card.
    6. Assert no push arrives within 2 s: the tab is looking.
    7. Navigate to `/`. Within 15 s one push arrives:
       - headers `Content-Encoding: aes128gcm`, `Urgency: high`, `TTL: 43200`
       - a 32-character `Topic`
       - a `vapid` Authorization whose JWT verifies with `k` and has `aud` equal to the fake origin
    8. Decrypt the body with an RFC 8291 decrypt written in the e2e file:
       - `Object.keys` ⊆ `['v','kind','tag','chatId','title','agent','at']`
       - `kind:'waiting'`
       - `tag` = `chat:<id>:waiting`
       - `title` equals the chat title
       - `MARKER` appears nowhere in the decrypted JSON, the headers or the path
    9. Assert `document.title === '(1) ZumiBot'`.
    10. Service worker:
        - Enable CDP `ServiceWorker` and get the `registrationId`.
        - `ServiceWorker.deliverPushMessage` with the decrypted JSON.
        - `(await navigator.serviceWorker.ready).getNotifications()` has one with tag `chat:<id>:waiting`.
    11. Open the chat and answer the card (`approval-allow-once`):
        - `getNotifications()` becomes empty (cleared by look or answer).
        - The title goes back to `ZumiBot`.
    12. Click `notify-test` in the dialog. A push with `kind:'test'` and `TTL: 60` arrives.
    13. Mark the path gone and click `notify-test` again. `notify-devices.json` no longer has `push` for the device, and its mode is `0o600`.
    14. Assert `unexpectedErrors(h.errors, [...])` is empty. The allow-list holds only known noise, with each entry justified.

- [ ] **Step 2: Run it.**
  Run: `npm run e2e:notifications`
  Expected: every step prints `ok …` and the exit code is 0. Afterwards `pgrep -f "chrome.*cb-e2e-"` and `pgrep -f "server.mjs"` print nothing from this run; kill any leftovers.

---

### Task 14: Docs and final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CLAUDE.md`:**
  - **Commands:** add `e2e:notifications` to the e2e list, with the fact that it uses only the fake claude and a local fake push endpoint, so it costs no quota.
  - **Architecture:** a new **Notifications (`core/notify/`)** paragraph covering:
    - events, slots and tags, presence and held events, devices and their channels
    - session-bound push devices
    - the hand-rolled RFC 8291/8292 code
    - `/sw.js` and the manifest behind the gate, with `crossorigin="use-credentials"`
    - the shell's optional `notify` bridge, and why older shells can't notify
  - **Data:** add `notify-devices.json` and `notify-vapid.json`, both 0600, never synced. Add them to the sync paragraph's "stays on each side" list, next to `auth.json`.

- [ ] **Step 2: Run the full verification.**
  Run: `npm test && npm run typecheck && npm run e2e:notifications && npm run e2e:sync && npm run e2e:routines`
  Expected: all PASS. Then confirm no Chrome, Electron or `server.mjs` processes started by these runs are left.
