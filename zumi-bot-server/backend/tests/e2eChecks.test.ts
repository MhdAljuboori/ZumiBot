import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
// @ts-expect-error plain .mjs without types
import { claimExpectedErrors, ipcDirsOf, killOwnedChild } from '../../e2e/e2eChecks.mjs'

describe('scoped expected e2e warnings', () => {
  it('claims only the designated step and exact count', () => {
    const rows = ['fallback', 'unrelated', 'fallback', 'fallback']
    expect(claimExpectedErrors(rows, 2, 3, /fallback/, 1)).toEqual([2])
    expect(() => claimExpectedErrors(rows, 0, 4, /fallback/, 1)).toThrow(/expected 1.*got 3/)
    expect(() => claimExpectedErrors(rows, 1, 2, /fallback/, 1)).toThrow(/expected 1.*got 0/)
    const claimed = new Set(claimExpectedErrors(rows, 2, 3, /fallback/, 1))
    expect(rows.filter((_, i) => !claimed.has(i))).toEqual(['fallback', 'unrelated', 'fallback'])
  })
})

describe('owned child cleanup', () => {
  it('signals only a child whose owned handle has not exited', () => {
    for (const state of [
      { exitCode: 0, signalCode: null },
      { exitCode: null, signalCode: 'SIGTERM' }
    ]) {
      const kill = vi.fn()
      killOwnedChild({ ...state, pid: 123, kill })
      expect(kill).not.toHaveBeenCalled()
    }
    const kill = vi.fn()
    killOwnedChild({ exitCode: null, signalCode: null, pid: 123, kill })
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })
})

describe('IPC folders of a process', () => {
  it.runIf(process.platform === 'linux')('lists the cb folders whose socket the process listens on', async () => {
    const dir = await mkdtemp('/tmp/cb-b-')
    const other = await mkdtemp('/tmp/zb-x-')
    const servers = [createServer(), createServer()]
    try {
      await new Promise<void>((r) => servers[0]!.listen(join(dir, 's'), r))
      await new Promise<void>((r) => servers[1]!.listen(join(other, 's'), r))
      const dirs: string[] = await ipcDirsOf(process.pid)
      expect(dirs).toContain(dir)
      expect(dirs).not.toContain(other)
      await new Promise((r) => servers[0]!.close(r))
      expect(await ipcDirsOf(process.pid)).not.toContain(dir)
    } finally {
      for (const s of servers) s.close()
      await rm(dir, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })
})
