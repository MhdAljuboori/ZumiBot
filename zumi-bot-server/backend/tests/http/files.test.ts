import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowGate, startRig, type Rig } from './helpers'
import { parseFilePath } from '../../src/http/files'

const HEX = 'a'.repeat(64)

describe('parseFilePath', () => {
  it('reads chat id and copy id', () => {
    expect(parseFilePath(`/api/files/c1/${HEX}`)).toEqual({ chatId: 'c1', id: HEX })
  })

  it('rejects anything that is not a plain chat id and a 64-hex id', () => {
    for (const p of [
      `/api/files/c1/${'a'.repeat(63)}`,
      `/api/files/c1/${'a'.repeat(65)}`,
      `/api/files/c1/${'A'.repeat(64)}`,
      `/api/files/../${HEX}`,
      `/api/files/c1/..`,
      `/api/files/c1/${HEX}/x`,
      `/api/files/${HEX}`,
      `/api/files/c%2F1/${HEX}`,
      `/other/files/c1/${HEX}`
    ]) {
      expect(parseFilePath(p), p).toBeNull()
    }
  })
})

let rig: Rig
beforeEach(async () => {
  rig = await startRig()
})
afterEach(() => rig.close())

async function keep(chatId: string, text: string): Promise<string> {
  const r = await rig.snapshots.put(chatId, text)
  if (!('id' in r)) throw new Error('not kept')
  return r.id
}

describe('GET /api/files', () => {
  it('serves a copy as nosniff text, cached for good', async () => {
    const id = await keep('c1', 'const a = 1\n')
    const res = await fetch(`${rig.base}/api/files/c1/${id}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('const a = 1\n')
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('HEAD answers the headers without a body', async () => {
    const id = await keep('c1', 'abc')
    const res = await fetch(`${rig.base}/api/files/c1/${id}`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('3')
    expect(await res.text()).toBe('')
  })

  it('answers 404 for a missing copy, a copy of another chat and a malformed id', async () => {
    const id = await keep('c1', 'abc')
    expect((await fetch(`${rig.base}/api/files/c1/${'b'.repeat(64)}`)).status).toBe(404)
    expect((await fetch(`${rig.base}/api/files/c2/${id}`)).status).toBe(404)
    expect((await fetch(`${rig.base}/api/files/c1/${'a'.repeat(63)}`)).status).toBe(404)
    expect((await fetch(`${rig.base}/api/files/c1/..`)).status).toBe(404)
  })

  it('is closed to a signed-out caller', async () => {
    const out = await startRig({ gate: allowGate(false) })
    try {
      expect((await fetch(`${out.base}/api/files/c1/${HEX}`)).status).toBe(401)
    } finally {
      await out.close()
    }
  })

  it('does not accept writes', async () => {
    const id = await keep('c1', 'abc')
    expect((await fetch(`${rig.base}/api/files/c1/${id}`, { method: 'POST' })).status).toBe(404)
  })

  it('?download=<name> adds a safe Content-Disposition and never changes what is read', async () => {
    const id = await keep('c1', 'abc')
    const name = 'my "draft" é.md'
    const res = await fetch(`${rig.base}/api/files/c1/${id}?download=${encodeURIComponent(name)}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc')
    const cd = res.headers.get('content-disposition')!
    expect(cd).toContain("filename*=UTF-8''my%20%22draft%22%20%C3%A9.md")
    expect(/filename="([^"]*)"/.exec(cd)?.[1]).toBe('my _draft_ _.md')
  })

  it('a traversing ?download name only names the file', async () => {
    const id = await keep('c1', 'abc')
    const res = await fetch(`${rig.base}/api/files/c1/${id}?download=${encodeURIComponent('../../etc/passwd')}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc')
  })
})
