// Acceptance assertions precede the fake CLI implementation. All websites/auth are synthetic.
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir, cpus, totalmem, release } from 'node:os'
import { execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { signIn, start, unexpectedErrors } from './harness.mjs'
import { ipcDirsOf } from './e2eChecks.mjs'
import { browserSite } from './fixtures/browser-site.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-browser-claude.mjs', import.meta.url))
await access(FAKE)
const out = fileURLToPath(new URL('../../.superpowers/sdd/2026-10-27-agent-browser/task-10-evidence/', import.meta.url))
await mkdir(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(40)
  }
  throw Error(`Timed out: ${label}`)
}
const json = (path) => readFile(path, 'utf8').then(JSON.parse)
const lines = (path) =>
  readFile(path, 'utf8').then(
    (s) => s.trim().split('\n').filter(Boolean).map(JSON.parse),
    () => []
  )
const checks = [],
  measurements = []
function pass(name) {
  checks.push(name)
  console.log(`PASS ${name}`)
}
const scenario = (plan) => `BROWSER_SCENARIO:${Buffer.from(JSON.stringify(plan)).toString('base64')}`
const call = (tool, args = {}, save) => ({ tool: `browser_${tool}`, args, save })
const ref = (observation, name) => ({ $ref: { observation, name } })
const stamp = (observation) => ({ $stamp: observation })

