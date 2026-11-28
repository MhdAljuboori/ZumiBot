import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchClaudeConfig } from '../../../src/core/extensions/configWatch'
import { removeDir } from '../../support/platform'

const DEBOUNCE = 40
// Long enough for a missed event to have landed, so "nothing fired" means something.
const QUIET_MS = process.platform === 'darwin' ? 1200 : 400

let dir: string
let fired: number
let stop: () => void

const put = (rel: string, text = 'x'): void => {
  const path = join(dir, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS))

// macOS starts a recursive watch's FSEvents stream asynchronously and drops events from before it runs, so the write
// is repeated until the listener has run.
const firesOn = async (write: () => void): Promise<void> => {
  const before = fired
  await vi.waitFor(
    async () => {
      write()
      await new Promise((r) => setTimeout(r, DEBOUNCE * 3))
      expect(fired).toBeGreaterThan(before)
    },
    { timeout: 4000 }
  )
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cb-cfg-watch-')))
  mkdirSync(join(dir, 'skills', 'mine'), { recursive: true })
  mkdirSync(join(dir, 'plugins'), { recursive: true })
  fired = 0
  stop = () => {}
})
afterEach(() => {
  stop()
  removeDir(dir)
})

const start = (): void => {
  stop = watchClaudeConfig(
    dir,
    () => {
      fired++
    },
    DEBOUNCE
  )
}

describe('watchClaudeConfig', () => {
  it('fires once, debounced, when a skill is added', async () => {
    start()
    await firesOn(() => {
      put('skills/new-skill/SKILL.md', '---\nname: new-skill\n---\n')
      put('skills/new-skill/scripts/run.sh')
    })
    const after = fired
    await quiet()
    expect(fired).toBe(after)
  })

  it('fires when a skill is edited, and when settings.json or installed_plugins.json is written', async () => {
    start()
    await firesOn(() => put('skills/mine/SKILL.md', 'edited'))
    await firesOn(() => put('settings.json', '{}'))
    await firesOn(() => put('plugins/installed_plugins.json', '{}'))
  })

  it('fires for a commands folder made after the watch started, and for a command added in it', async () => {
    start()
    // The folder is made only once, and the top watch is not recursive, so retried writes inside it never reach that
    // watch: on macOS a mkdir before the FSEvents stream runs is lost for good. An event first proves the stream runs.
    await firesOn(() => put('settings.json', '{}'))
    await firesOn(() => put('commands/check.md', 'Check it'))
    await firesOn(() => put('commands/nested/deep.md', 'Deep'))
  })

  // The CLI writes these at every start; a re-probe is a CLI start, so firing here would loop.
  it("ignores the CLI's own churn: synced skills and plugins, the plugin cache, and other files", async () => {
    start()
    // A first event proves the watch runs, so the quiet check after it is not passing on a watch that never started.
    await firesOn(() => put('skills/mine/SKILL.md', 'ready'))
    await quiet()
    const before = fired
    put('skills/synced/abc/.last-complete-round')
    put('skills/synced/abc/xlsx/SKILL.md')
    put('skills/.trash/old/SKILL.md')
    put('plugins/synced/abc/p~g2/.in_use/123')
    put('plugins/cache/m/p/1/skills/s/SKILL.md')
    put('plugins/known_marketplaces.json', '{}')
    put('history.jsonl', 'line')
    put('projects/x/session.jsonl', 'line')
    await quiet()
    expect(fired).toBe(before)
  })

  it('does nothing after stop()', async () => {
    start()
    await firesOn(() => put('settings.json', '{"a":1}'))
    stop()
    const before = fired
    put('settings.json', '{"a":2}')
    put('skills/other/SKILL.md')
    await quiet()
    expect(fired).toBe(before)
  })

  it('a missing config folder gives a stop that does nothing, and a throwing listener does not escape', async () => {
    expect(() => watchClaudeConfig(join(dir, 'nope'), () => {}, DEBOUNCE)()).not.toThrow()
    stop = watchClaudeConfig(
      dir,
      () => {
        fired++
        throw new Error('boom')
      },
      DEBOUNCE
    )
    await firesOn(() => put('settings.json', '{"b":1}'))
  })
})
