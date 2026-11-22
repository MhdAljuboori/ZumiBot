// End-to-end check of Clone room in the built server + web UI (local mode) against the FAKE claude
// (backend/tests/fixtures/fake-clone-claude.mjs): no real CLI call is ever made, so no login or quota is used.
// Usage: npm run e2e:clone   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The rooms are made over a raw /ws RPC, so they are never placed in the sidebar: the clone must still land right under
// its source. A decoy room made after the source sits on top of the unplaced rooms, where an unplaced clone would go.
// What each member read is checked on the fake's invocation log (FAKE_INVOCATIONS_OUT); its summary call is answered
// with SUMMARY, or hangs while HANG_FILE exists.
//
// DOM hooks relied on (data-testid): unassigned-items, group-row (+ data-chat-id, data-item-key), chat-menu-clone,
//   clone-dialog (+ data-step), clone-name, clone-option-fresh, clone-option-summary, clone-create, clone-write,
//   clone-writing, clone-cancel, clone-text, handoff-card, composer-input, send-button, agent-turn, user-message.
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, <dataDir>/sidebar.json.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-clone-claude.mjs', import.meta.url))
const ALPHA = 'clone-alpha'
const BETA = 'clone-beta'
const ROLE = 'clone-alpha builds, clone-beta reviews.'
const SOURCE = 'Widget room'
const DRAFT_MARK = 'DRAFT-MARK-7Q'
const SUMMARY = `## Goal\nShip the widget (${DRAFT_MARK}).\n\n## Decisions\nNone\n\n## Current state\nNone\n\n## Who does what\nNone\n\n## Your preferences\nNone\n\n## Open items\nNone`
const EDITED = `${SUMMARY}\n\nEDITED-MARK`
const PREFIX = 'zumibot-e2e-clone-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000

let h = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
  if (!h) return
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

