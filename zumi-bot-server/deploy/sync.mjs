import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RSYNC_SSH, SAFE_DIR, SAFE_HOST, SSH_OPTS, parseEnvFile, realRun, safeKeyFile, shq, vaultKeyFileOf } from './config.mjs'
import { keyFromText, keyIdOf, mergeVault, opensWith, parseVaultFile, planVaultKeys, resealFile } from './vaultSync.mjs'

// Two-way sync of ZumiBot data and ~/.claude between this PC and the VPS. Nothing is ever deleted:
// chats are joined, other files go newest-wins, and every file replaced lands in a backup folder on its side.

const here = dirname(fileURLToPath(import.meta.url))
const DATA = '.local/share/zumibot'
// Claude's own synced skills and the e2e/scratch sessions are throwaway, not worth shipping either way.
const CLAUDE_DIRS = [
  ['agents', []],
  ['skills', ['--exclude=/synced/', '--exclude=/.trash/']],
  ['projects', ['--exclude=/-tmp-*']],
  ['file-history', []],
  ['agent-memory', []]
]
// The lock and socket belong to the running server; auth.json is the VPS sign-in, which Local mode never uses.
// The notify files are each side's own push keys and subscriptions (a subscription only works with the keys it was made under), so like auth.json they never cross.
// Per-machine runtime state (profiles, installs, kept screenshots, desktop homes, the CLI's temp folders) and the audit log (each
// machine's own record of its runs, see docs/architecture/governance.md): never carries to the other side or into a backup.
// processes/: each machine's background processes and their logs; pids and paths mean nothing on the other one.
const LOCAL_ONLY_EXCLUDES = ['browsers', 'browser-runtime', 'browser-shots', 'desktops', 'claude-tmp', 'audit', 'processes']
// A vault key is never in the data folder (both servers and the sync refuse it there); the exclude holds even if one were.
// Anchored at the top, where a key would land: attachments keep their own file names, which may start the same way.
const KEY_EXCLUDE = '/vault.key*'
// protocol-launch.json is the ACP launches confirmed in Agent Studio on that machine: per machine on purpose (the same command can
// be another binary on the other one), so each machine confirms its own.
// channel-state.json (the bot's update offset and which message is which chat) and channel-tokens.json (the bot token, sealed) belong
// to the machine that runs the bot: never pulled, never pushed.
const PULL_EXCLUDES = [
  ...LOCAL_ONLY_EXCLUDES.map((p) => `/${p}/`),
  'server.lock',
  'control.sock',
  'auth.json',
  'notify-devices.json',
  'notify-vapid.json',
  '/protocol-launch.json',
  '/channel-state.json',
  '/channel-tokens.json',
  '*.pre-rename',
  KEY_EXCLUDE
].map((p) => `--exclude=${p}`)
// routine-hooks.json and workflow-hooks.json (webhook secrets) are named nowhere on purpose: only the files copied below leave the pull folder, so each machine keeps its own.
// Whole-file settings: the side that changed them last wins.
const NEWEST_WINS = ['routine-runs.json', 'workflow-runs.json', 'usage.json', 'sidebar.json', 'settings.json', 'connectors.json']

const itemKey = (x) => x?.id ?? JSON.stringify(x)

/**
 * One chat's items from both sides. The shared start keeps the newer side's copy (the other may have
 * saved an item mid-reply); turns only one side has are all kept, in time order.
 */
export function mergeItems(local, vps, vpsNewer) {
  let n = 0
  while (n < local.length && n < vps.length && itemKey(local[n]) === itemKey(vps[n])) n++
  const lt = local.slice(n)
  // Drop turns this side already has (an earlier sync joined them), so a re-run never duplicates.
  const have = new Set(lt.map(itemKey))
  const vt = vps.slice(n).filter((x) => !have.has(itemKey(x)))
  const base = (vpsNewer ? vps : local).slice(0, n)
  if (vt.length === 0) return { items: [...base, ...lt], forked: null }
  if (lt.length === 0) return { items: [...base, ...vt], forked: null }
  const first = (t) => t.reduce((m, x) => Math.min(m, x.ts ?? 0), Infinity)
  const [a, b] = first(lt) <= first(vt) ? [lt, vt] : [vt, lt]
  return { items: [...base, ...a, ...b], forked: { local: lt.length, vps: vt.length } }
}

const emptyVersions = (v) => !v || Object.keys(v).length === 0
const sameJson = (a, b) => {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameJson(a[k], b[k]))
}
const sameVersions = (a, b) => (emptyVersions(a) && emptyVersions(b)) || sameJson(a, b)

/** Every item id of one side: the visible ones and the user and tail items of each stored version. */
function allIds(side) {
  const ids = new Set(side.items.map(itemKey))
  for (const set of Object.values(side.versions ?? {})) {
    for (const v of set?.list ?? []) {
      if (!v) continue
      ids.add(itemKey(v.user))
      for (const x of v.tail ?? []) ids.add(itemKey(x))
    }
  }
  return ids
}

/**
 * One chat from both sides; versions are the parsed <id>.versions.json or null. Equal versions join items as
 * ever. Different ones mean a message was edited or switched on a side, so the newer side stays as it is, and
 * the older side becomes a copy when it holds any item the newer one lacks (nothing is ever lost).
 */
export function mergeChatFiles(local, vps, vpsNewer) {
  if (sameVersions(local.versions, vps.versions))
    return { ...mergeItems(local.items, vps.items, vpsNewer), versions: local.versions, copy: null }
  const [base, older] = vpsNewer ? [vps, local] : [local, vps]
  const have = allIds(base)
  const lost = [...allIds(older)].some((id) => !have.has(id))
  return { items: base.items, versions: base.versions, forked: null, copy: lost ? (vpsNewer ? 'local' : 'vps') : null }
}

// Ported from backend/src/core/chat/sessionPoints.ts (startBefore, memberStartsBefore), the source of truth:
// where a Claude session starts when a chat is forked. Kept here because this script cannot import TS.
const SEED = { seed: true }
function lastEndBefore(items, index, agent) {
  for (let i = Math.min(index, items.length) - 1; i >= 0; i--) {
    const end = items[i].end
    if (end && (agent === undefined || end.agent === agent)) return i
  }
  return -1
}
const hasUser = (items, from, to) => items.slice(Math.max(from, 0), Math.max(to, 0)).some((it) => it.type === 'user')
function startBefore(items, index) {
  const k = lastEndBefore(items, index)
  if (k < 0) return hasUser(items, 0, index) ? { sessionId: null, next: SEED } : { sessionId: null, next: null }
  // A user message after the last end means that turn never recorded an end, so its session is unusable.
  if (hasUser(items, k + 1, index)) return { sessionId: null, next: SEED }
  const end = items[k].end
  return { sessionId: end.session, next: { at: end.at }, ...(end.engine ? { engine: end.engine } : {}) }
}
function memberStartsBefore(items, index, members) {
  const out = {}
  for (const m of members) {
    const k = lastEndBefore(items, index, m)
    if (k >= 0) {
      const end = items[k].end
      out[m] = { sessionId: end.session, next: { at: end.at }, seen: end.seen ?? null, ...(end.engine ? { engine: end.engine } : {}) }
    } else if (items.slice(0, index).some((it) => it.type === 'assistant' && it.agent === m))
      out[m] = { sessionId: null, next: SEED, seen: null }
    else out[m] = { sessionId: null, next: null, seen: null }
  }
  return out
}

/**
 * The index entry of a kept copy. It must never resume the session the other chat keeps appending to, so it
 * starts forked from its own last recorded end (an existing `next` already forks). Held and running work stays
 * with the original, or a task would run in both chats; so does a pause (Resume would be offered in both) and the
 * subagents a Stop killed (the original's next turn is told).
 */
