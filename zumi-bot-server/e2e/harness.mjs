// Shared e2e harness: spawns the built server, drives it with the system Chrome (headless).
// fake:false runs the real claude with the real HOME; fake:true uses the fake claude and a temp HOME.
// fakeCodex (true, or a fixture path) puts a `codex` shim beside it running fake-codex.mjs (or that fixture), found through ZUMIBOT_CODEX_BIN,
// with its script, request log, answers file and thread home under the temp root (`codex`); without it a Codex agent runs
// whatever `codex` the PATH holds, with the real HOME's login when fake is false.
// setup:false (vps only) leaves the data dir with no password or 2FA, so the server serves the first-run setup
// wizard instead; `creds` is then null and `setupCode` holds the one-time code the server printed.
// fakeAcp (true, or a fixture path) writes an executable shim (`acp.bin`) running fake-acp-agent.mjs (or that fixture), for a
// suite to type as an ACP agent's Command in Agent Studio (an ACP agent's command lives in its own file, so nothing finds it by
// name). The fake's script (`acp.script`, a JSON file read when each process starts), message log, pids and start logs are under
// the temp root (`acp`); the server env carries their FAKE_ACP_* names, which the runner passes on (it strips only ZUMIBOT_*).
// fakeAgui (true, or a fixture path) starts fake-agui-server.mjs (or that fixture) as a child on 127.0.0.1 and turns on the
// AG-UI dev hook (ZUMIBOT_AGUI_ALLOW_LOCAL=1, so a remote agent may reach a loopback http endpoint). `agui` holds its
// `url` (`http://127.0.0.1:<port>/run`), its `script` (a JSON file read for each request) and its request `log`, plus its `pid`;
// stop() ends it.
// start() returns { page, browser, context, origin, server, errors, output, newPage, newContext, restartServer, stop, creds, setupCode, waitForOutput, script, codex, acp, agui, root }.
// connectors seeds <dataDir>/connectors.json (0600) before the server starts, unless the file exists, so no other suite runs the first-start
// switch-over (a probe of the home folder): the default is "migrated, every connector off for every agent"; null writes nothing.
// chromeArgs go to Chrome's command line (the voice suite's fake mic); newContext(options) opens another signed-in context.
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = fileURLToPath(new URL('.', import.meta.url))
export const SERVER = join(here, '..', 'backend', 'dist', 'server.mjs')
const FAKE = join(here, '..', 'backend', 'tests', 'fixtures', 'fake-claude.mjs')
const BASIC = join(here, '..', 'backend', 'tests', 'fixtures', 'stream', 'basic.jsonl')
const FAKE_CODEX = join(here, '..', 'backend', 'tests', 'fixtures', 'fake-codex.mjs')
const FAKE_ACP = join(here, '..', 'backend', 'tests', 'fixtures', 'fake-acp-agent.mjs')
const FAKE_AGUI = join(here, '..', 'backend', 'tests', 'fixtures', 'fake-agui-server.mjs')

// unref'd: a race loser's timer must not keep the process alive after stop()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref())

// The developer's own ZUMIBOT_* variables (a stray test hook, a secret) must not leak into the server under test.
const inheritedEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ZUMIBOT_')))

/**
 * Picks an option of a SearchSelect (the app's dropdown in place of a native select), as `selectOption` did: `want` is
 * the option's value, or `{ label }` for its text. Opens it with a click, then clicks the option in its menu.
 */
export async function pickOption(select, want) {
  await select.click()
  const menu = select.page().locator('.search-select-menu')
  const option =
    typeof want === 'string'
      ? menu.locator(`[data-testid="select-option"][data-value="${want.replace(/["\\]/g, '\\$&')}"]`)
      : menu.getByRole('option', { name: want.label, exact: true })
  await option.click()
}

/** A SearchSelect's current value, as `inputValue()` read a native select's. */
export const selectValue = (select) => select.getAttribute('data-value')

/** The labels of a SearchSelect's options; it opens the menu and closes it again with Esc. */
export async function optionLabels(select) {
  await select.click()
  const labels = await select.page().locator('.search-select-menu [data-testid="select-option"]').allTextContents()
  await select.page().keyboard.press('Escape')
  return labels
}

/** Errors not matched by the allow-list (regexes); suites fail on any other console or server error. */
export const unexpectedErrors = (errors, allow) => errors.filter((e) => !allow.some((re) => re.test(e)))

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// RFC 6238, SHA-1, 30 s, 6 digits (same as backend/src/auth/totp.ts).
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out = []
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  return Buffer.from(out)
}

