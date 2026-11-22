import { describe, expect, it } from 'vitest'
import { ACP_ERROR, AcpRpc, AcpRpcError } from '../../src/core/acp/acpRpc'

function make(ok = true) {
  const lines: string[] = []
  const rpc = new AcpRpc((l) => {
    lines.push(l)
    return ok
  })
  return { rpc, lines }
}

describe('AcpRpc', () => {
  it('writes a request as one JSON-RPC 2.0 line, ids from 1', () => {
    const { rpc, lines } = make()
    void rpc.request('initialize', {}).catch(() => {})
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'])
    void rpc.request('session/new', { cwd: '/x' }).catch(() => {})
    expect(lines[1]).toBe('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/x"}}\n')
  })

  it('every message it writes carries jsonrpc 2.0', () => {
    const { rpc, lines } = make()
    rpc.notify('session/cancel', { sessionId: 's' })
    rpc.notify('x')
    rpc.respond(5, { outcome: { outcome: 'cancelled' } })
    rpc.respondError('a', ACP_ERROR.methodNotFound, 'nope')
    expect(lines.map((l) => JSON.parse(l).jsonrpc)).toEqual(['2.0', '2.0', '2.0', '2.0'])
    expect(lines[0]).toBe('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}\n')
    expect(lines[1]).toBe('{"jsonrpc":"2.0","method":"x"}\n')
    expect(lines[2]).toBe('{"jsonrpc":"2.0","id":5,"result":{"outcome":{"outcome":"cancelled"}}}\n')
    expect(lines[3]).toBe('{"jsonrpc":"2.0","id":"a","error":{"code":-32601,"message":"nope"}}\n')
  })

  it('resolves a request from its response line and returns null', async () => {
    const { rpc } = make()
    const p = rpc.request<{ a: number }>('m', {})
    expect(rpc.receive('{"jsonrpc":"2.0","id":1,"result":{"a":1}}')).toBeNull()
    await expect(p).resolves.toEqual({ a: 1 })
  })

  it('rejects with AcpRpcError carrying the code on an error response', async () => {
    const { rpc } = make()
    const p = rpc.request('m', {})
    expect(rpc.receive('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}')).toBeNull()
    const err = (await p.catch((e: unknown) => e)) as AcpRpcError
    expect(err).toBeInstanceOf(AcpRpcError)
    expect(err.code).toBe(ACP_ERROR.invalidParams)
    expect(err.message).toBe('bad params')
  })

  it("runs a request's onSettle inside receive, before the next line is read, on a result or an error", () => {
    const { rpc } = make()
    const seen: string[] = []
    void rpc.request('a', {}, () => seen.push('a')).catch(() => {})
    void rpc.request('b', {}, () => seen.push('b')).catch(() => {})
    rpc.receive('{"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"gone"}}')
    expect(seen).toEqual(['b'])
    rpc.receive('{"jsonrpc":"2.0","method":"session/update","params":{}}')
    expect(seen).toEqual(['b'])
    rpc.receive('{"jsonrpc":"2.0","id":1,"result":{}}')
    expect(seen).toEqual(['b', 'a'])
  })

  it('names every JSON-RPC and ACP error code', () => {
    expect(ACP_ERROR).toEqual({
      parse: -32700,
      invalidRequest: -32600,
      methodNotFound: -32601,
      invalidParams: -32602,
      internal: -32603,
      cancelled: -32800,
      authRequired: -32000,
      notFound: -32002
    })
  })

  it('keeps the data of an auth-required error, outside the message', async () => {
    const { rpc } = make()
    const p = rpc.request('session/new', {})
    rpc.receive('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Authentication required","data":{"authMethods":["a"]}}}')
    const err = (await p.catch((e: unknown) => e)) as AcpRpcError
    expect(err.code).toBe(ACP_ERROR.authRequired)
    expect(err.data).toEqual({ authMethods: ['a'] })
    expect(err.message).not.toContain('authMethods')
  })

  it('uses a default code and message for an odd error object', async () => {
    const { rpc } = make()
    const p = rpc.request('m', {})
    rpc.receive('{"jsonrpc":"2.0","id":1,"error":{"code":"x","message":7}}')
    const err = (await p.catch((e: unknown) => e)) as AcpRpcError
    expect(err.code).toBe(ACP_ERROR.internal)
    expect(err.message).toBe('ACP request failed')
  })

  it('returns a line with method and no id as a notification', () => {
    const { rpc } = make()
    expect(rpc.receive('{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}')).toEqual({
      kind: 'notification',
      method: 'session/update',
      params: { x: 1 }
    })
  })

  it('returns a line with method and id as an agent request, id kept as sent', () => {
    const { rpc } = make()
    expect(rpc.receive('{"jsonrpc":"2.0","id":"abc","method":"session/request_permission","params":{}}')).toEqual({
      kind: 'request',
      id: 'abc',
      method: 'session/request_permission',
      params: {}
    })
    expect(rpc.receive('{"jsonrpc":"2.0","id":7,"method":"x","params":null}')).toEqual({
      kind: 'request',
      id: 7,
      method: 'x',
      params: null
    })
  })

  it('returns null and counts a non-JSON or non-object line', () => {
    const { rpc } = make()
    expect(rpc.malformed).toBe(0)
    expect(rpc.receive('gemini starting…')).toBeNull()
    expect(rpc.receive('42')).toBeNull()
    expect(rpc.receive('null')).toBeNull()
    expect(rpc.receive('[1,2]')).toBeNull()
    expect(rpc.malformed).toBe(4)
  })

  it('does not count a blank line, an unknown response id or a null id', () => {
    const { rpc } = make()
    expect(rpc.receive('')).toBeNull()
    expect(rpc.receive('   ')).toBeNull()
    expect(rpc.receive('{"jsonrpc":"2.0","id":99,"result":1}')).toBeNull()
    expect(rpc.receive('{"jsonrpc":"2.0","id":null,"method":"x"}')).toBeNull()
    expect(rpc.malformed).toBe(0)
  })

  it('rejects a request at once when the write fails', async () => {
    const { rpc } = make(false)
    await expect(rpc.request('m', {})).rejects.toThrow('not accepting input')
  })

  it('close rejects every pending request and any later one', async () => {
    const { rpc } = make()
    const a = rpc.request('a', {})
    const b = rpc.request('b', {})
    const closed = new Error('gone')
    rpc.close(closed)
    await expect(a).rejects.toBe(closed)
    await expect(b).rejects.toBe(closed)
    await expect(rpc.request('c', {})).rejects.toBe(closed)
  })

  it('a write that throws counts as not sent', async () => {
    const rpc = new AcpRpc(() => {
      throw new Error('EPIPE')
    })
    await expect(rpc.request('m', {})).rejects.toThrow('not accepting input')
    expect(() => rpc.notify('x')).not.toThrow()
  })
})
