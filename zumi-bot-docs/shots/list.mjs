// The screenshots the docs show. `run.mjs` makes each one, in light and dark, and `<Shot name="..." />` shows it.
// This file must not import the harness at top level: a vitest test reads it and has to stay fast.
import { existsSync } from 'node:fs'

// The Chrome the browser panel shot points ZumiBot at. `ZUMIBOT_DOCS_CHROME` names it, else the usual Linux path. Read when the shot starts,
// so listing the shots needs no Chrome.
const chromeForPanel = () => {
  const path = process.env.ZUMIBOT_DOCS_CHROME || '/usr/bin/google-chrome'
  if (!existsSync(path)) {
    throw new Error(`Chrome was not found at ${path}. Install Google Chrome there, or set ZUMIBOT_DOCS_CHROME to the path of a Chrome or Chromium program.`)
  }
  return path
}

/**
 * @typedef {object} Shot
 * @property {string} name Kebab-case, prefixed with its page's group (`chatting-composer`). It is the file name
 *   (`src/assets/shots/<name>-light.png` and `-dark.png`) and what a page passes to `<Shot name="..." />`.
 * @property {string} [seed] A folder under `shots/seed/` copied into the server's data dir before it starts (made-up chats,
 *   settings). Its `settings.json` keeps its keys; the runner only sets `theme`.
 * @property {{ width: number, height: number }} [viewport] Defaults to 1280x800.
 * @property {string | ((h: any) => Promise<{ x: number, y: number, width: number, height: number }>)} [clip] A CSS selector (the picture is that element only) or a
 *   function that returns a rectangle in window pixels (the picture is that part of the window). Either way it is only a crop of the screen.
 * @property {object | ((dirs: { tmp: string, dataDir: string, agentsDir: string }) => object | Promise<object>)} [start] Options merged into the harness
 *   `start()` call (default: Local mode, fake claude). A server screen such as the first-run wizard sets `{ mode: 'vps', setup: false }`;
 *   it does not follow the app theme, so `go` gets the theme too. A function gets the shot's folders, for an option that names a path
 *   inside them (the extensions shots' state file for the fake CLI). It may be async and return `cleanup`, a function the runner calls
 *   when the shot ends (it stops a fake service the function started, such as the fake Telegram).
 * @property {(h: Awaited<ReturnType<typeof import('../../zumi-bot-server/e2e/harness.mjs').start>>, theme: 'light' | 'dark') => Promise<void>} go
 *   Gets the app to the screen to capture, through the harness (`h.page` is a Playwright page; its second argument is the theme, `'light'` or `'dark'`). The runner waits 1.5 s after it.
 */

// The first-run wizard has no theme setting: it follows the browser's color scheme, so a shot of it sets that.
const wizard = async (h, theme, upTo) => {
  await h.page.emulateMedia({ colorScheme: theme })
  await h.page.goto(`${h.origin}/setup`)
  await h.page.locator('#code').waitFor()
  if (upTo === 'code') return
  await h.page.locator('#code').fill(h.setupCode)
  await h.page.locator('#submit-code').click()
  await h.page.locator('#password').waitFor()
  await h.page.locator('#password').fill('a-long-demo-passphrase-2026')
  await h.page.locator('#password2').fill('a-long-demo-passphrase-2026')
  await h.page.locator('#submit-password').click()
  await h.page.locator('#qr').waitFor()
}

// The new-chat screen with an agent and a folder picked and a message typed. The folder is made inside the harness's home,
// so the picker finds it; only its name shows in the app.
const FIRST_MESSAGE = 'Run the tests and tell me what fails'
const pickAgentAndFolder = async (h, message = FIRST_MESSAGE, agent = 'code-reviewer') => {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(`${h.root}/home/my-project`, { recursive: true })
  const page = h.page
  await page.locator('[data-testid="new-chat-agent"]').click()
  await page.locator(`[data-testid="new-chat-agent-option"][data-agent-name="${agent}"]`).click()
  await page.locator('[data-testid="new-chat-folder"]').click()
  await page.locator('[data-testid="new-chat-choose-folder"]').click()
  await page.locator('[data-testid="folder-picker"]').waitFor()
  // A second chat in a row opens the picker inside the folder used last (my-project itself), where it has no such item.
  const item = page.locator('[data-testid="folder-picker-item"]', { hasText: 'my-project' })
  if (await item.waitFor({ timeout: 3000 }).then(() => true, () => false)) await item.click()
  await page.getByRole('button', { name: 'Use this folder' }).click()
  await page.locator('[data-testid="folder-picker"]').waitFor({ state: 'detached' })
  await page.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill(message)
}

// The fake claude plays the script file the harness points at; a shot copies its own over it before a message is sent.
const useScript = async (h, name) => {
  const { copyFile } = await import('node:fs/promises')
  await copyFile(new URL(`./scripts/${name}`, import.meta.url), h.script)
}

const composerBox = (h) => h.page.locator('[data-testid="composer-input"]')

// A chat in the demo folder whose first reply has finished (the default script is `chatting-reply.jsonl`).
const chatWithReply = async (h, message = FIRST_MESSAGE, script = 'chatting-reply.jsonl') => {
  await useScript(h, script)
  await pickAgentAndFolder(h, message)
  await h.page.keyboard.press('Enter')
  await h.page.locator('[data-testid="agent-message"]').first().waitFor({ timeout: 15000 })
  await h.page.locator('[data-testid="send-button"] .sr-only', { hasText: 'Send' }).waitFor({ timeout: 15000 })
}

// Types into the open chat's message box (a click first, so the box has focus).
const typeInChat = async (h, text) => {
  await composerBox(h).click()
  await h.page.keyboard.type(text)
}

// A small picture to attach, drawn in memory: bands of color, so the thumbnail reads as a picture and not a blank square.
const demoPng = async () => {
  const { deflateSync } = await import('node:zlib')
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const w = 160
  const hgt = 100
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(hgt, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = []
  for (let y = 0; y < hgt; y++) {
    const row = [0]
    for (let x = 0; x < w; x++) {
      const bar = y > 70 ? [70, 90, 140] : x < 12 ? [120, 130, 160] : y < 16 ? [60, 110, 200] : (Math.floor(y / 14) + Math.floor(x / 40)) % 2 ? [225, 232, 245] : [205, 216, 238]
      row.push(...bar)
    }
    rows.push(Buffer.from(row))
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// A scripted reply built on the spot, for shots that need a different story than the files in `scripts/`: the fake claude plays it
// line by line. `steps` run in order: { thinking, ms } (a thought that takes ms), { tool: { name, input, result, detail? } } (`detail` is the CLI's tool_use_result, which the Files panel reads), { text },
// { sleep } (a pause, so a reply can still be running when the shot is taken). `used` is how full the context reads afterwards,
// out of `window` tokens. `uuid` stamps each reply line, so Edit and Resend can rewind this session (without it they start a fresh one).
// `limitAt` (epoch ms) makes the run end on the usage limit, resetting then.
const SESSION = '3f0a6d52-6b1e-4d77-9a34-0c1d2e3f4a5b'
const replyScript = ({ steps = [], session = SESSION, used = 17122, window = 200000, uuid = false, limitAt = null }) => {
  const usage = { input_tokens: 2, output_tokens: 120, cache_read_input_tokens: used - 3122, cache_creation_input_tokens: 3000 }
  const ev = (event) => JSON.stringify({ type: 'stream_event', event, session_id: session, parent_tool_use_id: null })
  const stamp = () => (uuid ? { uuid: globalThis.crypto.randomUUID() } : {})
  const assistant = (id, content) =>
    JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-haiku-5-5', id, type: 'message', role: 'assistant', content, stop_reason: null, usage },
      parent_tool_use_id: null,
      session_id: session,
      ...stamp()
    })
  const out = [JSON.stringify({ type: 'system', subtype: 'init', session_id: session, cwd: '/tmp/demo', model: 'claude-haiku-5-5', permissionMode: 'default' })]
  if (limitAt !== null) {
    out.push(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: Math.floor(limitAt / 1000), rateLimitType: 'five_hour' },
        uuid: 'demo-limit',
        session_id: session
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'demo-limit-msg', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit" }] },
        error: 'rate_limit',
        session_id: session
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, stop_reason: 'stop_sequence', session_id: session, result: "You've hit your session limit", total_cost_usd: 0, usage, num_turns: 1, duration_ms: 300 })
    )
    return out.join('\n') + '\n'
  }
  let last = ''
  steps.forEach((step, i) => {
    const id = `msg_demo_${i + 1}`
    const start = () => ev({ type: 'message_start', message: { model: 'claude-haiku-5-5', id, type: 'message', role: 'assistant', content: [], stop_reason: null, usage } })
    if ('sleep' in step) out.push(`#SLEEP ${step.sleep}`)
    else if ('thinking' in step) {
      out.push(start())
      out.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }))
      step.thinking.split('\n\n').forEach((part, n) => out.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: (n ? '\n\n' : '') + part } })))
      if (step.ms) out.push(`#SLEEP ${step.ms}`)
      out.push(assistant(id, [{ type: 'thinking', thinking: step.thinking, signature: 'demo' }]))
      out.push(ev({ type: 'content_block_stop', index: 0 }))
    } else if ('tool' in step) {
      const toolId = `toolu_demo_${i + 1}`
      out.push(assistant(id, [{ type: 'tool_use', id: toolId, name: step.tool.name, input: step.tool.input }]))
      out.push(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: step.tool.result }] },
          parent_tool_use_id: null,
          session_id: session,
          // `detail` is the CLI's own tool_use_result: the Files panel reads an Edit's old file from it.
          ...(step.tool.detail ? { tool_use_result: step.tool.detail } : {}),
          ...stamp()
        })
      )
    } else {
      last = step.text
      out.push(start())
      out.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      out.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } }))
      out.push(assistant(id, [{ type: 'text', text: step.text }]))
      out.push(ev({ type: 'content_block_stop', index: 0 }))
    }
  })
  out.push(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      session_id: session,
      total_cost_usd: 0.0213,
      usage,
      modelUsage: {
        'claude-haiku-5-5': { inputTokens: 2, outputTokens: 120, cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: 3000, costUSD: 0.0213, contextWindow: window, maxOutputTokens: 64000 }
      },
      num_turns: 1,
      result: last,
      duration_ms: 2400
    })
  )
  return out.join('\n') + '\n'
}

// Plays a script built by `replyScript` for the next run.
const writeScript = async (h, text) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(h.script, text)
}

// Waits until the open chat's reply has ended: its text is there and the send button reads Send again.
const replyDone = async (h) => {
  await h.page.locator('[data-testid="agent-message"]').first().waitFor({ timeout: 15000 })
  await h.page.locator('[data-testid="send-button"] .sr-only', { hasText: 'Send' }).waitFor({ timeout: 15000 })
}

// Three finished chats with the demo agent, for the shots of the chat list. With `unread`, the last reply comes in after you have
// already left that chat, so it is unread.
const demoChats = async (h, { unread = false } = {}) => {
  const chats = [
    ['Why does the checkout test fail?', 'The checkout test fails because the cart is empty when it runs. Seed the cart first and the checkout test passes.'],
    ['Add a discount code to checkout', 'I added a discount field to the checkout form and a check that the code is still valid.'],
    ['Write release notes for 0.4', 'Release notes for 0.4: faster search, a new export option and fixes for the sidebar.']
  ]
  for (const [i, [message, text]] of chats.entries()) {
    const last = i === chats.length - 1
    const slow = unread && last
    await writeScript(h, replyScript({ steps: [...(slow ? [{ sleep: 5000 }] : []), { text }] }))
    if (i > 0) await h.page.locator('[data-testid="rail-home"]').click()
    await pickAgentAndFolder(h, message)
    await h.page.keyboard.press('Enter')
    if (slow) {
      // Leave while the reply is still on its way.
      await h.page.locator('[data-testid="pause-button"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="rail-home"]').click()
    } else await replyDone(h)
  }
}

// An agent's editor, opened the way a reader opens it: the row's options button, then Edit agent. `name` is the file name.
const openAgentStudio = async (h, name) => {
  const row = h.page.locator(`[data-testid="agent-row"][data-agent-name="${name}"]`)
  await row.waitFor()
  await row.hover()
  await h.page.getByRole('button', { name: new RegExp(`^${name.replace('-', '.')} options$`, 'i') }).click()
  await h.page.locator('[data-testid="agent-menu-edit"]').click()
  await h.page.locator('#agent-name').waitFor()
  // Away from the sidebar, so no row stays lit under the pointer.
  await h.page.mouse.move(900, 20)
}

// Scrolls a card of the open editor to the top of its pane.
const scrollStudioTo = (h, selector) => h.page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'start' }))

// A memory file as Claude Code writes it: the name is the title, the type sits under metadata.
const memoryFile = (name, description, type, body) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n${body}\n`

// The folder of an agent's own memory. The harness gives the server a throwaway home, so nothing real is touched.
const memoryFolder = (h, agent) => `${h.root}/home/.claude/agent-memory/${agent}`

// The loadout card, the Settings page and a process's log show a folder as a full path, and the harness's home is a random temp folder.
// Replace only that path's text (and its tooltip) with a fixed demo path so the picture does not carry the temp name; nothing else on the
// screen is changed. `selector` names the element that holds the path.
const tidyFolderPath = (h, selector = '.ext-folder') =>
  h.page.evaluate((sel) => {
    for (const el of document.querySelectorAll(sel)) {
      const text = [...el.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE)
      if (text) text.textContent = '~/projects/shop'
      el.setAttribute('title', '~/projects/shop')
    }
  }, selector)

// The fake CLI that answers the extensions probe (servers, skills, plugins, hooks) from a state file, and the state it answers with.
const EXTENSIONS_CLI = new URL('../../zumi-bot-server/backend/tests/fixtures/fake-extensions-claude.mjs', import.meta.url).pathname
const extensionsStart = ({ tmp }) => ({ fake: EXTENSIONS_CLI, env: { FAKE_EXT_STATE: `${tmp}/extensions-state.json`, CLAUDE_CONFIG_DIR: undefined } })
const writeExtensionsState = async (h) => {
  const { writeFile } = await import('node:fs/promises')
  const stdio = (name, tools) => ({
    name,
    status: 'connected',
    scope: 'user',
    transport: 'stdio',
    config: { type: 'stdio', command: 'node', args: [`${name}-server.js`] },
    tools: tools.map((t) => ({ name: t }))
  })
  const state = {
    version: '2.1.0',
    mcpServers: [
      stdio('notes', ['search_notes', 'read_note', 'create_note', 'append_note']),
      {
        name: 'issue-tracker',
        status: 'needs-auth',
        scope: 'user',
        transport: 'http',
        config: { type: 'http', url: 'https://tracker.example.com/mcp' },
        tools: []
      },
      stdio('docs-search', ['search_docs', 'open_page'])
    ],
    skills: [
      { name: 'release-notes', description: 'Drafts release notes from the commit log.', source: 'user', state: 'on', tokens: 120 },
      { name: 'meeting-summary', description: 'Turns rough notes into a short summary.', source: 'user', state: 'on', tokens: 85 },
      { name: 'team-tools:lint-fix', description: 'Fixes lint errors the way the team does.', source: 'plugin', state: 'on', tokens: 40 }
    ],
    hooks: [],
    plugins: [
      { id: 'team-tools@acme-plugins', enabled: true },
      { id: 'travel-helper@acme-plugins', enabled: false }
    ]
  }
  await writeFile(`${h.dataDir}/../extensions-state.json`, JSON.stringify(state, null, 2))
}

// A scripted reply that also writes a file the way a tool would: the fake claude plays the #WRITE_FILE line right after the tool call.
const withFileWrite = (script, path, content) => {
  const lines = script.split('\n')
  lines.splice(lines.findIndex((l) => l.includes('"tool_use"')) + 1, 0, `#WRITE_FILE ${JSON.stringify({ path, content })}`)
  return lines.join('\n')
}