export function totpAt(secret, timeMs) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)))
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest()
  const off = h[h.length - 1] & 15
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

// Runs a CLI subcommand with piped stdin; `onOut` may answer prompts as output arrives.
function runCli(args, env, input, onOut) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    // A changed prompt would otherwise hang here with the CLI child alive
    const timer = setTimeout(() => {
      p.kill('SIGKILL')
      reject(new Error(`${args[0]} did not finish in 15 s`))
    }, 15_000)
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
      onOut?.(out, p)
    })
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (clearTimeout(timer), code === 0 ? resolve(out) : reject(new Error(`${args[0]} exited ${code}: ${err}`))))
    if (input !== undefined) p.stdin.end(input)
  })
}

async function setupAuth(env) {
  const password = `pw-${randomBytes(9).toString('hex')}`
  await runCli(['set-password'], env, `${password}\n${password}\n`)
  let secret = null
  let sent = false
  // The setup code is for the previous 30 s step, so the first sign-in (current step) is not a replay of it.
  await runCli(['setup-2fa'], env, undefined, (out, p) => {
    const m = /secret=([A-Z2-7]+)/.exec(out)
    if (m && !sent && out.includes('Enter the 6-digit code')) {
      secret = m[1]
      sent = true
      p.stdin.write(`${totpAt(secret, Date.now() - 30_000)}\n`)
      p.stdin.end()
    }
  })
  if (!secret) throw new Error('setup-2fa printed no secret')
  let lastStep = Math.floor(Date.now() / 30_000) - 1
  return {
    password,
    secret,
    // A code that works once: the next step after the last one handed out (the server accepts +-1 step).
    nextCode() {
      const cur = Math.floor(Date.now() / 30_000)
      lastStep = Math.max(lastStep + 1, cur)
      if (lastStep > cur + 1) throw new Error('no unused TOTP step left; wait for the next 30 s step')
      return totpAt(secret, lastStep * 30_000)
    }
  }
}

export async function signIn(page, origin, creds, code = creds.nextCode()) {
  await page.goto(`${origin}/login`)
  await page.fill('#password', creds.password)
  await page.fill('#code', code)
  await page.click('#submit')
}

// The fake AG-UI server: it prints its port first, and exits on SIGTERM or when its stdin (this process) closes.
function startFakeAgui(fixture, script, log) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [fixture], {
      env: { ...inheritedEnv(), FAKE_AGUI_SCRIPT: script, FAKE_AGUI_LOG: log },
      stdio: ['pipe', 'pipe', 'inherit']
    })
    let out = ''
    const timer = setTimeout(() => (p.kill('SIGKILL'), reject(new Error('the fake AG-UI server did not print its port in 10 s'))), 10_000)
    p.stdout.on('data', (d) => {
      out += d
      const m = /FAKE_AGUI_PORT=(\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ child: p, port: Number(m[1]) })
      }
    })
    p.once('error', (e) => (clearTimeout(timer), reject(e)))
    p.once('exit', (code, sig) => (clearTimeout(timer), reject(new Error(`the fake AG-UI server exited early (${code ?? sig})`))))
  })
}

async function stopChild(p, graceMs) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return
  p.removeAllListeners('exit')
  const exited = new Promise((r) => p.once('exit', r))
  p.kill('SIGTERM')
  await Promise.race([exited, sleep(graceMs)])
  if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
}

