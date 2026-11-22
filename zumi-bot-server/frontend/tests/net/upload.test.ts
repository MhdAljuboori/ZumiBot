import { describe, expect, it, vi } from 'vitest'
import { uploadFile } from '../../src/net/upload'

const resp = (status: number, body: string, json = false): Response =>
  new Response(body, { status, headers: { 'content-type': json ? 'application/json' : 'text/html' } })

describe('uploadFile', () => {
  it('413 with an HTML body maps to "<name> is over 25 MB"', async () => {
    const f = vi.fn().mockResolvedValue(resp(413, '<html>Request Entity Too Large</html>'))
    expect(await uploadFile(f, 'big.zip', new Uint8Array(1))).toEqual({ ok: false, name: 'big.zip', error: 'big.zip is over 25 MB' })
  })

  it('sends X-File-Name URI-encoded', async () => {
    const f = vi.fn().mockResolvedValue(resp(200, JSON.stringify({ ok: true, attachment: { id: 'a' } }), true))
    const bytes = new Uint8Array([1, 2])
    const r = await uploadFile(f, 'my file é.png', bytes)
    expect(r).toEqual({ ok: true, attachment: { id: 'a' } })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('/api/attachments/stage')
    expect(init.method).toBe('POST')
    expect(init.headers['X-File-Name']).toBe(encodeURIComponent('my file é.png'))
    expect(init.body).toBe(bytes)
  })

  it('500 → "<name> couldn\'t be read"', async () => {
    const f = vi.fn().mockResolvedValue(resp(500, 'oops'))
    expect(await uploadFile(f, 'a.txt', new Uint8Array(1))).toEqual({ ok: false, name: 'a.txt', error: "a.txt couldn't be read" })
  })

  it('401 triggers the signed-out path', async () => {
    const f = vi.fn().mockResolvedValue(resp(401, ''))
    const out = vi.fn()
    const r = await uploadFile(f, 'a.txt', new Uint8Array(1), out)
    expect(out).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
  })

  it('a network failure maps to unreadable', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('network'))
    expect(await uploadFile(f, 'a.txt', new Uint8Array(1))).toEqual({ ok: false, name: 'a.txt', error: "a.txt couldn't be read" })
  })
})
