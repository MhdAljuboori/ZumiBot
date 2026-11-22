// End-to-end check of a group chat in the built server + web UI (local mode) against the REAL `claude` CLI (Haiku only: the three test agents
// say `model: haiku`, and the moderator call always uses Haiku).
// Usage: npm run e2e:group   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude/agents (or anywhere else in ~/.claude) is created, changed or removed by this script;
//  - one mkdtemp folder `zumibot-e2e-group-*` is the chat folder; the three test agents live in its
//    `.claude/agents/` (the CLI finds project agents in the cwd) and ZUMIBOT_AGENTS_DIR points at that same dir;
//  - a separate mkdtemp data dir, and `zumibot-e2e-group-tasks-*` for the Tasks steps; only those three dirs (plus the
//    harness's own temp roots) are ever deleted, in `finally`;
//  - the servers started here (and only their own descendants) are killed in `finally`; overall timeout 10 min.
//  - the server runs with the real HOME (the CLI's login); nothing of it is copied.
// The agents may only use Read (frontmatter `tools: Read`) and are told to answer in one short line without tools,
// so no turn can write anywhere. The app runs in its default permission mode.
// Note: on start the server also writes the built-in zumi-bot.md into the agents folder, by design;
// it is deleted with the chat folder. The CLI keeps its own session files under ~/.claude/projects, as for any chat.
//
// Real replies vary: steps assert structure (who replied, notices, chips, rows, status line, persistence), never wording.
//
// DOM hooks relied on (data-testid / attribute / class):
//   data-testid: new-agent (the sidebar's + button; opens new-menu), new-menu, new-menu-agent, new-menu-group,
//                new-chat-members, new-chat-member-option (+ data-agent-name, aria-checked, aria-disabled),
//                new-chat-folder (+ title = cwd), new-chat-choose-folder, composer-input, send-button (text Send|Stop),
//                unassigned-items, group-row (+ data-chat-id), message-list, agent-turn, error-bubble,
//                mention (+ data-agent-name), mention-menu, mention-option (+ data-agent-name),
//                room-live (a running room's part of the thread, after its finished rows), live-turn (+ data-agent-name,
//                data-state = working|approval|asked), queued-member (+ data-agent-name), room-thinking,
//                role-chip, role-popup, role-input, role-save, role-cancel,
//                chat-members, members-row (+ data-agent-name), chat-folder (+ title),
//                attach-button, draft-attachment (+ data-status), sent-attachments, sent-thumb (img inside), sent-chip,
//                tasks-tray, tasks-head (its first span reads "Tasks · N"), task-row (.task-text inside), task-send, task-drop
//                (attach-error, draft-attachments, draft-attachment-remove and drop-overlay are covered by web.e2e.mjs)
//   attribute: [data-streaming] (the live bubble); [role=separator] (dividers)
//   by class: .messages-inner (thread rows), .bubble.user (a row, or inside a sent message's .user-msg row), .bubble.assistant, .agent-turn-name, .notice ("Stopped."),
//             .section-label ("Group chats"), .picker-text ("3 agents"), .group-title (group row title)
//   server env: ZUMIBOT_TEST_PICK_FOLDER (fixed answer of "Choose folder…"); the image goes through the paperclip +
//   Playwright's `filechooser` event (the old ZUMIBOT_TEST_PICK_FILES no longer exists)
// Stored state read: <dataDir>/chats.json (group meta) and <dataDir>/chats/<id>.json (items, with each reply's author).
//
// The Tasks steps (queued messages) run first, on their own server with the fake claude and a data dir seeded before it
// starts (held tasks of paused groups survive only there): no real CLI call, temp HOME, temp agents dir.

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start as startHarness } from './harness.mjs'
import { redPng } from './redPng.mjs'

const ALPHA = 'e2e-alpha'
const BETA = 'e2e-beta'
const GAMMA = 'e2e-gamma'
const CB = 'zumi-bot'
const LABEL = { [ALPHA]: 'E2e Alpha', [BETA]: 'E2e Beta', [GAMMA]: 'E2e Gamma' } // how the UI shows each handle
const MSG1 = '@e2e-beta @e2e-alpha write a spec and a TODO for a dark mode toggle'
const MSG2 = '@e2e-alpha thanks'
const MSG3 = '@e2e-alpha write a one-line spec for a font size setting'
const MSG4 = '@e2e-alpha write a one-line spec for a sound toggle @e2e-gamma name one planet'
const ROLE = 'E2e team: Alpha writes specs, Gamma answers facts, Beta turns a spec into a TODO.'
const PLACEHOLDER = 'Message the group… type @ to mention'
const PASS_MARKER = '[[PASS]]'
const REPLY_TIMEOUT = 120_000
const OVERALL_TIMEOUT = 10 * 60_000
const STEPS = 14
const SHOTS = fileURLToPath(new URL('./screenshots', import.meta.url))
const PREFIX = 'zumibot-e2e-group-'

const AGENT_FILES = {
  [ALPHA]: [
    '---',
    `name: ${ALPHA}`,
    'description: Writes a one-line spec for a request. Never writes TODO lines.',
    'model: haiku',
    'color: blue',
    'tools: Read',
    '---',
    'You are a test agent in an automated check. Reply with one short line of plain text only, a one-line spec for what was asked. Do not use any tools.',
    ''
  ].join('\n'),
  [BETA]: [
    '---',
    `name: ${BETA}`,
    'description: Turns a spec written by another member into one TODO line. Needs the spec first.',
    'model: haiku',
    'color: green',
    'tools: Read',
    '---',
    'You are a test agent in an automated check. Reply with one short line of plain text only, one TODO line made from the spec. Do not use any tools.',
    ''
  ].join('\n'),
  [GAMMA]: [
    '---',
    `name: ${GAMMA}`,
    'description: Answers one short fact on its own. Never needs another member.',
    'model: haiku',
    'color: purple',
    'tools: Read',
    '---',
    'You are a test agent in an automated check. Reply with one short line of plain text only, a short answer to what was asked. Do not use any tools.',
    ''
  ].join('\n')
}

class Blocked extends Error {}

let aborted = false // set by the overall timeout and by `finally`: nothing may start the server afterwards
let folder = null // the chat folder; holds .claude/agents
let agentsDir = null
let userData = null
let current = null // harness handle (page, server, errors, stop) + pid
let chatId = null
let fixturePng = null // red 32x32 PNG in <dataDir>/fixtures
const allErrors = []
const results = []
const t0 = Date.now()
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const log = (m) => console.log(m)
const ok = (step) => {
  results.push(`ok ${step}`)
  log(`ok ${step}  [${secs()}]`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

async function shot(name, page = current.page) {
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `e2e-group-${name}.png`) })
}

// ---------- process handling (only the server started here, and its descendants) ----------

function descendants(pid) {
  const out = []
  const walk = (p) => {
    let kids = []
    try {
      kids = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map(Number)
    } catch {
      /* no children */
    }
    for (const k of kids) {
      out.push(k)
      walk(k)
    }
  }
  walk(pid)
  return out
}

