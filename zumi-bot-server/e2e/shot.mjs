// Usage: node zumi-bot-server/e2e/shot.mjs <name> [agentsDir]   (run through `npm run shot`, which builds first)
// Optional env: SHOT_THEME=system|light|dark; SHOT_USER_DATA=<dir> copied into the server's fresh data dir before start
// (its settings.json, if any, keeps its keys under SHOT_THEME's); SHOT_OPEN_CHAT=<chat id> clicks that chat's sidebar row first.
// Local mode with the fake claude (a shot never runs a turn); the PNG goes to zumi-bot-server/e2e/screenshots/<name>.png.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from './harness.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const [name, agentsArg] = process.argv.slice(2)
if (!name) {
  console.error('Usage: node zumi-bot-server/e2e/shot.mjs <name> [agentsDir]')
  process.exit(2)
}

const shotTheme = process.env.SHOT_THEME
if (shotTheme !== undefined && !['system', 'light', 'dark'].includes(shotTheme)) {
  console.error('Usage: SHOT_THEME=system|light|dark node zumi-bot-server/e2e/shot.mjs <name> [agentsDir]')
  process.exit(2)
}

const tmp = await mkdtemp(join(tmpdir(), 'zumibot-shot-'))
const dataDir = join(tmp, 'data')
let agentsDir = agentsArg
if (!agentsDir) {
  agentsDir = join(tmp, 'agents')
  await cp(join(here, '..', 'backend', 'tests', 'fixtures', 'agents'), agentsDir, { recursive: true })
}

const shotUserData = process.env.SHOT_USER_DATA
if (shotUserData) await cp(shotUserData, dataDir, { recursive: true })

if (shotTheme) {
  await mkdir(dataDir, { recursive: true })
  const settingsFile = join(dataDir, 'settings.json')
  const settings = shotUserData ? await readFile(settingsFile, 'utf8').then(JSON.parse, () => ({})) : {}
  await writeFile(settingsFile, JSON.stringify({ ...settings, theme: shotTheme }))
}

const shotOpenChat = process.env.SHOT_OPEN_CHAT

let h
let failed = false
try {
  h = await start({ mode: 'local', fake: true, dataDir, agentsDir })
  const { page, errors } = h
  await page.emulateMedia({ colorScheme: null }) // Playwright forces light; let the theme setting decide
  if (shotOpenChat) {
    await page.locator(`[data-chat-id="${shotOpenChat}"]`).first().click({ timeout: 15_000 })
    await page.locator('[data-testid="message-list"]').waitFor({ timeout: 10_000 })
  }
  await page.waitForTimeout(1500)
  const shots = join(here, 'screenshots')
  await mkdir(shots, { recursive: true })
  const file = join(shots, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(`saved ${file}`)
  console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console or server errors')
} catch (err) {
  failed = true
  console.error(err)
} finally {
  if (h) await h.stop().catch(() => {})
  await rm(tmp, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