// One raw RPC over a fresh /ws socket from the page, so the auth cookie rides along.
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

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const invocations = async (file) =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const valueOf = (args, flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A room is done when nothing runs and its member's reply is stored.
async function waitRoomIdle(id, what) {
  await waitFor(
    async () => {
      const m = await metaOf(id)
      const items = await itemsOf(id)
      return (
        m &&
        !m.inFlight &&
        m.group.active.length === 0 &&
        m.group.queue.length === 0 &&
        items.some((i) => i.type === 'assistant' && i.agent === ALPHA && !i.turn)
      )
    },
    30_000,
    what
  )
}

const groupRow = (page, id) => page.locator(`${tid('group-row')}[data-chat-id="${id}"]`)
const unplacedOrder = (page) =>
  page
    .locator(tid('unassigned-items'))
    .evaluate((el) => [...el.querySelectorAll(':scope > [data-item-key]')].map((e) => e.getAttribute('data-item-key')))
const dialog = (page) => page.locator(tid('clone-dialog'))
const stepIs = (page, step) =>
  waitFor(
    async () =>
      (await dialog(page)
        .getAttribute('data-step')
        .catch(() => null)) === step,
    T,
    `the dialog step "${step}"`
  )

async function openClone(page, sourceId) {
  await groupRow(page, sourceId).click({ button: 'right' })
  await page.locator(tid('chat-menu-clone')).click()
  await dialog(page).waitFor({ timeout: T })
  await stepIs(page, 'choose')
}

// The id of the room the page opened, once it is a room other than the given ones.
async function openedRoom(page, not) {
  let id = null
  await waitFor(
    async () => {
      const m = /\/chat\/([^/?#]+)$/.exec(new URL(page.url()).pathname)
      id = m ? decodeURIComponent(m[1]) : null
      return id !== null && !not.includes(id)
    },
    T,
    'the new room to open'
  )
  return id
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const logs = await mk('logs')
  const invFile = join(logs, 'invocations.jsonl')
  const hangFile = join(logs, 'hang')
  for (const [name, desc] of [
    [ALPHA, 'Builds things.'],
    [BETA, 'Reviews things.']
  ]) {
    await writeFile(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\nmodel: haiku\n---\nYou are a test agent.\n`)
  }
  h = await start({
    fake: FAKE,
    dataDir,
    agentsDir,
    env: { FAKE_INVOCATIONS_OUT: invFile, FAKE_SUMMARY_HANG_FILE: hangFile, FAKE_SUMMARY_TEXT: SUMMARY }
  })
  const page = h.page
  await page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })

  // 0. the source room, one finished exchange, a fixed name; then a newer decoy room on top of the unplaced ones
  const src = (await rpc(page, 'chats:createGroup', [ALPHA, BETA], folder, ROLE)).id
  await rpc(page, 'chats:send', src, `@${ALPHA} hello there`, [])
  await waitRoomIdle(src, 'the source room to finish its exchange')
  await rpc(page, 'chats:rename', src, SOURCE)
  const decoy = (await rpc(page, 'chats:createGroup', [BETA, ALPHA], folder, '')).id
  await page.reload()
  await groupRow(page, src).waitFor({ timeout: T })
  await groupRow(page, decoy).waitFor({ timeout: T })
  const before = await unplacedOrder(page)
  assert(
    before[0] === `group:${decoy}` && before[1] === `group:${src}`,
    `the unplaced rows start ${JSON.stringify(before.slice(0, 2))}, not decoy then source`
  )
  const layout0 = await rpc(page, 'sidebar:get')
  assert(
    ![...layout0.unassigned, ...layout0.sections.flatMap((s) => s.items)].includes(`group:${src}`),
    'the source room already has a stored spot'
  )
  const srcBefore = JSON.stringify({ meta: await metaOf(src), items: await itemsOf(src) })
  ok(`source room ${src} ("${SOURCE}", 2 members, a role) with one exchange, never placed; decoy ${decoy} above it`)

  // 1. Start over: an empty room with the same members, role and folder, right under the source
  await openClone(page, src)
  assert(
    (await page.locator(tid('clone-name')).inputValue()) === `${SOURCE} (2)`,
    `the default name is ${JSON.stringify(await page.locator(tid('clone-name')).inputValue())}`
  )
  assert((await page.locator(tid('clone-option-fresh')).getAttribute('aria-pressed')) === 'true', 'Start over is not selected by default')
  await page.locator(tid('clone-create')).click()
  await dialog(page).waitFor({ state: 'detached', timeout: T })
  const fresh = await openedRoom(page, [src, decoy])
  const fm = await metaOf(fresh)
  assert(fm && fm.title === `${SOURCE} (2)`, `the new room is titled ${JSON.stringify(fm?.title)}`)
  assert(
    JSON.stringify(fm.group.members) === JSON.stringify([ALPHA, BETA]) && fm.group.role === ROLE && fm.cwd === folder,
    `the new room has ${JSON.stringify({ members: fm.group.members, role: fm.group.role, cwd: fm.cwd })}`
  )
  assert(fm.group.handoff === undefined, 'Start over stored a handoff')
  assert((await itemsOf(fresh)).length === 0, 'the new room has items')
  assert(
    (await page.locator(tid('user-message')).count()) === 0 && (await page.locator(tid('agent-turn')).count()) === 0,
    'the new room shows messages'
  )
  assert((await page.locator(tid('handoff-card')).count()) === 0, 'Start over shows a handoff card')
  await groupRow(page, fresh).waitFor({ timeout: T })
  await waitFor(
    async () => {
      const order = await unplacedOrder(page)
      return order.indexOf(`group:${fresh}`) === order.indexOf(`group:${src}`) + 1 && order[0] === `group:${decoy}`
    },
    T,
    'the new row to sit right under the source row'
  )
  await waitFor(
    async () => {
      const stored = await readFile(join(dataDir, 'sidebar.json'), 'utf8').then(JSON.parse, () => null)
      const u = stored?.unassigned ?? []
      return u.indexOf(`group:${fresh}`) === u.indexOf(`group:${src}`) + 1 && u.indexOf(`group:${src}`) >= 0
    },
    T,
    'the stored sidebar to place the new room right after the source'
  )
  ok(`1 Start over: ${fresh} "${SOURCE} (2)" opens empty with the same members, role and folder, its row right under the source`)

  // 2. With summary: the draft shows, the edit is what the room keeps and what its member reads
  await openClone(page, src)
  assert(
    (await page.locator(tid('clone-name')).inputValue()) === `${SOURCE} (3)`,
    `the default name is ${JSON.stringify(await page.locator(tid('clone-name')).inputValue())}`
  )
  await page.locator(tid('clone-option-summary')).click()
  const write = page.locator(tid('clone-write'))
  assert(
    ((await write.textContent()) ?? '').trim() === 'Write summary',
    `the summary button reads ${JSON.stringify(await write.textContent())}`
  )
  await write.click()
  await stepIs(page, 'review')
  const draft = await page.locator(tid('clone-text')).inputValue()
  assert(draft === SUMMARY, `the review box holds ${JSON.stringify(draft)}`)
  await page.locator(tid('clone-text')).fill(EDITED)
  await page.locator(tid('clone-create')).click()
  await dialog(page).waitFor({ state: 'detached', timeout: T })
  const summed = await openedRoom(page, [src, decoy, fresh])
  const card = page.locator(tid('handoff-card'))
  await card.waitFor({ timeout: T })
  const cardText = ((await card.textContent()) ?? '').replace(/\s+/g, ' ')
  assert(cardText.includes(`Handoff from ${SOURCE}`), `the card reads ${JSON.stringify(cardText)}`)
  const sm = await metaOf(summed)
  assert(
    sm.title === `${SOURCE} (3)` && sm.group.handoff?.text === EDITED,
    `the room stored ${JSON.stringify({ title: sm.title, handoff: sm.group.handoff })}`
  )
  assert(
    sm.group.handoff.from.chatId === src && sm.group.handoff.from.title === SOURCE,
    `the handoff is from ${JSON.stringify(sm.group.handoff.from)}`
  )
  const summaries = (await invocations(invFile)).filter((i) => i.kind === 'summary')
  assert(summaries.length === 1, `${summaries.length} summary calls`)
  const sargs = summaries[0].args
  for (const a of ['--model', 'sonnet', '--tools', '--setting-sources', '--strict-mcp-config', '--no-session-persistence'])
    assert(sargs.includes(a), `the summary call lacks ${a}`)
  assert(!sargs.includes('--agent') && !sargs.includes('--resume'), 'the summary call runs an agent or a session')

  await page.locator(tid('composer-input')).fill(`@${ALPHA} carry on`)
  await page.locator(tid('send-button')).click()
  await waitRoomIdle(summed, 'the cloned room to finish its first turn')
  const turns = (await invocations(invFile)).filter((i) => valueOf(i.args, '--agent') === ALPHA)
  const prompts = turns.map((i) => valueOf(i.args, '--append-system-prompt') ?? '')
  assert(turns.length === 2, `${turns.length} member turns of ${ALPHA}, not 2 (source, then clone)`)
  assert(!prompts[0].includes(DRAFT_MARK), "the source room's turn read a handoff")
  assert(
    prompts[1].includes('EDITED-MARK') && prompts[1].includes(`"${SOURCE}"`),
    "the cloned room's first turn did not read the edited handoff"
  )
  assert(
    prompts.every((p) => !p.includes(DRAFT_MARK) || p.includes('EDITED-MARK')),
    'a turn read the draft without the edit'
  )
  assert(!turns[1].args.includes('--resume'), "the cloned room's first turn resumed a session")
  ok(
    `2 With summary: the draft shows, the edit is stored, the card reads "Handoff from ${SOURCE}", and ${ALPHA}'s first turn there reads the edited text`
  )

  // 3. a summary that hangs: Writing summary… then Cancel goes back to choose, the call is killed, closing makes nothing
  await writeFile(hangFile, '')
  const listed = (await rpc(page, 'chats:list')).map((c) => c.id).sort()
  const rows = await page.locator(tid('group-row')).count()
  await openClone(page, src)
  await page.locator(tid('clone-option-summary')).click()
  await page.locator(tid('clone-write')).click()
  await stepIs(page, 'writing')
  await page.locator(tid('clone-writing')).getByText('Writing summary…').waitFor({ timeout: T })
  let hung = null
  await waitFor(
    async () => (hung = (await invocations(invFile)).find((i) => i.kind === 'summary' && i.hang)) !== undefined,
    T,
    'the hanging summary call to start'
  )
  assert(alive(hung.pid), 'the hanging summary call is not running')
  await page.locator(tid('clone-cancel')).click()
  await stepIs(page, 'choose')
  assert(((await page.locator(tid('clone-write')).textContent()) ?? '').trim() === 'Write summary', 'Cancel kept a draft')
  await waitFor(async () => !alive(hung.pid), T, 'Cancel to kill the summary call')
  await page.locator(tid('clone-cancel')).click()
  await dialog(page).waitFor({ state: 'detached', timeout: T })
  await sleep(500) // a room made by mistake would be pushed by now
  const after = (await rpc(page, 'chats:list')).map((c) => c.id).sort()
  assert(JSON.stringify(after) === JSON.stringify(listed), `the chat list changed: ${JSON.stringify(listed)} -> ${JSON.stringify(after)}`)
  assert((await page.locator(tid('group-row')).count()) === rows, 'the sidebar rows changed')
  await rm(hangFile, { force: true })
  ok('3 a hanging summary: Writing summary… shows, Cancel kills the call and goes back to choose, closing makes no room')

  // 4. usage: the summary's cost is recorded against the source room as the room handoff; the old room is untouched
  const usage = await rpc(page, 'usage:query', { from: null, to: null, agent: '#handoff', chatId: src, timeZone: 'UTC' })
  const row = usage.byAgent.find((r) => r.key === '#handoff')
  assert(
    row && row.label === 'Room handoff' && Math.abs(row.costUsd - 0.01) < 1e-9 && Math.abs(usage.exactUsd - 0.01) < 1e-9,
    `usage for the source room's handoff is ${JSON.stringify({ byAgent: usage.byAgent, exactUsd: usage.exactUsd })}`
  )
  const records = (await readFile(join(dataDir, 'usage-records.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const handoffs = records.filter((r) => r.kind === 'cost' && r.agent === '#handoff')
  assert(handoffs.length === 1 && handoffs[0].chatId === src, `handoff cost records: ${JSON.stringify(handoffs)}`)
  assert(JSON.stringify({ meta: await metaOf(src), items: await itemsOf(src) }) === srcBefore, 'cloning changed the source room')
  ok('4 usage:query has one Room handoff record ($0.01) for the source room; the source room is unchanged')

  // 5. nothing unexpected
  const bad = unexpectedErrors(h.errors, [])
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
console.log(failed ? 'e2e:clone FAILED' : 'e2e:clone passed')
process.exit(failed ? 1 : 0)