async function start() {
  if (aborted) throw new Error('aborted (overall timeout or cleanup already started)')
  // undefined: the harness drops undefined env keys, so the variable is not passed at all (not the string "undefined")
  // fake:false = real claude with the real HOME; undefined removes the harness's manual permission mode: the default mode applies, as before
  const started = await startHarness({
    mode: 'local',
    fake: false,
    dataDir: userData,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: folder, ZUMIBOT_PERMISSION_MODE: undefined }
  })
  current = { ...started, pid: started.server.pid }
  allErrors.push(started.errors)
  if (aborted) {
    await stop()
    throw new Error('aborted while launching')
  }
  await current.page.waitForSelector('[data-testid="new-agent"]', { timeout: 30_000 })
  return current.page
}

async function stop() {
  if (!current) return
  const h = current
  current = null
  await shutDown(h)
}

async function shutDown({ stop: stopHarness, pid }) {
  const kids = pid ? descendants(pid) : []
  await Promise.race([stopHarness().catch(() => {}), sleep(30_000)])
  for (const p of [pid, ...kids]) {
    if (!p) continue
    try {
      process.kill(p, 0)
      process.kill(p, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

// ---------- reading the thread ----------

const handleOf = (label) => Object.keys(LABEL).find((k) => LABEL[k] === label) ?? label

/** The open chat's thread in order: user bubbles (with their chips), one entry per finished agent bubble, notices, errors. */
async function thread(page) {
  const rows = await page.evaluate(() => {
    const out = []
    const inner = document.querySelector('[data-testid="message-list"] .messages-inner')
    if (!inner) return out
    for (const el of inner.children) {
      // A sent message's bubble sits in its .user-msg wrapper (beside its actions); one still on its way is a bare row.
      const user = el.matches('.bubble.user') ? el : el.matches('.user-msg') ? el.querySelector('.bubble.user') : null
      if (user) {
        const mentions = [...user.querySelectorAll('[data-testid="mention"]')].map((m) => m.getAttribute('data-agent-name'))
        out.push({ kind: 'user', text: user.textContent.trim(), mentions })
      } else if (el.matches('[data-testid="agent-turn"]')) {
        const agent = el.querySelector('.agent-turn-name')?.textContent.trim() ?? ''
        for (const b of el.querySelectorAll('.bubble.assistant:not([data-streaming])'))
          out.push({ kind: 'reply', agent, text: b.textContent.trim() })
      } else if (el.matches('[data-testid="error-bubble"]')) out.push({ kind: 'error', text: el.textContent.trim() })
      else if (el.matches('.notice')) out.push({ kind: 'notice', text: el.textContent.trim() })
      else if (el.matches('[role="separator"]')) out.push({ kind: 'divider', text: el.textContent.trim() })
    }
    return out
  })
  return rows.map((r) => (r.kind === 'reply' ? { ...r, agent: handleOf(r.agent) } : r))
}

const summary = (t) =>
  t
    .map((e) =>
      e.kind === 'user' ? `user(${e.mentions.join('+')})` : e.kind === 'reply' ? e.agent : `${e.kind}:${JSON.stringify(e.text)}`
    )
    .join(' > ')

/**
 * The room's live part as text: null when it is not shown (the room is idle), else "agent:state" per running turn, then
 * "agent:waiting" per queued member ("e2e-alpha:working,e2e-beta:waiting").
 */
const statusText = (page) =>
  page.evaluate(() => {
    const live = document.querySelector('[data-testid="message-list"] [data-testid="room-live"]')
    if (!live) return null
    const turns = [...live.querySelectorAll('[data-testid="live-turn"]')].map(
      (r) => r.getAttribute('data-agent-name') + ':' + r.getAttribute('data-state')
    )
    const queued = [...live.querySelectorAll('[data-testid="queued-member"]')].map((r) => r.getAttribute('data-agent-name') + ':waiting')
    return [...turns, ...queued].join(',')
  })

/** Records every change of the room's live part into window.__statusLog (entry 0: it now). Turns are read from it. */
const watchStatus = (page) =>
  page.evaluate(() => {
    window.__statusLog = []
    let last
    const check = () => {
      const live = document.querySelector('[data-testid="message-list"] [data-testid="room-live"]')
      const text = live
        ? [
            ...[...live.querySelectorAll('[data-testid="live-turn"]')].map(
              (r) => r.getAttribute('data-agent-name') + ':' + r.getAttribute('data-state')
            ),
            ...[...live.querySelectorAll('[data-testid="queued-member"]')].map((r) => r.getAttribute('data-agent-name') + ':waiting')
          ].join(',')
        : null
      if (text !== last) window.__statusLog.push((last = text))
    }
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    check()
  })
const statusLog = (page) => page.evaluate(() => window.__statusLog ?? [])

/** Polls the thread, status line and status log until `fn` returns a truthy value. Fails fast on an error bubble. */
async function poll(page, fn, timeout, what) {
  const end = Date.now() + timeout
  for (;;) {
    const t = await thread(page)
    const err = t.find((e) => e.kind === 'error')
    if (err) throw new Blocked(`app showed an error bubble: ${err.text}`)
    const st = await statusText(page)
    const slog = await statusLog(page)
    const v = fn(t, st, slog)
    if (v) return v
    if (Date.now() > end) {
      throw new Error(
        `ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}; thread: ${summary(t)}; status: ${JSON.stringify(st)}; status log: ${JSON.stringify(slog)}`
      )
    }
    await sleep(150)
  }
}

const replies = (t, agent) => t.filter((e) => e.kind === 'reply' && (agent === undefined || e.agent === agent))
const isWorking = (st, agent) => st !== null && st.split(',').includes(`${agent}:working`)
/** Index of the first status-log entry at or after `from` where `agent` starts a turn, or -1. */
const turnStart = (slog, agent, from = 0) =>
  slog.findIndex((s, i) => i >= from && isWorking(s, agent) && (i === 0 || !isWorking(slog[i - 1], agent)))
/** Index of the first entry after `from` (an entry of `agent` working) where its turn is over, or -1. */
const turnEnd = (slog, agent, from) => slog.findIndex((s, i) => i > from && !isWorking(s, agent))

async function chatsJson(dir = userData) {
  return JSON.parse(await readFile(join(dir, 'chats.json'), 'utf8'))
}
async function chatLog(id = chatId, dir = userData) {
  return JSON.parse(await readFile(join(dir, 'chats', `${id}.json`), 'utf8'))
}
/** The stored replies (assistant items) in thread order, with their index in the stored log. */
const storedReplies = (items, agent) =>
  items.map((it, i) => ({ ...it, i })).filter((it) => it.type === 'assistant' && (agent === undefined || it.agent === agent))

const send = (page) => page.locator('[data-testid="send-button"]')
const input = (page) => page.locator('[data-testid="composer-input"]')
const taskTexts = (page) => page.locator('[data-testid="task-row"] .task-text').allTextContents()
const tasksHeadText = async (page) => (await page.locator('[data-testid="tasks-head"] span').first().textContent()).trim()
const users = (t) => t.filter((e) => e.kind === 'user')

/**
 * Records each change of (the room's live part shown, `text` waiting as a task row, a user bubble past the first `count`) into
 * window.__queueLog. Read with queueLog(); judged by checkWaited().
 */
const watchQueued = (page, text, count) =>
  page.evaluate(
    ({ text, count }) => {
      window.__queueLog = []
      let last
      const check = () => {
        const inner = document.querySelector('[data-testid="message-list"] .messages-inner')
        const s = {
          live: document.querySelector('[data-testid="room-live"]') !== null,
          row: [...document.querySelectorAll('[data-testid="task-row"] .task-text')].some((e) => e.textContent.trim() === text),
          bubble: (inner ? inner.querySelectorAll(':scope > .bubble.user, :scope > .user-msg .bubble.user').length : 0) > count
        }
        const key = JSON.stringify(s)
        if (key !== last) {
          last = key
          window.__queueLog.push(s)
        }
      }
      window.__queueObs?.disconnect()
      window.__queueObs = new MutationObserver(check)
      window.__queueObs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
      check()
    },
    { text, count }
  )
const queueLog = (page) => page.evaluate(() => window.__queueLog ?? [])

/** A message sent mid-run: never a row and a bubble at once, a row while the room ran, in only after the room went idle. */
function checkWaited(qlog, what) {
  const seen = JSON.stringify(qlog)
  assert(!qlog.some((s) => s.row && s.bubble), `${what} showed as a task row and a bubble at once: ${seen}`)
  const waited = qlog.findIndex((s) => s.row && s.live && !s.bubble)
  assert(waited >= 0, `${what} never waited as a task row while the room's turns ran: ${seen}`)
  const inAt = qlog.findIndex((s) => s.bubble)
  assert(inAt > waited, `${what} never went in after waiting: ${seen}`)
  assert(
    qlog.slice(waited, inAt).some((s) => !s.live),
    `${what} went in before the room's live turns went away: ${seen}`
  )
}
// The composer is a rich-text editor (contenteditable), not a textarea: its text is textContent, its placeholder a data attribute.
// A mention away from the caret shows a display-name chip (a widget, not draft text) before its hidden handle.
const draftText = (page) =>
  input(page).evaluate((el) => {
    const copy = el.cloneNode(true)
    for (const chip of copy.querySelectorAll('.composer-mention')) chip.remove()
    return copy.textContent
  })
const placeholderText = (page) => input(page).locator('p[data-placeholder]').first().getAttribute('data-placeholder')

// ---------- steps ----------

async function step1(page) {
  await page.locator('[data-testid="new-agent"]').click()
  const menu = page.locator('[data-testid="new-menu"]')
  await menu.waitFor({ timeout: 5_000 })
  assert(
    (await page.locator('[data-testid="new-menu-agent"]').textContent()).trim() === 'New agent',
    'first + menu item is not "New agent"'
  )
  const groupItem = page.locator('[data-testid="new-menu-group"]')
  assert((await groupItem.textContent()).trim() === 'New group chat', 'second + menu item is not "New group chat"')
  await groupItem.click()
  await page.locator('[data-testid="new-chat-members"]').waitFor({ timeout: 5_000 })
  assert((await placeholderText(page)) === PLACEHOLDER, `placeholder is ${JSON.stringify(await placeholderText(page))}`)

  await page.locator('[data-testid="new-chat-members"]').click()
  const option = (name) => page.locator(`[data-testid="new-chat-member-option"][data-agent-name="${name}"]`)
  await option(ALPHA).waitFor({ timeout: 5_000 })
  const names = await page
    .locator('[data-testid="new-chat-member-option"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-name')))
  assert(names.length === 4 && [ALPHA, BETA, GAMMA, CB].every((n) => names.includes(n)), `members picker lists ${JSON.stringify(names)}`)
  const cb = option(CB)
  assert((await cb.getAttribute('aria-disabled')) === 'true', 'Zumi Bot is not disabled in the members picker')
  assert((await cb.textContent()).includes("can't join"), `Zumi Bot row lacks "can't join": ${JSON.stringify(await cb.textContent())}`)
  for (const n of [ALPHA, BETA, GAMMA]) {
    assert((await option(n).getAttribute('aria-disabled')) === 'false', `${n} is disabled in the members picker`)
    assert((await option(n).getAttribute('aria-checked')) === 'false', `${n} starts checked`)
  }
  await option(ALPHA).click()
  await option(BETA).click()
  await option(GAMMA).click()
  await cb.click({ force: true }) // aria-disabled, so Playwright would wait for it: force the click, nothing may change
  for (const n of [ALPHA, BETA, GAMMA])
    assert((await option(n).getAttribute('aria-checked')) === 'true', `${n} is not checked after picking it`)
  assert((await cb.getAttribute('aria-checked')) === 'false', 'Zumi Bot got checked')
  const pickerText = (await page.locator('[data-testid="new-chat-members"] .picker-text').textContent()).trim()
  assert(pickerText === '3 agents', `members picker reads ${JSON.stringify(pickerText)}, expected "3 agents"`)
  await shot('1-members')
  await page.keyboard.press('Escape')

  // No group chat yet, so no last group folder and no recent folders: the server's fixed folder answers.
  await page.locator('[data-testid="new-chat-folder"]').click()
  await page.locator('[data-testid="new-chat-choose-folder"]').click()
  await page.waitForFunction((cwd) => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip') === cwd, folder, {
    timeout: 5_000
  })
  const folderText = await page.locator('[data-testid="new-chat-folder"]').textContent()
  assert(folderText.includes(basename(folder)), `folder picker reads ${JSON.stringify(folderText)}`)
  await shot('1-ready')
  // The group's Role, set on this screen: saved with the chat when the first message goes out.
  await page.locator('[data-testid="role-chip"]').click()
  await page.locator('[data-testid="role-popup"]').waitFor({ timeout: 5_000 })
  await page.locator('[data-testid="role-input"]').fill(ROLE)
  await page.locator('[data-testid="role-save"]').click()
  await page.locator('[data-testid="role-popup"]').waitFor({ state: 'detached', timeout: 5_000 })
  assert(((await page.locator('[data-testid="role-chip"]').getAttribute('data-tip')) ?? '') === ROLE, 'role chip title is not the saved role')
  ok(`1 New group chat: members picker lists the 3 agents, Zumi Bot disabled ("can't join"); picked all 3, folder ${basename(folder)}`)
}

/**
 * Steps 2 and 3 share one run: the second message is sent while the second member of step 2 is replying, waits in
 * Tasks, and goes in once the whole room has ended.
 * Turns are read from the status line and replies from the stored log: a mentioned member's pass marker counts as
 * its reply (the room posts it, since mentioned members always post) but stays hidden while it is the last item.
 */
async function step2and3(page) {
  await watchStatus(page)
  await input(page).fill(MSG1)
  assert(await send(page).isEnabled(), 'Send disabled with 2 agents, a folder and text')
  await send(page).click()
  const sentAt = Date.now()
  await page.locator('[data-testid="chat-members"]').waitFor({ timeout: 10_000 })

  const user = await poll(page, (t) => t.find((e) => e.kind === 'user'), 10_000, 'the first user bubble')
  assert(
    JSON.stringify(user.mentions) === JSON.stringify([BETA, ALPHA]),
    `first bubble's mention chips are ${JSON.stringify(user.mentions)}`
  )
  const rows = page.locator('[data-testid="unassigned-items"] [data-testid="group-row"]')
  await rows.first().waitFor({ timeout: 10_000 })
  assert((await rows.count()) === 1, `${await rows.count()} group rows`)
  chatId = await rows.first().getAttribute('data-chat-id')
  assert(chatId, 'group row has no data-chat-id')

  // Step 2: the first member's turn and reply, then the other member's turn starts.
  const firstStart = await poll(
    page,
    (_t, _st, slog) => {
      const a = turnStart(slog, ALPHA)
      const b = turnStart(slog, BETA)
      if (a < 0 && b < 0) return false
      return a >= 0 && (b < 0 || a < b) ? { agent: ALPHA, at: a } : { agent: BETA, at: b }
    },
    REPLY_TIMEOUT,
    'a member to start its turn'
  )
  const first = firstStart.agent
  const other = first === ALPHA ? BETA : ALPHA
  await poll(
    page,
    (_t, _st, slog) => turnEnd(slog, first, firstStart.at) >= 0,
    REPLY_TIMEOUT - (Date.now() - sentAt),
    `${first}'s turn to end`
  )
  assert(storedReplies(await chatLog(), first).length > 0, `${first}'s turn ended without a reply`)
  log(`   step 2: ${first} took the first turn and replied after ${((Date.now() - sentAt) / 1000).toFixed(1)}s`)
  const otherStart = await poll(
    page,
    (_t, _st, slog) => {
      const at = turnStart(slog, other, firstStart.at)
      return at >= 0 && { at }
    },
    60_000,
    `${other}'s turn to start`
  )
  const otherStartedAt = Date.now()

  // Step 3: while that reply runs, send the second message, typed through the mention menu. The room runs, so it
  // waits in Tasks (no bubble) until the room has ended.
  await input(page).click()
  await input(page).pressSequentially('@e2e-al')
  await page.locator('[data-testid="mention-menu"]').waitFor({ timeout: 3_000 })
  await page.locator(`[data-testid="mention-option"][data-agent-name="${ALPHA}"]`).click()
  await input(page).pressSequentially('thanks')
  assert((await draftText(page)) === MSG2, `composer holds ${JSON.stringify(await draftText(page))}`)
  assert(
    (await send(page).textContent()).trim() === 'Send' && (await send(page).isEnabled()),
    'Send is not available while the group runs with text typed'
  )
  const usersBefore = users(await thread(page)).length
  const sendIdx = (await statusLog(page)).length - 1 // the status line at the click
  await watchQueued(page, MSG2, usersBefore)
  await send(page).click()
  const clickedAt = Date.now()
  await page.locator('[data-testid="task-row"]').first().waitFor({ timeout: 3_000 })
  const queued = await taskTexts(page)
  assert(JSON.stringify(queued) === JSON.stringify([MSG2]), `Tasks lists ${JSON.stringify(queued)}`)
  assert((await tasksHeadText(page)) === 'Tasks · 1', `Tasks header reads ${JSON.stringify(await tasksHeadText(page))}`)
  assert(users(await thread(page)).length === usersBefore, 'the second message went into the thread while the room ran')
  const atSend = (await statusLog(page))[sendIdx]
  assert(
    sendIdx >= otherStart.at && isWorking(atSend, other),
    `the live turns read ${JSON.stringify(atSend)} when the second message was sent, ${other} was not working`
  )
  log(`   step 3: "${MSG2}" queued while ${JSON.stringify(atSend)}`)
  await shot('3-queued-while-running')

  // Step 2 ends with the other member's reply.
  await poll(
    page,
    (_t, _st, slog) => turnEnd(slog, other, otherStart.at) >= 0,
    REPLY_TIMEOUT - (Date.now() - otherStartedAt),
    `${other}'s turn to end`
  )
  assert(storedReplies(await chatLog(), other).length > 0, `${other}'s turn ended without a reply`)
  log(
    `   step 2: ${other} replied after ${((Date.now() - otherStartedAt) / 1000).toFixed(1)}s of its turn; alpha replied before beta: ${first === ALPHA ? 'yes' : 'no'}`
  )
  await shot('2-both-replied')
  ok(`2 sent "${MSG1}": 2 mention chips, group row, both agents replied (first: ${first})`)

  // Step 3: the task goes in once the room has ended (its live turns went away first), as a new run.
  const posted = await poll(page, (t) => users(t).length > usersBefore && t, 2 * REPLY_TIMEOUT, `"${MSG2}" to go in from Tasks`)
  const thanks = users(posted)[usersBefore]
  assert(
    JSON.stringify(thanks.mentions) === JSON.stringify([ALPHA]) && thanks.text.endsWith('thanks'),
    `second bubble is ${JSON.stringify(thanks)}`
  )
  checkWaited(await queueLog(page), `"${MSG2}"`)
  log(`   step 3: "${MSG2}" went in ${((Date.now() - clickedAt) / 1000).toFixed(1)}s after the click, once the room had ended`)

  // Step 3 ends with a turn of alpha that starts after the turn running at send time, then the room going idle.
  // Not just "live turns gone": none show while the moderator still routes "thanks", before alpha is queued.
  await waitIdle(page)
  const slog = await statusLog(page)
  log(`   step 3: live turn changes: ${slog.map((s) => JSON.stringify(s)).join(' > ')}`)
  assert(
    turnStart(slog, ALPHA, sendIdx + 1) >= 0,
    `no new ${ALPHA} turn started after "${MSG2}" was sent; stored: ${(await chatLog()).map((i) => i.type + (i.agent ? '(' + i.agent + ')' : '')).join(' > ')}`
  )
  const items = await chatLog()
  const thanksAt = items.findIndex((i) => i.type === 'user' && i.text === MSG2)
  const alphaStored = storedReplies(items, ALPHA)
  assert(
    thanksAt >= 0 && alphaStored.length >= 2 && alphaStored[alphaStored.length - 1].i > thanksAt,
    `${ALPHA} did not reply again after "${MSG2}"`
  )
  // It waited for the whole room: both replies of the first run are stored before it.
  for (const a of [first, other])
    assert(
      storedReplies(items, a).some((r) => r.i < thanksAt),
      `"${MSG2}" is stored before ${a}'s reply to the first message`
    )
  // Idle, every posted reply shows: the thread must match the stored log.
  const t3 = await thread(page)
  for (const a of [ALPHA, BETA]) {
    assert(
      replies(t3, a).length === storedReplies(items, a).length,
      `${a}: ${replies(t3, a).length} bubbles shown, ${storedReplies(items, a).length} stored`
    )
  }
  const authors = storedReplies(items).map((i) => i.agent)
  assert(
    authors.every((a) => a === ALPHA || a === BETA),
    `stored replies have authors ${JSON.stringify(authors)}`
  )
  const passes = storedReplies(items)
    .filter((i) => i.text.trim() === PASS_MARKER)
    .map((i) => i.agent)
  log(`   step 3: thread ${summary(t3)}`)
  log(`   step 3: stored reply authors in order: ${authors.join(', ')}; pass-marker replies: ${passes.length ? passes.join(', ') : 'none'}`)
  await shot('3-alpha-again')
  ok(`3 "${MSG2}" sent while ${other} was replying: waited in Tasks until the room ended, then ${ALPHA} replied again`)
}

async function step4(page) {
  const stoppedBefore = (await thread(page)).filter((e) => e.kind === 'notice' && e.text === 'Stopped.').length
  await input(page).fill(MSG3)
  await send(page).click()
  // The moderator may queue beta ahead of alpha: stop as soon as any member's turn is running.
  const working = await poll(page, (_t, st) => st !== null && st.includes(':working') && st, 60_000, 'a member to start working')
  log(`   step 4: stopping while ${JSON.stringify(working)}`)
  assert(await page.locator('[data-testid="chat-members"]').isEnabled(), 'members picker is disabled while the group works')
  assert(
    (await send(page).textContent()).trim() === 'Stop',
    `composer button reads ${JSON.stringify(await send(page).textContent())} while running with an empty draft`
  )
  await send(page).click()
  await poll(
    page,
    (t) => t.filter((e) => e.kind === 'notice' && e.text === 'Stopped.').length > stoppedBefore,
    15_000,
    'a new "Stopped." notice'
  )
  await poll(page, (_t, st) => st === null, 15_000, "the room's live part to go away")
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="send-button"]')
      const box = document.querySelector('[data-testid="composer-input"]')
      return btn && btn.textContent.trim() === 'Send' && box && !box.disabled && !document.querySelector('[data-streaming]')
    },
    undefined,
    { timeout: 15_000, polling: 100 }
  )
  const meta = (await chatsJson()).chats.find((c) => c.id === chatId)
  assert(
    meta && meta.inFlight === false && meta.group.active.length === 0 && meta.group.queue.length === 0,
    `stored group after Stop: ${JSON.stringify(meta)}`
  )
  await shot('4-stopped')
  ok('4 Stop during a run: "Stopped." notice, live turns gone, composer idle (Send), nobody queued')
}

