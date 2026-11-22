import { readdir } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expectTooLarge } from '../support/chatTooLarge'
import { ATTACH_MAX_BYTES, stageErrors } from '@zumibot/shared/attachments'
import { startRig, type Rig } from './helpers'

let rig: Rig
beforeEach(async () => {
  rig = await startRig()
})
afterEach(() => rig.close())

const url = (): string => `${rig.base}/api/attachments/stage`

describe('POST /api/attachments/stage', () => {
  it('stages raw bytes under the decoded X-File-Name', async () => {
    const res = await fetch(url(), { method: 'POST', headers: { 'X-File-Name': encodeURIComponent('héllo.txt') }, body: 'hello' })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
    expect(body.attachment.name).toBe('héllo.txt')
    expect(body.attachment.size).toBe(5)
    expect(await rig.store.stagedFile(body.attachment.id)).not.toBeNull()
  })

  it('missing X-File-Name is 400', async () => {
    const res = await fetch(url(), { method: 'POST', body: 'x' })
    expect(res.status).toBe(400)
  })

  it('a malformed X-File-Name is 400', async () => {
    const res = await fetch(url(), { method: 'POST', headers: { 'X-File-Name': '%E0%A4%A' }, body: 'x' })
    expect(res.status).toBe(400)
  })

  it('answers 413 with tooBig for Content-Length > 25 MiB without reading the body', async () => {
    const body = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(
        url(),
        { method: 'POST', headers: { 'X-File-Name': 'big.bin', 'Content-Length': String(ATTACH_MAX_BYTES + 1) } },
        (res) => {
          let s = ''
          res.on('data', (d) => (s += d))
          res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(s) }))
        }
      )
      req.on('error', reject)
      req.write('only a few bytes sent, never the whole body') // the server must answer without waiting for the rest
    })
    expect(body.status).toBe(413)
    expect(body.json).toEqual({ ok: false, name: 'big.bin', error: stageErrors.tooBig('big.bin') })
  })

  it('answers 413 when a chunked body passes the limit', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1)
    const result = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(url(), { method: 'POST', headers: { 'X-File-Name': 'big.bin' } }, (res) => {
        let s = ''
        res.on('data', (d) => (s += d))
        res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(s) }))
      })
      req.on('error', (e) => {
        // The server may reset the connection after answering; the response handler above already ran then.
        if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET' && (e as NodeJS.ErrnoException).code !== 'EPIPE') reject(e)
      })
      let sent = 0
      const pump = (): void => {
        while (sent < 30) {
          sent++
          if (!req.write(chunk)) return void req.once('drain', pump)
          if (req.destroyed) return
        }
        req.end()
      }
      pump()
    })
    expect(result.status).toBe(413)
    expect(result.json).toEqual({ ok: false, name: 'big.bin', error: stageErrors.tooBig('big.bin') })
  })

  it('stages nothing for an oversized upload', async () => {
    await expectTooLarge(fetch(url(), { method: 'POST', headers: { 'X-File-Name': 'big.bin' }, body: Buffer.alloc(ATTACH_MAX_BYTES + 1) }))
    expect(await readdir(join(rig.root, 'att', '.staged')).catch(() => [])).toEqual([])
  })
})

describe('origin check on writes', () => {
  const gate = (originOk: boolean) => ({ authorize: async () => true, originOk: async () => originOk, handle: async () => false })

  it('POST with a bad origin is 403 and stages nothing', async () => {
    await rig.close()
    rig = await startRig({ gate: gate(false) })
    const res = await fetch(url(), { method: 'POST', headers: { 'X-File-Name': 'a.txt' }, body: 'hello' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Bad origin' })
    expect(await readdir(join(rig.root, 'att', '.staged')).catch(() => [])).toEqual([])
  })

  it('POST with a good origin works, and GET never needs the origin', async () => {
    await rig.close()
    rig = await startRig({ gate: gate(true) })
    expect((await fetch(url(), { method: 'POST', headers: { 'X-File-Name': 'a.txt' }, body: 'hello' })).status).toBe(200)
    await rig.close()
    rig = await startRig({ gate: gate(false) })
    expect((await fetch(`${rig.base}/`)).status).toBe(200)
  })
})
