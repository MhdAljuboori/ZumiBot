import { describe, expect, it } from 'vitest'
import { CodexRpc, RpcError } from '../../src/core/codex/codexRpc'

function make(ok = true) {
  const lines: string[] = []
  const rpc = new CodexRpc((l) => {
    lines.push(l)
    return ok
  })
  return { rpc, lines }
}

describe('CodexRpc', () => {
  it('writes a request as one JSON line, ids from 1', () => {
    const { rpc, lines } = make()
    void rpc.request('m', {}).catch(() => {})
    expect(lines).toEqual(['{"id":1,"method":"m","params":{}}\n'])
    void rpc.request('n', { a: 1 }).catch(() => {})
    expect(lines[1]).toBe('{"id":2,"method":"n","params":{"a":1}}\n')
  })

  it('resolves a request from its response line and returns null', async () => {
    const { rpc } = make()
    const p = rpc.request<{ a: number }>('m', {})
    expect(rpc.receive('{"id":1,"result":{"a":1}}')).toBeNull()
    await expect(p).resolves.toEqual({ a: 1 })
  })

  it('rejects with RpcError on an error response', async () => {
    const { rpc } = make()
    void rpc.request('m', {}).catch(() => {})
    const p = rpc.request('m', {})
    expect(rpc.receive('{"id":2,"error":{"code":-32600,"message":"bad"}}')).toBeNull()
    const err = (await p.catch((e: unknown) => e)) as RpcError
    expect(err).toBeInstanceOf(RpcError)
    expect(err.code).toBe(-32600)
    expect(err.message).toBe('bad')
  })

  it('returns a line with method and no id as a notification', () => {
    const { rpc } = make()
    expect(rpc.receive('{"method":"turn/started","params":{"x":1}}')).toEqual({
      kind: 'notification',
      method: 'turn/started',
      params: { x: 1 }
    })
  })

  it('returns a line with method and id as a server request, id kept as sent', () => {
    const { rpc } = make()
    expect(rpc.receive('{"id":"abc","method":"item/approve","params":{}}')).toEqual({
      kind: 'request',
      id: 'abc',
      method: 'item/approve',
      params: {}
    })
    expect(rpc.receive('{"id":7,"method":"x","params":null}')).toEqual({ kind: 'request', id: 7, method: 'x', params: null })
  })

  it('ignores non-JSON, blank and non-object lines', () => {
    const { rpc } = make()
    expect(rpc.receive('codex starting…')).toBeNull()
    expect(rpc.receive('')).toBeNull()
    expect(rpc.receive('42')).toBeNull()
    expect(rpc.receive('null')).toBeNull()
    expect(rpc.receive('{"id":99,"result":1}')).toBeNull() // unknown id
  })

  it('close rejects every pending request', async () => {
    const { rpc } = make()
    const a = rpc.request('a', {})
    const b = rpc.request('b', {})
    rpc.close(new Error('x'))
    await expect(a).rejects.toThrow('x')
    await expect(b).rejects.toThrow('x')
  })

  it('rejects a request at once when write returns false', async () => {
    const { rpc } = make(false)
    await expect(rpc.request('m', {})).rejects.toThrow()
  })

  it('rejects a request made after close', async () => {
    const { rpc } = make()
    rpc.close(new Error('gone'))
    await expect(rpc.request('m', {})).rejects.toThrow('gone')
  })

  it('writes notify, respond and respondError lines, echoing the id', () => {
    const { rpc, lines } = make()
    rpc.notify('initialized')
    rpc.notify('n', { a: 1 })
    rpc.respond('abc', { ok: true })
    rpc.respond(5, {})
    rpc.respondError('abc', -32601, 'nope')
    expect(lines).toEqual([
      '{"method":"initialized"}\n',
      '{"method":"n","params":{"a":1}}\n',
      '{"id":"abc","result":{"ok":true}}\n',
      '{"id":5,"result":{}}\n',
      '{"id":"abc","error":{"code":-32601,"message":"nope"}}\n'
    ])
  })
})