async function step5(page) {
  const picker = page.locator('[data-testid="chat-members"]')
  assert(await picker.isEnabled(), 'members picker is disabled while the group is idle')
  assert((await picker.locator('.picker-text').textContent()).trim() === '3 agents', 'members picker does not read "3 agents"')
  await picker.click()
  const rows = page.locator('[data-testid="members-row"]')
  await rows.first().waitFor({ timeout: 5_000 })
  const names = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-agent-name')))
  assert(JSON.stringify(names) === JSON.stringify([ALPHA, BETA, GAMMA]), `Members lists ${JSON.stringify(names)}`)
  assert((await page.locator('.picker-menu button, .picker-menu input').count()) === 0, 'Members list has controls in it')
  await rows.first().click() // a row is not a control: nothing may change, and the list stays open
  await sleep(500)
  assert((await rows.count()) === 3, 'Members list closed or changed on a row click')
  assert((await picker.locator('.picker-text').textContent()).trim() === '3 agents', 'member count changed')
  const meta = (await chatsJson()).chats.find((c) => c.id === chatId)
  assert(
    JSON.stringify(meta.group.members) === JSON.stringify([ALPHA, BETA, GAMMA]),
    `stored members ${JSON.stringify(meta.group.members)}`
  )
  await shot('5-members')
  await page.keyboard.press('Escape')
  await rows.first().waitFor({ state: 'detached', timeout: 5_000 })
  ok('5 Members picker lists the 3 members read-only, Escape closes it')
}

