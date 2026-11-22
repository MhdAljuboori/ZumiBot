import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexInfo, listCodexModels } from '../../src/core/codex/codexInfo'
import { writeFakeBin } from '../support/fakeBin'
import { codexShim } from '../support/codexShim'

const FAKE = join(__dirname, '..', 'fixtures', 'fake-codex.mjs')

describe('createCodexInfo', () => {
  it('reports not found when codex cannot be located, without listing', async () => {
    const list = vi.fn(async () => ['m'])
    expect(await createCodexInfo({ locate: async () => null, list })()).toEqual({ found: false, models: [] })
    expect(list).not.toHaveBeenCalled()
  })

  it('retries a failed or empty list on the next call, and gives found with no models meanwhile', async () => {
    const list = vi.fn<(bin: string) => Promise<string[]>>()
    list.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([]).mockResolvedValueOnce(['gpt-a', 'gpt-b'])
    const info = createCodexInfo({ locate: async () => '/bin/codex', list })
    expect(await info()).toEqual({ found: true, models: [] })
    expect(await info()).toEqual({ found: true, models: [] })
    expect(await info()).toEqual({ found: true, models: ['gpt-a', 'gpt-b'] })
    expect(list).toHaveBeenCalledWith('/bin/codex')
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('does not fetch a successful list again', async () => {
    const list = vi.fn(async () => ['gpt-a'])
    const info = createCodexInfo({ locate: async () => '/bin/codex', list })
    await info()
    expect(await info()).toEqual({ found: true, models: ['gpt-a'] })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('shares one list between calls made at the same time', async () => {
    let release: (m: string[]) => void = () => {}
    const list = vi.fn(
      () =>
        new Promise<string[]>((r) => {
          release = r
        })
    )
    const info = createCodexInfo({ locate: async () => '/bin/codex', list })
    const a = info(),
      b = info()
    await new Promise((r) => setTimeout(r, 5))
    release(['gpt-a'])
    expect(await a).toEqual({ found: true, models: ['gpt-a'] })
    expect(await b).toEqual({ found: true, models: ['gpt-a'] })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('a locate that throws counts as not found', async () => {
    expect(
      await createCodexInfo({
        locate: async () => {
          throw new Error('x')
        },
        list: async () => ['m']
      })()
    ).toEqual({ found: false, models: [] })
  })
})

describe('listCodexModels', () => {
  let dir: string
  let bin: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-codexinfo-'))
    // The fake is an .mjs run through node; a fake bin makes it a binary like `codex`.
    bin = writeFakeBin(dir, 'codex', FAKE)
  })
  // Retries: on Windows the killed fake can hold its folder for a moment.
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

  it('returns the visible models only', async () => {
    expect(await listCodexModels(bin)).toEqual(['gpt-fake-a', 'gpt-fake-b'])
  })

  it('follows nextCursor', async () => {
    expect(await listCodexModels(bin, { env: { ...process.env, FAKE_CODEX_MODELS_PAGED: '1' } })).toEqual(['gpt-fake-a', 'gpt-fake-c'])
  })

  it('gives up after the timeout and kills the process', async () => {
    const pidFile = join(dir, 'pid')
    // Node's own pid: on Windows the bin is a launcher, and the fake must end with it.
    const wrap = codexShim(dir, 'codex-hang', FAKE, `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n`)
    // Windows starts the launcher and then node, which a busy machine can take longer than 300 ms to do; so can an Intel Mac
    // running the suite.
    const timeoutMs = process.platform === 'win32' || process.platform === 'darwin' ? 3000 : 300
    await expect(listCodexModels(wrap, { timeoutMs, env: { ...process.env, FAKE_CODEX_MODELS_HANG: '1' } })).rejects.toThrow(
      'Codex did not answer'
    )
    const { readFileSync } = await import('node:fs')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    // Windows: node ends with the killed launcher's job, which a busy machine can take a moment longer to close.
    for (let waited = 0; waited < (process.platform === 'win32' ? 3000 : 100); waited += 50) {
      await new Promise((r) => setTimeout(r, 50))
      if (process.platform !== 'win32') continue
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
    }
    expect(() => process.kill(pid, 0)).toThrow() // gone
  })

  it('fails when the binary does not exist', async () => {
    await expect(listCodexModels(join(dir, 'nope'))).rejects.toThrow()
  })
})
