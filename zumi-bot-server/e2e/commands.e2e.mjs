// End-to-end check of agent commands in the built server + web UI (local mode) against the FAKE claude: no real CLI turn
// is ever sent, so no login or quota is used. Usage: npm run e2e:commands   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// What the agent read is checked on the fake claude's stdin (FAKE_STDIN_OUT, written when a run ends).
//
// DOM hooks relied on (data-testid): new-agent, new-menu-group, new-chat-agent, new-chat-agent-option
//   (+ data-agent-name), new-chat-members, new-chat-member-option (+ data-agent-name), new-chat-folder,
//   new-chat-choose-folder, composer-input, send-button, command-menu, command-option (+ data-agent-name,
//   data-command-name), command-agent, command-chip, full-prompt-toggle, full-prompt, chat-agent, user-message, edit-button,
//   message-editor-input, mode-tab-routines, new-routine, routine-name, trigger-kind, target-kind-group, target-members,
//   target-member-option (+ data-agent-name), target-folder, routine-prompt-input, prompt-command-hint, routine-save,
//   routine-row, routine-run-now, run-row (+ data-status), run-open-chat, chat-model, chat-model-option (+ data-model), new-chat-mode, new-chat-effort, chat-mode,
//   chat-effort, chat-mode-option and chat-effort-option (+ data-value), mode-tab-agents, agent-row.
// The model, mode and effort a run got are checked on the fake claude's argv (FAKE_ARGS_OUT, written when a run starts).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, unexpectedErrors, pickOption } from './harness.mjs'

const PREFIX = 'zumibot-e2e-commands-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000
const LINK = 'https://x/1'
const PROMPT = `Use check on ${LINK}`
const LINK2 = 'https://x/2'

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

const agentFile = (name, description, commands) =>
  `---\nname: ${name}\ndescription: ${description}\nmodel: haiku\ncommands:\n${commands
    .map((c) => `  - name: ${c.name}\n    description: ${c.description}\n    prompt: ${c.prompt}\n`)
    .join('')}---\nYou are a test agent.\n`