/** Waits for a settled room: composer back to Send, nothing streaming, stored run state idle and no task left, stored items still, live turns gone. */
async function waitIdle(page, id = chatId, dir = userData) {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="send-button"]')
      const box = document.querySelector('[data-testid="composer-input"]')
      return btn && btn.textContent.trim() === 'Send' && box && !box.disabled && !document.querySelector('[data-streaming]')
    },
    undefined,
    { timeout: 2 * REPLY_TIMEOUT, polling: 100 }
  )
  const end = Date.now() + 2 * REPLY_TIMEOUT
  let count = -1
  let since = Date.now()
  for (;;) {
    const meta = (await chatsJson(dir)).chats.find((c) => c.id === id)
    const n = (await chatLog(id, dir)).length
    if (n !== count) {
      count = n
      since = Date.now()
    }
    const stored =
      meta.inFlight === false && meta.group.active.length === 0 && meta.group.queue.length === 0 && (meta.tasks ?? []).length === 0
    if (stored && Date.now() - since >= 2_000 && (await statusText(page)) === null) return
    if (Date.now() > end)
      throw new Error(
        `ASSERT FAILED: the room did not settle; stored group ${JSON.stringify(meta.group)}, inFlight ${meta.inFlight}, ${(meta.tasks ?? []).length} tasks, ${n} items`
      )
    await sleep(200)
  }
}

