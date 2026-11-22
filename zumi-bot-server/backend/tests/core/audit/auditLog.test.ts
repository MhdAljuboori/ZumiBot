import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { AuditRecord } from '@zumibot/shared/audit'
import { AuditLog } from '../../../src/core/audit/auditLog'

let dir: string
let t: number
let seq: number

const rec = (o: Partial<AuditRecord> = {}): Omit<AuditRecord, 'prev'> => ({
  v: 1,
  id: `id${++seq}`,
  ts: t++,
  durationMs: 5,
  machine: 'm1',
  chatId: 'c1',
  itemId: 'i',
  turnId: null,
  agent: 'helper',
  subagent: null,
  parentToolUseId: null,
  engine: 'claude',
  runKind: 'chat',
  mode: 'auto',
  isolation: 'off',
  tool: 'Bash',
  input: { command: 'ls' },
  inputCut: null,
  decision: { kind: 'allowedByMode' },
  outcome: 'ok',
  error: null,
  ...o
})
const make = (o: { fileMax?: number; capOverride?: number } = {}) =>
  new AuditLog({ dir: join(dir, 'audit'), machine: 'm1', now: () => t, ...o })

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-audit-log-'))
  t = Date.UTC(2026, 10, 17, 12)
  seq = 0
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('AuditLog', () => {
  it('writes 0700 folder and 0600 files, newest first in pages, each record found again by its place', async () => {
    const log = make()
    await log.start()
    for (let i = 0; i < 5; i++) await log.append(rec({ tool: i % 2 ? 'Read' : 'Bash' }))
    if (process.platform !== 'win32') expect(statSync(join(dir, 'audit')).mode & 0o777).toBe(0o700)
    const files = (await fs.readdir(join(dir, 'audit'))).filter((f) => f.endsWith('.jsonl'))
    if (process.platform !== 'win32') expect(statSync(join(dir, 'audit', files[0])).mode & 0o777).toBe(0o600)
    const p1 = await log.list({}, null, 2)
    expect(p1.rows.map((r) => r.id)).toEqual(['id5', 'id4'])
    const p2 = await log.list({}, p1.next, 2)
    expect(p2.rows.map((r) => r.id)).toEqual(['id3', 'id2'])
    // A record appended meanwhile never shifts an open cursor.
    await log.append(rec())
    const p3 = await log.list({}, p2.next, 2)
    expect(p3.rows.map((r) => r.id)).toEqual(['id1'])
    expect(p3.next).toBeNull()
    expect((await log.get('id3', p2.rows[0].at))?.id).toBe('id3')
    expect(await log.get('id2', p2.rows[0].at)).toBeNull()
    expect(await log.get('id3', '../../etc/passwd:0')).toBeNull()
    expect((await log.list({ tool: 'Read' }, null, 10)).rows.map((r) => r.id)).toEqual(['id4', 'id2'])
    expect((await log.list({ q: 'LS' }, null, 10)).rows).toHaveLength(6)
    await expect(log.list({}, 'nope', 10)).rejects.toThrow(/cursor/)
  })

  it('rotates by size, chains across files, and the cap drops whole oldest files', async () => {
    const log = make({ fileMax: 600, capOverride: 2000 })
    await log.start()
    for (let i = 0; i < 30; i++) await log.append(rec())
    const files = (await fs.readdir(join(dir, 'audit'))).filter((f) => f.endsWith('.jsonl')).sort()
    expect(files.length).toBeGreaterThan(1)
    expect(log.status().bytes).toBeLessThanOrEqual(2000 + 600)
    // The oldest records are gone with their files; the newest stays.
    const all: string[] = []
    for await (const r of log.each()) all.push(r.id)
    expect(all.at(-1)).toBe('id30')
    expect(all).not.toContain('id1')
    expect(await log.verify()).toEqual({ ok: true, files: files.length })
    expect(log.status().records).toBe(all.length)
  })

  it('a restart continues the chain; an edited or removed line breaks it', async () => {
    const log = make()
    await log.start()
    for (let i = 0; i < 4; i++) await log.append(rec())
    const again = make()
    await again.start()
    await again.append(rec())
    expect(await again.verify()).toEqual({ ok: true, files: 1 })
    const [file] = (await fs.readdir(join(dir, 'audit'))).filter((f) => f.endsWith('.jsonl'))
    const path = join(dir, 'audit', file)
    const lines = (await fs.readFile(path, 'utf8')).split('\n')
    await fs.writeFile(path, lines.map((l) => l.replace('"id2"', '"idX"')).join('\n'))
    const edited = make()
    await edited.start()
    // Line 1 is the file's head, so the second record is line 3, and the link that breaks is line 4's.
    expect(await edited.verify()).toEqual({ ok: false, file, line: 4 })
    await fs.writeFile(path, lines.filter((_, i) => i !== 2).join('\n'))
    const l2 = make()
    await l2.start()
    expect(await l2.verify()).toMatchObject({ ok: false, file })
  })

  it('a write that fails is counted, never thrown; the cap is one of the offered sizes and survives a restart', async () => {
    const log = make()
    await log.append(rec()) // not started
    expect(log.status().failures).toBe(1)
    await log.start()
    await expect(log.setCap(12345)).rejects.toThrow(/offered/)
    await log.setCap(128 * 1024 * 1024)
    const again = make()
    await again.start()
    expect(again.status().cap).toBe(128 * 1024 * 1024)
  })

  it('facets list agents, tools and chats; export streams oldest first through the filter', async () => {
    const log = make()
    await log.start()
    await log.append(rec({ agent: 'b', tool: 'Read', chatId: 'c2' }))
    await log.append(rec({ agent: 'a', decision: { kind: 'deniedByUser' }, outcome: 'denied' }))
    expect(await log.getFacets()).toEqual({ agents: ['a', 'b'], tools: ['Bash', 'Read'], chats: ['c1', 'c2'] })
    await log.append(rec({ agent: 'z' }))
    expect((await log.getFacets()).agents).toEqual(['a', 'b', 'z'])
    const out: string[] = []
    for await (const r of log.each({ decision: 'deniedByUser' })) out.push(r.agent)
    expect(out).toEqual(['a'])
  })
})
