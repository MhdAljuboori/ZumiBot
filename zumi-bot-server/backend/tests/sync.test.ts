import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SideQuestion } from '@zumibot/shared/btw'

// node:fs passes every call through. While `on`, it records which paths are flushed and renamed, in order;
// `failRename` can make one rename fail, and `sizeLimit` gives a path a file-size limit, as `ulimit -f` does: a write
// there stops at the limit and returns the shorter count with no error, and the next one fails with EFBIG.
const fsTrace = vi.hoisted(() => ({
  on: false,
  ops: [] as string[],
  failRename: null as ((from: string, to: string) => boolean) | null,
  sizeLimit: null as ((path: string) => number | undefined) | null,
  // A close that releases the descriptor and still reports an error, as close(2) may after a delayed write error.
  failClose: null as ((path: string) => boolean) | null
}))
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>()
  const paths = new Map<number, string>()
  return {
    ...fs,
    openSync: (...a: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...a)
      paths.set(fd, String(a[0]))
      return fd
    },
    fsyncSync: (fd: number) => {
      if (fsTrace.on) fsTrace.ops.push(`fsync ${paths.get(fd)}`)
      return fs.fsyncSync(fd)
    },
    writeSync: (fd: number, data: string | NodeJS.ArrayBufferView, ...rest: number[]) => {
      const limit = fsTrace.sizeLimit?.(paths.get(fd) ?? '')
      if (limit === undefined) return (fs.writeSync as (...a: unknown[]) => number)(fd, data, ...rest)
      const offset = typeof data === 'string' ? 0 : (rest[0] ?? 0)
      const all =
        typeof data === 'string'
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset + offset, rest[1] ?? data.byteLength - offset)
      const room = limit - fs.fstatSync(fd).size
      if (room <= 0) throw Object.assign(new Error('EFBIG: file too large, write'), { code: 'EFBIG' })
      return fs.writeSync(fd, all.subarray(0, room))
    },
    closeSync: (fd: number) => {
      const path = paths.get(fd) ?? ''
      fs.closeSync(fd)
      if (fsTrace.failClose?.(path)) throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' })
    },
    renameSync: (from: string, to: string) => {
      if (fsTrace.failRename?.(String(from), String(to))) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      if (fsTrace.on) fsTrace.ops.push(`rename ${from} ${to}`)
      return fs.renameSync(from, to)
    }
  }
})
import {
  disableChannels,
  disableRoutines,
  disableWorkflows,
  mergeChatFiles,
  mergeChats,
  mergeDispatch,
  mergeItems,
  mergeSide,
  mergeTodos,
  mergeUsageRecords,
  mergeWorkflowMessages,
  stopUnfinishedWorkflowRuns,
  sync,
  unionHistory
  // @ts-expect-error plain .mjs script, no types (on the line the error is reported at)
} from '../../deploy/sync.mjs'
// @ts-expect-error plain .mjs script, no types
import { keyIdOf, mergeVault, openItem, opensWith, planVaultKeys, resealFile, sealItem } from '../../deploy/vaultSync.mjs'
// @ts-expect-error plain .mjs script, no types
import { parseEnvFile, realRun, vaultKeyFileOf } from '../../deploy/config.mjs'
import { resolveVaultKeyFile } from '../src/config'

type Item = { id: string; type: string; ts?: number; text?: string }
type Result = { code: number; stdout: string; stderr: string }
type Call = { cmd: string; args: string[]; input?: string }
type VItem = { id: string; updatedAt: number; deleted: boolean; sealed: string | null }
type VFile = { v: 1; keyId: string; items: VItem[] }

// vault.json fixtures in the server's format: each item's body carries its own id and time, like VaultStore's.
const vBody = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  updatedAt,
  kind: 'login',
  name: id,
  agents: [],
  ...extra
})
const vLive = (key: Buffer, id: string, updatedAt: number, extra: Record<string, unknown> = {}): VItem => ({
  id,
  updatedAt,
  deleted: false,
  sealed: sealItem(key, id, updatedAt, vBody(id, updatedAt, extra)) as string
})
const vTomb = (id: string, updatedAt: number): VItem => ({ id, updatedAt, deleted: true, sealed: null })
const vFile = (key: Buffer, items: VItem[]): VFile => ({ v: 1, keyId: keyIdOf(key) as string, items })
const vShape = (f: VFile | null) => f && f.items.map((i) => [i.id, i.updatedAt, i.deleted])

const u = (id: string, ts: number, text = id): Item => ({ id, type: 'user', ts, text })
const tItem = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: id,
  group: null,
  from: { turn: 't', itemId: 'a', label: 'Reply', at: 1 },
  addedBy: 'a',
  done: null,
  removed: null,
  last: { action: 'added', by: 'a', at: 1 },
  rev: 1,
  updatedAt: 1,
  ...over
})
const tFile = (items: ReturnType<typeof tItem>[], rev = 1, seen: Record<string, number> = {}) => ({ v: 1, rev, items, seen })
// Workflow runs as the server stores them (Record<workflowId, WorkflowRun[]>), trimmed to what the sync reads.
const wfVisit = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  stepId: id,
  n: 1,
  status,
  input: '',
  inputs: [],
  startedAt: 1,
  ...extra
})
const wfRun = (id: string, status: string, visits: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  workflowId: 'w',
  via: 'manual',
  late: false,
  status,
  snapshot: { steps: [], edges: [] },
  visits,
  inbox: {},
  allowance: { perStep: {}, total: 200 },
  halted: false,
  startedAt: 1,
  ...extra
})
const vpsRuns = () => ({
  w: [
    wfRun('running', 'running', [
      wfVisit('t', 'done', { endedAt: 2 }),
      wfVisit('llm', 'running'),
      wfVisit('wait', 'running', { until: 9 })
    ]),
    wfRun('waiting', 'waiting', [wfVisit('ok', 'waiting'), wfVisit('agent', 'waiting', { chatId: 'c1', messageId: 'm1' })]),
    wfRun('done', 'done', [wfVisit('t', 'done', { endedAt: 2 })], { endedAt: 3 }),
    wfRun('failed', 'failed', [wfVisit('x', 'failed', { endedAt: 4, error: 'Boom' })], { endedAt: 4, error: 'Boom' })
  ]
})
const side = (id: string, patch: Partial<SideQuestion> = {}): SideQuestion => ({
  id,
  question: id,
  agent: 'a',
  askedAt: 1,
  after: null,
  state: 'done',
  answer: id,
  endedAt: 10,
  ...patch
})