/** The role set on the new-group screen is stored with the chat. */
async function stepRole() {
  const meta = (await chatsJson()).chats.find((c) => c.id === chatId)
  assert(meta && meta.group.role === ROLE, `stored role is ${JSON.stringify(meta?.group?.role)}`)
  ok('Role saved: set through role-chip / role-input / role-save, chats.json stores it')
}

/** Two members mentioned together work at the same time: the thread shows two working turns at one moment. */
async function stepSideBySide(page) {
  await watchStatus(page)
  const before = (await chatLog()).length
  await input(page).fill(MSG4)
  await send(page).click()
  const sentAt = Date.now()
  const both = await poll(
    page,
    (_t, st) => st !== null && st.split(',').filter((r) => r.endsWith(':working')).length >= 2 && st,
    REPLY_TIMEOUT,
    'two live turns working at the same moment'
  )
  log(`   side by side: ${JSON.stringify(both)} after ${((Date.now() - sentAt) / 1000).toFixed(1)}s`)
  await shot('7-side-by-side')
  await poll(page, (_t, st) => st === null, 2 * REPLY_TIMEOUT, 'the room to go idle (live turns gone)')
  const items = (await chatLog()).slice(before)
  for (const a of [ALPHA, GAMMA]) assert(storedReplies(items, a).length > 0, `${a} has no reply to the side-by-side message`)
  assert(!(await chatLog()).some((i) => 'turn' in i && i.turn !== undefined), 'a stored item still carries `turn` after the turns finished')
  await waitIdle(page)
  const meta = (await chatsJson()).chats.find((c) => c.id === chatId)
  assert(meta.group.active.length === 0 && meta.group.queue.length === 0, `stored group after the run: ${JSON.stringify(meta.group)}`)
  ok(`Side by side: two real turns worked at once (${both}), both replied, no stored item carries turn`)
}

function rowDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i]))
      return `first difference at row ${i}:\nbefore ${JSON.stringify(a[i])}\nafter  ${JSON.stringify(b[i])}`
  }
  return 'no row differs'
}

/** @everyone, typed through the mention menu: the sent bubble shows the everyone chip and the members answer. */
async function stepEveryone(page) {
  await waitIdle(page)
  const before = (await chatLog()).length
  await input(page).click()
  await input(page).pressSequentially('@every')
  await page.locator('[data-testid="mention-menu"]').waitFor({ timeout: 3_000 })
  await page.locator('[data-testid="mention-option"][data-agent-name="everyone"]').click()
  await input(page).pressSequentially('reply with one short word')
  assert((await draftText(page)) === '@everyone reply with one short word', `composer holds ${JSON.stringify(await draftText(page))}`)
  await send(page).click()
  await page.locator('.bubble.user [data-testid="mention"][data-agent-name="everyone"]').last().waitFor({ timeout: 10_000 })
  await waitIdle(page)
  const items = (await chatLog()).slice(before)
  const replies = storedReplies(items)
  assert(replies.length > 0, 'no member replied to the @everyone message')
  for (const r of replies) assert([ALPHA, BETA, GAMMA].includes(r.agent), `a reply came from ${r.agent}, not a member`)
  assert(
    !(await chatLog()).some((i) => 'turn' in i && i.turn !== undefined),
    'a stored item still carries `turn` after the @everyone turns'
  )
  await shot('8-everyone')
  ok(
    `Everyone: chip shown in the sent bubble, replies from ${[...new Set(replies.map((r) => r.agent))].join(', ')}, no stored item carries turn`
  )
}