function copyMeta(meta, items) {
  // A copy is not news: it starts read, so it never lights an unread dot on either side.
  const { tasks: _t, held: _h, replyAt: _r, seenAt: _s, mark: _m, pause: _p, pauseCap: _pc, lost: _l, ...rest } = meta
  const out = { ...rest, inFlight: false }
  if (meta.group) {
    const { paused: _gp, lost: _gl, sessionEngines, ...g } = meta.group
    const points = memberStartsBefore(items, items.length, g.members)
    const sessions = { ...g.sessions }
    const seen = { ...g.seen }
    const next = { ...(g.next ?? {}) }
    // Per member, as a single chat's mark: a member that keeps its own `next` keeps its own mark; one forked from a stamp takes
    // the stamp's engine, whatever it is, so a thread never reaches claude --resume (nor a Claude session another engine).
    const engines = { ...(sessionEngines ?? {}) }
    for (const m of g.members) {
      if (next[m]) continue
      sessions[m] = points[m].sessionId
      seen[m] = points[m].seen
      if (points[m].next) next[m] = points[m].next
      if (points[m].sessionId !== null && points[m].engine) engines[m] = points[m].engine
      else delete engines[m]
    }
    out.group = {
      ...g,
      sessions,
      seen,
      active: [],
      queue: [],
      ...(Object.keys(next).length > 0 ? { next } : {}),
      ...(Object.keys(engines).length > 0 ? { sessionEngines: engines } : {})
    }
  } else if (!meta.next) {
    const p = startBefore(items, items.length)
    out.sessionId = p.sessionId
    if (p.next) out.next = p.next
    // The stamp's thread is no Claude session (nor the other way round): its engine, whatever it is, replaces the source's mark.
    if (p.engine) out.sessionEngine = p.engine
    else delete out.sessionEngine
  }
  return out
}

/**
 * Read and archive state never bump `updatedAt`, so the newer side's meta alone would drop the other side's read,
 * reply or archive. Each time keeps the larger value (absent counts as none), so a read on either side stays read and
 * the later of an archive and an unarchive wins. The later mark wins the same way; a later seenAt from an open on the
 * other side still ends it.
 */
function laterTimes(a, b) {
  const out = {}
  for (const k of ['replyAt', 'seenAt', 'archivedAt', 'unarchivedAt']) {
    const t = Math.max(a[k] ?? -Infinity, b[k] ?? -Infinity)
    if (t > -Infinity) out[k] = t
  }
  const mark = (b.mark?.at ?? -Infinity) > (a.mark?.at ?? -Infinity) ? b.mark : a.mark
  if (mark) out.mark = mark
  return out
}

