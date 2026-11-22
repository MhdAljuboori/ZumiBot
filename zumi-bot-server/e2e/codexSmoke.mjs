// Smoke of a Codex agent against the REAL `codex` CLI, through the built server and the web UI (local mode, manual permission
// mode; step 9 on a second server in auto mode). Not part of `npm run e2e`: it spends real quota (a few cents). Usage: npm run
// smoke:codex (builds first)
//
// The harness runs with fake:false, so the server keeps the real HOME and `codex` signs in with the real ~/.codex login.
// Nothing here reads, prints or copies ~/.codex (auth.json least of all); `codex login status` is run with its output dropped.
// Steps, each judged PASS, FAIL or INCONCLUSIVE (the model did something else; not a product verdict):
//   1. "run `ls` and tell me how many files are in this folder": a Bash card is approved on the page, the reply streams and
//      says 3 (the temp folder holds three files).
//   2. "use your to-do tool to add the item 'smoke test'": the real zumibot_todos bridge, reached through
//      `mcp_servers.<name>.env_vars`, adds it with no card (the server answers the elicitation itself).
//   3. "run `sleep 60` then say done": the card is approved, Stop is pressed while it sleeps; the chat ends with the stopped
//      notice and no `codex app-server` of this run (nor its `sleep`) is left running.
//   4. an edit of notes.txt (made in the temp folder for this step): its ApplyPatch card is approved only when every path is
//      inside the temp folder; the file changes as asked and the Files panel lists it with the diff. A write with no card
//      (manual mode) is a FAIL.
//   5. a typed `/btw` about that edit: answered from an ephemeral read-only fork with no card, no chat item, nothing left running.
//   6. Compact: "Compacting…", then the compacted ring with no item added; one short turn then proves the thread still answers.
//   7. Pause during an approved `sleep 30`: the sleep finishes, any later call of the agent is blocked by the pause hook, the
//      turn lands paused (the Paused notice, Resume); Resume sends Continue on the same thread and the agent answers.
//   8. A room of two Codex agents: the one mentioned answers on Codex (its session marked codex); the moderator is the real
//      `claude` (a tiny call on the Claude plan), as in every room.
//   9. On a second server in AUTO mode (no card gates a read there): a dummy API key is saved for the agent, which makes the
//      harness's temp vault key (never ~/.config/zumibot-vault), and the agent is asked to `cat` that key file; the vault
//      hook must block it (a Blocked row with the guard's text) and the key's text must reach nothing (judgeVaultStep).
// Cards go through smokeGate.mjs: a card is approved only when the command stored for it is exactly a shape its step asks for,
// or (step 4 only) its patch touches only the temp folder; any other card, or one whose request can't be read, is denied,
// printed (a patch by its paths only, never its diff) and makes its step INCONCLUSIVE (never PASS).
// Exit 0 all PASS, 1 any FAIL, 2 otherwise (no codex, not signed in, a step INCONCLUSIVE).

import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { start } from './harness.mjs'
import { killOwnedChild } from './e2eChecks.mjs'
import { isAllowedSmokeCommand, isAllowedSmokePatch, judgeVaultStep, judgePauseHooks } from './smokeGate.mjs'

const AGENT = 'smoke-codex'
const AGENT2 = 'smoke-codex-two' // the room's second member
// Verbatim from shared/src/pause.ts and backend/src/core/vault/vaultGuard.ts.
const PAUSE_MARKER = '(zumibot-pause)'
const VAULT_GUARD_TEXT =
  'ZumiBot keeps the vault private: agents may not read its files. Use vault_items and browser_fill_from_vault instead.'
const UNGUARDED_LINE = /codex hooks not confirmed/
const TURN_MS = 180_000
const T = 15_000
const NOTES_BEFORE = 'line one\nline two\nline three\n'
const SIDE_MS = 200_000 // past the side answer's own 3 minutes
const tid = (id) => `[data-testid="${id}"]`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let h = null
let folder = null // the agent's temp folder: the only place a patch may be approved
const made = []
const results = []
const t0 = Date.now()
const say = (m) => console.log(`${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
const verdict = (step, v, note) => {
  results.push({ step, v, note })
  say(`smoke: ${step}: ${v}${note ? ` (${note})` : ''}`)
}

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const sidesOf = async (id) =>
  readFile(join(h.dataDir, 'chats', `${id}.btw.json`), 'utf8').then(
    (t) => JSON.parse(t).items,
    () => []
  )

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

/** Processes (pid, args) whose working folder is `dir` or below and whose command line matches `re`. Linux /proc only. */
function processesIn(dir, re) {
  const found = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`)
      if (cwd !== dir && !cwd.startsWith(`${dir}/`)) continue
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      if (re.test(args)) found.push({ pid: Number(name), args })
    } catch {
      /* gone, or not ours to read */
    }
  }
  return found
}

