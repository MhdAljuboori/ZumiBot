import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BrowserFiles } from '../../src/core/browser/browserFiles'
import { ATTACH_MAX_BYTES } from '@zumibot/shared/attachments'

let root: string, now: number, files: BrowserFiles
const owner = { profileId: 'profile', generation: 'generation', viewerId: 'viewer' }
async function* bytes(size = 5) {
  yield Buffer.alloc(size, 97)
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cb-browser-files-'))
  now = 0
  files = new BrowserFiles(root, { now: () => now })
  await files.clear()
})
afterEach(async () => {
  await files.close()
  await rm(root, { recursive: true, force: true })
})
it('sanitizes hostile names and returns opaque metadata while keeping paths internal', async () => {
  const file = await files.stageDownload(owner, bytes(), '../../evil\\file\n.txt')
  expect(file).toEqual({ id: expect.stringMatching(/^[a-z0-9-]+$/), name: 'file_.txt', size: 5 })
  const internal = await files.download(file.id)
  expect(internal?.path.startsWith(root + sep)).toBe(true)
  expect(await readFile(internal!.path, 'utf8')).toBe('aaaaa')
})
it('stops consuming oversized streaming transfers and removes every partial byte', async () => {
  let consumed = 0
  async function* source() {
    for (let i = 0; i < 30; i++) {
      consumed++
      yield Buffer.alloc(1024 * 1024)
    }
  }
  await expect(files.stageDownload(owner, source(), 'large')).rejects.toThrow('limit')
  expect(consumed).toBe(26)
  expect(await readdir(root)).toEqual([])
})
it('caps profile bytes at 100 MiB as data arrives and reserves concurrent file slots', async () => {
  for (let i = 0; i < 4; i++) await files.stageDownload(owner, bytes(ATTACH_MAX_BYTES), 'full')
  await expect(files.stageDownload(owner, bytes(1), 'overflow')).rejects.toThrow('limit')
  expect(files.list(owner.profileId)).toHaveLength(4)
  await files.clear()
  for (let i = 0; i < 10; i++) await files.stageDownload(owner, bytes(), 'small')
  await expect(files.stageDownload(owner, bytes(), 'eleventh')).rejects.toThrow('limit')
})
it('binds native picker uploads to actual viewer/profile/generation and rejects paths/download IDs', async () => {
  const upload = await files.stageUpload(owner, bytes(), 'upload.txt')
  expect(await files.resolveUpload(owner, [upload.id])).toEqual([expect.stringMatching(/upload.txt$/)])
  for (const bad of [
    { ...owner, profileId: 'other' },
    { ...owner, generation: 'other' },
    { ...owner, viewerId: 'other' }
  ]) {
    await expect(files.resolveUpload(bad, [upload.id])).rejects.toThrow('unavailable')
  }
  await expect(files.resolveUpload(owner, ['/etc/passwd'])).rejects.toThrow('unavailable')
  const download = await files.stageDownload(owner, bytes(), 'download')
  await expect(files.resolveUpload(owner, [download.id])).rejects.toThrow('unavailable')
})
it('permits agent uploads only via its explicit chat attachment authorization', async () => {
  const agent = { profileId: 'profile', generation: 'generation', chatId: 'chat', turnId: 'turn' }
  const service = new BrowserFiles(root, {
    attached: async (o, id) => (o.chatId === 'chat' && id === 'attached' ? '/internal/chat/file' : null)
  })
  expect(await service.resolveUpload(agent, ['attached'])).toEqual(['/internal/chat/file'])
  await expect(service.resolveUpload(agent, ['unattached'])).rejects.toThrow('unavailable')
  await service.discardTurn('turn')
  await service.close()
})
it('cleans partial transfers on abort, expires downloads at one hour and never revives after restart', async () => {
  async function* aborted() {
    yield Buffer.from('partial')
    throw new Error('aborted')
  }
  await expect(files.stageDownload(owner, aborted(), 'partial')).rejects.toThrow('aborted')
  expect(await readdir(root)).toEqual([])
  const file = await files.stageDownload(owner, bytes(), 'download')
  now = 3600000
  expect(await files.download(file.id)).toBeNull()
  expect(await readdir(root)).toEqual([])
  const next = await files.stageDownload(owner, bytes(), 'next')
  const restarted = new BrowserFiles(root)
  expect(await restarted.download(next.id)).toBeNull()
  await restarted.clear()
  expect(await readdir(root)).toEqual([])
  await restarted.close()
})
it('aborts a stalled source and removes its partial file without waiting for another chunk', async () => {
  const abort = new AbortController()
  async function* stalled() {
    yield Buffer.from('partial')
    await new Promise(() => {})
    yield Buffer.from('unreachable')
  }
  const pending = files.stageUpload(owner, stalled(), 'stalled', abort.signal)
  await new Promise((resolve) => setTimeout(resolve, 10))
  abort.abort()
  await expect(pending).rejects.toThrow('unavailable')
  expect(await readdir(root)).toEqual([])
})
it('bounds hostile Unicode filenames by UTF-8 bytes without breaking characters', async () => {
  const file = await files.stageDownload(owner, bytes(), 'ع'.repeat(300) + '.txt')
  expect(Buffer.byteLength(file.name)).toBeLessThanOrEqual(180)
  expect(file.name).not.toContain('\ufffd')
  expect(await files.download(file.id)).not.toBeNull()
})
it('reserves both worker source and staged copy until source cleanup is acknowledged', async () => {
  for (let i = 0; i < 2; i++) await files.stageDownload(owner, bytes(20 * 1024 * 1024), 'completed')
  const retained = () => Object.assign(bytes(1024 * 1024), { retainsSource: true as const })
  const first = await files.stageDownload(owner, retained(), 'source-retained')
  await expect(files.stageDownload(owner, retained(), 'second')).rejects.toThrow('limit')
  files.sourceClosed(first.id)
  const second = await files.stageDownload(owner, retained(), 'source-released')
  expect(second.size).toBe(1024 * 1024)
  files.sourceClosed(second.id)
})