export async function start({
  mode = 'local',
  dataDir,
  agentsDir,
  env = {},
  fake = false,
  fakeCodex = false,
  fakeAcp = false,
  fakeAgui = false,
  setup = true,
  signIn: doSignIn = true,
  chromeArgs = [],
  connectors = { v: 1, agents: {}, migration: 'kept' }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cb-e2e-'))
  const errors = []
  // Everything the server printed to stdout, across restarts (suites check no secret reached the log).
  const output = []
  let browser = null
  let child = null
  let aguiChild = null
  let stopped = false
  const exitLog = []
  try {
    dataDir ??= join(root, 'data')
    agentsDir ??= join(root, 'agents')
    const home = join(root, 'home')
    for (const d of [dataDir, agentsDir, home]) await mkdir(d, { recursive: true })
    if (connectors !== null) {
      // 'wx': an existing file (a suite's own seed) is left alone
      await writeFile(join(dataDir, 'connectors.json'), JSON.stringify(connectors, null, 2), { mode: 0o600, flag: 'wx' }).catch((e) => {
        if (e.code !== 'EEXIST') throw e
      })
    }
    const script = join(root, 'script.jsonl')
    const fakeEnv = {}
    if (fake) {
      // A named fixture can exercise real CLI plumbing while preserving temp HOME/auth.
      await writeFile(join(root, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${typeof fake === 'string' ? fake : FAKE}" "$@"\n`)
      await chmod(join(root, 'claude'), 0o755)
      // Merged, so a seeded settings.json (a theme) survives
      const prior = await readFile(join(dataDir, 'settings.json'), 'utf8').then(JSON.parse, () => ({}))
      await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ ...prior, claudePath: join(root, 'claude') }))
      await copyFile(BASIC, script)
      fakeEnv.FAKE_STDOUT_FILE = script
    }
    let codex = null
    if (fakeCodex) {
      codex = {
        bin: join(root, 'codex'),
        script: join(root, 'codex-script.jsonl'),
        log: join(root, 'codex-log.jsonl'),
        answers: join(root, 'codex-answers.jsonl'),
        home: join(root, 'codex-home')
      }
      await writeFile(codex.bin, `#!/bin/sh\nexec "${process.execPath}" "${typeof fakeCodex === 'string' ? fakeCodex : FAKE_CODEX}" "$@"\n`)
      await chmod(codex.bin, 0o755)
      await mkdir(codex.home, { recursive: true })
      await writeFile(codex.script, '')
      Object.assign(fakeEnv, {
        ZUMIBOT_CODEX_BIN: codex.bin,
        FAKE_CODEX_SCRIPT: codex.script,
        FAKE_CODEX_LOG: codex.log,
        FAKE_CODEX_ANSWERS: codex.answers,
        FAKE_CODEX_HOME: codex.home
      })
    }
    let acp = null
    if (fakeAcp) {
      acp = {
        bin: join(root, 'acp-agent'),
        script: join(root, 'acp-script.json'),
        log: join(root, 'acp-log.jsonl'),
        pids: join(root, 'acp-pids.jsonl'),
        start: join(root, 'acp-start.jsonl')
      }
      // exec, so the agent's pid is the one the runner spawned and its process group holds nothing else of the shim.
      await writeFile(acp.bin, `#!/bin/sh\nexec "${process.execPath}" "${typeof fakeAcp === 'string' ? fakeAcp : FAKE_ACP}" "$@"\n`)
      await chmod(acp.bin, 0o755)
      await writeFile(acp.script, '{}\n')
      Object.assign(fakeEnv, { FAKE_ACP_SCRIPT: acp.script, FAKE_ACP_LOG: acp.log, FAKE_ACP_PIDS: acp.pids, FAKE_ACP_START: acp.start })
    }
    let agui = null
    if (fakeAgui) {
      const script = join(root, 'agui-script.json')
      const log = join(root, 'agui-log.jsonl')
      await writeFile(script, '{"requests":[[]]}\n')
      const started = await startFakeAgui(typeof fakeAgui === 'string' ? fakeAgui : FAKE_AGUI, script, log)
      aguiChild = started.child
      agui = { url: `http://127.0.0.1:${started.port}/run`, script, log, pid: started.child.pid }
      // The dev hook, so the remote agent may reach the fake's loopback http address (ignored when NODE_ENV=production).
      fakeEnv.ZUMIBOT_AGUI_ALLOW_LOCAL = '1'
    }
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const secret = randomBytes(24).toString('hex')
    const serverEnv = {
      ...inheritedEnv(),
      // Real claude keeps its login under the real HOME (never copied); fake runs get a throwaway one
      ...(fake ? { HOME: home } : {}),
      NODE_ENV: 'test',
      ZUMIBOT_MODE: mode,
      ZUMIBOT_DATA_DIR: dataDir,
      ZUMIBOT_AGENTS_DIR: agentsDir,
      ZUMIBOT_PORT: String(port),
      ...(mode === 'local' ? { ZUMIBOT_LOCAL_SECRET: secret } : { ZUMIBOT_ORIGIN: origin }),
      ZUMIBOT_PERMISSION_MODE: 'manual',
      // Passed on purpose, so `ZUMIBOT_CLAUDE_SDK=1 npm run e2e` runs every suite on the Claude Agent SDK adapter instead of
      // the CLI runner (docs/architecture/engines.md). Every other ZUMIBOT_* of the developer's own stays out, as above.
      ...(process.env.ZUMIBOT_CLAUDE_SDK ? { ZUMIBOT_CLAUDE_SDK: process.env.ZUMIBOT_CLAUDE_SDK } : {}),
      // Never the real ~/.config/zumibot-vault; beside the data dir, not in it (the server refuses that).
      ZUMIBOT_VAULT_KEY_FILE: join(root, 'vault-key', 'vault.key'),
      ...fakeEnv,
      ...env
    }
    for (const k of Object.keys(serverEnv)) if (serverEnv[k] === undefined) delete serverEnv[k]
    const creds = mode === 'vps' && setup ? await setupAuth(serverEnv) : null

    const spawnServer = () =>
      new Promise((resolve, reject) => {
        // After stop() nothing may start: a restart still in flight would leave an orphaned server
        if (stopped) return reject(new Error('harness already stopped'))
        const p = spawn(process.execPath, [SERVER], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] })
        child = p
        let buf = ''
        const timer = setTimeout(() => reject(new Error('server did not print LISTENING in 20 s')), 20_000)
        p.stdout.on('data', (d) => {
          buf += d
          output.push(String(d))
          if (new RegExp(`LISTENING ${port}\\b`).test(buf)) {
            clearTimeout(timer)
            resolve(p)
          }
        })
        p.stderr.on('data', (d) => errors.push(`server stderr: ${String(d).trim()}`))
        p.once('error', reject)
        p.once('exit', (code, sig) => {
          clearTimeout(timer)
          exitLog.push({ code, sig })
          reject(new Error(`server exited early (${code ?? sig})`))
        })
      })
    // stdout arrives in chunks, so a line printed right after LISTENING may not be there yet.
    const waitForOutput = async (re, timeoutMs = 10_000) => {
      const until = Date.now() + timeoutMs
      for (;;) {
        const m = re.exec(output.join(''))
        if (m) return m
        if (Date.now() > until) throw new Error(`the server never printed ${re}`)
        await sleep(50)
      }
    }
    const h = {
      origin,
      root,
      dataDir,
      agentsDir,
      creds,
      script,
      codex,
      acp,
      agui,
      errors,
      output,
      exitLog,
      waitForOutput,
      server: await spawnServer()
    }
    h.setupCode = mode === 'vps' && !setup ? (await waitForOutput(/Setup code: (\S+)/))[1] : null
    // Chrome gets a fresh temp profile (a persistent context would be its own dir); closed in stop().
    browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: chromeArgs })
    const context = await browser.newContext({ acceptDownloads: true })
    const watch = (p) => {
      p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
      p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    }
    context.on('page', watch)
    if (mode === 'local') await context.addCookies([{ name: 'cb_local', value: secret, url: origin }])
    const page = await context.newPage()
    if (mode === 'vps' && doSignIn && creds) {
      await signIn(page, origin, creds)
      await page.waitForURL(`${origin}/`, { timeout: 15_000 })
    } else if (mode === 'local') {
      await page.goto(origin)
    }
    Object.assign(h, {
      browser,
      context,
      page,
      newPage: () => context.newPage(),
      // Another context (a phone viewport, its own init scripts) with the same way in and the same error watchers.
      // VPS mode copies the main context's session cookie. Closed with the browser in stop().
      async newContext(options = {}) {
        const ctx = await browser.newContext({ acceptDownloads: true, ...options })
        ctx.on('page', watch)
        if (mode === 'local') await ctx.addCookies([{ name: 'cb_local', value: secret, url: origin }])
        else await ctx.addCookies(await context.cookies(origin))
        return ctx
      },
      // SIGTERM, wait for exit, start a fresh server on the same data dir and port (tabs reconnect to the same origin).
      restartServer() {
        h.restarting = restart()
        return h.restarting
      },
      async stop() {
        if (stopped) return
        stopped = true
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
        await h.restarting?.catch(() => {})
        await Promise.race([browser?.close().catch(() => {}), sleep(10_000)])
        // stopChild, not exitCode alone: a server the suite SIGKILLed has only signalCode set and is already gone.
        await stopChild(child, 12_000)
        await stopChild(aguiChild, 5_000)
        await rm(root, { recursive: true, force: true })
      }
    })
    const restart = async () => {
      // A server the suite SIGKILLed is already gone: stopChild returns at once instead of waiting 15 s.
      await stopChild(h.server, 15_000)
      h.server = await spawnServer()
    }
    // Ctrl-C or a kill of the e2e process must not orphan the server and Chrome
    const onSignal = () => void h.stop().finally(() => process.exit(130))
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    return h
  } catch (err) {
    // Setup failed halfway: still free everything this call started.
    if (browser) await browser.close().catch(() => {})
    if (child && child.exitCode === null) child.kill('SIGKILL')
    if (aguiChild && aguiChild.exitCode === null) aguiChild.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
    throw err
  }
}