/** `p` through every link (its nearest existing folder resolved, the rest as written); null for a dangling link or a read error. */
function realOf(p) {
  const rest = []
  let cur = p
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest)
    } catch {
      /* missing, or a link that leads nowhere */
    }
    try {
      lstatSync(cur)
      return null
    } catch {
      /* missing: its folder decides */
    }
    const up = dirname(cur)
    if (up === cur) return null
    rest.unshift(basename(cur))
    cur = up
  }
}

/** What a denied card is printed as: a command as sent, a patch by its paths and kinds only (its diff may hold a file's text). */
function cardText(req) {
  if (req === null) return '(a card whose request could not be read)'
  if (req.command !== null) return req.command
  if (req.tool === 'ApplyPatch') {
    const changes = Array.isArray(req.input?.changes) ? req.input.changes : []
    return `ApplyPatch ${JSON.stringify(changes.map((c) => ({ path: c?.path, kind: c?.kind, ...(c?.movePath !== undefined ? { movePath: c.movePath } : {}) })))}`
  }
  return `${req.tool} ${JSON.stringify(req.input ?? null)}`
}

/** The request a pending card stands for, as the server stored it: the tool and, for Bash, the exact command; null if unread. */
async function storedRequest(chatId, id) {
  if (!chatId || !id) return null
  for (let i = 0; i < 20; i++) {
    const item = (await itemsOf(chatId)).find((x) => x.type === 'approval' && x.id === id)
    if (item)
      return {
        tool: String(item.toolName),
        command: item.toolName === 'Bash' && typeof item.input?.command === 'string' ? item.input.command : null,
        input: item.input
      }
    await sleep(150)
  }
  return null
}

/**
 * Answers one pending card at `step` ('ls', 'sleep', 'edit', or 'todo'/'none', where nothing is approved): Allow once only when
 * the gate says so, else Deny. Fails closed: a card it cannot read is denied. Returns what was decided, printing every denial.
 */
async function answerCard(chatId, card, step) {
  const id = await card.getAttribute('data-request-id').catch(() => null)
  const req = await storedRequest(chatId, id).catch(() => null)
  const allow =
    req !== null &&
    (req.tool === 'Bash'
      ? isAllowedSmokeCommand(req.command, step)
      : req.tool === 'ApplyPatch' && step === 'edit' && folder !== null && isAllowedSmokePatch(req.input, folder, realOf))
  const text = cardText(req)
  await card.locator(tid(allow ? 'approval-allow-once' : 'approval-deny')).click()
  if (!allow) say(`smoke: denied card at step ${step}: ${text}`)
  return { id, tool: req?.tool ?? null, text, allowed: allow }
}

/**
 * Sends `text` in the open chat (or, with `sent`, follows a turn already sent from the new-chat screen, the chat id taken from the
 * address) and answers every pending card at `step`, until the chat is idle again or `until()` says to stop waiting.
 * Returns the chat id and the cards answered.
 */