describe('mergeDispatch', () => {
  const e = (id: string, updatedAt: number, startedAt = 1, extra: object = {}) => ({
    id,
    parent: null,
    turn: 't',
    description: id,
    subagentType: null,
    prompt: 'p',
    status: 'done',
    now: null,
    usage: { tokens: null, toolUses: null, durationMs: null },
    steps: [],
    report: null,
    startedAt,
    endedAt: 2,
    updatedAt,
    ...extra
  })
  const f = (entries: object[]) => ({ v: 1, entries })
  it('mergeDispatch joins by id and later updatedAt wins', () => {
    const out = mergeDispatch(f([e('a', 5, 1, { status: 'running' }), e('b', 1)]), f([e('a', 9, 1, { status: 'done' }), e('c', 1, 3)]))
    expect(out.entries.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([
      ['a', 'done'],
      ['b', 'done'],
      ['c', 'done']
    ])
  })
  it('a tie goes to this PC', () => {
    const out = mergeDispatch(f([e('a', 5, 1, { description: 'pc' })]), f([e('a', 5, 1, { description: 'vps' })]))
    expect(out.entries[0].description).toBe('pc')
  })
  it('mergeDispatch applies the 200 cap by newest start', () => {
    const local = Array.from({ length: 150 }, (_, i) => e(`l${i}`, 1, 1000 + i))
    const vps = Array.from({ length: 150 }, (_, i) => e(`v${i}`, 1, i))
    const out = mergeDispatch(f(local), f(vps))
    expect(out.entries).toHaveLength(200)
    expect(out.entries.some((x: { id: string }) => x.id === 'v0')).toBe(false)
    expect(out.entries.some((x: { id: string }) => x.id === 'v149')).toBe(true)
  })
  it('mergeDispatch applies the byte budget like the server', () => {
    const big = (id: string, startedAt: number) => e(id, 1, startedAt, { report: 'r'.repeat(Math.floor(10_000_000 / 3)) })
    const out = mergeDispatch(f([big('old', 1), big('new', 3)]), f([big('mid', 2), big('newest', 4)]))
    expect(out.entries.map((x: { id: string }) => x.id).sort()).toEqual(['new', 'newest'])
  })
  it('null side returns the other, both null returns null', () => {
    expect(mergeDispatch(null, f([e('a', 1)])).entries.map((x: { id: string }) => x.id)).toEqual(['a'])
    expect(mergeDispatch(f([e('b', 1)]), null).entries.map((x: { id: string }) => x.id)).toEqual(['b'])
    expect(mergeDispatch(null, null)).toBeNull()
  })
})

describe('mergeTodos', () => {
  const gone = { at: 9, by: 'user' }

  it('keeps a removal made on either side', () => {
    const live = tItem('x', { updatedAt: 5 })
    const tomb = tItem('x', { removed: gone, updatedAt: 9 })
    // the winner is restamped with the merged rev (2), everything else stays
    expect(mergeTodos(tFile([live]), tFile([tomb])).items).toEqual([{ ...tomb, rev: 2 }])
    expect(mergeTodos(tFile([tomb]), tFile([live])).items).toEqual([{ ...tomb, rev: 2 }])
  })

  it("keeps each machine's comments on a card whichever copy wins", () => {
    const pc = tItem('x', { updatedAt: 9, comments: [{ id: 'a', text: 'from the pc', by: 'user', at: 9 }] })
    const vps = tItem('x', { updatedAt: 5, comments: [{ id: 'b', text: 'from the vps', by: 'dev', at: 5 }] })
    expect(mergeTodos(tFile([pc]), tFile([vps])).items[0].comments.map((c: { id: string }) => c.id)).toEqual(['b', 'a'])
    expect(mergeTodos(tFile([vps]), tFile([pc])).items[0].comments.map((c: { id: string }) => c.id)).toEqual(['b', 'a'])
  })

  it('later updatedAt wins a tick/untick race, a tie goes to this PC', () => {
    const ticked = tItem('x', { done: { at: 6, by: 'user' }, updatedAt: 6 })
    const unticked = tItem('x', { updatedAt: 8 })
    expect(mergeTodos(tFile([ticked]), tFile([unticked])).items).toEqual([{ ...unticked, rev: 2 }])
    expect(mergeTodos(tFile([unticked]), tFile([ticked])).items).toEqual([{ ...unticked, rev: 2 }])
    const pcTie = tItem('x', { text: 'pc', updatedAt: 8 })
    const vpsTie = tItem('x', { text: 'vps', updatedAt: 8 })
    expect(mergeTodos(tFile([pcTie]), tFile([vpsTie])).items).toEqual([{ ...pcTie, rev: 2 }])
  })

  it('unions items by id and bumps rev past both', () => {
    const m = mergeTodos(tFile([tItem('a'), tItem('b')], 4), tFile([tItem('b'), tItem('c')], 6))
    expect(m.items.map((i: { id: string }) => i.id).sort()).toEqual(['a', 'b', 'c'])
    expect(m.rev).toBe(7)
    expect(m.v).toBe(1)
  })

  it('seen takes the smaller rev and is absent when a side lacks it', () => {
    const m = mergeTodos(tFile([tItem('a')], 5, { x: 4, y: 2, onlyPc: 3 }), tFile([tItem('b')], 5, { x: 3, y: 5, onlyVps: 1 }))
    expect(m.seen).toEqual({ x: 3, y: 2 })
  })

  it('restamps an item the sides disagree about so changesSince still reports it', () => {
    // PC counter at 10 with its agent caught up; the VPS changed an item at rev 4 on a counter at 5.
    const pc = tFile([tItem('a', { rev: 9, updatedAt: 5 })], 10, { x: 10 })
    const vps = tFile(
      [tItem('a', { rev: 9, updatedAt: 5 }), tItem('b', { rev: 4, updatedAt: 7, last: { action: 'ticked', by: 'user', at: 7 } })],
      5,
      { x: 5 }
    )
    const m = mergeTodos(pc, vps)
    expect(m.rev).toBe(11)
    expect(m.seen).toEqual({ x: 5 })
    const b = m.items.find((i: { id: string }) => i.id === 'b')
    expect(b).toMatchObject({ rev: 11, updatedAt: 7, last: { action: 'ticked', by: 'user', at: 7 } })
    expect(m.items.filter((i: { rev: number }) => i.rev > m.seen.x).map((i: { id: string }) => i.id)).toContain('b')
  })

  it('items identical on both sides keep their rev, a one-sided item is restamped', () => {
    const same = tItem('same', { rev: 2 })
    const m = mergeTodos(tFile([same, tItem('pc', { rev: 3 })], 6), tFile([same, tItem('vps', { rev: 1 })], 4))
    const rev = (id: string) => m.items.find((i: { id: string }) => i.id === id).rev
    expect(m.rev).toBe(7)
    expect([rev('same'), rev('pc'), rev('vps')]).toEqual([2, 7, 7])
  })

  it('merging the merged output with itself changes nothing', () => {
    const m = mergeTodos(tFile([tItem('a', { rev: 3 })], 6, { x: 2 }), tFile([tItem('b', { rev: 1 })], 4, { x: 3 }))
    expect(mergeTodos(m, structuredClone(m))).toEqual(m)
  })

  it('handles a missing side and leaves identical sides unbumped', () => {
    expect(mergeTodos(null, null)).toBeNull()
    const f = tFile([tItem('a')], 3, { x: 2 })
    // one side only: the item is restamped with the merged rev
    expect(mergeTodos(f, null)).toMatchObject({ rev: 4, items: [{ ...f.items[0], rev: 4 }], seen: {} })
    expect(mergeTodos(null, f)).toMatchObject({ rev: 4, items: [{ ...f.items[0], rev: 4 }], seen: {} })
    // a second sync of the same state must not keep raising rev
    expect(mergeTodos(f, structuredClone(f))).toEqual(f)
  })
})

describe('mergeWorkflowMessages', () => {
  const NOW = 2_000_000_000_000
  const DAY = 86_400_000
  const m = (id: string, o: Record<string, unknown> = {}) => ({
    id,
    workflowId: 'w',
    workflowName: 'W',
    runId: 'r',
    stepName: 's',
    title: `t-${id}`,
    at: 1000,
    updatedAt: 1000,
    ...o
  })
  const mf = (messages: unknown[], seenAt = 0) => ({ v: 1 as const, seenAt, messages })
  const ids = (f: { messages: { id: string }[] }) => f.messages.map((x) => x.id)

  it('joins messages from both sides', () => {
    expect(ids(mergeWorkflowMessages(mf([m('a'), m('b')]), mf([m('b'), m('c')]), NOW))).toEqual(['a', 'b', 'c'])
  })
  it('a delete beats an older archive', () => {
    const archived = m('x', { archivedAt: 1500, updatedAt: 1500 })
    const deleted = m('x', { deletedAt: NOW - 1000, updatedAt: NOW - 1000 })
    expect(mergeWorkflowMessages(mf([archived]), mf([deleted]), NOW).messages).toEqual([deleted])
    expect(mergeWorkflowMessages(mf([deleted]), mf([archived]), NOW).messages).toEqual([deleted])
  })
  it('a tombstone keeps a message deleted when the other side still has it', () => {
    const live = m('x', { updatedAt: 5 })
    const tomb = m('x', { deletedAt: NOW - 1000, updatedAt: NOW - 1000 })
    for (const f of [mergeWorkflowMessages(mf([live]), mf([tomb]), NOW), mergeWorkflowMessages(mf([tomb]), mf([live]), NOW)]) {
      expect(f.messages).toEqual([tomb])
    }
  })
  it('a tie goes to this PC', () => {
    const pc = m('x', { title: 'pc', updatedAt: 7 })
    const vps = m('x', { title: 'vps', updatedAt: 7 })
    expect(mergeWorkflowMessages(mf([pc]), mf([vps]), NOW).messages).toEqual([pc])
  })
  it('later seenAt wins', () => {
    expect(mergeWorkflowMessages(mf([], 5), mf([], 9), NOW).seenAt).toBe(9)
    expect(mergeWorkflowMessages(mf([], 9), mf([], 5), NOW).seenAt).toBe(9)
  })
  it('cap applies after the join', () => {
    const a = Array.from({ length: 300 }, (_, i) => m(`a${i}`, { at: i * 2 }))
    const b = Array.from({ length: 300 }, (_, i) => m(`b${i}`, { at: i * 2 + 1 }))
    const f = mergeWorkflowMessages(mf(a), mf(b), NOW)
    expect(f.messages).toHaveLength(500)
    // The oldest 100 of the 600 are the ones dropped.
    expect(f.messages.every((x: { at: number }) => x.at >= 100)).toBe(true)
  })
  it('prunes tombstones like the server: strips old text and drops year-old ones', () => {
    const stale = m('s', { deletedAt: NOW - 120_000, updatedAt: NOW - 120_000, body: 'secret' })
    const ancient = m('o', { deletedAt: NOW - 366 * DAY, updatedAt: NOW - 366 * DAY })
    const f = mergeWorkflowMessages(mf([stale, ancient]), null, NOW)
    expect(f.messages).toEqual([{ ...m('s', { deletedAt: NOW - 120_000, updatedAt: NOW - 120_000 }), title: '' }])
  })
  it('drops entries a hand edit left unreadable, so NaN never reaches pruning', () => {
    const f = mergeWorkflowMessages(
      mf([m('ok'), m('', {}), { ...m('bad-at'), at: 'x' }, { ...m('bad-up'), updatedAt: null }, null, 'junk']),
      mf([{ ...m('nan'), at: NaN }, m('ok2')]),
      NOW
    )
    expect(ids(f)).toEqual(['ok', 'ok2'])
  })
  it('one side alone is pruned and kept; null and null give null', () => {
    expect(ids(mergeWorkflowMessages(mf([m('a')], 3), null, NOW))).toEqual(['a'])
    expect(mergeWorkflowMessages(null, mf([m('a')], 3), NOW)).toEqual(mf([m('a')], 3))
    expect(mergeWorkflowMessages(null, null, NOW)).toBeNull()
  })
  it('is stable: joining a result with itself changes nothing', () => {
    const f = mergeWorkflowMessages(mf([m('a'), m('b', { deletedAt: NOW - 10, updatedAt: NOW - 10 })], 2), mf([m('c')], 4), NOW)
    expect(mergeWorkflowMessages(f, structuredClone(f), NOW)).toEqual(f)
  })
})

describe('mergeSide', () => {
  it('joins by id and orders by askedAt without changing either input', () => {
    const local = [side('late', { askedAt: 3 }), side('shared', { askedAt: 2 })]
    const vps = [side('first'), side('shared', { askedAt: 2, answer: 'remote' })]
    const before = structuredClone({ local, vps })
    expect(mergeSide(local, vps)).toEqual([side('first'), side('shared', { askedAt: 2 }), side('late', { askedAt: 3 })])
    expect({ local, vps }).toEqual(before)
    expect(mergeSide(null, null)).toEqual([])
    expect(mergeSide(null, vps)).toEqual([vps[0], vps[1]])
    expect(mergeSide(local, null)).toEqual([local[1], local[0]])
  })

  it.each(['done', 'error', 'stopped'] as const)('prefers finished %s over either open state in both directions', (state) => {
    const finished = side('q', { state, endedAt: 5 })
    for (const state of ['picking', 'running'] as const) {
      const open = side('q', { state, endedAt: 99, answer: 'partial' })
      expect(mergeSide([finished], [open])).toEqual([finished])
      expect(mergeSide([open], [finished])).toEqual([finished])
    }
  })

  it('prefers later endedAt after state, then local on a tie or missing times', () => {
    const local = side('q', { state: 'error', endedAt: 20 })
    const vps = side('q', { endedAt: 30, answer: 'remote' })
    expect(mergeSide([local], [vps])).toEqual([vps])
    expect(mergeSide([vps], [local])).toEqual([vps])
    expect(mergeSide([local], [{ ...vps, endedAt: 20 }])).toEqual([local])
    expect(mergeSide([{ ...local, endedAt: undefined }], [vps])).toEqual([vps])
    const missing = { ...local, endedAt: undefined }
    expect(mergeSide([missing], [{ ...vps, endedAt: undefined }])).toEqual([missing])
  })
})

describe('mergeItems', () => {
  it('takes the longer side when the other is a prefix of it', () => {
    const shared = [u('a', 1), u('b', 2)]
    expect(mergeItems(shared, [...shared, u('c', 3)], true)).toEqual({ items: [...shared, u('c', 3)], forked: null })
    expect(mergeItems([...shared, u('c', 3)], shared, false)).toEqual({ items: [...shared, u('c', 3)], forked: null })
  })

  it('keeps both tails of a fork, earlier one first', () => {
    const shared = [u('a', 1)]
    const m = mergeItems([...shared, u('l1', 50), u('l2', 60)], [...shared, u('v1', 10)], true)
    expect(m.items.map((x: Item) => x.id)).toEqual(['a', 'v1', 'l1', 'l2'])
    expect(m.forked).toEqual({ local: 2, vps: 1 })
  })

  it('never duplicates turns an earlier sync already joined', () => {
    const joined = [u('a', 1), u('l1', 5), u('v1', 10)]
    const vps = [u('a', 1), u('v1', 10), u('v2', 20)]
    const m = mergeItems(joined, vps, true)
    expect(m.items.map((x: Item) => x.id)).toEqual(['a', 'l1', 'v1', 'v2'])
    expect(mergeItems(m.items, vps, true).items).toEqual(m.items)
  })

  it('shared items come from the newer side', () => {
    const m = mergeItems([u('a', 1, 'stale')], [u('a', 1, 'final')], true)
    expect(m.items[0].text).toBe('final')
  })
})

// A shown user item after an edit, plus the old version parked in the versions file.
const meta = (id: string, title: string, updatedAt: number) => ({
  id,
  agentName: 'a',
  sessionId: null,
  cwd: '/w',
  title,
  createdAt: 1,
  updatedAt
})
const edited = (shown: Item, old: Item, tail: Item[]) => ({
  items: [{ ...shown, versions: { root: old.id, index: 1, count: 2 } }],
  versions: { [old.id]: { current: 1, list: [{ user: old, tail }, null] } }
})

describe('mergeChatFiles', () => {
  it('equal versions join items as before', () => {
    const shared = [u('a', 1)]
    const local = { items: [...shared, u('l1', 50)], versions: null }
    const vps = { items: [...shared, u('v1', 10)], versions: {} }
    const m = mergeChatFiles(local, vps, true)
    expect(m.items.map((x: Item) => x.id)).toEqual(['a', 'v1', 'l1'])
    expect(m).toMatchObject({ forked: { local: 1, vps: 1 }, copy: null })
    const same = { r: { current: 0, list: [null] } }
    expect(mergeChatFiles({ items: shared, versions: same }, { items: shared, versions: structuredClone(same) }, false)).toEqual({
      items: shared,
      versions: same,
      forked: null,
      copy: null
    })
  })

  it('a switch on one side wins without a copy when the other side has nothing new', () => {
    const old = u('u1', 1)
    const pc = edited(u('u1b', 2), old, [u('r1', 3)])
    const m = mergeChatFiles({ items: pc.items, versions: pc.versions }, { items: [old, u('r1', 3)], versions: null }, false)
    expect(m).toEqual({ items: pc.items, versions: pc.versions, forked: null, copy: null })
    // Same the other way round: the VPS made the switch.
    expect(mergeChatFiles({ items: [old, u('r1', 3)], versions: null }, { items: pc.items, versions: pc.versions }, true)).toEqual({
      items: pc.items,
      versions: pc.versions,
      forked: null,
      copy: null
    })
  })

  it('a versions-only change (same visible items) keeps the newer side, and copies only when something would be lost', () => {
    const shown = [u('a', 1), u('b', 2)]
    const hidden = (tail: Item[]) => ({ r: { current: 0, list: [null, { user: u('h', 1), tail }] } })
    const pc = { items: shown, versions: hidden([u('t1', 3)]) }
    const sub = { items: shown, versions: hidden([]) }
    expect(mergeChatFiles(pc, sub, false)).toEqual({ items: shown, versions: pc.versions, forked: null, copy: null })
    expect(mergeChatFiles(pc, { items: shown, versions: hidden([u('t1', 3), u('t2', 4)]) }, false).copy).toBe('vps')
  })

  it('the older side is kept as a copy when it holds an item the newer one lacks', () => {
    const old = u('u1', 1)
    const pc = edited(u('u1b', 2), old, [u('r1', 3)])
    const vps = { items: [old, u('r1', 3), u('u2', 4)], versions: null }
    expect(mergeChatFiles(pc, vps, false).copy).toBe('vps')
    // A hidden version's tail counts too.
    const hidden = { items: [u('x', 9)], versions: { r: { current: 0, list: [null, { user: u('h', 1), tail: [u('t', 2)] }] } } }
    expect(mergeChatFiles({ items: [u('x', 9)], versions: null }, hidden, false).copy).toBe('vps')
    expect(mergeChatFiles({ items: [u('x', 9)], versions: null }, hidden, true).copy).toBe(null)
  })
})

describe('mergeChats with versions', () => {
  const stamped = (id: string, ts: number, end: { session: string; at: string; agent?: string; seen?: string }): Item =>
    ({ ...u(id, ts), type: 'assistant', end }) as Item
  const files = (loc: object[], vps: object[], lv: unknown = null, vv: unknown = null) => ({
    items: (s: string) => (s === 'local' ? loc : vps),
    versions: (s: string) => (s === 'local' ? lv : vv)
  })

  it('a copy starts forked from its own last end, never at the end of a shared session', () => {
    const older = [u('u1', 1), stamped('a1', 2, { session: 'S1', at: 'm9' }), u('u2', 3), stamped('a2', 4, { session: 'S2', at: 'm12' })]
    const f = files([u('x', 9)], older, { r: { current: 0, list: [null] } })
    const m = mergeChats(
      [{ ...meta('c', 'T', 900), sessionId: 'S0', tasks: [{ id: 't' }], held: true, inFlight: true }],
      [{ ...meta('c', 'T', 100), sessionId: 'S2', tasks: [{ id: 't' }], held: true, inFlight: true }],
      f.items,
      f.versions
    )
    expect(m.copies[0].meta).toMatchObject({ sessionId: 'S2', next: { at: 'm12' }, inFlight: false })
    expect(m.copies[0].meta).not.toHaveProperty('tasks')
    expect(m.copies[0].meta).not.toHaveProperty('held')
    // A user message after the last end: that turn has no usable session, so it starts from a seed.
    f.items = (s: string) => (s === 'local' ? [u('x', 9)] : [...older, u('u3', 5)])
    expect(
      mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), sessionId: 'S2' }], f.items, f.versions).copies[0].meta
    ).toMatchObject({ sessionId: null, next: { seed: true } })
    // An existing `next` already forks, so it stays.
    const kept = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), sessionId: 'S1', next: { at: 'keep' } }], f.items, f.versions)
      .copies[0].meta
    expect(kept).toMatchObject({ sessionId: 'S1', next: { at: 'keep' } })
  })

  it("a copy that takes its session from a stamp takes that stamp's engine too, as a fork does", () => {
    const codexEnd = { session: 'TH2', at: 'turn-2', engine: 'codex' }
    const older = [u('u1', 1), stamped('a1', 2, { session: 'S1', at: 'm9' }), u('u2', 3), stamped('a2', 4, codexEnd as never)]
    const f = files([u('x', 9)], older, { r: { current: 0, list: [null] } })
    // A Claude chat whose agent moved to Codex: the copy's session is the Codex thread, so it carries the mark.
    const toCodex = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), sessionId: 'S0' }], f.items, f.versions).copies[0].meta
    expect(toCodex).toMatchObject({ sessionId: 'TH2', next: { at: 'turn-2' }, sessionEngine: 'codex' })
    // The other way round: a Claude stamp drops the source's Codex mark.
    f.items = (s: string) => (s === 'local' ? [u('x', 9)] : older.slice(0, 2))
    const toClaude = mergeChats(
      [meta('c', 'T', 900)],
      [{ ...meta('c', 'T', 100), sessionId: 'TH0', sessionEngine: 'codex' }],
      f.items,
      f.versions
    ).copies[0].meta
    expect(toClaude).toMatchObject({ sessionId: 'S1', next: { at: 'm9' } })
    expect(toClaude).not.toHaveProperty('sessionEngine')
    // A seed has no session, so no mark either.
    f.items = (s: string) => (s === 'local' ? [u('x', 9)] : [...older, u('u3', 5)])
    const seeded = mergeChats(
      [meta('c', 'T', 900)],
      [{ ...meta('c', 'T', 100), sessionId: 'TH2', sessionEngine: 'codex' }],
      f.items,
      f.versions
    ).copies[0].meta
    expect(seeded).toMatchObject({ sessionId: null, next: { seed: true } })
    expect(seeded).not.toHaveProperty('sessionEngine')
    // An existing `next` keeps the chat's own session, and with it the chat's own mark.
    const kept = mergeChats(
      [meta('c', 'T', 900)],
      [{ ...meta('c', 'T', 100), sessionId: 'TH1', sessionEngine: 'codex', next: { at: 'keep' } }],
      f.items,
      f.versions
    ).copies[0].meta
    expect(kept).toMatchObject({ sessionId: 'TH1', next: { at: 'keep' }, sessionEngine: 'codex' })
  })

  it.each(['acp', 'ag-ui'])("a copy carries a %s stamp's engine as it carries a Codex one (any engine's mark)", (engine) => {
    const older = [
      u('u1', 1),
      stamped('a1', 2, { session: 'S1', at: 'm9' }),
      u('u2', 3),
      stamped('a2', 4, { session: 'TH2', at: 'run-2', engine } as never)
    ]
    const f = files([u('x', 9)], older, { r: { current: 0, list: [null] } })
    const single = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), sessionId: 'S0' }], f.items, f.versions).copies[0].meta
    expect(single).toMatchObject({ sessionId: 'TH2', next: { at: 'run-2' }, sessionEngine: engine })
    // A room member forked from such a stamp is marked too.
    const room = { members: ['m'], sessions: { m: 'S0' }, seen: {}, role: '', active: [], queue: [] }
    f.items = (s: string) =>
      s === 'local' ? [u('x', 9)] : [u('u1', 1), stamped('a1', 2, { session: 'TH-M', at: 'run-1', agent: 'm', engine } as never)]
    const copy = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), group: room }], f.items, f.versions).copies[0].meta
    expect(copy.group).toMatchObject({ sessions: { m: 'TH-M' }, next: { m: { at: 'run-1' } }, sessionEngines: { m: engine } })
  })

  it('a room copy forks each member and loses its queue and active turns', () => {
    const room = {
      members: ['ann', 'bob'],
      sessions: { ann: 'SA', bob: 'SB' },
      seen: { ann: 'z', bob: 'z' },
      role: '',
      active: [{ agent: 'ann' }],
      queue: [{ id: 'q' }],
      next: { bob: { at: 'keep' } }
    }
    const items = [
      u('u1', 1),
      stamped('a1', 2, { session: 'SA1', at: 'ma', agent: 'ann', seen: 'u1' }),
      stamped('b1', 3, { session: 'SB1', at: 'mb', agent: 'bob' })
    ]
    const f = files([u('x', 9)], items, { r: { current: 0, list: [null] } })
    const m = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), group: room }], f.items, f.versions)
    expect(m.copies[0].meta.group).toMatchObject({
      sessions: { ann: 'SA1', bob: 'SB' },
      seen: { ann: 'u1', bob: 'z' },
      active: [],
      queue: [],
      next: { ann: { at: 'ma' }, bob: { at: 'keep' } }
    })
  })

  it("a room copy keeps each member's session engine with its session: a Codex stamp marks its member, a Claude stamp clears the mark", () => {
    // ann moved from Codex back to Claude (its last stamp is Claude's), cx is on Codex, bob keeps its own cut point.
    const room = {
      members: ['ann', 'cx', 'bob'],
      sessions: { ann: 'TH-OLD', cx: 'SC', bob: 'TH-B' },
      seen: {},
      role: '',
      active: [],
      queue: [],
      next: { bob: { at: 'keep' } },
      sessionEngines: { ann: 'codex', bob: 'codex' }
    }
    const items = [
      u('u1', 1),
      stamped('a1', 2, { session: 'SA1', at: 'ma', agent: 'ann', seen: 'u1' }),
      stamped('c1', 3, { session: 'TH-C', at: 'turn-1', agent: 'cx', seen: 'a1', engine: 'codex' } as never)
    ]
    const f = files([u('x', 9)], items, { r: { current: 0, list: [null] } })
    const copy = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), group: room }], f.items, f.versions).copies[0].meta
    expect(copy.group).toMatchObject({
      sessions: { ann: 'SA1', cx: 'TH-C', bob: 'TH-B' },
      next: { ann: { at: 'ma' }, cx: { at: 'turn-1' }, bob: { at: 'keep' } }
    })
    // An existing `next` keeps the member's own session, and with it the member's own mark; ann's Claude stamp clears its mark.
    expect(copy.group.sessionEngines).toEqual({ cx: 'codex', bob: 'codex' })
    // A room with no Codex session left carries no map at all.
    const claudeOnly = { ...room, members: ['ann'], sessions: { ann: 'TH-OLD' }, next: undefined, sessionEngines: { ann: 'codex' } }
    const plain = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), group: claudeOnly }], f.items, f.versions).copies[0].meta
    expect(plain.group.sessions).toEqual({ ann: 'SA1' })
    expect(plain.group).not.toHaveProperty('sessionEngines')
    // The joined index takes the newer side's room whole, its engines with its sessions.
    const joined = mergeChats(
      [{ ...meta('c', 'T', 900), group: room }],
      [{ ...meta('c', 'T', 100), group: { ...room, sessionEngines: {} } }],
      f.items,
      f.versions
    ).chats[0]
    expect(joined.group.sessionEngines).toEqual({ ann: 'codex', bob: 'codex' })
  })

  it('a copy chat keeps no pause and no lost subagents: Resume and the note stay with the original', () => {
    const f = files([u('x', 9)], [u('u1', 1)], { r: { current: 0, list: [null] } })
    const paused = { pause: 'paused', held: true, lost: ['scan the logs'] }
    const single = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), ...paused }], f.items, f.versions).copies[0].meta
    for (const k of ['pause', 'held', 'lost']) expect(single).not.toHaveProperty(k)
    const room = {
      members: ['ann', 'bob'],
      sessions: {},
      seen: {},
      role: '',
      active: [],
      queue: [],
      paused: { members: ['ann'], queue: [{ agent: 'bob', after: ['ann'] }] },
      lost: { ann: ['review the diff'] }
    }
    const copy = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), pause: 'pausing', group: room }], f.items, f.versions)
      .copies[0].meta
    expect(copy).not.toHaveProperty('pause')
    expect(copy.group).not.toHaveProperty('paused')
    expect(copy.group).not.toHaveProperty('lost')
    expect(copy.group.members).toEqual(['ann', 'bob'])
  })

  it('a room handoff survives the merge and a copy chat', () => {
    const handoff = { text: 'Summary', from: { chatId: 'old', title: 'Old room' }, at: 5 }
    const room = { members: ['ann'], sessions: { ann: 'SA' }, seen: { ann: 'z' }, role: '', active: [], queue: [], handoff }
    const items = [u('u1', 1), stamped('a1', 2, { session: 'SA1', at: 'ma', agent: 'ann', seen: 'u1' })]
    const f = files([u('x', 9)], items, { r: { current: 0, list: [null] } })
    // Local is newer for the winner; the VPS side becomes a copy.
    const m = mergeChats([{ ...meta('c', 'T', 900), group: room }], [{ ...meta('c', 'T', 100), group: room }], f.items, f.versions)
    expect(m.chats[0].group.handoff).toEqual(handoff)
    expect(m.copies[0].meta.group.handoff).toEqual(handoff)
    // A chat only the VPS holds is taken as is.
    expect(mergeChats([], [{ ...meta('c', 'T', 100), group: room }], f.items, f.versions).chats[0].group.handoff).toEqual(handoff)
  })

  it('running the merge twice over the same inputs yields one copy', () => {
    const old = u('u1', 1)
    const pc = edited(u('u1b', 2), old, [u('r1', 3)])
    const f = files(pc.items, [old, u('r1', 3), u('u2', 4)], pc.versions)
    const a = mergeChats([meta('c', 'Plan', 500)], [meta('c', 'Plan', 100)], f.items, f.versions)
    expect(a.copies).toHaveLength(1)
    expect(a.copies[0].newId).toMatch(/^[A-Za-z0-9-]+$/)
    // The next run sees the copy already in the index on this side.
    const b = mergeChats(a.chats, [meta('c', 'Plan', 100)], (s: string, id: string) => (id === 'c' ? f.items(s) : []), f.versions)
    expect(b.copies).toEqual([])
    expect(b.chats.map((c: { id: string }) => c.id)).toEqual(a.chats.map((c: { id: string }) => c.id))
  })

  it('mergeChats keeps the later replyAt and seenAt from either side', () => {
    const f = files([u('x', 1)], [u('x', 1)])
    const m = mergeChats(
      [{ ...meta('c', 'T', 900), replyAt: 10, seenAt: 50 }],
      [{ ...meta('c', 'T', 100), replyAt: 40 }],
      f.items,
      f.versions
    )
    expect(m.chats[0]).toMatchObject({ updatedAt: 900, replyAt: 40, seenAt: 50 })
    const flipped = mergeChats(
      [{ ...meta('c', 'T', 100), replyAt: 10 }],
      [{ ...meta('c', 'T', 900), replyAt: 5, seenAt: 70 }],
      f.items,
      f.versions
    )
    expect(flipped.chats[0]).toMatchObject({ updatedAt: 900, replyAt: 10, seenAt: 70 })
  })

  it('mergeChats keeps the later mark from either side, even on the older meta', () => {
    const f = files([u('x', 1)], [u('x', 1)])
    const m = mergeChats(
      [{ ...meta('c', 'T', 900), seenAt: 50 }],
      [{ ...meta('c', 'T', 100), mark: { at: 60, from: 5 } }],
      f.items,
      f.versions
    )
    expect(m.chats[0]).toMatchObject({ updatedAt: 900, seenAt: 50, mark: { at: 60, from: 5 } })
    const both = mergeChats(
      [{ ...meta('c', 'T', 100), mark: { at: 80, from: 7 } }],
      [{ ...meta('c', 'T', 900), mark: { at: 60, from: 5 } }],
      f.items,
      f.versions
    )
    expect(both.chats[0].mark).toEqual({ at: 80, from: 7 })
  })

  it('mergeChats keeps the later archive and unarchive from either side, even on the older meta', () => {
    const f = files([u('x', 1)], [u('x', 1)])
    // Archived on the VPS; the PC's meta is newer for another reason, and the archive still holds.
    const m = mergeChats([meta('c', 'T', 900)], [{ ...meta('c', 'T', 100), archivedAt: 60 }], f.items, f.versions)
    expect(m.chats[0]).toMatchObject({ updatedAt: 900, archivedAt: 60 })
    expect(m.chats[0]).not.toHaveProperty('unarchivedAt')
    // Unarchived on the PC after the VPS archived it: out of the archive on both.
    const back = mergeChats(
      [{ ...meta('c', 'T', 100), archivedAt: 50, unarchivedAt: 80 }],
      [{ ...meta('c', 'T', 900), archivedAt: 70 }],
      f.items,
      f.versions
    )
    expect(back.chats[0]).toMatchObject({ archivedAt: 70, unarchivedAt: 80 })
  })

  it('mergeChats drops a usage limit wait from every chat, so only one machine could ever send its continue', () => {
    const f = files([u('x', 1)], [u('x', 1)])
    const wait = { at: 5000, after: 'x', waits: 1 }
    const m = mergeChats(
      [
        { ...meta('c', 'T', 900), resume: wait },
        { ...meta('pc', 'P', 900), resume: wait }
      ],
      [
        { ...meta('c', 'T', 100), resume: wait },
        { ...meta('vps', 'V', 900), resume: wait }
      ],
      f.items,
      f.versions
    )
    expect(m.chats.map((c: { id: string }) => c.id).sort()).toEqual(['c', 'pc', 'vps'])
    for (const c of m.chats) expect(c).not.toHaveProperty('resume')
  })

  it('both absent stays absent', () => {
    const f = files([u('x', 1)], [u('x', 1)])
    const m = mergeChats([meta('c', 'T', 900)], [meta('c', 'T', 100)], f.items, f.versions)
    expect(m.chats[0]).not.toHaveProperty('replyAt')
    expect(m.chats[0]).not.toHaveProperty('seenAt')
    expect(m.chats[0]).not.toHaveProperty('mark')
    expect(m.chats[0]).not.toHaveProperty('archivedAt')
    expect(m.chats[0]).not.toHaveProperty('unarchivedAt')
  })

  it('a chat on one side only is left as it is', () => {
    const f = files([u('x', 1)], [])
    const only = { ...meta('c', 'T', 900), replyAt: 10 }
    const m = mergeChats([only], [], f.items, f.versions)
    expect(m.chats).toEqual([only])
  })

  it('a kept copy starts read', () => {
    const f = files([u('x', 9)], [u('x', 9), u('y', 9)], null, { r: { current: 0, list: [null] } })
    const m = mergeChats(
      [meta('c', 'T', 900)],
      [{ ...meta('c', 'T', 100), replyAt: 70, seenAt: 60, mark: { at: 65, from: 1 } }],
      f.items,
      f.versions
    )
    expect(m.copies[0].meta).not.toHaveProperty('replyAt')
    expect(m.copies[0].meta).not.toHaveProperty('seenAt')
    expect(m.copies[0].meta).not.toHaveProperty('mark')
  })

  it('an empty title falls back to "chat"', () => {
    const f = files([u('x', 9)], [u('x', 9), u('y', 9)], null, { r: { current: 0, list: [null] } })
    expect(mergeChats([meta('c', '', 900)], [meta('c', '', 100)], f.items, f.versions).copies[0].meta.title).toBe(
      'chat (copy from the VPS)'
    )
  })

  it('the copy gets a fresh id and a title that says where it came from', () => {
    const old = u('u1', 1)
    const pc = edited(u('u1b', 2), old, [u('r1', 3)])
    const files: Record<string, Record<string, { items: Item[]; versions: unknown }>> = {
      local: { c: { items: pc.items, versions: pc.versions } },
      vps: { c: { items: [old, u('r1', 3), u('u2', 4)], versions: null } }
    }
    const run = (l: number, v: number) =>
      mergeChats(
        [meta('c', 'Plan', l)],
        [meta('c', 'Plan', v)],
        (s: string, id: string) => files[s]![id]!.items,
        (s: string, id: string) => files[s]![id]!.versions,
        () => 'new1'
      )
    const a = run(500, 100)
    expect(a.copies).toEqual([
      { from: 'vps', id: 'c', newId: 'new1', meta: expect.objectContaining({ id: 'new1', title: 'Plan (copy from the VPS)' }) }
    ])
    expect(a.chats.map((c: { id: string }) => c.id)).toEqual(['c', 'new1'])
    // The VPS being newer flips the base: the PC's edit is the older side.
    files.local = { c: { items: [old, u('r1', 3), u('u2', 4)], versions: null } }
    files.vps = { c: { items: pc.items, versions: pc.versions } }
    const b = run(100, 500)
    expect(b.copies[0]).toMatchObject({ from: 'local', meta: { title: 'Plan (copy from this PC)' } })
    expect(b.versionWrites).toEqual([['c', pc.versions]])
  })
})

