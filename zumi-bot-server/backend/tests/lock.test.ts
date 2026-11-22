import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireDataLock, processStart } from '../src/lock'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-lock-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('acquireDataLock', () => {
  it('second acquire rejects "Another ZumiBot server is using <dir>"', async () => {
    const release = await acquireDataLock(dir)
    await expect(acquireDataLock(dir)).rejects.toThrow(`Another ZumiBot server is using ${dir}`)
    await release()
  })

  it('a stale lock with a dead pid is taken over', async () => {
    await writeFile(join(dir, 'server.lock'), '2147483646\n')
    const release = await acquireDataLock(dir)
    expect((await readFile(join(dir, 'server.lock'), 'utf8')).split(' ')[0]).toMatch(new RegExp(`^${process.pid}\\b`))
    await release()
  })

  it('a garbage lock file counts as stale', async () => {
    await writeFile(join(dir, 'server.lock'), 'not a pid')
    await (
      await acquireDataLock(dir)
    )()
  })

  it('release removes the file and lets the next server in', async () => {
    const release = await acquireDataLock(dir)
    await release()
    await expect(stat(join(dir, 'server.lock'))).rejects.toThrow()
    await (
      await acquireDataLock(dir)
    )()
  })

  it('a lock naming our own pid (left by a previous run, e.g. after a reboot) is taken over', async () => {
    await writeFile(join(dir, 'server.lock'), `${process.pid} 12345\n`)
    await (
      await acquireDataLock(dir)
    )()
  })

  // Start times come from /proc, or ps on a Mac; without them a live pid is always refused.
  it.skipIf(process.platform === 'win32')('a live pid with a different start time is another process and is taken over', async () => {
    await writeFile(join(dir, 'server.lock'), `${process.ppid} 1\n`)
    await (
      await acquireDataLock(dir)
    )()
  })

  it.skipIf(process.platform === 'win32')('a live pid with a matching start time is refused', async () => {
    const start = await processStart(process.ppid)
    expect(start).not.toBeNull()
    await writeFile(join(dir, 'server.lock'), `${process.ppid} ${start}\n`)
    await expect(acquireDataLock(dir)).rejects.toThrow('Another ZumiBot server is using')
  })

  it('sync release removes our file only', async () => {
    const release = await acquireDataLock(dir)
    release.sync()
    await expect(stat(join(dir, 'server.lock'))).rejects.toThrow()
    await writeFile(join(dir, 'server.lock'), '999999999 1\n')
    release.sync()
    expect(await readFile(join(dir, 'server.lock'), 'utf8')).toBe('999999999 1\n')
  })
})
