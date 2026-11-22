// vps-mode sign-in e2e against the built server (fake claude, no network). Usage: npm run e2e:auth (builds first).
import { signIn, start, unexpectedErrors } from './harness.mjs'

const t0 = Date.now()
const pass = (step) => console.log(`PASS ${step}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const SIDEBAR = '[data-testid="sidebar-user"]'

let h = null
try {
  h = await start({ mode: 'vps', fake: true, signIn: false })
  const { page, origin, creds } = h

  await page.goto(`${origin}/`)
  await page.waitForURL(`${origin}/login`, { timeout: 10_000 })
  pass('signed-out visit to / lands on /login')

  await signIn(page, origin, creds, '000000')
  await page.locator('#error').waitFor({ state: 'visible', timeout: 10_000 })
  assert(
    (await page.locator('#error').textContent()).trim() === 'Wrong password or code.',
    `error text ${await page.locator('#error').textContent()}`
  )
  assert(page.url() === `${origin}/login`, `left the login page: ${page.url()}`)
  pass('wrong code shows "Wrong password or code."')

  await signIn(page, origin, creds)
  await page.waitForURL(`${origin}/`, { timeout: 15_000 })
  await page.locator(SIDEBAR).waitFor({ timeout: 15_000 })
  pass('right password + current TOTP code reaches the sidebar')

  const b = await h.newPage()
  await b.goto(origin)
  await b.locator(SIDEBAR).waitFor({ timeout: 15_000 })
  const draft = 'half-typed thought'
  await b.locator('[data-testid="composer-input"]').fill(draft)
  await page.locator('[data-testid="settings-open"]').click()
  await page.locator('[data-testid="settings-nav-account"]').click()
  await page.locator('[data-testid="sign-out-everywhere"]').click()
  const out = Date.now()
  await b.waitForURL(`${origin}/login`, { timeout: 2_000 })
  pass(`"Sign out everywhere" in tab A sends tab B to /login (${Date.now() - out} ms)`)
  await page.waitForURL(`${origin}/login`, { timeout: 5_000 })

  await signIn(b, origin, creds)
  await b.waitForURL(`${origin}/`, { timeout: 15_000 })
  await b.locator(SIDEBAR).waitFor({ timeout: 15_000 })
  await b.waitForFunction((t) => document.querySelector('[data-testid="composer-input"]')?.textContent.includes(t), draft, {
    timeout: 5_000
  })
  pass("tab B's composer draft is back after signing in again")
  // Allowed: the wrong-code login (server log, browser 401 resource line). Anything else is a failure.
  const bad = unexpectedErrors(h.errors, [
    /^server stderr: login failed from 127\.0\.0\.1$/,
    /^console: Failed to load resource: the server responded with a status of 401/
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
