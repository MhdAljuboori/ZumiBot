import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BrowserFiles } from '../../src/core/browser/browserFiles'
import { BrowserFileReceiver } from '../../src/core/browser/browserFileIpc'

let root: string, files: BrowserFiles
const owner = { profileId: 'profile', generation: 'generation', viewerId: 'viewer' }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cb-file-ipc-'))
  files = new BrowserFiles(root)
  await files.clear()
  for (let n = 0; n < 2; n++)
    await files.stageDownload(
      owner,
      (async function* () {
        yield Buffer.alloc(20 * 1024 * 1024)
      })(),
      'completed'
    )
})
afterEach(async () => {
  await files.close()
  await rm(root, { recursive: true, force: true })
})
async function failedReceiver() {
  const receiver = new BrowserFileReceiver(
    {
      download: (source, name, _generation, signal) => {
        const failing = Object.assign(
          (async function* () {
            for await (const chunk of source) {
              yield chunk
              throw new Error('synthetic sink failure')
            }
          })(),
          { retainsSource: true as const, sourceId: source.sourceId }
        )
        return files.stageDownload(owner, failing, name, signal)
      },
      sourceClosed: (id) => files.sourceClosed(id)
    },
    () => owner.generation
  )
  const send = (phase: string, sequence: number, extra: object = {}) =>
    new Promise<{ error?: boolean }>((resolve) =>
      receiver.receive({ type: 'file', transferId: 'failed-transfer', phase, sequence, ...extra }, (_value, error) => resolve({ error }))
    )
  expect(await send('begin', 0, { generation: owner.generation, name: 'failed' })).toEqual({ error: undefined })
  expect(await send('chunk', 1, { bytes: Buffer.from('partial') })).toEqual({ error: true })
  expect(await readdir(root)).toHaveLength(2)
  expect(files.list(owner.profileId)).toHaveLength(2)
  return { receiver, send }
}
const replacement = () =>
  Object.assign(
    (async function* () {
      yield Buffer.from('replacement')
    })(),
    { retainsSource: true as const, sourceId: 'replacement' }
  )
it('keeps a failed transfer addressable for private cleanup without a successful public file id', async () => {
  const { send } = await failedReceiver()
  await expect(files.stageDownload(owner, replacement(), 'before-cleanup')).rejects.toThrow('limit')
  expect(await send('cleanup', -1)).toEqual({ error: undefined })
  expect((await files.stageDownload(owner, replacement(), 'after-cleanup')).size).toBe(11)
  files.sourceClosed('replacement')
})
it('retains a lost cleanup confirmation through receiver close until authoritative source cleanup', async () => {
  const { receiver } = await failedReceiver()
  receiver.close()
  await expect(files.stageDownload(owner, replacement(), 'unconfirmed-close')).rejects.toThrow('limit')
  await receiver.confirmClosed()
  expect((await files.stageDownload(owner, replacement(), 'confirmed-close')).size).toBe(11)
  files.sourceClosed('replacement')
})
