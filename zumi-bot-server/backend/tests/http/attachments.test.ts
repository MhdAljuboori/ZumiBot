import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAttachmentPath } from '../../src/http/attachments'
import { startRig, type Rig } from './helpers'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0
])

describe('parseAttachmentPath', () => {
  it('reads staged and chat paths', () => {
    expect(parseAttachmentPath('/api/attachments/staged/abc-123')).toEqual({ chatId: null, id: 'abc-123' })
    expect(parseAttachmentPath('/api/attachments/chat/c1/abc-123')).toEqual({ chatId: 'c1', id: 'abc-123' })
  })

  it('rejects ids that would leave the folder', () => {
    for (const p of [
      '/api/attachments/chat/../../etc/passwd',
      '/api/attachments/chat/c1/a%2Fb',
      '/api/attachments/chat/c1/..',
      '/api/attachments/other/abc',
      '/api/attachments/staged/',
      '/api/attachments/staged',
      '/api/attachments/chat/c1',
      '/api/attachments/staged/abc/extra',
      '/api/attachments/staged/a.b',
      '/other/staged/abc'
    ]) {
      expect(parseAttachmentPath(p), p).toBeNull()
    }
  })
})

let rig: Rig
beforeEach(async () => {
  rig = await startRig()
})
afterEach(() => rig.close())

async function stage(name: string, bytes: Buffer): Promise<string> {
  const r = await rig.store.stageBytes(name, bytes)
  if (!r.ok) throw new Error(r.error)
  return r.attachment.id
}

describe('GET /api/attachments', () => {
  it('serves a png inline with its mime and nosniff', async () => {
    const id = await stage('p.png', PNG)
    const res = await fetch(`${rig.base}/api/attachments/staged/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG)
  })

  it('serves a text file inline as text/plain; charset=utf-8', async () => {
    const id = await stage('a.txt', Buffer.from('hello'))
    const res = await fetch(`${rig.base}/api/attachments/staged/${id}`)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('serves a pdf inline', async () => {
    const id = await stage('a.pdf', Buffer.from('%PDF-1.4'))
    const res = await fetch(`${rig.base}/api/attachments/staged/${id}`)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('serves text/html and image/svg+xml as application/octet-stream with Content-Disposition: attachment', async () => {
    for (const name of ['x.html', 'x.htm', 'x.svg', 'x.js', 'noext']) {
      const id = await stage(name, Buffer.from('<script>alert(1)</script>'))
      const res = await fetch(`${rig.base}/api/attachments/staged/${id}`)
      expect(res.headers.get('content-type'), name).toBe('application/octet-stream')
      expect(res.headers.get('content-disposition'), name).toMatch(/^attachment/)
      expect(res.headers.get('x-content-type-options'), name).toBe('nosniff')
    }
  })

  it('download=1 forces attachment with the RFC 5987 encoded file name', async () => {
    const id = await stage('héllo wörld.png', PNG)
    const res = await fetch(`${rig.base}/api/attachments/staged/${id}?download=1`)
    expect(res.headers.get('content-type')).toBe('image/png')
    const cd = res.headers.get('content-disposition')!
    expect(cd).toBe(`attachment; filename="h_llo w_rld.png"; filename*=UTF-8''h%C3%A9llo%20w%C3%B6rld.png`)
  })

  it('encodes quote and star characters in the file name', async () => {
    const id = await stage("a'b(c)*.png", PNG)
    const cd = (await fetch(`${rig.base}/api/attachments/staged/${id}?download=1`)).headers.get('content-disposition')!
    // NTFS cannot hold a `*`, so a Windows server stores (and serves) it as `_`.
    if (process.platform === 'win32') expect(cd).toBe(`attachment; filename="a'b(c)_.png"; filename*=UTF-8''a%27b%28c%29_.png`)
    else expect(cd).toBe(`attachment; filename="a'b(c)*.png"; filename*=UTF-8''a%27b%28c%29%2A.png`)
  })

  it('the plain filename fallback has no quote or non-ASCII character', async () => {
    const id = await stage('a"b€.png', PNG)
    const cd = (await fetch(`${rig.base}/api/attachments/staged/${id}?download=1`)).headers.get('content-disposition')!
    expect(cd).toMatch(/^attachment; filename="a_b_\.png"; filename\*=UTF-8''/)
  })

  it('serves a sent chat attachment', async () => {
    const id = await stage('a.txt', Buffer.from('hi'))
    await rig.store.commit('chat1', [id])
    const res = await fetch(`${rig.base}/api/attachments/chat/chat1/${id}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hi')
  })

  it('404s a missing id and a path that leaves the folder', async () => {
    expect((await fetch(`${rig.base}/api/attachments/staged/nope`)).status).toBe(404)
    expect((await fetch(`${rig.base}/api/attachments/chat/c1/%2e%2e`)).status).toBe(404)
  })

  it('HEAD on a missing id is 404', async () => {
    expect((await fetch(`${rig.base}/api/attachments/staged/nope`, { method: 'HEAD' })).status).toBe(404)
  })

  it('HEAD on an existing id is 200 without a body', async () => {
    const id = await stage('a.txt', Buffer.from('hi'))
    const res = await fetch(`${rig.base}/api/attachments/staged/${id}`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