// ---- Rooms. A room's members each play their own script (`FAKE_STDOUT_DIR`, one file per agent), and the moderator is a fake call that picks
// the members in `FAKE_ROOM_PICKS` when you speak (see fakeRoomClaude.mjs); the handoff summary is `FAKE_SUMMARY_TEXT`.
const ROOM_CLI = new URL('./fakeRoomClaude.mjs', import.meta.url).pathname
const ROOM_MESSAGE = 'Review the checkout change and write the release note for it'
const ROOM_SUMMARY = [
  '## Goal',
  'Ship the checkout fix and its release note.',
  '',
  '## Decisions',
  '- The discount code is applied once, on the server.',
  '',
  '## Current state',
  'Code Reviewer found the double discount and added a test. Docs Writer wrote the release note.',
  '',
  '## Who does what',
  '- Code Reviewer checks every change first.',
  '- Docs Writer writes the release note from the review.',
  '',
  '## Your preferences',
  'Short release notes, no jargon.',
  '',
  '## Open items',
  '- Check the fix on the staging server.'
].join('\n')
const roomStart =
  (extra = {}) =>
  ({ tmp }) => ({
    fake: ROOM_CLI,
    env: {
      FAKE_STDOUT_DIR: `${tmp}/room-scripts`,
      FAKE_ROOM_PICKS: JSON.stringify([{ agent: 'code-reviewer' }, { agent: 'docs-writer', after: ['code-reviewer'] }]),
      FAKE_SUMMARY_TEXT: ROOM_SUMMARY,
      ...extra
    }
  })

// One reply script per agent, in the folder the server's fake reads (`start` above names it).
const writeAgentScripts = async (h, scripts) => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const dir = `${h.dataDir}/../room-scripts`
  await mkdir(dir, { recursive: true })
  for (const [agent, text] of Object.entries(scripts)) await writeFile(`${dir}/${agent}.jsonl`, text)
}

const roomReplies = async (h) =>
  writeAgentScripts(h, {
    'code-reviewer': replyScript({
      session: '11111111-2222-4333-8444-555555555551',
      steps: [{ text: 'The checkout change looks good, with one bug: the discount code is applied twice when the cart reloads. I added a test that shows it.' }]
    }),
    'docs-writer': replyScript({
      session: '11111111-2222-4333-8444-555555555552',
      steps: [{ text: 'Release note: Fixed a bug where the discount code was applied twice after the cart reloaded. Checkout now charges the right total.' }]
    }),
    researcher: replyScript({ session: '11111111-2222-4333-8444-555555555553', steps: [{ text: 'Nothing to add.' }] })
  })

// The new group chat screen: three agents ticked, a folder picked and the first message typed (sent only with `send`). `role` fills the Role popup.
const newRoom = async (h, { message = ROOM_MESSAGE, role = null, send = true } = {}) => {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(`${h.root}/home/my-project`, { recursive: true })
  const page = h.page
  await page.locator('[data-testid="new-agent"]').click()
  await page.locator('[data-testid="new-menu-group"]').click()
  await page.locator('[data-testid="new-chat-members"]').click()
  for (const name of ['code-reviewer', 'docs-writer', 'researcher']) {
    await page.locator(`[data-testid="new-chat-member-option"][data-agent-name="${name}"]`).click()
  }
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="new-chat-folder"]').click()
  await page.locator('[data-testid="new-chat-choose-folder"]').click()
  await page.locator('[data-testid="folder-picker"]').waitFor()
  await page.locator('[data-testid="folder-picker-item"]', { hasText: 'my-project' }).click()
  await page.getByRole('button', { name: 'Use this folder' }).click()
  await page.locator('[data-testid="folder-picker"]').waitFor({ state: 'detached' })
  if (role !== null) {
    await page.locator('[data-testid="role-chip"]').click()
    await page.locator('[data-testid="role-input"]').fill(role)
    await page.locator('[data-testid="role-save"]').click()
  }
  await page.getByRole('textbox', { name: 'Message the group' }).fill(message)
  if (!send) return
  await page.keyboard.press('Enter')
}

// Waits until the room has stopped working and both picked members have answered.
const roomDone = async (h) => {
  await h.page.locator('[data-testid="agent-message"]').nth(1).waitFor({ timeout: 30000 })
  await h.page.locator('[data-testid="send-button"] .sr-only', { hasText: 'Send' }).waitFor({ timeout: 30000 })
}

const ROOM_ROLE = 'Code Reviewer checks every change first. Docs Writer then writes the release note from the review. Researcher only answers questions about other projects.'

// A finished room (the usual story), with its row in the sidebar.
const finishedRoom = async (h) => {
  await roomReplies(h)
  await newRoom(h, { role: ROOM_ROLE })
  await roomDone(h)
}

// The room's row menu (right-click), then Clone room…
const openCloneDialog = async (h) => {
  await h.page.locator('[data-testid="group-row"]').first().click({ button: 'right' })
  await h.page.locator('[data-testid="chat-menu-clone"]').click()
  await h.page.locator('[data-testid="clone-dialog"]').waitFor()
}

// A tool-less ask story: Code Reviewer asks Docs Writer for a release note, and Docs Writer needs one command approved first.
const ASK_MESSAGE = 'Ask the docs writer for a short release note about the checkout fix'
const ASK_TEXT = 'Write a two-line release note for the checkout fix: the discount code was applied twice after the cart reloaded.'
const askScripts = async (h) => {
  const { writeFile } = await import('node:fs/promises')
  const line = (o) => JSON.stringify(o)
  const dir = `${h.dataDir}/../room-scripts`
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const call = `#MCP_CALL ${line({ server: 'zumibot_agents', tool: 'ask', args: { agent: '@docs-writer', message: ASK_TEXT }, id: 'toolu_ask1', permission: 'req-toolu_ask1' })}`
  const mine = replyScript({ session: '22222222-3333-4444-8555-666666666661', steps: [{ text: 'I asked the Docs Writer. The release note is ready: it covers the double discount fix.' }] }).split('\n')
  mine.splice(1, 0, call)
  await writeFile(`${dir}/code-reviewer.jsonl`, mine.join('\n'))
  const theirs = replyScript({ session: '22222222-3333-4444-8555-666666666662', steps: [{ text: 'Release note: Fixed a bug where the discount code was applied twice after the cart reloaded.\nCheckout now charges the right total.' }] }).split('\n')
  const request = line({
    type: 'control_request',
    request_id: 'req-docs-bash1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'git log --oneline -5', description: 'Read the latest commits' },
      description: 'Read the latest commits',
      decision_reason: 'needs approval',
      tool_use_id: 'toolu_req-docs-bash1'
    }
  })
  theirs.splice(1, 0, request, '#WAIT_RESPONSE req-docs-bash1')
  await writeFile(`${dir}/docs-writer.jsonl`, theirs.join('\n'))
}

// A reply that sends two subagents out (the CLI's Agent tool) and finishes with both reports. Built with the lines a real run prints.
const dispatchScript = () => {
  const session = '33333333-4444-4555-8666-777777777771'
  const j = (o) => JSON.stringify({ session_id: session, ...o })
  const usage = { input_tokens: 5 }
  const asst = (parent, content, extra = {}) =>
    j({ type: 'assistant', parent_tool_use_id: parent, message: { model: 'claude-haiku-5-5', role: 'assistant', usage, content }, ...extra })
  const prompts = {
    toolu_A: 'Run the checkout tests and tell me which ones fail and why.',
    toolu_B: 'Find every place that calls applyDiscount and say whether it can run twice.'
  }
  const started = (id, task, description, type) =>
    j({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: id, description, subagent_type: type, prompt: prompts[id] })
  const sent = (id, task) => j({ type: 'user', parent_tool_use_id: id, agent_id: task, message: { role: 'user', content: [{ type: 'text', text: prompts[id] }] } })
  const done = (id, task, agentType, report, totals) => [
    j({
      type: 'user',
      parent_tool_use_id: null,
      tool_use_result: { status: 'completed', agentType, content: [{ type: 'text', text: report }], ...totals },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: report }] }] }
    }),
    j({ type: 'system', subtype: 'task_updated', task_id: task, patch: { status: 'completed', end_time: Date.now() } })
  ]
  const out = [
    j({ type: 'system', subtype: 'init', cwd: '/tmp/demo', tools: ['Agent', 'Bash', 'Grep'], model: 'claude-haiku-5-5' }),
    asst(null, [
      { type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: 'Run the checkout tests', subagent_type: 'general-purpose', prompt: prompts.toolu_A } },
      { type: 'tool_use', id: 'toolu_B', name: 'Agent', input: { description: 'Find callers of applyDiscount', subagent_type: 'Explore', prompt: prompts.toolu_B } }
    ]),
    started('toolu_A', 'ta', 'Run the checkout tests', 'general-purpose'),
    started('toolu_B', 'tb', 'Find callers of applyDiscount', 'Explore'),
    sent('toolu_A', 'ta'),
    sent('toolu_B', 'tb'),
    asst('toolu_A', [
      { type: 'text', text: 'Running the checkout tests.' },
      { type: 'tool_use', id: 'toolu_A1', name: 'Bash', input: { command: 'npm test -- checkout', description: 'Run the checkout tests' } }
    ]),
    asst('toolu_B', [{ type: 'tool_use', id: 'toolu_B1', name: 'Grep', input: { pattern: 'applyDiscount', path: 'src' } }]),
    j({ type: 'user', parent_tool_use_id: 'toolu_A', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A1', content: 'Tests: 1 failed, 41 passed' }] } }),
    j({ type: 'user', parent_tool_use_id: 'toolu_B', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B1', content: '3 matches in 2 files' }] } }),
    asst('toolu_A', [{ type: 'text', text: 'One test fails.' }]),
    ...done('toolu_A', 'ta', 'general-purpose', '**One test fails:** the discount test, because the code is applied twice when the cart reloads.\n\nThe other 41 pass.', {
      totalDurationMs: 18000,
      totalTokens: 12400,
      totalToolUseCount: 1
    }),
    ...done('toolu_B', 'tb', 'Explore', 'applyDiscount is called in 3 places. The cart reload calls it a second time, so it can run twice.', {
      totalDurationMs: 9000,
      totalTokens: 6800,
      totalToolUseCount: 1
    }),
    asst(null, [{ type: 'text', text: 'Both checks are done. One discount test fails, because the reload applies the code twice.' }]),
    j({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      total_cost_usd: 0.0213,
      usage: { input_tokens: 2, output_tokens: 120 },
      modelUsage: {},
      num_turns: 2,
      result: 'Both checks are done.',
      duration_ms: 2400
    })
  ]
  return out.join('\n') + '\n'
}

// ---- Projects & code. The demo project folder is `my-project` in the harness's home (pickAgentAndFolder makes it).
const projectDir = (h) => `${h.root}/home/my-project`

// A chat whose reply edited one file and wrote another, the way the CLI reports it (an Edit's old file comes with the result). The new
// texts are on disk too, because Restore only writes back when the file still holds what the change left.
const CHECKOUT_OLD = ['function total(cart) {', '  let sum = 0', '  for (const item of cart.items) {', '    sum += item.price * item.qty', '  }', '  return sum', '}', ''].join('\n')
const CHECKOUT_NEW = CHECKOUT_OLD.replace('  return sum\n', '  return sum - cart.discount\n')
const NOTES_NEW = '# Release notes\n\n- The discount code is applied once.\n'
const filesChat = async (h) => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(projectDir(h), { recursive: true })
  await writeFile(`${projectDir(h)}/checkout.js`, CHECKOUT_NEW)
  await writeFile(`${projectDir(h)}/release-notes.md`, NOTES_NEW)
  const patch = CHECKOUT_OLD.trimEnd()
    .split('\n')
    .flatMap((l) => (l === '  return sum' ? ['-  return sum', '+  return sum - cart.discount'] : [` ${l}`]))
  await writeScript(
    h,
    replyScript({
      steps: [
        {
          tool: {
            name: 'Edit',
            input: { replace_all: false, file_path: 'checkout.js', old_string: '  return sum\n', new_string: '  return sum - cart.discount\n' },
            result: 'The file checkout.js has been updated successfully.',
            detail: {
              filePath: 'checkout.js',
              oldString: '  return sum\n',
              newString: '  return sum - cart.discount\n',
              originalFile: CHECKOUT_OLD,
              structuredPatch: [{ oldStart: 1, oldLines: 7, newStart: 1, newLines: 7, lines: patch }],
              userModified: false,
              replaceAll: false
            }
          }
        },
        {
          tool: {
            name: 'Write',
            input: { file_path: 'release-notes.md', content: NOTES_NEW },
            result: 'File created successfully at: release-notes.md',
            detail: { type: 'create', filePath: 'release-notes.md', content: NOTES_NEW, structuredPatch: [], originalFile: null, userModified: false }
          }
        },
        { text: 'I took the discount off the checkout total and wrote a short release note for it.' }
      ]
    })
  )
  await pickAgentAndFolder(h, 'Take the discount off the checkout total and write the release note')
  await h.page.keyboard.press('Enter')
  await replyDone(h)
}

// A real repository in the demo folder, with one commit. The commit needs an identity, so it is passed on the command line.
const repoRun = async (cwd, ...args) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  return (await promisify(execFile)('git', ['-c', 'user.email=demo@example.test', '-c', 'user.name=Demo', ...args], { cwd })).stdout.trim()
}
const DISCOUNT = ['export function applyDiscount(total, code) {', "  if (code === 'SAVE10') return total * 0.9", '  return total', '}', ''].join('\n')
const makeRepo = async (h) => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const dir = projectDir(h)
  await mkdir(dir, { recursive: true })
  await writeFile(`${dir}/checkout.js`, CHECKOUT_OLD)
  await writeFile(`${dir}/README.md`, '# Shop\n\nA small demo shop.\n')
  await repoRun(dir, 'init', '-b', 'main')
  await repoRun(dir, 'add', '.')
  await repoRun(dir, 'commit', '-m', 'Start the shop')
  // A bare "origin" in the shot's own folder: a pull request's push goes there, never anywhere real.
  const remote = `${h.dataDir}/../remote.git`
  await mkdir(remote, { recursive: true })
  await repoRun(remote, 'init', '--bare', '-b', 'main')
  await repoRun(dir, 'remote', 'add', 'origin', remote)
  await repoRun(dir, 'push', '-u', 'origin', 'main')
}