describe('unionHistory', () => {
  it('keeps each line once, oldest first', () => {
    const l = (ts: number) => JSON.stringify({ display: `p${ts}`, timestamp: ts })
    expect(unionHistory(`${l(3)}\n${l(1)}\n`, `${l(1)}\n${l(2)}\n`)).toBe(`${l(1)}\n${l(2)}\n${l(3)}\n`)
  })
})

describe('mergeUsageRecords', () => {
  const r = (id: string, agent = 'a') => JSON.stringify({ id, kind: 'msg', agent })
  it('unions by id', () => {
    expect(mergeUsageRecords(`${r('a')}\n${r('b')}\n`, `${r('b')}\n${r('c')}\n`, true)).toBe(`${r('a')}\n${r('b')}\n${r('c')}\n`)
  })
  it('unions owner records like any other', () => {
    const o = JSON.stringify({ id: 'o:s:c', kind: 'owner', chatId: 'c', sessionId: 's', agent: 'a', at: 1 })
    expect(mergeUsageRecords(`${r('a')}\n`, `${o}\n`, true)).toBe(`${r('a')}\n${o}\n`)
  })
  it('takes the newer side on the same id', () => {
    expect(mergeUsageRecords(`${r('a', 'old')}\n`, `${r('a', 'new')}\n`, true)).toBe(`${r('a', 'new')}\n`)
    expect(mergeUsageRecords(`${r('a', 'old')}\n`, `${r('a', 'new')}\n`, false)).toBe(`${r('a', 'old')}\n`)
  })
  it('drops broken lines', () => {
    expect(mergeUsageRecords(`${r('a')}\n{"id":"x"`, `nope\n${r('b')}\n{"no":1}\n`, false)).toBe(`${r('a')}\n${r('b')}\n`)
  })
})

describe('vault', () => {
  const K1 = Buffer.alloc(32, 1)
  const K2 = Buffer.alloc(32, 2)
  const K3 = Buffer.alloc(32, 3)

  it('mergeVault joins by id and keeps tombstones', () => {
    const local = vFile(K1, [vLive(K1, 'a', 10), vLive(K1, 'b', 5), vTomb('c', 20), vLive(K1, 'd', 3)])
    const vps = vFile(K1, [vLive(K1, 'a', 12), vTomb('b', 7), vLive(K1, 'c', 15), vLive(K1, 'e', 1)])
    const before = structuredClone([local, vps])
    const m = mergeVault(local, vps) as VFile
    // A delete made later stays deleted on both sides; an edit made later wins over an older delete's absence.
    expect(vShape(m)).toEqual([
      ['a', 12, false],
      ['b', 7, true],
      ['c', 20, true],
      ['d', 3, false],
      ['e', 1, false]
    ])
    expect(m.items[0]!.sealed).toBe(vps.items[0]!.sealed)
    expect(m.v).toBe(1)
    expect(m.keyId).toBe(keyIdOf(K1))
    expect([local, vps]).toEqual(before)
    expect(mergeVault(null, null)).toBeNull()
    expect(mergeVault(local, null)).toEqual(local)
    expect(mergeVault(local, null)).not.toBe(local)
    expect(mergeVault(null, vps)).toEqual(vps)
    // Joining the result with either side again changes nothing.
    expect(mergeVault(m, vps)).toEqual(m)
    expect(mergeVault(local, m)).toEqual(m)
    // A side holding only tombstones carries no sealed data, so the key id comes from the side with items.
    expect((mergeVault(vFile(K2, [vTomb('x', 1)]), vFile(K1, [vLive(K1, 'y', 1)])) as VFile).keyId).toBe(keyIdOf(K1))
    expect((mergeVault(vFile(K1, [vLive(K1, 'y', 1)]), vFile(K2, [vTomb('x', 1)])) as VFile).keyId).toBe(keyIdOf(K1))
  })

  it('mergeVault tie prefers the tombstone then the VPS', () => {
    const local = vFile(K1, [vTomb('a', 10), vLive(K1, 'b', 10), vLive(K1, 'c', 10, { side: 'pc' }), vTomb('d', 10)])
    const vps = vFile(K1, [vLive(K1, 'a', 10), vTomb('b', 10), vLive(K1, 'c', 10, { side: 'vps' }), vTomb('d', 10)])
    const m = mergeVault(local, vps) as VFile
    expect(vShape(m)).toEqual([
      ['a', 10, true],
      ['b', 10, true],
      ['c', 10, false],
      ['d', 10, true]
    ])
    expect(openItem(K1, m.items[2])).toEqual(vBody('c', 10, { side: 'vps' }))
  })

  it('planVaultKeys covers none, pull, push, merge, reseal and refuse', () => {
    const plan = (o: Record<string, unknown>) =>
      planVaultKeys({ localKey: null, vpsKey: null, localFile: null, vpsFile: null, ...o }) as { action: string; reason?: string }
    expect(plan({})).toEqual({ action: 'none' })
    expect(plan({ localFile: vFile(K1, [vTomb('x', 1)]), vpsFile: vFile(K2, [vTomb('y', 1)]) })).toEqual({ action: 'none' })
    expect(plan({ vpsKey: K1, vpsFile: vFile(K1, [vLive(K1, 'v', 1)]) })).toEqual({ action: 'pullKey' })
    expect(plan({ vpsKey: K1, localFile: vFile(K2, [vTomb('t', 1)]) })).toEqual({ action: 'pullKey' })
    expect(plan({ localKey: K1, localFile: vFile(K1, [vLive(K1, 'p', 1)]) })).toEqual({ action: 'pushKey' })
    expect(
      plan({ localKey: K1, vpsKey: Buffer.from(K1), localFile: vFile(K1, [vLive(K1, 'p', 1)]), vpsFile: vFile(K1, [vLive(K1, 'v', 1)]) })
    ).toEqual({ action: 'merge' })
    expect(plan({ localKey: K2, vpsKey: K1, localFile: vFile(K2, [vLive(K2, 'p', 1)]), vpsFile: vFile(K1, [vLive(K1, 'v', 1)]) })).toEqual({
      action: 'reseal'
    })
    expect(plan({ localKey: K2, vpsKey: K1 })).toEqual({ action: 'reseal' })

    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ localFile: vFile(K1, [vLive(K1, 'p', 1)]) }, /^This PC has vault items but no vault key/],
      // A PC that lost its key never gets one pulled over its items: that is keyMissing there.
      [{ vpsKey: K1, localFile: vFile(K1, [vLive(K1, 'p', 1)]) }, /^This PC has vault items but no vault key/],
      [{ localKey: K1, vpsFile: vFile(K1, [vLive(K1, 'v', 1)]) }, /^The VPS has vault items but no vault key/],
      // Sealed with the VPS key but not this PC's: never merged, even though it would open.
      [{ localKey: K2, vpsKey: K1, localFile: vFile(K1, [vLive(K1, 'p', 1)]) }, /^This PC's vault\.json was sealed with a different key/],
      [{ localKey: K1, vpsKey: K1, vpsFile: vFile(K2, [vLive(K2, 'v', 1)]) }, /^The VPS's vault\.json was sealed with a different key/],
      // The key id matches but an item does not open: keyMismatch on that side.
      [
        { localKey: K1, vpsKey: K1, localFile: vFile(K1, [vLive(K1, 'p', 1), vLive(K2, 'q', 1)]) },
        /^An item in this PC's vault does not open/
      ]
    ]
    for (const [o, reason] of refusals) {
      const r = plan(o)
      expect(r.action).toBe('refuse')
      expect(r.reason).toMatch(reason)
      for (const k of [K1, K2]) expect(r.reason).not.toContain(k.toString('base64'))
    }
  })

  it('a missing key is refused naming the path checked and the setting that moves it', () => {
    const plan = (o: Record<string, unknown>) =>
      planVaultKeys({
        localKey: null,
        vpsKey: null,
        localFile: null,
        vpsFile: null,
        localKeyFile: '/h/.config/zumibot-vault/vault.key',
        vpsKeyFile: '/home/bot/.config/zumibot-vault/vault.key',
        ...o
      }) as { action: string; reason?: string }
    const local = plan({ localFile: vFile(K1, [vLive(K1, 'p', 1)]) }).reason!
    expect(local).toMatch(/^This PC has vault items but no vault key at \/h\/\.config\/zumibot-vault\/vault\.key\. /)
    expect(local).toContain('ZUMIBOT_VAULT_KEY_FILE')
    expect(local).toContain('XDG_CONFIG_HOME')
    const vps = plan({ localKey: K1, vpsFile: vFile(K1, [vLive(K1, 'v', 1)]) }).reason!
    expect(vps).toMatch(/^The VPS has vault items but no vault key at \/home\/bot\/\.config\/zumibot-vault\/vault\.key\. /)
    expect(vps).toContain('VPS_VAULT_KEY_FILE')
  })

  it('opensWith checks the key id and every live item', () => {
    expect(opensWith(K1, vFile(K1, [vLive(K1, 'a', 1), vTomb('b', 2)]))).toBe(true)
    expect(opensWith(K1, vFile(K1, []))).toBe(true)
    expect(opensWith(K2, vFile(K1, [vLive(K1, 'a', 1)]))).toBe(false)
    expect(opensWith(K1, vFile(K1, [vLive(K1, 'a', 1), vLive(K2, 'b', 1)]))).toBe(false)
    expect(opensWith(K1, vFile(K1, [{ ...vLive(K1, 'a', 1), id: 'moved' }]))).toBe(false)
  })

  it('resealFile reseals and opens with the new key', () => {
    const file = vFile(K2, [vLive(K2, 'a', 5, { password: 'hunter22' }), vTomb('b', 6)])
    const before = structuredClone(file)
    const out = resealFile(file, K2, K1) as VFile
    expect(out.v).toBe(1)
    expect(out.keyId).toBe(keyIdOf(K1))
    expect(vShape(out)).toEqual(vShape(file))
    expect(openItem(K1, out.items[0])).toEqual(vBody('a', 5, { password: 'hunter22' }))
    expect(() => openItem(K2, out.items[0])).toThrow()
    expect(out.items[1]).toEqual(vTomb('b', 6))
    expect(JSON.stringify(out)).not.toContain('hunter22')
    expect(file).toEqual(before)
  })

  it("resealFile throws and changes nothing when an item won't open", () => {
    const file = vFile(K2, [vLive(K2, 'a', 5), vLive(K3, 'x', 6)])
    const before = structuredClone(file)
    let err: unknown
    try {
      resealFile(file, K2, K1)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    for (const k of [K1, K2, K3]) expect((err as Error).message).not.toContain(k.toString('base64'))
    expect(file).toEqual(before)
    // An item moved to another id, or a file under another key, fails the same way.
    expect(() => resealFile(vFile(K2, [{ ...vLive(K2, 'a', 5), id: 'b' }]), K2, K1)).toThrow()
    expect(() => resealFile(vFile(K3, [vLive(K3, 'a', 5)]), K2, K1)).toThrow()
  })

  it("finds this PC's vault key where the server looks for it", () => {
    const home = '/home/t'
    const dataDir = '/home/t/.local/share/zumibot'
    const envs = [
      {},
      { XDG_CONFIG_HOME: '/x/conf' },
      { XDG_CONFIG_HOME: 'relative' },
      { XDG_CONFIG_HOME: '' },
      { ZUMIBOT_VAULT_KEY_FILE: '/k/vault/vault.key', XDG_CONFIG_HOME: '/x' },
      { ZUMIBOT_VAULT_KEY_FILE: '' }
    ]
    for (const env of envs) expect(vaultKeyFileOf(env, home, dataDir)).toBe(resolveVaultKeyFile(env, home, dataDir))
    const shared = [
      { ZUMIBOT_VAULT_KEY_FILE: '/home/t/vault.key' },
      { ZUMIBOT_VAULT_KEY_FILE: '/k/vault.key' },
      { ZUMIBOT_VAULT_KEY_FILE: '/home/t/.local/share/vault/../vault.key' }
    ]
    for (const env of [
      { ZUMIBOT_VAULT_KEY_FILE: 'rel/vault.key' },
      { ZUMIBOT_VAULT_KEY_FILE: `${dataDir}/vault.key` },
      { XDG_CONFIG_HOME: dataDir },
      ...shared
    ]) {
      expect(() => resolveVaultKeyFile(env, home, dataDir)).toThrow()
      expect(() => vaultKeyFileOf(env, home, dataDir)).toThrow(/^ZUMIBOT_VAULT_KEY_FILE /)
    }
  })
})

