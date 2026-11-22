import { readdirSync, readlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startRig, type Rig } from './helpers'

let rig: Rig
afterEach(() => rig.close())

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const openFds = (needle: string): number =>
  readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`).includes(needle)
    } catch {
      return false
    }
  }).length

// Aborts after the first bytes and checks the server let go of the file.
async function abortAfterFirstChunk(port: number, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      res.once('data', () => {
        req.destroy()
        resolve()
      })
    })
    req.on('error', () => {})
    req.on('close', () => resolve())
    req.end()
    setTimeout(() => reject(new Error('no data')), 3000)
  })
}

// Open files are counted through /proc, which Windows and macOS have not.
describe.skipIf(process.platform !== 'linux')('aborted downloads', () => {
  it('release the attachment file', async () => {
    rig = await startRig()
    const r = await rig.store.stageBytes('big.bin', Buffer.alloc(20 * 1024 * 1024, 1))
    if (!r.ok) throw new Error(r.error)
    await abortAfterFirstChunk(rig.port, `/api/attachments/staged/${r.attachment.id}`)
    await sleep(300)
    expect(openFds('big.bin')).toBe(0)
  })

  it('release the static file', async () => {
    rig = await startRig()
    await writeFile(join(rig.webDir, 'assets', 'huge-abc.js'), Buffer.alloc(20 * 1024 * 1024, 1))
    await abortAfterFirstChunk(rig.port, '/assets/huge-abc.js')
    await sleep(300)
    expect(openFds('huge-abc.js')).toBe(0)
  })
})
