// The CLI writes' runner (claudeCli.ts): a run ends at its timeout or an abort even when something it started still holds its stdout.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import { mcpRemove, pluginList } from '../../../src/core/extensions/claudeCli'
import { writeFakeNodeBin } from '../../support/fakeBin'
import { isWindows, removeDir } from '../../support/platform'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-ext-cli-'))
})
afterEach(() => {
  // The stray grandchild left the CLI's process group on purpose; it goes here.
  const pidFile = join(dir, 'stray.pid')
  if (existsSync(pidFile))
    try {
      // Windows has no process groups: the stray is a single process there.
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      process.kill(isWindows ? pid : -pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  removeDir(dir)
})

// A CLI that hangs, and starts a grandchild in a session of its own that keeps the CLI's stdout open.
const strayCli = (): string => {
  if (process.platform !== 'linux') {
    // No setsid command on Windows or macOS. A detached node grandchild that inherits stdout does the same: on POSIX node
    // calls setsid() for it, and on Windows it leaves the launcher's job.
    const stray = `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'stray.pid'))}, String(process.pid)); setTimeout(() => {}, 30000)`
    return writeFakeNodeBin(
      dir,
      'claude',
      `import { spawn } from 'node:child_process'\n` +
        `spawn(process.execPath, ['-e', ${JSON.stringify(stray)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref()\n` +
        `setTimeout(() => {}, 30000)\n`
    )
  }
  const bin = join(dir, 'claude')
  writeFileSync(bin, `#!/bin/sh\nsetsid sh -c 'echo $$ > "${join(dir, 'stray.pid')}"; exec sleep 30' &\nexec sleep 30\n`)
  chmodSync(bin, 0o755)
  return bin
}

// The node fake (Windows, macOS) starts slower than sh and sleep, more so on Windows (a launcher, then node): the timeout
// must fall after the stray is up, and the test needs longer.
const nodeFake = process.platform !== 'linux'
const SLOW = nodeFake ? 15_000 : undefined

const waitFor = async (file: string) => {
  // Up to 5 s: the node fake starts slower, Windows's most (a launcher, then node).
  for (let i = 0; i < 250 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20))
}

it(
  'ends a timed-out run after the kill grace even while a grandchild that left its group holds stdout',
  async () => {
    const bin = strayCli()
    const started = Date.now()
    const listing = pluginList({
      bin,
      env: { PATH: process.env.PATH ?? '' },
      cwd: dir,
      timeoutMs: nodeFake ? 2500 : 300,
      killGraceMs: 100
    })
    await expect(listing).rejects.toThrow(EXT_TEXT.timeout)
    expect(Date.now() - started).toBeLessThan(5000)
    await waitFor(join(dir, 'stray.pid'))
    expect(existsSync(join(dir, 'stray.pid'))).toBe(true)
  },
  SLOW
)

it(
  'ends a run when its signal aborts, the same way',
  async () => {
    const bin = strayCli()
    const ac = new AbortController()
    const started = Date.now()
    const removing = mcpRemove({
      bin,
      env: { PATH: process.env.PATH ?? '' },
      folder: dir,
      scope: 'user',
      name: 'x',
      killGraceMs: 100,
      signal: ac.signal
    })
    await waitFor(join(dir, 'stray.pid'))
    ac.abort()
    await expect(removing).rejects.toThrow(EXT_TEXT.timeout)
    expect(Date.now() - started).toBeLessThan(5000)
    // An already aborted signal starts nothing.
    await expect(
      mcpRemove({ bin: join(dir, 'never-run'), env: {}, folder: dir, scope: 'user', name: 'x', signal: ac.signal })
    ).rejects.toThrow(EXT_TEXT.timeout)
  },
  SLOW
)
