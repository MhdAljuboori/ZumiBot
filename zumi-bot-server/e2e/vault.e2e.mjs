// Vault acceptance: the fake browser claude with the real injected bridges, real Chromium and the local fixture site
// (a login on 127.0.0.1; a checkout on localhost whose card form is an iframe on 127.0.0.1, so the hosts differ).
// Every secret here is synthetic. Setup and answers go through raw /ws RPCs, never the UI, so the suite holds
// whatever web build is served (E2E_WEB_DIR, when set, serves another one: a worktree whose web build fails).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { start, totpAt, unexpectedErrors } from './harness.mjs'
import { browserSite } from './fixtures/browser-site.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-browser-claude.mjs', import.meta.url))
const INSTRUMENT = fileURLToPath(new URL('./fixtures/browser-instrumentation.mjs', import.meta.url))
await access(FAKE)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(50)
  }
  throw Error(`Timed out: ${label}`)
}
// A line still being appended does not parse yet: it is read on the next poll.
const parsed = (line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
}
const lines = (path) =>
  readFile(path, 'utf8').then(
    (s) => s.split('\n').flatMap(parsed),
    () => []
  )
const sha = (value) => createHash('sha256').update(value).digest('hex')
function pass(name) {
  console.log(`PASS ${name}`)
}
const scenario = (plan) => `BROWSER_SCENARIO:${Buffer.from(JSON.stringify(plan)).toString('base64')}`
const call = (tool, args = {}, save) => ({ tool: `browser_${tool}`, args, save })
const ref = (observation, name) => ({ $ref: { observation, name } })
const stamp = (observation) => ({ $stamp: observation })
const item = (name) => ({ $item: { list: 'items', name } })
const fill = (observation, field, name, itemName, save) =>
  call('fill_from_vault', { stamp: stamp(observation), ref: ref(observation, field), item: item(itemName), field: name }, save)

// Synthetic secrets. The card is Luhn-valid so the editor and the fill accept it.
function luhn(body) {
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i])
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return body + ((10 - (sum % 10)) % 10)
}
const PASSWORD = 'Vlt-e2e-Pw-q7Z3m9'
const TOTP = 'MZXW6YTBOI2DMNBUGQ3TOOJZGU2DKNJV'
const CARD = luhn('491657201938274'),
  CARD_SPACED = CARD.replace(/(\d{4})(?=\d)/g, '$1 '),
  CVC = '8317',
  EXPIRY = '09/31'
const API_KEY = 'vk-e2e-T0kenValue-Zq81x93fJ',
  ENV = 'VAULT_E2E_TOKEN',
  KEY_NAME = 'Deploy token'
assert.notEqual(CARD.slice(-4), CVC)