it('disableRoutines switches every routine off like the UI does', () => {
  expect(disableRoutines([{ id: 'r', enabled: true, nextRunAt: 5 }])).toEqual([{ id: 'r', enabled: false, nextRunAt: null }])
})

it('disableChannels runs no bot on the copy written here and keeps the rest', () => {
  expect(disableChannels({ v: 1, telegram: { run: true, paired: { userId: '1', chatId: '1', name: 'A' }, agents: ['a'] } })).toEqual({
    v: 1,
    telegram: { run: false, paired: { userId: '1', chatId: '1', name: 'A' }, agents: ['a'] }
  })
  expect(disableChannels(null)).toEqual({})
})

it('disableWorkflows switches every workflow off like disableRoutines', () => {
  expect(disableWorkflows([{ id: 'w', enabled: true, nextRunAt: 5, name: 'W' }])).toEqual([
    { id: 'w', enabled: false, nextRunAt: null, name: 'W' }
  ])
})

describe('stopUnfinishedWorkflowRuns', () => {
  it('stops the running and waiting runs and their open visits, and leaves ended ones as they are', () => {
    const out = stopUnfinishedWorkflowRuns(vpsRuns(), 50)
    expect(out.w[0]).toEqual(
      wfRun(
        'running',
        'stopped',
        [
          wfVisit('t', 'done', { endedAt: 2 }),
          wfVisit('llm', 'stopped', { endedAt: 50 }),
          wfVisit('wait', 'stopped', { until: 9, endedAt: 50 })
        ],
        { error: 'Continues on the VPS', endedAt: 50 }
      )
    )
    expect(out.w[1]).toMatchObject({ status: 'stopped', error: 'Continues on the VPS', endedAt: 50 })
    expect(out.w[1].visits.map((v: { status: string }) => v.status)).toEqual(['stopped', 'stopped'])
    expect(out.w[2]).toEqual(vpsRuns().w[2])
    expect(out.w[3]).toEqual(vpsRuns().w[3])
  })
  it('stops the open item inside a For each visit, as the run halts it, and leaves done and pending items alone', () => {
    const items = [
      { id: 'i1', n: 1, text: 'a', status: 'done', output: 'x', startedAt: 1, endedAt: 2 },
      { id: 'i2', n: 2, text: 'b', status: 'running', chatId: 'c', startedAt: 3 },
      { id: 'i3', n: 3, text: 'c', status: 'waiting', until: 9, startedAt: 3 },
      { id: 'i4', n: 4, text: 'd', status: 'pending' }
    ]
    const out = stopUnfinishedWorkflowRuns({ w: [wfRun('r', 'running', [wfVisit('f', 'running', { items })])] }, 50)
    expect(out.w[0].visits[0]).toMatchObject({ status: 'stopped', endedAt: 50 })
    expect(out.w[0].visits[0].items).toEqual([
      items[0],
      { ...items[1], status: 'stopped', endedAt: 50 },
      { ...items[2], status: 'stopped', endedAt: 50 },
      items[3]
    ])
  })
  it('keeps an end time already set and passes anything that is not a run list through', () => {
    const out = stopUnfinishedWorkflowRuns(
      { w: [wfRun('r', 'running', [wfVisit('a', 'running', { endedAt: 7 })], { endedAt: 8 })], odd: 'x' },
      50
    )
    expect(out.w[0]).toMatchObject({ status: 'stopped', endedAt: 8, visits: [{ status: 'stopped', endedAt: 7 }] })
    expect(out.odd).toBe('x')
    expect(stopUnfinishedWorkflowRuns({ side: 'vps' }, 50)).toEqual({ side: 'vps' })
    expect(stopUnfinishedWorkflowRuns([], 50)).toEqual([])
  })
})