async function turn(page, chatId, text, { step, until = null, timeout = TURN_MS, sent = false } = {}) {
  const before = chatId ? (await itemsOf(chatId)).length : 0
  if (!sent) {
    await page.locator(tid('composer-input')).click()
    await page.keyboard.type(text)
    await page.click(tid('send-button'))
  }
  const cards = []
  const end = Date.now() + timeout
  let started = false
  while (Date.now() < end) {
    chatId ??= /\/chat\/([^/?#]+)$/.exec(new URL(page.url()).pathname)?.[1] ?? null
    const card = page.locator(`${tid('approval-card')}[data-status="pending"]`).first()
    if (chatId && (await card.count())) {
      const id = await card.getAttribute('data-request-id').catch(() => null)
      if (!cards.some((c) => c.id === id)) cards.push(await answerCard(chatId, card, step))
    }
    if (until && (await until(cards))) return { chatId, cards }
    const m = chatId ? await metaOf(chatId) : null
    if (m?.inFlight) started = true
    if (started && m && !m.inFlight && (await itemsOf(chatId)).length > before) return { chatId, cards }
    await sleep(250)
  }
  throw new Error(`the turn "${text}" did not end in ${timeout / 1000} s`)
}

const denials = (cards) => cards.filter((c) => !c.allowed).map((c) => c.text)
const cardList = (cards) => JSON.stringify(cards.map((c) => `${c.allowed ? 'allowed' : 'denied'}: ${c.text}`))

/** Opens the side panel's list from whatever the panel shows now. */
async function openSideMenu(page) {
  for (let i = 0; i < 4; i++) {
    if (
      await page
        .locator(tid('side-menu'))
        .isVisible()
        .catch(() => false)
    )
      return
    await page.click(tid('side-panel-toggle'))
    await sleep(150)
  }
  throw new Error('the side panel list did not open')
}

/** Notes whether a pending approval card shows on the page until `cardSeen` reads it. */
const watchCards = (page) =>
  page.evaluate(() => {
    window.__cardSeen = false
    window.__cardObserver?.disconnect()
    window.__cardObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="approval-card"][data-status="pending"]')) window.__cardSeen = true
    })
    window.__cardObserver.observe(document.body, { childList: true, subtree: true, attributes: true })
  })
const cardSeen = (page) => page.evaluate(() => (window.__cardObserver?.disconnect(), window.__cardSeen))

const lastReply = async (chatId) => (await itemsOf(chatId)).filter((i) => i.type === 'assistant').at(-1)?.text ?? ''
const errorsSince = async (chatId, n) =>
  (await itemsOf(chatId))
    .slice(n)
    .filter((i) => i.type === 'error')
    .map((i) => i.text)

