// End-to-end check of notifications in the built server + web UI (VPS mode) against the FAKE claude: no real CLI turn is
// ever sent, so no login or quota is used. Usage: npm run e2e:notifications   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome and the fake push server started here are stopped in `finally`; overall timeout 3 min.
// Headless Chrome cannot make a real FCM subscription, so the page's own device id is enabled by a raw /ws RPC call
// with a subscription pointing at a local fake push service (ZUMIBOT_TEST_PUSH_ORIGIN) and keys made here. Every push
// it records is decrypted (RFC 8291) and its VAPID JWT verified here. The tool request comes from a can_use_tool
// control_request plus #WAIT_RESPONSE in the fake claude's script.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, approval-card (+ data-status), approval-allow-once, sidebar-user, settings-open,
//   settings-nav-notifications, settings-notifications, notify-test, notify-note.
// Stored state read: <dataDir>/chats.json, <dataDir>/notify-devices.json, <dataDir>/notify-vapid.json.

import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort, start, unexpectedErrors } from './harness.mjs'

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const AGENT = 'e2e-notify-agent'
const PREFIX = 'zumibot-e2e-notify-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000
const MARKER = 'ZEBRA-7731-SECRET'
// The chat title keeps the first 60 characters, so the marker past them must never leave the server.
const TEXT = `Notify check ${'padding '.repeat(7)}${MARKER}`
const ALLOWED = ['v', 'kind', 'tag', 'chatId', 'title', 'agent', 'at']

let h = null
let push = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const readJson = (name) => readFile(join(h.dataDir, name), 'utf8').then(JSON.parse)
const modeOf = async (name) => (await stat(join(h.dataDir, name))).mode & 0o777

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
  if (h) {
    const cur = h
    const pid = cur.server.pid
    h = null
    await Promise.race([cur.stop().catch(() => {}), sleep(30_000)])
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  if (push) {
    const p = push
    push = null
    p.server.closeAllConnections()
    await new Promise((r) => p.server.close(r))
  }
}

// ---------- the fake push service: records every request, 201, or 410 for paths marked gone ----------
async function startPushServer() {
  const port = await freePort()
  const got = []
  const gone = new Set()
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      got.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(gone.has(req.url) ? 410 : 201).end()
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${port}`, server, got, gone }
}

// ---------- RFC 8291 decrypt and RFC 8292 VAPID check, kept apart from the code under test ----------
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16)
  const idLen = body[20]
  const asPublic = body.subarray(21, 21 + idLen)
  const ct = body.subarray(21 + idLen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const uaPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  assert(plain[plain.length - 1] === 2, 'the push record does not end with the last-record delimiter')
  return plain.subarray(0, plain.length - 1).toString('utf8')
}

function verifyVapid(authorization, aud) {
  const m = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization ?? '')
  assert(m, 'the Authorization header is not "vapid t=<jwt>, k=<key>"')
  const [head, claims, sig] = m[1].split('.')
  const pub = Buffer.from(m[2], 'base64url')
  assert(pub.length === 65 && pub[0] === 4, 'the VAPID k is not an uncompressed P-256 point')
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk'
  })
  assert(
    verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')),
    'the VAPID JWT signature does not verify with k'
  )
  const hdr = JSON.parse(Buffer.from(head, 'base64url').toString())
  const c = JSON.parse(Buffer.from(claims, 'base64url').toString())
  assert(hdr.alg === 'ES256', `the VAPID JWT alg is ${hdr.alg}`)
  assert(c.aud === aud, `the VAPID JWT aud is ${c.aud}, not the push origin`)
  assert(c.exp > Date.now() / 1000, 'the VAPID JWT has already expired')
  return m[2]
}

// One raw RPC over a fresh /ws socket from the page, so the session cookie rides along.
const rpc = (page, method, ...args) =>
  page.evaluate(
    async ({ method, args }) => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`)
      await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error('the socket did not open')))))
      try {
        return await new Promise((res, rej) => {
          ws.onmessage = (e) => {
            const m = JSON.parse(e.data)
            if (m.id === 1) m.ok ? res(m.value) : rej(new Error(m.error))
          }
          ws.send(JSON.stringify({ id: 1, method, args }))
        })
      } finally {
        ws.close()
      }
    },
    { method, args }
  )