// Windows cannot remove a folder while a transfer still holds a file in it open, so cleanup races there (the agent
// browser is Linux-only).
it.skipIf(process.platform !== 'linux').each(['error', 'abort', 'turn', 'expiry', 'clear'] as const)(
  'retains failed source accounting through %s until cleanup confirmation while deleting staged partials',
  async (kind) => {
    for (let n = 0; n < 2; n++) await files.stageDownload(owner, bytes(20 * 1024 * 1024), 'completed')
    const abort = new AbortController(),
      turnOwner = { profileId: owner.profileId, generation: owner.generation, chatId: 'chat', turnId: 'failed-turn' }
    let started!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    const source = Object.assign(
      (async function* () {
        yield Buffer.from('partial')
        started()
        await gate
        if (kind === 'error') throw new Error('source failed')
        await new Promise(() => {})
      })(),
      { retainsSource: true as const, sourceId: 'failed-source' }
    )
    const transfer = files.stageDownload(turnOwner, source, 'failed', abort.signal)
    const rejected = expect(transfer).rejects.toThrow()
    await ready
    if (kind === 'error') release()
    else if (kind === 'turn') await files.discardTurn(turnOwner.turnId)
    else if (kind === 'expiry') {
      now = 3600000
      await files.download('expired-probe')
    } else if (kind === 'clear') await files.clear()
    else abort.abort()
    await rejected
    expect(files.list(owner.profileId).some((f) => f.name === 'failed')).toBe(false)
    expect((await readdir(root)).length).toBe(kind === 'expiry' || kind === 'clear' ? 0 : 2)
    const replacement = () => Object.assign(bytes(1), { retainsSource: true as const, sourceId: 'replacement' })
    // Completed downloads may expire, so re-establish the same 40 MiB baseline.
    if (kind === 'expiry' || kind === 'clear')
      for (let n = 0; n < 2; n++) await files.stageDownload(owner, bytes(20 * 1024 * 1024), 'completed-new')
    await expect(files.stageDownload(owner, replacement(), 'replacement-before-cleanup')).rejects.toThrow('limit')
    now += 3600000
    await files.download('lost-cleanup-confirmation')
    // Expiring the public ID cannot release an unconfirmed physical source.
    for (let n = 0; n < 2; n++) await files.stageDownload(owner, bytes(20 * 1024 * 1024), 'completed-after-expiry')
    await expect(files.stageDownload(owner, replacement(), 'replacement-after-expiry')).rejects.toThrow('limit')
    files.sourceClosed('failed-source')
    expect((await files.stageDownload(owner, replacement(), 'replacement-after-cleanup')).size).toBe(1)
    files.sourceClosed('replacement')
    release()
  },
  3000
)
