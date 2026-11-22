// Real UI/server, fake remembered sessions only: no login or Claude quota.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'
import { SIDE_GUARD } from './btwProbe.mjs'
import { ipcDirsOf } from './e2eChecks.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-memory-claude.mjs', import.meta.url))
const A = 'btw-alpha'
const B = 'btw-other'
const tid = (id) => `[data-testid="${id}"]`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await mkdtemp(join(tmpdir(), 'zumibot-e2e-btw-'))
const audit = join(root, 'runs.jsonl')
let h
const log = (message) => console.log(`ok ${message}`)
async function until(fn, why, timeout = 25_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(30)
  }
  throw new Error(`Timed out: ${why}`)
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const runs = async () => (await readFile(audit, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
// Real turns only: --json-schema calls (moderator, and the ack line that carries the user's message) have no entries.
const turns = async () => (await runs()).filter((r) => !r.argv.includes('--json-schema'))
const chatId = (page) => new URL(page.url()).pathname.split('/').at(-1)
const sides = async (id) => (await readJson(join(h.dataDir, 'chats', `${id}.btw.json`))).items
const items = (id) => readJson(join(h.dataDir, 'chats', `${id}.json`))
const entryAt = (page, id) => page.locator(`${tid('side-entry')}[data-side-id="${id}"]`)
const threadView = (page, rootId) => page.locator(`${tid('side-thread')}[data-thread-id="${rootId}"]`)
const chip = (page, id) => page.locator(`.side-chip-row[data-side-id="${id}"] ${tid('side-chip')}`)
// The list and the thread both have a Back button; this is the thread's, which goes back to the list.
const threadBack = (page) =>
  page
    .locator(tid('side-panel'))
    .filter({ has: page.locator(tid('side-thread')) })
    .locator(tid('side-back'))
async function showList(page) {
  if (await page.locator(tid('side-thread')).count()) await threadBack(page).click()
  await page.locator(tid('side-input')).waitFor()
}
async function openThread(page, rootId) {
  if (await threadView(page, rootId).count()) return
  if (!(await page.locator(tid('side-panel')).count())) await openSides(page)
  await showList(page)
  await page.locator(`${tid('side-row')}[data-thread-id="${rootId}"]`).click()
  await threadView(page, rootId).waitFor()
}
// Only an open thread shows its entries: one not shown opens its thread (a follow-up names its root) first.
async function entry(page, id, root = id) {
  if (!(await entryAt(page, id).isVisible())) await openThread(page, root)
  return entryAt(page, id)
}
async function send(page, text) {
  await page.locator(tid('composer-input')).fill(text)
  await page.locator(tid('send-button')).click()
}
// The composer's /btw opens the new thread by itself.
async function ask(page, question) {
  const before = await sides(chatId(page)).catch(() => [])
  await send(page, `/btw ${question}`)
  // The file appears with the first entry; a poll before that finds none yet.
  const side = await until(
    async () => (await sides(chatId(page)).catch(() => [])).find((s) => !before.some((b) => b.id === s.id)),
    `accept ${question}`
  )
  await entryAt(page, side.id).waitFor()
  return side
}
async function state(page, side, value) {
  await entry(page, side.id, side.thread ?? side.id)
  await page.locator(`${tid('side-entry')}[data-side-id="${side.id}"][data-state="${value}"]`).waitFor()
}
async function folder(page) {
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
}
async function openSides(page) {
  await page.locator(tid('side-panel-toggle')).click()
  await page.locator(tid('side-open-sides')).click()
  await page.locator(tid('side-panel')).waitFor()
}
const picks = (page) =>
  page.locator(tid('side-pick')).evaluateAll((els) =>
    els.map((e) => ({
      key: e.dataset.pick,
      label: e.textContent.trim(),
      pressed: e.getAttribute('aria-pressed'),
      disabled: e.disabled,
      title: e.getAttribute('data-tip') ?? ''
    }))
  )
// Types into the list's box and presses Enter; returns the entries it made, in the order they were stored.
async function panelAsk(page, id, text, pick) {
  await showList(page)
  if (pick) await page.locator(`${tid('side-pick')}[data-pick="${pick}"]`).click()
  const before = await sides(id).catch(() => [])
  const box = page.locator(tid('side-input'))
  const failed = page.locator(tid('side-input-error'))
  // The chat's first side question writes its .btw.json only once it is stored.
  const fresh = async () => (await sides(id).catch(() => [])).filter((s) => !before.some((b) => b.id === s.id))
  await box.fill(text)
  await box.press('Enter')
  if (pick === 'both') {
    // Two asks stay on the list, the box cleared and focused for the next question.
    await until(
      async () => (await failed.count()) > 0 || ((await box.inputValue()) === '' && (await fresh()).length === 2),
      `panel ask ${text}`
    )
    assert.equal(await failed.count(), 0, `panel ask ${text} failed`)
    assert(await box.evaluate((el) => el === document.activeElement), 'focus stays in the side box')
    const made = await fresh()
    for (const side of made) await page.locator(`${tid('side-row')}[data-thread-id="${side.id}"]`).waitFor()
    assert.equal(await page.locator(tid('side-thread')).count(), 0, 'Both stays on the list')
    return made
  }
  // One ask opens its new thread, with the follow-up box taking the keyboard.
  const made = await until(async () => {
    if (await failed.count()) return 'failed'
    const found = await fresh()
    return found.length === 1 && (await threadView(page, found[0].id).count()) > 0 && found
  }, `panel ask ${text}`)
  assert.notEqual(made, 'failed', `panel ask ${text} failed`)
  assert(
    await page.locator(tid('side-follow-input')).evaluate((el) => el === document.activeElement),
    "focus moves to the new thread's follow-up box"
  )
  return made
}
// Rows are threads, newest first.
async function newestShown(page) {
  await showList(page)
  return page.locator(tid('side-row')).first().getAttribute('data-thread-id')
}
async function completed(page, text) {
  await page.locator('.bubble.assistant').filter({ hasText: text }).waitFor()
  await until(async () => (await page.locator(tid('send-button')).textContent()).trim() === 'Send', 'main idle')
}
try {
  const fixtureHome = join(root, 'fixture-home')
  await mkdir(fixtureHome)
  const fakeCall = (args, input) => {
    const r = spawnSync(process.execPath, [FAKE, ...args], {
      input,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, HOME: fixtureHome, FAKE_STEP_MS: '1', FAKE_MEMORY_LOG: '' }
    })
    assert.equal(r.status, 0, r.stderr || String(r.error))
    return r.stdout
  }
  const toolInput = JSON.stringify({ type: 'user', message: { content: '<btw>use a tool</btw>' } }) + '\n'
  fakeCall(['--no-session-persistence'], toolInput)
  assert(existsSync(join(fixtureHome, 'tool-ran.txt')), 'unguarded fixture must really create the marker')
  await rm(join(fixtureHome, 'tool-ran.txt'))
  const denied = fakeCall(['--no-session-persistence', '--settings', SIDE_GUARD], toolInput)
  assert(denied.includes('No tools in a side answer') && denied.includes('"is_error":true'))
  assert(!existsSync(join(fixtureHome, 'tool-ran.txt')))
  assert.deepEqual(await readdir(join(fixtureHome, '.fake-sessions')), [], 'no-session-persistence writes no session')
  assert.deepEqual(JSON.parse(fakeCall(['--json-schema', '{}'], `<pick>\nMembers:\n- @${B}\n- @${A}\nWorking now: @${A}`)), { member: A })
  console.log('fixture controls passed: unguarded marker, guarded denial, no persistence, working-member pick')

  const work = join(root, 'work')
  const agentsDir = join(root, 'agents')
  await mkdir(work)
  await mkdir(agentsDir)
  for (const [name, color] of [
    [A, 'blue'],
    [B, 'green']
  ])
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Side question test agent\nmodel: haiku\ncolor: ${color}\n---\nYou are a test agent.\n`
    )
  // A's chat that asked B, and the A→B chat it made, as e2e:ask leaves them; neither has a session, so side runs seed.
  const dataDir = join(root, 'data')
  const sourceId = randomUUID()
  const askedId = randomUUID()
  const t0 = Date.now() - 60_000
  await mkdir(join(dataDir, 'chats'), { recursive: true })
  await writeFile(
    join(dataDir, 'chats.json'),
    JSON.stringify({
      chats: [
        { id: sourceId, agentName: A, sessionId: null, cwd: work, title: 'Plan', createdAt: t0, updatedAt: t0, inFlight: false },
        {
          id: askedId,
          agentName: B,
          sessionId: null,
          cwd: work,
          title: `@${A} · Plan`,
          createdAt: t0 + 1000,
          updatedAt: t0 + 1000,
          inFlight: false,
          asked: { by: A, from: sourceId, fromTitle: 'Plan', chain: [] }
        }
      ]
    })
  )
  await writeFile(
    join(dataDir, 'chats', `${sourceId}.json`),
    JSON.stringify([
      { type: 'user', id: 'src-user', text: 'Plan the CSV import', ts: t0 },
      { type: 'assistant', id: 'src-reply', text: 'I will ask for the parser', ts: t0 + 10 }
    ])
  )
  await writeFile(
    join(dataDir, 'chats', `${askedId}.json`),
    JSON.stringify([
      { type: 'user', id: 'ask-user', text: 'Write the CSV parser', ts: t0 + 1000, from: A },
      {
        type: 'tool',
        id: 'toolu_ask_bash',
        name: 'Bash',
        input: { command: 'npm test' },
        result: 'ok',
        isError: false,
        blocked: false,
        ts: t0 + 1100,
        doneTs: t0 + 1200
      },
      { type: 'assistant', id: 'ask-reply', text: 'Parser half done', ts: t0 + 1300 }
    ])
  )
  h = await start({
    fake: FAKE,
    dataDir,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: work, FAKE_STEP_MS: '1600', FAKE_MEMORY_LOG: audit }
  })
  console.log(`HARNESS ${JSON.stringify({ root: h.root, serverPid: h.server.pid })}`)
  const page = h.page
  page.setDefaultTimeout(25_000)
  await page.locator(`${tid('agent-row')}[data-agent-name="${A}"]`).click()
  await folder(page)
  await send(page, 'Work 8 steps')
  await page.waitForURL(/\/chat\//)
  const single = chatId(page)
  const sessionDir = join(h.root, 'home', '.fake-sessions')
  let mainFile
  // Ask while Step 4 is pending, so a cut at the latest entry would be invalid.
  await until(async () => {
    const names = await readdir(sessionDir).catch(() => [])
    if (!names.length) return false
    mainFile = join(sessionDir, names[0])
    const es = await readJson(mainFile)
    return es.filter((e) => e.content?.some((b) => b.type === 'tool_result')).length === 3 && es.at(-1)?.content?.[0]?.type === 'tool_use'
  }, 'three results and pending fourth tool')
  const first = await ask(page, 'how many steps done?')
  const sideRun = await until(async () => (await turns()).find((r) => r.prompt?.includes('<btw>how many steps done?</btw>')), 'fork audit')
  assert.equal(sideRun.entries.filter((e) => e.content?.some((b) => b.type === 'tool_result')).length, 3)
  assert.equal(sideRun.entries.at(-1).content[0].type, 'tool_result', 'fork excludes the pending Step use')
  assert(sideRun.argv.includes('--fork-session') && sideRun.argv.includes('--no-session-persistence'))
  await state(page, first, 'done')
  assert.equal((await (await entry(page, first.id)).locator('.markdown').textContent()).trim(), 'Steps done: 3')
  assert.equal((await page.locator(tid('send-button')).textContent()).trim(), 'Stop', 'side completes while main still works')
  await completed(page, 'Done 8 steps')
  assert.equal(await page.locator(tid('task-row')).count(), 0)
  log('1 live fork at completed Step 3 excludes pending Step 4; side answers before Done 8 steps')

  await send(page, 'Continue main without side context')
  await completed(page, 'OK')
  const later = (await turns()).find((r) => r.prompt?.includes('Continue main without side context'))
  assert(later && !later.prompt.includes('how many steps done'))
  assert(!JSON.stringify(later.entries).includes('how many steps done'))
  assert(!(await readFile(mainFile, 'utf8')).includes('how many steps done'))
  assert(!(await readFile(join(h.dataDir, 'chats', `${single}.json`), 'utf8')).includes('how many steps done'))
  assert.deepEqual(
    (await readdir(sessionDir)).filter((n) => n.endsWith('.json')),
    [mainFile.split('/').at(-1)],
    'side writes no session'
  )
  log('2 later main stdin, its resumed context, session file and chat items exclude side question')

  // Here, after 2: the main run has moved on past `first` (8 steps and a reply), so a follow-up must still read first's point.
  const chatBefore = await items(single)
  await openThread(page, first.id)
  const followBox = page.locator(tid('side-follow-input'))
  const followAsk = page.locator(tid('side-follow'))
  await followBox.fill('and how many now?')
  await followBox.press('Enter')
  const follow = await until(async () => (await sides(single)).find((s) => s.question === 'and how many now?'), 'accept follow-up')
  assert.equal(follow.thread, first.id)
  assert.equal(follow.agent, A)
  await threadView(page, first.id)
    .locator(`${tid('side-entry')}[data-side-id="${follow.id}"]`)
    .waitFor()
  assert.deepEqual(
    await threadView(page, first.id).locator(tid('side-bubble')).allTextContents(),
    ['how many steps done?', 'and how many now?'],
    'questions as bubbles, oldest first'
  )
  const flagOf = (r, name) => r.argv[r.argv.indexOf(name) + 1]
  const followRun = await until(
    async () => (await turns()).find((r) => r.prompt?.includes('<btw>and how many now?</btw>')),
    'follow-up audit'
  )
  assert(followRun.argv.includes('--fork-session') && followRun.argv.includes('--no-session-persistence'))
  assert.equal(flagOf(followRun, '--resume'), flagOf(sideRun, '--resume'))
  assert.equal(flagOf(followRun, '--resume-session-at'), flagOf(sideRun, '--resume-session-at'), "the follow-up forks at its root's point")
  assert.deepEqual(
    followRun.entries.map((e) => e.uuid),
    sideRun.entries.map((e) => e.uuid)
  )
  assert.equal(
    followRun.entries.filter((e) => e.content?.some((b) => b.type === 'tool_result')).length,
    3,
    'not the 8 steps the main run has done since'
  )
  const at = (text) => followRun.prompt.indexOf(text)
  assert(at('<btw>how many steps done?</btw>') >= 0, 'the root question is replayed')
  assert(at('<btw>how many steps done?</btw>') < at('<answer>Steps done: 3</answer>'), 'then its answer')
  assert(at('<answer>Steps done: 3</answer>') < at('<btw>and how many now?</btw>'), 'then the new question')
  await state(page, follow, 'running')
  await followBox.fill('next one')
  assert(await followAsk.isDisabled(), 'Ask waits while an answer runs')
  assert(await followBox.isEditable(), 'the box stays editable meanwhile')
  assert.equal((await page.locator(tid('side-follow-note')).textContent()).trim(), 'Wait for this answer to finish')
  await showList(page)
  assert.equal(await page.locator(tid('side-row')).count(), 1, 'one row per thread')
  const row = page.locator(`${tid('side-row')}[data-thread-id="${first.id}"]`)
  assert.equal((await row.locator(tid('side-row-count')).textContent()).trim(), '2 questions')
  assert.equal(await row.getAttribute('data-status'), 'running')
  assert.equal((await row.locator(tid('side-row-line')).textContent()).trim(), 'Answering follow-up…')
  assert.equal(await chip(page, first.id).count(), 1, 'one chip for the thread')
  assert.equal(await page.locator(`.side-chip-row[data-side-id="${follow.id}"]`).count(), 0, 'the follow-up gets no chip of its own')
  assert.equal(await chip(page, first.id).getAttribute('data-state'), 'running', 'the chip shows the open follow-up')
  assert.deepEqual(
    (await items(single)).map((i) => i.id),
    chatBefore.map((i) => i.id),
    'no new chat items'
  )
  assert(!(await readFile(join(h.dataDir, 'chats', `${single}.json`), 'utf8')).includes('and how many now'))
  log(
    '13 follow-up after main moved on: same thread, forks at the root point (3 results, not 8), replays the root pair; Ask waits while it runs; one row (2 questions), one chip, no chat items'
  )

  const followEntry = await entry(page, follow.id, first.id)
  await until(async () => (await followEntry.locator('.markdown').count()) > 0, 'partial follow-up text')
  await followEntry.locator(tid('side-stop')).click()
  await state(page, follow, 'stopped')
  assert.equal(await followEntry.locator(tid('side-again')).count(), 1, 'the last entry offers Ask again')
  // A done root never offers Ask again; step 15 checks the last-entry rule on a stopped root.
  assert.equal(await entryAt(page, first.id).locator(tid('side-again')).count(), 0, 'the done root offers no Ask again')
  assert.equal(await followBox.inputValue(), 'next one', 'the draft outlives the trip to the list')
  assert(!(await followAsk.isDisabled()), 'Ask is back once nothing runs')
  assert.equal(await page.locator(tid('side-follow-note')).count(), 0)
  await followBox.fill('')
  await followEntry.locator(tid('side-again')).click()
  await state(page, follow, 'done')
  const followRuns = (await turns()).filter((r) => r.prompt?.includes('<btw>and how many now?</btw>'))
  assert.equal(followRuns.length, 2, 'Ask again reran the follow-up')
  assert(followRuns[1].prompt.includes('<btw>how many steps done?</btw>\n<answer>Steps done: 3</answer>'), 'the rerun keeps the root pair')
  assert.equal(
    flagOf(followRuns[1], '--resume-session-at'),
    flagOf(sideRun, '--resume-session-at'),
    "the rerun forks at the root's point too"
  )
  assert.deepEqual(
    (await sides(single)).map((s) => s.id),
    [first.id, follow.id],
    'rerun in place'
  )
  assert.deepEqual(
    (await readdir(sessionDir)).filter((n) => n.endsWith('.json')),
    [mainFile.split('/').at(-1)],
    'follow-ups write no session'
  )
  log('14 Stop a follow-up: it offers Ask again, which reruns it with the root pair from the same point')

  const anchor = (await sides(single))[0].after
  assert((await items(single)).some((i) => i.id === anchor))
  async function restored(p) {
    await chip(p, first.id).waitFor()
    assert(
      await p.evaluate((id) => {
        const c = document.querySelector(`.side-chip-row[data-side-id="${id}"] [data-testid="side-chip"]`)
        const done = [...document.querySelectorAll('.bubble.assistant')].find((e) => e.textContent.includes('Done 8 steps'))
        return Boolean(c && done && c.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING)
      }, first.id),
      'chip stays before the main completion'
    )
    // The chip is the user's question, so it sits on the right like their bubbles.
    assert(
      await p.evaluate((id) => {
        const c = document.querySelector(`.side-chip-row[data-side-id="${id}"] [data-testid="side-chip"]`).getBoundingClientRect()
        const list = document.querySelector('.messages-inner').getBoundingClientRect()
        return Math.abs(c.right - list.right) < 2 && c.left > list.left + 20
      }, first.id),
      'chip sits on the right'
    )
    await chip(p, first.id).click()
    await state(p, first, 'done')
    assert((await (await entry(p, first.id)).textContent()).includes('Steps done: 3'))
  }
  await page.reload()
  await restored(page)
  const secondContext = await h.newContext()
  const second = await secondContext.newPage()
  await second.goto(`${h.origin}/chat/${single}`)
  await chip(second, first.id).waitFor()
  assert.equal(await second.locator(tid('side-panel')).count(), 0, 'other device does not autoopen')
  // The count lives in the side panel's list, not under the composer.
  assert.equal(
    await second
      .locator('.pickers')
      .filter({ hasText: /\bbtw\b/ })
      .count(),
    0,
    'no btw chip under the composer'
  )
  await second.locator(tid('side-panel-toggle')).click()
  assert.equal(
    (await second.locator(tid('side-sides-count')).textContent()).trim(),
    String((await sides(single)).filter((s) => !s.thread).length),
    'side panel list counts threads, not entries'
  )
  await second.locator(tid('side-panel-toggle')).click()
  await restored(second)
  await secondContext.close()
  log('3 reload and independent browser context retain chip position and answer')

  await page.evaluate(() => {
    window.__sideApprovalSeen = false
    window.__sideApprovalObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="approval-card"]')) window.__sideApprovalSeen = true
    })
    window.__sideApprovalObserver.observe(document.body, { childList: true, subtree: true })
  })
  const guarded = await ask(page, 'use a tool')
  await state(page, guarded, 'done')
  assert(!existsSync(join(h.root, 'home', 'tool-ran.txt')))
  assert.equal(await page.locator(tid('approval-card')).count(), 0)
  assert.equal(await page.evaluate(() => window.__sideApprovalSeen), false)
  const guardRun = (await turns()).find((r) => r.prompt?.includes('<btw>use a tool</btw>'))
  assert(guardRun.argv[guardRun.argv.indexOf('--settings') + 1].includes('No tools in a side answer'))
  log('4 deny hook prevents marker and any approval card')

  const stopped = await ask(page, 'slow stop answer')
  await until(async () => (await (await entry(page, stopped.id)).locator('.markdown').textContent()).includes('Side:'), 'partial text')
  await (await entry(page, stopped.id)).locator(tid('side-stop')).click()
  await state(page, stopped, 'stopped')
  const partial = (await sides(single)).find((s) => s.id === stopped.id).answer
  assert(partial.startsWith('Side:') && !partial.includes('slow stop answer'))
  await (await entry(page, stopped.id)).locator(tid('side-again')).click()
  await state(page, stopped, 'done')
  assert((await (await entry(page, stopped.id)).textContent()).includes('Side: slow stop answer'))
  assert.equal((await sides(single)).filter((s) => s.id === stopped.id).length, 1)
  assert.equal(await chip(page, stopped.id).count(), 1)
  assert.equal((await turns()).filter((r) => r.prompt?.includes('<btw>slow stop answer</btw>')).length, 2)
  log('5 Stop keeps partial text; Ask again reruns the same entry/chip')

  await page.locator(tid('new-agent')).click()
  await page.locator(tid('new-menu-group')).click()
  await page.locator(tid('new-chat-members')).click()
  for (const name of [A, B]) await page.locator(`${tid('new-chat-member-option')}[data-agent-name="${name}"]`).click()
  await page.locator(tid('composer-input')).click()
  await folder(page)
  await send(page, `@${A} Work 8 steps`)
  await page.waitForURL(/\/chat\//)
  const room = chatId(page)
  await until(async () => (await items(room)).some((i) => i.turn && i.type === 'tool'), 'persisted room live tool')
  const beforePick = (await runs()).filter((r) => r.argv.includes('--json-schema')).length
  const picked = await ask(page, 'who is working?')
  await until(async () => (await sides(room)).find((s) => s.id === picked.id)?.agent === A, 'picker chooses working member')
  const liveSide = (await sides(room)).find((s) => s.id === picked.id)
  assert(
    (await items(room)).some((i) => i.id === liveSide.after && i.turn),
    'chip anchored to room live item'
  )
  await chip(page, picked.id).waitFor()
  await chip(page, picked.id).locator(`.side-chip-who[data-agent-name="${A}"]`).waitFor()
  assert.equal((await runs()).filter((r) => r.argv.includes('--json-schema')).length, beforePick + 1, 'moderator really ran')
  const pickerRun = (await runs()).filter((r) => r.argv.includes('--json-schema')).at(-1)
  assert(pickerRun.prompt.includes(`Working now: @${A}`))
  const explicit = await ask(page, `@${B} x`)
  await state(page, explicit, 'done')
  assert.equal((await sides(room)).find((s) => s.id === explicit.id).agent, B)
  assert((await (await entry(page, explicit.id)).textContent()).includes('Side: x'))
  await chip(page, explicit.id).locator(`.side-chip-who[data-agent-name="${B}"]`).waitFor()
  assert.equal((await runs()).filter((r) => r.argv.includes('--json-schema')).length, beforePick + 1, 'mention skips moderator')
  await state(page, picked, 'done')
  await completed(page, 'Done 8 steps')
  log('6 room moderator picks working member; explicit other skips picker; attributed live-anchor chips remain visible')

  await page.goto(`${h.origin}/chat/${single}`)
  const interrupted = await ask(page, 'restart during answer')
  await until(
    async () => (await sides(single)).find((s) => s.id === interrupted.id)?.answer.startsWith('Side:'),
    'persisted partial before crash'
  )
  // SIGKILL deliberately bypasses graceful stop so recovery sees an unfinished stored entry.
  const crashed = h.server
  const ipcDirs = await ipcDirsOf(crashed.pid)
  assert.equal(ipcDirs.length, 7, 'the server listens in seven IPC folders: ' + ipcDirs.join(', '))
  const exited = new Promise((resolve) => crashed.once('exit', resolve))
  crashed.kill('SIGKILL')
  await exited
  await h.restartServer()
  // The crashed server never ran close(): the restarted one's startup sweep removes its IPC folders.
  for (const dir of ipcDirs) assert(!existsSync(dir), dir + ' outlived the crash')
  await page.reload()
  await chip(page, interrupted.id).click()
  await state(page, interrupted, 'error')
  assert((await (await entry(page, interrupted.id)).textContent()).includes('Interrupted by a restart'))
  assert((await sides(single)).find((s) => s.id === interrupted.id).answer.startsWith('Side:'))
  log('7 hard server restart recovers partial answer with Interrupted by a restart')

  const open = []
  for (let n = 1; n <= 3; n++) open.push(await ask(page, `limit ${n}`))
  await send(page, '/btw limit fourth')
  const refusal = page.locator(tid('error-bubble')).filter({ hasText: '3 side questions are already running in this chat' })
  await refusal.waitFor()
  assert.equal(
    await refusal.evaluate((el) =>
      [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('')
        .trim()
    ),
    '3 side questions are already running in this chat'
  )
  assert.equal((await sides(single)).filter((s) => ['running', 'picking'].includes(s.state)).length, 3)
  assert(!(await sides(single)).some((s) => s.question === 'limit fourth'))
  for (const side of open) await (await entry(page, side.id)).locator(tid('side-stop')).click()
  log('8 fourth concurrent side question is refused with exact limit text')

  await until(async () => !(await sides(single)).some((s) => ['running', 'picking'].includes(s.state)), 'limit entries stopped')
  // A stopped root offers Ask again only while it is its thread's last entry (step 14's root was done, so it could not show).
  const [limited] = open
  await state(page, limited, 'stopped')
  assert.equal(await entryAt(page, limited.id).locator(tid('side-again')).count(), 1)
  await followBox.fill('limit follow-up')
  await followBox.press('Enter')
  const limitedFollow = await until(
    async () => (await sides(single)).find((s) => s.question === 'limit follow-up'),
    'accept limit follow-up'
  )
  assert.equal(limitedFollow.thread, limited.id)
  await state(page, limitedFollow, 'running')
  assert.equal(await entryAt(page, limited.id).locator(tid('side-again')).count(), 0, 'a root with a follow-up offers no Ask again')
  await entryAt(page, limitedFollow.id).locator(tid('side-stop')).click()
  await state(page, limitedFollow, 'stopped')
  assert.equal(await entryAt(page, limitedFollow.id).locator(tid('side-again')).count(), 1)
  assert.equal(await entryAt(page, limited.id).locator(tid('side-again')).count(), 0)
  log('15 a stopped root loses Ask again once followed up; only the last entry offers it')

  await showList(page)
  assert.equal(await page.locator(tid('side-pick')).count(), 0, 'a single chat offers no Answer from chips')
  const [typed] = await panelAsk(page, single, 'typed in the panel')
  assert.equal(typed.question, 'typed in the panel')
  assert.equal(typed.agent, A)
  assert.equal(typed.mention, undefined, 'a single chat entry is not marked as a mention')
  assert.equal(await newestShown(page), typed.id, 'the new thread is the first row')
  await state(page, typed, 'done')
  assert((await (await entry(page, typed.id)).textContent()).includes('Side: typed in the panel'))
  assert(
    !(await readFile(join(h.dataDir, 'chats', `${single}.json`), 'utf8')).includes('typed in the panel'),
    'the panel ask sent no chat message'
  )
  log('9 single chat panel input: Enter asks and opens the new thread, focus in its follow-up box, its row first in the list, no chips')

  await page.goto(`${h.origin}/chat/${room}`)
  await openSides(page)
  const members = (await readJson(join(h.dataDir, 'chats.json'))).chats.find((c) => c.id === room).group.members
  const roomPicks = await picks(page)
  assert.deepEqual(
    roomPicks.map((p) => p.key),
    ['auto', ...members.map((m) => `agent:${m}`)]
  )
  assert.deepEqual(
    roomPicks.map((p) => p.pressed),
    ['true', ...members.map(() => 'false')],
    'Auto is the default'
  )
  const [chipped] = await panelAsk(page, room, 'which file next?', `agent:${B}`)
  assert.equal(chipped.agent, B)
  assert.equal(chipped.mention, true)
  assert.equal(chipped.question, 'which file next?')
  assert.equal(await newestShown(page), chipped.id)
  await state(page, chipped, 'done')
  log('10 room panel input: Auto plus members, a member chip answers as that member with mention')

  await page.goto(`${h.origin}/chat/${askedId}`)
  await page.locator(tid('asked-bar')).waitFor()
  assert.equal(await page.locator(tid('composer-input')).count(), 0, 'the A→B chat has a composer')
  await openSides(page)
  const askedPicks = await picks(page)
  assert.deepEqual(
    askedPicks.map((p) => p.key),
    [`agent:${B}`, `agent:${A}`, 'both']
  )
  assert.equal(askedPicks.at(-1).label, 'Both')
  assert.deepEqual(
    askedPicks.map((p) => [p.pressed, p.disabled]),
    [
      ['true', false],
      ['false', false],
      ['false', false]
    ]
  )
  const agentArg = (r) => r.argv[r.argv.indexOf('--agent') + 1]
  const [fromB] = await panelAsk(page, askedId, 'how far is the parser?')
  assert.equal(fromB.agent, B)
  assert.equal(fromB.mention, undefined)
  const runB = await until(async () => (await turns()).find((r) => r.prompt?.includes('<btw>how far is the parser?</btw>')), 'B side run')
  assert.equal(agentArg(runB), B)
  assert(runB.prompt.includes('Write the CSV parser') && !runB.prompt.includes('Plan the CSV import'), 'B answers from the A→B chat only')
  const [fromA] = await panelAsk(page, askedId, 'how is the parser going?', `agent:${A}`)
  assert.equal(fromA.agent, A)
  assert.equal(fromA.mention, true)
  assert.equal(await newestShown(page), fromA.id)
  const both = page.locator(`${tid('side-pick')}[data-pick="both"]`)
  assert(await both.isDisabled(), 'Both needs two free slots')
  assert.equal(await both.getAttribute('data-tip'), 'Both needs 2 free side question slots')
  const runA = await until(async () => (await turns()).find((r) => r.prompt?.includes('<btw>how is the parser going?</btw>')), 'A side run')
  assert.equal(agentArg(runA), A)
  for (const text of ['Plan the CSV import', 'Parser half done', 'Used Bash(npm test)'])
    assert(runA.prompt.includes(text), `A's side prompt lacks ${text}`)
  await state(page, fromB, 'done')
  await state(page, fromA, 'done')
  assert((await (await entry(page, fromA.id)).textContent()).includes('Side: how is the parser going?'))
  await showList(page)
  await until(async () => !(await both.isDisabled()), 'Both usable again')
  const pair = await panelAsk(page, askedId, 'status of both?', 'both')
  assert.deepEqual(
    pair.map((s) => s.agent),
    [B, A]
  )
  assert.deepEqual(
    pair.map((s) => s.question),
    ['status of both?', 'status of both?']
  )
  assert.equal(await newestShown(page), pair[1].id, "the asker's answer of Both is on top")
  assert.equal(
    await page.locator(`${tid('side-pick')}[data-pick="agent:${B}"]`).getAttribute('aria-pressed'),
    'true',
    'Both falls back to B once slots fill'
  )
  for (const side of pair) await state(page, side, 'done')
  log(
    '11 A→B chat: no composer; chips B, A, Both; B answers from its chat, A from the source chat with the A→B snapshot; Both makes two answers'
  )

  await showList(page)
  const box = page.locator(tid('side-input'))
  await box.fill('@nobody hi')
  await box.press('Enter')
  await page.locator(tid('side-input-error')).waitFor()
  assert((await page.locator(tid('side-input-error')).textContent()).includes('is not in this chat'))
  assert.equal(await box.inputValue(), '@nobody hi', 'a refused question keeps its text')
  log('12 a refused panel question shows its error and keeps the text')

  const bad = unexpectedErrors(h.errors, [
    /WebSocket.*(closed|connection)|ERR_CONNECTION_(REFUSED|RESET)|Failed to load resource.*(net::|503)/i
  ])
  assert.deepEqual(bad, [], 'unexpected server/browser errors')
  console.log(`ERRORS ${JSON.stringify(h.errors)}`)
} finally {
  // The deliberate hard crash may orphan its side child; only kill audited fixture pids we own.
  for (const r of await runs())
    if (r.pid) {
      try {
        const command = await readFile(`/proc/${r.pid}/cmdline`, 'utf8')
        if (command.includes(FAKE)) process.kill(r.pid, 'SIGTERM')
      } catch {
        /* already exited */
      }
    }
  await h?.stop()
  await rm(root, { recursive: true, force: true })
  console.log('CLEANUP owned fixture children, server and Chrome stopped')
}
