import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createHandlers, type HandlerDeps, type Handlers } from '../../src/rpc/handlers'
import { AuditLog } from '../../src/core/audit/auditLog'
import type { AuditPage } from '@zumibot/shared/audit'

let dir: string
let log: AuditLog
let h: Handlers

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-audit-rpc-'))
  log = new AuditLog({ dir: join(dir, 'audit'), machine: 'm1', now: () => 1 })
  await log.start()
  for (const tool of ['Bash', 'Read']) {
    await log.append({
      v: 1,
      id: `id-${tool}`,
      ts: 100,
      durationMs: 1,
      machine: 'm1',
      chatId: 'c1',
      itemId: 't',
      turnId: null,
      agent: 'dev',
      subagent: null,
      parentToolUseId: null,
      engine: 'claude',
      runKind: 'chat',
      mode: 'auto',
      isolation: 'off',
      tool,
      input: {},
      inputCut: null,
      decision: { kind: 'allowedByMode' },
      outcome: 'ok',
      error: null
    })
  }
  h = createHandlers({ audit: log } as unknown as HandlerDeps)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('audit handlers', () => {
  it('lists through a checked filter and gets a row by its place', async () => {
    const page = (await h['audit:list']({ tool: 'Read' }, null, null)) as AuditPage
    expect(page.rows.map((r) => r.id)).toEqual(['id-Read'])
    expect(await h['audit:get']('id-Read', page.rows[0].at)).toMatchObject({ id: 'id-Read', tool: 'Read' })
  })

  it('refuses bad arguments', async () => {
    await expect(h['audit:list']({ decision: 'maybe' }, null)).rejects.toThrow(/decision/)
    await expect(h['audit:list']({ from: 'yesterday' }, null)).rejects.toThrow(/from/)
    await expect(h['audit:list']({ q: 'x'.repeat(301) }, null)).rejects.toThrow(/q must/)
    await expect(h['audit:list']([], null)).rejects.toThrow(/filter/)
    await expect(h['audit:list']({}, 7)).rejects.toThrow(/cursor/)
    await expect(h['audit:list']({}, null, 0)).rejects.toThrow(/limit/)
    await expect(h['audit:list']({}, null, 1000)).rejects.toThrow(/limit/)
    await expect(h['audit:get'](1, 'x')).rejects.toThrow(/id/)
    await expect(h['audit:setCap'](42)).rejects.toThrow(/cap/)
  })

  it('status, facets and verify answer; no handler clears the log', async () => {
    expect(await h['audit:status']()).toMatchObject({ machine: 'm1', records: 2 })
    expect(await h['audit:facets']()).toEqual({ agents: ['dev'], tools: ['Bash', 'Read'], chats: ['c1'] })
    expect(await h['audit:verify']()).toEqual({ ok: true, files: 1 })
    expect(
      Object.keys(h)
        .filter((k) => k.startsWith('audit:'))
        .sort()
    ).toEqual(['audit:facets', 'audit:get', 'audit:list', 'audit:setCap', 'audit:status', 'audit:verify'])
  })
})