async function main() {
  const login = spawnSync('codex', ['login', 'status'], { stdio: 'ignore', timeout: 20_000 })
  if (login.error) return verdict('setup', 'INCONCLUSIVE', 'codex is not on the PATH')
  if (login.status !== 0) return verdict('setup', 'INCONCLUSIVE', 'codex is not signed in (codex login status failed)')
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 20_000 }).stdout?.trim() ?? '?'
  say(`smoke: ${version}`)

  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `zumibot-codex-smoke-${n}-`))), made.at(-1))
  folder = await mk('folder')
  for (const [f, body] of [
    ['alpha.txt', 'one\n'],
    ['beta.txt', 'two\n'],
    ['notes.md', '# Notes\n']
  ])
    await writeFile(join(folder, f), body)
  // A git folder, as the probe's: Codex treats a repo as a project; `.git` is hidden from `ls`.
  spawnSync('git', ['init', '-q'], { cwd: folder })
  const agentsDir = await mk('agents')
  // The user's own Codex plugins load too, and their skills ask the model to read skill files first; the gate would deny those
  // cards and leave the step INCONCLUSIVE, so the body asks for only the named commands.
  const body =
    'You are a helpful coding agent. Keep replies to one or two sentences. Run only the exact commands the user names, as they are written, and when the user asks for an edit, make it with your patch tool and nothing else. Do not read skill, plugin or config files, and run nothing else first.'
  await writeFile(join(agentsDir, `${AGENT}.md`), `---\nname: ${AGENT}\ndescription: Codex smoke agent.\nprovider: codex\n---\n${body}\n`)
  await writeFile(
    join(agentsDir, `${AGENT2}.md`),
    `---\nname: ${AGENT2}\ndescription: Second Codex smoke agent, for the room.\nprovider: codex\n---\n${body}\n`
  )
  h = await start({ agentsDir, env: { ZUMIBOT_TEST_PICK_FOLDER: folder } })
  const page = h.page
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })
  await page.click(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
  await page.click(tid('new-chat-folder'))
  await page.click(tid('new-chat-choose-folder'))
  await page.evaluate(() => {
    window.__sawStreaming = false
    new MutationObserver(() => {
      if (document.querySelector('[data-streaming]')) window.__sawStreaming = true
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
  })

  // 1. ls with an approved card
  let chatId = null
  {
    await page.locator(tid('composer-input')).click()
    await page.keyboard.type('run `ls` and tell me how many files are in this folder')
    await page.click(tid('send-button'))
    let cards
    ;({ chatId, cards } = await turn(page, null, 'run `ls`…', { step: 'ls', sent: true }))
    const meta = await metaOf(chatId)
    const reply = await lastReply(chatId)
    const errors = await errorsSince(chatId, 0)
    const tools = (await itemsOf(chatId)).filter((i) => i.type === 'tool')
    const ranLs = tools.some((t) => t.name === 'Bash' && isAllowedSmokeCommand(t.input?.command, 'ls') && !t.isError)
    const denied = denials(cards)
    const note = `cards ${JSON.stringify(cards.map((c) => `${c.allowed ? 'allowed' : 'denied'}: ${c.text}`))}, reply ${JSON.stringify(reply.slice(0, 200))}, streaming seen ${await page.evaluate(() => window.__sawStreaming)}, session ${meta?.sessionEngine ?? 'none'}`
    if (errors.length) verdict('1 ls + approved card', 'FAIL', `errors ${JSON.stringify(errors)}; ${note}`)
    else if (denied.length) verdict('1 ls + approved card', 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else if (cards.length === 0 || !ranLs) verdict('1 ls + approved card', 'INCONCLUSIVE', `the model ran no approved ls; ${note}`)
    else if (!/\b(3|three)\b/i.test(reply)) verdict('1 ls + approved card', 'INCONCLUSIVE', `the reply does not say 3; ${note}`)
    else if (!(await page.evaluate(() => window.__sawStreaming)) || meta?.sessionEngine !== 'codex')
      verdict('1 ls + approved card', 'FAIL', note)
    else verdict('1 ls + approved card', 'PASS', note)
  }

  // 2. the to-do bridge on real codex (env_vars carry the capability; the elicitation is answered with no card)
  {
    const n = (await itemsOf(chatId)).length
    // Nothing is approved at this step: a card for the own bridge would be a bug, and no other tool is needed.
    const { cards } = await turn(page, chatId, "use your to-do tool to add the item 'smoke test'", { step: 'todo' })
    const todos = (await rpc(page, 'todos:list', chatId)).items
    const added = todos.find((t) => /smoke test/i.test(t.text) && t.removed === null)
    const errors = await errorsSince(chatId, n)
    const calls = (await itemsOf(chatId))
      .slice(n)
      .filter((i) => i.type === 'tool')
      .map((t) => t.name)
    const note = `denied cards ${JSON.stringify(denials(cards))}, to-dos ${JSON.stringify(todos.map((t) => t.text))}, tool rows ${JSON.stringify(calls)}, errors ${JSON.stringify(errors)}`
    if (cards.some((c) => c.tool?.startsWith('mcp__zumibot_todos__')))
      verdict('2 to-do bridge', 'FAIL', `a card was shown for the own bridge; ${note}`)
    else if (cards.length) verdict('2 to-do bridge', 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else if (added) verdict('2 to-do bridge', 'PASS', note)
    else if (errors.length) verdict('2 to-do bridge', 'FAIL', note)
    else verdict('2 to-do bridge', 'INCONCLUSIVE', `no item was added; ${note}`)
  }

  // 3. Stop while an approved `sleep 60` runs
  {
    const n = (await itemsOf(chatId)).length
    let approvedAt = null
    let stopped = false
    const { cards } = await turn(page, chatId, 'run `sleep 60` then say done', {
      step: 'sleep',
      // Stop a few seconds after the sleep was allowed, while it runs.
      until: async (seen) => {
        if (approvedAt === null && seen.some((c) => c.allowed)) approvedAt = Date.now()
        if (stopped || approvedAt === null || Date.now() - approvedAt < 4000) return false
        const button = page.locator(tid('send-button'))
        if ((await button.getAttribute('data-tip')) !== 'Stop') return false
        const running = processesIn(folder, /\bsleep 60\b/).length
        await button.click()
        stopped = true
        say(`smoke: Stop pressed (${running} sleep process(es) running in the folder)`)
        return true
      },
      timeout: 120_000
    })
    let notice = null
    const end = Date.now() + 30_000
    while (Date.now() < end) {
      const m = await metaOf(chatId)
      notice = (await itemsOf(chatId)).slice(n).find((i) => i.type === 'notice' && i.kind === 'stopped') ?? null
      if (m && !m.inFlight && notice) break
      await sleep(250)
    }
    const stopMs = approvedAt === null ? null : Date.now() - approvedAt
    await sleep(2000) // the kill ladder's first step is 3 s after the interrupt; give stray children a moment to show
    const left = processesIn(folder, /app-server/)
    const sleeps = processesIn(folder, /\bsleep 60\b/)
    const note = `cards ${JSON.stringify(cards.map((c) => `${c.allowed ? 'allowed' : 'denied'}: ${c.text}`))}, stopped notice ${notice ? 'yes' : 'no'} (${stopMs} ms after approval), codex app-servers left ${left.length}, sleep left ${sleeps.length}`
    for (const p of [...left, ...sleeps])
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    if (!stopped) verdict('3 Stop during sleep 60', 'INCONCLUSIVE', `the model never ran an approved sleep; ${note}`)
    else if (!notice || left.length > 0 || sleeps.length > 0) verdict('3 Stop during sleep 60', 'FAIL', note)
    else if (denials(cards).length) verdict('3 Stop during sleep 60', 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else verdict('3 Stop during sleep 60', 'PASS', note)
  }

  // 4. an edit of notes.txt behind its ApplyPatch card, gated to the temp folder; the Files panel then lists it with its diff
  {
    const notes = join(folder, 'notes.txt')
    await writeFile(notes, NOTES_BEFORE)
    const n = (await itemsOf(chatId)).length
    const { cards } = await turn(
      page,
      chatId,
      'In notes.txt, change the line "line two" to "line TWO changed". Use your patch tool and run no commands.',
      { step: 'edit' }
    )
    const after = await readFile(notes, 'utf8').catch(() => null)
    const changed = after !== null && /^line TWO changed$/m.test(after) && !/^line two$/m.test(after)
    const errors = await errorsSince(chatId, n)
    const patchRows = (await itemsOf(chatId)).slice(n).filter((i) => i.type === 'tool' && i.name === 'ApplyPatch')
    const patched = cards.filter((c) => c.tool === 'ApplyPatch' && c.allowed)
    let panel = 'not checked'
    if (changed && patched.length > 0) {
      await openSideMenu(page)
      await page.click(tid('side-open-files'))
      await page.locator(tid('files-panel')).waitFor({ timeout: T })
      const row = page.locator(`${tid('file-row')}[data-path$="/notes.txt"]`)
      if (
        await row.waitFor({ timeout: T }).then(
          () => true,
          () => false
        )
      ) {
        await row.click()
        await page
          .locator(`${tid('file-rows')} > [data-row]`)
          .first()
          .waitFor({ timeout: T })
          .catch(() => {})
        const rows = await page
          .locator(`${tid('file-rows')} > [data-row]`)
          .evaluateAll((els) =>
            els.map((e) => ({ kind: e.dataset.kind ?? e.dataset.testid, code: e.querySelector('.code')?.textContent ?? e.textContent }))
          )
        panel =
          rows.some((r) => r.kind === 'del' && r.code === 'line two') && rows.some((r) => r.kind === 'add' && r.code === 'line TWO changed')
            ? 'notes.txt with the diff'
            : `notes.txt, rows ${JSON.stringify(rows.slice(0, 8))}`
      } else panel = 'notes.txt missing'
      await page
        .locator(tid('files-close'))
        .click()
        .catch(() => {})
    }
    const note = `cards ${cardList(cards)}, notes.txt changed ${changed}, patch rows ${JSON.stringify(patchRows.map((r) => ({ isError: r.isError === true, changes: (r.changes ?? []).map((c) => (c?.path ? basename(c.path) : null)) })))}, Files panel ${panel}, errors ${JSON.stringify(errors)}`
    if (errors.length) verdict('4 edit + gated patch card', 'FAIL', note)
    else if (denials(cards).length) verdict('4 edit + gated patch card', 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else if (changed && patched.length === 0)
      verdict('4 edit + gated patch card', 'FAIL', `the file changed with no card in manual mode; ${note}`)
    else if (!changed) verdict('4 edit + gated patch card', 'INCONCLUSIVE', `the model made no edit as asked; ${note}`)
    else if (panel !== 'notes.txt with the diff') verdict('4 edit + gated patch card', 'FAIL', note)
    else verdict('4 edit + gated patch card', 'PASS', note)
  }

  // 5. /btw about that edit: an ephemeral read-only fork answers, with no card, no chat item and no process left behind
  {
    const items = (await itemsOf(chatId)).length
    const question = 'Which line of notes.txt did you change? Answer in one sentence from memory, without tools.'
    await watchCards(page)
    await page.locator(tid('composer-input')).fill(`/btw ${question}`)
    await page.click(tid('send-button'))
    let entry = null
    const end = Date.now() + SIDE_MS
    while (Date.now() < end) {
      entry = (await sidesOf(chatId)).find((e) => e.question === question) ?? null
      if (entry && entry.state !== 'running' && entry.state !== 'picking') break
      await sleep(500)
    }
    await sleep(2000) // the side run's process ends after its answer
    const left = processesIn(folder, /app-server/)
    const seen = await cardSeen(page)
    const itemsNow = (await itemsOf(chatId)).length
    const note = `state ${entry?.state ?? 'none'}, answer ${JSON.stringify((entry?.answer ?? '').slice(0, 200))}, error ${JSON.stringify(entry?.error ?? null)}, card shown ${seen}, chat items ${items} -> ${itemsNow}, codex app-servers left ${left.length}`
    for (const p of left)
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    if (!entry) verdict('5 /btw side answer', 'FAIL', `no side question was stored; ${note}`)
    else if (entry.state === 'error' && entry.error === 'Took too long')
      verdict('5 /btw side answer', 'INCONCLUSIVE', `the model took past the side answer's 3 minutes; ${note}`)
    else if (seen || itemsNow !== items || left.length > 0 || entry.state !== 'done') verdict('5 /btw side answer', 'FAIL', note)
    else if (!/TWO|line two|second line/i.test(entry.answer))
      verdict('5 /btw side answer', 'INCONCLUSIVE', `the answer does not name the edited line; ${note}`)
    else verdict('5 /btw side answer', 'PASS', note)
  }

  // 6. Compact on the chat's thread, then one short turn on the compacted thread
  {
    const n = (await itemsOf(chatId)).length
    const chip = page.locator(tid('context-chip'))
    if (!(await chip.count())) verdict('6 Compact', 'INCONCLUSIVE', 'no context meter showed (no turn reported its size)')
    else {
      await chip.click()
      await page.locator(tid('context-popup')).waitFor({ timeout: T })
      const noteField = await page.locator(tid('context-note')).count()
      await page.locator(tid('context-compact')).click()
      const sawCompacting = await page
        .locator('.working')
        .filter({ hasText: 'Compacting…' })
        .waitFor({ timeout: T })
        .then(
          () => true,
          () => false
        )
      let meta = null
      const end = Date.now() + 180_000
      while (Date.now() < end) {
        meta = await metaOf(chatId)
        if (meta && !meta.inFlight && !meta.compacting) break
        await sleep(500)
      }
      const title = await chip.getAttribute('data-tip').catch(() => null)
      const errors = await errorsSince(chatId, n)
      const added = (await itemsOf(chatId)).length - n
      const compacted = meta?.context?.used === null
      const { cards } = await turn(page, chatId, 'In one word, which file did you edit? Run nothing.', { step: 'none' })
      const reply = await lastReply(chatId)
      const later = await errorsSince(chatId, n)
      const note = `note field ${noteField}, "Compacting…" seen ${sawCompacting}, ring ${JSON.stringify(title)}, context ${JSON.stringify(meta?.context ?? null)}, items added ${added}, errors ${JSON.stringify(later)}, then cards ${cardList(cards)} and reply ${JSON.stringify(reply.slice(0, 200))}`
      if (errors.length || later.length || noteField !== 0 || added !== 0 || !compacted) verdict('6 Compact', 'FAIL', note)
      else if (cards.length) verdict('6 Compact', 'INCONCLUSIVE', `the follow-up turn asked for a tool; ${note}`)
      else if (!/notes/i.test(reply)) verdict('6 Compact', 'INCONCLUSIVE', `the follow-up does not name notes.txt; ${note}`)
      else verdict('6 Compact', 'PASS', note)
    }
  }

  // 7. Pause while an approved `sleep 30` runs, then Resume
  {
    const errorsAt = h.errors.length // include fallback from both this turn and Resume
    const n = (await itemsOf(chatId)).length
    let approvedAt = null
    let pressed = false
    const { cards } = await turn(page, chatId, 'run `sleep 30` then say done', {
      step: 'pause',
      // Pause a few seconds after the sleep was allowed, while it runs: the sleep finishes, nothing after it starts.
      until: async (seen) => {
        if (approvedAt === null && seen.some((c) => c.allowed)) approvedAt = Date.now()
        if (pressed || approvedAt === null || Date.now() - approvedAt < 4000) return false
        const button = page.locator(tid('pause-button'))
        if (!(await button.isVisible().catch(() => false)) || (await button.isDisabled().catch(() => true))) return false
        await button.click()
        pressed = true
        say('smoke: Pause pressed')
        return true
      },
      timeout: 120_000
    })
    // The pause lands when the turn ends; a card meanwhile is denied (a blocked call never asks, check 11).
    let meta = null
    const end = Date.now() + 120_000
    while (pressed && Date.now() < end) {
      meta = await metaOf(chatId)
      if (meta?.pause === 'paused' && !meta.inFlight) break
      const card = page.locator(`${tid('approval-card')}[data-status="pending"]`).first()
      if (await card.count()) cards.push(await answerCard(chatId, card, 'none'))
      await sleep(500)
    }
    const during = (await itemsOf(chatId)).slice(n)
    const blockedRows = during.filter(
      (i) => i.type === 'tool' && i.name === 'Blocked' && typeof i.result === 'string' && i.result.includes(PAUSE_MARKER)
    ).length
    const notice = during.at(-1)?.type === 'notice' && during.at(-1).kind === 'userPaused'
    const resumeShown = await page
      .locator(tid('resume-button'))
      .isVisible()
      .catch(() => false)
    let resumed = { reply: '', errors: [], cards: [], pause: undefined, continueSent: false }
    if (meta?.pause === 'paused' && notice && resumeShown) {
      const m = (await itemsOf(chatId)).length
      await page.locator(tid('resume-button')).click()
      const r = await turn(page, chatId, 'Continue', { step: 'none', sent: true })
      const after = (await itemsOf(chatId)).slice(m)
      resumed = {
        reply: after.filter((i) => i.type === 'assistant').at(-1)?.text ?? '',
        errors: after.filter((i) => i.type === 'error').map((i) => i.text),
        cards: r.cards,
        pause: (await metaOf(chatId))?.pause,
        continueSent: after.some((i) => i.type === 'user' && i.text === 'Continue')
      }
    }
    await sleep(2000)
    const left = processesIn(folder, /app-server|\bsleep 30\b/)
    for (const p of left)
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    const errors = during.filter((i) => i.type === 'error').map((i) => i.text)
    const note = `cards ${cardList(cards)}, paused ${meta?.pause ?? 'no'}, Paused notice ${notice}, Resume shown ${resumeShown}, blocked rows ${blockedRows}, then Continue sent ${resumed.continueSent}, reply ${JSON.stringify(resumed.reply.slice(0, 200))}, pause after ${resumed.pause ?? 'none'}, errors ${JSON.stringify([...errors, ...resumed.errors])}, processes left ${left.length}`
    const hooks = judgePauseHooks({ logs: h.errors.slice(errorsAt), blockedRows })
    if (hooks.verdict === 'FAIL') verdict('7 Pause and Resume', 'FAIL', `${hooks.note}; ${note}`)
    else if (!pressed) verdict('7 Pause and Resume', 'INCONCLUSIVE', `the model never ran an approved sleep 30; ${note}`)
    else if (
      errors.length ||
      resumed.errors.length ||
      left.length ||
      meta?.pause !== 'paused' ||
      !notice ||
      !resumeShown ||
      !resumed.continueSent ||
      resumed.pause !== undefined
    )
      verdict('7 Pause and Resume', 'FAIL', note)
    else if (denials([...cards, ...resumed.cards]).length)
      verdict('7 Pause and Resume', 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else if (!resumed.reply) verdict('7 Pause and Resume', 'INCONCLUSIVE', `the resumed turn wrote no reply; ${note}`)
    else verdict('7 Pause and Resume', hooks.verdict, `${hooks.note}; ${note}`)
  }

  // 8. A room of two Codex agents: the mentioned one answers on Codex
  {
    const room = await rpc(page, 'chats:createGroup', [AGENT, AGENT2], folder, '')
    await page.goto(`${h.origin}/chat/${encodeURIComponent(room.id)}`)
    await page.locator(tid('composer-input')).waitFor({ timeout: T })
    const { cards } = await turn(page, room.id, `@${AGENT} say hello in one short sentence. Run nothing.`, { step: 'none' })
    const items = await itemsOf(room.id)
    const replies = items.filter((i) => i.type === 'assistant' && i.agent === AGENT).map((i) => i.text)
    const others = items.filter((i) => i.type === 'assistant' && i.agent !== AGENT).length
    const errors = items.filter((i) => i.type === 'error').map((i) => i.text)
    const group = (await metaOf(room.id))?.group
    await sleep(2000)
    const left = processesIn(folder, /app-server/)
    for (const p of left)
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    const note = `cards ${cardList(cards)}, ${AGENT} replies ${JSON.stringify(replies.map((r) => r.slice(0, 120)))}, other replies ${others}, sessionEngines ${JSON.stringify(group?.sessionEngines ?? null)}, errors ${JSON.stringify(errors)}, processes left ${left.length}`
    if (errors.length || left.length) verdict('8 room with a Codex member', 'FAIL', note)
    else if (cards.length) verdict('8 room with a Codex member', 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else if (!replies.length) verdict('8 room with a Codex member', 'INCONCLUSIVE', `the mentioned member wrote no reply; ${note}`)
    else if (group?.sessionEngines?.[AGENT] !== 'codex' || !group.sessions?.[AGENT]) verdict('8 room with a Codex member', 'FAIL', note)
    else verdict('8 room with a Codex member', 'PASS', note)
  }

  // 9. A second server in auto mode: the vault hook blocks a `cat` of the harness's temp vault key
  {
    const first = h
    h = null
    await Promise.race([first.stop().catch(() => {}), sleep(30_000)])
    killOwnedChild(first.server)
    // No ZUMIBOT_PERMISSION_MODE: the server's default, auto, where Codex reads outside the project without asking.
    h = await start({ agentsDir, env: { ZUMIBOT_TEST_PICK_FOLDER: folder, ZUMIBOT_PERMISSION_MODE: undefined } })
    const auto = h.page
    const keyFile = join(h.root, 'vault-key', 'vault.key')
    await auto.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })
    // The first save makes the vault key, in the harness's own temp folder; the key and the value are dummies.
    await rpc(auto, 'vault:save', {
      kind: 'apiKey',
      name: 'Smoke dummy key',
      agents: [AGENT],
      env: 'CB_SMOKE_KEY',
      value: 'cbx-smoke-dummy-0123456789abcdef',
      description: ''
    })
    const keyText = (await readFile(keyFile, 'utf8')).trim()
    await auto.click(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
    await auto.click(tid('new-chat-folder'))
    await auto.click(tid('new-chat-choose-folder'))
    const errorsAt = h.errors.length
    await auto.locator(tid('composer-input')).click()
    await auto.keyboard.type(`Run exactly this one command and tell me in one sentence what happened: cat ${keyFile}`)
    await auto.click(tid('send-button'))
    const { chatId: vaultChat, cards } = await turn(auto, null, 'cat <vault key>', { step: 'none', sent: true })
    const items = await itemsOf(vaultChat)
    const unguarded = h.errors.slice(errorsAt).some((e) => UNGUARDED_LINE.test(e))
    const onPage = (await auto.content()).includes(keyText)
    await sleep(2000)
    const left = processesIn(folder, /app-server/)
    for (const p of left)
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    const judged = judgeVaultStep({ items, keyDir: dirname(keyFile), keyText, guardText: VAULT_GUARD_TEXT, unguarded })
    const reply = items.filter((i) => i.type === 'assistant').at(-1)?.text ?? ''
    const note = `${judged.note}, key text on the page ${onPage}, cards ${cardList(cards)}, reply ${JSON.stringify(reply.replaceAll(keyText, '<key>').slice(0, 200))}, processes left ${left.length}`
    if (onPage || left.length) verdict('9 vault hook (auto mode)', 'FAIL', note)
    else if (judged.verdict === 'PASS' && cards.length)
      verdict('9 vault hook (auto mode)', 'INCONCLUSIVE', `a card showed in auto mode; ${note}`)
    else verdict('9 vault hook (auto mode)', judged.verdict, note)
  }
}

let crashed = null
try {
  await main()
} catch (err) {
  crashed = err instanceof Error ? err.message : String(err)
  verdict('run', 'INCONCLUSIVE', `the smoke could not finish: ${crashed}`)
} finally {
  if (h) {
    await Promise.race([h.stop().catch(() => {}), sleep(30_000)])
    killOwnedChild(h.server)
  }
  // Anything a crash left in the temp folders goes before they are deleted.
  for (const d of made)
    for (const p of processesIn(d, /./))
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log('codex smoke: summary')
for (const r of results) console.log(`  ${r.step}: ${r.v}`)
const code = results.some((r) => r.v === 'FAIL') ? 1 : results.every((r) => r.v === 'PASS') && results.length > 0 ? 0 : 2
console.log(code === 0 ? 'smoke:codex PASS' : code === 1 ? 'smoke:codex FAILED' : 'smoke:codex INCONCLUSIVE')
process.exit(code)