/** An image attached through the paperclip and sent with an explicit @mention: Gamma sees it as an image block. */
async function stepAttachment(page) {
  await waitIdle(page)
  const before = (await chatLog()).length
  const gammaBefore = storedReplies(await chatLog(), GAMMA).length
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid="attach-button"]').click()])
  await chooser.setFiles(fixturePng)
  await page.locator('[data-testid="draft-attachment"][data-status="ready"]').waitFor({ timeout: 15_000 })
  await input(page).fill('@e2e-gamma what color is this image? One word.')
  await send(page).click()
  await page.locator('[data-testid="sent-thumb"]').first().waitFor({ timeout: 10_000 })
  await poll(page, (t) => replies(t, GAMMA).length > gammaBefore && t, 2 * REPLY_TIMEOUT, 'a new reply from e2e-gamma to the image message')
  await waitIdle(page)
  const items = (await chatLog()).slice(before)
  const gamma = storedReplies(items, GAMMA)
  assert(gamma.length > 0, 'no stored reply from e2e-gamma')
  assert(
    gamma.some((r) => /\bred\b/i.test(r.text)),
    `gamma's reply lacks "red": ${JSON.stringify(gamma.map((r) => r.text))}`
  )
  const width = await page
    .locator('[data-testid="sent-thumb"] img')
    .last()
    .evaluate((img) => img.naturalWidth)
  assert(width > 0, `sent thumbnail did not load (naturalWidth ${width})`)
  await shot('9-group-attachment')
  ok(`Group attachment: red PNG sent with @e2e-gamma, Gamma replied "${gamma[0].text.slice(0, 60)}", thumbnail shown (${width}px)`)
}

async function step6() {
  const page0 = current.page
  await waitIdle(page0)
  const beforeThread = await thread(page0)
  const title = (await page0.locator(`[data-testid="group-row"][data-chat-id="${chatId}"] .group-title`).textContent()).trim()
  assert((await chatsJson()).chats.find((c) => c.id === chatId).inFlight === false, 'chat is still in flight right before the restart')
  await stop()
  const page = await start()
  const row = page.locator(`[data-testid="unassigned-items"] [data-testid="group-row"][data-chat-id="${chatId}"]`)
  await row.waitFor({ timeout: 15_000 })
  assert((await row.locator('.group-title').textContent()).trim() === title, 'group row title changed after restart')
  await row.click()
  await page.locator('[data-testid="chat-members"]').waitFor({ timeout: 10_000 })
  const afterThread = await poll(page, (t) => t.length >= beforeThread.length && t, 15_000, 'the stored thread to render')
  assert(
    JSON.stringify(afterThread) === JSON.stringify(beforeThread),
    `thread differs after restart (${beforeThread.length} rows before, ${afterThread.length} after); ${rowDiff(beforeThread, afterThread)}`
  )
  assert((await page.locator('[data-testid="chat-folder"]').getAttribute('data-tip')) === folder, 'folder picker lost the chat folder')
  await shot('6-restarted')
  ok(`6 restart with the same data dir: group row "${title}" and its ${afterThread.length}-row history are still there`)
}

// ---------- Tasks (queued messages): their own server on the fake claude, data dir seeded before it starts ----------
// The fake prints one script for member turns and moderator calls alike, so every moderator call fails ("Couldn't check
// who else should reply.") and the room falls back to the mentioned member, else the last one to speak. `#SLEEP` before
// the reply makes each of those calls take that long.

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const PAUSED_TEXT = 'Agents paused after 15 turns without you. Send a message to continue.'
// Seeded chats: a single chat holding a task (not paused, so it goes in at start), two groups the hop cap paused that
// hold tasks, and an idle group for a message sent mid-run.
const TQ = { resume: 'tasks-resume', enter: 'tasks-enter', write: 'tasks-write', room: 'tasks-room' }
const RESUMED = 'left from before'
const ENTER_TASKS = ['first held task', 'second held task']
const WRITE_TASKS = ['held one', 'held two']
const WRITTEN = 'written while paused'
let fake = null // harness handle of the Tasks steps
let fakeRoot = null // mkdtemp: data/, agents/, work/
let fakeData = null

async function seedTasks(dataDir, work) {
  const t = Date.now() - 60_000
  const group = { members: [ALPHA, BETA], sessions: {}, seen: {}, role: '', active: [], queue: [] }
  const meta = (id, title, extra) => ({
    id,
    agentName: '',
    sessionId: null,
    cwd: work,
    title,
    createdAt: t,
    updatedAt: t,
    inFlight: false,
    ...extra
  })
  const tasks = (texts) => texts.map((text, k) => ({ id: `${text.replace(/\W+/g, '-')}-id`, text, ts: t + k }))
  const chats = [
    meta(TQ.resume, 'Tasks resumed', { agentName: ALPHA, tasks: tasks([RESUMED]) }),
    meta(TQ.enter, 'Tasks enter', { group, tasks: tasks(ENTER_TASKS) }),
    meta(TQ.write, 'Tasks write', { group, tasks: tasks(WRITE_TASKS) }),
    meta(TQ.room, 'Tasks room', { group })
  ]
  const exchange = (tag) => [
    { type: 'user', id: `${tag}-u`, text: '@e2e-alpha start', ts: t },
    { type: 'assistant', id: `${tag}-a`, text: 'started', ts: t + 1, agent: ALPHA }
  ]
  // The hop cap paused these: the paused notice is the last item, so their tasks are held.
  const paused = (tag) => [...exchange(tag), { type: 'notice', id: `${tag}-n`, kind: 'paused', text: PAUSED_TEXT, ts: t + 2 }]
  const logs = { [TQ.resume]: [], [TQ.enter]: paused('enter'), [TQ.write]: paused('write'), [TQ.room]: exchange('room') }
  await mkdir(join(dataDir, 'chats'), { recursive: true })
  await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ chats }, null, 2))
  for (const [id, items] of Object.entries(logs)) await writeFile(join(dataDir, 'chats', `${id}.json`), JSON.stringify(items, null, 2))
}

async function startFake() {
  fakeRoot = await mkdtemp(join(tmpdir(), `${PREFIX}tasks-`))
  fakeData = join(fakeRoot, 'data')
  const agents = join(fakeRoot, 'agents')
  const work = join(fakeRoot, 'work')
  for (const d of [fakeData, agents, work]) await mkdir(d, { recursive: true })
  for (const [name, raw] of Object.entries(AGENT_FILES)) await writeFile(join(agents, `${name}.md`), raw)
  await seedTasks(fakeData, work)
  if (aborted) throw new Error('aborted (overall timeout or cleanup already started)')
  fake = await startHarness({ mode: 'local', fake: true, dataDir: fakeData, agentsDir: agents })
  allErrors.push(fake.errors)
  if (aborted) {
    await stopFake()
    throw new Error('aborted while launching')
  }
  await fake.page.waitForSelector('[data-testid="new-agent"]', { timeout: 30_000 })
  return fake.page
}

