// First-run setup e2e: a fresh data dir, no password and no 2FA, so the server serves only the wizard.
// Walks it end to end, then signs in with what the wizard set. Usage: npm run e2e:setup (builds first).
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { signIn, start, totpAt, unexpectedErrors } from './harness.mjs'

const t0 = Date.now()
const pass = (step) => console.log(`PASS ${step}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const SIDEBAR = '[data-testid="sidebar-user"]'
const PASSWORD = 'a long enough wizard password'
const errorText = async (page) => (await page.locator('#error').textContent()).trim()

let h = null
try {
  h = await start({ mode: 'vps', fake: true, setup: false, signIn: false })
  const { page, origin, dataDir, root } = h

  assert(h.setupCode && /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(h.setupCode), `setup code ${h.setupCode}`)
  assert(h.output.join('').includes(`Open ${origin}/setup`), 'the server did not print the setup URL')
  pass('a server with no password prints a one-time setup code and the setup URL')

  await page.goto(`${origin}/`)
  await page.waitForURL(`${origin}/setup`, { timeout: 10_000 })
  await page.locator('#panel-code').waitFor({ timeout: 10_000 })
  pass('every page lands on /setup')

  // Nothing but the wizard answers: no app, no sign-in, no WebSocket.
  const api = await page.request.post(`${origin}/api/login`, { headers: { origin }, data: { password: PASSWORD, code: '000000' } })
  assert(api.status() === 404, `/api/login answered ${api.status()}`)
  pass('the sign-in route does not exist yet')

  await page.fill('#code', 'AAAA-AAAA-AAAA-AAAA')
  await page.click('#submit-code')
  await page.locator('#error').waitFor({ state: 'visible', timeout: 10_000 })
  assert((await errorText(page)).startsWith('That setup code is not right.'), `error text: ${await errorText(page)}`)
  assert(await page.locator('#panel-code').isVisible(), 'a wrong code left the code panel')
  pass('a wrong setup code gets nowhere')

  await page.fill('#code', h.setupCode)
  await page.click('#submit-code')
  await page.locator('#panel-password').waitFor({ timeout: 10_000 })
  pass('the printed code opens the password step')

  await page.fill('#password', 'short')
  await page.fill('#password2', 'short')
  await page.click('#submit-password')
  await page.locator('#error').waitFor({ state: 'visible', timeout: 10_000 })
  assert((await errorText(page)) === 'Use at least 16 characters.', `error text: ${await errorText(page)}`)
  pass('the password rule is the same one the CLI applies')

  await page.fill('#password', PASSWORD)
  await page.fill('#password2', `${PASSWORD} not`)
  await page.click('#submit-password')
  assert((await errorText(page)) === 'The two passwords do not match.', `error text: ${await errorText(page)}`)
  pass('a mistyped repeat is caught before anything is sent')

  await page.fill('#password2', PASSWORD)
  await page.click('#submit-password')
  await page.locator('#panel-totp').waitFor({ timeout: 10_000 })
  await page.waitForFunction(() => document.getElementById('secret').textContent.length > 0, null, { timeout: 10_000 })
  const qr = await page.locator('#qr').getAttribute('src')
  assert(qr.startsWith('data:image/png;base64,'), `qr src ${String(qr).slice(0, 40)}`)
  const secret = (await page.locator('#secret').textContent()).trim()
  assert(/^[A-Z2-7]{32}$/.test(secret), `secret ${secret}`)
  // Each 30 s step works once, and the wizard's confirmation burns the one it is given, so hand out the next each
  // time (the same rule the harness's own creds follow).
  let lastStep = Math.floor(Date.now() / 30_000) - 1
  const creds = {
    password: PASSWORD,
    nextCode() {
      const cur = Math.floor(Date.now() / 30_000)
      lastStep = Math.max(lastStep + 1, cur)
      if (lastStep > cur + 1) throw new Error('no unused TOTP step left; wait for the next 30 s step')
      return totpAt(secret, lastStep * 30_000)
    }
  }
  pass('the authenticator step shows a QR code and the secret behind it')

  await page.fill('#totp', '000000')
  await page.click('#submit-totp')
  await page.locator('#error').waitFor({ state: 'visible', timeout: 10_000 })
  assert((await errorText(page)).includes('not valid'), `error text: ${await errorText(page)}`)
  pass('a wrong 6-digit code is refused')

  await page.fill('#totp', creds.nextCode())
  await page.click('#submit-totp')
  await page.locator('#panel-recovery').waitFor({ timeout: 10_000 })
  const codes = await page.locator('#recovery-codes li').allTextContents()
  assert(codes.length === 10, `${codes.length} recovery codes`)
  assert(
    codes.every((c) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(c.trim())),
    `recovery codes ${JSON.stringify(codes)}`
  )
  assert(new Set(codes).size === 10, 'recovery codes repeat')
  pass('confirming shows ten recovery codes, once')

  assert(await page.locator('#submit-recovery').isDisabled(), 'Continue was enabled before the codes were acknowledged')
  await page.check('#saved-codes')
  await page.click('#submit-recovery')
  await page.locator('#panel-check').waitFor({ timeout: 10_000 })
  await page.waitForFunction(() => document.getElementById('claude-message').textContent.length > 0, null, { timeout: 10_000 })
  assert(await page.locator('#claude-fix').isVisible(), 'the CLI check did not ask for a sign-in')
  const commands = await page.locator('#claude-commands').textContent()
  assert(commands.trim() === 'claude', `fix commands: ${commands}`)
  pass('the claude check finds the CLI, sees no login, and prints the command to fix it')

  // A signed-in CLI is an oauthAccount in ~/.claude.json; the temp HOME is the one the server reads.
  await writeFile(
    join(root, 'home', '.claude.json'),
    JSON.stringify({
      oauthAccount: { accountUuid: 'u-1', emailAddress: 'someone@example.com', displayName: 'Someone', organizationType: 'claude_max' }
    })
  )
  await page.click('#recheck')
  await page.waitForFunction(() => document.getElementById('claude-message').textContent.includes('someone@example.com'), null, {
    timeout: 10_000
  })
  assert(!(await page.locator('#claude-fix').isVisible()), 'the fix block stayed up after a successful check')
  pass('"Check again" sees the login and stops asking')

  await page.click('#submit-finish')
  await page.waitForURL(`${origin}/login`, { timeout: 60_000 })
  pass('Finish hands the port over to the app and lands on /login')

  // The setup routes are gone for good: the app has no such API, even with the right code.
  const gone = await page.request.post(`${origin}/api/setup/check`, { headers: { origin }, data: { code: h.setupCode } })
  assert(gone.status() === 401 || gone.status() === 404, `/api/setup/check answered ${gone.status()}`)
  pass('the setup calls no longer exist')

  // A step the wizard's confirmation did not burn.
  await signIn(page, origin, creds)
  await page.waitForURL(`${origin}/`, { timeout: 20_000 })
  await page.locator(SIDEBAR).waitFor({ timeout: 20_000 })
  pass('the password and authenticator the wizard set sign in')

  const auth = await readFile(join(dataDir, 'auth.json'), 'utf8')
  const bare = h.setupCode.replaceAll('-', '')
  assert(!auth.includes(bare) && !auth.includes(h.setupCode), 'the setup code reached auth.json')
  assert(!auth.includes(PASSWORD), 'the password reached auth.json')
  assert(!h.errors.join('').includes(bare), 'the setup code reached stderr')
  pass('neither the setup code nor the password is stored in the clear')

  const bad = unexpectedErrors(h.errors, [
    /^server stderr: setup code refused from 127\.0\.0\.1$/,
    /^server stderr: setup: /,
    /^server stderr: setup finished$/,
    /^console: Failed to load resource: the server responded with a status of (400|401|404|503)/
  ])
  assert(bad.length === 0, `unexpected errors: ${JSON.stringify(bad)}`)
  pass('no unexpected console or server errors')
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.stack : err}`)
  if (h) console.error(h.errors.join('\n'))
  process.exitCode = 1
} finally {
  await h?.stop()
}
