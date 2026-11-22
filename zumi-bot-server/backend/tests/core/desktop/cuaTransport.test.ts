import { afterEach, expect, it, vi } from 'vitest'
import type { ChildProcessByStdio } from 'node:child_process'
import { PassThrough, Writable, type Readable } from 'node:stream'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { CuaTransport } from '../../../src/core/desktop/cuaTransport'

afterEach(() => {
  vi.useRealTimers()
})

/** A child whose stdin never drains, so every write waits for 'drain'. */
function fakeChild() {
  const stdin = new Writable({
    highWaterMark: 1,
    write() {
      /* never calls back */
    }
  })
  const stdout = new PassThrough()
  return { child: { stdin, stdout } as unknown as ChildProcessByStdio<Writable, Readable, null>, stdin, stdout }
}
const ping: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' }
const reply = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n'

it('a send waiting for drain is rejected when cua-driver goes away', async () => {
  const { child, stdout } = fakeChild()
  const t = new CuaTransport(child, () => {})
  await t.start()
  const sent = t.send(ping)
  let settled = false
  sent.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise((r) => setTimeout(r, 20))
  expect(settled).toBe(false)
  stdout.destroy()
  await expect(sent).rejects.toThrow('cua-driver is not running')
})

it('a send waiting for drain is rejected by close()', async () => {
  const { child } = fakeChild()
  const t = new CuaTransport(child, () => {})
  await t.start()
  const sent = t.send(ping)
  await t.close()
  await expect(sent).rejects.toThrow()
  await expect(t.send(ping)).rejects.toThrow()
})

it('stops delivering messages after close()', async () => {
  const { child, stdout } = fakeChild()
  const t = new CuaTransport(child, () => {})
  const got: JSONRPCMessage[] = []
  t.onmessage = (m) => {
    got.push(m)
  }
  await t.start()
  stdout.write(reply(1))
  await new Promise((r) => setImmediate(r))
  await t.close()
  stdout.write(reply(2))
  await new Promise((r) => setImmediate(r))
  expect(got.map((m) => (m as { id: number }).id)).toEqual([1])
})

it('skips foreign lines, logging a fixed line at most once a second', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { child, stdout } = fakeChild()
  const lines: string[] = []
  const t = new CuaTransport(child, (l) => lines.push(l))
  const got: JSONRPCMessage[] = []
  t.onmessage = (m) => {
    got.push(m)
  }
  await t.start()
  stdout.write('SpiRegistry daemon is running\n{"not":"json-rpc"}\nmore noise\n' + reply(1))
  await new Promise((r) => setImmediate(r))
  expect(got).toHaveLength(1)
  expect(lines).toEqual(['Desktop: skipped a line from cua-driver that is not JSON-RPC'])
  vi.setSystemTime(Date.now() + 1500)
  stdout.write('noise again\n')
  await new Promise((r) => setImmediate(r))
  expect(lines).toHaveLength(2)
  expect(lines.join('\n')).not.toMatch(/SpiRegistry|noise|json-rpc"/)
})

it('a stream error does not throw', async () => {
  const { child, stdout, stdin } = fakeChild()
  const t = new CuaTransport(child, () => {})
  let closed = false
  t.onclose = () => {
    closed = true
  }
  await t.start()
  stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  stdout.destroy(new Error('read failed'))
  await new Promise((r) => setImmediate(r))
  expect(closed).toBe(true)
})
