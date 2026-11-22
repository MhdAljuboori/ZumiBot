import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ISOLATION_OFF } from '@zumibot/shared/isolation'
import { isolationRefusal } from '@zumibot/shared/engine'
import { createHandlers, type HandlerDeps, type Handlers } from '../../src/rpc/handlers'
import {
  CODEX_CONTAINER_REFUSED,
  CODEX_ISOLATION_REFUSED,
  CODEX_SANDBOX_REFUSED,
  IsolationService
} from '../../src/core/isolation/isolationService'

let dir: string
let svc: IsolationService
let h: Handlers

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-iso-rpc-'))
  svc = new IsolationService({
    file: join(dir, 'audit', 'isolation.json'),
    home: dir,
    dataDir: join(dir, 'data'),
    keyDir: join(dir, 'key'),
    pathEnv: async () => '',
    fileHook: null,
    checkSupport: async () => ({ available: true })
  })
  await svc.start()
  const agents = {
    list: async () => [
      { name: 'dev' },
      { name: 'cx', provider: 'codex' },
      { name: 'ac', provider: 'acp' },
      { name: 'rem', provider: 'ag-ui' }
    ]
  }
  h = createHandlers({ isolation: svc, agents } as unknown as HandlerDeps)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('isolation handlers', () => {
  it('gets Off for an agent never set, and saves a checked value', async () => {
    expect(await h['isolation:get']('dev')).toEqual({ isolation: ISOLATION_OFF, refused: null })
    const v = await h['isolation:set']('dev', { level: 'sandbox', network: ['Example.com'] })
    expect(v).toMatchObject({ isolation: { level: 'sandbox', network: ['example.com'] }, refused: null })
    expect(svc.levelOf('dev')).toBe('sandbox')
  })

  it('refuses bad values, unknown agents and a sandboxed Codex agent', async () => {
    await expect(h['isolation:set']('dev', { level: 'sandbox', network: ['https://x.com/a'] })).rejects.toThrow(/host name only/)
    await expect(h['isolation:set']('dev', { level: 'maybe' })).rejects.toThrow(/level/)
    await expect(h['isolation:set'](7, { level: 'off' })).rejects.toThrow(/agent/)
    await expect(h['isolation:set']('ghost', { level: 'sandbox' })).rejects.toThrow(/No agent/)
    await expect(h['isolation:set']('cx', { level: 'sandbox' })).rejects.toThrow(CODEX_SANDBOX_REFUSED)
    await expect(h['isolation:set']('cx', { level: 'container' })).rejects.toThrow(CODEX_CONTAINER_REFUSED)
    expect(await h['isolation:get']('cx')).toMatchObject({ refused: CODEX_ISOLATION_REFUSED })
    expect(await h['isolation:set']('dev', { level: 'container', network: ['registry.npmjs.org'] })).toMatchObject({
      isolation: { level: 'container' }
    })
    expect(svc.levelOf('dev')).toBe('container')
    await h['isolation:set']('dev', { level: 'off' })
    expect(svc.levelOf('dev')).toBe('off')
  })

  it('an ACP or remote agent is offered neither level and saves only Off, each with its own sentence', async () => {
    for (const [name, engine] of [
      ['ac', 'acp'],
      ['rem', 'ag-ui']
    ] as const) {
      await expect(h['isolation:set'](name, { level: 'sandbox' })).rejects.toThrow(isolationRefusal(engine, 'sandbox'))
      await expect(h['isolation:set'](name, { level: 'container' })).rejects.toThrow(isolationRefusal(engine, 'container'))
      expect(await h['isolation:get'](name)).toEqual({ isolation: ISOLATION_OFF, refused: isolationRefusal(engine, null) })
      expect(await h['isolation:set'](name, { level: 'off' })).toEqual({
        isolation: ISOLATION_OFF,
        refused: isolationRefusal(engine, null)
      })
      expect(svc.levelOf(name)).toBe('off')
    }
  })

  it('status says whether the sandbox runs here', async () => {
    expect(await h['isolation:status'](true)).toEqual({
      sandbox: { available: true },
      container: { available: false, reason: "This server's build has no container support." },
      toolchain: [join(dir, '.gitconfig'), join(dir, '.config', 'git')]
    })
  })
})