/** Same chat and same older side give the same id, so a run that failed after the merge never makes a second copy. */
function copyId(chatId, content) {
  const h = createHash('sha256').update(chatId).update('\0').update(content).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * The joined chat index, the item and versions files to rewrite, the VPS files to copy as they are, and the
 * older sides kept as copies. `items`/`versions` read one side's file for a chat id (null when missing).
 */
export function mergeChats(localChats, vpsChats, items, versions = () => null, newId = copyId) {
  const vpsById = new Map(vpsChats.map((c) => [c.id, c]))
  const chats = []
  const writes = []
  const versionWrites = []
  const copies = []
  const fromVps = []
  const forked = []
  const known = new Set([...localChats, ...vpsChats].map((c) => c.id))
  for (const c of localChats) {
    const v = vpsById.get(c.id)
    vpsById.delete(c.id)
    if (!v) {
      chats.push(c)
      continue
    }
    const vpsNewer = (v.updatedAt ?? 0) > (c.updatedAt ?? 0)
    const { replyAt: _r, seenAt: _s, mark: _m, archivedAt: _a, unarchivedAt: _u, ...winner } = vpsNewer ? v : c
    chats.push({ ...winner, ...laterTimes(c, v), updatedAt: Math.max(v.updatedAt ?? 0, c.updatedAt ?? 0) })
    const vi = items('vps', c.id)
    if (!vi) continue
    const li = items('local', c.id)
    if (!li) {
      fromVps.push(c.id)
      continue
    }
    const lv = versions('local', c.id)
    const vv = versions('vps', c.id)
    const m = mergeChatFiles({ items: li, versions: lv }, { items: vi, versions: vv }, vpsNewer)
    if (m.forked) forked.push({ id: c.id, title: c.title, ...m.forked })
    if (JSON.stringify(m.items) !== JSON.stringify(li)) writes.push([c.id, m.items])
    if (!sameVersions(lv, vv)) {
      // An empty winner still overwrites the other side's file (rsync never deletes), so it becomes `{}`.
      const want = emptyVersions(m.versions) ? {} : m.versions
      if (!sameJson(want, lv ?? {})) versionWrites.push([c.id, want])
      else if (lv === null) versionWrites.push([c.id, {}])
    }
    if (m.copy) {
      const older = m.copy === 'local' ? { meta: c, items: li, versions: lv } : { meta: v, items: vi, versions: vv }
      const id = newId(c.id, JSON.stringify([older.items, older.versions]))
      // Already in an index (an earlier run failed after the merge): nothing more to keep.
      if (!known.has(id)) {
        known.add(id)
        const meta = {
          ...copyMeta(older.meta, older.items),
          id,
          title: `${older.meta.title || 'chat'} (copy from ${m.copy === 'local' ? 'this PC' : 'the VPS'})`
        }
        chats.push(meta)
        copies.push({ from: m.copy, id: c.id, newId: id, meta })
      }
    }
  }
  for (const v of vpsById.values()) {
    chats.push(v)
    fromVps.push(v.id)
  }
  return { chats: chats.map(withoutWait), writes, versionWrites, copies, fromVps, forked }
}

/**
 * A usage limit wait (`resume`) sends `continue` from whichever server holds it, and both sides get the same index:
 * kept, both machines would continue the chat. Dropped, the chat shows the limit and waits for the user.
 */
function withoutWait(meta) {
  if (!('resume' in meta)) return meta
  const { resume: _w, ...rest } = meta
  return rest
}

/** A stale streaming snapshot must not replace a finished answer. */
export function mergeSide(local, vps) {
  const finished = (q) => q.state === 'done' || q.state === 'error' || q.state === 'stopped'
  const byId = new Map((local ?? []).map((q) => [q.id, q]))
  for (const q of vps ?? []) {
    const current = byId.get(q.id)
    if (!current || (finished(q) !== finished(current) ? finished(q) : (q.endedAt ?? -Infinity) > (current.endedAt ?? -Infinity)))
      byId.set(q.id, q)
  }
  return [...byId.values()].sort((a, b) => a.askedAt - b.askedAt)
}

// shared/src/todos.ts mergeComments: by id, the later change wins, a tombstone (deletedAt) always.
function mergeComments(a, b) {
  if (!a && !b) return undefined
  const stamp = (c) => (c.deletedAt !== undefined ? Infinity : (c.editedAt ?? c.at))
  const byId = new Map((a ?? []).map((c) => [c.id, c]))
  for (const c of b ?? []) {
    const cur = byId.get(c.id)
    if (!cur || stamp(c) > stamp(cur)) byId.set(c.id, c)
  }
  return [...byId.values()].sort((x, y) => x.at - y.at || x.id.localeCompare(y.id))
}

/**
 * A chat's to-do list from both machines (parsed <id>.todos.json or null), or the user's own (todos.json). Items join by id, the later
 * `updatedAt` wins (a tombstone is an item, so a removal on either side stays), a tie goes to this PC.
 * Plain .mjs with no imports, so the shape is copied from shared/src/todos.ts.
 */
export function mergeTodos(local, vps) {
  if (!local && !vps) return null
  const a = local ?? { v: 1, rev: 0, items: [], seen: {} }
  const b = vps ?? { v: 1, rev: 0, items: [], seen: {} }
  const byId = new Map(a.items.map((i) => [i.id, i]))
  const other = new Map(b.items.map((i) => [i.id, i]))
  for (const i of b.items) {
    const cur = byId.get(i.id)
    const win = !cur || i.updatedAt > cur.updatedAt ? i : cur
    // A card's comments join by id, so a comment made on each machine is kept whichever copy wins.
    const comments = cur ? mergeComments(cur.comments, i.comments) : i.comments
    byId.set(i.id, comments === undefined ? win : { ...win, comments })
  }
  // A side that has not seen an agent forces the smaller rev, so the agent is told about what it missed.
  const seen = {}
  for (const [agent, rev] of Object.entries(a.seen ?? {})) if (agent in (b.seen ?? {})) seen[agent] = Math.min(rev, b.seen[agent])
  const merged = [...byId.values()]
  // Identical sides need no bump, or every sync would raise rev again.
  const same = JSON.stringify(a.items) === JSON.stringify(b.items) && JSON.stringify(a.seen ?? {}) === JSON.stringify(seen)
  const rev = Math.max(a.rev, b.rev) + (same ? 0 : 1)
  // The machines' rev counters drift apart, so an item that changed on one side can carry a rev at or below the
  // merged `seen` and be skipped by changesSince. Items the sides disagree about (or only one has) take the merged rev.
  const mine = new Map(a.items.map((i) => [i.id, i]))
  const items = merged.map((i) => {
    const x = mine.get(i.id)
    const y = other.get(i.id)
    return x && y && JSON.stringify(x) === JSON.stringify(y) ? i : { ...i, rev }
  })
  return { v: 1, rev, items, seen }
}

// shared/src/inbox.ts INBOX_KEPT, TOMBSTONE_KEEP_MS and STRIP_AFTER_MS: both sides prune the same way (pruneMessages),
// so a dropped tombstone stays dropped.
const INBOX_KEPT = 500
const TOMBSTONE_KEEP_MS = 365 * 86_400_000
const STRIP_AFTER_MS = 60_000

/**
 * workflow-messages.json from both machines (parsed or null). Messages join by id, the later `updatedAt` wins (a
 * tombstone is a message, so a delete on either side stays), a tie goes to this PC; `seenAt` is the larger; then
 * pruned as pruneMessages does. An entry a hand edit left unreadable is dropped, so NaN never reaches the pruning.
 */
export function mergeWorkflowMessages(local, vps, now) {
  if (!local && !vps) return null
  const num = (x) => typeof x === 'number' && Number.isFinite(x)
  const usable = (f) =>
    (Array.isArray(f?.messages) ? f.messages : []).filter(
      (m) => typeof m?.id === 'string' && m.id !== '' && num(m.at) && num(m.updatedAt) && (m.deletedAt === undefined || num(m.deletedAt))
    )
  const byId = new Map(usable(local).map((m) => [m.id, m]))
  for (const m of usable(vps)) {
    const cur = byId.get(m.id)
    if (!cur || m.updatedAt > cur.updatedAt) byId.set(m.id, m)
  }
  const merged = [...byId.values()]
  const live = merged.filter((m) => m.deletedAt === undefined)
  // Stable: ties on `at` keep their joined order.
  const newest = new Set(
    live
      .map((m, i) => ({ m, i }))
      .sort((a, b) => b.m.at - a.m.at || a.i - b.i)
      .slice(0, INBOX_KEPT)
      .map((x) => x.m)
  )
  const messages = []
  for (const m of merged) {
    if (m.deletedAt === undefined) {
      if (newest.has(m)) messages.push(m)
      continue
    }
    const age = now - m.deletedAt
    if (age > TOMBSTONE_KEEP_MS) continue
    if (age > STRIP_AFTER_MS) {
      const { body: _body, ...rest } = m
      messages.push({ ...rest, title: '' })
    } else messages.push(m)
  }
  const seen = (f) => (num(f?.seenAt) ? f.seenAt : 0)
  return { v: 1, seenAt: Math.max(seen(local), seen(vps)), messages }
}

// shared/src/dispatch.ts DISPATCH_ENTRIES_MAX and DISPATCH_FILE_MAX: both sides prune the same entries the same way
// (pruneEntries), so a dropped one stays dropped.
const DISPATCH_ENTRIES_MAX = 200
const DISPATCH_FILE_MAX = 10_000_000

/**
 * A chat's dispatched agents from both machines (parsed <id>.dispatch.json or null). Entries join by id, the later
 * `updatedAt` wins, a tie goes to this PC; then the newest by start time that fit the server's caps are kept.
 */
export function mergeDispatch(local, vps) {
  if (!local && !vps) return null
  const byId = new Map((local?.entries ?? []).map((e) => [e.id, e]))
  for (const e of vps?.entries ?? []) {
    const cur = byId.get(e.id)
    if (!cur || e.updatedAt > cur.updatedAt) byId.set(e.id, e)
  }
  const entries = [...byId.values()]
  const keep = new Set()
  let size = 0
  for (const e of [...entries].sort((a, b) => b.startedAt - a.startedAt)) {
    if (keep.size >= DISPATCH_ENTRIES_MAX) break
    const n = JSON.stringify(e).length
    if (keep.size > 0 && size + n > DISPATCH_FILE_MAX) break
    keep.add(e.id)
    size += n
  }
  return { v: 1, entries: entries.filter((e) => keep.has(e.id)) }
}

/** Prompt history from both machines, each line once, oldest first. */
export function unionHistory(a, b) {
  const seen = new Set()
  const rows = []
  for (const line of `${a}\n${b}`.split('\n')) {
    if (!line.trim() || seen.has(line)) continue
    seen.add(line)
    let ts = 0
    try {
      ts = JSON.parse(line).timestamp ?? 0
    } catch {
      // kept, sorted first
    }
    rows.push([ts, line])
  }
  rows.sort((x, y) => x[0] - y[0])
  return rows.map((r) => `${r[1]}\n`).join('')
}

/** Routines fire on the VPS only, so the local copy is switched off the way the UI does it. */
export const disableRoutines = (routines) => routines.map((r) => ({ ...r, enabled: false, nextRunAt: null }))

/** Workflows fire on the VPS only, like routines. */
export const disableWorkflows = disableRoutines

/**
 * A bot can be polled by one machine only, so the copy of channels.json written on this PC runs no bot; the VPS keeps its own.
 * Every other field (the paired account, the agents switched on) comes as the VPS has it.
 */
export const disableChannels = (channels) => {
  const out = { ...(channels && typeof channels === 'object' && !Array.isArray(channels) ? channels : {}) }
  for (const [k, v] of Object.entries(out)) if (v && typeof v === 'object' && !Array.isArray(v) && 'run' in v) out[k] = { ...v, run: false }
  return out
}

const RUNS_ON_VPS = 'Continues on the VPS'
const openRun = (s) => s === 'running' || s === 'waiting'

/**
 * workflow-runs.json pulled from the VPS: its unfinished runs go on there, so this PC's copy holds them as stopped. The
 * local server's recover() would otherwise re-arm their waits and run their Agent, LLM and Notify steps a second time.
 */
export function stopUnfinishedWorkflowRuns(all, now) {
  if (!all || typeof all !== 'object' || Array.isArray(all)) return all
  const stop = (r) => {
    if (!r || !openRun(r.status)) return r
    // A For each visit's open item stops with it (as halt() does), else the PC shows an item Running in a stopped run; pending ones stay.
    const stopItems = (items) =>
      Array.isArray(items) ? items.map((i) => (i && openRun(i.status) ? { ...i, status: 'stopped', endedAt: i.endedAt ?? now } : i)) : items
    const visits = Array.isArray(r.visits)
      ? r.visits.map((v) =>
          v && openRun(v.status)
            ? { ...v, ...(v.items !== undefined ? { items: stopItems(v.items) } : {}), status: 'stopped', endedAt: v.endedAt ?? now }
            : v
        )
      : r.visits
    return { ...r, status: 'stopped', error: RUNS_ON_VPS, endedAt: r.endedAt ?? now, visits }
  }
  return Object.fromEntries(Object.entries(all).map(([id, runs]) => [id, Array.isArray(runs) ? runs.map(stop) : runs]))
}

/**
 * usage-records.jsonl from both sides: each id once, local lines first. On the same id the newer file's line wins
 * (an agent rename rewrites records). Torn or id-less lines are dropped.
 */
export function mergeUsageRecords(localText, vpsText, vpsNewer) {
  const byId = new Map()
  const add = (text, wins) => {
    for (const line of text.split('\n')) {
      let id
      try {
        id = JSON.parse(line)?.id
      } catch {
        continue
      }
      if (typeof id !== 'string') continue
      if (wins || !byId.has(id)) byId.set(id, line)
    }
  }
  add(localText, !vpsNewer)
  add(vpsText, vpsNewer)
  return [...byId.values()].map((l) => `${l}\n`).join('')
}

const md5 = (p) => (existsSync(p) ? createHash('md5').update(readFileSync(p)).digest('hex') : 'none')
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback)