// Sync runs ssh and rsync for real against a fake VPS (bash, a POSIX PATH): rsync Sync is Linux-only in the app.
describe.skipIf(process.platform !== 'linux')('sync', () => {
  let root: string
  let pc: string
  let vps: string
  let calls: Call[]
  let logs: string[]

  const write = (p: string, body: unknown, mtime?: number) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
    if (mtime) utimesSync(p, mtime, mtime)
  }
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
  const data = (home: string, f: string) => join(home, '.local/share/zumibot', f)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cb-sync-'))
    pc = join(root, 'pc')
    vps = join(root, 'vps')
    calls = []
    logs = []
    // Fake server CLI and systemctl on the "VPS".
    write(join(vps, 'zumibot/bin/zumibot-server'), `#!/bin/sh\ncat ${join(vps, 'busy')}\n`)
    chmodSync(join(vps, 'zumibot/bin/zumibot-server'), 0o755)
    write(join(vps, 'busy'), '0\n')
    // A fake sudo logs too, so a restart that still goes through sudo shows up in sudo.log.
    write(join(root, 'bin/sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${join(vps, 'sudo.log')}\n`)
    chmodSync(join(root, 'bin/sudo'), 0o755)
    write(
      join(root, 'bin/systemctl'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${join(vps, 'systemctl.log')}\n[ ! -e ${join(vps, 'systemctl-fail')} ]\n`
    )
    chmodSync(join(root, 'bin/systemctl'), 0o755)

    const chat = (id: string, updatedAt: number) => ({ id, agentName: 'a', sessionId: null, cwd: '/w', title: id, createdAt: 1, updatedAt })
    write(data(pc, 'chats.json'), { chats: [chat('shared', 300), chat('pc-only', 100)] })
    write(data(pc, 'chats/shared.json'), [u('a', 1), u('l1', 50)])
    write(data(pc, 'chats/pc-only.json'), [u('p', 1)])
    write(data(pc, 'sidebar.json'), { side: 'pc' }, 2_000_000_000)
    write(data(pc, 'attachments/pc-only/x/a.png'), 'png')
    write(data(vps, 'chats.json'), { chats: [chat('shared', 400), chat('vps-only', 200)] })
    write(data(vps, 'chats/shared.json'), [u('a', 1), u('v1', 100)])
    write(data(vps, 'chats/vps-only.json'), [u('v', 1)])
    write(data(vps, 'sidebar.json'), { side: 'vps' }, 1_000_000_000)
    write(data(vps, 'routines.json'), [{ id: 'r', enabled: true, nextRunAt: 9 }])
    write(data(vps, 'auth.json'), { secret: 1 })
    write(data(vps, 'channels.json'), { v: 1, telegram: { run: true, paired: null, agents: ['a'] } })
    write(data(vps, 'channel-state.json'), { v: 1, telegram: { offset: 77 } })
    write(data(vps, 'channel-tokens.json'), { v: 1, tokens: {} })
    write(data(pc, 'channel-state.json'), { v: 1, telegram: { offset: 5 } })

    write(join(pc, '.claude/agents/pc-agent.md'), 'pc')
    write(join(vps, '.claude/agents/vps-agent.md'), 'vps')
    write(join(pc, '.claude/projects/p/s.jsonl'), 'old', 1_000_000_000)
    write(join(vps, '.claude/projects/p/s.jsonl'), 'new', 2_000_000_000)
    write(join(pc, '.claude/projects/-tmp-x/t.jsonl'), 'junk')
    write(join(vps, '.claude/skills/synced/s/SKILL.md'), 'auto')
    write(join(pc, '.claude/history.jsonl'), '{"timestamp":2}\n')
    write(join(vps, '.claude/history.jsonl'), '{"timestamp":1}\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  // ssh runs the remote command locally with HOME at the fake VPS; rsync runs for real with the host mapped to it.
  function fakeRun(onRun?: (c: Call) => void) {
    return async (cmd: string, args: string[], opts?: { input?: string }): Promise<Result> => {
      calls.push({ cmd, args, input: opts?.input })
      onRun?.({ cmd, args })
      const env = { ...process.env, HOME: vps, PATH: `${join(root, 'bin')}:${process.env.PATH}` }
      let r
      if (cmd === 'ssh') r = spawnSync('bash', ['-c', args[args.length - 1]!], { env, encoding: 'utf8', input: opts?.input })
      else {
        const local: string[] = []
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-e') {
            i++
            continue
          }
          const a = args[i]!
          const remote = a.startsWith('bot@vps.example:') ? a.slice('bot@vps.example:'.length) : null
          local.push(remote === null ? a : remote.startsWith('/') ? remote : join(vps, remote) + (remote.endsWith('/') ? '/' : ''))
        }
        r = spawnSync('rsync', local, { env, encoding: 'utf8' })
      }
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
    }
  }

  const go = (run = fakeRun(), alive = () => false, extra: Record<string, string> = {}) => {
    let t = 0
    return sync({
      env: { VPS_HOST: 'vps.example', VPS_USER: 'bot', VPS_DIR: join(vps, 'zumibot'), HOME: pc, ...extra },
      run,
      alive,
      log: (m: string) => logs.push(m),
      sleep: async (ms: number) => {
        t += ms
      },
      now: () => 1_800_000_000_000 + t
    }) as Promise<number>
  }

  it('leaves both machines with every chat, agent and session, and restarts the VPS', async () => {
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      expect(read(data(home, 'chats.json')).chats.map((c: { id: string }) => c.id)).toEqual(['shared', 'pc-only', 'vps-only'])
      expect(read(data(home, 'chats/shared.json')).map((x: Item) => x.id)).toEqual(['a', 'l1', 'v1'])
      expect(existsSync(data(home, 'chats/vps-only.json')) && existsSync(data(home, 'chats/pc-only.json'))).toBe(true)
      expect(read(data(home, 'sidebar.json'))).toEqual({ side: 'pc' })
      expect(existsSync(data(home, 'attachments/pc-only/x/a.png'))).toBe(true)
      expect(existsSync(join(home, '.claude/agents/pc-agent.md')) && existsSync(join(home, '.claude/agents/vps-agent.md'))).toBe(true)
      expect(readFileSync(join(home, '.claude/projects/p/s.jsonl'), 'utf8')).toBe('new')
      expect(readFileSync(join(home, '.claude/history.jsonl'), 'utf8')).toBe('{"timestamp":1}\n{"timestamp":2}\n')
    }
    expect(read(data(pc, 'chats.json')).chats[0].updatedAt).toBe(400)
    // Routines fire on the VPS only; the sign-in and Claude's own synced skills stay put.
    expect(read(data(pc, 'routines.json'))).toEqual([{ id: 'r', enabled: false, nextRunAt: null }])
    expect(read(data(vps, 'routines.json'))).toEqual([{ id: 'r', enabled: true, nextRunAt: 9 }])
    expect(existsSync(data(pc, 'auth.json'))).toBe(false)
    // One machine polls a bot: the PC's copy runs none, and each side keeps its own offset and sealed token.
    expect(read(data(pc, 'channels.json'))).toEqual({ v: 1, telegram: { run: false, paired: null, agents: ['a'] } })
    expect(read(data(vps, 'channels.json')).telegram.run).toBe(true)
    expect(read(data(pc, 'channel-state.json'))).toEqual({ v: 1, telegram: { offset: 5 } })
    expect(read(data(vps, 'channel-state.json'))).toEqual({ v: 1, telegram: { offset: 77 } })
    expect(existsSync(data(pc, 'channel-tokens.json'))).toBe(false)
    expect(existsSync(join(vps, '.claude/projects/-tmp-x'))).toBe(false)
    expect(existsSync(join(pc, '.claude/skills/synced'))).toBe(false)
    // The user unit: no sudo, no root.
    expect(readFileSync(join(vps, 'systemctl.log'), 'utf8')).toBe('--user restart zumibot\n')
    expect(existsSync(join(vps, 'sudo.log'))).toBe(false)
    // The replaced session file is kept.
    const bk = logs.find((l) => l.startsWith('Synced'))!.match(/Backups: (\S+) \(this PC\)/)![1]!
    expect(readFileSync(join(bk, 'projects-overwritten/p/s.jsonl'), 'utf8')).toBe('old')
    expect(calls.some((c) => c.args.some((a) => a.startsWith('--delete')))).toBe(false)
  })

  // Session logs are gigabytes of JSON over a home uplink: uncompressed, the projects push alone took minutes.
  it('compresses every rsync that crosses to the VPS', async () => {
    expect(await go()).toBe(0)
    const remote = calls.filter((c) => c.cmd === 'rsync' && c.args.some((a) => a.startsWith('bot@vps.example:')))
    expect(remote.length).toBeGreaterThan(5)
    for (const c of remote) expect(c.args[0]).toMatch(/^-a?z/)
  })

  it('workflows.json from VPS lands locally switched off', async () => {
    write(data(vps, 'workflows.json'), [{ id: 'w', name: 'W', enabled: true, nextRunAt: 9 }])
    expect(await go()).toBe(0)
    expect(read(data(pc, 'workflows.json'))).toEqual([{ id: 'w', name: 'W', enabled: false, nextRunAt: null }])
    expect(read(data(vps, 'workflows.json'))).toEqual([{ id: 'w', name: 'W', enabled: true, nextRunAt: 9 }])
  })

  it('saved versions of workflows and routines come from the VPS with the definitions', async () => {
    write(data(vps, 'history/workflows/w.json'), { v: 1, versions: [{ id: 'v2', side: 'vps' }] })
    write(data(pc, 'history/workflows/w.json'), { v: 1, versions: [{ id: 'v1', side: 'pc' }] })
    write(data(pc, 'history/routines/only-here.json'), { v: 1, versions: [] })
    expect(await go()).toBe(0)
    expect(read(data(pc, 'history/workflows/w.json'))).toEqual({ v: 1, versions: [{ id: 'v2', side: 'vps' }] })
    expect(read(data(pc, 'history/routines/only-here.json'))).toEqual({ v: 1, versions: [] }) // never deleted
    expect(read(data(vps, 'history/workflows/w.json'))).toEqual({ v: 1, versions: [{ id: 'v2', side: 'vps' }] })
  })

  it('workflow-runs.json newest wins', async () => {
    write(data(pc, 'workflow-runs.json'), { side: 'pc' }, 1_000_000_000)
    write(data(vps, 'workflow-runs.json'), { side: 'vps' }, 2_000_000_000)
    expect(await go()).toBe(0)
    expect(read(data(pc, 'workflow-runs.json'))).toEqual({ side: 'vps' })
  })

  it('workflow-runs.json keeps the local file when it is newer', async () => {
    write(data(pc, 'workflow-runs.json'), { side: 'pc' }, 2_000_000_000)
    write(data(vps, 'workflow-runs.json'), { side: 'vps' }, 1_000_000_000)
    expect(await go()).toBe(0)
    expect(read(data(pc, 'workflow-runs.json'))).toEqual({ side: 'pc' })
  })

  // Per-agent connector on lists: no secrets, 0600 like the server writes it.
  it('connectors.json newest wins: the VPS copy replaces an older local one, keeping 0600', async () => {
    write(data(pc, 'connectors.json'), { side: 'pc' }, 1_000_000_000)
    write(data(vps, 'connectors.json'), { side: 'vps' }, 2_000_000_000)
    chmodSync(data(pc, 'connectors.json'), 0o600)
    chmodSync(data(vps, 'connectors.json'), 0o600)
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      expect(read(data(home, 'connectors.json'))).toEqual({ side: 'vps' })
      if (process.platform !== 'win32') expect(statSync(data(home, 'connectors.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('connectors.json newest wins: a newer local copy goes up to the VPS, keeping 0600', async () => {
    write(data(pc, 'connectors.json'), { side: 'pc' }, 2_000_000_000)
    write(data(vps, 'connectors.json'), { side: 'vps' }, 1_000_000_000)
    chmodSync(data(pc, 'connectors.json'), 0o600)
    chmodSync(data(vps, 'connectors.json'), 0o600)
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      expect(read(data(home, 'connectors.json'))).toEqual({ side: 'pc' })
      if (process.platform !== 'win32') expect(statSync(data(home, 'connectors.json')).mode & 0o777).toBe(0o600)
    }
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    expect(push.args.some((a) => a.endsWith('/connectors.json'))).toBe(true)
  })

  it('pulled workflow runs still unfinished land stopped here, keeping the VPS time, and the VPS copy is untouched', async () => {
    write(data(pc, 'workflow-runs.json'), { w: [] }, 1_000_000_000)
    write(data(vps, 'workflow-runs.json'), vpsRuns(), 2_000_000_000)
    expect(await go()).toBe(0)
    const local = read(data(pc, 'workflow-runs.json'))
    // They go on on the VPS: a local server must not run their Agent, LLM or Notify steps a second time.
    expect(local.w.map((r: { status: string }) => r.status)).toEqual(['stopped', 'stopped', 'done', 'failed'])
    expect(local.w[0]).toMatchObject({ error: 'Continues on the VPS', endedAt: expect.any(Number) })
    expect(local.w[0].visits.map((v: { status: string }) => v.status)).toEqual(['done', 'stopped', 'stopped'])
    expect(local.w.slice(2)).toEqual(vpsRuns().w.slice(2))
    expect(read(data(vps, 'workflow-runs.json'))).toEqual(vpsRuns())
    // Still the VPS's time: the next sync compares against it, and a VPS file unchanged since is not pulled again.
    expect(statSync(data(pc, 'workflow-runs.json')).mtimeMs).toBe(statSync(data(vps, 'workflow-runs.json')).mtimeMs)
  })

  it('keeps webhook secrets (routine and workflow hooks) on the machine that made them', async () => {
    const files = ['routine-hooks.json', 'workflow-hooks.json']
    for (const home of [pc, vps])
      for (const f of files) {
        write(data(home, f), `{"side":"${home === pc ? 'pc' : 'vps'}","file":"${f}"}\n`)
        chmodSync(data(home, f), 0o600)
      }
    expect(await go()).toBe(0)
    for (const home of [pc, vps])
      for (const f of files) {
        expect(readFileSync(data(home, f), 'utf8')).toBe(`{"side":"${home === pc ? 'pc' : 'vps'}","file":"${f}"}\n`)
        if (process.platform !== 'win32') expect(statSync(data(home, f)).mode & 0o777).toBe(0o600)
      }
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    for (const f of files) expect(push.args.some((a) => a.endsWith(f))).toBe(false)
  })

  it('chat workflow link survives sync', async () => {
    const link = { workflowId: 'w', runId: 'run1', stepId: 's1', name: 'W' }
    const chats = read(data(vps, 'chats.json')).chats
    chats.find((c: { id: string }) => c.id === 'vps-only').workflow = link
    write(data(vps, 'chats.json'), { chats })
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      expect(read(data(home, 'chats.json')).chats.find((c: { id: string }) => c.id === 'vps-only').workflow).toEqual(link)
    }
  })

  it('carries agent memory both ways and keeps the newer MEMORY.md', async () => {
    write(join(pc, '.claude/agent-memory/a/pc.md'), 'pc')
    write(join(vps, '.claude/agent-memory/a/vps.md'), 'vps')
    write(join(pc, '.claude/agent-memory/a/MEMORY.md'), 'old', 1_000_000_000)
    write(join(vps, '.claude/agent-memory/a/MEMORY.md'), 'new', 2_000_000_000)
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      const dir = join(home, '.claude/agent-memory/a')
      expect(readFileSync(join(dir, 'pc.md'), 'utf8')).toBe('pc')
      expect(readFileSync(join(dir, 'vps.md'), 'utf8')).toBe('vps')
      expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('new')
    }
  })

  const gone9 = { at: 9, by: 'user' }
  const HEX_A = 'a'.repeat(64)
  const HEX_B = 'b'.repeat(64)

  it('copies btw files that exist only on the VPS, including a VPS-only chat', async () => {
    for (const id of ['shared', 'vps-only']) write(data(vps, `chats/${id}.btw.json`), { v: 1, items: [side(id)] })
    expect(await go()).toBe(0)
    for (const home of [pc, vps])
      for (const id of ['shared', 'vps-only']) {
        expect(read(data(home, `chats/${id}.btw.json`))).toEqual({ v: 1, items: [side(id)] })
      }
  })

  it("copies a remote agent's thread file (agui.json) with a chat whose items come from the VPS", async () => {
    const thread = { v: 1, threadId: 'th-vps', state: { step: 2 }, interrupts: [] }
    write(data(vps, 'chats/vps-only.agui.json'), thread)
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) expect(read(data(home, 'chats/vps-only.agui.json'))).toEqual(thread)
  })

  it('joins side files for shared chats and carries files from chats on either side only', async () => {
    const shared = side('same', { state: 'running', endedAt: undefined })
    const finished = side('same', { answer: 'finished' })
    write(data(pc, 'chats/shared.btw.json'), { v: 1, items: [shared, side('pc', { askedAt: 3 })] })
    write(data(vps, 'chats/shared.btw.json'), { v: 1, items: [finished, side('vps', { askedAt: 2 })] })
    write(data(pc, 'chats/pc-only.btw.json'), { v: 1, items: [side('pc-only')] })
    write(data(vps, 'chats/vps-only.btw.json'), { v: 1, items: [side('vps-only')] })

    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      expect(read(data(home, 'chats/shared.btw.json'))).toEqual({
        v: 1,
        items: [finished, side('vps', { askedAt: 2 }), side('pc', { askedAt: 3 })]
      })
      expect(read(data(home, 'chats/pc-only.btw.json'))).toEqual({ v: 1, items: [side('pc-only')] })
      expect(read(data(home, 'chats/vps-only.btw.json'))).toEqual({ v: 1, items: [side('vps-only')] })
    }
    expect(await go()).toBe(0)
    expect(read(data(pc, 'chats/shared.btw.json'))).toEqual(read(data(vps, 'chats/shared.btw.json')))
  })

  it('joins side files even when a shared chat needs its missing items from the VPS', async () => {
    rmSync(data(pc, 'chats/shared.json'))
    write(data(pc, 'chats/shared.btw.json'), { v: 1, items: [side('pc')] })
    write(data(vps, 'chats/shared.btw.json'), { v: 1, items: [side('vps', { askedAt: 2 })] })
    expect(await go()).toBe(0)
    for (const home of [pc, vps])
      expect(read(data(home, 'chats/shared.btw.json'))).toEqual({ v: 1, items: [side('pc'), side('vps', { askedAt: 2 })] })
  })

  it('writes the joined todos file for a chat on both sides and copies one only on the VPS', async () => {
    const pcSide = tFile([tItem('a', { updatedAt: 5 }), tItem('only-pc')], 2, { x: 2 })
    const vpsSide = tFile([tItem('a', { removed: gone9, updatedAt: 9 }), tItem('only-vps')], 3, { x: 3 })
    write(data(pc, 'chats/shared.todos.json'), pcSide)
    write(data(vps, 'chats/shared.todos.json'), vpsSide)
    write(data(pc, 'chats/pc-only.todos.json'), tFile([tItem('p')]))
    write(data(vps, 'chats/vps-only.todos.json'), tFile([tItem('v')]))
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      const joined = read(data(home, 'chats/shared.todos.json'))
      expect(joined.items.map((i: { id: string }) => i.id).sort()).toEqual(['a', 'only-pc', 'only-vps'])
      expect(joined.items.find((i: { id: string }) => i.id === 'a').removed).toEqual(gone9)
      expect(joined.rev).toBe(4)
      expect(joined.seen).toEqual({ x: 2 })
      expect(read(data(home, 'chats/pc-only.todos.json')).items.map((i: { id: string }) => i.id)).toEqual(['p'])
      expect(read(data(home, 'chats/vps-only.todos.json')).items.map((i: { id: string }) => i.id)).toEqual(['v'])
    }
    expect(read(data(pc, 'chats/shared.todos.json'))).toEqual(read(data(vps, 'chats/shared.todos.json')))
    // a second run changes nothing
    expect(await go()).toBe(0)
    expect(read(data(pc, 'chats/shared.todos.json')).rev).toBe(4)
  })

  it('carries file-snapshots both ways, never overwriting a snapshot that exists', async () => {
    write(data(pc, `file-snapshots/pc-only/${HEX_A}`), 'pc-snap')
    write(data(vps, `file-snapshots/vps-only/${HEX_B}`), 'vps-snap')
    // Content-addressed, so the same name holds the same bytes; a union must keep the local one.
    write(data(pc, `file-snapshots/shared/${HEX_A}`), 'local')
    write(data(vps, `file-snapshots/shared/${HEX_A}`), 'remote')
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      expect(readFileSync(data(home, `file-snapshots/pc-only/${HEX_A}`), 'utf8')).toBe('pc-snap')
      expect(readFileSync(data(home, `file-snapshots/vps-only/${HEX_B}`), 'utf8')).toBe('vps-snap')
      expect(readFileSync(data(home, `file-snapshots/shared/${HEX_A}`), 'utf8')).toBe('local')
    }
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    expect(push.args.slice(3, -1)).toEqual(['chats.json', 'sidebar.json', 'chats', 'attachments', 'file-snapshots'].map((f) => data(pc, f)))
    expect(calls.some((c) => c.args.some((a) => a.startsWith('--delete')))).toBe(false)
  })

  it('keeps snapshot folders 0700 and files 0600 on both machines', async () => {
    const mode = (p: string) => statSync(p).mode & 0o777
    const lock = (home: string, rel: string) => {
      chmodSync(data(home, rel), 0o600)
      chmodSync(dirname(data(home, rel)), 0o700)
      chmodSync(dirname(dirname(data(home, rel))), 0o700)
    }
    write(data(vps, `file-snapshots/vps-only/${HEX_B}`), 'vps-snap')
    lock(vps, `file-snapshots/vps-only/${HEX_B}`)
    write(data(pc, `file-snapshots/pc-only/${HEX_A}`), 'pc-snap')
    lock(pc, `file-snapshots/pc-only/${HEX_A}`)
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      if (process.platform !== 'win32') expect(mode(data(home, 'file-snapshots'))).toBe(0o700)
      for (const rel of [`vps-only/${HEX_B}`, `pc-only/${HEX_A}`]) {
        if (process.platform !== 'win32') expect(mode(dirname(data(home, `file-snapshots/${rel}`)))).toBe(0o700)
        if (process.platform !== 'win32') expect(mode(data(home, `file-snapshots/${rel}`))).toBe(0o600)
      }
    }
  })

  const LOCAL_ONLY = ['browsers', 'browser-runtime', 'browser-shots', 'desktops', 'claude-tmp', 'audit']
  it('keeps browser profiles, runtimes, agent desktops and the audit log private on each machine and out of all data backups', async () => {
    for (const home of [pc, vps])
      for (const folder of LOCAL_ONLY) {
        write(data(home, `${folder}/local-marker`), home === pc ? 'pc' : 'vps')
        write(data(home, `${folder}/only-${home === pc ? 'pc' : 'vps'}`), 'private')
      }
    const run = fakeRun()
    let pulled = false
    expect(
      await go(async (cmd: string, args: string[]) => {
        const result = await run(cmd, args)
        if (cmd === 'rsync' && args.includes('bot@vps.example:.local/share/zumibot/')) {
          pulled = true
          for (const folder of LOCAL_ONLY) expect(existsSync(join(args.at(-1)!, folder))).toBe(false)
        }
        return result
      })
    ).toBe(0)
    expect(pulled).toBe(true)
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    expect(push.args.slice(3, -1)).toEqual(['chats.json', 'sidebar.json', 'chats', 'attachments'].map((f) => data(pc, f)))
    for (const home of [pc, vps])
      for (const folder of LOCAL_ONLY) {
        expect(readFileSync(data(home, `${folder}/local-marker`), 'utf8')).toBe(home === pc ? 'pc' : 'vps')
        expect(existsSync(data(home, `${folder}/only-${home === pc ? 'vps' : 'pc'}`))).toBe(false)
        // Derive the actual backup location from the operation's reported path.
        const line = logs.find((l) => l.startsWith('Synced'))!
        const paths = line.match(/Backups: (\S+) \(this PC\), (\S+) \(VPS\)/)!
        expect(existsSync(join(home === pc ? paths[1]! : paths[2]!, 'zumibot-data', folder))).toBe(false)
      }
  })

  it("keeps each machine's confirmed ACP launches (protocol-launch.json) on that machine, never pulled or pushed", async () => {
    const f = 'protocol-launch.json'
    for (const home of [pc, vps]) {
      write(data(home, f), `{"agents":{"gem":{"provider":"acp","command":"${home}","args":[],"authEnv":[]}}}\n`)
      chmodSync(data(home, f), 0o600)
    }
    const [pcBefore, vpsBefore] = [readFileSync(data(pc, f), 'utf8'), readFileSync(data(vps, f), 'utf8')]
    const run = fakeRun()
    let pulled = false
    expect(
      await go(async (cmd: string, args: string[]) => {
        const result = await run(cmd, args)
        if (cmd === 'rsync' && args.includes('bot@vps.example:.local/share/zumibot/')) {
          pulled = true
          expect(existsSync(join(args.at(-1)!, f))).toBe(false)
        }
        return result
      })
    ).toBe(0)
    expect(pulled).toBe(true)
    expect(readFileSync(data(pc, f), 'utf8')).toBe(pcBefore)
    expect(readFileSync(data(vps, f), 'utf8')).toBe(vpsBefore)
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    expect(push.args.some((a) => a.endsWith(f))).toBe(false)
  })

  it('keeps push keys and subscriptions on the side that owns them, byte for byte', async () => {
    const files = ['notify-devices.json', 'notify-vapid.json']
    for (const home of [pc, vps])
      for (const f of files) {
        const p = data(home, f)
        write(p, `{"side":"${home === pc ? 'pc' : 'vps'}","file":"${f}"}\n`)
        chmodSync(p, 0o600)
      }
    const before = (home: string) => files.map((f) => ({ body: readFileSync(data(home, f), 'utf8'), mode: statSync(data(home, f)).mode }))
    const [pcBefore, vpsBefore] = [before(pc), before(vps)]
    const run = fakeRun()
    let pulled = false
    expect(
      await go(async (cmd: string, args: string[]) => {
        const result = await run(cmd, args)
        if (cmd === 'rsync' && args.includes('bot@vps.example:.local/share/zumibot/')) {
          pulled = true
          for (const f of files) expect(existsSync(join(args.at(-1)!, f))).toBe(false)
        }
        return result
      })
    ).toBe(0)
    expect(pulled).toBe(true)
    expect(before(pc)).toEqual(pcBefore)
    expect(before(vps)).toEqual(vpsBefore)
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    for (const f of files) expect(push.args.some((a) => a.endsWith(f))).toBe(false)
  })

  it('merges usage records from both sides, uploads them, and leaves the derived estimates alone', async () => {
    const r = (id: string) => JSON.stringify({ id, kind: 'msg' })
    write(data(pc, 'usage-records.jsonl'), `${r('a')}\n${r('b')}\n`)
    write(data(vps, 'usage-records.jsonl'), `${r('b')}\n${r('c')}\n`)
    write(data(pc, 'usage-estimates.json'), { side: 'pc' })
    write(data(vps, 'usage-estimates.json'), { side: 'vps' })
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) expect(readFileSync(data(home, 'usage-records.jsonl'), 'utf8')).toBe(`${r('a')}\n${r('b')}\n${r('c')}\n`)
    expect(read(data(pc, 'usage-estimates.json'))).toEqual({ side: 'pc' })
    expect(read(data(vps, 'usage-estimates.json'))).toEqual({ side: 'vps' })
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    expect(push.args.some((a) => a.endsWith('usage-records.jsonl'))).toBe(true)
    expect(push.args.some((a) => a.endsWith('usage-estimates.json'))).toBe(false)
  })

  it('joins workflow messages, writes them 0600 and uploads them', async () => {
    const wm = (id: string, o: Record<string, unknown> = {}) => ({
      id,
      workflowId: 'w',
      workflowName: 'W',
      runId: 'r',
      stepName: 's',
      title: id,
      at: 1000,
      updatedAt: 1000,
      ...o
    })
    write(data(pc, 'workflow-messages.json'), { v: 1, seenAt: 5, messages: [wm('pc-only'), wm('both', { updatedAt: 1 })] })
    write(data(vps, 'workflow-messages.json'), {
      v: 1,
      seenAt: 9,
      messages: [wm('vps-only'), wm('both', { archivedAt: 2000, updatedAt: 2000 })]
    })
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      const f = read(data(home, 'workflow-messages.json'))
      expect(f.seenAt).toBe(9)
      expect(f.messages.map((x: { id: string }) => x.id)).toEqual(['pc-only', 'both', 'vps-only'])
      expect(f.messages[1].archivedAt).toBe(2000)
    }
    if (process.platform !== 'win32') expect(statSync(data(pc, 'workflow-messages.json')).mode & 0o777).toBe(0o600)
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    expect(push.args.some((a) => a.endsWith('workflow-messages.json'))).toBe(true)
  })

  it("joins the user's own to-do list (todos.json) by item id, writes it 0600 and uploads it", async () => {
    const td = (id: string, updatedAt: number, done: unknown = null) => ({
      id,
      text: id,
      group: null,
      from: { turn: 'user', itemId: null, label: 'Added by you', at: 1 },
      addedBy: 'user',
      done,
      removed: null,
      last: { action: 'added', by: 'user', at: updatedAt },
      rev: 1,
      updatedAt
    })
    write(data(pc, 'todos.json'), { v: 1, rev: 2, items: [td('pc-only', 5), td('both', 5)], seen: {} })
    write(data(vps, 'todos.json'), { v: 1, rev: 3, items: [td('vps-only', 5), td('both', 9, { at: 9, by: 'user' })], seen: {} })
    expect(await go()).toBe(0)
    for (const home of [pc, vps]) {
      const f = read(data(home, 'todos.json'))
      expect(f.items.map((i: { id: string }) => i.id)).toEqual(['pc-only', 'both', 'vps-only'])
      expect(f.items[1].done).toEqual({ at: 9, by: 'user' })
      expect(f.rev).toBe(4)
    }
    if (process.platform !== 'win32') expect(statSync(data(pc, 'todos.json')).mode & 0o777).toBe(0o600)
    const push = calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    expect(push.args.some((a) => a.endsWith('/todos.json'))).toBe(true)
  })

  it('an own to-do list only on this PC goes up as it is', async () => {
    const f = { v: 1, rev: 1, items: [], seen: {} }
    write(data(pc, 'todos.json'), f)
    expect(await go()).toBe(0)
    expect(read(data(vps, 'todos.json'))).toEqual(f)
  })

  it('a workflow message only on the VPS lands in this PC file', async () => {
    write(data(vps, 'workflow-messages.json'), {
      v: 1,
      seenAt: 0,
      messages: [{ id: 'v', workflowId: 'w', workflowName: 'W', runId: 'r', stepName: 's', title: 'v', at: 1, updatedAt: 1 }]
    })
    expect(await go()).toBe(0)
    expect(read(data(pc, 'workflow-messages.json')).messages.map((x: { id: string }) => x.id)).toEqual(['v'])
  })

  it('a second run changes nothing', async () => {
    expect(await go()).toBe(0)
    const before = readFileSync(data(vps, 'chats/shared.json'), 'utf8')
    expect(await go()).toBe(0)
    expect(readFileSync(data(vps, 'chats/shared.json'), 'utf8')).toBe(before)
    expect(readFileSync(data(pc, 'chats/shared.json'), 'utf8')).toBe(before)
  })

  it('refuses while a reply runs on the VPS, before touching anything', async () => {
    write(join(vps, 'busy'), '2\n')
    expect(await go()).toBe(1)
    expect(logs).toContain('2 replies running on the VPS. Sync again once they finish.')
    expect(calls.every((c) => c.cmd === 'ssh')).toBe(true)
  })

  // A sync.env carried over from ClaudeBot still named ~/claudebot, so the shell's bare "No such file" was all it said.
  it('names VPS_DIR when no server is installed there, before touching anything', async () => {
    const dir = join(vps, 'claudebot')
    expect(await go(fakeRun(), () => false, { VPS_DIR: dir })).toBe(1)
    expect(logs).toContain(
      `No ZumiBot server at ${dir} on the VPS. Set VPS_DIR to the folder it is installed in (the installer's default is /home/bot/zumibot).`
    )
    expect(calls.every((c) => c.cmd === 'ssh')).toBe(true)
  })

  it('refuses while ZumiBot runs on this PC', async () => {
    write(data(pc, 'server.lock'), '4242 1')
    expect(await go(fakeRun(), () => true)).toBe(1)
    expect(logs).toContain('ZumiBot is running on this PC. Close it, then sync again.')
    expect(calls.some((c) => c.cmd === 'rsync')).toBe(false)
  })

  // A password prompt or a dead host must never stall the sync.
  it('ssh never prompts or hangs, and rsync uses the same options', async () => {
    expect(await go()).toBe(0)
    const ssh = calls.filter((c) => c.cmd === 'ssh'),
      rsync = calls.filter((c) => c.cmd === 'rsync')
    expect(ssh.length).toBeGreaterThan(0)
    expect(rsync.length).toBeGreaterThan(0)
    for (const c of ssh) expect(c.args.slice(0, 4)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'])
    for (const c of rsync) expect(c.args).toContain('ssh -o BatchMode=yes -o ConnectTimeout=10')
  })

  it('names the user unit when the restart fails, and never mentions sudo', async () => {
    write(join(vps, 'systemctl-fail'), '')
    expect(await go()).toBe(1)
    const msg = logs.find((l) => l.includes('restarting it failed'))!
    expect(msg).toContain('systemctl --user status zumibot')
    expect(msg).not.toContain('sudo')
  })

  it('leaves the VPS chats alone when they change during the sync', async () => {
    const run = fakeRun((c) => {
      if (c.cmd === 'rsync' && c.args.at(-1)!.includes('/incoming/')) write(data(vps, 'chats.json'), { chats: [] })
    })
    expect(await go(run)).toBe(1)
    expect(read(data(vps, 'chats.json'))).toEqual({ chats: [] })
    expect(existsSync(join(vps, 'sudo.log'))).toBe(false)
    expect(logs.some((l) => l.startsWith('Chats changed on the VPS during the sync'))).toBe(true)
  })

  it('keeps both backup folders and the incoming folder private to the user', async () => {
    expect(await go()).toBe(0)
    const [bk, rbk] = logs
      .find((l) => l.startsWith('Synced'))!
      .match(/Backups: (\S+) \(this PC\), (\S+) \(VPS\)/)!
      .slice(1, 3) as [string, string]
    if (process.platform !== 'win32')
      for (const dir of [bk, rbk, join(rbk, 'incoming')]) expect(statSync(dir).mode & 0o777, dir).toBe(0o700)
  })

  describe('vault', () => {
    // HOME is the temp PC home and no XDG_CONFIG_HOME is passed, so both keys live under the temp homes.
    const keyFile = (home: string) => join(home, '.config/zumibot-vault/vault.key')
    const putKey = (home: string, key: Buffer) => {
      write(keyFile(home), `${key.toString('base64')}\n`)
      chmodSync(keyFile(home), 0o600)
    }
    const keyOf = (home: string) => Buffer.from(readFileSync(keyFile(home), 'utf8').trim(), 'base64')
    const mode = (p: string) => statSync(p).mode & 0o777
    const incoming = () => calls.find((c) => c.cmd === 'rsync' && c.args.at(-1)!.endsWith('/incoming/'))!
    const backups = () =>
      logs
        .find((l) => l.startsWith('Synced'))!
        .match(/Backups: (\S+) \(this PC\), (\S+) \(VPS\)/)!
        .slice(1, 3) as [string, string]
    // Every way the key could leak as text: the file's base64, hex, and the base64 of the file the ssh read sends back.
    const forms = (k: Buffer) => [
      k.toString('base64'),
      k.toString('hex'),
      Buffer.from(`${k.toString('base64')}\n`)
        .toString('base64')
        .slice(0, 40)
    ]
    const filesUnder = (dir: string): string[] =>
      existsSync(dir)
        ? readdirSync(dir, { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => join(e.parentPath, e.name))
        : []

    it('copies a vault key only the VPS has to this PC and joins the vault', async () => {
      const K = randomBytes(32)
      putKey(vps, K)
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 10)]))
      // An old tombstone-only file from a key this PC no longer has carries nothing sealed.
      write(data(pc, 'vault.json'), vFile(randomBytes(32), [vTomb('t', 5)]))
      expect(await go()).toBe(0)
      expect(readFileSync(keyFile(pc), 'utf8')).toBe(`${K.toString('base64')}\n`)
      if (process.platform !== 'win32') expect(mode(keyFile(pc))).toBe(0o600)
      if (process.platform !== 'win32') expect(mode(dirname(keyFile(pc)))).toBe(0o700)
      for (const home of [pc, vps]) {
        const f = read(data(home, 'vault.json')) as VFile
        expect(f.keyId).toBe(keyIdOf(K))
        expect(vShape(f)).toEqual([
          ['t', 5, true],
          ['v', 10, false]
        ])
        expect(openItem(K, f.items[1])).toEqual(vBody('v', 10))
        if (process.platform !== 'win32') expect(mode(data(home, 'vault.json'))).toBe(0o600)
      }
      expect(logs).toContain('Vault key copied from the VPS to this PC.')
      expect(incoming().args.some((a) => a.endsWith('/vault.json'))).toBe(true)
    })

    it('copies a vault key only this PC has to the VPS over ssh stdin, never in argv', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 3)]))
      expect(await go()).toBe(0)
      expect(readFileSync(keyFile(vps), 'utf8')).toBe(`${K.toString('base64')}\n`)
      if (process.platform !== 'win32') expect(mode(keyFile(vps))).toBe(0o600)
      if (process.platform !== 'win32') expect(mode(dirname(keyFile(vps)))).toBe(0o700)
      // The temp file the key was written through is gone.
      expect(readdirSync(dirname(keyFile(vps)))).toEqual(['vault.key'])
      for (const home of [pc, vps]) expect(vShape(read(data(home, 'vault.json')))).toEqual([['p', 3, false]])
      expect(calls.some((c) => c.cmd === 'ssh' && c.input?.includes(K.toString('base64')))).toBe(true)
      for (const f of forms(K)) expect(calls.some((c) => c.args.join(' ').includes(f))).toBe(false)
      expect(logs).toContain('Vault key copied from this PC to the VPS.')
      // The next run finds one key on both sides and copies nothing.
      expect(await go()).toBe(0)
      expect(readFileSync(keyFile(vps), 'utf8')).toBe(`${K.toString('base64')}\n`)
    })

    it("reseals this PC's vault under the VPS key and keeps the old key beside it", async () => {
      const [KV, KP] = [randomBytes(32), randomBytes(32)]
      putKey(vps, KV)
      write(data(vps, 'vault.json'), vFile(KV, [vLive(KV, 'v', 10)]))
      putKey(pc, KP)
      write(data(pc, 'vault.json'), vFile(KP, [vLive(KP, 'p', 20, { password: 'pc-secret' }), vTomb('gone', 4)]))
      expect(await go()).toBe(0)
      expect(keyOf(pc).equals(KV)).toBe(true)
      expect(keyOf(vps).equals(KV)).toBe(true)
      const dir = dirname(keyFile(pc))
      const kept = readdirSync(dir).filter((f) => f.startsWith('vault.key.replaced-'))
      expect(kept).toHaveLength(1)
      expect(readdirSync(dir).sort()).toEqual(['vault.key', kept[0]].sort())
      expect(readFileSync(join(dir, kept[0]!), 'utf8').trim()).toBe(KP.toString('base64'))
      if (process.platform !== 'win32') expect(mode(join(dir, kept[0]!))).toBe(0o600)
      if (process.platform !== 'win32') expect(mode(keyFile(pc))).toBe(0o600)
      for (const home of [pc, vps]) {
        const f = read(data(home, 'vault.json')) as VFile
        expect(f.keyId).toBe(keyIdOf(KV))
        expect(vShape(f)).toEqual([
          ['p', 20, false],
          ['gone', 4, true],
          ['v', 10, false]
        ])
        expect(openItem(KV, f.items[0])).toEqual(vBody('p', 20, { password: 'pc-secret' }))
        expect(openItem(KV, f.items[2])).toEqual(vBody('v', 10))
      }
      expect(logs.some((l) => l.startsWith("This PC's vault used another key: its items are now sealed with the VPS key."))).toBe(true)
      // The PC's backup keeps the vault as it was, still sealed with the old key.
      expect((read(join(backups()[0], 'zumibot-data/vault.json')) as VFile).keyId).toBe(keyIdOf(KP))
      // A second run finds one key on both sides and changes nothing.
      const after = [pc, vps].map((h) => readFileSync(data(h, 'vault.json'), 'utf8'))
      expect(await go()).toBe(0)
      expect([pc, vps].map((h) => readFileSync(data(h, 'vault.json'), 'utf8'))).toEqual(after)
      expect(readdirSync(dir).filter((f) => f.startsWith('vault.key.replaced-'))).toHaveLength(1)
    })

    it('never puts a vault key in argv, logs, the work dir or a backup', async () => {
      const [KV, KP] = [randomBytes(32), randomBytes(32)]
      putKey(vps, KV)
      write(data(vps, 'vault.json'), vFile(KV, [vLive(KV, 'v', 10)]))
      putKey(pc, KP)
      write(data(pc, 'vault.json'), vFile(KP, [vLive(KP, 'p', 20)]))
      const run = fakeRun()
      let work = ''
      const seen = new Map<string, string>()
      expect(
        await go(async (cmd: string, args: string[], opts?: { input?: string }) => {
          const result = await run(cmd, args, opts)
          if (cmd === 'rsync' && args.includes('bot@vps.example:.local/share/zumibot/')) work = dirname(args.at(-1)!)
          // The upload is the last step before the swap, when the work dir holds the most; it is gone after the run.
          if (cmd === 'rsync' && args.at(-1)!.endsWith('/incoming/'))
            for (const f of filesUnder(work)) seen.set(f, readFileSync(f, 'latin1'))
          return result
        })
      ).toBe(0)
      expect([...seen.keys()].some((f) => f.endsWith('/vault.json'))).toBe(true)
      const [bk, rbk] = backups()
      const stored = [...seen.values(), ...[...filesUnder(bk), ...filesUnder(rbk)].map((f) => readFileSync(f, 'latin1'))]
      for (const k of [KV, KP])
        for (const f of forms(k)) {
          expect(logs.join('\n')).not.toContain(f)
          expect(calls.some((c) => c.args.join(' ').includes(f))).toBe(false)
          expect(stored.some((s) => s.includes(f))).toBe(false)
        }
    })

    it("leaves both vaults alone when a side's vault does not match its key, and syncs the rest", async () => {
      const [KV, KP] = [randomBytes(32), randomBytes(32)]
      putKey(vps, KV)
      write(data(vps, 'vault.json'), vFile(KV, [vLive(KV, 'v', 10)]))
      putKey(pc, KP)
      // Sealed with a key this PC does not have (keyMismatch here): never re-sealed or merged.
      write(data(pc, 'vault.json'), vFile(KV, [vLive(KV, 'p', 20)]))
      const snap = () => [pc, vps].flatMap((h) => [readFileSync(data(h, 'vault.json'), 'utf8'), readFileSync(keyFile(h), 'utf8')])
      const before = snap()
      expect(await go()).toBe(0)
      expect(snap()).toEqual(before)
      expect(readdirSync(dirname(keyFile(pc)))).toEqual(['vault.key'])
      expect(logs).toContain(
        "The vault was left as it was on both machines. This PC's vault.json was sealed with a different key than its vault key."
      )
      expect(incoming().args.some((a) => a.endsWith('/vault.json'))).toBe(false)
      expect(existsSync(data(pc, 'chats/vps-only.json')) && existsSync(data(vps, 'chats/pc-only.json'))).toBe(true)
    })

    it('leaves both vaults alone when a vault.json or key file cannot be read', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 1)]))
      write(data(vps, 'vault.json'), '{"v":1,"keyId":')
      expect(await go()).toBe(0)
      expect(readFileSync(data(vps, 'vault.json'), 'utf8')).toBe('{"v":1,"keyId":')
      expect(existsSync(keyFile(vps))).toBe(false)
      expect(logs).toContain("The vault was left as it was on both machines. The VPS's vault.json can't be read.")
      logs = []
      write(data(vps, 'vault.json'), vFile(K, []))
      write(keyFile(vps), 'not a key\n')
      expect(await go()).toBe(0)
      expect(readFileSync(keyFile(vps), 'utf8')).toBe('not a key\n')
      expect(logs).toContain('The vault was left as it was on both machines. The vault key file on the VPS is not a valid key.')
    })

    it('keeps a VPS vault that changed during the sync', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      putKey(vps, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 1)]))
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      const changed = vFile(K, [vLive(K, 'v', 1), vLive(K, 'late', 2)])
      const run = fakeRun((c) => {
        if (c.cmd === 'rsync' && c.args.at(-1)!.includes('/incoming/')) write(data(vps, 'vault.json'), changed)
      })
      expect(await go(run)).toBe(0)
      expect(read(data(vps, 'vault.json'))).toEqual(changed)
      expect(vShape(read(data(pc, 'vault.json')))).toEqual([
        ['p', 1, false],
        ['v', 1, false]
      ])
      expect(logs).toContain('The vault changed on the VPS during the sync, so it was left as it was there. Sync again to update it.')
      expect(await go()).toBe(0)
      for (const home of [pc, vps])
        expect((read(data(home, 'vault.json')) as VFile).items.map((i) => i.id).sort()).toEqual(['late', 'p', 'v'])
    })

    it('reads the VPS key from VPS_VAULT_KEY_FILE and refuses an unsafe one', async () => {
      const K = randomBytes(32)
      write(join(vps, 'keys/vault.key'), `${K.toString('base64')}\n`)
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      for (const bad of ['~/.local/share/zumibot/vault.key', 'keys/vault.key', '~/k;touch x', '~/a/../.local/share/zumibot/k']) {
        logs = []
        expect(await go(fakeRun(), undefined, { VPS_VAULT_KEY_FILE: bad })).toBe(0)
        expect(existsSync(keyFile(pc))).toBe(false)
        expect(logs.some((l) => l.startsWith('The vault was left as it was on both machines. VPS_VAULT_KEY_FILE '))).toBe(true)
      }
      expect(await go(fakeRun(), undefined, { VPS_VAULT_KEY_FILE: '~/keys/vault.key' })).toBe(0)
      expect(keyOf(pc).equals(K)).toBe(true)
      expect(existsSync(keyFile(vps))).toBe(false)
    })

    afterEach(() => Object.assign(fsTrace, { on: false, ops: [], failRename: null, sizeLimit: null, failClose: null }))
    // The VPS reports its home folder with a trailing slash.
    const slashHome =
      (run = fakeRun()) =>
      async (cmd: string, args: string[], opts?: { input?: string }) =>
        cmd === 'ssh' && args.at(-1) === 'printf %s "$HOME"'
          ? (calls.push({ cmd, args }), { code: 0, stdout: `${vps}/`, stderr: '' })
          : run(cmd, args, opts)
    const realBin = (name: string) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
    const fakeBin = (name: string, body: string) => {
      write(join(root, 'bin', name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(root, 'bin', name), 0o755)
    }
    // A reseal: this PC's vault under its own key, the VPS's under another.
    const twoKeys = () => {
      const [KV, KP] = [randomBytes(32), randomBytes(32)]
      putKey(vps, KV)
      write(data(vps, 'vault.json'), vFile(KV, [vLive(KV, 'v', 10)]))
      putKey(pc, KP)
      write(data(pc, 'vault.json'), vFile(KP, [vLive(KP, 'p', 20)]))
      return { KV, KP }
    }

    it('flushes the old key copy, the new key and the joined vault to disk before the new key goes in', async () => {
      twoKeys()
      const kf = keyFile(pc)
      const vaultPath = data(pc, 'vault.json')
      fsTrace.on = true
      expect(await go()).toBe(0)
      fsTrace.on = false
      const replaced = readdirSync(dirname(kf)).find((f) => f.startsWith('vault.key.replaced-'))!
      const ops = fsTrace.ops
      const keyIn = ops.indexOf(`rename ${kf}.sync-tmp ${kf}`)
      expect(keyIn).toBeGreaterThan(0)
      const before = (op: string) => {
        const at = ops.indexOf(op)
        expect(at, op).toBeGreaterThanOrEqual(0)
        expect(at, op).toBeLessThan(keyIn)
        return at
      }
      before(`fsync ${join(dirname(kf), replaced)}`)
      before(`fsync ${kf}.sync-tmp`)
      const vaultIn = before(`rename ${vaultPath}.sync-tmp ${vaultPath}`)
      expect(before(`fsync ${vaultPath}.sync-tmp`)).toBeLessThan(vaultIn)
      // The folders' entries too: the vault's rename, and the kept old key and the new one beside it.
      expect(ops.slice(vaultIn, keyIn)).toContain(`fsync ${dirname(vaultPath)}`)
      before(`fsync ${dirname(kf)}`)
      expect(ops.slice(keyIn)).toContain(`fsync ${dirname(kf)}`)
    })

    it('refuses a VPS key inside the data folder even when the VPS home ends in a slash', async () => {
      const K = randomBytes(32)
      write(data(vps, 'vault.key'), `${K.toString('base64')}\n`)
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      expect(await go(slashHome(), undefined, { VPS_VAULT_KEY_FILE: '~/.local/share/zumibot/vault.key' })).toBe(0)
      expect(existsSync(keyFile(pc))).toBe(false)
      expect(logs.some((l) => l.startsWith('The vault was left as it was on both machines. VPS_VAULT_KEY_FILE '))).toBe(true)
    })

    it('never pulls or backs up a vault key file that sits in the VPS data folder', async () => {
      write(data(vps, 'vault.key'), 'misplaced key')
      write(data(vps, 'vault.key.replaced-1'), 'misplaced old key')
      const run = fakeRun()
      let work = ''
      let pulled: string[] = []
      expect(
        await go(async (cmd: string, args: string[], opts?: { input?: string }) => {
          const result = await run(cmd, args, opts)
          if (cmd === 'rsync' && args.includes('bot@vps.example:.local/share/zumibot/')) work = dirname(args.at(-1)!)
          if (cmd === 'rsync' && args.at(-1)!.endsWith('/incoming/')) pulled = filesUnder(work)
          return result
        })
      ).toBe(0)
      expect(pulled.some((f) => f.endsWith('/chats.json'))).toBe(true)
      expect(pulled.filter((f) => f.includes('vault.key'))).toEqual([])
      const [, rbk] = backups()
      expect(existsSync(join(rbk, 'zumibot-data/chats.json'))).toBe(true)
      expect(filesUnder(rbk).filter((f) => f.includes('vault.key'))).toEqual([])
      expect(filesUnder(data(pc, '')).filter((f) => f.includes('vault.key'))).toEqual([])
    })

    it('still carries an attachment whose name starts like a key file', async () => {
      write(data(vps, 'attachments/vps-only/y/vault.keynote.pdf'), 'slides')
      expect(await go()).toBe(0)
      expect(readFileSync(data(pc, 'attachments/vps-only/y/vault.keynote.pdf'), 'utf8')).toBe('slides')
      expect(existsSync(join(backups()[1], 'zumibot-data/attachments/vps-only/y/vault.keynote.pdf'))).toBe(true)
    })

    it('finishes a key rename an earlier sync left undone, once every item opens with the new key', async () => {
      const [KV, KP] = [randomBytes(32), randomBytes(32)]
      putKey(vps, KV)
      write(data(vps, 'vault.json'), vFile(KV, [vLive(KV, 'v', 10)]))
      // The earlier run stopped after writing the joined vault: the old key is still in place, kept aside, and the
      // VPS key sits in the temp file.
      putKey(pc, KP)
      write(`${keyFile(pc)}.replaced-2026-01-01-000000`, `${KP.toString('base64')}\n`)
      write(`${keyFile(pc)}.sync-tmp`, `${KV.toString('base64')}\n`)
      write(data(pc, 'vault.json'), vFile(KV, [vLive(KV, 'p', 20), vLive(KV, 'v', 10)]))
      expect(await go()).toBe(0)
      expect(keyOf(pc).equals(KV)).toBe(true)
      if (process.platform !== 'win32') expect(mode(keyFile(pc))).toBe(0o600)
      expect(readdirSync(dirname(keyFile(pc))).sort()).toEqual(['vault.key', 'vault.key.replaced-2026-01-01-000000'])
      expect(logs).toContain('An earlier sync stopped while putting the VPS vault key in place on this PC; it is in place now.')
      for (const home of [pc, vps]) {
        const f = read(data(home, 'vault.json')) as VFile
        expect(f.keyId).toBe(keyIdOf(KV))
        expect(vShape(f)).toEqual([
          ['p', 20, false],
          ['v', 10, false]
        ])
      }
    })

    it('keeps the old key aside before finishing such a rename, if no copy holds it', async () => {
      const [KV, KP] = [randomBytes(32), randomBytes(32)]
      putKey(vps, KV)
      putKey(pc, KP)
      write(`${keyFile(pc)}.sync-tmp`, `${KV.toString('base64')}\n`)
      write(data(pc, 'vault.json'), vFile(KV, [vLive(KV, 'p', 20)]))
      expect(await go()).toBe(0)
      expect(keyOf(pc).equals(KV)).toBe(true)
      const kept = readdirSync(dirname(keyFile(pc))).filter((f) => f.startsWith('vault.key.replaced-'))
      expect(kept).toHaveLength(1)
      expect(readFileSync(join(dirname(keyFile(pc)), kept[0]!), 'utf8').trim()).toBe(KP.toString('base64'))
      if (process.platform !== 'win32') expect(mode(join(dirname(keyFile(pc)), kept[0]!))).toBe(0o600)
    })

    it('never renames a linked temp key in', async () => {
      const [KV, KP] = [randomBytes(32), randomBytes(32)]
      putKey(vps, KV)
      putKey(pc, KP)
      write(join(root, 'elsewhere.key'), `${KV.toString('base64')}\n`)
      symlinkSync(join(root, 'elsewhere.key'), `${keyFile(pc)}.sync-tmp`)
      write(data(pc, 'vault.json'), vFile(KV, [vLive(KV, 'p', 20)]))
      expect(await go()).toBe(0)
      expect(lstatSync(keyFile(pc)).isFile()).toBe(true)
      expect(keyOf(pc).equals(KP)).toBe(true)
      expect(lstatSync(`${keyFile(pc)}.sync-tmp`).isSymbolicLink()).toBe(true)
      expect(logs).toContain(`${keyFile(pc)}.sync-tmp is not a plain file, so it was not put in place as this PC's vault key.`)
    })

    it('leaves a temp key alone when the vault does not open with it', async () => {
      const [KV, KP, KX] = [randomBytes(32), randomBytes(32), randomBytes(32)]
      putKey(vps, KV)
      write(data(vps, 'vault.json'), vFile(KV, [vLive(KV, 'v', 10)]))
      putKey(pc, KP)
      // The key id matches the temp key, but an item was sealed with another key.
      write(`${keyFile(pc)}.sync-tmp`, `${KV.toString('base64')}\n`)
      write(data(pc, 'vault.json'), vFile(KV, [vLive(KV, 'p', 20), vLive(KX, 'x', 21)]))
      const before = readFileSync(data(pc, 'vault.json'), 'utf8')
      expect(await go()).toBe(0)
      expect(keyOf(pc).equals(KP)).toBe(true)
      expect(readFileSync(`${keyFile(pc)}.sync-tmp`, 'utf8').trim()).toBe(KV.toString('base64'))
      expect(readFileSync(data(pc, 'vault.json'), 'utf8')).toBe(before)
      expect(logs.some((l) => l.startsWith('The vault was left as it was on both machines.'))).toBe(true)
    })

    it('never replaces a key that appears on the VPS before the push', async () => {
      const [K, KO] = [randomBytes(32), randomBytes(32)]
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 3)]))
      // The VPS server makes its own key between the sync's read and its push.
      const run = fakeRun((c) => {
        if (c.cmd === 'ssh' && c.args.at(-1)!.includes('mktemp')) putKey(vps, KO)
      })
      expect(await go(run)).toBe(0)
      expect(keyOf(vps).equals(KO)).toBe(true)
      expect(readdirSync(dirname(keyFile(vps)))).toEqual(['vault.key'])
      expect(logs).toContain('The vault was left as it was on both machines. A vault key appeared on the VPS during the sync. Sync again.')
      expect(incoming().args.some((a) => a.endsWith('/vault.json'))).toBe(false)
      expect(existsSync(data(vps, 'vault.json'))).toBe(false)
    })

    it('never replaces a key that appears on the VPS between its check and the link', async () => {
      const [K, KO] = [randomBytes(32), randomBytes(32)]
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 3)]))
      // mktemp runs after the push script's own check: the key appears there, so only the link can notice.
      fakeBin('mktemp', `printf '%s\\n' ${KO.toString('base64')} > "\${1%.sync-XXXXXX}"\nexec ${realBin('mktemp')} "$@"`)
      expect(await go()).toBe(0)
      expect(keyOf(vps).equals(KO)).toBe(true)
      expect(readdirSync(dirname(keyFile(vps)))).toEqual(['vault.key'])
      expect(logs).toContain('The vault was left as it was on both machines. A vault key appeared on the VPS during the sync. Sync again.')
    })

    it('tells a VPS folder without hard links apart from a key that appeared', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 3)]))
      fakeBin('ln', 'echo "ln: failed to create hard link: Operation not permitted" >&2\nexit 1')
      expect(await go()).toBe(0)
      expect(existsSync(keyFile(vps))).toBe(false)
      expect(readdirSync(dirname(keyFile(vps)))).toEqual([])
      expect(logs.some((l) => l.includes('appeared'))).toBe(false)
      expect(logs).toContain(
        'The vault was left as it was on both machines. Could not link the vault key into place on the VPS (its folder may not allow hard links), so it was not copied there.'
      )
    })

    it('reads a dangling link where the VPS key goes as a key that appeared, not a folder without hard links', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 3)]))
      mkdirSync(dirname(keyFile(vps)), { recursive: true })
      symlinkSync(join(vps, 'nowhere.key'), keyFile(vps))
      expect(await go()).toBe(0)
      expect(lstatSync(keyFile(vps)).isSymbolicLink()).toBe(true)
      expect(existsSync(join(vps, 'nowhere.key'))).toBe(false)
      expect(readdirSync(dirname(keyFile(vps)))).toEqual(['vault.key'])
      expect(logs).toContain('The vault was left as it was on both machines. A vault key appeared on the VPS during the sync. Sync again.')
    })

    it('rolls a reseal back when the joined vault cannot be written', async () => {
      const { KP } = twoKeys()
      const before = readFileSync(data(pc, 'vault.json'), 'utf8')
      // A folder where the vault's temp file goes makes that write fail after both key files were made.
      mkdirSync(data(pc, 'vault.json.sync-tmp'))
      expect(await go()).toBe(0)
      expect(keyOf(pc).equals(KP)).toBe(true)
      expect(readdirSync(dirname(keyFile(pc)))).toEqual(['vault.key'])
      expect(readFileSync(data(pc, 'vault.json'), 'utf8')).toBe(before)
      expect(logs).toContain("The vault was left as it was on both machines. Could not write this PC's vault under the VPS key.")
      expect(existsSync(data(pc, 'chats/vps-only.json')) && existsSync(data(vps, 'chats/pc-only.json'))).toBe(true)
    })

    it('puts the vault back when the new key cannot be renamed in, and syncs the rest', async () => {
      const { KV, KP } = twoKeys()
      const before = readFileSync(data(pc, 'vault.json'), 'utf8')
      fsTrace.failRename = (from, to) => to === keyFile(pc) && from === `${keyFile(pc)}.sync-tmp`
      expect(await go()).toBe(0)
      expect(keyOf(pc).equals(KP)).toBe(true)
      expect(readdirSync(dirname(keyFile(pc)))).toEqual(['vault.key'])
      expect(readFileSync(data(pc, 'vault.json'), 'utf8')).toBe(before)
      expect(keyOf(vps).equals(KV)).toBe(true)
      expect(logs).toContain('The vault was left as it was on both machines. Could not put the VPS vault key in place on this PC.')
      for (const f of forms(KV)) expect(logs.join('\n')).not.toContain(f)
      expect(incoming().args.some((a) => a.endsWith('/vault.json'))).toBe(false)
      expect(existsSync(data(pc, 'chats/vps-only.json')) && existsSync(data(vps, 'chats/pc-only.json'))).toBe(true)
    })

    it('finishes on the next sync a reseal whose new key could not go in and whose old vault could not be put back', async () => {
      const { KV, KP } = twoKeys()
      // The key rename fails, and so does the vault's own rename when the old one is put back (its first write went through).
      let vaultRenames = 0
      fsTrace.failRename = (from, to) =>
        (to === keyFile(pc) && from === `${keyFile(pc)}.sync-tmp`) || (to === data(pc, 'vault.json') && ++vaultRenames > 1)
      expect(await go()).toBe(0)
      expect(logs).toContain(
        "The vault was left as it was on both machines. Could not put the VPS vault key in place on this PC, nor this PC's vault back. Sync again to finish."
      )
      // Left for the next sync: the old key in place and kept aside, the VPS key in the temp file, the vault sealed with it.
      expect(keyOf(pc).equals(KP)).toBe(true)
      expect(readFileSync(`${keyFile(pc)}.sync-tmp`, 'utf8').trim()).toBe(KV.toString('base64'))
      expect(readdirSync(dirname(keyFile(pc))).filter((f) => f.startsWith('vault.key.replaced-'))).toHaveLength(1)
      expect((read(data(pc, 'vault.json')) as VFile).keyId).toBe(keyIdOf(KV))
      expect(incoming().args.some((a) => a.endsWith('/vault.json'))).toBe(false)
      for (const f of forms(KV)) expect(logs.join('\n')).not.toContain(f)
      fsTrace.failRename = null
      logs = []
      expect(await go()).toBe(0)
      expect(logs).toContain('An earlier sync stopped while putting the VPS vault key in place on this PC; it is in place now.')
      expect(keyOf(pc).equals(KV)).toBe(true)
      const dir = dirname(keyFile(pc))
      expect(readdirSync(dir).filter((f) => f !== 'vault.key')).toHaveLength(1)
      expect(
        readFileSync(
          join(
            dir,
            readdirSync(dir).find((f) => f.startsWith('vault.key.replaced-'))!
          ),
          'utf8'
        ).trim()
      ).toBe(KP.toString('base64'))
      for (const home of [pc, vps]) {
        const f = read(data(home, 'vault.json')) as VFile
        expect(f.keyId).toBe(keyIdOf(KV))
        expect(vShape(f)).toEqual([
          ['p', 20, false],
          ['v', 10, false]
        ])
      }
    })

    it('replaces the VPS vault through a temp file, so a full VPS disk never cuts the live vault short', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      putKey(vps, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 1)]))
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      const before = readFileSync(data(vps, 'vault.json'), 'utf8')
      // A full disk on the VPS: any copy of vault.json writes a few bytes, then fails.
      fakeBin(
        'cp',
        `for last; do :; done\ncase "$last" in *vault.json*) printf '{"v":1,' > "$last"; echo "cp: error writing: No space left on device" >&2; exit 1;; esac\nexec ${realBin('cp')} "$@"`
      )
      expect(await go()).toBe(0)
      expect(readFileSync(data(vps, 'vault.json'), 'utf8')).toBe(before)
      expect(readdirSync(data(vps, '')).filter((f) => f.startsWith('vault.json'))).toEqual(['vault.json'])
      expect(logs).toContain(
        'The vault could not be written on the VPS (its disk may be full), so it was left as it was there. Sync again to update it.'
      )
      // The rest of the swap went on.
      expect(existsSync(data(vps, 'chats/pc-only.json'))).toBe(true)
      rmSync(join(root, 'bin', 'cp'))
      expect(await go()).toBe(0)
      expect(vShape(read(data(vps, 'vault.json')))).toEqual([
        ['p', 1, false],
        ['v', 1, false]
      ])
      if (process.platform !== 'win32') expect(mode(data(vps, 'vault.json'))).toBe(0o600)
      expect(readdirSync(data(vps, '')).filter((f) => f.startsWith('vault.json'))).toEqual(['vault.json'])
    })

    it('never links a vault key into place on the VPS that arrived cut short', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 3)]))
      const real = fakeRun()
      // The connection drops partway through the key.
      const run = async (cmd: string, args: string[], opts?: { input?: string }) =>
        real(cmd, args, cmd === 'ssh' && args.at(-1)!.includes('mktemp') && opts?.input ? { input: opts.input.slice(0, 20) } : opts)
      expect(await go(run)).toBe(0)
      expect(existsSync(keyFile(vps))).toBe(false)
      expect(readdirSync(dirname(keyFile(vps)))).toEqual([])
      expect(logs).toContain(
        'The vault was left as it was on both machines. The vault key did not reach the VPS whole, so it was not put in place there. Sync again.'
      )
      expect(incoming().args.some((a) => a.endsWith('/vault.json'))).toBe(false)
      // A whole key on the next run goes in.
      expect(await go()).toBe(0)
      expect(keyOf(vps).equals(K)).toBe(true)
    })

    it('reads a symlinked VPS key folder by where it points, and makes it private only when that is open', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 1)]))
      const real = join(vps, 'secure/zumibot-vault')
      mkdirSync(real, { recursive: true })
      chmodSync(real, 0o700)
      mkdirSync(join(vps, '.config'), { recursive: true })
      symlinkSync(real, dirname(keyFile(vps)))
      expect(await go()).toBe(0)
      expect(readFileSync(join(real, 'vault.key'), 'utf8').trim()).toBe(K.toString('base64'))
      expect(logs.some((l) => l.includes('private (0700)'))).toBe(false)
      // Open where it points: made private, and said once.
      rmSync(join(real, 'vault.key'))
      rmSync(data(vps, 'vault.json'), { force: true })
      chmodSync(real, 0o755)
      logs = []
      expect(await go()).toBe(0)
      if (process.platform !== 'win32') expect(mode(real)).toBe(0o700)
      expect(logs).toContain(`Made the VPS vault key folder ${dirname(keyFile(vps))} private (0700): it was open to other users.`)
    })

    // A file-size limit on the path the write goes through.
    const limitAt = (suffix: string, bytes: number) => {
      fsTrace.sizeLimit = (p) => (p.endsWith(suffix) ? bytes : undefined)
    }

    it('never renames in or uploads a joined vault that a write cut short', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      putKey(vps, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 1)]))
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      const before = [pc, vps].map((h) => readFileSync(data(h, 'vault.json'), 'utf8'))
      limitAt('/vault.json.sync-tmp', 100)
      expect(await go()).toBe(0)
      expect([pc, vps].map((h) => readFileSync(data(h, 'vault.json'), 'utf8'))).toEqual(before)
      expect(existsSync(data(pc, 'vault.json.sync-tmp'))).toBe(false)
      expect(logs).toContain('The vault was left as it was on both machines. Could not write the merged vault on this PC.')
      expect(incoming().args.some((a) => a.endsWith('/vault.json'))).toBe(false)
    })

    it('rolls a reseal back when the joined vault or the new key is cut short', async () => {
      const { KP } = twoKeys()
      const before = readFileSync(data(pc, 'vault.json'), 'utf8')
      for (const suffix of ['/vault.json.sync-tmp', '/vault.key.sync-tmp']) {
        logs = []
        limitAt(suffix, 10)
        expect(await go()).toBe(0)
        expect(keyOf(pc).equals(KP), suffix).toBe(true)
        expect(readdirSync(dirname(keyFile(pc))), suffix).toEqual(['vault.key'])
        expect(readFileSync(data(pc, 'vault.json'), 'utf8'), suffix).toBe(before)
        expect(logs, suffix).toContain("The vault was left as it was on both machines. Could not write this PC's vault under the VPS key.")
      }
    })

    it('never leaves a pulled vault key that a write cut short', async () => {
      const K = randomBytes(32)
      putKey(vps, K)
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      limitAt('/zumibot-vault/vault.key', 10)
      expect(await go()).toBe(0)
      expect(existsSync(keyFile(pc))).toBe(false)
      expect(logs).toContain('The vault was left as it was on both machines. Could not write the vault key on this PC.')
      expect(existsSync(data(pc, 'vault.json'))).toBe(false)
    })

    it('removes a pulled vault key whose close failed, never leaving it in place', async () => {
      const K = randomBytes(32)
      putKey(vps, K)
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      fsTrace.failClose = (p) => p.endsWith('/zumibot-vault/vault.key')
      expect(await go()).toBe(0)
      expect(existsSync(keyFile(pc))).toBe(false)
      expect(logs).toContain('The vault was left as it was on both machines. Could not write the vault key on this PC.')
      fsTrace.failClose = null
      expect(await go()).toBe(0)
      expect(keyOf(pc).equals(K)).toBe(true)
    })

    it('reports a joined vault it cannot write in a sentence, and syncs the rest', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      putKey(vps, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 1)]))
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      const before = [pc, vps].map((h) => readFileSync(data(h, 'vault.json'), 'utf8'))
      mkdirSync(data(pc, 'vault.json.sync-tmp'))
      expect(await go()).toBe(0)
      expect([pc, vps].map((h) => readFileSync(data(h, 'vault.json'), 'utf8'))).toEqual(before)
      expect(logs).toContain('The vault was left as it was on both machines. Could not write the merged vault on this PC.')
      for (const f of forms(K)) expect(logs.join('\n')).not.toContain(f)
      expect(incoming().args.some((a) => a.endsWith('/vault.json'))).toBe(false)
      expect(existsSync(data(pc, 'chats/vps-only.json')) && existsSync(data(vps, 'chats/pc-only.json'))).toBe(true)
    })

    it('makes a loose vault key folder private when it writes a key there', async () => {
      const K = randomBytes(32)
      putKey(vps, K)
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      mkdirSync(dirname(keyFile(pc)), { recursive: true })
      chmodSync(dirname(keyFile(pc)), 0o755)
      chmodSync(pc, 0o755)
      expect(await go()).toBe(0)
      expect(keyOf(pc).equals(K)).toBe(true)
      if (process.platform !== 'win32') expect(mode(dirname(keyFile(pc)))).toBe(0o700)
      if (process.platform !== 'win32') expect(mode(pc)).toBe(0o755)
      expect(logs).toContain(`Made the vault key folder ${dirname(keyFile(pc))} private (0700): it was open to other users.`)
      // Already private: nothing to say.
      logs = []
      expect(await go()).toBe(0)
      expect(logs.some((l) => l.includes('private (0700)'))).toBe(false)
    })

    it('makes a loose VPS key folder private, but never the VPS home', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 1)]))
      mkdirSync(dirname(keyFile(vps)), { recursive: true })
      chmodSync(dirname(keyFile(vps)), 0o755)
      expect(await go()).toBe(0)
      expect(keyOf(vps).equals(K)).toBe(true)
      if (process.platform !== 'win32') expect(mode(dirname(keyFile(vps)))).toBe(0o700)
      expect(logs).toContain(`Made the VPS vault key folder ${dirname(keyFile(vps))} private (0700): it was open to other users.`)

      // A key path straight in the home folder: the key goes there, the home keeps its mode.
      logs = []
      rmSync(keyFile(vps))
      rmSync(data(vps, 'vault.json'))
      chmodSync(vps, 0o755)
      expect(await go(fakeRun(), undefined, { VPS_VAULT_KEY_FILE: '~/vault.key' })).toBe(0)
      expect(readFileSync(join(vps, 'vault.key'), 'utf8').trim()).toBe(K.toString('base64'))
      if (process.platform !== 'win32') expect(mode(vps)).toBe(0o755)
      expect(logs.some((l) => l.includes('private (0700)'))).toBe(false)
    })

    it('names the key path it checked when a side has items but no key', async () => {
      const K = randomBytes(32)
      putKey(pc, K)
      write(data(vps, 'vault.json'), vFile(K, [vLive(K, 'v', 1)]))
      expect(await go()).toBe(0)
      const line = logs.find((l) =>
        l.startsWith('The vault was left as it was on both machines. The VPS has vault items but no vault key')
      )!
      expect(line).toContain(` at ${keyFile(vps)}.`)
      expect(line).toContain('VPS_VAULT_KEY_FILE')
      rmSync(keyFile(pc))
      write(data(pc, 'vault.json'), vFile(K, [vLive(K, 'p', 1)]))
      putKey(vps, K)
      logs = []
      expect(await go()).toBe(0)
      const local = logs.find((l) =>
        l.startsWith('The vault was left as it was on both machines. This PC has vault items but no vault key')
      )!
      expect(local).toContain(` at ${keyFile(pc)}.`)
      expect(local).toContain('ZUMIBOT_VAULT_KEY_FILE')
    })
  })

  describe('versions', () => {
    const chat = (id: string, updatedAt: number) => ({ id, agentName: 'a', sessionId: null, cwd: '/w', title: id, createdAt: 1, updatedAt })
    const addChat = (home: string, c: ReturnType<typeof chat>) => {
      const f = data(home, 'chats.json')
      write(f, { chats: [...read(f).chats, c] })
    }
    const old = u('u1', 1)
    const reply = u('r1', 2)
    const pcEdit = {
      items: [{ ...u('u1b', 3), versions: { root: 'u1', index: 1, count: 2 } }],
      versions: { u1: { current: 1, list: [{ user: old, tail: [reply] }, null] } }
    }

    it.each(['local', 'vps'] as const)('copies only side questions anchored in a copy chat from %s', async (older) => {
      addChat(pc, chat('ed', older === 'local' ? 100 : 900))
      addChat(vps, chat('ed', older === 'vps' ? 100 : 900))
      const source = older === 'local' ? pc : vps
      const newer = older === 'local' ? vps : pc
      write(data(source, 'chats/ed.json'), pcEdit.items)
      write(data(source, 'chats/ed.versions.json'), pcEdit.versions)
      write(data(newer, 'chats/ed.json'), [old, reply, u('u2', 4)])
      const entries = [
        side('anchored', { after: 'u1b' }),
        side('before'),
        side('hidden', { after: 'r1' }),
        side('other', { after: 'absent' })
      ]
      write(data(source, 'chats/ed.btw.json'), { v: 1, items: entries })
      write(data(newer, 'chats/ed.btw.json'), { v: 1, items: [side('newer', { after: 'u2', askedAt: 2 })] })
      write(data(source, 'chats/ed.todos.json'), tFile([tItem('copied')]))
      write(data(source, 'chats/ed.agui.json'), { v: 1, threadId: 'th-ed', state: {}, interrupts: [] })

      expect(await go()).toBe(0)
      for (const home of [pc, vps]) {
        const copy = read(data(home, 'chats.json')).chats.find((c: { title: string }) => c.title.startsWith('ed (copy'))
        expect(read(data(home, `chats/${copy.id}.btw.json`))).toEqual({ v: 1, items: [entries[0], entries[1]] })
        expect(read(data(home, 'chats/ed.btw.json'))).toEqual({ v: 1, items: [...entries, side('newer', { after: 'u2', askedAt: 2 })] })
        // a copy chat gets the source side's whole list as it is
        expect(read(data(home, `chats/${copy.id}.todos.json`))).toEqual(tFile([tItem('copied')]))
        // but no remote thread: a copy starts a new one
        expect(existsSync(data(home, `chats/${copy.id}.agui.json`))).toBe(false)
      }
    })

    it('a switch on one side wins without a copy when the other side has nothing new', async () => {
      addChat(pc, chat('sw', 900))
      addChat(vps, chat('sw', 100))
      write(data(pc, 'chats/sw.json'), pcEdit.items)
      write(data(pc, 'chats/sw.versions.json'), pcEdit.versions)
      write(data(vps, 'chats/sw.json'), [old, reply])
      expect(await go()).toBe(0)
      for (const home of [pc, vps]) {
        expect(read(data(home, 'chats/sw.json'))).toEqual(pcEdit.items)
        expect(read(data(home, 'chats/sw.versions.json'))).toEqual(pcEdit.versions)
        expect(read(data(home, 'chats.json')).chats.map((c: { id: string }) => c.id)).toEqual(['shared', 'pc-only', 'sw', 'vps-only'])
      }
    })

    it('versions changed on both sides keep the newer side and copy the older one, with attachments', async () => {
      addChat(pc, chat('ed', 100))
      addChat(vps, chat('ed', 900))
      write(data(pc, 'chats/ed.json'), pcEdit.items)
      write(data(pc, 'chats/ed.versions.json'), pcEdit.versions)
      write(data(pc, 'attachments/ed/att1/f.png'), 'png')
      write(data(pc, `file-snapshots/ed/${HEX_A}`), 'snap')
      chmodSync(data(pc, `file-snapshots/ed/${HEX_A}`), 0o600)
      chmodSync(data(pc, 'file-snapshots/ed'), 0o700)
      write(data(vps, 'chats/ed.json'), [old, reply, u('u2', 4)])
      expect(await go()).toBe(0)
      for (const home of [pc, vps]) {
        const chats = read(data(home, 'chats.json')).chats as { id: string; title: string }[]
        const copy = chats.find((c) => c.title === 'ed (copy from this PC)')!
        expect(copy.id).not.toBe('ed')
        // The newer (VPS) side stays as it is; its empty versions overwrite the PC's file on both sides.
        expect(read(data(home, 'chats/ed.json')).map((x: Item) => x.id)).toEqual(['u1', 'r1', 'u2'])
        expect(read(data(home, 'chats/ed.versions.json'))).toEqual({})
        expect(read(data(home, `chats/${copy.id}.json`))).toEqual(pcEdit.items)
        expect(read(data(home, `chats/${copy.id}.versions.json`))).toEqual(pcEdit.versions)
        expect(readFileSync(data(home, `attachments/${copy.id}/att1/f.png`), 'utf8')).toBe('png')
        expect(readFileSync(data(home, 'attachments/ed/att1/f.png'), 'utf8')).toBe('png')
        expect(readFileSync(data(home, `file-snapshots/${copy.id}/${HEX_A}`), 'utf8')).toBe('snap')
        // cpSync makes the copy's folder with the umask mode; sync tightens it before the upload.
        if (process.platform !== 'win32') expect(statSync(data(home, `file-snapshots/${copy.id}`)).mode & 0o777).toBe(0o700)
        if (process.platform !== 'win32') expect(statSync(data(home, `file-snapshots/${copy.id}/${HEX_A}`)).mode & 0o777).toBe(0o600)
        expect(readFileSync(data(home, `file-snapshots/ed/${HEX_A}`), 'utf8')).toBe('snap')
      }
      expect(logs.some((l) => l.includes('copy from this PC'))).toBe(true)
      // A second run finds both sides equal and adds no more copies.
      expect(await go()).toBe(0)
      expect(read(data(pc, 'chats.json')).chats.filter((c: { title: string }) => c.title.startsWith('ed (copy')).length).toBe(1)
    })

    it('a run that fails after the merge does not make a second copy on the next run', async () => {
      addChat(pc, chat('ed', 900))
      addChat(vps, chat('ed', 100))
      write(data(pc, 'chats/ed.json'), pcEdit.items)
      write(data(pc, 'chats/ed.versions.json'), pcEdit.versions)
      write(data(vps, 'chats/ed.json'), [old, reply, u('u2', 4)])
      // The VPS index changes during the upload, so the swap stops after the local merge.
      const run = fakeRun((c) => {
        if (c.cmd === 'rsync' && c.args.at(-1)!.includes('/incoming/'))
          write(data(vps, 'chats.json'), JSON.stringify(read(data(vps, 'chats.json')), null, 1))
      })
      expect(await go(run)).toBe(1)
      const copies = () => (read(data(pc, 'chats.json')).chats as { title: string }[]).filter((c) => c.title.startsWith('ed (copy'))
      expect(copies()).toHaveLength(1)
      expect(await go()).toBe(0)
      for (const home of [pc, vps])
        expect((read(data(home, 'chats.json')).chats as { title: string }[]).filter((c) => c.title.startsWith('ed (copy'))).toHaveLength(1)
    })

    it('a versions file that exists only on the VPS reaches this PC', async () => {
      addChat(pc, chat('vo', 100))
      addChat(vps, chat('vo', 900))
      write(data(pc, 'chats/vo.json'), [old, reply])
      write(data(vps, 'chats/vo.json'), [old, reply])
      write(data(vps, 'chats/vo.versions.json'), pcEdit.versions)
      expect(await go()).toBe(0)
      expect(read(data(pc, 'chats/vo.versions.json'))).toEqual(pcEdit.versions)
      // A VPS-only chat brings its versions too.
      addChat(vps, chat('vv', 50))
      write(data(vps, 'chats/vv.json'), pcEdit.items)
      write(data(vps, 'chats/vv.versions.json'), pcEdit.versions)
      expect(await go()).toBe(0)
      expect(read(data(pc, 'chats/vv.versions.json'))).toEqual(pcEdit.versions)
    })
  })
})