async function stopFake() {
  if (!fake) return
  const h = fake
  fake = null
  await shutDown({ stop: h.stop, pid: h.server.pid })
}

/** Every fake call (member turn or moderator) waits `ms` before it answers "pong". */
async function slowScript(ms) {
  const [init, ...rest] = (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)
  await writeFile(fake.script, [init, `#SLEEP ${ms}`, ...rest].join('\n') + '\n')
}

/** Polls `fn` (node side) until it returns a truthy value. */
async function until(fn, timeout, what) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
    await sleep(150)
  }
}

/** Opens a seeded group and waits for its stored thread (`rows` rows) to render. */
async function openGroup(page, id, rows) {
  const row = page.locator(`[data-testid="unassigned-items"] [data-testid="group-row"][data-chat-id="${id}"]`)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.locator('[data-testid="chat-members"]').waitFor({ timeout: 10_000 })
  await poll(page, (t) => t.length >= rows, 10_000, `the stored thread of ${id}`)
}

const storedUsers = (items) => items.filter((i) => i.type === 'user').map((i) => i.text)
const fakeMeta = async (id) => (await chatsJson(fakeData)).chats.find((c) => c.id === id)

/** At start, resume() sends the task of a chat that is not paused, and leaves the paused groups' tasks held. */
async function stepTasksHeld(page) {
  // resume() runs before the server listens; the control chat proves it did run.
  await until(
    async () => {
      const items = await chatLog(TQ.resume, fakeData)
      const at = items.findIndex((i) => i.type === 'user' && i.text === RESUMED)
      return at >= 0 && items.slice(at).some((i) => i.type === 'assistant')
    },
    15_000,
    `the task of ${TQ.resume} to go in at start`
  )
  assert(((await fakeMeta(TQ.resume)).tasks ?? []).length === 0, `${TQ.resume} still holds its task after start`)
  await sleep(1_500) // nothing may go in late either
  for (const [id, texts] of [
    [TQ.enter, ENTER_TASKS],
    [TQ.write, WRITE_TASKS]
  ]) {
    const meta = await fakeMeta(id)
    const held = (meta.tasks ?? []).map((x) => x.text)
    assert(
      meta.inFlight === false && JSON.stringify(held) === JSON.stringify(texts),
      `${id} after start: inFlight ${meta.inFlight}, tasks ${JSON.stringify(held)}`
    )
    const items = await chatLog(id, fakeData)
    assert(items.length === 3 && items[2].kind === 'paused', `${id} got new items at start: ${JSON.stringify(items.map((i) => i.type))}`)
  }
  await openGroup(page, TQ.write, 3)
  await page.locator('[data-testid="task-row"]').first().waitFor({ timeout: 5_000 })
  assert(JSON.stringify(await taskTexts(page)) === JSON.stringify(WRITE_TASKS), `Tasks lists ${JSON.stringify(await taskTexts(page))}`)
  assert((await tasksHeadText(page)) === 'Tasks · 2', `Tasks header reads ${JSON.stringify(await tasksHeadText(page))}`)
  assert((await page.locator('[data-testid="room-live"]').count()) === 0, 'a paused group shows live turns after start')
  await shot('tasks-held', page)
  ok('Tasks held at start: a paused group keeps its 2 tasks (nothing sent, list shown), a chat that is not paused sent its task')
}

/** Collapse survives a reload; Enter on the second task of an idle (paused) group sends that one, the other stays. */
async function stepTasksEnter(page) {
  await slowScript(1_500)
  await openGroup(page, TQ.enter, 3)
  const rows = page.locator('[data-testid="task-row"]')
  const head = page.locator('[data-testid="tasks-head"]')
  await rows.first().waitFor({ timeout: 5_000 })
  assert(JSON.stringify(await taskTexts(page)) === JSON.stringify(ENTER_TASKS), `Tasks lists ${JSON.stringify(await taskTexts(page))}`)
  assert((await page.locator('[data-testid="task-send"]').count()) === 2, 'an idle chat does not offer Send now on each task')

  await head.click()
  await rows.first().waitFor({ state: 'detached', timeout: 5_000 })
  assert(
    (await tasksHeadText(page)) === 'Tasks · 2' && (await head.getAttribute('aria-expanded')) === 'false',
    `collapsed header reads ${JSON.stringify(await tasksHeadText(page))}`
  )
  await page.reload()
  await openGroup(page, TQ.enter, 3)
  await head.waitFor({ timeout: 5_000 })
  assert((await rows.count()) === 0 && (await head.getAttribute('aria-expanded')) === 'false', 'Tasks opened again after a reload')
  assert((await tasksHeadText(page)) === 'Tasks · 2', `collapsed header reads ${JSON.stringify(await tasksHeadText(page))} after a reload`)
  await shot('tasks-collapsed', page)
  await head.click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="task-row"]').length === 2, undefined, { timeout: 5_000 })

  const before = users(await thread(page)).length
  await watchQueued(page, ENTER_TASKS[1], before)
  await rows.filter({ hasText: ENTER_TASKS[1] }).locator('[data-testid="task-send"]').click()
  const sent = await poll(page, (t) => users(t).length > before && t, 10_000, `"${ENTER_TASKS[1]}" to go in`)
  assert(users(sent)[before].text === ENTER_TASKS[1], `went in: ${JSON.stringify(users(sent)[before])}`)
  assert(
    JSON.stringify(await taskTexts(page)) === JSON.stringify([ENTER_TASKS[0]]),
    `Tasks lists ${JSON.stringify(await taskTexts(page))} after Enter`
  )
  await page.locator('[data-testid="room-live"]').waitFor({ timeout: 5_000 })
  assert((await page.locator('[data-testid="task-send"]').count()) === 0, 'Send now is offered while the room runs')
  assert(
    !(await queueLog(page)).some((s) => s.row && s.bubble),
    `"${ENTER_TASKS[1]}" showed as a row and a bubble at once: ${JSON.stringify(await queueLog(page))}`
  )
  await shot('tasks-enter', page)

  // The room is no longer paused, so the other task goes in once that run has ended.
  await poll(page, (t) => users(t).length > before + 1, 30_000, `"${ENTER_TASKS[0]}" to go in after the run`)
  await waitIdle(page, TQ.enter, fakeData)
  const sentOrder = storedUsers(await chatLog(TQ.enter, fakeData))
  assert(
    JSON.stringify(sentOrder) === JSON.stringify(['@e2e-alpha start', ENTER_TASKS[1], ENTER_TASKS[0]]),
    `stored user messages ${JSON.stringify(sentOrder)}`
  )
  ok(
    'Tasks collapse + Enter: collapsed "Tasks · 2" stays collapsed after a reload; Enter on the 2nd task sent it, the 1st stayed until that run ended'
  )
}