// The fake gh (signed in) first on the server's PATH, so a worktree chat offers Open PR… instead of the note about the machine's own gh.
// Its answers come from a state file a shot can rewrite while the server runs.
const FAKE_GH = new URL('../../zumi-bot-server/backend/tests/fixtures/fake-gh.mjs', import.meta.url).pathname
const ghStart = ({ tmp }) => {
  const fs = process.getBuiltinModule('node:fs')
  fs.mkdirSync(`${tmp}/bin`, { recursive: true })
  fs.writeFileSync(`${tmp}/bin/gh`, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(`${tmp}/gh-state.json`, JSON.stringify({ auth: 'in' }))
  return { env: { PATH: `${tmp}/bin:${process.env.PATH}`, FAKE_GH_STATE: `${tmp}/gh-state.json` } }
}
const setGh = async (h, state) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(`${h.dataDir}/../gh-state.json`, JSON.stringify(state))
}

// The agent's work on a worktree, all committed (a pull request is refused while anything is uncommitted).
const commitWork = async (h, wt) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(`${wt}/discount.js`, DISCOUNT)
  await repoRun(wt, 'add', 'discount.js')
  await repoRun(wt, 'commit', '-m', 'Add the discount helper')
  await writeFile(`${wt}/checkout.js`, CHECKOUT_NEW)
  await repoRun(wt, 'commit', '-am', 'Take the discount off the checkout total')
}

// On the new-chat screen: opens the folder menu and ticks "Isolate in worktree". `keepOpen` leaves the menu showing for a picture.
const isolateInWorktree = async (h, { keepOpen = false } = {}) => {
  const box = h.page.locator('[data-testid="new-chat-worktree"]')
  await h.page.locator('[data-testid="new-chat-folder"]').click()
  await h.page.waitForFunction(() => document.querySelector('[data-testid="new-chat-worktree"]')?.disabled === false, null, { timeout: 15000 })
  await box.click()
  await h.page.waitForFunction(() => document.querySelector('[data-testid="new-chat-worktree"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 15000 })
  if (!keepOpen) await h.page.keyboard.press('Escape')
}

// A chat on its own worktree: the first reply done. Returns the worktree's folder (a sibling of the repo).
const worktreeChat = async (h, message = 'Add a discount helper for the checkout') => {
  const { readdir } = await import('node:fs/promises')
  await makeRepo(h)
  await writeScript(h, replyScript({ steps: [{ text: 'I added the discount helper on a branch of its own and committed it.' }] }))
  await pickAgentAndFolder(h, message)
  await isolateInWorktree(h)
  await h.page.getByRole('textbox', { name: 'Describe a task or ask a question' }).click()
  await h.page.keyboard.press('Enter')
  await replyDone(h)
  const name = (await readdir(`${h.root}/home`)).find((n) => n.startsWith('my-project-'))
  return `${h.root}/home/${name}`
}

// After a first reply on a worktree: the agent's committed work and one uncommitted edit appear in the worktree, and a second turn ends so the chip reads them.
const workInWorktree = async (h, wt) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(`${wt}/discount.js`, DISCOUNT)
  await repoRun(wt, 'add', 'discount.js')
  await repoRun(wt, 'commit', '-m', 'Add the discount helper')
  await writeFile(`${wt}/checkout.js`, CHECKOUT_NEW)
  await writeScript(h, replyScript({ steps: [{ text: 'The checkout total now uses the helper too.' }] }))
  await h.page.getByRole('textbox', { name: 'Message Code Reviewer' }).fill('Use it in the checkout total as well')
  await h.page.keyboard.press('Enter')
  await h.page.locator('[data-testid="agent-message"]').nth(1).waitFor({ timeout: 15000 })
  await h.page.locator('[data-testid="send-button"] .sr-only', { hasText: 'Send' }).waitFor({ timeout: 15000 })
  await h.page.locator('[data-testid="chat-git-dirty"]').waitFor({ timeout: 15000 })
}

// A real mouse drag over the diff's lines (row numbers from `data-row`; row 0 is the hunk header), so the selection menu shows.
const dragDiffLines = async (h, a, b) => {
  const page = h.page
  const from = await page.locator(`[data-testid="file-rows"] [data-row="${a}"] .code`).boundingBox()
  const to = await page.locator(`[data-testid="file-rows"] [data-row="${b}"] .code`).boundingBox()
  await page.mouse.move(from.x + 1, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  await page.mouse.move(to.x + to.width - 1, to.y + to.height / 2, { steps: 4 })
  await page.mouse.up()
  await page.locator('[data-testid="selection-menu"]').waitFor({ timeout: 5000 })
}

// One app call from the page, over a fresh socket (the page's cookie rides along), to set up a board the way a person would by clicking.
const appCall = (h, method, ...args) =>
  h.page.evaluate(
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

// A board with a card or two in most columns. Cards made on the board are New; each is moved the way a drag or the card's Status would.
const demoBoard = async (h) => {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(projectDir(h), { recursive: true })
  const cards = [
    'Order the demo data',
    'Update the checkout copy',
    'Fix the double discount on reload',
    'Check the fix on the staging server',
    'Write release notes for 0.4'
  ]
  for (const text of cards) await appCall(h, 'todos:add', text, null)
  const board = await appCall(h, 'todos:board')
  const id = (text) => board.open.find((i) => i.text === text).id
  await appCall(h, 'todos:assign', id('Check the fix on the staging server'), 'release-helper', projectDir(h))
  await appCall(h, 'todos:assign', id('Update the checkout copy'), 'user', null)
  await appCall(h, 'todos:move', id('Update the checkout copy'), 'progress')
  await appCall(h, 'todos:assign', id('Fix the double discount on reload'), 'user', null)
  await appCall(h, 'todos:move', id('Fix the double discount on reload'), 'todo')
  await appCall(h, 'todos:edit', id('Fix the double discount on reload'), {
    description: 'The discount code runs twice when the cart reloads. Reproduce it with the cart test, then fix it in the checkout total.\n\nDone when the checkout tests pass.'
  })
  await appCall(h, 'todos:comment', id('Fix the double discount on reload'), 'Keep the change small: one file if you can.', null)
  await appCall(h, 'todos:move', id('Order the demo data'), 'done')
  await h.page.reload()
  await h.page.locator('[data-testid="rail-todos"]').click()
  await h.page.locator('[data-testid="board-card"]').first().waitFor({ timeout: 15000 })
  return id
}

// Background processes: the fake CLI that starts one through the real process tool (after its approval card), as the e2e suite does.
// The scenario rides in the first message, which is why these shots show only the side panel, as a full-screen sheet on a narrow window.
const PROCESS_CLI = new URL('../../zumi-bot-server/backend/tests/fixtures/fake-process-claude.mjs', import.meta.url).pathname
const DEV_COMMAND = 'echo "Local: http://localhost:5173/"; i=0; while true; do i=$((i+1)); echo "GET /checkout 200 ($i)"; sleep 1; done'
const runningProcess = async (h, size) => {
  const plan = {
    log: `${h.dataDir}/../process-log.jsonl`,
    steps: [
      { tool: 'start', args: { command: DEV_COMMAND, name: 'dev server' }, save: 'dev' },
      { tool: 'wait', args: { id: { $id: 'dev' }, patterns: ['Local:'], timeoutSeconds: 10 }, save: 'ready' }
    ]
  }
  await pickAgentAndFolder(h, `PROCESS_SCENARIO:${Buffer.from(JSON.stringify(plan)).toString('base64')}`)
  await h.page.keyboard.press('Enter')
  const card = h.page.locator('[data-testid="approval-card"][data-status="pending"]')
  await card.waitFor({ timeout: 15000 })
  await card.locator('[data-testid="approval-allow-once"]').click()
  await h.page.locator('[data-testid="agent-message"]', { hasText: 'Process fixture complete.' }).waitFor({ timeout: 30000 })
  await h.page.locator('[data-testid="process-mark"]').waitFor({ timeout: 15000 })
  // The first message is the scenario text, which would become the chat's title: name the chat as a person would.
  await appCall(h, 'chats:rename', new URL(h.page.url()).pathname.replace('/chat/', ''), 'Start the dev server')
  await h.page.reload() // the app hears a rename from its own socket only
  await h.page.locator('[data-testid="process-mark"]').waitFor({ timeout: 15000 })
  // The shot's own size is a narrow window, where the side panel is a full-screen sheet; the chat was made at the desktop size.
  await h.page.setViewportSize(size)
}

// The side panel's list, then one of its views ('files', 'changes', 'todos', 'processes').
const openSideView = async (h, view) => {
  await h.page.locator('[data-testid="side-panel-toggle"]').click()
  await h.page.locator(`[data-testid="side-open-${view}"]`).click()
}

// ---- Automation. Routines and workflows are made through the app's own calls (the same ones its Save buttons send), then opened by address.
// The workflow shots use the backend's fake workflow claude: an Agent step is a normal scripted reply, and a bare call (LLM, Condition) works too.
const WORKFLOW_CLI = new URL('../../zumi-bot-server/backend/tests/fixtures/fake-workflow-claude.mjs', import.meta.url).pathname

// A routine that writes release notes on weekdays at 9. The zone is set on the routine, so the picture does not carry this machine's.
const demoRoutine = async (h) => {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(projectDir(h), { recursive: true })
  await appCall(h, 'routines:save', {
    id: null,
    name: 'Weekday release notes',
    enabled: true,
    timeZone: 'UTC',
    trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } },
    target: { kind: 'new-chat', agent: 'docs-writer', cwd: projectDir(h), title: 'Release notes' },
    prompt: 'Write short release notes for everything that changed since yesterday. Keep them to five lines, in plain words.',
    command: null,
    limitPolicy: 'wait',
    missedPolicy: 'run-once',
    sessionPolicy: 'continue'
  })
}

// Opens Routines and the one routine in its editor.
const openRoutine = async (h) => {
  await h.page.reload()
  await h.page.locator('[data-testid="mode-tab-routines"]').click()
  await h.page.locator('[data-testid="routine-row"]').first().click()
  await h.page.locator('[data-testid="routine-editor"]').waitFor()
  await h.page.mouse.move(900, 4)
}

const wfStep = (id, kind, name, x, y, extra = {}) => ({ id, handle: id, name, kind, x, y, ...extra })
const wfEdge = (from, port, to) => ({ id: `${from}-${port}-${to}`, from, port, to })
const wfInput = (name, steps, edges, extra = {}) => ({
  id: null,
  name,
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps,
  edges,
  notes: [],
  groups: [],
  ...extra
})

// Release notes: you start it, an agent drafts the notes, you approve them, and a notification says it is done.
const releaseNotes = (h, extra = {}) =>
  wfInput(
    'Release notes',
    [
      wfStep('trigger', 'trigger', 'Trigger', 0, 0),
      wfStep('draft', 'agent', 'Draft the notes', 250, 0, {
        agent: 'docs-writer',
        cwd: projectDir(h),
        prompt: 'Write short release notes for these changes:\n\n{{trigger.text}}'
      }),
      wfStep('approve', 'approval', 'Approve the notes', 500, 0, { question: 'Send these release notes?\n\n{{steps.draft.output}}', editable: true }),
      wfStep('notify', 'notify', 'Tell me it is done', 750, 0, { title: 'Release notes approved', body: '{{steps.draft.output}}' })
    ],
    [wfEdge('trigger', 'out', 'draft'), wfEdge('draft', 'out', 'approve'), wfEdge('approve', 'approved', 'notify')],
    extra
  )

// A crop of the workflow canvas around what a page shows: from `top` (an element's top edge, minus `lead`) down to the bottom of `bottom`, and
// from the canvas's left edge up to just before the "React Flow" credit at its lower right, so the credit is left out by the crop alone.
const canvasCrop =
  ({ top = '[data-testid="wf-node"]', bottom, lead = 70 }) =>
  async (h) => {
    const box = async (selector) => {
      const b = await h.page.locator(selector).first().boundingBox()
      if (!b) throw new Error(`canvasCrop: ${selector} is not on screen`)
      return b
    }
    const canvas = await box('[data-testid="wf-canvas"]')
    const credit = await box('.react-flow__attribution')
    const up = Math.max(canvas.y, (await box(top)).y - lead)
    const b = await box(bottom)
    const down = b.y + b.height + 12
    return { x: canvas.x, y: up, width: credit.x - canvas.x - 4, height: down - up }
  }

const saveWorkflow = async (h, input) => {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(projectDir(h), { recursive: true })
  return appCall(h, 'workflows:save', input)
}

// Opens a saved workflow's editor and waits for its canvas.
const openWorkflow = async (h, id) => {
  await h.page.goto(`${h.origin}/workflows/${id}`)
  await h.page.locator('[data-testid="wf-canvas"]').waitFor({ timeout: 15000 })
  await h.page.locator('[data-testid="wf-node"]').first().waitFor({ timeout: 15000 })
  await h.page.mouse.move(900, 4)
}

const NOTES_REPLY = 'Release notes for 0.4:\n\n- Search is faster.\n- You can export a chat as Markdown.\n- Fixed the sidebar jumping on small windows.'
const CHANGES_TEXT = 'Faster search, a new export option, a sidebar fix.'

// Starts a run of the saved workflow, with the agent's scripted reply.
const startRun = async (h, workflowId, input = CHANGES_TEXT) => {
  await writeScript(h, replyScript({ steps: [{ text: NOTES_REPLY }] }))
  return appCall(h, 'workflows:run', workflowId, input)
}

// Chrome's fake microphone: it grants the permission and plays a short tone, so a shot can show the listening state with no real audio.
const VOICE_CHROME_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${new URL('../../zumi-bot-server/e2e/fixtures/mic-loop.wav', import.meta.url).pathname}`
]

// Three made-up vault items for the Safety shots. The values are obvious fakes (and the card number is a published test number);
// they are saved through the app's own call, as the form does. Only names, sites and counts ever show in a picture.
const vaultDemo = async (h) => {
  const save = (input) => appCall(h, 'vault:save', input, null)
  await save({
    kind: 'login',
    name: 'Staging admin',
    sites: ['staging.example.com'],
    username: 'demo-user',
    password: 'demo-password-not-real',
    totp: 'JBSWY3DPEHPK3PXP',
    agents: ['code-reviewer', 'researcher']
  })
  await save({
    kind: 'card',
    name: 'Work Visa',
    holder: 'Demo Person',
    number: '4242 4242 4242 4242',
    expiry: '12/30',
    cvc: '123',
    agents: ['release-helper']
  })
  await save({
    kind: 'apiKey',
    name: 'Deploy token',
    env: 'DEPLOY_TOKEN',
    value: 'demo-token-not-a-real-key-0000',
    description: 'Used by the release scripts to publish a build.',
    agents: ['release-helper']
  })
}

// Two agents with a daily cap each and one finished chat each. The fake claude's reply costs $0.0213, so a $5.00 cap is nowhere near and
// a $0.02 cap is passed.
const spendCapChats = async (h) => {
  const setCap = async (agent, amount) => {
    await openAgentStudio(h, agent)
    await h.page.locator('[data-testid="agent-daily-cap"]').fill(amount)
    await h.page.getByRole('button', { name: 'Save changes' }).click()
    await h.page.getByText('Saved', { exact: true }).first().waitFor({ timeout: 15000 })
  }
  await setCap('code-reviewer', '5')
  await setCap('docs-writer', '0.02')
  const chat = async (agent, message, text) => {
    await h.page.locator('[data-testid="rail-home"]').click()
    await writeScript(h, replyScript({ steps: [{ text }] }))
    await pickAgentAndFolder(h, message, agent)
    await h.page.keyboard.press('Enter')
    await replyDone(h)
  }
  await chat('code-reviewer', 'Why does the checkout test fail?', 'The cart is empty when the test runs. Seed the cart first and it passes.')
  await chat('docs-writer', 'Write a short intro for the setup page', 'Here is a short intro: set up the server in three steps, then open it in your browser.')
}

// Three finished chats with three different agents, for the Usage page. Each reply costs the fake claude's $0.0213.
const usageChats = async (h) => {
  const chats = [
    ['code-reviewer', 'Why does the checkout test fail?', 'The cart is empty when the test runs. Seed the cart first and it passes.'],
    ['docs-writer', 'Write a short intro for the setup page', 'Here is a short intro: set up the server in three steps, then open it in your browser.'],
    ['researcher', 'Compare two date libraries', 'Both libraries do the job. The smaller one is enough unless you need time zones.']
  ]
  for (const [i, [agent, message, text]] of chats.entries()) {
    if (i > 0) await h.page.locator('[data-testid="rail-home"]').click()
    await writeScript(h, replyScript({ steps: [{ text }] }))
    await pickAgentAndFolder(h, message, agent)
    await h.page.keyboard.press('Enter')
    await replyDone(h)
  }
}

// Three finished chats that leave audit records: two tool calls that run with no card, one Bash command you allow once and one you deny.
// The log is then rewritten to fixed made-up times, durations and machine name, with the hash chain worked out again (so Verify chain would
// still say intact), because the real ones change on every run and would differ between the light and the dark picture.
const auditDemo = async (h) => {
  const { readdir, readFile, writeFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const ask = (id, command, why, resultText, isError) => {
    const input = { command, description: why }
    const rid = `9b1d3c7e-2f44-4a68-8d10-5e6f7a8b9c0${id}`
    const lines = [
      { type: 'system', subtype: 'init', session_id: SESSION, cwd: '/tmp/demo', model: 'claude-haiku-5-5', permissionMode: 'default' },
      { type: 'assistant', message: { model: 'claude-haiku-5-5', id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input }], stop_reason: null, usage: { input_tokens: 2, output_tokens: 20 } }, parent_tool_use_id: null, session_id: SESSION },
      { type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input, description: why, permission_suggestions: [], decision_reason: 'This command requires approval', decision_reason_type: 'other', tool_use_id: `toolu_${id}` } }
    ]
    const out = lines.map((l) => JSON.stringify(l))
    out.push(`#WAIT_RESPONSE ${rid}`)
    out.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: `toolu_${id}`, type: 'tool_result', content: resultText, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: SESSION }))
    out.push(JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5', id: `msg_${id}b`, type: 'message', role: 'assistant', content: [{ type: 'text', text: isError ? 'Understood, I will leave the build folder alone.' : 'All 42 tests pass.' }], stop_reason: null, usage: { input_tokens: 2, output_tokens: 20 } }, parent_tool_use_id: null, session_id: SESSION }))
    out.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: SESSION, total_cost_usd: 0.0213, usage: { input_tokens: 2, output_tokens: 20 }, modelUsage: {}, num_turns: 1, result: 'done', duration_ms: 1200 }))
    return out.join('\n') + '\n'
  }
  const chat = async (agent, message, script, answer) => {
    await h.page.locator('[data-testid="rail-home"]').click()
    await writeScript(h, script)
    await pickAgentAndFolder(h, message, agent)
    await h.page.keyboard.press('Enter')
    if (answer) {
      await h.page.locator('[data-testid="approval-card"]').waitFor({ timeout: 15000 })
      await h.page.locator(`[data-testid="${answer}"]`).click()
    }
    await replyDone(h)
  }
  const tools = [
    { tool: { name: 'Read', input: { file_path: 'README.md' }, result: '# Shop\nA small demo shop.' } },
    { tool: { name: 'Bash', input: { command: 'ls -la', description: 'List the files' }, result: 'README.md  checkout.ts' } },
    { text: 'The folder holds a README and the checkout file.' }
  ]
  await chat('code-reviewer', 'What is in this folder?', replyScript({ steps: tools }))
  await chat('docs-writer', 'Run the tests', ask('1', 'npm test', 'Run the project tests', 'Tests: 42 passed'), 'approval-allow-once')
  await chat('researcher', 'Clean up the old build', ask('2', 'rm -rf build', 'Remove the build folder', "The user doesn't want to proceed with this tool use.", true), 'approval-deny')
  // The writer appends each record; give the last one a moment, then rewrite the file.
  await h.page.waitForTimeout(1500)
  const dir = `${h.dataDir}/audit`
  const files = (await readdir(dir)).filter((f) => /^audit-.*\.jsonl$/.test(f))
  if (files.length !== 1) throw new Error(`auditDemo: expected one audit file, found ${files.length}`)
  const sha = (t) => createHash('sha256').update(t).digest('hex')
  const [headLine, ...recLines] = (await readFile(`${dir}/${files[0]}`, 'utf8')).split('\n').filter(Boolean)
  const base = Date.UTC(2026, 10, 18, 9, 14, 0)
  const head = { ...JSON.parse(headLine), machine: 'a1b2c3d4', created: base - 1000 }
  const out = [JSON.stringify(head)]
  let last = out[0]
  recLines.forEach((line, i) => {
    const r = JSON.parse(line)
    const next = JSON.stringify({
      ...r,
      ts: base + i * 41_000,
      durationMs: r.durationMs === null ? null : 40 + i * 70,
      machine: 'a1b2c3d4',
      prev: sha(last)
    })
    out.push(next)
    last = next
  })
  await writeFile(`${dir}/${files[0]}`, out.join('\n') + '\n')
}

