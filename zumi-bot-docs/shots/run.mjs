// Makes the docs screenshots: `npm run shots -w @zumibot/docs -- [name...]` (every shot, or the named ones).
// It needs the built server (`npm run build:server`); the root `npm run docs:shots` runs both.
// Each shot runs twice, light then dark, on a fresh server in Local mode with the fake claude (a shot never runs a turn),
// the demo agents (shots/agents) and the shot's seed folder. The PNG goes to `src/assets/shots/<name>-<theme>.png`.
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, SERVER } from '../../zumi-bot-server/e2e/harness.mjs'
import { SHOTS } from './list.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const OUT = join(here, '..', 'src', 'assets', 'shots')
const DEMO_AGENTS = join(here, 'agents') // clean demo agents; the backend's test fixtures hold odd names and a duplicate
const THEMES = ['light', 'dark']
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
const SETTLE_MS = 1500 // as e2e/shot.mjs: let fonts, the sidebar and animations finish

const wanted = process.argv.slice(2)
const unknown = wanted.filter((n) => !SHOTS.some((s) => s.name === n))
if (unknown.length) {
  console.error(`Unknown shot: ${unknown.join(', ')}. Known: ${SHOTS.map((s) => s.name).join(', ')}`)
  process.exit(2)
}
const todo = wanted.length ? SHOTS.filter((s) => wanted.includes(s.name)) : SHOTS

try {
  await access(SERVER)
} catch {
  console.error('The server is not built. Run `npm run build:server` first (or use `npm run docs:shots` from the repo root).')
  process.exit(2)
}

/** One shot in one theme. Throws with the shot's name on a failure or on any console or server error. */
async function make(shot, theme) {
  const label = `${shot.name} (${theme})`
  const tmp = await mkdtemp(join(tmpdir(), 'zumibot-docs-shot-'))
  const dataDir = join(tmp, 'data')
  const agentsDir = join(tmp, 'agents')
  let h
  let cleanup
  try {
    await cp(DEMO_AGENTS, agentsDir, { recursive: true })
    if (shot.seed) await cp(join(here, 'seed', shot.seed), dataDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    const settingsFile = join(dataDir, 'settings.json')
    const settings = await readFile(settingsFile, 'utf8').then(JSON.parse, () => ({}))
    await writeFile(settingsFile, JSON.stringify({ ...settings, theme }))

    // `start` may be a function of the shot's folders, for options that name a path inside them (a fake CLI's state file).
    // It may be async and return a `cleanup` function (a fake service it started), which runs when the shot ends.
    const { cleanup: stopFake, ...options } = (typeof shot.start === 'function' ? await shot.start({ tmp, dataDir, agentsDir }) : shot.start) ?? {}
    cleanup = stopFake
    h = await start({ mode: 'local', fake: true, dataDir, agentsDir, ...options })
    await h.page.emulateMedia({ colorScheme: null }) // Playwright forces light; let the theme setting decide
    await h.page.setViewportSize(shot.viewport ?? DEFAULT_VIEWPORT)
    await shot.go(h, theme)
    await h.page.waitForTimeout(SETTLE_MS)
    // Before the PNG is written, so a failed shot leaves no fresh file on disk.
    // The wizard logs its steps ("setup: password set") on stderr, which is progress, not an error.
    const errors = h.errors.filter((e) => !e.startsWith('server stderr: setup: '))
    if (errors.length) throw new Error(`console or server errors:\n${errors.join('\n')}`)
    await mkdir(OUT, { recursive: true })
    const file = join(OUT, `${shot.name}-${theme}.png`)
    // `clip` captures part of the window: a selector (that element) or a function of the harness that returns a rectangle
    // ({ x, y, width, height } in window pixels), for a screen that is mostly canvas or sidebar. Only the crop changes, never the screen.
    if (typeof shot.clip === 'function') await h.page.screenshot({ path: file, clip: await shot.clip(h) })
    else if (shot.clip) await h.page.locator(shot.clip).first().screenshot({ path: file })
    else await h.page.screenshot({ path: file })
    console.log(`saved ${file}`)
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : err}`, { cause: err })
  } finally {
    // Always: no browser or server may outlive the run.
    if (h) await h.stop().catch(() => {})
    if (cleanup) await cleanup().catch(() => {})
    await rm(tmp, { recursive: true, force: true })
  }
}

let failed = false
for (const shot of todo) {
  for (const theme of THEMES) {
    try {
      await make(shot, theme)
    } catch (err) {
      failed = true
      console.error(err instanceof Error ? err.message : err)
    }
  }
}
process.exit(failed ? 1 : 0)