/** A message written in a paused group goes straight in; the held tasks stay until its run has ended. */
async function stepTasksWrite(page) {
  await slowScript(2_000) // the checks below run while the written message's room still runs
  await openGroup(page, TQ.write, 3)
  await page.locator('[data-testid="task-row"]').first().waitFor({ timeout: 5_000 })
  const before = users(await thread(page)).length
  await input(page).fill(WRITTEN)
  await send(page).click()
  const shown = await poll(page, (t) => users(t).length > before && t, 3_000, `"${WRITTEN}" to go straight in`)
  assert(users(shown)[before].text === WRITTEN, `went in: ${JSON.stringify(users(shown)[before])}`)
  await page.locator('[data-testid="room-live"]').waitFor({ timeout: 5_000 })
  assert(
    JSON.stringify(await taskTexts(page)) === JSON.stringify(WRITE_TASKS),
    `Tasks lists ${JSON.stringify(await taskTexts(page))} while the written message runs`
  )
  assert((await tasksHeadText(page)) === 'Tasks · 2', `Tasks header reads ${JSON.stringify(await tasksHeadText(page))}`)
  const items = await until(
    async () => {
      const all = await chatLog(TQ.write, fakeData)
      return all.some((i) => i.type === 'user' && i.text === WRITTEN) && all
    },
    5_000,
    `"${WRITTEN}" to be stored`
  )
  assert(
    items[3]?.type === 'user' && items[3].text === WRITTEN,
    `"${WRITTEN}" is not stored right after the paused notice: ${JSON.stringify(items.map((i) => i.type))}`
  )
  const meta = await fakeMeta(TQ.write)
  assert(
    JSON.stringify((meta.tasks ?? []).map((x) => x.text)) === JSON.stringify(WRITE_TASKS),
    `stored tasks ${JSON.stringify(meta.tasks)} while the written message runs`
  )
  await shot('tasks-written', page)

  // Then the held tasks flow, oldest first, one run each.
  await poll(page, (t) => users(t).length >= before + 3, 60_000, 'both held tasks to go in after the written message')
  await waitIdle(page, TQ.write, fakeData)
  const sentOrder = storedUsers(await chatLog(TQ.write, fakeData))
  assert(
    JSON.stringify(sentOrder) === JSON.stringify(['@e2e-alpha start', WRITTEN, ...WRITE_TASKS]),
    `stored user messages ${JSON.stringify(sentOrder)}`
  )
  ok(`Tasks paused + written: "${WRITTEN}" went straight in with both tasks still listed, which then went in oldest first`)
}

/** A message sent while a member works waits in Tasks for the whole room, while the member's turn shows in the thread. */
async function stepTasksRoom(page) {
  await slowScript(2_500)
  await openGroup(page, TQ.room, 2)
  await watchStatus(page)
  await input(page).fill('@e2e-alpha one')
  await send(page).click()
  await poll(page, (_t, st) => isWorking(st, ALPHA), 20_000, `${ALPHA} to start working`)
  const before = users(await thread(page)).length
  await watchQueued(page, 'two', before)
  await input(page).fill('two')
  await send(page).click()
  await page.locator('[data-testid="task-row"]').first().waitFor({ timeout: 3_000 })
  assert(JSON.stringify(await taskTexts(page)) === JSON.stringify(['two']), `Tasks lists ${JSON.stringify(await taskTexts(page))}`)
  assert(
    await page.locator(`[data-testid="live-turn"][data-agent-name="${ALPHA}"]`).isVisible(),
    `${ALPHA}'s turn is not shown in the thread while the task waits`
  )
  assert(users(await thread(page)).length === before, '"two" went into the thread while the room ran')
  const inThread = await page.evaluate(() => {
    const tasks = document.querySelector('[data-testid="tasks-tray"]')
    const live = document.querySelector('[data-testid="message-list"] [data-testid="room-live"]')
    return !!tasks && !!live && (live.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  })
  assert(inThread, 'the running turn is not in the thread above Tasks')
  await shot('tasks-room-queued', page)

  await poll(page, (t) => users(t).length > before, 30_000, '"two" to go in from Tasks')
  checkWaited(await queueLog(page), '"two"')
  await waitIdle(page, TQ.room, fakeData)
  const items = await chatLog(TQ.room, fakeData)
  const twoAt = items.findIndex((i) => i.type === 'user' && i.text === 'two')
  const reply = items.findIndex((i, k) => k > 2 && i.type === 'assistant' && i.agent === ALPHA)
  // The room ends after routing alpha's reply (a moderator call, which fails here and leaves a notice): "two" comes after both.
  assert(
    reply > 0 && twoAt > reply + 1 && items[twoAt - 1].type === 'notice',
    `stored order: ${items.map((i) => i.type + (i.agent ? '(' + i.agent + ')' : '')).join(' > ')}`
  )
  ok(`Tasks mid-run: "two" sent while ${ALPHA} worked (its turn in the thread) waited in Tasks, went in after the room went idle`)
}

// ---------- main ----------

async function main() {
  try {
    execFileSync('pgrep', ['--version'], { stdio: 'ignore' })
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error('pgrep is not installed; the cleanup cannot find child processes')
  }
  folder = await mkdtemp(join(tmpdir(), PREFIX))
  userData = await mkdtemp(join(tmpdir(), `${PREFIX}data-`))
  agentsDir = join(folder, '.claude', 'agents')
  await mkdir(agentsDir, { recursive: true })
  for (const [name, raw] of Object.entries(AGENT_FILES)) await writeFile(join(agentsDir, `${name}.md`), raw)
  await mkdir(join(userData, 'fixtures'))
  fixturePng = join(userData, 'fixtures', 'red.png')
  await writeFile(fixturePng, redPng(32))
  log(`folder=${folder} dataDir=${userData}`)

  // Tasks first, on the fake claude: a failure there costs no real CLI call.
  const fp = await startFake()
  await stepTasksHeld(fp)
  await stepTasksEnter(fp)
  await stepTasksWrite(fp)
  await stepTasksRoom(fp)
  await stopFake()

  const page = await start()
  await step1(page)
  await step2and3(page)
  await stepRole()
  await step4(page)
  await step5(page)
  await stepSideBySide(page)
  await stepEveryone(page)
  await stepAttachment(page)
  await step6()
}

const safe = (p) => p !== null && p.startsWith(tmpdir() + sep) && basename(p).startsWith(PREFIX)
let failed = false
let timer
try {
  await Promise.race([
    main(),
    new Promise((_, rej) => {
      timer = setTimeout(() => {
        aborted = true
        rej(new Error('overall e2e timeout (8 min)'))
      }, OVERALL_TIMEOUT)
    })
  ])
} catch (err) {
  failed = true
  if (err instanceof Blocked) console.error(`BLOCKED: ${err.message}`)
  console.error(err)
  if (current) await shot('failure').catch(() => {})
  if (fake) await shot('failure-tasks', fake.page).catch(() => {})
} finally {
  aborted = true
  clearTimeout(timer)
  await stop().catch((e) => console.error('stop failed', e))
  await stopFake().catch((e) => console.error('stop failed', e))
  for (const dir of [folder, userData, fakeRoot]) {
    if (dir === null) continue
    if (safe(dir)) await rm(dir, { recursive: true, force: true })
    else console.error(`refusing to delete unexpected path ${dir}`)
  }
}

const flat = allErrors.flat()
if (flat.length) {
  failed = true
  log(`console or main errors:\n${flat.join('\n')}`)
} else log('no console or main errors')
if (!failed && results.length !== STEPS) {
  failed = true
  console.error(`expected ${STEPS} step results, got ${results.length}`)
}
log(`total ${secs()}`)
process.exit(failed ? 1 : 0)