const shownTags = (page) => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.tag))

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const pickDir = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Notifications e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  push = await startPushServer()
  h = await start({
    mode: 'vps',
    fake: true,
    dataDir,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: pickDir, ZUMIBOT_TEST_PUSH_ORIGIN: push.origin }
  })
  const page = h.page
  const agentRow = page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
  await agentRow.waitFor({ timeout: 30_000 })

  // 1. permission, over CDP Browser.grantPermissions
  await h.context.grantPermissions(['notifications'], { origin: h.origin })
  assert((await page.evaluate(() => Notification.permission)) === 'granted', 'notification permission was not granted')
  ok('notification permission granted')

  // 2. the subscription keys a browser would make
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = randomBytes(16)
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
  ok('P-256 key pair and 16-byte auth secret made')

  // 3. the page's own device id, so its presence applies to the device pushed to
  await waitFor(() => page.evaluate(() => localStorage.getItem('zumibot.deviceId') !== null), T, 'the page to store its device id')
  const deviceId = await page.evaluate(() => localStorage.getItem('zumibot.deviceId'))
  assert(/^[A-Za-z0-9-]{8,64}$/.test(deviceId), `the device id has the wrong shape: ${deviceId}`)
  await page.evaluate(() => navigator.serviceWorker.ready)
  ok('device id read and the service worker is ready')

  // 4. enable that device with the fake subscription
  const endpoint = `${push.origin}/d1`
  const status = await rpc(page, 'notify:enable', deviceId, { channel: 'push', label: 'e2e', subscription: { endpoint, keys } })
  const me = status.devices.find((d) => d.id === deviceId)
  assert(me && me.subscribed && !me.paused, 'the enabled device is not listed as subscribed')
  assert(
    !JSON.stringify(status).includes(endpoint) && !JSON.stringify(status).includes(keys.p256dh),
    'the status leaks the endpoint or keys'
  )
  ok('device enabled by raw RPC; the status shows no endpoint or keys')

  // 5. a chat whose turn asks for a tool; the pause lets the tab's presence land before the request
  await writeFile(
    h.script,
    (await readFile(BASIC, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .flatMap((line) =>
        JSON.parse(line).type === 'stream_event' && JSON.parse(line).event?.delta?.type === 'text_delta'
          ? [
              '#SLEEP 1500',
              JSON.stringify({
                type: 'control_request',
                request_id: 'req-e2e-notify',
                request: {
                  subtype: 'can_use_tool',
                  tool_name: 'Bash',
                  input: { command: 'ls' },
                  description: 'List files',
                  decision_reason: 'needs approval',
                  tool_use_id: 'toolu_e2e'
                }
              }),
              '#WAIT_RESPONSE req-e2e-notify',
              line
            ]
          : [line]
      )
      .join('\n') + '\n'
  )
  assert(TEXT.indexOf(MARKER) >= 60, 'the marker must sit past the 60 title characters')
  await agentRow.click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).click()
  await page.locator(tid('composer-input')).fill(TEXT)
  await page.locator(tid('send-button')).click()
  await page.waitForURL(/\/chat\//, { timeout: T })
  const chatId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
  await page.locator(tid('approval-card')).last().waitFor({ timeout: 30_000 })
  assert(await page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus()), 'the tab is not visible and focused')
  ok(`chat ${chatId} waits on an approval card`)

  // 6. the tab is looking at the chat: nothing buzzes
  await sleep(2_000)
  assert(push.got.length === 0, `a push arrived while the tab looked at the chat (${push.got.length})`)
  ok('no push within 2 s while the tab looks at the chat')

  // 7. leave without input (a click would count as having seen it); the held event goes after the 10 s grace
  await page.goto(`${h.origin}/`)
  await waitFor(async () => push.got.length > 0, 20_000, 'the held push after leaving the chat')
  await sleep(1_000)
  assert(push.got.length === 1, `expected exactly one push, got ${push.got.length}`)
  const first = push.got[0]
  assert(first.method === 'POST' && first.path === '/d1', `the push went to ${first.method} ${first.path}`)
  assert(first.headers['content-encoding'] === 'aes128gcm', `Content-Encoding is ${first.headers['content-encoding']}`)
  assert(first.headers.urgency === 'high', `Urgency is ${first.headers.urgency}`)
  assert(first.headers.ttl === '43200', `TTL is ${first.headers.ttl}`)
  assert(/^[A-Za-z0-9_-]{32}$/.test(first.headers.topic ?? ''), `Topic is not 32 url-safe characters: ${first.headers.topic}`)
  const k = verifyVapid(first.headers.authorization, push.origin)
  assert(k === (await readJson('notify-vapid.json')).publicKey, 'the VAPID k is not the stored public key')
  ok('one push after leaving: aes128gcm, Urgency high, TTL 43200, 32-char Topic, VAPID JWT verifies')

  // 8. the payload: allowed fields only, and nothing past the title
  const json = decrypt(first.body, ua.getPrivateKey(), auth)
  const p = JSON.parse(json)
  const chat = (await readJson('chats.json')).chats.find((c) => c.id === chatId)
  assert(chat, 'the chat is not in chats.json')
  assert(
    Object.keys(p).every((key) => ALLOWED.includes(key)),
    `the payload has extra fields: ${Object.keys(p)}`
  )
  assert(p.v === 1 && p.kind === 'waiting' && p.chatId === chatId, `the payload is not a waiting push for the chat: ${json}`)
  assert(p.tag === `chat:${chatId}:waiting`, `the tag is ${p.tag}`)
  assert(p.title === chat.title, `the title "${p.title}" is not the chat title "${chat.title}"`)
  for (const [what, s] of [
    ['payload', json],
    ['headers', JSON.stringify(first.headers)],
    ['path', first.path]
  ])
    assert(!s.includes(MARKER), `the marker leaked into the ${what}`)
  ok('decrypted payload: allowed keys only, kind waiting, tag and title right, marker nowhere')

  // 9. the title badge, seeded from notify:state after the reload
  await waitFor(() => page.evaluate(() => document.title === '(1) ZumiBot'), T, 'the title to read (1) ZumiBot')
  ok('title reads (1) ZumiBot')

  // 10. the service worker shows it with the slot's tag
  const cdp = await h.context.newCDPSession(page)
  let registrationId = null
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    for (const r of registrations) if (!r.isDeleted && r.scopeURL === `${h.origin}/`) registrationId = r.registrationId
  })
  await cdp.send('ServiceWorker.enable')
  await waitFor(async () => registrationId !== null, T, 'the service worker registration id')
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: h.origin, registrationId, data: json })
  await waitFor(async () => (await shownTags(page)).includes(p.tag), T, `a shown notification tagged ${p.tag}`)
  await cdp.send('ServiceWorker.disable').catch(() => {})
  await cdp.detach().catch(() => {})
  ok(`the service worker shows a notification tagged ${p.tag}`)

  // 11. open the chat and answer: the notification and the badge go
  await page.goto(`${h.origin}/chat/${encodeURIComponent(chatId)}`)
  const card = page.locator(tid('approval-card')).last()
  await card.locator(tid('approval-allow-once')).click()
  await waitFor(async () => (await card.getAttribute('data-status')) === 'allowed-once', T, 'the card to read allowed once')
  await waitFor(async () => (await shownTags(page)).length === 0, T, 'the shown notifications to clear')
  await waitFor(() => page.evaluate(() => document.title === 'ZumiBot'), T, 'the title to read ZumiBot')
  ok('answering clears the notification and the title badge')

  // 12. Send test from Settings > Notifications
  const before = push.got.length
  await page.locator(tid('settings-open')).click()
  await page.locator(tid('settings-nav-notifications')).click()
  await page.locator(tid('settings-notifications')).waitFor({ timeout: T })
  const testBtn = page.locator(tid('notify-test'))
  await waitFor(() => testBtn.isEnabled(), T, 'Send test to be enabled')
  await testBtn.click()
  await waitFor(async () => push.got.length > before, T, 'the test push')
  const tested = push.got.at(-1)
  const tp = JSON.parse(decrypt(tested.body, ua.getPrivateKey(), auth))
  assert(tp.kind === 'test' && tp.tag === 'test' && tp.chatId === null, `the test push payload is wrong: ${JSON.stringify(tp)}`)
  assert(tested.headers.ttl === '60', `the test push TTL is ${tested.headers.ttl}`)
  verifyVapid(tested.headers.authorization, push.origin)
  ok('Send test pushes kind test with TTL 60')

  // 13. a 410 drops the push binding but keeps the device
  push.gone.add('/d1')
  const beforeGone = push.got.length
  await waitFor(() => testBtn.isEnabled(), T, 'Send test to be enabled again')
  await testBtn.click()
  await waitFor(async () => push.got.length > beforeGone, T, 'the push that gets a 410')
  await waitFor(
    async () => {
      const rec = (await readJson('notify-devices.json')).find((d) => d.id === deviceId)
      return rec !== undefined && rec.push === undefined
    },
    T,
    'the device record to lose its push binding'
  )
  assert(
    (await modeOf('notify-devices.json')) === 0o600,
    `notify-devices.json mode is ${(await modeOf('notify-devices.json')).toString(8)}`
  )
  assert((await modeOf('notify-vapid.json')) === 0o600, `notify-vapid.json mode is ${(await modeOf('notify-vapid.json')).toString(8)}`)
  ok('a 410 removes the push binding, the record stays; both notify files are 0600')

  // 14. nothing unexpected
  const bad = unexpectedErrors(h.errors, [
    // step 13's 410 is logged by design, with the label only (no endpoint)
    /server stderr: push to "e2e" failed: 410$/
  ])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('no unexpected console or server errors')
}

const timer = setTimeout(() => {
  console.error('FAIL overall timeout')
  void stop().finally(() => process.exit(1))
}, OVERALL_TIMEOUT)
timer.unref()

let failed = false
try {
  await main()
} catch (err) {
  failed = true
  console.error(`FAIL ${err instanceof Error ? err.message : err}`)
} finally {
  await stop()
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:notifications FAILED' : 'e2e:notifications passed')
process.exit(failed ? 1 : 0)
