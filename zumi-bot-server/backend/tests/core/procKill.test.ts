import { afterEach, describe, expect, test, vi } from 'vitest'

// taskkill is spawned, never run: these check which kills reach it.
const spawned = vi.hoisted(() => [] as { cmd: string; args: string[] }[])
vi.mock('node:child_process', async (load) => ({
  ...(await load<typeof import('node:child_process')>()),
  spawn: (cmd: string, args: string[]) => {
    spawned.push({ cmd, args })
    return { on: () => {}, unref: () => {} }
  }
}))

const { signalChildGroup } = await import('../../src/core/procKill')

const live = { pid: 4242, exitCode: null, signalCode: null }
const exited = { pid: 4242, exitCode: 0, signalCode: null }
const killed = { pid: 4242, exitCode: null, signalCode: 'SIGKILL' as const }

afterEach(() => {
  spawned.length = 0
  vi.restoreAllMocks()
})

describe('signalChildGroup on Windows', () => {
  test("a live child's tree ends with taskkill /T", () => {
    signalChildGroup(live, 'SIGTERM', 'win32')
    expect(spawned).toEqual([{ cmd: 'taskkill', args: ['/T', '/F', '/PID', '4242'] }])
  })

  // Windows gives a freed pid to the next process at once: a taskkill by it would end a stranger's tree.
  test('a child node saw exit is gone: no taskkill, ESRCH like process.kill', () => {
    for (const child of [exited, killed]) {
      expect(() => signalChildGroup(child, 'SIGKILL', 'win32')).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect(() => signalChildGroup(child, 0, 'win32')).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    expect(spawned).toEqual([])
  })

  test('signal 0 asks node, not the pid, and kills nothing', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(() => signalChildGroup(live, 0, 'win32')).not.toThrow()
    expect(kill).not.toHaveBeenCalled()
    expect(spawned).toEqual([])
  })

  test('a child that never started has nothing to kill', () => {
    expect(() => signalChildGroup({ pid: undefined, exitCode: null, signalCode: null }, 'SIGKILL', 'win32')).toThrow(
      expect.objectContaining({ code: 'ESRCH' })
    )
    expect(spawned).toEqual([])
  })
})

describe('signalChildGroup on POSIX', () => {
  // The group outlives its leader, so a kill after the exit still reaches what the child left running.
  test('signals the group, also after the child exited', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    signalChildGroup(live, 'SIGTERM', 'linux')
    signalChildGroup(exited, 'SIGKILL', 'darwin')
    expect(kill.mock.calls).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL']
    ])
    expect(spawned).toEqual([])
  })
})