describe('sync helpers', () => {
  // The sync sends the vault key to ssh this way, never in argv.
  it('realRun feeds input to stdin, and closes stdin without it', async () => {
    expect(await realRun('sh', ['-c', 'cat'], { input: 'secret\n' })).toEqual({ code: 0, stdout: 'secret\n', stderr: '' })
    expect(await realRun('sh', ['-c', 'cat; echo done'])).toEqual({ code: 0, stdout: 'done\n', stderr: '' })
    // A child that never reads its input still reports its own exit.
    expect((await realRun('sh', ['-c', 'exit 3'], { input: 'x'.repeat(1 << 20) })).code).toBe(3)
  })

  it('parses a dotenv file', () => {
    expect(parseEnvFile('VPS_HOST=a # note\nVPS_USER="b #c"\n')).toEqual({ VPS_HOST: 'a', VPS_USER: 'b #c' })
    expect(parseEnvFile('VPS_HOST="x" # c\nVPS_DIR= # c\nVPS_USER=u\n')).toEqual({ VPS_HOST: 'x', VPS_DIR: '', VPS_USER: 'u' })
    expect(parseEnvFile('# c\nVPS_HOST=a\nVPS_USER="b c"\n\nexport VPS_DIR=\'/x\'\n')).toEqual({
      VPS_HOST: 'a',
      VPS_USER: 'b c',
      VPS_DIR: '/x'
    })
  })
})