// ---------- UI helpers ----------
const composer = (page) => page.locator(tid('composer-input'))
// The agents' rows only: the composer and the edit box also list the built-in /btw, which has no agent.
const agentRows = (page) => page.locator(`${tid('command-option')}[data-agent-name]`)
// A non-breaking space is what the editor may use for a trailing space.
const draftText = async (page) => (await composer(page).evaluate((el) => el.textContent)).replace(/ /g, ' ')
async function pickFolder(page, pickDir) {
  await page.click(tid('new-chat-folder'))
  await page.click(tid('new-chat-choose-folder'))
  await waitFor(async () => (await page.locator(tid('new-chat-folder')).getAttribute('data-tip')) === pickDir, T, 'the folder to be set')
}
// What the fake claude was sent as the user message, or null while its run has not ended.
async function stdinText(file) {
  const raw = await readFile(file, 'utf8').catch(() => '')
  const line = raw.split('\n').find((l) => l.trim() !== '')
  if (!line) return null
  const msg = JSON.parse(line)
  const c = msg.message.content
  return typeof c === 'string' ? c : c.map((p) => p.text ?? '').join('')
}
const waitStdin = async (file) => {
  let text = null
  await waitFor(async () => (text = await stdinText(file)) !== null, 30_000, 'the fake claude to receive the message')
  return text
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const pickDir = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const stdinFile = join(await mk('stdin'), 'stdin.txt')
  const argsFile = join(await mk('args'), 'args.json')
  await writeFile(
    join(agentsDir, 'wk.md'),
    agentFile('wk', 'Work agent.', [
      { name: 'check', description: 'Check a card', prompt: 'Use check on $ARGUMENTS' },
      { name: 'fix', description: 'Fix a bug', prompt: 'Fix $ARGUMENTS' }
    ])
  )
  await writeFile(
    join(agentsDir, 'rv.md'),
    agentFile('rv', 'Review agent.', [{ name: 'check', description: 'Review a pull request', prompt: 'Review $ARGUMENTS' }])
  )
  h = await start({
    fake: true,
    dataDir,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: pickDir, FAKE_STDIN_OUT: stdinFile, FAKE_ARGS_OUT: argsFile }
  })
  const page = h.page
  const input = composer(page)

  // 1. a single chat with wk: the menu lists its commands, with no agent header
  await page.locator(tid('new-chat-agent')).waitFor({ timeout: 30_000 }) // the no-chat-open screen is a new chat
  await page.click(tid('new-chat-agent'))
  await page.click(`${tid('new-chat-agent-option')}[data-agent-name="wk"]`)
  await pickFolder(page, pickDir)
  await input.click()
  await page.keyboard.type('/')
  await page.locator(tid('command-menu')).waitFor({ timeout: T })
  const rows = agentRows(page)
  await waitFor(async () => (await rows.count()) === 2, T, 'two command rows')
  const names = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-command-name')))
  assert(names.join(',') === 'check,fix', `the rows are ${names.join(',')}, not check,fix`)
  const texts = await rows.allTextContents()
  assert(texts[0].includes('Check a card') && texts[1].includes('Fix a bug'), `the rows lack their descriptions: ${JSON.stringify(texts)}`)
  assert((await page.locator(tid('command-agent')).count()) === 0, 'a single chat shows an agent header in the command menu')
  ok('1 "/" lists the single agent commands with descriptions and no agent header')

  // 2. pick with Enter, add the argument, send: the agent reads the filled prompt
  await page.keyboard.type('ch')
  await waitFor(async () => (await rows.count()) === 1, T, 'the menu to narrow to check')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await draftText(page)) === '/check ', T, 'the composer to hold "/check "')
  await page.keyboard.type(LINK)
  await page.click(tid('send-button'))
  await page.locator(tid('chat-agent')).waitFor({ timeout: T })
  const sent = await waitStdin(stdinFile)
  assert(sent === PROMPT, `the agent read ${JSON.stringify(sent)}, not ${JSON.stringify(PROMPT)}`)
  assert(!sent.includes('/check'), 'the agent read the short form')
  ok('2 Enter picks /check, and the agent reads the filled prompt, not /check')

  // 3. the bubble: chip, collapsed full prompt, toggle and chip both flip it
  const bubble = page.locator('.bubble.user').last()
  await bubble.locator(tid('command-chip')).waitFor({ timeout: T })
  const chipText = (await bubble.locator(tid('command-chip')).textContent()).trim()
  assert(chipText === '/check', `the chip reads ${JSON.stringify(chipText)}`)
  assert((await page.locator(tid('full-prompt')).count()) === 0, 'the full prompt is open before any click')
  await page.click(tid('full-prompt-toggle'))
  await page.locator(tid('full-prompt')).waitFor({ timeout: T })
  const full = (await page.locator(tid('full-prompt')).textContent()).trim()
  assert(full === PROMPT, `the full prompt reads ${JSON.stringify(full)}`)
  await bubble.locator(tid('command-chip')).click()
  await waitFor(async () => (await page.locator(tid('full-prompt')).count()) === 0, T, 'the chip to close the full prompt')
  ok('3 the bubble shows the chip; the toggle opens the full prompt and the chip closes it')

  // 4. an unknown command goes through as typed, with no chip
  await waitFor(
    async () =>
      (await page.locator('.bubble.assistant').count()) > 0 && (await page.locator(tid('send-button')).textContent()).trim() === 'Send',
    30_000,
    'the first reply to end'
  )
  await rm(stdinFile, { force: true })
  await input.click()
  await page.keyboard.type('/nope hi')
  await page.click(tid('send-button'))
  await page.locator('.bubble.user', { hasText: '/nope hi' }).waitFor({ timeout: T })
  const plain = await waitStdin(stdinFile)
  assert(plain === '/nope hi', `the agent read ${JSON.stringify(plain)}, not "/nope hi"`)
  assert(
    (await page.locator('.bubble.user', { hasText: '/nope hi' }).locator(tid('command-chip')).count()) === 0,
    'an unknown command got a chip'
  )
  assert((await page.locator(tid('command-chip')).count()) === 1, 'the number of chips changed')
  ok('4 /nope hi reaches the agent as typed, with no chip')

  // 5. a new group (wk, rv): the menu groups the commands by member, in member order
  await page.click(tid('new-agent'))
  await page.click(tid('new-menu-group'))
  await page.locator(tid('new-chat-members')).waitFor({ timeout: T })
  await page.click(tid('new-chat-members'))
  const member = (n) => page.locator(`${tid('new-chat-member-option')}[data-agent-name="${n}"]`)
  await member('wk').click()
  await member('rv').click()
  await page.keyboard.press('Escape')
  await page.locator(tid('new-chat-members')).locator('.picker-text').filter({ hasText: '2 agents' }).waitFor({ timeout: T })
  await composer(page).click()
  await page.keyboard.type('/')
  await page.locator(tid('command-menu')).waitFor({ timeout: T })
  await waitFor(async () => (await agentRows(page).count()) === 3, T, 'three command rows in the group menu')
  const heads = (await page.locator(tid('command-agent')).allTextContents()).map((s) => s.trim().toLowerCase())
  assert(
    heads.length === 2 && heads[0].includes('wk') && heads[1].includes('rv'),
    `the agent headers are ${JSON.stringify(heads)}, not wk then rv`
  )
  const pairs = await agentRows(page).evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-agent-name')}/${e.getAttribute('data-command-name')}`)
  )
  assert(pairs.join(',') === 'wk/check,wk/fix,rv/check', `the group rows are ${pairs.join(',')}`)
  ok('5 a group "/" shows one header per member in order, with check under both')

  // 6. in that room, a plain message is edited into a command through the editor's own "/" menu: the pick reaches the server
  await page.keyboard.press('Escape') // the menu first
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await pickFolder(page, pickDir)
  await composer(page).click()
  await page.keyboard.type('@wk hello')
  await page.click(tid('send-button'))
  const sendIdle = async () =>
    waitFor(
      async () =>
        (await page.locator('.bubble.assistant').count()) > 0 && (await page.locator(tid('send-button')).textContent()).trim() === 'Send',
      30_000,
      'the room reply to end'
    )
  await sendIdle()
  await page.locator(tid('user-message')).last().locator(tid('edit-button')).click()
  const box = page.locator(tid('message-editor-input'))
  await box.waitFor({ timeout: T })
  assert((await page.locator(tid('command-menu')).count()) === 0, 'the editor opened with the menu already open')
  await box.press('Control+A')
  await box.press('Backspace')
  await page.keyboard.type('/')
  await page.locator(tid('command-menu')).waitFor({ timeout: T })
  await waitFor(async () => (await agentRows(page).count()) === 3, T, 'three command rows in the editor menu')
  const editPairs = await agentRows(page).evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-agent-name')}/${e.getAttribute('data-command-name')}`)
  )
  assert(editPairs.join(',') === 'wk/check,wk/fix,rv/check', `the editor rows are ${editPairs.join(',')}`)
  assert((await page.locator(tid('command-agent')).count()) === 2, 'the editor menu in a room lacks its agent headers')
  await page.keyboard.type('ch')
  await waitFor(async () => (await page.locator(tid('command-option')).count()) === 2, T, 'the editor menu to narrow to check')
  await page.keyboard.press('Escape')
  assert((await page.locator(tid('command-menu')).count()) === 0, 'Esc left the menu open')
  assert((await box.count()) === 1, 'Esc with the menu open cancelled the edit')
  await box.press('Control+A')
  await box.press('Backspace')
  await page.keyboard.type('/ch')
  await waitFor(async () => (await page.locator(tid('command-option')).count()) === 2, T, 'the editor menu to reopen')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter') // picks rv/check; it must not send
  await waitFor(async () => (await box.evaluate((el) => el.editor.getText())) === '/check ', T, 'the editor to hold "/check "')
  assert((await page.locator(tid('command-menu')).count()) === 0, 'the menu stayed open after a pick')
  await page.keyboard.type(LINK)
  await page.keyboard.press('Enter')
  const edited = page.locator(tid('user-message')).last()
  await edited.locator(tid('command-chip')).waitFor({ timeout: T })
  await edited.locator(tid('full-prompt-toggle')).click()
  const roomPrompt = (await edited.locator(tid('full-prompt')).textContent()).trim()
  assert(roomPrompt === `Review ${LINK}`, `the edit read ${JSON.stringify(roomPrompt)}, not rv's prompt`)
  await sendIdle()
  ok('6 the editor "/" menu picks rv/check in a room: Esc closes the menu first, Enter picks, the edit runs rv\'s prompt')

  // 7. with no menu open, Esc still cancels the edit
  await edited.locator(tid('edit-button')).click()
  await box.waitFor({ timeout: T })
  await page.keyboard.press('Escape')
  await waitFor(async () => (await box.count()) === 0, T, 'Esc to cancel the edit')
  ok('7 Esc with no menu open cancels the edit')

  // 8. a routine for a new room (wk, rv): its prompt's "/" menu lists both members' commands, the pick is saved with it,
  //    and Run now sends rv's command, as the composer would
  await page.click(tid('mode-tab-routines'))
  await page.click(tid('new-routine'))
  await page.locator(tid('routine-name')).waitFor({ timeout: T })
  await page.fill(tid('routine-name'), 'Review routine')
  await pickOption(page.locator(tid('trigger-kind')), 'manual')
  await page.click(tid('target-kind-group'))
  await page.click(tid('target-members'))
  const rtMember = (n) => page.locator(`${tid('target-member-option')}[data-agent-name="${n}"]`)
  await rtMember('wk').click()
  await rtMember('rv').click()
  await page.click(tid('routine-name')) // a mousedown outside closes the members menu
  await page.click(tid('target-folder'))
  await waitFor(async () => (await page.locator(tid('target-folder')).getAttribute('data-tip')) === pickDir, T, 'the routine folder to be set')
  await page.locator(tid('prompt-command-hint')).waitFor({ timeout: T })
  const rtInput = page.locator(tid('routine-prompt-input'))
  await rtInput.click()
  await page.keyboard.type('/')
  await page.locator(tid('command-menu')).waitFor({ timeout: T })
  await waitFor(async () => (await page.locator(tid('command-option')).count()) === 3, T, 'three command rows in the routine menu')
  const rtPairs = await page
    .locator(tid('command-option'))
    .evaluateAll((els) => els.map((e) => `${e.getAttribute('data-agent-name')}/${e.getAttribute('data-command-name')}`))
  assert(rtPairs.join(',') === 'wk/check,wk/fix,rv/check', `the routine rows are ${rtPairs.join(',')}`)
  assert((await page.locator(tid('command-agent')).count()) === 2, 'the routine menu for a room lacks its agent headers')
  assert(
    !rtPairs.some((p) => p.endsWith('/btw')) && (await page.locator(`${tid('command-option')}[data-command-name="btw"]`).count()) === 0,
    'the routine menu offers /btw'
  )
  await page.keyboard.type('ch')
  await waitFor(async () => (await page.locator(tid('command-option')).count()) === 2, T, 'the routine menu to narrow to check')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter') // picks rv/check
  const rtText = async () => (await rtInput.evaluate((el) => el.textContent)).replace(/\u00a0/g, ' ')
  await waitFor(async () => (await rtText()) === '/check ', T, 'the routine prompt to hold "/check "')
  assert((await page.locator(tid('command-menu')).count()) === 0, 'the routine menu stayed open after a pick')
  await page.keyboard.type(LINK2)
  await page.click(tid('routine-save'))
  await page.locator(tid('routine-row')).first().waitFor({ timeout: T })
  await waitFor(async () => await page.locator(tid('routine-run-now')).isEnabled(), T, 'the routine save to land')
  const saved = JSON.parse(await readFile(join(dataDir, 'routines.json'), 'utf8')).find((r) => r.name === 'Review routine')
  assert(saved?.prompt === `/check ${LINK2}`, `the routine saved the prompt ${JSON.stringify(saved?.prompt)}`)
  assert(saved.command?.agent === 'rv' && saved.command?.name === 'check', `the routine saved the pick ${JSON.stringify(saved.command)}`)
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () =>
      (await page.locator(tid('run-row')).count()) > 0 &&
      (await page.locator(tid('run-row')).first().getAttribute('data-status')) === 'done',
    30_000,
    'the routine run to be done'
  )
  const openRun = page.locator(tid('run-row')).first().locator(tid('run-open-chat'))
  await waitFor(async () => await openRun.isEnabled(), T, 'the run chat to be openable')
  await openRun.click()
  const runMessage = page.locator(tid('user-message')).last()
  await runMessage.locator(tid('command-chip')).waitFor({ timeout: T })
  await runMessage.locator(tid('full-prompt-toggle')).click()
  const runPrompt = (await runMessage.locator(tid('full-prompt')).textContent()).trim()
  assert(runPrompt === `Review ${LINK2}`, `the routine run read ${JSON.stringify(runPrompt)}, not rv's prompt`)
  ok('8 a room routine\'s "/" menu picks rv/check, the pick is saved, and Run now sends rv\'s filled prompt')

  // 9. the model picker: Default (Opus) at first, /card (sonnet) previews and starts the chat on Sonnet, a plain message
  // stays on it, Default puts it back on the agent's model, and a model picked by hand wins over every command's
  await writeFile(
    join(agentsDir, 'cm.md'),
    '---\nname: cm\ndescription: Card agent.\nmodel: opus\ncommands:\n' +
      '  - name: card\n    description: Create a card\n    model: sonnet\n    prompt: |\n      Card $ARGUMENTS\n---\nYou are a test agent.\n'
  )
  await page.click(tid('mode-tab-agents'))
  const modelArg = async () => {
    const args = JSON.parse(await readFile(argsFile, 'utf8'))
    return args.includes('--model') ? args[args.indexOf('--model') + 1] : null
  }
  const idle = () =>
    waitFor(async () => (await page.locator(tid('send-button')).textContent()).trim() === 'Send', 30_000, 'the reply to end')
  const picker = page.locator(tid('chat-model'))
  const pickerText = async () => (await picker.textContent()).trim()
  const typeMessage = async (text) => {
    await input.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Escape') // a "/" menu may still be open
  }
  const sendTypedAndArgs = async () => {
    await rm(argsFile, { force: true })
    await page.click(tid('send-button'))
    await waitFor(async () => (await readFile(argsFile, 'utf8').catch(() => '')) !== '', 30_000, 'the fake claude to start')
    await idle()
    return modelArg()
  }
  const sendAndArgs = async (text) => {
    await typeMessage(text)
    return sendTypedAndArgs()
  }
  const pickModel = async (model) => {
    await picker.click()
    await page.click(`${tid('chat-model-option')}[data-model="${model}"]`)
  }
  // The agents folder is watched: cm shows up by itself, and its row opens its start screen.
  await page.click(`${tid('agent-row')}[data-agent-name="cm"]`)
  await pickFolder(page, pickDir)
  // The agent's start screen has the new-chat picker; the chat's own shows once the first message made the chat.
  const startPicker = page.locator(tid('new-chat-model'))
  await startPicker.waitFor({ timeout: T })
  const startText = async () => (await startPicker.textContent()).trim()
  assert(
    (await startText()) === 'Default (Opus)',
    `the start screen's picker reads ${JSON.stringify(await startText())}, not Default (Opus)`
  )
  await typeMessage('/card login bug')
  await waitFor(async () => (await startText()) === 'Sonnet · /card', T, 'the start picker to preview Sonnet for /card')
  assert((await sendTypedAndArgs()) === 'sonnet', 'the /card run did not get --model sonnet')
  await picker.waitFor({ timeout: T })
  await waitFor(async () => (await pickerText()) === 'Sonnet', T, 'the picker to read Sonnet after the /card turn')
  assert((await sendAndArgs('add the due date')) === 'sonnet', 'a plain message in the Sonnet chat left Sonnet')
  await pickModel('')
  await waitFor(async () => (await pickerText()) === 'Default (Opus)', T, 'the picker to read Default (Opus) after picking Default')
  assert((await sendAndArgs('now the hard part')) === null, "after Default the run still got a --model, not the agent's own")
  await pickModel('haiku')
  await waitFor(async () => (await pickerText()) === 'Haiku', T, 'the picker to read Haiku after picking it')
  assert((await sendAndArgs('quick one')) === 'haiku', 'the run after picking Haiku did not get --model haiku')
  await typeMessage('/card hand picked')
  // A pick by hand wins: the command's Sonnet is not previewed, and the run stays on Haiku.
  assert((await pickerText()) === 'Haiku', `with Haiku picked by hand, /card previewed ${JSON.stringify(await pickerText())}`)
  assert((await sendTypedAndArgs()) === 'haiku', '/card moved a chat whose model was picked by hand')
  ok(
    '9 the picker reads Default (Opus), previews Sonnet for /card and runs it, Default puts the chat back, and Haiku picked by hand wins over /card'
  )

  // 10. a model picked on the start screen is the new chat's pick: its first message, a command's included, runs on it.
  await writeFile(
    join(agentsDir, 'cn.md'),
    '---\nname: cn\ndescription: Card agent.\nmodel: opus\ncommands:\n' +
      '  - name: card\n    description: Create a card\n    model: sonnet\n    prompt: |\n      Card $ARGUMENTS\n---\nYou are a test agent.\n'
  )
  await page.click(`${tid('agent-row')}[data-agent-name="cn"]`)
  await pickFolder(page, pickDir)
  await startPicker.waitFor({ timeout: T })
  await startPicker.click()
  await page.click(`${tid('chat-model-option')}[data-model="haiku"]`)
  await waitFor(async () => (await startText()) === 'Haiku', T, 'the start picker to read Haiku')
  assert((await sendAndArgs('/card from the start')) === 'haiku', "the start screen's Haiku pick did not reach the first run")
  await waitFor(async () => (await pickerText()) === 'Haiku', T, "the new chat's picker to read Haiku")
  ok("10 Haiku picked on the start screen runs the new chat's first message, /card included, and the chat keeps it")

  // 11. a mode and an effort picked on the start screen start the new chat's first run; Auto and Medium put the chat back.
  await writeFile(join(agentsDir, 'cp.md'), '---\nname: cp\ndescription: Plan agent.\nmodel: opus\n---\nYou are a test agent.\n')
  await page.click(`${tid('agent-row')}[data-agent-name="cp"]`)
  await pickFolder(page, pickDir)
  const label = async (id) => (await page.locator(tid(id)).textContent()).trim()
  const choose = async (picker, option, value) => {
    await page.click(tid(picker))
    await page.click(`${tid(option)}[data-value="${value}"]`)
  }
  const runArgs = async () => {
    const args = JSON.parse(await readFile(argsFile, 'utf8'))
    return {
      mode: args[args.indexOf('--permission-mode') + 1],
      effort: args.includes('--effort') ? args[args.indexOf('--effort') + 1] : null
    }
  }
  await page.locator(tid('new-chat-mode')).waitFor({ timeout: T })
  assert(
    (await label('new-chat-mode')) === 'Auto',
    `the start screen's mode picker reads ${JSON.stringify(await label('new-chat-mode'))}, not Auto`
  )
  assert(
    (await label('new-chat-effort')) === 'Medium effort',
    `the start screen's effort picker reads ${JSON.stringify(await label('new-chat-effort'))}`
  )
  await choose('new-chat-mode', 'chat-mode-option', 'plan')
  await choose('new-chat-effort', 'chat-effort-option', 'max')
  await waitFor(
    async () => (await label('new-chat-mode')) === 'Plan mode' && (await label('new-chat-effort')) === 'Max effort',
    T,
    'the start pickers to read Plan mode and Max effort'
  )
  await sendAndArgs('plan it first')
  const first = await runArgs()
  assert(first.mode === 'plan' && first.effort === 'max', `the first run got ${JSON.stringify(first)}, not plan and max`)
  await waitFor(
    async () => (await label('chat-mode')) === 'Plan mode' && (await label('chat-effort')) === 'Max effort',
    T,
    "the new chat's pickers to read Plan mode and Max effort"
  )
  await choose('chat-mode', 'chat-mode-option', '')
  await choose('chat-effort', 'chat-effort-option', 'medium')
  await waitFor(
    async () => (await label('chat-mode')) === 'Auto' && (await label('chat-effort')) === 'Medium effort',
    T,
    'the pickers to read Auto and Medium effort'
  )
  await sendAndArgs('now build it')
  const next = await runArgs()
  // The harness runs the server in manual mode, which a chat on Auto (no mode of its own) gets; Medium is the default effort.
  assert(next.mode === 'manual' && next.effort === 'medium', `after Auto and Medium the run got ${JSON.stringify(next)}`)
  ok(
    "11 Plan mode and Max effort picked on the start screen start the new chat's first run; Auto and Medium put the chat back on the server's mode and --effort medium"
  )

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected errors: ${bad.join(' | ')}`)
  ok('no console or server errors')
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
console.log(failed ? 'e2e:commands FAILED' : 'e2e:commands passed')
process.exit(failed ? 1 : 0)