async function connect(h, path = '/ws', origin = h.origin, authenticated = true) {
  const cookie = (await h.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  const ws = new WebSocket(h.origin.replace('http', 'ws') + path, {
    headers: { Origin: origin, ...(authenticated ? { Cookie: cookie } : {}) }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let id = 0
  const pending = new Map(),
    wire = [],
    frames = []
  ws.on('message', (raw, binary) => {
    if (binary) {
      frames.push({ time: Date.now(), bytes: raw.length })
      return
    }
    const value = JSON.parse(String(raw))
    wire.push(value)
    if (pending.has(value.id)) {
      pending.get(value.id)(value)
      pending.delete(value.id)
    }
  })
  ws.on('error', () => {})
  return {
    ws,
    wire,
    frames,
    async request(message, wait = true) {
      const next = ++id
      if (!wait) {
        ws.send(JSON.stringify({ id: next, ...message }))
        return { id: next, value: null }
      }
      const result = new Promise((resolve) => pending.set(next, resolve))
      ws.send(JSON.stringify({ id: next, ...message }))
      let timer
      const response = await Promise.race([
        result,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`Socket timeout ${message.op ?? message.method}`)), 20000)
        })
      ]).finally(() => clearTimeout(timer))
      assert.equal(response.ok, true, JSON.stringify(response))
      return { id: next, value: response.value }
    },
    async rpc(method, ...args) {
      return (await this.request({ method, args }, method !== 'chats:send')).value
    },
    close() {
      ws.close()
    }
  }
}
async function rejectedSocket(h, origin, authenticated) {
  const client = await connect(h, '/ws/browser', origin, authenticated)
  assert.equal(await new Promise((resolve) => client.ws.once('close', resolve)), 4401)
}
async function items(rpc, id) {
  return (await rpc.rpc('chats:items', id)).items
}
async function handoff(rpc, id, status = 'pending') {
  return until(
    async () => (await items(rpc, id)).find((i) => i.type === 'browser-action' && i.handoff.status === status),
    `handoff ${status}`
  )
}
async function logResult(log, name) {
  return until(async () => (await lines(log)).find((e) => e.name === name), `fake tool result ${name}`)
}
async function received(metrics, command) {
  return (await lines(metrics)).filter((e) => e.type === 'ipcRequestReceived' && e.command === command).length
}
// Call only after the private service receipt checkpoint, then give an erroneously
// admitted request time to return through the bridge before releasing its blocker.
async function assertBlocked(log, names) {
  const end = Date.now() + 250
  do {
    const results = await lines(log)
    for (const name of names)
      assert.equal(
        results.some((e) => e.name === name),
        false,
        `${name} stays blocked after service receipt`
      )
    if (Date.now() >= end) return
    await sleep(25)
  } while (true)
}
async function openChat(h, chat) {
  await h.page.reload()
  await h.page.locator('[data-agent-name="researcher"]').first().click()
  // The agent click opens its block and its start screen; wait for it so the rows below have stopped moving.
  await h.page.locator('[data-testid="new-chat"]').waitFor()
  // A folder lists its newest chats, so an older one now sits behind Show more, as it would for a user.
  const row = h.page.locator(`[data-chat-id="${chat.id}"]`).first()
  const more = h.page.locator(`[data-testid="folder"][data-cwd="${chat.cwd}"] [data-testid="folder-more"]`).first()
  for (let shown = 0; !(await row.isVisible()); shown++) {
    if (shown > 20) throw Error(`Chat ${chat.id} is not listed in its folder`)
    await more.click()
  }
  await row.click()
}
async function captureCount(metrics) {
  const running = new Map()
  for (const e of await lines(metrics)) {
    if (e.type === 'Page.startScreencast') running.set(e.pid, (running.get(e.pid) ?? 0) + 1)
    if (e.type === 'Page.stopScreencast') running.set(e.pid, Math.max(0, (running.get(e.pid) ?? 0) - 1))
    if (e.type === 'close') running.delete(e.pid)
  }
  return [...running.values()].reduce((sum, count) => sum + count, 0)
}
const knownChrome = new Map()
// Follow fixture worker descendants and retain their identities across forced parent exit.
// Playwright gives Chromium its own process group, so worker PGID alone is insufficient.
async function resources(metrics) {
  const descendants = new Set((await lines(metrics)).filter((e) => e.type === 'launch').map((e) => e.pid))
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((s) => s.trim().split(/\s+/))
  for (let n = -1; n !== descendants.size;) {
    n = descendants.size
    for (const r of rows) if (descendants.has(Number(r[1]))) descendants.add(Number(r[0]))
  }
  const known = knownChrome.get(metrics) ?? new Map()
  knownChrome.set(metrics, known)
  const chrome = []
  let ticks = 0
  for (const row of rows.filter((r) => /chrome|chromium/.test(r[3]))) {
    const stat = await readFile(`/proc/${row[0]}/stat`, 'utf8').catch(() => '')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (!stat || fields[0] === 'Z' || !(descendants.has(Number(row[0])) || known.get(row[0]) === fields[19])) continue
    known.set(row[0], fields[19])
    chrome.push(row)
    ticks += Number(fields[11] ?? 0) + Number(fields[12] ?? 0)
  }
  return { processes: chrome.length, rssMiB: chrome.reduce((n, r) => n + Number(r[2]), 0) / 1024, ticks }
}
async function measure(metrics, state) {
  const a = await resources(metrics),
    start = Date.now()
  await sleep(1500)
  const b = await resources(metrics)
  const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }))
  const record = {
    state,
    ...b,
    sampleMs: Date.now() - start,
    cpuPercentOneCore: (Math.max(0, b.ticks - a.ticks) / hz / ((Date.now() - start) / 1000)) * 100
  }
  delete record.ticks
  measurements.push(record)
  console.log(`MEASURE ${JSON.stringify(record)}`)
}

const website = await browserSite()
const roots = [],
  harnesses = []
