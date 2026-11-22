import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { PodmanCalls } from '../../../src/core/isolation/podmanCalls'

// A stand-in for podman: node prints its pid, then runs until signalled.
const node = process.execPath
const hang = (ignoreTerm = false) => [
  '-e',
  `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)`
]
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('PodmanCalls', () => {
  it('runs a call and gives its exit code and stdout', async () => {
    const calls = new PodmanCalls()
    expect(await calls.run(node, ['-e', 'process.stdout.write("true")'], 5000)).toEqual({ code: 0, stdout: 'true' })
    expect(await calls.exec(node)(['-e', 'process.exit(3)'])).toEqual({ code: 3, stdout: '' })
    expect(await calls.run('/nonexistent/podman', ['info'], 5000)).toEqual({ code: null, stdout: '' })
  })

  it('close() ends a call still running and waits for its exit; nothing starts after', async () => {
    const calls = new PodmanCalls()
    const pending = calls.run(node, hang(), 30_000)
    await sleep(300)
    const started = Date.now()
    await calls.close()
    expect(Date.now() - started).toBeLessThan(2000)
    const { code, stdout } = await pending
    expect(code).toBeNull()
    expect(alive(Number(stdout))).toBe(false)
    expect(await calls.run(node, ['-e', 'process.stdout.write("late")'], 5000)).toEqual({ code: null, stdout: '' })
  })

  it('close() SIGKILLs a call that ignores SIGTERM once the grace is over', async () => {
    const calls = new PodmanCalls()
    const pending = calls.run(node, hang(true), 30_000)
    await sleep(300)
    const started = Date.now()
    await calls.close(300)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    const { stdout } = await pending
    expect(alive(Number(stdout))).toBe(false)
  })

  it('close() with nothing running returns at once', async () => {
    await expect(new PodmanCalls().close()).resolves.toBeUndefined()
  })
})