// Literal secrets anywhere; the short numeric ones only as a token of their own, after ids and hashes are blanked
// (a UUID group or a hex run can hold any four or six digits).
const literal = [
  ['password', PASSWORD],
  ['card number', CARD],
  ['spaced card number', CARD_SPACED],
  ['dashed card number', CARD_SPACED.replaceAll(' ', '-')],
  ['API key', API_KEY],
  ['2FA secret', TOTP]
]
const codes = new Set()
function leaks(text) {
  const found = literal.filter(([, v]) => text.includes(v)).map(([k]) => k)
  const plain = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U').replace(/[0-9a-f]{32,}/gi, 'H')
  for (const [label, token] of [['CVC', CVC], ...[...codes].map((c) => ['2FA code', c])]) {
    if (new RegExp(`(?<![0-9A-Za-z])${token}(?![0-9A-Za-z])`).test(plain)) found.push(label)
  }
  return found
}
async function filesUnder(dir, skip) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (skip(path)) continue
    if (entry.isDirectory()) out.push(...(await filesUnder(path, skip)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

async function connect(h) {
  const cookie = (await h.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  const ws = new WebSocket(h.origin.replace('http', 'ws') + '/ws', { headers: { Origin: h.origin, Cookie: cookie } })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let id = 0
  const pending = new Map(),
    wire = []
  ws.on('message', (raw) => {
    wire.push(String(raw))
    const value = JSON.parse(String(raw))
    if (pending.has(value.id)) {
      pending.get(value.id)(value)
      pending.delete(value.id)
    }
  })
  ws.on('error', () => {})
  const send = (method, args) => {
    const next = ++id
    let timer
    const result = new Promise((resolve, reject) => {
      pending.set(next, resolve)
      timer = setTimeout(() => reject(Error(`Socket timeout ${method}`)), 20000)
    })
    ws.send(JSON.stringify({ id: next, method, args }))
    return result.finally(() => clearTimeout(timer))
  }
  return {
    wire,
    // Answers the RPC's value, or throws its error. A send answers only when its turn ends, so it is not awaited.
    async rpc(method, ...args) {
      if (method === 'chats:send') {
        ws.send(JSON.stringify({ id: ++id, method, args }))
        return
      }
      const response = await send(method, args)
      if (!response.ok) throw Error(`${method}: ${JSON.stringify(response.error ?? response)}`)
      return response.value
    },
    async refused(method, ...args) {
      const response = await send(method, args)
      assert.equal(response.ok, false, `${method} was accepted`)
      return response
    },
    close() {
      ws.close()
    }
  }
}

const website = await browserSite()
const root = await mkdtemp(join(tmpdir(), 'cb-vault-acceptance-'))
let h = null
try {
  const agentsDir = join(root, 'agents'),
    metrics = join(root, 'metrics.jsonl'),
    inspectFile = join(root, 'inspect.json')
  const log = join(root, 'main.jsonl'),
    results = join(root, 'results.jsonl')
  await mkdir(agentsDir)
  for (const name of ['operator', 'outsider'])
    await writeFile(
      join(agentsDir, name + '.md'),
      `---\nname: ${name}\ndescription: Synthetic vault acceptance\n---\nUse the vault fixture.`
    )
  h = await start({
    mode: 'local',
    fake: FAKE,
    agentsDir,
    env: {
      BROWSER_E2E_METRICS: metrics,
      BROWSER_E2E_INSPECT: inspectFile,
      NODE_OPTIONS: `--import=${INSTRUMENT}`,
      ZUMIBOT_BROWSER_LEASE_IDLE_MS: '60000',
      ...(process.env.E2E_WEB_DIR ? { ZUMIBOT_WEB_DIR: process.env.E2E_WEB_DIR } : {})
    }
  })
  const rpc = await connect(h)
  const keyFile = join(h.root, 'vault-key', 'vault.key')

  // The agent browser, seen through the suite's own instrumentation: each field's value hash, length and mask. Each
  // worker counts its answers from 1, so an answer counts only from the worker asked (the latest launched) and past its
  // own last one; a worker that is gone fails at once, naming why, rather than timing out.
  const gone = (pid) => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }
  async function inspect() {
    const pid = (await lines(metrics)).filter((e) => e.type === 'launch').at(-1)?.pid
    assert.ok(pid, 'agent browser launched')
    const last = await readFile(inspectFile, 'utf8').then(JSON.parse, () => null)
    const after = last?.pid === pid ? last.seq : 0
    const replaced = `the agent browser worker ${pid} is gone, so the page could not be inspected: it was closed or replaced mid-suite`
    try {
      process.kill(pid, 'SIGUSR2')
    } catch {
      assert.fail(replaced)
    }
    return until(async () => {
      const v = await readFile(inspectFile, 'utf8').then(JSON.parse, () => null)
      if (v?.pid === pid && v.seq > after) return v
      if (gone(pid)) assert.fail(replaced)
      return null
    }, `page inspection by worker ${pid}`)
  }
  const fieldOf = (snapshot, url, label) => {
    const field = snapshot.pages
      .flatMap((p) => p.frames)
      .filter((f) => f.url === url)
      .flatMap((f) => f.fields ?? [])
      .find((f) => f.label === label)
    assert.ok(field, `field ${label} on ${url}`)
    return field
  }
  const logResult = (name) => until(async () => (await lines(log)).find((e) => e.name === name)?.result, `fake result ${name}`)
  const items = async (chatId) => (await rpc.rpc('chats:items', chatId)).items
  const cards = async (chatId) => (await items(chatId)).filter((i) => i.type === 'vault-approval')
  const gate = (name) => {
    const path = join(root, name)
    return { step: { wait: path }, open: () => writeFile(path, 'go') }
  }

  // Setup over raw RPCs, as the Vault page would save.
  assert.equal(await rpc.rpc('vault:status'), 'empty')
  await assert.rejects(access(keyFile), 'no key before the first save')
  const login = await rpc.rpc('vault:save', {
    kind: 'login',
    name: 'Fixture login',
    agents: ['operator'],
    sites: ['127.0.0.1'],
    username: 'fixture-user',
    password: PASSWORD,
    totp: TOTP
  })
  const card = await rpc.rpc('vault:save', {
    kind: 'card',
    name: 'Fixture Visa',
    agents: ['operator'],
    holder: 'Fixture Holder',
    number: CARD_SPACED,
    expiry: EXPIRY,
    cvc: CVC
  })
  await rpc.rpc('vault:save', {
    kind: 'apiKey',
    name: KEY_NAME,
    agents: ['operator'],
    env: ENV,
    value: API_KEY,
    description: 'Synthetic deploy token'
  })
  await rpc.refused('vault:save', {
    kind: 'apiKey',
    name: 'Bot key',
    agents: ['zumi-bot'],
    env: 'BOT_KEY',
    value: 'bot-key-value-1',
    description: ''
  })
  assert.equal(await rpc.rpc('vault:status'), 'ready')
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
  assert.equal((await stat(join(h.root, 'vault-key'))).mode & 0o777, 0o700)
  const sealed = await readFile(join(h.dataDir, 'vault.json'), 'utf8')
  assert.equal(sealed.includes('Fixture login'), false, 'item names are sealed too')
  assert.deepEqual(leaks(JSON.stringify(await rpc.rpc('vault:list'))), [])
  pass(
    'items saved over RPC; key made at the first save, under the harness root, 0600 in a 0700 folder; vault.json and vault:list hold no secret'
  )

  const chat = await rpc.rpc('chats:create', 'operator', root)
  const [g1, g2, g3, g4] = ['g1', 'g2', 'g3', 'g4'].map(gate)
  // The login page echoes the typed password into its text, so the observe after the fill would hold it unscrubbed.
  const loginUrl = `${website.url}/login?echo=1`,
    wrongUrl = `${website.hostUrl}/login`
  const checkoutUrl = `${website.hostUrl}/checkout?frame=${website.url}`,
    frameUrl = `${website.url}/card-frame`
  const startedAt = Date.now()
  await rpc.rpc(
    'chats:send',
    chat.id,
    scenario({
      log,
      results,
      rows: true,
      steps: [
        { tool: 'vault_items', server: 'zumibot_vault', save: 'items' },
        call('navigate', { url: loginUrl }),
        call('observe', {}, 'login'),
        fill('login', 'Username', 'username', 'Fixture login', 'fillUser'),
        fill('login', 'Password', 'password', 'Fixture login', 'fillPassword'),
        fill('login', 'Nickname', 'code', 'Fixture login', 'fillCode'),
        call('observe', {}, 'afterLogin'),
        g1.step,
        call('navigate', { url: wrongUrl }),
        call('observe', {}, 'wrongLogin'),
        fill('wrongLogin', 'Password', 'password', 'Fixture login', 'wrongSite'),
        g2.step,
        call('navigate', { url: checkoutUrl }),
        call('observe', {}, 'checkout'),
        fill('checkout', 'Card number', 'number', 'Fixture Visa', 'cardDenied'),
        g3.step,
        fill('checkout', 'Card number', 'number', 'Fixture Visa', 'cardAllowed'),
        fill('checkout', 'Expiry', 'expiry', 'Fixture Visa', 'fillExpiry'),
        fill('checkout', 'CVC', 'cvc', 'Fixture Visa', 'fillCvc'),
        call('observe', {}, 'afterCard'),
        call('screenshot', {}, 'shot'),
        g4.step,
        { bash: { env: ENV }, save: 'bashEnv' },
        { say: { env: ENV } },
        call('release', {}, 'released')
      ]
    }),
    []
  )

  const listed = await logResult('items')
  // In the order vault_items gives them: by kind (login, card, contact, apiKey), then by name.
  assert.deepEqual(
    listed.map((i) => `${i.kind} ${i.name}`),
    ['login Fixture login', 'card Fixture Visa', `apiKey ${KEY_NAME}`]
  )
  const listedLogin = listed.find((i) => i.kind === 'login')
  assert.deepEqual(listedLogin, {
    id: login.id,
    kind: 'login',
    name: 'Fixture login',
    sites: ['127.0.0.1'],
    username: 'fixture-user',
    hasCode: true
  })
  assert.deepEqual(
    listed.find((i) => i.kind === 'card'),
    { id: card.id, kind: 'card', name: 'Fixture Visa', label: `Visa •${CARD.slice(-4)}`, holder: 'Fixture Holder' }
  )
  assert.equal(listed.find((i) => i.kind === 'apiKey').env, ENV)
  assert.deepEqual(leaks(JSON.stringify(listed)), [])
  pass('vault_items lists the granted login, card and API key, by kind then name, with no password, code, card number or key value')

  for (const name of ['fillUser', 'fillPassword', 'fillCode']) {
    const r = await logResult(name)
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`)
    assert.equal(r.data.filled, true)
    assert.equal(r.data.item, 'Fixture login')
  }
  await until(async () => (await lines(log)).some((e) => e.name === 'afterLogin'), 'observe after the login fill')
  for (let t = startedAt - 60_000; t <= Date.now() + 60_000; t += 30_000) codes.add(totpAt(TOTP, t))
  const loginPage = await inspect()
  const password = fieldOf(loginPage, loginUrl, 'Password'),
    nickname = fieldOf(loginPage, loginUrl, 'Nickname')
  assert.equal(password.sha256, sha(PASSWORD), 'the page field holds the password')
  assert.equal(password.mask, 'disc')
  assert.equal(fieldOf(loginPage, loginUrl, 'Username').sha256, sha('fixture-user'))
  assert.ok(
    [...codes].some((c) => sha(c) === nickname.sha256),
    'the code field holds a current 2FA code'
  )
  assert.equal(nickname.mask, 'disc', 'a secret in a plain text field is masked')
  const afterLogin = await logResult('afterLogin')
  assert.match(afterLogin.data.text, /Typed \[hidden by vault\]/, 'the page echo of the password reaches the agent scrubbed')
  assert.deepEqual(leaks(JSON.stringify(afterLogin)), [])
  await g1.open()
  pass(
    'a granted login fills /login: the page holds the password and a 2FA code, both masked; the next observe holds neither, though the page echoes the password'
  )

  const wrong = await logResult('wrongSite')
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, 'wrong_site')
  assert.match(wrong.message, /127\.0\.0\.1/)
  assert.equal(fieldOf(await inspect(), wrongUrl, 'Password').length, 0, 'nothing typed on the other host')
  await g2.open()
  pass('the same login on a host not in its sites fails wrong_site, naming the saved sites, and types nothing')

  const first = await until(async () => (await cards(chat.id)).find((c) => c.request.status === 'pending'), 'first vault approval card')
  assert.equal(first.agent, 'operator')
  assert.deepEqual(
    { site: first.request.site, frameSite: first.request.frameSite, itemName: first.request.itemName, label: first.request.label },
    { site: 'localhost', frameSite: '127.0.0.1', itemName: 'Fixture Visa', label: `Visa •${CARD.slice(-4)}` }
  )
  // It waits like an approval card: the badge, notifications and routine waiting all read this push.
  await until(
    () => rpc.wire.some((m) => m.includes('"kind":"approvals"') && m.includes(chat.id) && /"pending":1\b/.test(m)),
    'the card counts as pending'
  )
  await rpc.rpc('vault:answer', chat.id, first.id, 'deny')
  const denied = await logResult('cardDenied')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'denied')
  assert.equal((await cards(chat.id)).find((c) => c.id === first.id).request.status, 'denied')
  assert.equal(fieldOf(await inspect(), frameUrl, 'Card number').length, 0, 'Deny types nothing')
  assert.deepEqual((await rpc.rpc('vault:list')).find((i) => i.id === card.id).approved, [])
  await g3.open()
  pass(
    'the checkout card fill shows a vault-approval card naming both hosts, counted as pending; Deny fails denied, types nothing, remembers nothing'
  )

  const second = await until(
    async () => (await cards(chat.id)).find((c) => c.request.status === 'pending' && c.id !== first.id),
    'second vault approval card'
  )
  await rpc.refused('vault:answer', chat.id, first.id, 'allow')
  await rpc.rpc('vault:answer', chat.id, second.id, 'allow')
  const allowed = await logResult('cardAllowed')
  assert.equal(allowed.ok, true, JSON.stringify(allowed))
  assert.equal(allowed.data.filled, true)
  const approved = (await rpc.rpc('vault:list')).find((i) => i.id === card.id).approved
  assert.deepEqual(
    approved.map((a) => [a.site, a.frameSite]),
    [['localhost', '127.0.0.1']]
  )
  for (const name of ['fillExpiry', 'fillCvc']) assert.equal((await logResult(name)).ok, true, name)
  const all = await cards(chat.id)
  assert.equal(all.length, 2, 'the third fill on an approved pair needs no card')
  assert.equal(all.find((c) => c.id === second.id).request.status, 'allowed')
  pass("Allow fills and lists the pair under the card's approved sites; later fills there need no card")

  const afterCard = await logResult('afterCard')
  const echo = afterCard.data.elements.find((e) => e.name === 'Echo')
  assert.equal(echo.frame, '127.0.0.1')
  assert.equal(echo.text, 'Typed [hidden by vault]', 'a page echoing the card number reaches the agent scrubbed')
  assert.deepEqual(leaks(JSON.stringify(afterCard)), [])
  const shot = await logResult('shot')
  assert.equal(shot.ok, true)
  assert.ok(shot.image.length > 0, 'the screenshot came back')
  const cardPage = await inspect()
  for (const [label, value] of [
    ['Card number', CARD],
    ['Expiry', EXPIRY],
    ['CVC', CVC]
  ]) {
    const field = fieldOf(cardPage, frameUrl, label)
    assert.equal(field.sha256, sha(value), `${label} holds its value`)
    assert.equal(field.mask, 'disc', `${label} is masked for screenshots`)
  }
  await g4.open()
  pass('after the card fills a screenshot succeeds and the card fields compute -webkit-text-security: disc; the page echo is scrubbed')

  const env = await logResult('bashEnv')
  assert.deepEqual(env, { present: true, sha256: sha(API_KEY), length: API_KEY.length })
  assert.equal((await logResult('released')).ok, true)
  await until(async () => (await rpc.rpc('chats:list')).find((c) => c.id === chat.id && !c.inFlight), 'the turn ends')
  const tag = `[vault: ${KEY_NAME}]`
  const stored = await readFile(join(h.dataDir, 'chats', `${chat.id}.json`), 'utf8')
  const bash = (await items(chat.id)).find((i) => i.type === 'tool' && i.name === 'Bash')
  assert.ok(bash, 'the Bash row is stored')
  assert.ok(JSON.stringify(bash).includes(tag), `the Bash result reads ${tag}`)
  assert.ok(
    (await items(chat.id)).some((i) => i.type === 'assistant' && i.text.includes(`The value is ${tag}.`)),
    'the reply text is scrubbed, split deltas included'
  )
  assert.ok(stored.includes(tag), 'the stored chat JSON holds the tag')
  assert.ok(
    rpc.wire.some((m) => m.includes('chats:push') && m.includes(tag)),
    'the items feed carries the tag'
  )
  pass(`a granted API key reaches the fake's Bash env; the stored chat and the items feed hold ${tag}, never the value`)

  // A run that dies with the value in its stderr: the stored error is scrubbed too.
  await rpc.rpc('chats:send', chat.id, scenario({ log, steps: [{ fail: { env: ENV } }] }), [])
  await until(
    async () => (await items(chat.id)).some((i) => i.type === 'error' && JSON.stringify(i).includes(`fixture stops with ${tag}`)),
    'scrubbed stderr error'
  )
  pass('a run ending with the key in its stderr stores the error scrubbed')

  const other = await rpc.rpc('chats:create', 'outsider', root)
  await rpc.rpc(
    'chats:send',
    other.id,
    scenario({
      log,
      steps: [
        { tool: 'vault_items', server: 'zumibot_vault', save: 'outsiderItems' },
        { bash: { env: ENV }, save: 'outsiderEnv' }
      ]
    }),
    []
  )
  assert.deepEqual(await logResult('outsiderItems'), [])
  assert.equal((await logResult('outsiderEnv')).present, false)
  pass('an agent with no grants lists nothing and gets no key in its env')

  await until(async () => (await rpc.rpc('chats:list')).every((c) => !c.inFlight), 'every run ends')
  for (let t = startedAt - 60_000; t <= Date.now() + 60_000; t += 30_000) codes.add(totpAt(TOTP, t))
  // The Chrome profile is the agent browser's own storage, like any browser's, and is left out (see the NOTE below).
  const profiles = join(h.dataDir, 'browsers')
  const dataFiles = await filesUnder(h.dataDir, (p) => p === profiles)
  assert.ok(dataFiles.some((f) => f.endsWith(`${chat.id}.json`)))
  const scanned = [
    ...(await Promise.all(dataFiles.map(async (f) => [`data/${relative(h.dataDir, f)}`, await readFile(f, 'latin1')]))),
    ['server log', [...h.output, ...h.errors].join('\n')],
    ['tool results the fake received', await readFile(results, 'utf8')],
    ['fake step log', await readFile(log, 'utf8')],
    ['items feed and RPC answers', rpc.wire.join('\n')]
  ]
  const found = scanned.flatMap(([where, text]) => leaks(text).map((what) => `${what} in ${where}`))
  assert.deepEqual(found, [])
  pass(
    `no password, card number, CVC, 2FA code or API key value in ${dataFiles.length} data files (chats/*.json included), the server log, the items feed or any tool result the fake received`
  )
  const inProfile = (await Promise.all((await filesUnder(profiles, () => false)).map((f) => readFile(f, 'latin1')))).filter(
    (t) => leaks(t).length > 0
  ).length
  console.log(`NOTE agent Chrome profile files holding a filled value (Chrome's own form/session storage, not ZumiBot's): ${inProfile}`)

  // Audit tools on the style fixture (after the leak scan above, which would read PNG bytes as text). Saved screenshots stay
  // on disk under the chat's folder: the agent gets a path and sizes, never the bytes.
  const shotsRoot = join(h.dataDir, 'browser-shots'),
    auditLog = join(root, 'audit.jsonl'),
    auditResults = join(root, 'audit-results.jsonl')
  const auditChat = await rpc.rpc('chats:create', 'operator', root),
    keepChat = await rpc.rpc('chats:create', 'operator', root)
  const styleUrl = `${website.url}/style`
  await rpc.rpc(
    'chats:send',
    auditChat.id,
    scenario({
      log: auditLog,
      results: auditResults,
      steps: [
        call('set_viewport', { width: 1000, height: 700 }, 'viewport'),
        call('navigate', { url: styleUrl }),
        call('observe', {}, 'style'),
        call('hover', { stamp: stamp('style'), ref: ref('style', 'Hover me') }, 'hover'),
        call('computed_style', { stamp: stamp('style'), ref: ref('style', 'Hover me') }, 'computed'),
        call('save_screenshot', { name: 'e2e-hover', stamp: stamp('style'), ref: ref('style', 'Hover me') }, 'shotElement'),
        call('save_screenshot', { name: 'e2e-page', fullPage: true }, 'shotPage'),
        call('release', {}, 'auditReleased')
      ]
    }),
    []
  )
  const auditResult = async (name) =>
    (await until(async () => (await lines(auditLog)).find((e) => e.name === name), `audit result ${name}`)).result
  const okResult = async (name) => {
    const r = await auditResult(name)
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`)
    return r
  }
  assert.deepEqual((await okResult('viewport')).data, { width: 1000, height: 700 })
  assert.equal((await okResult('hover')).data.hovered, true)
  const computed = (await okResult('computed')).data
  assert.equal(computed.style['background-color'], 'rgb(255, 0, 0)', 'the :hover colour shows, so the hover reached the page')
  assert.ok(computed.rect.width > 0 && computed.rect.height > 0, 'the element has a box')
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const chatShots = join(shotsRoot, auditChat.id)
  for (const [name, shotName] of [
    ['shotElement', 'e2e-hover'],
    ['shotPage', 'e2e-page']
  ]) {
    const saved = (await okResult(name)).data
    assert.equal(saved.name, shotName)
    assert.ok(saved.path.startsWith(chatShots + '/'), `${name} is under browser-shots/<chatId>: ${saved.path}`)
    const bytes = await readFile(saved.path)
    assert.ok(bytes.subarray(0, 4).equals(pngSignature), `${name} is a PNG`)
    assert.equal(bytes.length, saved.bytes, `${name} reports its size`)
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600)
    assert.ok(saved.width > 0 && saved.height > 0)
  }
  const elementShot = (await okResult('shotElement')).data,
    pageShot = (await okResult('shotPage')).data
  assert.ok(elementShot.width < 1000 && elementShot.height < 700, 'the element shot is the element, not the page')
  assert.ok(pageShot.height > 700, 'fullPage is taller than the 700 pixel viewport')
  assert.equal((await stat(chatShots)).mode & 0o777, 0o700)
  await until(async () => (await rpc.rpc('chats:list')).find((c) => c.id === auditChat.id && !c.inFlight), 'the audit turn ends')
  // A second chat keeps a shot of its own, to survive the first one's deletion.
  await rpc.rpc(
    'chats:send',
    keepChat.id,
    scenario({
      log: auditLog,
      results: auditResults,
      steps: [call('navigate', { url: styleUrl }), call('save_screenshot', { name: 'e2e-keep' }, 'shotKeep'), call('release')]
    }),
    []
  )
  const keepShot = (await okResult('shotKeep')).data
  assert.ok(keepShot.path.startsWith(join(shotsRoot, keepChat.id) + '/'))
  await until(async () => (await rpc.rpc('chats:list')).find((c) => c.id === keepChat.id && !c.inFlight), 'the second audit turn ends')
  const received = (await lines(auditResults)).filter((e) => e.server === 'zumibot_browser')
  assert.ok(received.length >= 8, `the fake received every result (${received.length})`)
  assert.ok(
    received.every((e) => !(e.text ?? '').includes('base64') && !e.image),
    'no tool result holds image bytes'
  )
  // The save results are among those checked: each reached the fake as text with its path.
  for (const shotName of ['e2e-hover', 'e2e-page', 'e2e-keep']) {
    assert.ok(
      received.some(
        (e) => e.tool === 'browser_save_screenshot' && (e.text ?? '').includes(`"name":"${shotName}"`) && e.text.includes('"path"')
      ),
      `${shotName} reached the fake with its path`
    )
  }
  assert.deepEqual(
    leaks(`${await readFile(auditResults, 'utf8')}${await readFile(auditLog, 'utf8')}`),
    [],
    'no vault secret in any audit result'
  )
  await rpc.rpc('chats:remove', auditChat.id)
  await until(
    () =>
      access(chatShots).then(
        () => false,
        () => true
      ),
    "the deleted chat's screenshots are removed"
  )
  assert.ok((await readFile(keepShot.path)).subarray(0, 4).equals(pngSignature), "another chat's shot survives")
  pass(
    'audit tools: set_viewport, hover, computed_style (the :hover colour) and save_screenshot (element and fullPage) return paths, never bytes; PNGs are 0600 under browser-shots/<chatId>; deleting the chat removes its folder only'
  )

  const errors = unexpectedErrors(h.errors, [/WebSocket connection.*failed/, /Failed to load resource/, /net::ERR_CONNECTION_REFUSED/])
  assert.deepEqual(errors, [])
  rpc.close()
  console.log(JSON.stringify({ result: 'PASS', suite: 'vault' }))
} catch (error) {
  if (h) console.error(JSON.stringify({ fixtureErrors: h.errors }))
  for (const name of ['main.jsonl']) {
    const records = await lines(join(root, name))
    console.error(
      JSON.stringify({ fixture: name, records: records.map((r) => ({ name: r.name, ok: r.result?.ok, code: r.result?.code })) })
    )
  }
  throw error
} finally {
  await h?.stop()
  await rm(root, { recursive: true, force: true })
  await website.close()
}