function writeAtomic(p, text, mode) {
  const tmp = `${p}.sync-tmp`
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
  renameSync(tmp, p)
}

// cpSync makes directories with the umask's mode, but snapshot folders are 0700 (the rsync upload carries modes to the VPS).
function tightenDirs(dir) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return
  chmodSync(dir, 0o700)
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) tightenDirs(join(dir, e.name))
}

function copyKeepTime(from, to) {
  copyFileSync(from, to)
  const st = statSync(from)
  utimesSync(to, st.atime, st.mtime)
}

// Rewritten, then given the VPS file's time back: newest-wins keeps comparing against the VPS's own time.
function copyRunsKeepTime(from, to, now) {
  let runs
  try {
    runs = JSON.parse(readFileSync(from, 'utf8'))
  } catch {
    copyKeepTime(from, to) // not JSON: the local server moves it aside as corrupt, as it would on the VPS
    return
  }
  writeAtomic(to, JSON.stringify(stopUnfinishedWorkflowRuns(runs, now)))
  const st = statSync(from)
  utimesSync(to, st.atime, st.mtime)
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function lockPid(data) {
  try {
    const pid = Number.parseInt(readFileSync(join(data, 'server.lock'), 'utf8'), 10)
    return pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// The vault -------------------------------------------------------------------------------------------------------
// Key bytes stay in this process's memory and cross only over ssh stdin/stdout: never argv, a log line, an error, the
// work dir or a backup. Both keys live outside the data folders, which is all the backups copy.

const VPS_KEY_DEFAULT = '~/.config/zumibot-vault/vault.key'

// This PC's key folder is one only for the key (vaultKeyFileOf refuses any other), so whatever mode it had, it can be made private.
function tightenKeyDir(dir, log) {
  if ((statSync(dir).mode & 0o077) === 0) return
  chmodSync(dir, 0o700)
  log(`Made the vault key folder ${dir} private (0700): it was open to other users.`)
}

// writeSync may write less than it was given and not fail (a full disk, a file-size limit): loop until all of it is in,
// then check the size (each file here is new, opened with wx), so a vault or key cut short is never renamed in.
function writeAll(fd, data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  for (let at = 0; at < buf.length;) {
    const n = writeSync(fd, buf, at, buf.length - at)
    if (!(n > 0)) throw new Error('A write stopped short.')
    at += n
  }
  if (fstatSync(fd).size !== buf.length) throw new Error('A write stopped short.')
}

// Like the server's writeKey: exclusive (a key is never replaced in place), 0600 in a 0700 folder, on disk before returning.
function writeKeyFile(path, key, log) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  tightenKeyDir(dirname(path), log)
  const fd = openSync(path, 'wx', 0o600)
  let unclosed = true
  try {
    writeAll(fd, `${key.toString('base64')}\n`)
    fsyncSync(fd)
    // A close that fails has still released the descriptor: closing it again would throw EBADF and skip the removal below.
    unclosed = false
    closeSync(fd)
  } catch (err) {
    if (unclosed) {
      try {
        closeSync(fd)
      } catch {}
    }
    rmSync(path, { force: true })
    throw err
  }
}

// fsync of a file already written, or of a folder, whose entries (a new file, a rename) then reach the disk too.
function flush(path) {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// Some file systems refuse fsync on a folder; the files in it were flushed themselves.
function flushDir(dir) {
  try {
    flush(dir)
  } catch {}
}

// null when there is none; throws when it can't be read or is not a key.
function readKeyFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return keyFromText(text)
}

// The file's bytes as well, so a reseal can put back the vault it replaced.
function readVaultFile(p) {
  if (!existsSync(p)) return { file: null, text: null }
  const text = readFileSync(p)
  return { file: parseVaultFile(text.toString('utf8')), text }
}

// On disk before it is renamed in, and the folder after: a reseal puts the new key in only once this vault is there. A temp
// file left by a crash would keep its old mode, so it goes first; vault.json is 0600 like the server's.
function writeVaultFile(p, text) {
  const tmp = `${p}.sync-tmp`
  try {
    rmSync(tmp, { force: true })
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeAll(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, p)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    throw err
  }
  flushDir(dirname(p))
}

const vaultText = (file) => JSON.stringify(file, null, 2)

// The VPS key's absolute path, or null when VPS_VAULT_KEY_FILE is unsafe to quote or would put the key in the data folder.
// Both sides are resolved, so a home ending in a slash can't make a key in the data folder look outside it.
function remoteKeyFile(value, remoteHome) {
  if (!safeKeyFile(value)) return null
  const full = posix.resolve(value.startsWith('~/') ? `${remoteHome}/${value.slice(2)}` : value)
  const dataDir = posix.resolve(`${remoteHome}/${DATA}`)
  return full === dataDir || full.startsWith(`${dataDir}/`) ? null : full
}

// The VPS server, like this PC's, wants a key folder of its own (dedicatedKeyDir in backend/src/config.ts). Only such a
// folder is made private by the push: never the home folder, one above it or a shared one.
function ownKeyDir(file, remoteHome) {
  const dir = posix.dirname(file)
  const home = posix.resolve(remoteHome)
  return /vault|zumibot/i.test(posix.basename(dir)) && !['/', '/etc', '/tmp', '/var/tmp'].includes(dir) && !`${home}/`.startsWith(`${dir}/`)
}

// base64 of the file between markers, so a login banner or a missing key can't be read as one.
const readKeyScript = (file) =>
  ['set -e', `F=${shq(file)}`, 'if [ -e "$F" ]; then echo key:; base64 < "$F"; echo :end; else echo none:; fi'].join('\n')

// The key arrives on stdin. mktemp makes the temp file 0600; ln never replaces a key the VPS made meanwhile, since
// everything sealed with that one would be lost. A failed ln means that race only when a key is there afterwards (3);
// else the folder could not take the link (4).
// A link there, even a dangling one, counts as that race: only a link that could not be made at all is told apart.
// What arrived must be the whole key file (its byte count, and one line of a 32-byte key's base64) before it is linked: a
// dropped connection would otherwise leave a short key in place, and the VPS server would read the vault as sealed by another (5).
const KEY_LINE_BYTES = 45
const pushKeyScript = (file, ownDir) =>
  [
    'set -e',
    'umask 077',
    `F=${shq(file)}`,
    'D=$(dirname "$F")',
    'mkdir -p "$D"',
    // A loose folder is made private and says so (dir:private), so the sync can log it.
    // -H: a folder that is a symlink is judged by where it points, as chmod acts there; the link's own mode is always open.
    ...(ownDir ? ['if [ -n "$(find -H "$D" -maxdepth 0 -perm /077)" ]; then chmod go-rwx "$D"; echo dir:private; fi'] : []),
    '[ ! -e "$F" ] || exit 3',
    'T=$(mktemp "$F.sync-XXXXXX")',
    `trap 'rm -f "$T"' EXIT`,
    'cat > "$T"',
    `[ "$(wc -c < "$T" | tr -d ' ')" = ${KEY_LINE_BYTES} ] && grep -qx '[A-Za-z0-9+/]\\{43\\}=' "$T" || exit 5`,
    'sync "$T" 2>/dev/null || true',
    'if ! ln "$T" "$F" 2>/dev/null; then if [ -e "$F" ] || [ -L "$F" ]; then exit 3; fi; exit 4; fi'
  ].join('\n')

/** The VPS key from readKeyScript's output: a Buffer, null for none, undefined when the answer can't be read. */
function vpsKeyOf(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim())
  const at = lines.findLastIndex((l) => l === 'key:' || l === 'none:')
  if (at < 0) return undefined
  if (lines[at] === 'none:') return null
  const end = lines.indexOf(':end', at)
  if (end < 0) return undefined
  return keyFromText(Buffer.from(lines.slice(at + 1, end).join(''), 'base64').toString('utf8'))
}

// A copy of the key file beside it, 0600 and on disk, never over another file.
function copyKeyAside(keyFile, to) {
  try {
    copyFileSync(keyFile, to, constants.COPYFILE_EXCL)
    chmodSync(to, 0o600)
    flush(to)
  } catch (err) {
    if (err.code !== 'EEXIST') rmSync(to, { force: true })
    throw err
  }
}

// The old key goes aside as vault.key.replaced-<time>, unless such a copy already holds it.
function keepKeyAside(keyFile, key, now) {
  const dir = dirname(keyFile)
  const prefix = `${basename(keyFile)}.replaced-`
  const held = (f) => {
    try {
      return readKeyFile(join(dir, f))?.equals(key) === true
    } catch {
      return false
    }
  }
  if (!readdirSync(dir).some((f) => f.startsWith(prefix) && held(f))) copyKeyAside(keyFile, `${keyFile}.replaced-${stamp(new Date(now()))}`)
}

/**
 * A reseal that stopped between writing the joined vault and renaming the new key in leaves that key in vault.key.sync-tmp
 * and a vault.json sealed with it. That rename is finished, once every item opens with the key and the old key is kept
 * aside. Returns whether it did; throws when it could not.
 */
function finishKeyRename(keyFile, localFile, now, log) {
  const next = `${keyFile}.sync-tmp`
  if (!localFile) return false
  let st
  try {
    st = lstatSync(next)
  } catch {
    return false
  }
  // Only a plain file goes in: a link would put whatever it points at in the key's place.
  if (!st.isFile()) {
    log(`${next} is not a plain file, so it was not put in place as this PC's vault key.`)
    return false
  }
  let key
  let current
  try {
    key = readKeyFile(next)
    current = readKeyFile(keyFile)
  } catch {
    return false
  }
  if (!key || !opensWith(key, localFile)) return false
  if (current?.equals(key)) {
    rmSync(next, { force: true })
    return false
  }
  if (current) keepKeyAside(keyFile, current, now)
  tightenKeyDir(dirname(keyFile), log)
  chmodSync(next, 0o600)
  renameSync(next, keyFile)
  flushDir(dirname(keyFile))
  return true
}

/**
 * Joins vault.json by item id and leaves both sides on one key: a key only one side has is copied; different keys
 * mean this PC's items are sealed again with the VPS key. A side whose vault doesn't match its own key leaves both
 * vaults alone, and the rest of the sync goes on. Returns whether this PC's vault.json should go up to the VPS.
 */
async function syncVault({ env, home, data, pulled, remoteHome, ssh, log, now }) {
  const leave = (why) => {
    log(`The vault was left as it was on both machines. ${why}`)
    return false
  }
  let keyFile
  try {
    keyFile = vaultKeyFileOf(env, home, data)
  } catch (err) {
    return leave(`${err.message}.`)
  }
  const vpsKeyFile = remoteKeyFile(env.VPS_VAULT_KEY_FILE || VPS_KEY_DEFAULT, remoteHome)
  if (!vpsKeyFile)
    return leave('VPS_VAULT_KEY_FILE must be a file under ~/ or an absolute path, in plain characters, outside the VPS data folder.')
  const vaultPath = join(data, 'vault.json')
  let local
  let vpsFile
  let localKey
  let vpsKey
  try {
    local = readVaultFile(vaultPath)
  } catch {
    return leave("This PC's vault.json can't be read.")
  }
  const localFile = local.file
  try {
    vpsFile = readVaultFile(join(pulled, 'vault.json')).file
  } catch {
    return leave("The VPS's vault.json can't be read.")
  }
  try {
    if (finishKeyRename(keyFile, localFile, now, log))
      log('An earlier sync stopped while putting the VPS vault key in place on this PC; it is in place now.')
  } catch {
    return leave('An earlier sync stopped while putting the VPS vault key in place on this PC, and that could not be finished.')
  }
  try {
    localKey = readKeyFile(keyFile)
  } catch {
    return leave('The vault key file on this PC is not a valid key.')
  }
  const got = await ssh(readKeyScript(vpsKeyFile))
  try {
    vpsKey = got.code === 0 ? vpsKeyOf(got.stdout) : undefined
  } catch {
    return leave('The vault key file on the VPS is not a valid key.')
  }
  if (vpsKey === undefined) return leave('Could not read the vault key on the VPS.')

  const plan = planVaultKeys({ localKey, vpsKey, localFile, vpsFile, localKeyFile: keyFile, vpsKeyFile })
  if (plan.action === 'refuse') return leave(plan.reason)
  if (plan.action === 'pullKey') {
    try {
      writeKeyFile(keyFile, vpsKey, log)
    } catch {
      return leave('Could not write the vault key on this PC.')
    }
    log('Vault key copied from the VPS to this PC.')
  }
  if (plan.action === 'pushKey') {
    const put = await ssh(pushKeyScript(vpsKeyFile, ownKeyDir(vpsKeyFile, remoteHome)), `${localKey.toString('base64')}\n`)
    if (put.stdout.split('\n').includes('dir:private'))
      log(`Made the VPS vault key folder ${posix.dirname(vpsKeyFile)} private (0700): it was open to other users.`)
    if (put.code === 3) return leave('A vault key appeared on the VPS during the sync. Sync again.')
    if (put.code === 4)
      return leave('Could not link the vault key into place on the VPS (its folder may not allow hard links), so it was not copied there.')
    if (put.code === 5) return leave('The vault key did not reach the VPS whole, so it was not put in place there. Sync again.')
    if (put.code !== 0) return leave('Copying the vault key to the VPS failed.')
    log('Vault key copied from this PC to the VPS.')
  }
  if (plan.action !== 'reseal') {
    const merged = mergeVault(localFile, vpsFile)
    if (!merged) return false
    // Every live item is sealed with the one key both sides now have; a tombstone-only side's id is stale.
    if (localKey ?? vpsKey) merged.keyId = keyIdOf(localKey ?? vpsKey)
    try {
      writeVaultFile(vaultPath, vaultText(merged))
    } catch {
      return leave('Could not write the merged vault on this PC.')
    }
    return true
  }

  // Different keys: the VPS key wins. Nothing changes unless every item of this PC opens with this PC's key.
  let resealed
  try {
    resealed = localFile && resealFile(localFile, localKey, vpsKey)
  } catch {
    return leave("An item in this PC's vault does not open with its key.")
  }
  const merged = mergeVault(resealed, vpsFile)
  if (merged) merged.keyId = keyIdOf(vpsKey)
  // The old key is kept beside the new one (the backup's vault.json is still sealed with it), and the new key is
  // renamed over it, so the key path is never empty.
  const keyDir = dirname(keyFile)
  const replaced = `${keyFile}.replaced-${stamp(new Date(now()))}`
  const next = `${keyFile}.sync-tmp`
  try {
    tightenKeyDir(keyDir, log)
    copyKeyAside(keyFile, replaced)
  } catch {
    return leave("Could not keep this PC's old vault key aside.")
  }
  const undo = () => {
    rmSync(next, { force: true })
    rmSync(replaced, { force: true })
  }
  try {
    rmSync(next, { force: true })
    writeKeyFile(next, vpsKey, log)
    if (merged) writeVaultFile(vaultPath, vaultText(merged))
    // Both key files and the joined vault are on disk before the key goes in: a crash before the rename leaves the old
    // key with a vault finishKeyRename completes, never a key with nothing sealed under it.
    flushDir(keyDir)
  } catch {
    undo()
    return leave("Could not write this PC's vault under the VPS key.")
  }
  try {
    renameSync(next, keyFile)
    flushDir(keyDir)
  } catch {
    // The vault this PC had goes back, so it matches the key still in place; if even that fails, the next sync
    // finishes the rename instead (the new key stays in its temp file).
    try {
      if (merged) {
        if (local.text) writeVaultFile(vaultPath, local.text)
        else rmSync(vaultPath, { force: true })
      }
    } catch {
      return leave("Could not put the VPS vault key in place on this PC, nor this PC's vault back. Sync again to finish.")
    }
    undo()
    return leave('Could not put the VPS vault key in place on this PC.')
  }
  log(`This PC's vault used another key: its items are now sealed with the VPS key. The old key is kept as ${replaced}.`)
  return merged !== null
}

const pluginNames = (text) => {
  try {
    return Object.keys(JSON.parse(text).plugins ?? {})
  } catch {
    return []
  }
}

export async function sync({
  env = {},
  run = realRun,
  log = console.log,
  alive = isAlive,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now
}) {
  const host = env.VPS_HOST
  const user = env.VPS_USER
  if (!host || !user) {
    log('VPS_HOST and VPS_USER are required. Copy deploy.env.example to deploy.env next to sync.mjs and fill them in.')
    return 1
  }
  const dir = env.VPS_DIR || `/home/${user}/zumibot`
  if (!SAFE_HOST.test(host) || !SAFE_HOST.test(user) || !SAFE_DIR.test(dir)) {
    log('VPS_HOST, VPS_USER or VPS_DIR in deploy.env contains characters that are not allowed.')
    return 1
  }
  const target = `${user}@${host}`
  const ssh = (cmd, input) => run('ssh', [...SSH_OPTS, target, cmd], input === undefined ? undefined : { input })
  // -z: session logs are gigabytes of JSON that shrink about 5x (zstd when both rsyncs are 3.2+), and a
  // home uplink is the bottleneck. rsync skips already-compressed files (images, archives) on its own.
  const rsync = (...args) => run('rsync', ['-az', ...RSYNC_SSH, ...args])
  const busyCmd = `${shq(`${dir}/bin/zumibot-server`)} busy`
  const home = env.HOME || ''
  const data = join(home, DATA)
  const claude = join(home, '.claude')

  // A reply running on either side would write chats while they are being joined.
  const busy = await ssh(busyCmd)
  const count = busy.code === 0 ? /^\d+$/m.exec(busy.stdout)?.[0] : undefined
  if (count !== '0') {
    log(
      count
        ? `${count} replies running on the VPS. Sync again once they finish.`
        : `Could not read the running-reply count from the VPS. ${busy.stderr.trim()}`
    )
    return 1
  }
  // The VPS server restarts at the end: its background processes stop. Only a warning; an older server has no such line.
  const procs = await ssh(`${shq(`${dir}/bin/zumibot-server`)} processes`)
  const procCount = procs.code === 0 ? Number.parseInt(/^\d+$/m.exec(procs.stdout)?.[0] ?? '0', 10) : 0
  if (procCount > 0) log(`${procCount} background process${procCount === 1 ? '' : 'es'} on the VPS will be stopped by the restart.`)
  const pid = lockPid(data)
  if (pid !== null && alive(pid)) {
    log('ZumiBot is running on this PC. Close it, then sync again.')
    return 1
  }
  const remoteHome = (await ssh('printf %s "$HOME"')).stdout.trim()
  if (!SAFE_DIR.test(remoteHome)) {
    log('Could not read the home folder on the VPS.')
    return 1
  }

  const name = `zumibot-sync-backup-${stamp(new Date(now()))}`
  const bk = join(home, name)
  const rbk = `${remoteHome}/${name}`
  log(`Backing up to ${bk} (this PC) and ${rbk} (VPS)...`)
  // Private: the copies keep their own 0664 modes, so the folder is what keeps chats and settings from other users.
  // chmod too, since mkdir's mode is masked by the umask.
  mkdirSync(bk, { recursive: true, mode: 0o700 })
  chmodSync(bk, 0o700)
  if (existsSync(data))
    cpSync(data, join(bk, 'zumibot-data'), {
      recursive: true,
      preserveTimestamps: true,
      filter: (src) => !LOCAL_ONLY_EXCLUDES.includes(relative(data, src).split('/')[0]) && !lstatSync(src).isSocket()
    })
  for (const f of ['agents', 'history.jsonl', 'CLAUDE.md']) {
    if (existsSync(join(claude, f))) cpSync(join(claude, f), join(bk, f), { recursive: true, preserveTimestamps: true })
  }
  const rb = await ssh(
    [
      'set -e',
      'umask 077',
      `B=${shq(rbk)}`,
      // The same on the VPS: the backup and its incoming folder are the user's alone.
      'mkdir -p -m 700 "$B"',
      'chmod 700 "$B"',
      'mkdir -p ~/.claude/agents ~/.claude/skills ~/.claude/projects ~/.claude/file-history ~/.claude/agent-memory',
      `[ ! -d ~/${DATA} ] || rsync -a --exclude=control.sock ${shq(`--exclude=${KEY_EXCLUDE}`)} ${LOCAL_ONLY_EXCLUDES.map((p) => `--exclude=/${p}/`).join(' ')} ~/${DATA}/ "$B/zumibot-data/"`,
      'for f in agents history.jsonl CLAUDE.md; do [ ! -e ~/.claude/$f ] || cp -a ~/.claude/$f "$B/"; done'
    ].join('\n')
  )
  if (rb.code !== 0) {
    log(`Backup on the VPS failed: ${rb.stderr.trim()}`)
    return 1
  }

  const work = mkdtempSync(join(tmpdir(), 'zumibot-sync-'))
  try {
    log('Joining chats...')
    const vps = join(work, 'vps')
    const pull = await rsync(...PULL_EXCLUDES, `${target}:${DATA}/`, `${vps}/`)
    if (pull.code !== 0) {
      log(`Copying ZumiBot data from the VPS failed: ${pull.stderr.trim()}`)
      return 1
    }
    // The swap below only goes ahead if the VPS index is still this one.
    const pulled = md5(join(vps, 'chats.json'))
    // Likewise vault.json: a vault item saved on the VPS after the pull must not be overwritten.
    const pulledVault = md5(join(vps, 'vault.json'))
    mkdirSync(join(data, 'chats'), { recursive: true })
    const vaultUp = await syncVault({ env, home, data, pulled: vps, remoteHome, ssh, log, now })
    const roots = { local: data, vps }
    const localChats = readJson(join(data, 'chats.json'), { chats: [] }).chats
    const vpsChats = readJson(join(vps, 'chats.json'), { chats: [] }).chats
    const localIds = new Set(localChats.map((c) => c.id))
    const sideWrites = []
    const todoWrites = []
    const dispatchWrites = []
    for (const c of vpsChats) {
      if (!localIds.has(c.id)) continue
      const localSide = readJson(join(data, 'chats', `${c.id}.btw.json`), null)
      const vpsSide = readJson(join(vps, 'chats', `${c.id}.btw.json`), null)
      if (localSide !== null || vpsSide !== null) sideWrites.push([c.id, mergeSide(localSide?.items ?? null, vpsSide?.items ?? null)])
      const localTodos = readJson(join(data, 'chats', `${c.id}.todos.json`), null)
      const vpsTodos = readJson(join(vps, 'chats', `${c.id}.todos.json`), null)
      if (localTodos !== null || vpsTodos !== null) todoWrites.push([c.id, mergeTodos(localTodos, vpsTodos)])
      const localDispatch = readJson(join(data, 'chats', `${c.id}.dispatch.json`), null)
      const vpsDispatch = readJson(join(vps, 'chats', `${c.id}.dispatch.json`), null)
      if (localDispatch !== null || vpsDispatch !== null) dispatchWrites.push([c.id, mergeDispatch(localDispatch, vpsDispatch)])
    }
    const m = mergeChats(
      localChats,
      vpsChats,
      (side, id) => readJson(join(roots[side], 'chats', `${id}.json`), null),
      (side, id) => readJson(join(roots[side], 'chats', `${id}.versions.json`), null)
    )
    // Copies first: they read this PC's files as they were, before the joined versions replace them.
    for (const c of m.copies) {
      const from = roots[c.from]
      for (const ext of ['json', 'versions.json', 'btw.json', 'todos.json', 'dispatch.json']) {
        const source = join(from, 'chats', `${c.id}.${ext}`)
        const dest = join(data, 'chats', `${c.newId}.${ext}`)
        if (!existsSync(source)) continue
        if (ext === 'btw.json') {
          const keep = new Set(readJson(join(from, 'chats', `${c.id}.json`), []).map((it) => it.id))
          const entries = readJson(source, { items: [] }).items.filter((q) => q.after === null || keep.has(q.after))
          writeAtomic(dest, JSON.stringify({ v: 1, items: entries }))
        } else copyKeepTime(source, dest)
      }
      if (existsSync(join(from, 'attachments', c.id)))
        cpSync(join(from, 'attachments', c.id), join(data, 'attachments', c.newId), { recursive: true, preserveTimestamps: true })
      if (existsSync(join(from, 'file-snapshots', c.id)))
        cpSync(join(from, 'file-snapshots', c.id), join(data, 'file-snapshots', c.newId), { recursive: true, preserveTimestamps: true })
      log(
        `  "${c.meta.title}" kept: message versions differed on both machines, so the ${c.from === 'local' ? 'PC' : 'VPS'} side is a separate chat.`
      )
    }
    for (const [id, list] of m.writes) writeAtomic(join(data, 'chats', `${id}.json`), JSON.stringify(list))
    // The whole local chats/ folder goes up later, so a versions file written here reaches the VPS too.
    for (const [id, v] of m.versionWrites) writeAtomic(join(data, 'chats', `${id}.versions.json`), JSON.stringify(v))
    // A remote agent's thread file goes with the items it belongs to. A copy chat (above) never gets one: it starts a new thread.
    for (const id of m.fromVps) {
      for (const f of [
        `${id}.json`,
        `${id}.agui.json`,
        `${id}.versions.json`,
        `${id}.btw.json`,
        `${id}.todos.json`,
        `${id}.dispatch.json`
      ]) {
        if (existsSync(join(vps, 'chats', f))) copyKeepTime(join(vps, 'chats', f), join(data, 'chats', f))
      }
    }
    // Apply joins after fromVps copies, which may replace a shared chat's local side file.
    for (const [id, entries] of sideWrites) writeAtomic(join(data, 'chats', `${id}.btw.json`), JSON.stringify({ v: 1, items: entries }))
    // 0600 like the server's own todos files: item text comes from agent replies.
    for (const [id, f] of todoWrites) writeAtomic(join(data, 'chats', `${id}.todos.json`), JSON.stringify(f), 0o600)
    // 0600 like the server's: a subagent's tool results hold whatever it read.
    for (const [id, f] of dispatchWrites) writeAtomic(join(data, 'chats', `${id}.dispatch.json`), JSON.stringify(f), 0o600)
    writeAtomic(join(data, 'chats.json'), JSON.stringify({ chats: m.chats }, null, 2))
    for (const f of m.forked)
      log(`  "${f.title || f.id}" had new messages on both machines: kept ${f.local} items from this PC and ${f.vps} from the VPS.`)
    if (existsSync(join(vps, 'routines.json')))
      writeAtomic(join(data, 'routines.json'), JSON.stringify(disableRoutines(readJson(join(vps, 'routines.json'), [])), null, 2))
    if (existsSync(join(vps, 'workflows.json')))
      writeAtomic(join(data, 'workflows.json'), JSON.stringify(disableWorkflows(readJson(join(vps, 'workflows.json'), [])), null, 2))
    // 0600 like the server's own file.
    if (existsSync(join(vps, 'channels.json')))
      writeAtomic(join(data, 'channels.json'), JSON.stringify(disableChannels(readJson(join(vps, 'channels.json'), {})), null, 2), 0o600)
    // The definitions come from the VPS, so their saved versions do too; the backup folder keeps this PC's old files.
    if (existsSync(join(vps, 'history')))
      cpSync(join(vps, 'history'), join(data, 'history'), { recursive: true, force: true, preserveTimestamps: true })
    for (const f of NEWEST_WINS) {
      const from = join(vps, f)
      const to = join(data, f)
      if (!existsSync(from) || (existsSync(to) && statSync(from).mtimeMs <= statSync(to).mtimeMs)) continue
      if (f === 'workflow-runs.json') copyRunsKeepTime(from, to, now())
      else copyKeepTime(from, to)
    }
    // Not NEWEST_WINS: both machines append records, so the files are joined. usage-estimates.json is derived and stays out.
    if (existsSync(join(vps, 'usage-records.jsonl'))) {
      const to = join(data, 'usage-records.jsonl')
      const vpsNewer = !existsSync(to) || statSync(join(vps, 'usage-records.jsonl')).mtimeMs > statSync(to).mtimeMs
      writeAtomic(
        to,
        mergeUsageRecords(existsSync(to) ? readFileSync(to, 'utf8') : '', readFileSync(join(vps, 'usage-records.jsonl'), 'utf8'), vpsNewer)
      )
    }
    // Joined like the records: a Notify message may exist on either machine. 0600 as the server writes it (step text).
    if (existsSync(join(vps, 'workflow-messages.json'))) {
      const merged = mergeWorkflowMessages(
        readJson(join(data, 'workflow-messages.json'), null),
        readJson(join(vps, 'workflow-messages.json'), null),
        now()
      )
      if (merged) writeAtomic(join(data, 'workflow-messages.json'), JSON.stringify(merged), 0o600)
    }
    // The user's own to-do list, which no chat holds: joined by item id as a chat's list is, 0600, and pushed like the above.
    if (existsSync(join(vps, 'todos.json'))) {
      const merged = mergeTodos(readJson(join(data, 'todos.json'), null), readJson(join(vps, 'todos.json'), null))
      if (merged) writeAtomic(join(data, 'todos.json'), JSON.stringify(merged), 0o600)
    }
    if (existsSync(join(vps, 'attachments')))
      cpSync(join(vps, 'attachments'), join(data, 'attachments'), { recursive: true, force: false, preserveTimestamps: true })
    // Snapshots are content-addressed and never change once written, so a union without overwriting is enough.
    if (existsSync(join(vps, 'file-snapshots')))
      cpSync(join(vps, 'file-snapshots'), join(data, 'file-snapshots'), { recursive: true, force: false, preserveTimestamps: true })
    tightenDirs(join(data, 'file-snapshots'))

    for (const [d, extra] of CLAUDE_DIRS) {
      log(`Syncing ~/.claude/${d}...`)
      mkdirSync(join(claude, d), { recursive: true })
      const down = await rsync(
        '--update',
        ...extra,
        '--backup',
        `--backup-dir=${join(bk, `${d}-overwritten`)}`,
        `${target}:.claude/${d}/`,
        `${join(claude, d)}/`
      )
      const up =
        down.code === 0
          ? await rsync(
              '--update',
              ...extra,
              '--backup',
              `--backup-dir=${rbk}/${d}-overwritten`,
              `${join(claude, d)}/`,
              `${target}:.claude/${d}/`
            )
          : down
      if (up.code !== 0) {
        log(`Syncing ~/.claude/${d} failed: ${up.stderr.trim()}`)
        return 1
      }
    }
    const remoteHas = (await ssh('[ -f ~/.claude/CLAUDE.md ] && echo yes || true')).stdout.trim() === 'yes'
    if (remoteHas) await rsync('--update', '--backup', `--backup-dir=${bk}`, `${target}:.claude/CLAUDE.md`, join(claude, 'CLAUDE.md'))
    if (existsSync(join(claude, 'CLAUDE.md')))
      await rsync('--update', '--backup', `--backup-dir=${rbk}`, join(claude, 'CLAUDE.md'), `${target}:.claude/CLAUDE.md`)

    const remoteHistory = await ssh('cat ~/.claude/history.jsonl 2>/dev/null || true')
    const localHistory = existsSync(join(claude, 'history.jsonl')) ? readFileSync(join(claude, 'history.jsonl'), 'utf8') : ''
    writeAtomic(join(claude, 'history.jsonl'), unionHistory(localHistory, remoteHistory.stdout))
    await rsync(join(claude, 'history.jsonl'), `${target}:.claude/history.jsonl`)

    log('Updating chats on the VPS...')
    const inc = `${rbk}/incoming`
    await ssh(`umask 077; mkdir -p -m 700 ${shq(inc)}`)
    const sources = [
      'chats.json',
      'sidebar.json',
      'settings.json',
      'connectors.json',
      'usage-records.jsonl',
      'workflow-messages.json',
      'todos.json',
      'chats',
      'attachments',
      'file-snapshots'
    ]
      .filter((f) => existsSync(join(data, f)))
      .map((f) => join(data, f))
    // Only a joined vault goes up: one left alone stays as it is on both sides. It is sealed; the key never goes.
    if (vaultUp) sources.push(join(data, 'vault.json'))
    const upload = await rsync(...sources, `${target}:${inc}/`)
    if (upload.code !== 0) {
      log(`Uploading chats to the VPS failed: ${upload.stderr.trim()}`)
      return 1
    }
    // The VPS server keeps the chat index in memory and would write its old copy back, so the files are
    // swapped and the server restarted in one go, and only if nothing changed there since the pull.
    const swap = await ssh(
      [
        'set -e',
        `D=~/${DATA}; I=${shq(inc)}`,
        `[ "$(${busyCmd})" = 0 ] || exit 3`,
        'cur=$([ -f "$D/chats.json" ] && md5sum < "$D/chats.json" | cut -d" " -f1 || echo none)',
        `[ "$cur" = ${pulled} ] || exit 4`,
        'mkdir -p "$D/chats"',
        'rsync -a "$I/chats/" "$D/chats/"',
        '[ ! -d "$I/attachments" ] || rsync -a "$I/attachments/" "$D/attachments/"',
        '[ ! -d "$I/file-snapshots" ] || rsync -a "$I/file-snapshots/" "$D/file-snapshots/"',
        'for f in sidebar.json settings.json connectors.json usage-records.jsonl workflow-messages.json todos.json; do [ ! -f "$I/$f" ] || cp -p "$I/$f" "$D/"; done',
        // Not in the list above: the vault goes in only over the copy that was joined, else it stays and the next sync joins it.
        // Through a temp file in the same folder and an mv, so a full disk can never leave the live vault cut short.
        `if [ -f "$I/vault.json" ]; then v=$([ -f "$D/vault.json" ] && md5sum < "$D/vault.json" | cut -d" " -f1 || echo none); if [ "$v" = ${pulledVault} ]; then T="$D/vault.json.sync-in"; if cp "$I/vault.json" "$T" && chmod 600 "$T" && { sync "$T" 2>/dev/null || true; } && mv -f "$T" "$D/vault.json"; then :; else rm -f "$T"; echo vault-failed; fi; else echo vault-changed; fi; fi`,
        'cp -p "$I/chats.json" "$D/chats.json"',
        // The server runs as the user's systemd unit (install.sh), so no sudo and no root rule.
        'systemctl --user restart zumibot || exit 5'
      ].join('\n')
    )
    if (swap.code === 3 || swap.code === 4) {
      log(
        `${swap.code === 3 ? 'A reply started' : 'Chats changed'} on the VPS during the sync, so its chats were left as they were. This PC is up to date; sync again to update the VPS.`
      )
      return 1
    }
    if (swap.code === 5) {
      log('The chats are in place on the VPS, but restarting it failed. On the VPS run: systemctl --user status zumibot')
      return 1
    }
    if (swap.code !== 0) {
      log(`Updating chats on the VPS failed: ${swap.stderr.trim()}`)
      return 1
    }
    if (swap.stdout.split('\n').includes('vault-changed'))
      log('The vault changed on the VPS during the sync, so it was left as it was there. Sync again to update it.')
    if (swap.stdout.split('\n').includes('vault-failed'))
      log('The vault could not be written on the VPS (its disk may be full), so it was left as it was there. Sync again to update it.')
    const deadline = now() + 20000
    let up = false
    while (!up) {
      up = (await ssh(busyCmd)).code === 0
      if (up || now() >= deadline) break
      await sleep(1000)
    }
    if (!up) {
      log('The VPS server did not answer within 20 s after the restart. On the VPS run: journalctl --user -u zumibot -n 50')
      return 1
    }
    const after = (await ssh(`md5sum < ~/${DATA}/chats.json | cut -d" " -f1`)).stdout.trim()
    if (after !== md5(join(data, 'chats.json'))) log('Warning: the chat list on the VPS does not match this PC after the sync. Sync again.')

    // Plugins need installing, not copying, so they are only reported.
    const remotePlugins = pluginNames((await ssh('cat ~/.claude/plugins/installed_plugins.json 2>/dev/null || true')).stdout)
    const localPlugins = pluginNames(
      existsSync(join(claude, 'plugins', 'installed_plugins.json'))
        ? readFileSync(join(claude, 'plugins', 'installed_plugins.json'), 'utf8')
        : ''
    )
    for (const p of localPlugins.filter((x) => !remotePlugins.includes(x)))
      log(`Plugin ${p} is only on this PC. To add it on the VPS: claude plugin install ${p}`)
    for (const p of remotePlugins.filter((x) => !localPlugins.includes(x)))
      log(`Plugin ${p} is only on the VPS. To add it here: claude plugin install ${p}`)
    const remoteSettings = (await ssh('md5sum < ~/.claude/settings.json 2>/dev/null | cut -d" " -f1 || true')).stdout.trim()
    if (remoteSettings && remoteSettings !== md5(join(claude, 'settings.json')))
      log('~/.claude/settings.json differs between the machines. It is not synced (it lists plugins); compare it by hand.')

    log(`Synced ${m.chats.length} chats. Backups: ${bk} (this PC), ${rbk} (VPS).`)
    return 0
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// realpath so a symlinked launch still runs.
function isEntry() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}
if (isEntry()) {
  const file = join(here, 'deploy.env')
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {}
  process.exitCode = await sync({ env: { ...fromFile, ...process.env } })
}