// A Codex agent for the engines shots, written beside the demo agents, and the fake Codex app-server (no login, no quota).
const codexAgentStart = async ({ agentsDir }) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    `${agentsDir}/test-writer.md`,
    '---\nname: test-writer\ndescription: Writes unit tests for the code you point it at.\ncolor: purple\nicon: bolt\nprovider: codex\n---\nYou write unit tests. Read the code first, then add the smallest tests that cover it.\n'
  )
  return { fakeCodex: true }
}

// Plays one Codex turn on the fake app-server: a shell call, then the reply.
const codexScript = async (h, text) => {
  const { writeFile } = await import('node:fs/promises')
  const note = (method, params) => ({ notify: { method, params: { threadId: '$THREAD', turnId: '$TURN', ...params } } })
  const steps = [
    { exec: { command: 'npm test -- cart', output: 'Tests: 3 passed, 3 total\n' } },
    note('item/agentMessage/delta', { itemId: 'msg-1', delta: text }),
    note('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text } })
  ]
  await writeFile(h.codex.script, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
}

// Picks an Engine in Agent Studio's select by its value (claude, codex, acp, ag-ui).
const pickOptionByValue = async (h, value) => {
  await h.page.locator('[data-testid="agent-engine"]').click()
  await h.page.locator(`.search-select-menu [data-testid="select-option"][data-value="${value}"]`).click()
}

// Agent Studio's Engine select on a saved agent, scrolled to its card.
const openEngineSelect = async (h) => {
  await openAgentStudio(h, 'code-reviewer')
  await scrollStudioTo(h, '#card-model')
}

/** @type {Shot[]} */
export const SHOTS = [
  {
    // The home screen with the demo agents; nothing to do after the app loads.
    name: 'get-started-first-look',
    go: async () => {}
  },
  {
    // The first screen of the server's setup wizard. Narrow, so the card fills the picture and stays readable on a phone.
    name: 'get-started-setup-code',
    start: { mode: 'vps', setup: false },
    viewport: { width: 560, height: 560 },
    go: (h, theme) => wizard(h, theme, 'code')
  },
  {
    // The authenticator step: the QR code to scan and the 6-digit code box.
    name: 'get-started-setup-authenticator',
    start: { mode: 'vps', setup: false },
    viewport: { width: 560, height: 760 },
    go: (h, theme) => wizard(h, theme, 'totp')
  },
  {
    // The new-chat screen: the agent picker, the folder picker and a message ready to send.
    name: 'get-started-first-chat-pickers',
    viewport: { width: 860, height: 460 },
    // Not `go: pickAgentAndFolder`: the runner's second argument is the theme, which would become the typed message.
    go: (h) => pickAgentAndFolder(h)
  },
  {
    // The reply is waiting for an answer: the agent wants to run a command, and the approval card offers the choices.
    name: 'get-started-first-chat-approval',
    viewport: { width: 860, height: 680 },
    go: async (h) => {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(new URL('./scripts/first-chat-approval.jsonl', import.meta.url), h.script)
      await pickAgentAndFolder(h)
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="approval-card"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // An open chat after a finished reply, with the next message half typed: the thread, the message box and the picker row.
    name: 'chatting-composer',
    viewport: { width: 1180, height: 720 },
    go: async (h) => {
      await chatWithReply(h)
      await typeInChat(h, 'Yes, add that test')
    }
  },
  {
    // Two files waiting to go with the next message: a picture as a thumbnail and a text file as a chip.
    name: 'chatting-attachments',
    viewport: { width: 1180, height: 720 },
    go: async (h) => {
      await chatWithReply(h)
      // The button chooses which draft the dialog's files join, so the files go through it, not straight into the input.
      const chooser = h.page.waitForEvent('filechooser')
      await h.page.locator('[data-testid="attach-button"]').click()
      await (await chooser).setFiles([
        { name: 'checkout-mockup.png', mimeType: 'image/png', buffer: await demoPng() },
        { name: 'error-log.txt', mimeType: 'text/plain', buffer: Buffer.from('TypeError: cannot read properties of undefined\n'.repeat(60)) }
      ])
      await h.page.locator('[data-testid="draft-attachment"][data-status="ready"]').nth(1).waitFor({ timeout: 15000 })
      await typeInChat(h, 'Why does checkout fail? The screenshot and the log are attached.')
    }
  },
  {
    // An approval card with its input open: the exact fields the agent wants to change, and the choices below.
    name: 'chatting-approval-input',
    viewport: { width: 860, height: 700 },
    go: async (h) => {
      await useScript(h, 'chatting-approval-input.jsonl')
      await pickAgentAndFolder(h, 'Make the greeting use the name')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="approval-card"]').waitFor({ timeout: 15000 })
      await h.page.locator('.approval-head').click()
    }
  },
  {
    // A question card with two questions: one choice at a time, with tabs to move between them.
    name: 'chatting-question-card',
    viewport: { width: 860, height: 700 },
    go: async (h) => {
      await useScript(h, 'chatting-question.jsonl')
      await pickAgentAndFolder(h, 'Set up tests for this project')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="question-card"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // A plan card from a chat started in Plan mode: the plan, then Approve or Keep planning.
    name: 'chatting-plan-card',
    viewport: { width: 1180, height: 760 },
    go: async (h) => {
      await useScript(h, 'chatting-plan.jsonl')
      await pickAgentAndFolder(h, 'Add a test for the empty list')
      await h.page.locator('[data-testid="new-chat-mode"]').click()
      await h.page.locator('[data-testid="chat-mode-option"][data-value="plan"]').click()
      // Picking from the menu moved the focus away from the message box.
      await h.page.getByRole('textbox', { name: 'Describe a task or ask a question' }).press('Enter')
      await h.page.locator('[data-testid="plan-card"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // The mode picker open in a chat: Auto, Ask permissions, Accept edits and Plan mode.
    name: 'chatting-mode-menu',
    viewport: { width: 1180, height: 720 },
    go: async (h) => {
      await chatWithReply(h)
      await h.page.locator('[data-testid="chat-mode"]').click()
      await h.page.locator('[data-testid="chat-mode-menu"]').waitFor()
    }
  },
  {
    // The model picker open: the agent's own model first, then Opus, Sonnet and Haiku.
    name: 'chatting-model-menu',
    viewport: { width: 1180, height: 720 },
    go: async (h) => {
      await chatWithReply(h)
      await h.page.locator('[data-testid="chat-model"]').click()
      await h.page.locator('[data-testid="chat-model-menu"]').waitFor()
    }
  },
  {
    // A "/" typed at the start of the message box: the built-in commands, then this agent's own (the list's height limit is lifted for the picture).
    name: 'chatting-slash-menu',
    viewport: { width: 1180, height: 800 },
    go: async (h) => {
      await chatWithReply(h)
      await typeInChat(h, '/')
      await h.page.locator('[data-testid="command-menu"]').waitFor()
      // The list scrolls after about five rows; let it grow so the picture shows every command and its description.
      await h.page.addStyleTag({ content: '.mention-menu { max-height: none !important }' })
    }
  },
  {
    // A side question asked while the main reply is still running: the answer shows in the side panel.
    name: 'chatting-btw-panel',
    viewport: { width: 1200, height: 640 },
    go: async (h) => {
      await useScript(h, 'chatting-btw-main.jsonl')
      await pickAgentAndFolder(h, 'Run the full test suite')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="agent-message"], [data-testid="streaming-bubble"]').first().waitFor({ timeout: 15000 })
      // The running reply has read its script already; the side run starts a new process, so it gets this one.
      await useScript(h, 'chatting-btw-side.jsonl')
      await typeInChat(h, '/btw What is the difference between a mock and a stub?')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="side-panel"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="side-entry"][data-state="done"]').waitFor({ timeout: 30000 })
    }
  },
  {
    // A finished reply whose run of steps is open: the agent's thought (summary) opened, then the command it ran.
    name: 'chatting-thinking',
    viewport: { width: 980, height: 640 },
    go: async (h) => {
      await writeScript(
        h,
        replyScript({
          steps: [
            {
              thinking:
                '**Finding the failing test**\n\nThe error mentions an empty list, so I should check how the cart handles no items before I change anything.\n\nI will run the tests first to see which one fails.',
              ms: 3000
            },
            { tool: { name: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, result: 'Tests: 1 failed, 41 passed' } },
            { text: 'One test fails: `cart.test.ts` expects an empty cart to show a message, but it shows nothing.\n\nWant me to fix it?' }
          ]
        })
      )
      await pickAgentAndFolder(h, 'Why does the checkout test fail?')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('.tool-run-head').first().click()
      await h.page.locator('[data-testid="thought-row"] .tool-head').first().click()
    }
  },
  {
    // The context meter's ring in the row under the box, open: how full the context is and the Compact now button.
    name: 'chatting-context-meter',
    viewport: { width: 1180, height: 640 },
    go: async (h) => {
      await writeScript(h, replyScript({ used: 152000, steps: [{ text: 'The migration is done. All 42 tests still pass.' }] }))
      await pickAgentAndFolder(h, 'Finish the database migration')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('[data-testid="context-chip"]').click()
      await h.page.locator('[data-testid="context-popup"]').waitFor()
    }
  },
  {
    // A reply that is still running: the message box shows Pause beside Stop.
    name: 'chatting-pause-running',
    viewport: { width: 980, height: 560 },
    go: async (h) => {
      await writeScript(
        h,
        replyScript({
          steps: [{ text: 'Updating the docs for the new settings page.' }, { sleep: 60000 }, { text: 'Done.' }]
        })
      )
      await pickAgentAndFolder(h, 'Update the docs for the new settings page')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="pause-button"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="streaming-bubble"], [data-testid="agent-message"]').first().waitFor({ timeout: 15000 })
    }
  },
  {
    // A paused chat: the notice and its Resume button.
    name: 'chatting-pause-resume',
    viewport: { width: 980, height: 560 },
    go: async (h) => {
      await writeScript(
        h,
        replyScript({
          steps: [{ text: 'Updating the docs for the new settings page.' }, { sleep: 4000 }, { text: 'I stopped at a good point: the page outline is done.' }]
        })
      )
      await pickAgentAndFolder(h, 'Update the docs for the new settings page')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="pause-button"]').click({ timeout: 15000 })
      await h.page.locator('[data-testid="resume-button"]').waitFor({ timeout: 30000 })
    }
  },
  {
    // A reply the usage limit stopped: the notice says when the chat continues by itself, with Continue now and Don't continue.
    name: 'chatting-limit-wait',
    viewport: { width: 980, height: 560 },
    go: async (h) => {
      await writeScript(h, replyScript({ limitAt: Date.now() + 2 * 3600_000 }))
      await pickAgentAndFolder(h, 'Keep going with the migration')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="limit-notice"][data-state="waiting"]').waitFor({ timeout: 20000 })
    }
  },
  {
    // The buttons that show beside your message when you point at it: Edit, Resend, Fork and Copy.
    name: 'chatting-message-actions',
    viewport: { width: 980, height: 520 },
    go: async (h) => {
      await writeScript(h, replyScript({ uuid: true, steps: [{ text: 'I would use a map keyed by the product id. It keeps the lookup fast and the code short.' }] }))
      await pickAgentAndFolder(h, 'How should I store the cart items?')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('[data-testid="user-message"]').first().hover()
      await h.page.locator('[data-testid="user-message-actions"]').first().waitFor()
    }
  },
  {
    // A message edited once: the new version shows, and the arrows under it step between versions ("2 / 2").
    name: 'chatting-versions',
    viewport: { width: 980, height: 560 },
    go: async (h) => {
      await writeScript(h, replyScript({ uuid: true, steps: [{ text: 'I would use a map keyed by the product id. It keeps the lookup fast and the code short.' }] }))
      await pickAgentAndFolder(h, 'How should I store the cart items?')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      // The edit runs a new session, so the second script has its own id.
      await writeScript(
        h,
        replyScript({
          uuid: true,
          session: '8b21c4d7-95fa-4e0c-a6d3-2f7e1b9c0a44',
          steps: [{ text: 'For a cart that is saved to the server, use a list of line items, each with a product id and a quantity. It is easy to send and to store.' }]
        })
      )
      await h.page.locator('[data-testid="user-message"]').first().hover()
      await h.page.locator('[data-testid="edit-button"]').click()
      const box = h.page.locator('[data-testid="message-editor"] .msg-edit-input .ProseMirror')
      await box.click()
      await h.page.keyboard.press('Control+A')
      await h.page.keyboard.type('How should I store the cart items so they can be saved to the server?')
      await h.page.locator('[data-testid="message-editor-send"]').click()
      await h.page.locator('[data-testid="version-switcher"]').waitFor({ timeout: 20000 })
      await h.page.locator('[data-testid="send-button"] .sr-only', { hasText: 'Send' }).waitFor({ timeout: 20000 })
      await h.page.locator('[data-testid="agent-message"]', { hasText: 'list of line items' }).waitFor({ timeout: 20000 })
    }
  },
  {
    // The sidebar search: chats whose name matches, and under them the messages that contain the words.
    name: 'chatting-search',
    viewport: { width: 980, height: 620 },
    go: async (h) => {
      await demoChats(h)
      await h.page.locator('[data-testid="search-button"]').click()
      await h.page.locator('[data-testid="search-input"]').fill('checkout')
      await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="message-hit"]').length >= 3, null, { timeout: 30000 })
    }
  },
  {
    // A chat whose reply came in while you were elsewhere shows a dot; its row menu (right-click) offers Export and Archive.
    name: 'chatting-unread-menu',
    viewport: { width: 980, height: 620 },
    go: async (h) => {
      await demoChats(h, { unread: true })
      // The agent is folded, so the dot shows on it first; open it to list its chats.
      await h.page.locator('[data-testid="agent-unread-dot"]').waitFor({ timeout: 20000 })
      await h.page.locator('[data-testid="agent-row"][data-agent-name="code-reviewer"]').click()
      const row = h.page.locator('[data-testid="chat-row"]', { hasText: 'Write release notes' }).first()
      await row.locator('[data-testid="unread-dot"]').waitFor({ timeout: 20000 })
      await row.click({ button: 'right' })
      await h.page.locator('[data-testid="chat-menu-archive"]').waitFor()
    }
  },
  {
    // The Archived list: two archived chats under the Back to chats link and the search box (no chat open, no rows ticked).
    name: 'chatting-archived',
    viewport: { width: 980, height: 620 },
    go: async (h) => {
      await demoChats(h)
      await h.page.locator('[data-testid="agent-row"][data-agent-name="code-reviewer"]').click()
      for (const title of ['Add a discount code', 'Write release notes']) {
        await h.page.locator('[data-testid="chat-row"]', { hasText: title }).first().click({ button: 'right' })
        await h.page.locator('[data-testid="chat-menu-archive"]').click()
        await h.page.waitForTimeout(500)
      }
      await h.page.locator('[data-testid="archived-open"]').click()
      await h.page.locator('[data-testid="archived-search"]').waitFor()
    }
  },
  {
    // Export from one reply: the dialog offers this reply or the whole chat, Markdown or a web page, and to include tool steps.
    name: 'chatting-export-dialog',
    viewport: { width: 860, height: 640 },
    go: async (h) => {
      await writeScript(h, replyScript({ steps: [{ text: 'Use a list of line items, each with a product id and a quantity. It is easy to send and to store.' }] }))
      await pickAgentAndFolder(h, 'How should I store the cart items?')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('[data-testid="agent-message"]').first().hover()
      await h.page.locator('[data-testid="export-button"]').click()
      await h.page.locator('[data-testid="export-dialog"]').waitFor()
    }
  },
  {
    // Agent Studio on a saved agent: the form's cards on the left (identity, model, icon, tools, commands) and the system prompt on the right.
    name: 'agents-studio-form',
    viewport: { width: 1280, height: 1000 },
    go: async (h) => {
      await openAgentStudio(h, 'code-reviewer')
      await h.page.locator('#agent-prompt').waitFor()
    }
  },
  {
    // The same editor scrolled down: Icon & color, Tools (all tools inherited) and the Commands card with this agent's three commands.
    name: 'agents-studio-cards',
    viewport: { width: 1280, height: 1000 },
    go: async (h) => {
      await openAgentStudio(h, 'code-reviewer')
      await scrollStudioTo(h, '#card-avatar')
    }
  },
  {
    // A reply in which the agent saved something to its memory: the line "Memory: 1 saved" under the reply, with its View link.
    name: 'agents-memory-line',
    viewport: { width: 980, height: 520 },
    start: { env: { CLAUDE_CONFIG_DIR: undefined } },
    go: async (h) => {
      const file = `${memoryFolder(h, 'researcher')}/feedback_short_answers.md`
      await writeScript(
        h,
        withFileWrite(
          replyScript({
            steps: [
              { tool: { name: 'Write', input: { file_path: file, content: 'x' }, result: 'File created' } },
              { text: 'Noted. From now on I will keep my answers short and put the evidence after them.' }
            ]
          }),
          file,
          memoryFile('Prefers short answers', 'Reply style', 'feedback', 'Keep answers short. Put the evidence after the answer.')
        )
      )
      await pickAgentAndFolder(h, 'Please keep your answers short from now on', 'researcher')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('[data-testid="memory-line"]').waitFor({ timeout: 20000 })
    }
  },
  {
    // Agent Studio's Memory card (On, Limit 100, three memories grouped by type) and, below it, the Remembered approvals card with one
    // rule that "Allow always for this agent" made in a real approval card first.
    name: 'agents-memory-approvals',
    // Short, so the cards under Remembered approvals (the browser, computer use and Isolation) stay out of the picture.
    viewport: { width: 1180, height: 640 },
    start: { env: { CLAUDE_CONFIG_DIR: undefined } },
    go: async (h) => {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const dir = memoryFolder(h, 'researcher')
      await mkdir(dir, { recursive: true })
      await writeFile(`${dir}/user_role.md`, memoryFile('Works on the checkout team', 'Who the user is', 'user', 'The user works on the checkout team.'))
      await writeFile(`${dir}/feedback_short_answers.md`, memoryFile('Prefers short answers', 'Reply style', 'feedback', 'Keep answers short.'))
      await writeFile(`${dir}/project_release_freeze.md`, memoryFile('Release freeze starts Friday', 'Project timing', 'project', 'No merges after Friday noon.'))
      // The index Claude Code keeps beside them; without it the server adds the lines itself and logs that on stderr.
      await writeFile(
        `${dir}/MEMORY.md`,
        [
          '- [Works on the checkout team](user_role.md) — Who the user is',
          '- [Prefers short answers](feedback_short_answers.md) — Reply style',
          '- [Release freeze starts Friday](project_release_freeze.md) — Project timing',
          ''
        ].join('\n')
      )
      await useScript(h, 'first-chat-approval.jsonl')
      await pickAgentAndFolder(h, 'Run the project tests', 'researcher')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="approval-card"]').waitFor({ timeout: 15000 })
      await h.page.getByRole('button', { name: /Allow always for this agent/ }).click()
      await openAgentStudio(h, 'researcher')
      await h.page.locator('[data-testid="memory-row"]').nth(2).waitFor({ timeout: 15000 })
      await h.page.getByLabel('Remembered approvals').waitFor()
      await scrollStudioTo(h, '[data-testid="memory-section"]')
    }
  },
  {
    // Settings › Claude Code, Servers tab: the servers Claude Code loads from a folder, each with its status.
    name: 'agents-extensions-settings',
    viewport: { width: 1180, height: 720 },
    start: extensionsStart,
    go: async (h) => {
      await writeExtensionsState(h)
      await h.page.goto(`${h.origin}/settings/claude-code`)
      await h.page.locator('[data-testid="ext-server"]').first().waitFor({ timeout: 30000 })
      await tidyFolderPath(h)
    }
  },
  {
    // The New server form of that tab, filled in for a server that runs a command on this machine.
    name: 'agents-extensions-server-form',
    viewport: { width: 1180, height: 760 },
    start: extensionsStart,
    go: async (h) => {
      await writeExtensionsState(h)
      await h.page.goto(`${h.origin}/settings/claude-code`)
      await h.page.locator('[data-testid="ext-add-server"]').click()
      await h.page.getByLabel('Name', { exact: true }).fill('calendar')
      await h.page.getByLabel('Command', { exact: true }).fill('node')
      await h.page.getByLabel('Arguments', { exact: true }).fill('calendar-server.js')
      await tidyFolderPath(h)
    }
  },
  {
    // Agent Studio's "What this agent loads" card: totals, then Servers (with switches), Skills, Plugins and Hooks for one agent.
    name: 'agents-extensions-agent-card',
    viewport: { width: 1180, height: 1180 },
    start: extensionsStart,
    go: async (h) => {
      await writeExtensionsState(h)
      await openAgentStudio(h, 'code-reviewer')
      await h.page.locator('[data-testid="agent-ext-server"]').first().waitFor({ timeout: 30000 })
      await h.page.locator('[data-testid="agent-ext-skills"] summary').click()
      await tidyFolderPath(h)
      await scrollStudioTo(h, '[data-testid="agent-loadout"]')
    }
  },
  {
    // The "/" menu of a Zumi Bot chat: its commands for agents, routines and workflows (the list's height limit is lifted for the picture).
    name: 'agents-zumi-bot-commands',
    viewport: { width: 1180, height: 900 },
    go: async (h) => {
      await h.page.locator('[data-testid="agent-row"][data-agent-name="zumi-bot"]').click()
      await typeInChat(h, '/')
      await h.page.locator('[data-testid="command-menu"]').waitFor()
      // The tall menu covers the start screen except the end of the agent's description, which would peek out beside it.
      await h.page.addStyleTag({ content: '.mention-menu { max-height: none !important } .chat-intro-desc { visibility: hidden }' })
    }
  },
  {
    // A chat with Zumi Bot after it made an agent: its reply names the agent and its commands, and the new agent is in the sidebar.
    name: 'agents-zumi-bot-chat',
    viewport: { width: 1180, height: 760 },
    go: async (h) => {
      const file = `${h.agentsDir}/pr-reviewer.md`
      const agent = [
        '---',
        'name: pr-reviewer',
        'description: Reviews a pull request for bugs and missing tests.',
        'color: purple',
        'icon: magnifier',
        'autoCompactWindow: 400000',
        'commands:',
        '  - name: review',
        '    description: Review the changes in this folder',
        '    prompt: |',
        '      Review the changes in this folder. $ARGUMENTS',
        '---',
        'You review pull requests. Point out real bugs first, then missing tests.',
        ''
      ].join('\n')
      await writeScript(
        h,
        withFileWrite(
          replyScript({
            steps: [
              { tool: { name: 'Write', input: { file_path: file, content: 'x' }, result: 'File created' } },
              {
                text: 'I created **pr-reviewer**. It reviews a pull request for bugs and missing tests, and it is now in your sidebar.\n\nCommands:\n- `/review`: Review the changes in this folder\n\nI set its Compact at size to 400K, the usual size for an agent like this.'
              }
            ]
          }),
          file,
          agent
        )
      )
      await h.page.locator('[data-testid="agent-row"][data-agent-name="zumi-bot"]').click()
      await typeInChat(h, 'Make me an agent that reviews pull requests for bugs and missing tests')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('[data-testid="agent-row"][data-agent-name="pr-reviewer"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // A finished room: three members in the sidebar and the title, two of them answered one message with no @mention, and the pickers show 3 agents, the folder and Role.
    name: 'rooms-room-chat',
    viewport: { width: 1180, height: 760 },
    start: roomStart(),
    go: finishedRoom
  },
  {
    // The Role popup of a room: how the team works, read by every agent and the moderator.
    name: 'rooms-role-popup',
    viewport: { width: 1180, height: 760 },
    start: roomStart(),
    go: async (h) => {
      await finishedRoom(h)
      await h.page.locator('[data-testid="role-chip"]').click()
      await h.page.locator('[data-testid="role-popup"]').waitFor()
    }
  },
  {
    // Clone room on its first step: a name, what is kept, and the two ways to start (Start over or With summary).
    name: 'rooms-clone-dialog',
    viewport: { width: 1180, height: 760 },
    start: roomStart(),
    go: async (h) => {
      await finishedRoom(h)
      await openCloneDialog(h)
      await h.page.locator('[data-testid="clone-option-summary"]').click()
    }
  },
  {
    // Review summary: the handoff note the members will read, open for editing.
    name: 'rooms-clone-review',
    viewport: { width: 1180, height: 820 },
    start: roomStart(),
    go: async (h) => {
      await finishedRoom(h)
      await openCloneDialog(h)
      await h.page.locator('[data-testid="clone-option-summary"]').click()
      await h.page.locator('[data-testid="clone-write"]').click()
      await h.page.locator('[data-testid="clone-text"]').waitFor({ timeout: 30000 })
    }
  },
  {
    // The cloned room: the Handoff card at the top, collapsed, with the room it came from.
    name: 'rooms-handoff-card',
    viewport: { width: 1180, height: 760 },
    start: roomStart(),
    go: async (h) => {
      await finishedRoom(h)
      await openCloneDialog(h)
      await h.page.locator('[data-testid="clone-option-summary"]').click()
      await h.page.locator('[data-testid="clone-write"]').click()
      await h.page.locator('[data-testid="clone-text"]').waitFor({ timeout: 30000 })
      await h.page.locator('[data-testid="clone-create"]').click()
      await h.page.locator('[data-testid="handoff-card"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // Code Reviewer asked Docs Writer a question: the ask card shows who was asked, the message, the status and a command that waits for your answer.
    name: 'rooms-ask-card',
    viewport: { width: 1180, height: 820 },
    start: roomStart(),
    go: async (h) => {
      await askScripts(h)
      await pickAgentAndFolder(h, ASK_MESSAGE)
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="ask-card"] [data-testid="approval-card"]').waitFor({ timeout: 20000 })
    }
  },
  {
    // The chat the ask opened, seen from Docs Writer: A's message, the reply, and the Asked bar where the message box would be.
    name: 'rooms-asked-chat',
    viewport: { width: 1180, height: 760 },
    start: roomStart(),
    go: async (h) => {
      await askScripts(h)
      await pickAgentAndFolder(h, ASK_MESSAGE)
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="ask-card"] [data-testid="approval-card"]').waitFor({ timeout: 20000 })
      await h.page.locator('[data-testid="approval-allow-once"]').click()
      await h.page.locator('[data-testid="ask-card"][data-status="done"]').waitFor({ timeout: 20000 })
      await h.page.locator('[data-testid="ask-open"]').click()
      await h.page.locator('[data-testid="asked-bar"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // The Dispatched agents list after a reply that sent two subagents out: each row with its type and totals, and the chat behind it.
    name: 'rooms-dispatch-list',
    viewport: { width: 1180, height: 700 },
    go: async (h) => {
      await writeScript(h, dispatchScript())
      await pickAgentAndFolder(h, 'Check the checkout tests and find where the discount is applied')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('[data-testid="side-panel-toggle"]').click()
      await h.page.locator('[data-testid="side-open-dispatch"]').click()
      await h.page.locator('[data-testid="dispatch-row"]').nth(1).waitFor({ timeout: 15000 })
    }
  },
  {
    // One dispatched agent opened: its final report first, then the prompt it got and a fold for its steps.
    name: 'rooms-dispatch-agent',
    viewport: { width: 1180, height: 700 },
    go: async (h) => {
      await writeScript(h, dispatchScript())
      await pickAgentAndFolder(h, 'Check the checkout tests and find where the discount is applied')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('[data-testid="side-panel-toggle"]').click()
      await h.page.locator('[data-testid="side-open-dispatch"]').click()
      await h.page.locator('[data-testid="dispatch-row"]').first().click()
      await h.page.locator('[data-testid="dispatch-report"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // The Files panel after a reply that edited one file and wrote another: the list, then one file as a diff with its Restore button.
    name: 'projects-files-panel',
    viewport: { width: 1180, height: 700 },
    go: async (h) => {
      await filesChat(h)
      await openSideView(h, 'files')
      await h.page.locator('[data-testid="file-row"][data-path$="checkout.js"]').click()
      await h.page.locator('[data-testid="file-restore"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(600, 20)
    }
  },
  {
    // The confirm that Restore asks first.
    name: 'projects-restore-confirm',
    viewport: { width: 1180, height: 700 },
    go: async (h) => {
      await filesChat(h)
      await openSideView(h, 'files')
      await h.page.locator('[data-testid="file-row"][data-path$="checkout.js"]').click()
      await h.page.locator('[data-testid="file-restore"]').click()
      await h.page.getByRole('dialog').waitFor()
    }
  },
  {
    // The new-chat folder menu for a git repository, with "Isolate in worktree" ticked.
    name: 'projects-worktree-toggle',
    viewport: { width: 1180, height: 640 },
    go: async (h) => {
      await makeRepo(h)
      await pickAgentAndFolder(h, 'Add a discount helper for the checkout')
      await isolateInWorktree(h, { keepOpen: true })
    }
  },
  {
    // A chat in a plain repository (no worktree): the branch chip with its dot, and the Changes panel listing two files, one as a diff.
    name: 'projects-changes-panel',
    viewport: { width: 1180, height: 700 },
    go: async (h) => {
      const { writeFile } = await import('node:fs/promises')
      await makeRepo(h)
      await writeFile(`${projectDir(h)}/checkout.js`, CHECKOUT_NEW)
      await writeFile(`${projectDir(h)}/discount.js`, DISCOUNT)
      await writeScript(h, replyScript({ steps: [{ text: 'I used the discount in the checkout total and added a helper for the code.' }] }))
      await pickAgentAndFolder(h, 'Take the discount off the checkout total')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      await h.page.locator('[data-testid="chat-git-dirty"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="chat-git"]').click()
      await h.page.locator('[data-testid="change-row"][data-path="checkout.js"]').click()
      await h.page.locator('[data-testid="diff-row"][data-kind="add"]').first().waitFor({ timeout: 15000 })
      await h.page.mouse.move(600, 20)
    }
  },
  {
    // A chat on its own worktree: the chip names the branch, the folder chip carries the branch mark, and the Changes panel has the scope switch.
    name: 'projects-worktree-changes',
    viewport: { width: 1180, height: 700 },
    start: ghStart,
    go: async (h) => {
      const wt = await worktreeChat(h)
      await workInWorktree(h, wt)
      await h.page.locator('[data-testid="chat-git"]').click()
      await h.page.locator('[data-testid="changes-scope-base"]').click()
      await h.page.locator('[data-testid="change-row"][data-path="discount.js"]').click()
      await h.page.locator('[data-testid="diff-row"][data-kind="add"]').first().waitFor({ timeout: 15000 })
      await h.page.mouse.move(600, 20)
    }
  },
  {
    // A review comment on two lines of the agent's work: the draft bar at the foot of the Changes panel with Send review.
    name: 'projects-review-draft',
    viewport: { width: 1180, height: 700 },
    start: ghStart,
    go: async (h) => {
      const wt = await worktreeChat(h)
      await workInWorktree(h, wt)
      await h.page.locator('[data-testid="chat-git"]').click()
      await h.page.locator('[data-testid="changes-scope-base"]').click()
      await h.page.locator('[data-testid="change-row"][data-path="discount.js"]').click()
      await h.page.locator('[data-testid="diff-row"][data-kind="add"]').first().waitFor({ timeout: 15000 })
      await dragDiffLines(h, 2, 3)
      await h.page.locator('[data-testid="selection-comment"]').click()
      await h.page.locator('[data-testid="review-form-text"]').fill('Read the code from a setting, not from the function.')
      await h.page.locator('[data-testid="review-add"]').click()
      await h.page.locator('[data-testid="review-bar"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="review-row"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(600, 20)
    }
  },
  {
    // Open PR…: the dialog with the branch, its commits and a drafted title and body.
    name: 'projects-pr-dialog',
    viewport: { width: 1180, height: 760 },
    start: ghStart,
    go: async (h) => {
      const wt = await worktreeChat(h)
      await commitWork(h, wt)
      await h.page.locator('[data-testid="chat-git"]').click()
      await h.page.locator('[data-testid="pr-open"]').click()
      await h.page.locator('[data-testid="pr-commits"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(600, 20)
    }
  },
  {
    // After the pull request is made: the chip beside the branch, and the box with its state and one failing check with Send to agent.
    name: 'projects-pr-box',
    viewport: { width: 1180, height: 700 },
    start: ghStart,
    go: async (h) => {
      const wt = await worktreeChat(h)
      await commitWork(h, wt)
      await h.page.locator('[data-testid="chat-git"]').click()
      await h.page.locator('[data-testid="pr-open"]').click()
      await h.page.locator('[data-testid="pr-commits"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="pr-create"]').click()
      await h.page.locator('[data-testid="chat-pr"]').waitFor({ timeout: 30000 })
      await setGh(h, {
        auth: 'in',
        pr: {
          number: 7,
          url: 'https://github.com/acme/app/pull/7',
          state: 'OPEN',
          isDraft: false,
          statusCheckRollup: [
            { name: 'unit-tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/1/job/22' },
            { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }
          ]
        }
      })
      await h.page.locator('[data-testid="pr-refresh"]').click()
      await h.page.locator('[data-testid="pr-failing-row"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(600, 20)
    }
  },
  {
    // The task board in its Kanban view: a column per status, with cards that are New, To do, In progress and Done.
    name: 'projects-todo-board',
    viewport: { width: 1400, height: 640 },
    go: async (h) => {
      await demoBoard(h)
      // Two empty columns folded to strips (their count stays), so every status that holds a card fits.
      for (const col of ['blocked', 'review']) await h.page.locator(`[data-testid="board-col"][data-col="${col}"] [data-testid="board-col-collapse"]`).click()
      await h.page.mouse.move(640, 700)
    }
  },
  {
    // One card opened in the board's drawer: status, assignee, notes, images and a comment.
    name: 'projects-todo-card',
    viewport: { width: 1400, height: 760 },
    go: async (h) => {
      await demoBoard(h)
      await h.page.locator('[data-testid="board-card"]', { hasText: 'Fix the double discount on reload' }).locator('[data-testid="board-card-open"]').click()
      await h.page.locator('[data-testid="todo-card"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="board-drawer-expand"]').click() // the card on the left, its comments on the right
      await h.page.locator('[data-testid="todo-comment"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // The Processes panel while a dev server an agent started keeps running after its reply.
    name: 'projects-processes-list',
    start: { fake: PROCESS_CLI },
    go: async (h) => {
      await runningProcess(h, { width: 560, height: 520 })
      await openSideView(h, 'processes')
      await h.page.locator('[data-testid="process-row"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // One process opened: its command, the Stop, Restart and Forget buttons, and the output so far.
    name: 'projects-process-log',
    start: { fake: PROCESS_CLI },
    go: async (h) => {
      await runningProcess(h, { width: 560, height: 620 })
      await openSideView(h, 'processes')
      await h.page.locator('[data-testid="process-row"]').click()
      // The log view names the folder in full, and the harness's home folder has a random temporary name: show the fixed demo path instead.
      await tidyFolderPath(h, '.process-cwd')
      await h.page.waitForFunction(() => /GET \/checkout 200 \(3\)/.test(document.querySelector('[data-testid="process-log"]')?.textContent ?? ''), null, { timeout: 15000 })
    }
  },
  {
    // A saved routine's editor: the trigger card, the prompt card and the run settings (the side column says no runs yet).
    name: 'automation-routine-editor',
    viewport: { width: 1240, height: 1290 },
    clip: '[data-testid="routine-editor"]',
    go: async (h) => {
      await demoRoutine(h)
      await openRoutine(h)
    }
  },
  {
    // A workflow on its canvas: the Trigger and three steps joined by lines, with the toolbar and zoom buttons on the canvas.
    name: 'automation-workflow-canvas',
    viewport: { width: 1500, height: 440 },
    clip: canvasCrop({ bottom: '[data-testid="wf-toolbar"]' }),
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const w = await saveWorkflow(h, releaseNotes(h))
      await openWorkflow(h, w.id)
    }
  },
  {
    // The Add step menu from the canvas toolbar: every kind of step, each with its one-line hint.
    name: 'automation-workflow-add-step',
    viewport: { width: 1500, height: 860 },
    clip: canvasCrop({ top: '[data-testid="wf-add-menu"]', lead: 20, bottom: '[data-testid="wf-toolbar"]' }),
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const w = await saveWorkflow(h, releaseNotes(h))
      await openWorkflow(h, w.id)
      await h.page.locator('[data-testid="wf-add"]').click()
      await h.page.locator('[data-testid="wf-add-menu"]').waitFor()
    }
  },
  {
    // An Agent step picked on the canvas: its settings open in the panel on the right.
    name: 'automation-workflow-step',
    viewport: { width: 1180, height: 1000 },
    clip: '[data-testid="wf-inspector"]',
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const w = await saveWorkflow(h, releaseNotes(h))
      await openWorkflow(h, w.id)
      await h.page.locator('[data-testid="wf-node"][data-step-id="draft"]').click()
      await h.page.locator('[data-testid="wf-step-inspector"]').waitFor()
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // The trigger's "Starts" list open: manual, schedule, webhook and the five event kinds.
    name: 'automation-workflow-starts',
    viewport: { width: 1180, height: 780 },
    clip: '[data-testid="wf-inspector"]',
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const w = await saveWorkflow(h, releaseNotes(h))
      await openWorkflow(h, w.id)
      await h.page.locator('[data-testid="wf-node"][data-step-id="trigger"]').click()
      await h.page.locator('[data-testid="wf-trigger-kind"]').click()
    }
  },
  {
    // A "When a file changes" trigger: the folder, the file pattern, the three kinds of change and the filters.
    name: 'automation-workflow-file-trigger',
    viewport: { width: 1180, height: 1300 },
    clip: '[data-testid="wf-inspector"]',
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(`${h.root}/home/invoices`, { recursive: true })
      const w = await saveWorkflow(
        h,
        releaseNotes(h, { name: 'New invoice', trigger: { kind: 'file', path: `${h.root}/home/invoices`, pattern: '*.pdf', changes: ['added'], filters: [] } })
      )
      await openWorkflow(h, w.id)
      await h.page.locator('[data-testid="wf-node"][data-step-id="trigger"]').click()
      await h.page.locator('[data-testid="wf-file-pattern"]').waitFor()
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // A run that stopped at its Approval step, on the canvas: green ticks on the steps that are done, a pause mark on the one that waits.
    name: 'automation-workflow-run',
    viewport: { width: 1500, height: 440 },
    clip: canvasCrop({ bottom: '.react-flow__controls' }),
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const w = await saveWorkflow(h, releaseNotes(h))
      const run = await startRun(h, w.id)
      await h.page.goto(`${h.origin}/workflows/${w.id}/runs/${run.id ?? run}`)
      await h.page.locator('[data-testid="wf-approval"]').waitFor({ timeout: 30000 })
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // The History dialog: three saves of one workflow, newest first, with who saved each and what changed. The dates are set on the stored
    // versions (the dialog would otherwise show the minute the picture was made, which differs between the light and dark pictures).
    name: 'automation-history-dialog',
    viewport: { width: 1180, height: 760 },
    clip: '[data-testid="history-dialog"]',
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const { readFile, writeFile } = await import('node:fs/promises')
      const first = releaseNotes(h)
      const w = await saveWorkflow(h, first)
      const second = releaseNotes(h)
      second.id = w.id
      second.steps[1].prompt = 'Write short release notes for these changes, in five lines or fewer:\n\n{{trigger.text}}'
      await saveWorkflow(h, second)
      const third = { ...second, name: 'Release notes with approval' }
      await saveWorkflow(h, third)
      const file = `${h.dataDir}/history/workflows/${w.id}.json`
      const stored = JSON.parse(await readFile(file, 'utf8'))
      const days = [Date.UTC(2026, 10, 16, 14, 5), Date.UTC(2026, 10, 12, 9, 30), Date.UTC(2026, 10, 9, 16, 45)]
      stored.versions.forEach((v, i) => (v.savedAt = days[i]))
      await writeFile(file, JSON.stringify(stored))
      await openWorkflow(h, w.id)
      await h.page.locator('[data-testid="wf-more"]').click()
      await h.page.locator('[data-testid="wf-history"]').click()
      await h.page.locator('[data-testid="history-row"]').nth(2).waitFor({ timeout: 15000 })
    }
  },
  {
    // The Inbox: a run waits for your approval, and another workflow's Notify step left a message.
    name: 'automation-inbox',
    viewport: { width: 1180, height: 700 },
    clip: '[data-testid="inbox-page"]',
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const w = await saveWorkflow(h, releaseNotes(h))
      await startRun(h, w.id)
      const backup = await saveWorkflow(
        h,
        wfInput(
          'Nightly backup',
          [
            wfStep('trigger', 'trigger', 'Trigger', 0, 0),
            wfStep('notify', 'notify', 'Tell me it is done', 250, 0, { title: 'Nightly backup finished', body: 'All 12 folders were copied. Nothing failed.' })
          ],
          [wfEdge('trigger', 'out', 'notify')]
        )
      )
      await appCall(h, 'workflows:run', backup.id)
      // The message's time is set to last night, as it would be after an overnight run, so the picture does not show the minute it was made.
      const { readFile, writeFile } = await import('node:fs/promises')
      const file = `${h.dataDir}/workflow-messages.json`
      for (let i = 0; i < 100 && !(await appCall(h, 'inbox:messages')).messages.length; i++) await h.page.waitForTimeout(200)
      const stored = JSON.parse(await readFile(file, 'utf8'))
      for (const m of stored.messages) m.at = Date.UTC(2026, 10, 19, 2, 0)
      await writeFile(file, JSON.stringify(stored))
      await h.page.goto(`${h.origin}/inbox`)
      await h.page.locator('[data-testid="inbox-card"]').waitFor({ timeout: 30000 })
      await h.page.locator('[data-testid="inbox-messages"] >> text=Nightly backup finished').waitFor({ timeout: 30000 })
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // The same run's panel: the Approval step's question with the agent's draft in an editable box, a note, Approve and Reject.
    name: 'automation-workflow-approval',
    viewport: { width: 1500, height: 640 },
    clip: '[data-testid="wf-inspector"]',
    start: { fake: WORKFLOW_CLI },
    go: async (h) => {
      const w = await saveWorkflow(h, releaseNotes(h))
      const run = await startRun(h, w.id)
      await h.page.goto(`${h.origin}/workflows/${w.id}/runs/${run.id ?? run}`)
      await h.page.locator('[data-testid="wf-approval"]').waitFor({ timeout: 30000 })
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // Settings > Voice input with voice on and a key saved (the seed's key is a made-up string; the page never shows it).
    name: 'voice-settings',
    seed: 'voice',
    viewport: { width: 900, height: 1500 },
    clip: '[data-testid="settings-voice"]',
    go: async (h) => {
      await h.page.goto(`${h.origin}/settings/voice`)
      await h.page.locator('[data-testid="voice-talk"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="voice-aliases"]').waitFor()
      await h.page.mouse.move(890, 4)
    }
  },
  {
    // The message box while dictating: Chrome's own fake microphone feeds the recorder, nothing is sent anywhere until the mic is tapped again.
    name: 'voice-dictation-listening',
    seed: 'voice',
    viewport: { width: 1180, height: 720 },
    clip: '.composer',
    start: { chromeArgs: VOICE_CHROME_ARGS },
    go: async (h) => {
      await chatWithReply(h)
      await typeInChat(h, 'Please also check')
      await h.page.locator('.composer [data-testid="dictation-button"]').click()
      await h.page.locator('.composer [data-testid="dictation-strip"]').waitFor({ timeout: 15000 })
    }
  },
  {
    // The voice request screen on a phone, before the first tap: the default agent's face, the dotted line and "Tap to talk".
    name: 'voice-request-phone',
    seed: 'voice',
    viewport: { width: 390, height: 540 },
    start: { chromeArgs: VOICE_CHROME_ARGS },
    go: async (h) => {
      await h.page.goto(`${h.origin}/voice`)
      await h.page.locator('[data-testid="voice-talk"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="voice-start"]').waitFor()
    }
  },
  {
    // An agent's start screen, then its browser opened beside it: tabs, address bar, the Take control switch and "View only".
    // ZumiBot uses the Chrome found on this machine, so the shot needs no browser download. Set ZUMIBOT_DOCS_CHROME to its path when it is not
    // /usr/bin/google-chrome.
    name: 'computer-browser-panel',
    viewport: { width: 1280, height: 720 },
    clip: '[data-testid="browser-panel"]',
    start: () => ({ env: { ZUMIBOT_BROWSER_EXECUTABLE_PATH: chromeForPanel() } }),
    go: async (h) => {
      await h.page.locator('[data-testid="agent-row"][data-agent-name="researcher"]').click()
      await h.page.getByRole('button', { name: 'Open Browser' }).click()
      await h.page.locator('[data-testid="browser-panel"]').waitFor({ timeout: 15000 })
      await h.page.locator('.browser-footer', { hasText: 'Live browser' }).waitFor({ timeout: 60000 })
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // Agent Studio's Computer use card with the switch on and saved: the line under the title, Open Desktop and Clear desktop data.
    name: 'computer-studio-card',
    viewport: { width: 1280, height: 900 },
    clip: '[data-testid="desktop-settings"]',
    go: async (h) => {
      await openAgentStudio(h, 'researcher')
      await scrollStudioTo(h, '[data-testid="desktop-settings"]')
      await h.page.locator('[data-testid="computer-use-switch"]').click()
      await h.page.getByRole('button', { name: 'Save changes' }).click()
      await h.page.locator('[data-testid="open-desktop"]:not([disabled])').waitFor({ timeout: 20000 }).catch(() => {})
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // A reply waiting on an approval card for a desktop click: the line "Click at 412, 300" and the Show on desktop button.
    name: 'computer-approval-card',
    viewport: { width: 860, height: 820 },
    // From the top of the card to the bottom of Allow once: the rows under it name the tool the way the server knows it.
    clip: async (h) => {
      const card = await h.page.locator('[data-testid="approval-card"]').first().boundingBox()
      const allow = await h.page.locator('[data-testid="approval-allow-once"]').first().boundingBox()
      return { x: card.x, y: card.y, width: card.width, height: allow.y + allow.height - card.y + 12 }
    },
    go: async (h) => {
      const { readFile, writeFile } = await import('node:fs/promises')
      const tool = 'mcp__zumibot_desktop__desktop_click'
      const input = '{"x":412,"y":300,"stamp":"demo"}'
      const text = (await readFile(new URL('./scripts/first-chat-approval.jsonl', import.meta.url), 'utf8'))
        .replaceAll('"name":"Bash"', `"name":"${tool}"`)
        .replaceAll('"tool_name":"Bash","display_name":"Bash"', `"tool_name":"${tool}","display_name":"${tool}"`)
        .replaceAll('{"command":"npm test","description":"Run the project\'s tests"}', input)
        .replaceAll("Run the project's tests", 'Click the Save button')
        .replaceAll("I'll run the tests first, then look at anything that fails.", "I'll click Save in the editor window.")
      await writeFile(h.script, text)
      await pickAgentAndFolder(h, 'Save the file in the editor', 'researcher')
      await h.page.keyboard.press('Enter')
      await h.page.locator('[data-testid="approval-card"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // Settings > Notifications on a server, with this browser enabled. A headless Chrome cannot make a real push subscription, so the page's
    // own device is enabled through the app's own call with made-up keys and an address that is never contacted; nothing is sent.
    name: 'connect-notifications-settings',
    viewport: { width: 1000, height: 1100 },
    clip: '[data-testid="settings-notifications"]',
    start: { mode: 'vps', env: { ZUMIBOT_TEST_PUSH_ORIGIN: 'http://127.0.0.1:9' } },
    go: async (h) => {
      const { createECDH, randomBytes } = await import('node:crypto')
      await h.context.grantPermissions(['notifications'], { origin: h.origin })
      const ua = createECDH('prime256v1')
      ua.generateKeys()
      const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
      await h.page.waitForFunction(() => localStorage.getItem('zumibot.deviceId') !== null, null, { timeout: 15000 })
      await h.page.evaluate(
        async ({ keys }) => {
          const deviceId = localStorage.getItem('zumibot.deviceId')
          const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`)
          await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error('the socket did not open')))))
          await new Promise((res, rej) => {
            ws.onmessage = (e) => {
              const m = JSON.parse(e.data)
              if (m.id === 1) m.ok ? res(m.value) : rej(new Error(m.error))
            }
            // The label is the one the page itself would send for this browser.
            ws.send(JSON.stringify({ id: 1, method: 'notify:enable', args: [deviceId, { channel: 'push', label: 'Chrome on Linux', subscription: { endpoint: 'http://127.0.0.1:9/demo', keys } }] }))
          })
          ws.close()
        },
        { keys }
      )
      await h.page.goto(`${h.origin}/settings/notifications`)
      await h.page.locator('[data-testid="notify-state"]', { hasText: 'On' }).waitFor({ timeout: 15000 })
      await h.page.mouse.move(990, 4)
    }
  },
  {
    // Settings > Channels, the Telegram part, with a bot token saved, the bot running and one agent switched on. Made against the e2e
    // suite's fake Telegram service, so no real bot is involved; the pairing code is random and is not shown.
    name: 'connect-telegram-settings',
    viewport: { width: 900, height: 1500 },
    clip: '[data-testid="channel-section"]',
    start: async () => {
      const { startFakeTelegram } = await import('../../zumi-bot-server/backend/tests/fixtures/fake-telegram.mjs')
      const tg = await startFakeTelegram()
      return { env: { ZUMIBOT_TEST_TELEGRAM_URL: tg.origin }, cleanup: () => tg.close() }
    },
    go: async (h) => {
      const { FAKE_TOKEN } = await import('../../zumi-bot-server/backend/tests/fixtures/fake-telegram.mjs')
      await h.page.goto(`${h.origin}/settings/channels`)
      await h.page.locator('[data-testid="settings-channels"]').waitFor({ timeout: 30000 })
      await h.page.locator('[data-testid="channel-token"]').fill(FAKE_TOKEN)
      await h.page.locator('[data-testid="channel-token-save"]').click()
      await h.page.locator('[data-testid="channel-token-remove"]').waitFor({ timeout: 15000 })
      await h.page.locator('[data-testid="channel-run"]').check()
      await h.page.locator('[data-testid="channel-state"]', { hasText: 'Connected' }).waitFor({ timeout: 20000 })
      await h.page.locator('[data-testid="channel-agent-code-reviewer"]').check()
      await h.page.mouse.move(890, 4)
    }
  },
  {
    // The Slack part of the same page before anything is set up: the steps the Slack app needs and the two token fields.
    name: 'connect-slack-settings',
    viewport: { width: 900, height: 2600 }, // tall: the Slack part starts below the Telegram part
    clip: async (h) => {
      const section = await h.page.locator('[data-testid="slack-section"]').boundingBox()
      const card = await h.page.locator('[data-testid="slack-section"] .set-card').first().boundingBox()
      return { x: section.x, y: section.y, width: section.width, height: card.y + card.height - section.y + 12 }
    },
    go: async (h) => {
      await h.page.goto(`${h.origin}/settings/channels`)
      await h.page.locator('[data-testid="slack-section"]').waitFor({ timeout: 30000 })
      await h.page.locator('[data-testid="slack-state"]', { hasText: 'No tokens saved.' }).waitFor({ timeout: 15000 })
      await h.page.mouse.move(890, 4)
    }
  },
  {
    // Settings > Connectors: Gmail connected and turned on for one agent, Notion needing a sign-in. The fake CLI answers the connector list
    // from a state file, so no claude.ai account is involved.
    name: 'connect-connectors-settings',
    viewport: { width: 1000, height: 1700 },
    start: extensionsStart,
    clip: async (h) => {
      const list = await h.page.locator('[data-testid="connectors-page"]').boundingBox()
      const second = await h.page.locator('[data-testid="connector-card"]').nth(1).boundingBox()
      return { x: list.x, y: list.y, width: list.width, height: second.y + second.height - list.y + 12 }
    },
    go: async (h) => {
      const { writeFile } = await import('node:fs/promises')
      const proxy = (name, url, status, tools = []) => ({
        name,
        status,
        scope: 'claudeai',
        transport: 'claudeai-proxy',
        config: { type: 'claudeai-proxy', url, id: `mcpsrv_${name.length}` },
        tools: tools.map((t) => ({ name: t }))
      })
      const state = {
        version: '2.1.0',
        mcpServers: [
          proxy('claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1', 'connected', ['search_threads', 'get_thread', 'create_draft', 'send_message']),
          proxy('claude.ai Notion', 'https://mcp.notion.com/mcp', 'needs-auth')
        ],
        skills: [],
        hooks: [],
        plugins: []
      }
      await writeFile(`${h.dataDir}/../extensions-state.json`, JSON.stringify(state, null, 2))
      await h.page.goto(`${h.origin}/settings/connectors`)
      await h.page.locator('[data-testid="connector-card"][data-state="connected"]').waitFor({ timeout: 30000 })
      const flip = '[data-testid="connector-card"][data-id="gmail"] [data-testid="connector-switch"][data-agent="code-reviewer"]'
      await h.page.locator(flip).click()
      await h.page.locator(`${flip}[data-on="true"]`).waitFor({ timeout: 10000 })
      await h.page.mouse.move(990, 4)
    }
  },
  {
    // Settings > Vault with three made-up items: a login, a card and an API key, each with its agents. Every secret is an obvious fake and
    // the list never shows one. The items are saved through the app's own call, as the form would.
    name: 'safety-vault-list',
    viewport: { width: 1000, height: 900 },
    clip: '[data-testid="settings-vault"]',
    go: async (h) => {
      await vaultDemo(h)
      await h.page.goto(`${h.origin}/settings/vault`)
      await h.page.locator('[data-testid="vault-group-apiKey"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(990, 4)
    }
  },
  {
    // An item's form, here a login: Sites, Username, the Password and 2FA secret boxes (empty on open, with "Saved. Leave blank to keep it."),
    // the two switches and the agents that can use it. Show and Copy are not pressed, so no value is on screen.
    name: 'safety-vault-form',
    viewport: { width: 1000, height: 1100 },
    clip: '[data-testid="vault-form"]',
    go: async (h) => {
      await vaultDemo(h)
      await h.page.goto(`${h.origin}/settings/vault`)
      await h.page.locator('[data-testid="vault-group-login"] [data-testid^="vault-row-"]').first().click()
      await h.page.locator('[data-testid="vault-form"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(990, 4)
    }
  },
  {
    // Agent Studio's Daily spend cap card with an amount typed in ($5, saved).
    name: 'safety-spend-cap-agent',
    viewport: { width: 1280, height: 1000 },
    clip: 'section[aria-labelledby="card-spend"]',
    go: async (h) => {
      await openAgentStudio(h, 'code-reviewer')
      await h.page.locator('[data-testid="agent-daily-cap"]').fill('5')
      await h.page.getByRole('button', { name: 'Save changes' }).click()
      await h.page.getByText('Saved', { exact: true }).first().waitFor({ timeout: 15000 })
      await scrollStudioTo(h, 'section[aria-labelledby="card-spend"]')
      await h.page.mouse.move(900, 20)
    }
  },
  {
    // Settings > Usage > Spend caps: Code Reviewer with a $5.00 cap and one short chat so far, Docs Writer with a $0.02 cap that one chat
    // already passed (so its row reads over, with the Allow button). The caps are set through Agent Studio's own field.
    name: 'safety-spend-cap-usage',
    viewport: { width: 1100, height: 900 },
    clip: '[data-testid="usage-caps"]',
    go: async (h) => {
      await spendCapChats(h)
      await h.page.goto(`${h.origin}/settings/usage`)
      await h.page.locator('[data-testid="usage-cap"][data-over="true"]').waitFor({ timeout: 20000 })
      await h.page.mouse.move(1090, 4)
    }
  },
  {
    // The cost chip in a chat's picker row, open: this chat's total, its messages, the four token counts and the model rows.
    name: 'safety-usage-cost-chip',
    viewport: { width: 1180, height: 720 },
    clip: '[data-testid="cost-pop"]',
    go: async (h) => {
      await chatWithReply(h)
      await h.page.locator('[data-testid="cost-chip"]').click()
      await h.page.locator('[data-testid="cost-pop"]').waitFor()
      await h.page.mouse.move(1170, 4)
    }
  },
  {
    // Settings > Usage after three short chats with three agents: the total with its Exact and Estimated lines. The daily chart beside it
    // is left out of the crop, since its date axis would be wrong the day after.
    name: 'safety-usage-total',
    viewport: { width: 1180, height: 1000 },
    clip: '.usg-hero-left',
    go: async (h) => {
      await usageChats(h)
      await h.page.goto(`${h.origin}/settings/usage`)
      await h.page.locator('[data-testid="usage-row"]').first().waitFor({ timeout: 20000 })
      await h.page.mouse.move(1170, 4)
    }
  },
  {
    // The same page lower down, on the Agent tab: the token boxes and the breakdown table with Cost, Share and Tokens.
    name: 'safety-usage-breakdown',
    viewport: { width: 1180, height: 1000 },
    clip: async (h) => {
      const totals = await h.page.locator('.usg-totals').boundingBox()
      const table = await h.page.locator('.usg-table-wrap').boundingBox()
      return { x: totals.x, y: totals.y - 4, width: totals.width, height: table.y + table.height - totals.y + 8 }
    },
    go: async (h) => {
      await usageChats(h)
      await h.page.goto(`${h.origin}/settings/usage`)
      await h.page.locator('[data-testid="usage-row"]').first().waitFor({ timeout: 20000 })
      await h.page.mouse.move(1170, 4)
    }
  },
  {
    // Settings > Audit log after three short chats: two tool calls that ran without a card, one you allowed once and one you denied.
    // The log's times, durations and machine name are rewritten to fixed made-up values (see auditDemo), so both pictures agree; the
    // footer, which carries the machine name and size, is cropped out.
    name: 'safety-audit-log',
    viewport: { width: 1100, height: 900 },
    clip: async (h) => {
      const page = await h.page.locator('[data-testid="audit-page"]').boundingBox()
      const list = await h.page.locator('[data-testid="audit-list"]').boundingBox()
      return { x: page.x, y: page.y, width: page.width, height: list.y + list.height - page.y + 4 }
    },
    go: async (h) => {
      await auditDemo(h)
      await h.page.goto(`${h.origin}/settings/audit`)
      await h.page.locator('[data-testid="audit-row"]').nth(3).waitFor({ timeout: 20000 })
      await h.page.mouse.move(1090, 4)
    }
  },
  {
    // One record opened from the log: the decision in words and the facts under it (the JSON below them is cropped out, since it holds ids).
    name: 'safety-audit-record',
    viewport: { width: 1100, height: 1100 },
    clip: async (h) => {
      const rec = await h.page.locator('[data-testid="audit-record"]').boundingBox()
      const facts = await h.page.locator('.audit-facts').boundingBox()
      return { x: rec.x, y: rec.y, width: rec.width, height: facts.y + facts.height - rec.y + 12 }
    },
    go: async (h) => {
      await auditDemo(h)
      await h.page.goto(`${h.origin}/settings/audit`)
      await h.page.locator('[data-testid="audit-row"][data-decision="approvedByUser"]').first().click()
      await h.page.locator('[data-testid="audit-why"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(1090, 4)
    }
  },
  {
    // Agent Studio's Engine select open: Claude, Codex, ACP agent and Remote agent (AG-UI). The Codex CLI is the fake one, so Codex is offered.
    name: 'engines-engine-select',
    viewport: { width: 1280, height: 900 },
    start: codexAgentStart,
    go: async (h) => {
      await openEngineSelect(h)
      await h.page.locator('[data-testid="agent-engine"]').click()
      await h.page.locator('.search-select-menu [data-testid="select-option"][data-value="codex"]:not([aria-disabled="true"])').waitFor({ timeout: 15000 })
    },
    clip: async (h) => {
      const card = await h.page.locator('section[aria-labelledby="card-model"]').boundingBox()
      const menu = await h.page.locator('.search-select-menu').boundingBox()
      const y = card.y + 18 // skip the pane's edge, where the title above the card peeks in
      return { x: card.x, y, width: card.width, height: Math.max(card.height - 18, menu.y + menu.height - y + 16) }
    }
  },
  {
    // A reply from a Codex agent: the sidebar row carries the Codex tag; the chat looks like any other chat.
    name: 'engines-codex-chat',
    viewport: { width: 1180, height: 640 },
    start: codexAgentStart,
    go: async (h) => {
      await codexScript(h, 'I ran the cart tests and all three pass. I added two more cases for an empty cart and a removed item.')
      await pickAgentAndFolder(h, 'Add tests for the cart total', 'test-writer')
      await h.page.keyboard.press('Enter')
      await replyDone(h)
      // Open the "Thought for ..." line, as a reader does, so the shell call the agent made shows.
      await h.page.locator('[data-testid="tool-run"] .tool-run-head').first().click()
      await h.page.mouse.move(1150, 4)
    }
  },
  {
    // Agent Studio's ACP card as a reader fills it in before saving: Command and Arguments (one per line). The values are examples.
    name: 'engines-acp-card',
    viewport: { width: 1280, height: 1000 },
    clip: '[data-testid="acp-card"]',
    go: async (h) => {
      await openEngineSelect(h)
      await pickOptionByValue(h, 'acp')
      await h.page.locator('[data-testid="acp-command"]').fill('gemini')
      await h.page.locator('[data-testid="acp-args"]').fill('--acp')
      await scrollStudioTo(h, '[data-testid="acp-card"]')
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // Agent Studio's Remote agent card with an example endpoint typed in and nothing saved: the notice says where messages would go.
    name: 'engines-remote-card',
    viewport: { width: 1280, height: 1000 },
    clip: '[data-testid="agui-card"]',
    go: async (h) => {
      await openEngineSelect(h)
      await pickOptionByValue(h, 'ag-ui')
      await h.page.locator('[data-testid="agui-endpoint"]').fill('https://agents.example.com/run')
      await scrollStudioTo(h, '[data-testid="agui-card"]')
      await h.page.mouse.move(900, 4)
    }
  },
  {
    // Settings > Jev decisions with a made-up key saved (the page never shows it): the master switch, the key box and the three switches.
    name: 'engines-jev-settings',
    seed: 'jev',
    viewport: { width: 900, height: 1000 },
    clip: '[data-testid="settings-jev"]',
    go: async (h) => {
      await h.page.goto(`${h.origin}/settings/jev`)
      await h.page.locator('[data-testid="jev-key-test"]').waitFor({ timeout: 15000 })
      await h.page.mouse.move(890, 4)
    }
  }
]