try {
  for (const mode of ['local', 'vps']) {
    const root = await mkdtemp(join(tmpdir(), 'cb-browser-acceptance-'))
    roots.push(root)
    const agentsDir = join(root, 'agents'),
      metrics = join(root, 'metrics.jsonl')
    await mkdir(agentsDir)
    for (const name of ['researcher', 'writer', 'third'])
      await writeFile(
        join(agentsDir, name + '.md'),
        `---\nname: ${name}\ndescription: Synthetic browser acceptance\n---\nUse the browser fixture.`
      )
    const h = await start({
      mode,
      fake: FAKE,
      agentsDir,
      env: {
        BROWSER_E2E_METRICS: metrics,
        NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/browser-instrumentation.mjs', import.meta.url))}`,
        ZUMIBOT_BROWSER_IDLE_MS: '60000',
        ZUMIBOT_BROWSER_HANDOFF_IDLE_MS: '3000',
        ZUMIBOT_BROWSER_LEASE_IDLE_MS: '20000',
        ZUMIBOT_BROWSER_QUEUE_MS: '15000'
      }
    })
    harnesses.push(h)
    const uiInputs = new Set(),
      uiWire = []
    h.page.on('websocket', (ws) => {
      if (!ws.url().endsWith('/ws/browser')) return
      ws.on('framesent', (e) => {
        try {
          const r = JSON.parse(String(e.payload))
          uiWire.push({ direction: 'sent', op: r.op, id: r.id })
          if (r.op === 'input') uiInputs.add(r.id)
        } catch {}
      })
      ws.on('framereceived', (e) => {
        try {
          const r = JSON.parse(String(e.payload))
          if (r.type === 'response') {
            uiInputs.delete(r.id)
            uiWire.push({ direction: 'received', id: r.id, ok: r.ok })
          }
        } catch {}
      })
    })
    let rpc = await connect(h),
      answer = await connect(h, '/ws/browser')
    await rejectedSocket(h, 'https://hostile.invalid', true)
    await rejectedSocket(h, h.origin, false)
    await measure(metrics, mode + ': zero browsers')
    assert.equal((await resources(metrics)).processes, 0)
    const chat = await rpc.rpc('chats:create', 'researcher', root),
      log = join(root, 'main.jsonl')
    const gate = join(root, 'continue'),
      takeover = join(root, 'takeover')
    const plan = {
      log,
      steps: [
        call('navigate', { url: website.url }),
        call('observe', {}, 'before'),
        { wait: gate },
        call('request_user_action', { reason: 'Synthetic account check' }, 'handoff'),
        { wait: takeover },
        {
          parallel: [
            call('observe', {}, 'after'),
            call('click', { stamp: stamp('before'), ref: ref('before', 'Click me') }, 'blockedAction')
          ]
        },
        call('click', { stamp: stamp('before'), ref: ref('before', 'Click me') }, 'stale'),
        call('click', { stamp: stamp('after'), ref: ref('after', 'Show account') }, 'show'),
        call('observe', {}, 'manual'),
        call('click', { stamp: stamp('manual'), ref: ref('manual', 'Set cookie') }),
        call('release', {}, 'released')
      ]
    }
    await rpc.rpc('chats:send', chat.id, scenario(plan), [])
    await logResult(log, 'before')
    assert.equal(await captureCount(metrics), 0)
    await measure(metrics, mode + ': active unviewed')
    await writeFile(gate, 'go')
    await handoff(rpc, chat.id)
    await openChat(h, chat)
    await h.page.getByTestId('browser-action').getByRole('button', { name: 'Open Browser', exact: true }).click()
    await until(() => captureCount(metrics).then((n) => n === 1), 'one actual CDP screencast')
    // The page is sized to the panel, so the frame fills it 1:1 (headless Chrome has one pixel per CSS pixel).
    await h.page.waitForFunction(() => {
      const c = document.querySelector('canvas')
      return !!c?.width && c.width === Math.floor(c.getBoundingClientRect().width)
    })
    assert.equal(await h.page.getByRole('switch', { name: 'Take control' }).isChecked(), false)
    const viewer = await connect(h, '/ws/browser'),
      target = { agent: 'researcher', chatId: chat.id }
    const watch = await viewer.request({ op: 'watch', target })
    await until(() => viewer.frames.length > 0, 'second watcher frame')
    // A viewport change restarts the screencast (stop, then start), so the count is briefly 0; it settles at one capture.
    await until(() => captureCount(metrics).then((n) => n === 1), 'still one actual CDP screencast with two watchers')
    const observed = (await logResult(log, 'before')).result.data
    const current = viewer.wire.filter((m) => m.type === 'status').at(-1).status
    assert.equal(current.generation, observed.stamp.generation)
    assert.equal(current.activeTabId, observed.stamp.tabId)
    assert.equal(current.tabs[0].url, website.url + '/')
    await measure(metrics, mode + ': active viewed')
    const started = Date.now(),
      beforeFrames = viewer.frames.length
    await sleep(1100)
    const sample = viewer.frames.slice(beforeFrames),
      duration = Date.now() - started
    const frameMetric = {
      mode,
      frames: sample.length,
      durationMs: duration,
      fps: (sample.length * 1000) / duration,
      bytes: sample.reduce((n, f) => n + f.bytes, 0),
      maxFrameBytes: Math.max(0, ...sample.map((f) => f.bytes))
    }
    assert.ok(frameMetric.fps <= 11)
    measurements.push(frameMetric)
    // Resolve before takeover; Done intentionally releases the controlling viewer.
    const card = await handoff(rpc, chat.id)
    await answer.request({ op: 'answer', target, requestId: card.id, decision: 'done' })
    await logResult(log, 'handoff')
    await h.page.getByTestId('browser-action').getByRole('button', { name: 'Open Browser', exact: true }).click()
    await h.page.getByRole('switch', { name: 'Take control' }).check()
    await h.page.getByText('You have control', { exact: true }).waitFor()
    const observeReceipts = await received(metrics, 'observe'),
      clickReceipts = await received(metrics, 'click')
    await writeFile(takeover, 'go')
    await until(
      async () => (await received(metrics, 'observe')) > observeReceipts && (await received(metrics, 'click')) > clickReceipts,
      'competing observe and click reached private IPC service'
    )
    await assertBlocked(log, ['after', 'blockedAction'])
    const s = viewer.wire.filter((m) => m.type === 'status').at(-1).status
    const denied = await viewer
      .request({ op: 'navigate', watchId: watch.id, generation: s.generation, tabId: s.activeTabId, command: { op: 'reload' } })
      .then(
        () => false,
        () => true
      )
    assert.equal(denied, true, 'read-only second viewer cannot act')
    // Coordinate input reaches the same input the MCP later observes.
    const [W, H] = await h.page.evaluate(() => {
      const c = document.querySelector('canvas')
      return [c.width, c.height]
    })
    const surface = await h.page.getByLabel('Browser page input').boundingBox(),
      k = Math.min(surface.width / W, surface.height / H)
    await h.page.mouse.click(surface.x + (surface.width - W * k) / 2 + 110 * k, surface.y + (surface.height - H * k) / 2 + 18 * k)
    await h.page.keyboard.type('manual-fixture')
    await until(() => uiInputs.size === 0, 'manual inputs acknowledged')
    // Ordinary quick-toggle behavior: release immediately while a fresh burst is queued.
    await h.page.keyboard.type('-quick-release')
    await h.page.getByRole('switch', { name: 'Take control' }).uncheck()
    const after = await logResult(log, 'after')
    assert.notEqual(after.result.data.stamp.observationId, observed.stamp.observationId)
    assert.equal(
      (await logResult(log, 'blockedAction')).result.code,
      'stale_reference',
      'blocked action completes after release with its stale stamp rejected'
    )
    assert.equal(after.result.data.stamp.generation, observed.stamp.generation, 'quick release keeps the live browser generation')
    assert.equal((await logResult(log, 'stale')).result.ok, false)
    assert.match((await logResult(log, 'manual')).result.data.text, /manual-fixture/)
    assert.equal((await logResult(log, 'released')).result.ok, true)
    await viewer.request({ op: 'unwatch', watchId: watch.id })
    viewer.close()
    assert.equal(await captureCount(metrics), 1)
    await h.page.getByRole('button', { name: 'Close browser', exact: true }).click()
    await until(() => captureCount(metrics).then((n) => n === 0), 'last watcher stops actual screencast')
    // A long idle setting must not retain an explicitly released, unwatched browser.
    await until(async () => (await resources(metrics)).processes === 0, 'released Chrome cleanup before idle deadline', 5000)
    await measure(metrics, mode + ': post release zero')
    pass(mode + ': unseen work / same live tab / one producer / takeover / fresh refs / manual input / prompt release zero')

    // Single/group/routine completion paths use the actual CLI -> MCP bridge -> service.
    for (const kind of ['single', 'group', 'routine'])
      for (const decision of ['done', 'cancel', 'timeout']) {
        const runLog = join(root, `${kind}-${decision}.jsonl`)
        const text = scenario({
          log: runLog,
          steps: [
            call('navigate', { url: website.url }),
            call('observe', {}, 'cookie'),
            call('request_user_action', { reason: `${kind} ${decision}` }, 'outcome'),
            call('release')
          ]
        })
        let c, run, routine
        if (kind === 'routine') {
          routine = await rpc.rpc('routines:save', {
            id: null,
            name: `Browser ${decision}`,
            enabled: true,
            timeZone: 'UTC',
            trigger: { kind: 'manual' },
            target: { kind: 'new-chat', agent: 'researcher', cwd: root },
            prompt: text
          })
          run = await rpc.rpc('routines:runNow', routine.id)
          c = { id: run.chatId }
        } else {
          c =
            kind === 'group'
              ? await rpc.rpc('chats:createGroup', ['researcher', 'writer'], root, '')
              : await rpc.rpc('chats:create', 'researcher', root)
          await rpc.rpc('chats:send', c.id, (kind === 'group' ? '@researcher ' : '') + text, [])
        }
        const action = await handoff(rpc, c.id)
        assert.equal(action.agent, 'researcher')
        assert.equal(action.handoff.chatId, c.id)
        // The run turns waiting after it reloads the chat the card was pushed to, so it can trail the card.
        if (kind === 'routine')
          await until(
            async () => (await rpc.rpc('routines:list')).runs[routine.id][0].status === 'waiting',
            'routine waits for the handoff'
          )
        if (decision !== 'timeout')
          await answer.request({ op: 'answer', target: { agent: 'researcher', chatId: c.id }, requestId: action.id, decision })
        await handoff(rpc, c.id, decision === 'cancel' ? 'cancelled' : decision === 'timeout' ? 'expired' : 'done')
        const result = (await logResult(runLog, 'outcome')).result
        assert.equal(result.ok, decision === 'done')
        if (decision !== 'done') assert.equal(result.code, decision === 'cancel' ? 'handoff_cancelled' : 'handoff_expired')
        if (kind === 'single') assert.match((await logResult(runLog, 'cookie')).result.data.text, /fixture=persisted/)
        if (kind === 'routine')
          await until(async () => (await rpc.rpc('routines:list')).runs[routine.id][0].status === 'done', 'routine leaves waiting')
        pass(`${mode}: ${kind} handoff ${decision}`)
      }
    assert.equal(await captureCount(metrics), 0, 'answer-only cards never capture')

    // Concurrent single/group runs on the same agent must hold an entire observation/action sequence.
    const held = join(root, 'held'),
      serialA = join(root, 'serial-a.jsonl'),
      serialB = join(root, 'serial-b.jsonl')
    const one = await rpc.rpc('chats:create', 'researcher', root),
      two = await rpc.rpc('chats:createGroup', ['researcher', 'writer'], root, '')
    await rpc.rpc(
      'chats:send',
      one.id,
      scenario({ log: serialA, steps: [call('observe', {}, 'owned'), { wait: held }, call('release')] }),
      []
    )
    await logResult(serialA, 'owned')
    const groupReceipts = await received(metrics, 'observe')
    await rpc.rpc(
      'chats:send',
      two.id,
      '@researcher ' + scenario({ log: serialB, steps: [call('observe', {}, 'owned'), call('release')] }),
      []
    )
    await until(async () => (await received(metrics, 'observe')) > groupReceipts, 'competing group observe reached private IPC service')
    await assertBlocked(serialB, ['owned'])
    await writeFile(held, 'release')
    await logResult(serialB, 'owned')
    pass(mode + ': same-agent single/group sequence serialization')

    // Two live leases pin the cap; a third profile queues until a slot is released.
    const heldProfiles = []
    for (const agent of ['researcher', 'writer']) {
      const log = join(root, `cap-${agent}.jsonl`),
        c = await rpc.rpc('chats:create', agent, root)
      await rpc.rpc(
        'chats:send',
        c.id,
        scenario({
          log,
          steps: [
            call('navigate', { url: website.url }),
            call('request_user_action', { reason: 'Pin browser capacity' }, 'outcome'),
            call('release')
          ]
        }),
        []
      )
      const card = await handoff(rpc, c.id)
      // Keep handoffs visible without granting manual control or opening another browser.
      const watcher = await connect(h, '/ws/browser')
      const watched = await watcher.request({ op: 'watch', target: { agent, chatId: c.id } })
      heldProfiles.push({ watcher, watched, card, c, agent })
    }
    const thirdLog = join(root, 'cap-third.jsonl'),
      third = await rpc.rpc('chats:create', 'third', root)
    await rpc.rpc('chats:send', third.id, scenario({ log: thirdLog, steps: [call('observe', {}, 'ready'), call('release')] }), [])
    await until(async () => (await rpc.rpc('browsers:status', 'third')).state === 'queued', 'third profile reaches capacity queue')
    assert.equal(
      (await lines(thirdLog)).some((e) => e.name === 'ready'),
      false
    )
    const firstPinned = heldProfiles[0]
    await answer.request({
      op: 'answer',
      target: { agent: firstPinned.agent, chatId: firstPinned.c.id },
      requestId: firstPinned.card.id,
      decision: 'done'
    })
    await firstPinned.watcher.request({ op: 'unwatch', watchId: firstPinned.watched.id })
    firstPinned.watcher.close()
    await logResult(thirdLog, 'ready')
    const remaining = heldProfiles[1]
    await answer.request({
      op: 'answer',
      target: { agent: remaining.agent, chatId: remaining.c.id },
      requestId: remaining.card.id,
      decision: 'cancel'
    })
    await remaining.watcher.request({ op: 'unwatch', watchId: remaining.watched.id })
    remaining.watcher.close()
    pass(mode + ': two-browser cap queues third profile and releases capacity')

    // Pending cards survive reload, become interrupted on restart; website cookies persist.
    const pendingLog = join(root, 'restart.jsonl'),
      pendingChat = await rpc.rpc('chats:create', 'researcher', root)
    await rpc.rpc(
      'chats:send',
      pendingChat.id,
      scenario({
        log: pendingLog,
        steps: [call('navigate', { url: website.url }), call('request_user_action', { reason: 'Restart fixture' })]
      }),
      []
    )
    const old = await handoff(rpc, pendingChat.id)
    await h.restartServer()
    rpc.close()
    answer.close()
    rpc = await connect(h)
    answer = await connect(h, '/ws/browser')
    await handoff(rpc, pendingChat.id, 'interrupted')
    await assert.rejects(
      answer.request({ op: 'answer', target: { agent: 'researcher', chatId: pendingChat.id }, requestId: old.id, decision: 'done' })
    )
    for (const agent of ['researcher', 'writer']) {
      const l = join(root, `${agent}-restart-cookie.jsonl`),
        c = await rpc.rpc('chats:create', agent, root)
      await rpc.rpc(
        'chats:send',
        c.id,
        scenario({ log: l, steps: [call('navigate', { url: website.url }), call('observe', {}, 'cookie'), call('release')] }),
        []
      )
      const value = (await logResult(l, 'cookie')).result.data.text
      assert.equal(value.includes('fixture=persisted'), agent === 'researcher')
    }
    pass(mode + ': server restart interrupts old card / persists cookies / isolates second agent')

    // Last hidden panel drops capture/control; reconnect starts read-only.
    await openChat(h, chat)
    if (!(await h.page.getByTestId('side-menu').isVisible())) await h.page.getByTestId('side-panel-toggle').click()
    await h.page.getByTestId('side-open-browser').click()
    await until(() => captureCount(metrics).then((n) => n === 1), 'reopened viewer capture')
    await h.page.getByRole('switch', { name: 'Take control' }).check()
    await h.page.getByText('You have control', { exact: true }).waitFor()
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await until(() => captureCount(metrics).then((n) => n === 0), 'hidden last watcher stops capture')
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await h.page.getByRole('switch', { name: 'Take control' }).waitFor()
    assert.equal(await h.page.getByRole('switch', { name: 'Take control' }).isChecked(), false)
    await h.page.getByRole('button', { name: 'Close browser', exact: true }).click()
    pass(mode + ': hidden panel releases capture and control; resumed viewer is read-only')

    // Auth sign-out revokes a controlling browser socket, including a pending handoff.
    if (mode === 'vps') {
      const l = join(root, 'signout.jsonl'),
        c = await rpc.rpc('chats:create', 'researcher', root)
      await rpc.rpc(
        'chats:send',
        c.id,
        scenario({ log: l, steps: [call('navigate', { url: website.url }), call('request_user_action', { reason: 'Signout fixture' })] }),
        []
      )
      await handoff(rpc, c.id)
      const controlled = await connect(h, '/ws/browser'),
        watched = await controlled.request({ op: 'watch', target: { agent: 'researcher', chatId: c.id } })
      const s = await until(
        () => controlled.wire.filter((m) => m.type === 'status' && m.status.state === 'ready').at(-1)?.status,
        'auth viewer ready'
      )
      await controlled.request({ op: 'takeControl', watchId: watched.id, generation: s.generation, tabId: s.activeTabId })
      const closed = new Promise((resolve) => controlled.ws.once('close', resolve))
      const response = await h.context.request.post(h.origin + '/api/logout', { headers: { Origin: h.origin } })
      assert.ok(response.status() < 400)
      assert.equal(await closed, 4401)
      await until(() => captureCount(metrics).then((n) => n === 0), 'signout stops capture')
      await until(
        async () => (await resources(metrics)).processes === 0,
        'signout leaves no browser after unattended expiry and idle cleanup'
      )
      pass(mode + ': signout revokes control/capture; unattended handoff expires and Chromium returns to zero')
      // Restore the synthetic session after the sign-out check.
      await signIn(h.page, h.origin, h.creds)
      await h.page.waitForURL(h.origin + '/')
    }
    // Keep an explicit viewer alive: closed panels no longer leave a warm browser.
    const fresh = await connect(h, '/ws/browser')
    await fresh.request({ op: 'watch', target: { agent: 'researcher', chatId: chat.id } })
    rpc.close()
    answer.close()
    // SIGKILL bypasses graceful manager shutdown: IPC ownership cleanup still frees Chrome.
    const pids = (await lines(metrics)).filter((e) => e.type === 'launch').map((e) => e.pid)
    assert.ok((await resources(metrics)).processes > 0, 'forced-exit check starts with owned Chromium alive')
    const ipcDirs = await ipcDirsOf(h.server.pid)
    assert.equal(ipcDirs.length, 7, 'the server listens in seven IPC folders: ' + ipcDirs.join(', '))
    h.server.kill('SIGKILL')
    await until(async () => (await resources(metrics)).processes === 0, 'forced parent exit cleans browsers', 20000)
    assert.ok(pids.length > 0)
    pass(mode + ': forced parent exit frees owned Chromium')
    const errors = unexpectedErrors(h.errors, [
      /WebSocket connection.*failed/,
      /Failed to load resource.*401/,
      /Failed to load resource.*403/,
      /net::ERR_CONNECTION_REFUSED/
    ])
    assert.deepEqual(errors, [])
    // The killed server never ran close(): the next one's startup sweep removes its IPC folders.
    await h.restartServer()
    for (const dir of ipcDirs) await assert.rejects(access(dir), { code: 'ENOENT' }, dir + ' outlived the forced exit')
    pass(mode + ': next start removes the killed server IPC folders')
    await h.stop()
  }
  const evidence = {
    result: 'PASS',
    checks,
    measurements,
    machine: {
      platform: process.platform,
      kernel: release(),
      architecture: process.arch,
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      ramMiB: totalmem() / 1024 ** 2,
      node: process.version,
      chrome: execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim(),
      playwright: '1.64.1'
    }
  }
  await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ result: 'PASS', checks: checks.length, evidence: join(out, 'evidence.json') }))
} catch (error) {
  for (const h of harnesses) console.error(JSON.stringify({ fixtureErrors: h.errors }))
  for (const root of roots) {
    const { readdir } = await import('node:fs/promises')
    for (const name of (await readdir(root)).filter((n) => n.endsWith('.jsonl'))) {
      const records = await lines(join(root, name))
      console.error(
        JSON.stringify({
          fixture: name,
          records: records
            .filter((r) => r.type !== 'workerRequest')
            .map((r) => ({ name: r.name, type: r.type, ok: r.result?.ok, code: r.result?.code }))
        })
      )
    }
  }
  throw error
} finally {
  for (const h of harnesses) await h.stop()
  for (const root of roots) await rm(root, { recursive: true, force: true })
  await website.close()
}
