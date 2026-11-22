// Probe of the real `codex app-server` (spec: docs/superpowers/specs/2026-11-09-codex-provider-design.md, "Phase 0: the probe",
// checks 1-6; checks 7-10, 14 and 15 of Phase 2 and 11-13, 16-18 of Phase 3 run only with `--only`). It speaks JSON-RPC over stdio lines to one app-server process per attempt, in a fresh git temp folder, and judges
// each check from the transcript alone, so `judge` can be unit tested without the CLI. Real Codex, a few cents of quota.
// Run directly: node zumi-bot-server/e2e/codexProbe.mjs [--record <dir>] [--only <n[,n...]>] [--soft]
// Exit 0 PASS, 1 FAILED, 2 INCONCLUSIVE (no codex, not signed in, the model never made the call: retried once per check).
// `--soft` turns 2 into 0 with a loud warning (npm run e2e passes it); ZUMIBOT_SKIP_CODEX_PROBE=1 skips it;
// ZUMIBOT_PROBE_CODEX names the binary (default `codex`); PROBE_CODEX_MODEL sets `model` on every thread.
// `--record <dir>` writes <dir>/codex-check<N>.jsonl: one `{dir, msg, t}` line per message ('out' = probe to codex, 'in' = codex
// to probe, `t` ms), then one last `{meta: {files, exit}}` line. Never any auth data: ~/.codex/auth.json is never read.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MCP = fileURLToPath(new URL('./fixtures/probe-codex-mcp.mjs', import.meta.url))
// A 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const TURN_MS = 180_000
const REQ_MS = 60_000
const INTERRUPT_MS = 10_000
const COMPACT_MS = 120_000
const NETWORK = { 'sandbox_workspace_write.network_access': true }

const binary = () => process.env.ZUMIBOT_PROBE_CODEX || 'codex'
const exists = (p) =>
  access(p).then(
    () => true,
    () => false
  )
const killGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Whether this machine reaches the site check 4's curl does, outside any sandbox; a failure is no verdict on Codex.
const hostOnline = () =>
  fetch('https://example.com', { method: 'HEAD', signal: AbortSignal.timeout(10_000) }).then(
    () => true,
    () => false
  )
// The app-servers running now, so a signal to the probe takes each process group (and its stub MCP server) down too.
const live = new Set()

// ---- the judge (pure) ----

const ins = (t) => t.lines.filter((l) => l.dir === 'in').map((l) => l.msg)
const notes = (t, method) => ins(t).filter((m) => m.method === method && m.id === undefined)
const requests = (t, method) => ins(t).filter((m) => m.method && m.id !== undefined && (!method || m.method === method))
const textOf = (v) => {
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}
const AUTH = /unauthori[sz]ed|not logged in|not signed in|log ?in|sign ?in|401/i
/** The in-line that answers the out-line at index i (same id, no method). */
const answerTo = (t, i) => {
  const id = t.lines[i].msg.id
  for (let j = i + 1; j < t.lines.length; j++) {
    const l = t.lines[j]
    if (l.dir === 'in' && l.msg.id === id && l.msg.method === undefined) return l.msg
  }
  return null
}
const outIndexes = (t, method) => t.lines.flatMap((l, i) => (l.dir === 'out' && l.msg.method === method ? [i] : []))
const initAnswered = (t) => outIndexes(t, 'initialize').some((i) => answerTo(t, i)?.result)
const itemsDone = (t, type) =>
  notes(t, 'item/completed')
    .map((m) => m.params?.item)
    .filter((it) => it?.type === type)
const agentTexts = (t) => itemsDone(t, 'agentMessage').map((it) => String(it.text ?? ''))
const authTrouble = (t) =>
  ins(t).some(
    (m) =>
      (m.method === 'error' || m.method === 'turn/completed' || m.error) &&
      AUTH.test(textOf(m.params?.error ?? m.params?.turn?.error ?? m.error))
  )

/** 'pass', 'fail' or 'inconclusive' for one check. Only a real wire or behaviour mismatch is a failure. */
export function judge(check, t) {
  if (!initAnswered(t)) return 'inconclusive'
  switch (check) {
    case 1: {
      const start = outIndexes(t, 'thread/start')
        .map((i) => answerTo(t, i))
        .find(Boolean)
      if (!start) return 'inconclusive'
      if (!start.result?.thread?.id) return 'fail'
      const done = notes(t, 'turn/completed')[0]
      if (!done) return authTrouble(t) ? 'inconclusive' : 'fail'
      if (done.params?.turn?.status !== 'completed') return authTrouble(t) ? 'inconclusive' : 'fail'
      if (notes(t, 'item/agentMessage/delta').length === 0) return 'fail'
      const usage = notes(t, 'thread/tokenUsage/updated').map((m) => m.params?.tokenUsage)
      if (usage.length === 0) return 'fail'
      const sum = usage.reduce((n, u) => n + Number(u?.last?.totalTokens ?? NaN), 0)
      return sum === usage[usage.length - 1]?.total?.totalTokens ? 'pass' : 'fail'
    }
    case 2: {
      const resume = outIndexes(t, 'thread/resume')[0]
      if (resume === undefined) return 'inconclusive'
      const before = (l) => t.lines.indexOf(l) < resume
      const replies = (pick) =>
        t.lines
          .filter((l) => l.dir === 'in' && pick(l) && l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'agentMessage')
          .map((l) => String(l.msg.params.item.text ?? ''))
      const first = replies(before).join(' '),
        second = replies((l) => !before(l)).join(' ')
      if (!second) return 'inconclusive'
      if (!first.includes('KIWI')) return 'inconclusive'
      return second.includes('MANGO') && !second.includes('KIWI') ? 'pass' : 'fail'
    }
    case 3: {
      const asked = requests(t, 'item/commandExecution/requestApproval')
      const f = t.files
      if (f['outside-marker:before']) return 'fail' // ran before the answer
      if (asked.length === 0) return f['outside-marker:declined'] || f['outside-marker:accepted'] ? 'fail' : 'inconclusive'
      if (f['outside-marker:declined']) return 'fail'
      if (f['outside-marker:accepted']) return 'pass'
      // No file after accept fails only if the model asked to write again after the decline; a model that did not rerun proves nothing.
      const declined = t.lines.findIndex((l) => l.dir === 'out' && l.msg.result?.decision === 'decline')
      const rerun =
        declined >= 0 &&
        t.lines.some(
          (l, i) =>
            i > declined &&
            l.dir === 'in' &&
            l.msg.id !== undefined &&
            l.msg.method === 'item/commandExecution/requestApproval' &&
            /outside-marker/.test(textOf(l.msg.params?.command))
        )
      return rerun ? 'fail' : 'inconclusive'
    }
    case 4: {
      const inside = requests(t).filter((m) => /inside\.txt/.test(String(m.params?.command ?? '')))
      if (inside.length) return 'fail' // an approval reached the client in auto mode
      const cmds = itemsDone(t, 'commandExecution')
      const curl = cmds.find((c) => /curl/.test(String(c.command)))
      if (!t.files['inside.txt'] && !cmds.some((c) => /inside\.txt/.test(String(c.command)))) return 'inconclusive'
      if (!t.files['inside.txt']) return 'fail'
      if (!curl) return 'inconclusive'
      if (curl.exitCode === 0) return 'pass'
      // A failed curl blames the sandbox only when this machine itself reached the network (offline is no verdict).
      return t.files['host-online'] === true ? 'fail' : 'inconclusive'
    }
    case 5: {
      const f = t.files
      if (!f['marker-mcp.txt']) return itemsDone(t, 'mcpToolCall').some((it) => it.status === 'failed') ? 'fail' : 'inconclusive'
      if (!f['marker-mcp.token']) return 'fail' // env_vars did not forward PROBE_TOKEN
      if (f['session-leak']) return 'fail'
      return itemsDone(t, 'mcpToolCall').some((it) => it.server === 'probe' && it.tool === 'probe_echo') ? 'pass' : 'fail'
    }
    case 6: {
      const sent = t.lines.findIndex((l) => l.dir === 'out' && l.msg.method === 'turn/interrupt')
      if (sent < 0) return 'inconclusive'
      const end = t.lines.find((l, i) => i > sent && l.dir === 'in' && l.msg.method === 'turn/completed')
      if (!end) return 'fail'
      const dt = (end.t ?? 0) - (t.lines[sent].t ?? 0)
      return end.msg.params?.turn?.status === 'interrupted' && dt <= INTERRUPT_MS ? 'pass' : 'fail'
    }
    case 7: {
      const forks = outIndexes(t, 'thread/fork')
      if (!forks.length) return 'inconclusive'
      const fi = forks[forks.length - 1] // the last try: the first may have used the wrong end of `lastTurnId`
      const ans = answerTo(t, fi)
      if (!ans) return 'inconclusive'
      const forkId = ans.result?.thread?.id
      if (!forkId || forkId === t.lines[fi].msg.params?.threadId) return 'fail'
      const resume = outIndexes(t, 'thread/resume').find((i) => i > fi)
      const forkReply = textsBetween(t, fi, resume ?? t.lines.length).join(' ')
      const sourceReply = resume === undefined ? '' : textsBetween(t, resume, t.lines.length).join(' ')
      if (!forkReply || !sourceReply) return 'inconclusive'
      if (!forkReply.includes('ALPHA') || forkReply.includes('BETA') || forkReply.includes('GAMMA')) return 'fail'
      return sourceReply.includes('GAMMA') ? 'pass' : 'fail'
    }
    case 8: {
      const fi = outIndexes(t, 'thread/fork').find((i) => t.lines[i].msg.params?.ephemeral === true)
      if (fi === undefined) return 'inconclusive'
      const ans = answerTo(t, fi)
      if (!ans) return 'inconclusive'
      if (!ans.result?.thread?.id) return 'fail'
      // A fork that never ran a turn may not have written anything yet, and a search that cannot find the source's own file is blind.
      if (!t.lines.some((l, i) => i > fi && l.dir === 'in' && l.msg.method === 'turn/completed')) return 'inconclusive'
      if (t.files['source-rollout'] !== true) return 'inconclusive'
      return t.files['fork-rollout'] === true ? 'fail' : 'pass'
    }
    case 9: {
      const ci = outIndexes(t, 'thread/compact/start')[0]
      if (ci === undefined) return 'inconclusive'
      const ans = answerTo(t, ci)
      if (ans?.error) return 'fail'
      const at = t.lines[ci].t ?? 0
      const notice = t.lines.find(
        (l, i) =>
          i > ci &&
          l.dir === 'in' &&
          (l.msg.method === 'thread/compacted' ||
            ((l.msg.method === 'item/started' || l.msg.method === 'item/completed') && l.msg.params?.item?.type === 'contextCompaction'))
      )
      if (notice) return (notice.t ?? 0) - at <= COMPACT_MS ? 'pass' : 'fail'
      return !ans && authTrouble(t) ? 'inconclusive' : 'fail'
    }
    case 10: {
      const orig = t.files['a.txt:original'],
        disk = t.files['a.txt:disk']
      if (typeof orig !== 'string' || typeof disk !== 'string' || orig === disk) return 'inconclusive' // the edit never landed
      const mine = itemsDone(t, 'fileChange')
        .filter((it) => it.status === undefined || it.status === 'completed')
        .flatMap((it) => (Array.isArray(it.changes) ? it.changes : []))
        .filter((c) => /(^|\/)a\.txt$/.test(String(c?.path)))
      if (!mine.length) return 'inconclusive' // the model edited through the shell
      let back = disk
      for (const c of [...mine].reverse()) {
        // the newest patch comes off first
        back = back === null ? null : reverseDiff(String(c.diff ?? ''), back)
      }
      return back === orig ? 'pass' : 'fail'
    }
    case 14: {
      const cmds = requests(t, 'item/commandExecution/requestApproval')
      const elicits = requests(t, 'mcpServer/elicitation/request')
      const patches = requests(t, 'item/fileChange/requestApproval')
      const started = notes(t, 'item/started').map((m) => m.params?.item)
      const cmdText = (c) => String(c?.params?.command ?? c?.command ?? '')
      const startedCmd = (re) => started.some((it) => it?.type === 'commandExecution' && re.test(String(it.command ?? '')))
      const attempts = {
        marker: { asked: cmds.some((c) => /side-marker/.test(cmdText(c))), tried: startedCmd(/side-marker/) },
        mcp: {
          asked: elicits.some((m) => /probe/.test(textOf(m.params))),
          tried: started.some((it) => it?.type === 'mcpToolCall' && it.tool === 'probe_echo')
        },
        file: {
          asked: patches.length > 0 || cmds.some((c) => /side-file/.test(cmdText(c))),
          tried: started.some((it) => it?.type === 'fileChange') || startedCmd(/side-file/)
        }
      }
      if (t.files['side-marker'] || t.files['side-file.txt'] || t.files['marker-mcp.txt']) return 'fail'
      const tried = Object.values(attempts).filter((a) => a.tried || a.asked)
      if (tried.some((a) => !a.asked)) return 'fail' // an attempt went by with no request to decline
      return tried.length < 2 ? 'inconclusive' : 'pass'
    }
    case 15: {
      const req = requests(t, 'item/tool/requestUserInput')[0]
      if (!req) return 'inconclusive'
      const qs = req.params?.questions
      const shaped =
        Array.isArray(qs) &&
        qs.length > 0 &&
        qs.every(
          (q) =>
            typeof q?.id === 'string' &&
            typeof q?.question === 'string' &&
            Array.isArray(q?.options) &&
            q.options.every((o) => typeof o?.label === 'string')
        )
      if (!shaped) return 'fail'
      if (!notes(t, 'turn/completed').length) return 'inconclusive'
      return agentTexts(t).join(' ').toLowerCase().includes('blue') ? 'pass' : 'fail'
    }
    case 11: {
      const f = t.files
      if (f['bypass-hook-trust'] === true) return 'inconclusive' // only a hook ZumiBot can run without the bypass counts
      if (f['blocked-marker'] === true) return 'fail'
      if (f['blocked-marker'] !== false) return 'inconclusive' // the marker was never looked for
      const inputs = hookInputs(f['hook-log'])
      if (!f['hook-source'] || !inputs.length) return 'inconclusive' // the hook never ran from any per-run source
      const naming = (re) => inputs.filter((i) => re.test(textOf(i.tool_input)) || re.test(String(i.tool_name ?? '')))
      const shellCall = naming(/blocked-marker/)[0]
      if (!shellCall) return 'inconclusive' // the model never tried the blocked command
      // A shell command that only names the file (an `ls` after the patch) is not the patch or MCP call itself.
      const other = (re) => naming(re).some((i) => i.tool_name !== shellCall.tool_name)
      const started = ins(t)
        .filter((m) => m.method === 'item/started' || m.method === 'item/completed')
        .map((m) => m.params?.item)
      const mcpCalled = started.some((it) => it?.type === 'mcpToolCall' && it.tool === 'probe_echo')
      const patched = started.some((it) => it?.type === 'fileChange' && /patch-marker/.test(textOf(it.changes)))
      if (!mcpCalled || !patched) return 'inconclusive' // a kind of call the model never made proves nothing either way
      return other(/probe_echo/) && other(/patch-marker/) ? 'pass' : 'fail'
    }
    case 12: {
      const asked = requests(t).filter((m) => m.method === 'mcpServer/elicitation/request' || /requestApproval$/.test(m.method))
      if (!asked.length) return 'inconclusive' // no per-tool setting made it ask
      // Only a request about this tool counts: another approval says nothing about forcing probe_echo.
      if (!asked.some((m) => /probe_echo/.test(textOf(m.params)))) return 'inconclusive'
      const f = t.files
      if (f['marker-mcp:at-request'] === true || f['marker-mcp:declined'] === true) return 'fail'
      if (f['marker-mcp:at-request'] !== false || f['marker-mcp:declined'] !== false) return 'inconclusive' // not looked for
      // A decline proves something only if an accept then lets the same tool run.
      return f['marker-mcp:accepted'] === true ? 'pass' : 'inconclusive'
    }
    case 13: {
      const collab = ins(t).some(
        (m) => /^item\/(started|completed)$/.test(m.method ?? '') && m.params?.item?.type === 'collabAgentToolCall'
      )
      if (!collab) return 'inconclusive'
      if (t.files['sleep-after-exit'] === true) return 'fail'
      if (t.files['sleep-started'] !== true) return 'inconclusive'
      // The leak check must have run: a missing key (something threw first) proves nothing.
      return t.files['sleep-after-exit'] === false ? 'pass' : 'inconclusive'
    }
    case 16: {
      const resume = outIndexes(t, 'thread/resume').find((i) => t.lines[i].msg.params?.excludeTurns === true)
      const fork = outIndexes(t, 'thread/fork').find(
        (i) => t.lines[i].msg.params?.excludeTurns === true && !t.lines[i].msg.params?.ephemeral
      )
      if (resume === undefined) return 'inconclusive'
      const noTurns = (a) => !(Array.isArray(a?.result?.thread?.turns) && a.result.thread.turns.length > 0)
      const ra = answerTo(t, resume)
      if (!ra) return 'inconclusive'
      if (ra.error || !noTurns(ra)) return 'fail'
      if (fork === undefined) return 'inconclusive'
      const fa = answerTo(t, fork)
      if (!fa) return 'inconclusive'
      if (fa.error || !noTurns(fa)) return 'fail'
      const [lo, hi] = resume < fork ? [resume, fork] : [fork, resume]
      const between = textsBetween(t, lo, hi).join(' '),
        after = textsBetween(t, hi, t.lines.length).join(' ')
      const resumeReply = resume < fork ? between : after,
        forkReply = resume < fork ? after : between
      if (!resumeReply || !forkReply) return 'inconclusive'
      if (!(resumeReply.includes('ALPHA') && resumeReply.includes('BETA'))) return 'fail'
      return forkReply.includes('ALPHA') && !forkReply.includes('BETA') ? 'pass' : 'fail'
    }
    case 17: {
      const i = outIndexes(t, 'thread/start').find((k) => typeof t.lines[k].msg.params?.config?.model_auto_compact_token_limit === 'number')
      if (i === undefined) return 'inconclusive'
      const a = answerTo(t, i)
      if (!a) return 'inconclusive'
      return a.result?.thread?.id ? 'pass' : 'fail'
    }
    case 18: {
      const stopped = t.lines.findIndex(
        (l) => l.dir === 'in' && l.msg.method === 'turn/completed' && l.msg.params?.turn?.status === 'interrupted'
      )
      if (stopped < 0) return 'inconclusive'
      const fi = outIndexes(t, 'thread/fork').find((i) => i > stopped)
      if (fi === undefined) return 'inconclusive'
      // Accepted or refused both work for the app (a refusal reseeds). No answer is a failure only when the app-server was
      // still alive at the deadline (a hang); a process that died or a request that broke is no verdict.
      if (answerTo(t, fi)) return 'pass'
      return t.files['fork-hang'] === true ? 'fail' : 'inconclusive'
    }
    default:
      return 'inconclusive'
  }
}

/** The hook stdin lines the probe's hook appended (JSONL); unreadable lines are skipped. */
function hookInputs(log) {
  if (typeof log !== 'string') return []
  return log
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

/** A value as TOML inline (for `codex -c key=<value>`): strings JSON-escaped, null-valued keys left out (TOML has no null). */
export function tomlInline(v) {
  if (v === null || v === undefined) throw new Error('TOML has no null')
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(tomlInline).join(',')}]`
  const key = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))
  return `{${Object.entries(v)
    .filter(([, x]) => x !== null && x !== undefined)
    .map(([k, x]) => `${key(k)}=${tomlInline(x)}`)
    .join(',')}}`
}

/** The text of the agentMessage items completed between line indexes `from` and `to`. */
function textsBetween(t, from, to) {
  return t.lines
    .slice(from, to)
    .filter((l) => l.dir === 'in' && l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'agentMessage')
    .map((l) => String(l.msg.params.item.text ?? ''))
}

/**
 * Puts the old text back from the new text and a unified diff of the change (file headers optional); null when the diff
 * is not hunks, or the new text does not hold what a hunk says it should (never a guess).
 */
export function reverseDiff(diff, newText) {
  const rows = String(diff).split('\n')
  if (rows[rows.length - 1] === '') rows.pop()
  const hunks = []
  for (const row of rows) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row)
    if (h) {
      hunks.push({ newStart: Number(h[3]), newLen: h[4] === undefined ? 1 : Number(h[4]), oldSide: [], newSide: [] })
      continue
    }
    const cur = hunks[hunks.length - 1]
    if (!cur) continue // a header line before the first hunk
    if (row.startsWith('\\')) continue // "\ No newline at end of file"
    const sign = row[0] ?? ' ',
      body = row.slice(1)
    if (sign === ' ') {
      cur.oldSide.push(body)
      cur.newSide.push(body)
    } else if (sign === '-') cur.oldSide.push(body)
    else if (sign === '+') cur.newSide.push(body)
    else return null
  }
  if (!hunks.length) return null
  const lines = newText.split('\n') // the last element is '' when the file ends with a newline
  for (const h of [...hunks].reverse()) {
    // later hunks first, so the earlier positions stay true
    const at = h.newLen === 0 ? h.newStart : h.newStart - 1
    if (at < 0 || at + h.newSide.length > lines.length || h.newSide.some((l, i) => lines[at + i] !== l)) return null
    lines.splice(at, h.newSide.length, ...h.oldSide)
  }
  return lines.join('\n')
}

/** `--only 7,8` as [7, 8]; null (all checks) when absent or not a list of numbers. */
export function parseOnly(v) {
  if (!v) return null
  const list = v.split(',').map((x) => x.trim())
  return list.every((x) => /^\d+$/.test(x)) ? list.map(Number) : null
}

// ---- the JSON-RPC line client ----

/** One `codex app-server --listen stdio://` process. `onRequest(msg)` answers a server-to-client request with its result. */
class Session {
  constructor(bin, cwd, env, { extraArgs = [], experimental = false, multiAgent = false } = {}) {
    this.experimental = experimental
    this.lines = []
    this.pending = new Map()
    this.nextId = 1
    this.onRequest = async () => {
      throw new Error('no handler')
    }
    this.waiters = new Set()
    this.stderr = ''
    this.exit = null
    // Subagents stay off as in the app, unless a check turns them on.
    const agents = multiAgent ? ['--enable', 'multi_agent'] : ['--disable', 'multi_agent']
    this.child = spawn(bin, ['app-server', '--listen', 'stdio://', ...agents, ...extraArgs], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    live.add(this.child)
    this.child.stdin.on('error', () => {})
    this.child.stderr.setEncoding('utf8').on('data', (c) => {
      this.stderr = (this.stderr + c).slice(-4000)
    })
    this.closed = new Promise((resolve) => {
      this.child.on('error', (e) => {
        this.error = `codex could not start (${bin}): ${e.message}`
        resolve()
      })
      this.child.on('close', (code) => {
        this.exit = code
        resolve()
      })
    })
    let buf = ''
    this.child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c
      for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        } // a banner or warning line
        this.receive(msg)
      }
    })
  }

  log(dir, msg) {
    const l = { dir, msg, t: Date.now() }
    this.lines.push(l)
    for (const w of [...this.waiters]) w()
    return l
  }

  write(msg) {
    this.log('out', msg)
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  receive(msg) {
    this.log('in', msg)
    if (msg.method && msg.id !== undefined) {
      Promise.resolve()
        .then(() => this.onRequest(msg))
        .then(
          (result) => this.write({ id: msg.id, result }),
          (e) => this.write({ id: msg.id, error: { code: -32601, message: String(e?.message ?? e) } })
        )
    } else if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? 'error'), { rpc: msg.error }))
      else p.resolve(msg.result)
    }
  }

  request(method, params, ms = REQ_MS) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: no answer in ${ms / 1000} s`))
      }, ms)
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.write({ id, method, params })
    })
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params })
  }

  /** Resolves with the first line, from index `from` on, that `pred(line)` accepts; rejects after `ms`. */
  waitFor(pred, ms, from = 0, what = 'a message') {
    return new Promise((resolve, reject) => {
      const look = () => {
        const l = this.lines.slice(from).find(pred)
        if (l) {
          done()
          resolve(l)
          return true
        }
        return false
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`no ${what} in ${ms / 1000} s`))
      }, ms)
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(look)
      }
      if (!look()) this.waiters.add(look)
    })
  }

  async initialize() {
    const r = await this.request('initialize', {
      clientInfo: { name: 'zumibot-probe', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: this.experimental, requestAttestation: false }
    })
    this.notify('initialized')
    this.userAgent = r?.userAgent ?? null
    this.codexHome = r?.codexHome ?? null
    return r
  }

  /** One turn: resolves with the `turn/completed` params once it arrives. `during(session, idx)` runs beside it. */
  async turn(threadId, input, extra = {}) {
    const from = this.lines.length
    const res = await this.request('turn/start', { threadId, input, ...extra })
    this.turnId = res?.turn?.id ?? null
    const end = await this.waitFor(
      (l) => l.dir === 'in' && l.msg.method === 'turn/completed' && l.msg.params?.threadId === threadId,
      TURN_MS,
      from,
      'turn/completed'
    )
    return end.msg.params
  }

  async close() {
    try {
      this.child.stdin.end()
    } catch {
      /* closed */
    }
    await Promise.race([this.closed, sleep(3000)])
    if (this.child.pid) killGroup(this.child)
    live.delete(this.child)
  }
}

const text = (s) => [{ type: 'text', text: s, text_elements: [] }]
const modelParams = () => (process.env.PROBE_CODEX_MODEL ? { model: process.env.PROBE_CODEX_MODEL } : {})
const threadParams = (cwd, o = {}) => ({
  cwd,
  sandbox: 'workspace-write',
  ...modelParams(),
  approvalPolicy: o.approvalPolicy ?? 'on-request',
  approvalsReviewer: o.approvalsReviewer ?? 'auto_review',
  config: { ...NETWORK, ...(o.config ?? {}) },
  ...(o.developerInstructions ? { developerInstructions: o.developerInstructions } : {})
})

/** A fresh `parent/ws` git folder (parent holds the files meant to be outside the workspace); the env a run gets. */
async function workspace() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'codex-probe-')))
  const ws = join(parent, 'ws')
  await mkdir(ws)
  try {
    execFileSync('git', ['init', '-q'], { cwd: ws, stdio: 'ignore' })
  } catch {
    /* the probe does not need git to exist */
  }
  const env = { ...process.env, PROBE_TOKEN: `probe-${randomBytes(9).toString('hex')}` }
  delete env.CODEX_THREAD_ID // the probe may be started from inside a Codex session
  return { parent, ws, env }
}

const sessionsHolding = async (home, id) => {
  const hits = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.includes(id)) hits.push(p)
    }
  }
  await walk(join(home, 'sessions'))
  return hits
}

// ---- the six checks: each returns {lines, files, exit, facts} ----

const approvalAnswer = (decision) => async () => ({ decision })

async function startThread(s, ws, o) {
  const r = await s.request('thread/start', threadParams(ws, o))
  return r?.thread?.id
}

async function check1({ bin }) {
  const { parent, ws, env } = await workspace()
  const s = new Session(bin, ws, env)
  const facts = {}
  try {
    s.onRequest = async (m) =>
      m.method === 'item/commandExecution/requestApproval' ? { decision: 'accept' } : Promise.reject(new Error('unexpected request'))
    await s.initialize()
    facts.userAgent = s.userAgent
    const id = await startThread(s, ws)
    const input = [
      ...text('Run the shell command `echo hi` once, then reply with one short sentence. This is a test; nothing real happens.'),
      { type: 'image', url: `data:image/png;base64,${PNG}` }
    ]
    await s.turn(id, input)
    const usage = s.lines.filter((l) => l.dir === 'in' && l.msg.method === 'thread/tokenUsage/updated').map((l) => l.msg.params.tokenUsage)
    facts.usageUpdates = usage.length
    facts.lastUsage = usage[usage.length - 1] ?? null
    facts.sumOfLast = usage.reduce((n, u) => n + (u?.last?.totalTokens ?? 0), 0)
  } finally {
    await s.close()
  }
  await rm(parent, { recursive: true, force: true })
  return { lines: s.lines, files: {}, exit: s.exit, facts, error: s.error }
}

// Instructions change between turns in the app (house style, the to-do note's paragraph), so a changed value must replace
// the old one on `thread/resume`. Each field is tried in a fresh folder and process pair; the first that works is the verdict
// and its transcript is the one recorded. Real finding (codex 0.164.0): `developerInstructions` on resume is ignored.
async function swap(bin, field) {
  const { parent, ws, env } = await workspace()
  const lines = [],
    facts = {}
  let id,
    exit = null,
    error
  try {
    for (const [i, word] of ['KIWI', 'MANGO'].entries()) {
      const s = new Session(bin, ws, env)
      try {
        s.onRequest = approvalAnswer('decline')
        await s.initialize()
        facts.userAgent = s.userAgent
        const given = { [field]: `Always end every reply with the word ${word}.` }
        if (i === 0) {
          id = (await s.request('thread/start', { ...threadParams(ws), ...given }))?.thread?.id
        } else await s.request('thread/resume', { threadId: id, ...threadParams(ws), ...given })
        await s.turn(id, text('Say hello in one short sentence. This is a test.'))
      } finally {
        await s.close()
        lines.push(...s.lines)
        exit = s.exit
        error ??= s.error
      }
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
  facts.replies = lines
    .filter((l) => l.dir === 'in' && l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'agentMessage')
    .map((l) => l.msg.params.item.text)
  return { lines, files: {}, exit, facts, error }
}

async function check2({ bin }) {
  const tried = {}
  let chosen = null
  for (const field of ['developerInstructions', 'baseInstructions']) {
    const r = await swap(bin, field)
    const verdict = r.error ? 'inconclusive' : judge(2, { lines: r.lines, files: r.files, exit: r.exit })
    tried[field] = { verdict, replies: r.facts.replies }
    if (!chosen || verdict === 'pass') chosen = { ...r, field }
    if (verdict === 'pass') break
  }
  chosen.facts = { userAgent: chosen.facts.userAgent, mechanism: chosen.field, tried }
  return chosen
}

async function check3({ bin }) {
  const { parent, ws, env } = await workspace()
  const outside = join(parent, 'outside-marker'),
    readable = join(parent, 'outside-read.txt')
  await writeFile(readable, 'outside-read-content\n')
  const s = new Session(bin, ws, env)
  const files = {},
    facts = { readAsked: false, readCommands: [] }
  const approvals = []
  try {
    await s.initialize()
    facts.userAgent = s.userAgent
    const id = await startThread(s, ws, { approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
    const prompt =
      'This is a test of sandbox approvals; nothing real happens. Run exactly this shell command and nothing else: `touch ../outside-marker`. If it is refused, do not retry or try another way. Then reply with the word DONE.'
    let mode = 'decline',
      phase = 'write'
    s.onRequest = async (m) => {
      if (m.method !== 'item/commandExecution/requestApproval') return { decision: 'decline' }
      approvals.push({ phase, command: m.params?.command, reason: m.params?.reason ?? null, keys: Object.keys(m.params ?? {}) })
      if (phase === 'write') files['outside-marker:before'] ||= await exists(outside)
      if (phase === 'read') {
        facts.readAsked = true
        facts.readCommands.push(m.params?.command ?? null)
      }
      return { decision: phase.startsWith('read') ? 'accept' : mode }
    }
    await s.turn(id, text(prompt))
    files['outside-marker:declined'] = await exists(outside)
    mode = 'accept'
    await s.turn(id, text(prompt))
    files['outside-marker:accepted'] = await exists(outside)
    // Control: every shell call asks in manual mode (it runs through `bash -lc`, so nothing counts as known safe), so an outside
    // read only needs its own handling if it asks where a read inside the workspace does not.
    await writeFile(join(ws, 'inside-read.txt'), 'inside-read-content\n')
    phase = 'readInside'
    const asked0 = approvals.length
    await s.turn(
      id,
      text(
        'This is a test; nothing real happens. Run exactly this shell command and nothing else: `cat inside-read.txt`. Then reply with the word DONE.'
      )
    )
    facts.readInsideAsked = approvals.length > asked0
    phase = 'read'
    await s.turn(
      id,
      text(
        'This is a test; nothing real happens. Run exactly this shell command and nothing else: `cat ../outside-read.txt`. Then reply with the word DONE.'
      )
    )
    facts.readOnlyAskedOutside = facts.readAsked && !facts.readInsideAsked
    facts.readRan = s.lines.some(
      (l) =>
        l.dir === 'in' &&
        l.msg.method === 'item/completed' &&
        l.msg.params?.item?.type === 'commandExecution' &&
        /outside-read/.test(String(l.msg.params.item.command)) &&
        l.msg.params.item.exitCode === 0
    )
    facts.approvals = approvals
  } finally {
    await s.close()
  }
  await rm(parent, { recursive: true, force: true })
  return { lines: s.lines, files, exit: s.exit, facts, error: s.error }
}

async function check4({ bin }) {
  const { parent, ws, env } = await workspace()
  const s = new Session(bin, ws, env)
  const files = {},
    facts = { requests: [] }
  try {
    s.onRequest = async (m) => {
      facts.requests.push({ method: m.method, command: m.params?.command ?? null })
      return { decision: 'decline' }
    }
    await s.initialize()
    facts.userAgent = s.userAgent
    const id = await startThread(s, ws, { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
    const say = (c) =>
      `This is a test; nothing real happens. Run exactly this shell command and nothing else: \`${c}\`. Then reply with the word DONE.`
    await s.turn(id, text(say('echo ok > inside.txt')))
    files['inside.txt'] = await exists(join(ws, 'inside.txt'))
    await s.turn(id, text(say('curl -sI https://example.com')))
    files['host-online'] = await hostOnline()
    // Informational only: what an escalation looks like on the wire when the reviewer, not the user, decides. /tmp is a
    // writable root of workspace-write, so the target is in /var/tmp, which is not.
    const far = await mkdtemp('/var/tmp/codex-probe-far-')
    await writeFile(join(far, 'read.txt'), 'far\n')
    const from = s.lines.length
    await s.turn(id, text(say(`cat ${far}/read.txt`))).catch(() => {})
    facts.farReadRan = s.lines
      .slice(from)
      .some(
        (l) =>
          l.dir === 'in' &&
          l.msg.method === 'item/completed' &&
          l.msg.params?.item?.type === 'commandExecution' &&
          l.msg.params.item.exitCode === 0
      )
    const from2 = s.lines.length
    await s.turn(id, text(say(`touch ${far}/escalated`))).catch(() => {})
    facts.escalation = s.lines
      .slice(from2)
      .filter((l) => l.dir === 'in' && /requestApproval|guardian|review|serverRequest|error/i.test(l.msg.method ?? ''))
      .map((l) => ({ method: l.msg.method, keys: Object.keys(l.msg.params ?? {}) }))
    facts.farWriteRan = await exists(join(far, 'escalated'))
    await rm(far, { recursive: true, force: true })
  } finally {
    await s.close()
  }
  await rm(parent, { recursive: true, force: true })
  return { lines: s.lines, files, exit: s.exit, facts, error: s.error }
}

async function check5({ bin }) {
  const { parent, ws, env } = await workspace()
  const config = { 'mcp_servers.probe': { command: process.execPath, args: [MCP], env_vars: ['PROBE_TOKEN'], tool_timeout_sec: 600 } }
  const prompt =
    'This is a test; nothing real happens. Call the tool probe_echo of the MCP server named probe once, with {"text": "hello"}. ' +
    'Then reply with the exact name of that tool as it appears in your tool list, written between <name> and </name>, and nothing else.'
  const files = {},
    facts = { elicitation: null }
  const extras = []
  let threadId, first
  // The same call in both permission modes: whether it asks differs by mode, and the app answers its own bridges in both.
  for (const [label, opts] of [
    ['auto', {}],
    ['manual', { approvalPolicy: 'untrusted', approvalsReviewer: 'user' }]
  ]) {
    const s = new Session(bin, ws, env)
    first ??= s
    const seen = []
    try {
      s.onRequest = async (m) => {
        if (m.method === 'mcpServer/elicitation/request') {
          seen.push({
            mode: m.params?.mode,
            serverName: m.params?.serverName,
            message: String(m.params?.message ?? '').slice(0, 200),
            meta: m.params?._meta ?? null,
            schemaKeys: Object.keys(m.params?.requestedSchema?.properties ?? {})
          })
          return { action: 'accept', content: null, _meta: null }
        }
        if (m.method === 'item/commandExecution/requestApproval') return { decision: 'accept' }
        throw new Error('unexpected request')
      }
      await s.initialize()
      facts.userAgent = s.userAgent
      const id = await startThread(s, ws, { ...opts, config })
      if (label === 'auto') threadId = id
      await s.turn(id, text(prompt))
      const call = s.lines.find((l) => l.dir === 'in' && l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'mcpToolCall')
        ?.msg.params.item
      const reply = s.lines
        .filter((l) => l.dir === 'in' && l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'agentMessage')
        .map((l) => l.msg.params.item.text)
        .join('\n')
      if (label === 'auto') {
        facts.elicitation = seen[0] ?? null
        facts.mcpToolCall = call ? { server: call.server, tool: call.tool, status: call.status, namespace: call.namespace ?? null } : null
        facts.reportedName = /<name>\s*([^<]*?)\s*<\/name>/.exec(reply)?.[1] ?? null
        facts.reply = reply.slice(0, 300)
        const marker = await readFile(join(ws, 'marker-mcp.txt'), 'utf8').catch(() => null)
        files['marker-mcp.txt'] = marker !== null
        files['marker-mcp.token'] = marker !== null && marker.includes(env.PROBE_TOKEN)
        // The token must not be in the session log, which lives under CODEX_HOME and names the thread id.
        const home = s.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')
        const hits = await sessionsHolding(home, threadId)
        facts.sessionFiles = hits.length
        let leak = false
        for (const p of hits) if ((await readFile(p, 'utf8').catch(() => '')).includes(env.PROBE_TOKEN)) leak = true
        files['session-leak'] = leak
      } else {
        facts.elicitationManual = seen
        facts.manualToolCall = call ? { server: call.server, tool: call.tool, status: call.status } : null
        extras.push({ name: 'check5-manual', lines: s.lines, files: {}, exit: s.exit })
      }
    } catch (e) {
      if (label === 'auto') throw e
      facts.manualError = e.message
    } finally {
      await s.close()
    }
  }
  await rm(parent, { recursive: true, force: true })
  return { lines: first.lines, files, exit: first.exit, facts, error: first.error, extras }
}

async function check6({ bin }) {
  const { parent, ws, env } = await workspace()
  const s = new Session(bin, ws, env)
  const facts = {}
  try {
    s.onRequest = async (m) =>
      m.method === 'item/commandExecution/requestApproval' ? { decision: 'accept' } : Promise.reject(new Error('unexpected request'))
    await s.initialize()
    facts.userAgent = s.userAgent
    const id = await startThread(s, ws)
    const from = s.lines.length
    const turn = s.turn(
      id,
      text(
        'This is a test; nothing real happens. Run exactly this shell command and nothing else: `sleep 30`. Then reply with the word DONE.'
      )
    )
    turn.catch(() => {})
    const started = await s.waitFor(
      (l) => l.dir === 'in' && l.msg.method === 'item/started' && l.msg.params?.item?.type === 'commandExecution',
      TURN_MS,
      from,
      'item/started'
    )
    s.request('turn/interrupt', { threadId: id, turnId: started.msg.params.turnId ?? s.turnId }).catch(() => {})
    const end = await turn
    facts.status = end?.turn?.status ?? null
    facts.interruptAnswerMs = null
  } catch (e) {
    facts.error = e.message
  } finally {
    await s.close()
  }
  await rm(parent, { recursive: true, force: true })
  return { lines: s.lines, files: {}, exit: s.exit, facts, error: s.error }
}

// ---- checks 7-10, 14, 15 (Phase 2: rewinds, compact, side runs, files, questions) ----

const agentReplies = (s, from = 0) =>
  s.lines
    .slice(from)
    .filter((l) => l.dir === 'in' && l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'agentMessage')
    .map((l) => String(l.msg.params.item.text ?? ''))
    .join('\n')
const noCommands = async (m) =>
  m.method === 'item/commandExecution/requestApproval' ? { decision: 'decline' } : Promise.reject(new Error('unexpected request'))

/** One process: a new thread with one turn per prompt. Returns the thread id and each turn's id; the session is closed. */
async function sourceThread(bin, ws, env, prompts, lines) {
  const s = new Session(bin, ws, env)
  const turns = []
  try {
    s.onRequest = noCommands
    await s.initialize()
    const id = await startThread(s, ws)
    for (const p of prompts) {
      await s.turn(id, text(p))
      turns.push(s.turnId)
    }
    return { id, turns, userAgent: s.userAgent, codexHome: s.codexHome }
  } finally {
    await s.close()
    lines.push(...s.lines)
  }
}

/** A fresh process that forks `threadId`; `ask` is the one turn it then runs. Returns the fork's answer and reply. */
async function forkAndAsk(bin, ws, env, params, ask, lines, o = {}) {
  const s = new Session(bin, ws, env)
  try {
    s.onRequest = o.onRequest ?? noCommands
    await s.initialize()
    const r = await s.request('thread/fork', { ...threadParams(ws, o), ...params })
    const from = s.lines.length
    await s.turn(r.thread.id, text(ask))
    return { answer: r, reply: agentReplies(s, from), codexHome: s.codexHome, userAgent: s.userAgent }
  } finally {
    await s.close()
    lines.push(...s.lines)
  }
}

const WORDS = ['ALPHA', 'BETA', 'GAMMA']
const remember = (w) => `This is a test; nothing real happens. Remember the word ${w}. Do not use any tool. Reply with just OK.`
const RECALL =
  'This is a test. Which words did I ask you to remember in this conversation? Reply with just those words, separated by spaces, and nothing else. If there are none, reply NONE.'

async function check7({ bin }) {
  const { parent, ws, env } = await workspace()
  const lines = [],
    facts = {}
  try {
    const src = await sourceThread(bin, ws, env, WORDS.map(remember), lines)
    facts.userAgent = src.userAgent
    facts.turnIds = src.turns
    // `lastTurnId` is documented as inclusive: try turn 1's id, then turn 2's if the fork knows nothing, and record which end holds.
    let semantics = 'unknown',
      tries = []
    for (const [i, last] of [src.turns[0], src.turns[1]].entries()) {
      const f = await forkAndAsk(bin, ws, env, { threadId: src.id, lastTurnId: last }, RECALL, lines)
      const known = WORDS.filter((w) => f.reply.includes(w))
      tries.push({
        lastTurnId: `turn ${i + 1}`,
        forkThreadDiffers: f.answer.thread.id !== src.id,
        turnsInAnswer: f.answer.thread.turns?.length ?? null,
        reply: f.reply.slice(0, 200),
        known
      })
      if (i === 0 && known.join() === 'ALPHA') {
        semantics = 'inclusive (lastTurnId keeps that turn)'
        break
      }
      if (i === 1 && known.join() === 'ALPHA') semantics = 'exclusive (lastTurnId keeps the turns before it)'
    }
    facts.lastTurnIdSemantics = semantics
    facts.tries = tries
    const s = new Session(bin, ws, env)
    try {
      s.onRequest = noCommands
      await s.initialize()
      await s.request('thread/resume', { threadId: src.id, ...threadParams(ws) })
      const from = s.lines.length
      await s.turn(src.id, text('This is a test. What was the last word I asked you to remember? Reply with just that word.'))
      facts.sourceReply = agentReplies(s, from).slice(0, 100)
    } finally {
      await s.close()
      lines.push(...s.lines)
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
  return { lines, files: {}, exit: null, facts }
}

async function check8({ bin }) {
  const { parent, ws, env } = await workspace()
  const lines = [],
    facts = {},
    files = {}
  try {
    const src = await sourceThread(bin, ws, env, WORDS.slice(0, 2).map(remember), lines)
    facts.userAgent = src.userAgent
    const f = await forkAndAsk(
      bin,
      ws,
      env,
      { threadId: src.id, lastTurnId: src.turns[0], ephemeral: true, excludeTurns: true },
      RECALL,
      lines
    )
    await sleep(1500) // a rollout, if one is written, is flushed by now
    const forkHits = await sessionsHolding(f.codexHome, f.answer.thread.id)
    const srcHits = await sessionsHolding(f.codexHome, src.id)
    files['fork-rollout'] = forkHits.length > 0
    files['source-rollout'] = srcHits.length > 0
    facts.forkThread = {
      ephemeral: f.answer.thread.ephemeral ?? null,
      path: f.answer.thread.path ?? null,
      preview: String(f.answer.thread.preview ?? '').slice(0, 60)
    }
    facts.forkReply = f.reply.slice(0, 100)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
  return { lines, files, exit: null, facts }
}

async function check9({ bin }) {
  const { parent, ws, env } = await workspace()
  const lines = [],
    facts = {},
    extras = []
  try {
    const src = await sourceThread(
      bin,
      ws,
      env,
      ['This is a test; nothing real happens. Reply with one short sentence about the sea. Do not use any tool.'],
      []
    )
    facts.userAgent = src.userAgent
    const s = new Session(bin, ws, env)
    try {
      s.onRequest = noCommands
      await s.initialize()
      await s.request('thread/resume', { threadId: src.id, ...threadParams(ws) })
      const from = s.lines.length
      const sentAt = Date.now()
      const answered = s.request('thread/compact/start', { threadId: src.id }, COMPACT_MS).then(
        (r) => ({ ok: true, r, at: Date.now() }),
        (e) => ({ ok: false, e: e.message, at: Date.now() })
      )
      const notice = (l) =>
        l.dir === 'in' &&
        (l.msg.method === 'thread/compacted' ||
          (/^item\/(started|completed)$/.test(l.msg.method) && l.msg.params?.item?.type === 'contextCompaction'))
      await s.waitFor(notice, COMPACT_MS, from, 'a compaction notice').catch(() => {})
      const a = await Promise.race([answered, sleep(2000).then(() => null)])
      // Let the rest of the sequence arrive: a turn that wraps the compaction ends after its notice.
      await s.waitFor((l) => l.dir === 'in' && l.msg.method === 'turn/completed', 15_000, from, 'turn/completed').catch(() => {})
      await sleep(1000)
      facts.compactAnswer = a ? { ok: a.ok, result: a.r ?? null, error: a.e ?? null, ms: a.at - sentAt } : 'no answer'
      facts.sequence = s.lines
        .slice(from)
        .filter((l) => l.dir === 'in' || l.msg.method === 'thread/compact/start')
        .map((l) => ({
          ms: l.t - sentAt,
          dir: l.dir,
          method: l.msg.method ?? '(answer)',
          item: l.msg.params?.item?.type ?? null
        }))
        .filter((x) => !/Delta|tokenUsage|rateLimits/.test(x.method))
    } finally {
      await s.close()
      lines.push(...s.lines)
    }
    // The auto-compact config key: is it accepted by thread/start, and does a low limit make the next turn compact?
    const accepted = {}
    for (const [label, limit] of [
      ['100000', 100000],
      ['1000', 1000]
    ]) {
      const a = new Session(bin, ws, env)
      try {
        a.onRequest = noCommands
        await a.initialize()
        const r = await a.request('thread/start', threadParams(ws, { config: { model_auto_compact_token_limit: limit } })).then(
          (x) => ({ ok: true, id: x?.thread?.id }),
          (e) => ({ ok: false, error: e.message })
        )
        accepted[label] = { startOk: r.ok, error: r.error ?? null }
        if (label === '1000' && r.ok) {
          // Two turns: the limit is checked as a request is made, so a lone turn cannot show a compaction.
          const t0 = a.lines.length
          for (const n of [1, 2]) {
            const turn = a.turn(r.id, text(`This is a test. Reply with one short sentence (${n}). Do not use any tool.`)).then(
              () => 'completed',
              (e) => e.message
            )
            accepted[label][`turn${n}`] = await Promise.race([turn, sleep(90_000).then(() => 'still running after 90 s')])
            if (accepted[label][`turn${n}`] !== 'completed') {
              await a.request('turn/interrupt', { threadId: r.id, turnId: a.turnId }, 5000).catch(() => {})
              break
            }
          }
          accepted[label].compactedDuringTurns = a.lines
            .slice(t0)
            .filter((l) => l.dir === 'in' && (l.msg.method === 'thread/compacted' || l.msg.params?.item?.type === 'contextCompaction'))
            .map((l) => l.msg.method)
        }
      } finally {
        await a.close()
        if (label === '1000') extras.push({ name: 'check9-auto', lines: a.lines, files: {}, exit: a.exit })
      }
    }
    facts.autoCompactConfig = accepted
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
  return { lines, files: {}, exit: null, facts, extras }
}

async function check10({ bin }) {
  const { parent, ws, env } = await workspace()
  const original = 'line one\nline two\nline three\n'
  await writeFile(join(ws, 'a.txt'), original)
  await writeFile(join(ws, 'c.txt'), 'to be deleted\n')
  const s = new Session(bin, ws, env)
  const facts = {},
    files = {}
  try {
    s.onRequest = async (m) =>
      /requestApproval$/.test(m.method) ? { decision: 'accept' } : Promise.reject(new Error('unexpected request'))
    await s.initialize()
    facts.userAgent = s.userAgent
    const id = await startThread(s, ws)
    await s.turn(
      id,
      text(
        'This is a test; nothing real happens. Use your file-editing patch tool (not shell commands) to do exactly this: ' +
          'in a.txt change the second line from "line two" to "line TWO changed"; create b.txt holding the single line "brand new"; delete c.txt. Then reply with the word DONE.'
      )
    )
    files['a.txt:original'] = original
    files['a.txt:disk'] = await readFile(join(ws, 'a.txt'), 'utf8').catch(() => '')
    facts.bExists = await exists(join(ws, 'b.txt'))
    facts.cGone = !(await exists(join(ws, 'c.txt')))
    const done = s.lines
      .filter((l) => l.dir === 'in' && l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'fileChange')
      .map((l) => l.msg.params.item)
    facts.fileChangeItems = done.map((it) => ({ status: it.status, changes: it.changes }))
    facts.methodsSeen = [
      ...new Set(
        s.lines.filter((l) => l.dir === 'in' && l.msg.method && /fileChange|turn\/diff|patch/i.test(l.msg.method)).map((l) => l.msg.method)
      )
    ]
    facts.shellCommands = s.lines
      .filter((l) => l.dir === 'in' && l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'commandExecution')
      .map((l) => l.msg.params.item.command)
  } finally {
    await s.close()
  }
  await rm(parent, { recursive: true, force: true })
  return { lines: s.lines, files, exit: s.exit, facts, error: s.error }
}

async function check14({ bin }) {
  const { parent, ws, env } = await workspace()
  const lines = [],
    facts = { requests: [] },
    files = {}
  const config = { 'mcp_servers.probe': { command: process.execPath, args: [MCP], env_vars: ['PROBE_TOKEN'], tool_timeout_sec: 600 } }
  try {
    const src = await sourceThread(
      bin,
      ws,
      env,
      ['This is a test; nothing real happens. Reply with the word OK. Do not use any tool.'],
      lines
    )
    facts.userAgent = src.userAgent
    // The side guard: with no hooks the only brake is that every request is declined, so a declined request must run nothing.
    const decline = async (m) => {
      facts.requests.push({
        method: m.method,
        command: m.params?.command ?? null,
        message: String(m.params?.message ?? '').slice(0, 100) || null
      })
      if (m.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null }
      if (m.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
      return { decision: 'decline' }
    }
    const f = await forkAndAsk(
      bin,
      ws,
      env,
      { threadId: src.id, ephemeral: true, excludeTurns: true, sandbox: 'read-only', config },
      'This is a test; nothing real happens. Do these three things, each with its own tool call and in this order, and do not retry any that is refused: ' +
        '1. run the shell command `touch side-marker`; 2. call the tool probe_echo of the MCP server named probe once with {"text": "x"}; 3. create a new file named side-file.txt holding the line x, using your file-editing patch tool. Then reply with the word DONE.',
      lines,
      { approvalPolicy: 'untrusted', approvalsReviewer: 'user', onRequest: decline }
    )
    facts.reply = f.reply.slice(0, 200)
    files['side-marker'] = await exists(join(ws, 'side-marker'))
    files['side-file.txt'] = await exists(join(ws, 'side-file.txt'))
    files['marker-mcp.txt'] = await exists(join(ws, 'marker-mcp.txt'))
    facts.itemsStarted = lines.filter((l) => l.dir === 'in' && l.msg.method === 'item/started').map((l) => l.msg.params?.item?.type)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
  return { lines, files, exit: null, facts }
}

const PICK =
  'This is a test; nothing real happens. Use your question tool (request_user_input) to ask me to pick one of two options, red or blue. Wait for my answer, then reply with the word I picked.'
async function check15({ bin }) {
  const { parent, ws, env } = await workspace()
  const facts = { variants: {} },
    extras = []
  let chosen = null
  // The flag the brief names, then the same with experimentalApi on, then no flag at all (record only).
  const variants = [
    ['flag', { extraArgs: ['--enable', 'default_mode_request_user_input'] }],
    ['flag+experimentalApi', { extraArgs: ['--enable', 'default_mode_request_user_input'], experimental: true }],
    ['noFlag', {}]
  ]
  try {
    for (const [label, opts] of variants) {
      if (label === 'flag+experimentalApi' && chosen?.requested) {
        facts.variants[label] = 'skipped (an earlier variant had a request)'
        continue
      }
      const s = new Session(bin, ws, env, opts)
      const answers = []
      try {
        s.onRequest = async (m) => {
          if (m.method === 'item/tool/requestUserInput') {
            const q = m.params?.questions ?? []
            const reply = { answers: Object.fromEntries(q.map((x) => [x.id, { answers: ['blue'] }])) }
            answers.push({ params: m.params, answered: reply })
            return reply
          }
          if (/requestApproval$/.test(m.method)) return { decision: 'accept' }
          throw new Error('unexpected request')
        }
        await s.initialize()
        facts.userAgent = s.userAgent
        const id = await startThread(s, ws)
        let ended = 'completed'
        // A variant that never ends (no flag: the question may hang the turn) is stopped after 60 s and described, not failed.
        await Promise.race([
          s.turn(id, text(PICK)),
          sleep(label === 'noFlag' ? 60_000 : TURN_MS).then(() => {
            throw new Error('no turn/completed')
          })
        ]).catch((e) => {
          ended = e.message
        })
        if (ended !== 'completed') await s.request('turn/interrupt', { threadId: id, turnId: s.turnId }, 5000).catch(() => {})
        facts.variants[label] = {
          requested: answers.length > 0,
          ended,
          reply: agentReplies(s).slice(0, 150),
          request: answers[0] ?? null,
          methods: [
            ...new Set(
              s.lines
                .filter(
                  (l) =>
                    l.dir === 'in' &&
                    l.msg.method &&
                    !/Delta|tokenUsage|rateLimits|mcpServer\/startup|thread\/status|account\/|remoteControl/.test(l.msg.method)
                )
                .map((l) => l.msg.method)
            )
          ]
        }
        if (label !== 'noFlag') {
          if (!chosen || answers.length) chosen = { lines: s.lines, label, exit: s.exit, error: s.error, requested: answers.length > 0 }
        } else extras.push({ name: 'check15-noflag', lines: s.lines, files: {}, exit: s.exit })
      } catch (e) {
        facts.variants[label] = { error: e.message }
      } finally {
        await s.close()
      }
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
  facts.usedVariant = chosen?.label ?? null
  return { lines: chosen?.lines ?? [], files: {}, exit: chosen?.exit ?? null, facts, error: chosen?.error, extras }
}

// ---- checks 11-13, 16-18 (Phase 3: hooks, forced MCP approval, subagents, excludeTurns, compact limit, interrupted fork) ----

/** Processes (pid, args) whose working folder is `dir` or below and whose command line matches `re`. Linux /proc only. */
function processesIn(dir, re) {
  const found = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`)
      if (cwd !== dir && !cwd.startsWith(`${dir}/`)) continue
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      if (re.test(args)) found.push({ pid: Number(name), args })
    } catch {
      /* gone, or not ours */
    }
  }
  return found
}
const killAll = (procs) => {
  for (const p of procs)
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const say = (c) =>
  `This is a test; nothing real happens. Run exactly this shell command and nothing else: \`${c}\`. Then reply with the word DONE.`
const MCP_CONFIG = (extra = {}) => ({
  'mcp_servers.probe': { command: process.execPath, args: [MCP], env_vars: ['PROBE_TOKEN'], tool_timeout_sec: 600, ...extra }
})
const cut = (v, n = 400) => {
  const s = typeof v === 'string' ? v : textOf(v)
  return s.length > n ? `${s.slice(0, n)}…` : s
}
const itemsOf = (lines, type, from = 0) =>
  lines
    .slice(from)
    .filter((l) => l.dir === 'in' && /^item\/(started|completed)$/.test(l.msg.method ?? '') && l.msg.params?.item?.type === type)
    .map((l) => ({ phase: l.msg.method.slice(5), threadId: l.msg.params.threadId ?? null, ...l.msg.params.item }))

// The probe's hook: logs each stdin as one JSONL line, blocks `blocked-marker` (exit 2, stderr BLOCKED-BY-PROBE), exits 1 on
// `exit1-marker` (does exit 1 block?) and outlives its timeout on `timeout-marker` (what does a timeout do?).
const HOOK_TIMEOUT_SEC = 5
async function probeHook(parent) {
  const script = join(parent, 'probe-hook.sh'),
    log = join(parent, 'hook-log.jsonl')
  await writeFile(
    script,
    [
      '#!/bin/sh',
      'input=$(cat)',
      `printf '%s\\n' "$input" >> ${shq(log)}`,
      'case "$input" in',
      '  *blocked-marker*) echo "BLOCKED-BY-PROBE" >&2; exit 2 ;;',
      '  *exit1-marker*) echo "EXIT1-BY-PROBE" >&2; exit 1 ;;',
      '  *timeout-marker*) exec sleep 20 ;;',
      'esac',
      'exit 0',
      ''
    ].join('\n')
  )
  const command = `sh ${shq(script)}`
  // No `matcher` (every tool): TOML has no null, and the thread `config` is turned into TOML too.
  return { log, command, group: [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] }] }
}
const hookLogOf = async (log) => await readFile(log, 'utf8').catch(() => '')
/** hooks/list entries, names and sources only (a user or project hook's command is never kept). */
const hookSummary = (r) =>
  (r?.data ?? [])
    .flatMap((d) => d.hooks ?? [])
    .map((h) => ({
      key: h.key,
      eventName: h.eventName,
      source: h.source,
      handlerType: h.handlerType,
      trustStatus: h.trustStatus,
      timeoutSec: h.timeoutSec,
      matcher: h.matcher,
      ...(h.source === 'sessionFlags' ? { currentHash: h.currentHash } : {})
    }))
// The recorded transcript keeps a hooks/list answer's commands only for the probe's own session-flag hooks.
const redactOtherHooks = (lines) => {
  for (const l of lines)
    for (const d of l.msg?.result?.data ?? [])
      for (const h of d?.hooks ?? []) if (h?.source && h.source !== 'sessionFlags' && 'command' in h) h.command = '[not recorded]'
}

/**
 * The hook sources tried in order: `thread/start`'s `config`, `-c` on the app-server line (a `sessionFlags` hook), then the same
 * `-c` hook trusted by its own hash through `-c hooks.state` (the hash comes from a `hooks/list` of a first process, which
 * starts no model). Never `--dangerously-bypass-hook-trust` or `bypass_hook_trust`, which would also run the user's hooks.
 */
async function hookSources(bin, ws, env, hook) {
  const cli = ['-c', `hooks.PreToolUse=${tomlInline(hook.group)}`]
  const pre = new Session(bin, ws, env, { extraArgs: cli })
  let trusted = null
  try {
    await pre.initialize()
    const listed = await pre.request('hooks/list', { cwds: [ws] })
    const mine = (listed?.data ?? []).flatMap((d) => d.hooks ?? []).find((h) => h.source === 'sessionFlags' && h.command === hook.command)
    if (mine) trusted = { key: mine.key, hash: mine.currentHash }
  } finally {
    await pre.close()
  }
  const sources = [
    ['config', { args: [], config: { hooks: { PreToolUse: hook.group } } }],
    ['cli', { args: cli, config: {} }]
  ]
  if (trusted)
    sources.push([
      'cli+trust',
      { args: [...cli, '-c', `hooks.state=${tomlInline({ [trusted.key]: { trusted_hash: trusted.hash } })}`], config: {} }
    ])
  return { sources, trusted }
}

async function check11({ bin }) {
  const { parent, ws, env } = await workspace()
  // `bypass-hook-trust` is a guard record, never a mode: the probe never passes the trust bypass, so it stays false.
  const files = { 'bypass-hook-trust': false, 'hook-source': '' }
  const facts = { tried: {}, hooksListed: {}, timeoutSec: HOOK_TIMEOUT_SEC }
  const extras = []
  let chosen = null,
    far = null
  try {
    const hook = await probeHook(parent)
    facts.hookCommandShape = { PreToolUse: hook.group }
    far = await mkdtemp('/var/tmp/codex-probe-far-')
    await writeFile(join(far, 'read.txt'), 'far\n')
    const { sources, trusted } = await hookSources(bin, ws, env, hook)
    facts.trustedBy = trusted ? { stateKey: trusted.key, hash: trusted.hash } : null
    for (const [label, src] of sources) {
      const s = new Session(bin, ws, env, { extraArgs: src.args })
      const requests = []
      let keep = false
      try {
        s.onRequest = async (m) => {
          requests.push({
            method: m.method,
            threadId: m.params?.threadId ?? null,
            command: m.params?.command ?? null,
            hookAlreadyRan: (await hookLogOf(hook.log)).includes('blocked-marker-manual')
          })
          if (m.method === 'mcpServer/elicitation/request') return { action: 'accept', content: null, _meta: null }
          if (m.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
          return { decision: 'accept' }
        }
        await s.initialize()
        facts.userAgent = s.userAgent
        facts.hooksListed[label] = hookSummary(await s.request('hooks/list', { cwds: [ws] }).catch(() => null))
        const id = await startThread(s, ws, { config: { ...MCP_CONFIG(), ...src.config } })
        if (label === 'config')
          facts.hooksListed['config:afterThreadStart'] = hookSummary(await s.request('hooks/list', { cwds: [ws] }).catch(() => null))
        await s.turn(id, text(say('echo ok')))
        const fired = (await hookLogOf(hook.log)).includes('echo ok')
        facts.tried[label] = fired ? 'fired' : 'did not fire'
        if (!fired) continue
        keep = true
        chosen = s
        files['hook-source'] = label
        facts.source = { label, appServerArgs: src.args, threadConfig: src.config }
        // The three shell outcomes, one turn: exit 2 (blocks?), exit 1, a hook that outlives its timeout.
        let from = s.lines.length
        await s.turn(
          id,
          text(
            'This is a test of a command filter; nothing real happens. Run these three shell commands, each as its own separate tool call, in this order: ' +
              '`touch blocked-marker`, then `touch exit1-marker`, then `touch timeout-marker`. Do not retry any of them and do not try another way. ' +
              'Then, for each command that was refused or failed, write the exact message you received for it between <seen> and </seen>. Then reply with the word DONE.'
          )
        )
        for (const m of ['blocked-marker', 'exit1-marker', 'timeout-marker']) files[m] = await exists(join(ws, m))
        facts.shellOutcomes = {
          'exit 2 (blocked-marker) ran': files['blocked-marker'],
          'exit 1 (exit1-marker) ran': files['exit1-marker'],
          'timeout (timeout-marker) ran': files['timeout-marker']
        }
        facts.shellItems = itemsOf(s.lines, 'commandExecution', from)
          .filter((i) => i.phase === 'completed')
          .map((i) => ({ command: i.command, status: i.status, exitCode: i.exitCode ?? null, output: cut(i.aggregatedOutput ?? '', 300) }))
        facts.shellItemsStarted = itemsOf(s.lines, 'commandExecution', from)
          .filter((i) => i.phase === 'started')
          .map((i) => i.command)
        facts.modelSaw = agentReplies(s, from).slice(0, 1200)
        from = s.lines.length
        await s.turn(
          id,
          text(
            'This is a test; nothing real happens. Call the tool probe_echo of the MCP server named probe once, with {"text": "hook"}. Then reply with the word DONE.'
          )
        )
        facts.mcpItems = itemsOf(s.lines, 'mcpToolCall', from)
          .filter((i) => i.phase === 'completed')
          .map((i) => ({ server: i.server, tool: i.tool, status: i.status }))
        from = s.lines.length
        await s.turn(
          id,
          text(
            'This is a test; nothing real happens. Use your file-editing patch tool (apply_patch, not a shell command) to create a new file named patch-marker.txt holding the single line x. Then reply with the word DONE.'
          )
        )
        facts.patchItems = itemsOf(s.lines, 'fileChange', from)
          .filter((i) => i.phase === 'completed')
          .map((i) => ({ status: i.status, paths: (i.changes ?? []).map((c) => c.path) }))
        files['patch-marker.txt'] = await exists(join(ws, 'patch-marker.txt'))
        // Auto mode runs a read outside the workspace without asking (check 4): does the hook still see it?
        from = s.lines.length
        const asked0 = requests.length
        await s.turn(id, text(say(`cat ${far}/read.txt`)))
        facts.farRead = {
          hookSawIt: (await hookLogOf(hook.log)).includes(`${far}/read.txt`),
          asked: requests.length > asked0,
          ran: itemsOf(s.lines, 'commandExecution', from).some((i) => i.phase === 'completed' && i.exitCode === 0)
        }
        // Manual mode: does the hook run before the approval request, or after the user allowed it?
        from = s.lines.length
        const asked1 = requests.length
        await s.turn(id, text(say('touch blocked-marker-manual')), { approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
        facts.manual = {
          requests: requests.slice(asked1),
          ran: await exists(join(ws, 'blocked-marker-manual')),
          hookSawIt: (await hookLogOf(hook.log)).includes('blocked-marker-manual')
        }
        facts.hookNotifications = s.lines
          .filter((l) => l.dir === 'in' && /^hook\//.test(l.msg.method ?? ''))
          .map((l) => ({
            method: l.msg.method,
            threadId: l.msg.params?.threadId,
            turnId: l.msg.params?.turnId,
            eventName: l.msg.params?.run?.eventName,
            source: l.msg.params?.run?.source,
            status: l.msg.params?.run?.status,
            durationMs: l.msg.params?.run?.durationMs ?? null,
            entries: l.msg.params?.run?.entries
          }))
        facts.hookNotificationCount = facts.hookNotifications.length
      } catch (e) {
        facts.tried[label] ??= `error: ${e.message}`
        if (keep) facts.stepsError = e.message
      } finally {
        await s.close()
        redactOtherHooks(s.lines)
        if (!keep) extras.push({ name: `check11-${label.replace('+', '-')}`, lines: s.lines, files: {}, exit: s.exit })
      }
      if (keep) break
    }
    killAll(processesIn(ws, /\bsleep 20\b/)) // a timed-out hook that codex left behind
    const log = await hookLogOf(hook.log)
    files['hook-log'] = log
    facts.hookInputs = hookInputs(log)
    // Subagent identity: the same hook with multi_agent on; does a subagent's call carry a field the main thread's lacks?
    if (chosen) {
      const src = facts.source
      const s = new Session(bin, ws, env, { extraArgs: src.appServerArgs, multiAgent: true })
      try {
        s.onRequest = async (m) =>
          m.method === 'mcpServer/elicitation/request' ? { action: 'accept', content: null, _meta: null } : { decision: 'accept' }
        await s.initialize()
        const id = await startThread(s, ws, { config: src.threadConfig })
        await s.turn(
          id,
          text(
            'This is a test; nothing real happens. First run the shell command `echo main` yourself. Then use your spawn_agent tool to start exactly one ' +
              'subagent whose only task is to run the shell command `echo sub` and report what it printed. Wait for the subagent to finish, then reply with the word DONE.'
          )
        )
        const all = hookInputs(await hookLogOf(hook.log))
        const main = all.find((i) => /echo main/.test(textOf(i.tool_input))),
          sub = all.find((i) => /echo sub/.test(textOf(i.tool_input)))
        const keys = (i) => (i ? Object.keys(i).sort() : null)
        const pick = (i) =>
          i
            ? {
                tool_name: i.tool_name,
                session_id: i.session_id,
                turn_id: i.turn_id,
                agent_id: i.agent_id,
                agent_type: i.agent_type,
                transcript_path: i.transcript_path,
                keys: keys(i)
              }
            : null
        const subThreads = itemsOf(s.lines, 'collabAgentToolCall').flatMap((i) => i.receiverThreadIds ?? [])
        facts.subagent = {
          mainThread: id,
          childThreads: [...new Set(subThreads)],
          main: pick(main),
          sub: pick(sub),
          subRanEchoSub: itemsOf(s.lines, 'commandExecution').some((i) => /echo sub/.test(String(i.command))),
          keysOnlyInSub: main && sub ? keys(sub).filter((k) => !(k in main)) : null,
          differingValues: main && sub ? keys(sub).filter((k) => k in main && textOf(main[k]) !== textOf(sub[k])) : null
        }
        files['hook-log'] = await hookLogOf(hook.log)
      } catch (e) {
        facts.subagentError = e.message
      } finally {
        await s.close()
        extras.push({ name: 'check11-subagent', lines: s.lines, files: {}, exit: s.exit })
      }
    }
    facts.otherHooks = Object.values(facts.hooksListed)
      .flat()
      .filter((h) => h.source !== 'sessionFlags')
  } finally {
    killAll(processesIn(ws, /\bsleep 20\b/))
    if (far) await rm(far, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
  const main = chosen ?? { lines: extras.at(-1)?.lines ?? [], exit: extras.at(-1)?.exit ?? null }
  return { lines: main.lines, files, exit: main.exit, facts, error: main.error, extras: chosen ? extras : extras.slice(0, -1) }
}

// Forcing an approval for one MCP tool in auto mode (computer use's action tools must always ask). Variants in order; the first
// that asks is judged. A decline turn first (the tool must not run), then an accept turn (it must run).
async function check12({ bin }) {
  const variants = [
    ['tools.probe_echo.approval_mode', 'prompt', { tools: { probe_echo: { approval_mode: 'prompt' } } }],
    ['tools.probe_echo.approval_mode', 'approve', { tools: { probe_echo: { approval_mode: 'approve' } } }],
    ['default_tools_approval_mode', 'prompt', { default_tools_approval_mode: 'prompt' }]
  ]
  const facts = { tried: [] },
    extras = []
  let chosen = null
  const prompt =
    'This is a test; nothing real happens. Call the tool probe_echo of the MCP server named probe once, with {"text": "forced"}. ' +
    'If the call is refused or declined, do not retry and do not try another way. Then reply with the word DONE.'
  for (const [key, value, extra] of variants) {
    const { parent, ws, env } = await workspace()
    const marker = join(ws, 'marker-mcp.txt')
    const s = new Session(bin, ws, env)
    const files = {},
      seen = []
    let phase = 'decline'
    try {
      s.onRequest = async (m) => {
        files['marker-mcp:at-request'] ||= await exists(marker)
        seen.push({ phase, method: m.method, params: { ...m.params, requestedSchema: m.params?.requestedSchema ?? undefined } })
        const yes = phase === 'accept'
        if (m.method === 'mcpServer/elicitation/request') return { action: yes ? 'accept' : 'decline', content: null, _meta: null }
        if (m.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
        return { decision: yes ? 'accept' : 'decline' }
      }
      await s.initialize()
      facts.userAgent = s.userAgent
      const id = await startThread(s, ws, { config: MCP_CONFIG(extra) })
      await s.turn(id, text(prompt))
      files['marker-mcp:declined'] = await exists(marker)
      const askedOnDecline = seen.length > 0
      if (askedOnDecline) {
        phase = 'accept'
        await s.turn(id, text(prompt))
        files['marker-mcp:accepted'] = await exists(marker)
      }
      const warnings = s.lines
        .filter((l) => l.dir === 'in' && /configWarning|^warning$|deprecationNotice/.test(l.msg.method ?? ''))
        .map((l) => cut(l.msg.params, 300))
      facts.tried.push({
        key: `mcp_servers.probe.${key}`,
        value,
        asked: askedOnDecline,
        ranAfterDecline: files['marker-mcp:declined'],
        ranAfterAccept: files['marker-mcp:accepted'] ?? null,
        requests: seen.map((r) => ({ phase: r.phase, method: r.method, params: cut(r.params, 900) })),
        warnings,
        stderrIgnored: /ignoring|unrecognized|unknown/i.test(s.stderr) ? cut(s.stderr.slice(-600), 600) : null,
        mcpItems: itemsOf(s.lines, 'mcpToolCall')
          .filter((i) => i.phase === 'completed')
          .map((i) => ({ status: i.status, error: i.error ?? null }))
      })
      const r = { lines: s.lines, files, exit: s.exit, error: s.error }
      if (askedOnDecline && !chosen) {
        chosen = r
        facts.working = { key: `mcp_servers.probe.${key}`, value }
        facts.request = seen[0] ?? null
      } else extras.push({ name: `check12-${key.split('.').pop()}-${value}`, ...r })
    } finally {
      await s.close()
      await rm(parent, { recursive: true, force: true })
    }
    if (chosen) break
  }
  const main = chosen ?? extras.pop() ?? { lines: [], files: {}, exit: null }
  return { lines: main.lines, files: main.files, exit: main.exit, facts, error: main.error, extras }
}

async function check13({ bin }) {
  const { parent, ws, env } = await workspace()
  const s = new Session(bin, ws, env, { multiAgent: true })
  const files = {},
    facts = { approvals: [] }
  try {
    s.onRequest = async (m) => {
      facts.approvals.push({ method: m.method, threadId: m.params?.threadId ?? null, command: m.params?.command ?? null })
      if (m.method === 'mcpServer/elicitation/request') return { action: 'accept', content: null, _meta: null }
      if (m.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
      return { decision: 'accept' }
    }
    await s.initialize()
    facts.userAgent = s.userAgent
    // Manual mode, so a child's command approval (if one reaches this client) shows with its thread id.
    const id = await startThread(s, ws, { approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
    const end1 = await s.turn(
      id,
      text(
        'This is a test; nothing real happens. Use your spawn_agent tool to start exactly one subagent whose only task is to run the shell command ' +
          '`echo child` and report what it printed. Wait for the subagent to finish, then reply with its report.'
      )
    )
    const turn1End = s.lines.findLast((l) => l.dir === 'in' && l.msg.method === 'turn/completed' && l.msg.params?.threadId === id)
    const children = [...new Set(itemsOf(s.lines, 'collabAgentToolCall').flatMap((i) => i.receiverThreadIds ?? []))]
    const fromChild = (l) => l.dir === 'in' && l.msg.params?.threadId && l.msg.params.threadId !== id
    facts.turn1 = {
      status: end1?.turn?.status,
      mainThread: id,
      childThreads: children,
      collab: itemsOf(s.lines, 'collabAgentToolCall').map((i) => ({
        phase: i.phase,
        threadId: i.threadId,
        tool: i.tool,
        status: i.status,
        senderThreadId: i.senderThreadId,
        receiverThreadIds: i.receiverThreadIds,
        agentsStates: i.agentsStates,
        prompt: cut(i.prompt ?? '', 200),
        model: i.model ?? null
      })),
      subAgentActivity: itemsOf(s.lines, 'subAgentActivity').map((i) => ({
        phase: i.phase,
        threadId: i.threadId,
        kind: i.kind,
        agentThreadId: i.agentThreadId,
        agentPath: i.agentPath,
        model: i.model ?? null
      })),
      methodsByThread: Object.fromEntries(
        [...new Set(s.lines.filter((l) => l.dir === 'in' && l.msg.params?.threadId).map((l) => l.msg.params.threadId))].map((th) => [
          th === id ? `main ${th}` : `other ${th}`,
          [
            ...new Set(
              s.lines
                .filter((l) => l.dir === 'in' && l.msg.params?.threadId === th && !/Delta|tokenUsage/.test(l.msg.method ?? ''))
                .map((l) => l.msg.method ?? '(answer)')
            )
          ]
        ])
      ),
      childItemTypes: [
        ...new Set(
          s.lines
            .filter((l) => fromChild(l) && /^item\//.test(l.msg.method ?? ''))
            .map((l) => `${l.msg.method}:${l.msg.params?.item?.type ?? ''}`)
        )
      ],
      lastChildMessageMsBeforeTurnCompleted: (() => {
        const last = s.lines.filter(fromChild).at(-1)
        return last && turn1End ? turn1End.t - last.t : null
      })(),
      childTurnCompleted: s.lines
        .filter((l) => fromChild(l) && l.msg.method === 'turn/completed')
        .map((l) => ({
          threadId: l.msg.params.threadId,
          status: l.msg.params?.turn?.status,
          msBeforeMain: turn1End ? turn1End.t - l.t : null
        })),
      approvalsFromChild: facts.approvals.filter((a) => a.threadId && a.threadId !== id),
      reply: agentReplies(s).slice(0, 300)
    }
    // Stop: a child sleeping, then turn/interrupt for the main turn only.
    const from = s.lines.length
    const turn2 = s.turn(
      id,
      text(
        'This is a test; nothing real happens. Use your spawn_agent tool to start exactly one subagent whose only task is to run the shell command ' +
          '`sleep 60` and then report DONE. Wait for the subagent to finish, then reply with the word DONE.'
      )
    )
    turn2.catch(() => {})
    const started = await s.waitFor(
      (l) =>
        l.dir === 'in' &&
        l.msg.method === 'item/started' &&
        l.msg.params?.item?.type === 'commandExecution' &&
        /sleep 60/.test(String(l.msg.params.item.command)),
      TURN_MS,
      from,
      'the child sleep'
    )
    files['sleep-started'] = true
    await sleep(1500)
    facts.stop = { sleepThread: started.msg.params.threadId, sleepProcsBefore: processesIn(ws, /\bsleep 60\b/).length }
    const sentAt = Date.now()
    s.request('turn/interrupt', { threadId: id, turnId: s.turnId }).catch((e) => {
      facts.stop.interruptError = e.message
    })
    const end2 = await Promise.race([turn2, sleep(30_000).then(() => null)])
    facts.stop.mainStatus = end2?.turn?.status ?? 'no turn/completed in 30 s'
    facts.stop.mainEndMs = end2 ? Date.now() - sentAt : null
    await sleep(3000)
    files['sleep-after-interrupt'] = processesIn(ws, /\bsleep 60\b/).length > 0
    facts.stop.after = s.lines
      .slice(from)
      .filter(
        (l) =>
          l.dir === 'in' &&
          l.t >= sentAt &&
          (l.msg.method === 'turn/completed' ||
            l.msg.params?.item?.type === 'subAgentActivity' ||
            l.msg.params?.item?.type === 'collabAgentToolCall' ||
            (l.msg.method === 'item/completed' && l.msg.params?.item?.type === 'commandExecution'))
      )
      .map((l) => ({
        ms: l.t - sentAt,
        method: l.msg.method,
        threadId: l.msg.params?.threadId,
        status: l.msg.params?.turn?.status ?? l.msg.params?.item?.status ?? null,
        kind: l.msg.params?.item?.kind ?? null,
        tool: l.msg.params?.item?.tool ?? null,
        agentsStates: l.msg.params?.item?.agentsStates ?? undefined
      }))
    // Close the app-server as the runner does (stdin first), and look for the child's sleep before any kill.
    try {
      s.child.stdin.end()
    } catch {
      /* closed */
    }
    await Promise.race([s.closed, sleep(5000)])
    facts.stop.appServerExited = s.exit !== null
    files['sleep-after-exit'] = processesIn(ws, /\bsleep 60\b/).length > 0
  } catch (e) {
    facts.error = e.message
  } finally {
    await s.close()
    killAll(processesIn(ws, /\bsleep 60\b/))
    await rm(parent, { recursive: true, force: true })
  }
  return { lines: s.lines, files, exit: s.exit, facts, error: s.error }
}

async function check16({ bin }) {
  const { parent, ws, env } = await workspace()
  const lines = [],
    facts = {}
  try {
    const src = await sourceThread(bin, ws, env, WORDS.slice(0, 2).map(remember), lines)
    facts.userAgent = src.userAgent
    const s = new Session(bin, ws, env)
    try {
      s.onRequest = noCommands
      await s.initialize()
      const r = await s.request('thread/resume', { threadId: src.id, ...threadParams(ws), excludeTurns: true }).then(
        (x) => ({ x }),
        (e) => ({ e: e.message })
      )
      facts.resume = r.e ? { error: r.e } : { turns: Array.isArray(r.x?.thread?.turns) ? r.x.thread.turns.length : 'absent' }
      if (!r.e) {
        const from = s.lines.length
        await s.turn(src.id, text(RECALL))
        facts.resume.reply = agentReplies(s, from).slice(0, 100)
      }
      facts.resume.deprecationNotice = s.lines.some((l) => l.dir === 'in' && l.msg.method === 'deprecationNotice')
    } finally {
      await s.close()
      lines.push(...s.lines)
    }
    // A non-ephemeral fork at turn 1 (inclusive, check 7): only ALPHA may be remembered.
    const f = new Session(bin, ws, env)
    try {
      f.onRequest = noCommands
      await f.initialize()
      const r = await f
        .request('thread/fork', { ...threadParams(ws), threadId: src.id, lastTurnId: src.turns[0], excludeTurns: true })
        .then(
          (x) => ({ x }),
          (e) => ({ e: e.message })
        )
      facts.fork = r.e
        ? { error: r.e }
        : { turns: Array.isArray(r.x?.thread?.turns) ? r.x.thread.turns.length : 'absent', newId: r.x?.thread?.id !== src.id }
      if (!r.e) {
        const from = f.lines.length
        await f.turn(r.x.thread.id, text(RECALL))
        facts.fork.reply = agentReplies(f, from).slice(0, 100)
      }
    } finally {
      await f.close()
      lines.push(...f.lines)
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
  return { lines, files: {}, exit: null, facts }
}

// Only accepts or refuses the limit at thread/start; nothing runs near the window.
async function check17({ bin }) {
  const { parent, ws, env } = await workspace()
  const s = new Session(bin, ws, env)
  const facts = {}
  try {
    s.onRequest = noCommands
    await s.initialize()
    facts.userAgent = s.userAgent
    const id = await startThread(s, ws)
    await s.turn(id, text('This is a test. Reply with just OK. Do not use any tool.'))
    const usage = s.lines.filter((l) => l.dir === 'in' && l.msg.method === 'thread/tokenUsage/updated').map((l) => l.msg.params.tokenUsage)
    const window = Number(usage.at(-1)?.modelContextWindow ?? NaN)
    facts.window = Number.isFinite(window) ? window : null
    if (facts.window) {
      const limit = facts.window + 100_000
      facts.limit = limit
      const from = s.lines.length
      const r = await s.request('thread/start', threadParams(ws, { config: { model_auto_compact_token_limit: limit } })).then(
        (x) => ({ x }),
        (e) => ({ e: e.message })
      )
      await sleep(2000) // a notice about the value, if any, comes now
      facts.accepted = !r.e
      facts.error = r.e ?? null
      facts.notices = s.lines
        .slice(from)
        .filter((l) => l.dir === 'in' && /configWarning|warning|deprecationNotice|^error$/.test(l.msg.method ?? ''))
        .map((l) => ({ method: l.msg.method, params: cut(l.msg.params, 400) }))
      facts.stderr = /compact|limit|clamp|window/i.test(s.stderr) ? cut(s.stderr.slice(-600), 600) : null
    }
  } finally {
    await s.close()
  }
  await rm(parent, { recursive: true, force: true })
  return { lines: s.lines, files: {}, exit: s.exit, facts, error: s.error }
}

async function check18({ bin }) {
  const { parent, ws, env } = await workspace()
  const lines = [],
    facts = {},
    files = {}
  try {
    const s = new Session(bin, ws, env)
    let id, stoppedTurn
    try {
      s.onRequest = async (m) =>
        /requestApproval$/.test(m.method) ? { decision: 'accept' } : Promise.reject(new Error('unexpected request'))
      await s.initialize()
      facts.userAgent = s.userAgent
      id = await startThread(s, ws)
      await s.turn(id, text(remember('ALPHA')))
      const from = s.lines.length
      const turn = s.turn(
        id,
        text(
          'This is a test; nothing real happens. Remember the word BETA. Then run exactly this shell command and nothing else: `sleep 30`. Then reply with the word DONE.'
        )
      )
      turn.catch(() => {})
      const started = await s.waitFor(
        (l) => l.dir === 'in' && l.msg.method === 'item/started' && l.msg.params?.item?.type === 'commandExecution',
        TURN_MS,
        from,
        'item/started'
      )
      stoppedTurn = started.msg.params.turnId ?? s.turnId
      s.request('turn/interrupt', { threadId: id, turnId: stoppedTurn }).catch(() => {})
      const end = await turn
      facts.interruptedStatus = end?.turn?.status ?? null
    } finally {
      await s.close()
      killAll(processesIn(ws, /\bsleep 30\b/))
      lines.push(...s.lines)
    }
    const f = new Session(bin, ws, env)
    try {
      f.onRequest = noCommands
      await f.initialize()
      const at = Date.now()
      const r = await f.request('thread/fork', { ...threadParams(ws), threadId: id, lastTurnId: stoppedTurn }).then(
        (x) => ({ x }),
        (e) => ({ e: e.message, rpc: e.rpc ?? null })
      )
      // A hang: our own deadline passed with no answer while the app-server still ran (not an RPC error, not a dead process).
      files['fork-hang'] = Boolean(r.e) && !r.rpc && f.exit === null && !f.error
      facts.fork = r.e
        ? { error: r.e, code: r.rpc?.code ?? null, ms: Date.now() - at }
        : {
            accepted: true,
            ms: Date.now() - at,
            turns:
              r.x?.thread?.turns?.map((u) => ({ id: u.id === stoppedTurn ? '(interrupted turn)' : 'other', status: u.status })) ?? 'absent'
          }
      if (!r.e) {
        const from = f.lines.length
        await f.turn(r.x.thread.id, text(RECALL))
        facts.fork.reply = agentReplies(f, from).slice(0, 100)
      }
    } finally {
      await f.close()
      lines.push(...f.lines)
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
  return { lines, files, exit: null, facts }
}

const CHECKS = [
  [1, 'turn basics', check1],
  [2, 'instructions on resume', check2],
  [3, 'approvals, manual mode', check3],
  [4, 'approvals, auto mode', check4],
  [5, 'MCP bridge', check5],
  [6, 'stop', check6],
  [7, 'fork at a turn', check7],
  [8, 'ephemeral fork', check8],
  [9, 'compact', check9],
  [10, 'file changes', check10],
  [11, 'PreToolUse hook', check11],
  [12, 'forced MCP approval', check12],
  [13, 'subagents', check13],
  [14, 'side guard without hooks', check14],
  [15, 'question input', check15],
  [16, 'excludeTurns on resume and fork', check16],
  [17, 'compact limit above the window', check17],
  [18, 'fork at an interrupted turn', check18]
]
// Checks 1-6 gate the provider; 7+ each gate one feature and cost many model turns, so only `--only` runs them
// (`npm run probe:codex -- --only 7,8,9,10,14,15`, Phase 3's `--only 11,12,13,16,17,18`); a default run, which `npm run e2e` makes, never does.
const FEATURE_FROM = 7
/** The check numbers a run executes, in order: the named ones, else only 1-6. */
export function selectedChecks(only) {
  return CHECKS.map(([n]) => n).filter((n) => (only ? only.includes(n) : n < FEATURE_FROM))
}

export { Session, workspace, threadParams, text } // for ad hoc experiments against the real CLI

const cliVersion = (bin) => {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return 'unknown'
  }
}

// Fixtures must hold no machine identity either: the install id and the host name come with the app-server's status line.
const scrub = (s) =>
  s
    .split(homedir())
    .join('/home/user')
    .split(hostname())
    .join('host')
    .replace(/"installationId":"[^"]*"/g, '"installationId":"install-id"')
    .replace(/eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}/g, '[redacted]')
const record = async (dir, n, r) => {
  await mkdir(dir, { recursive: true })
  const rows = r.lines.map((l) => JSON.stringify({ dir: l.dir, msg: l.msg, t: l.t }))
  rows.push(JSON.stringify({ meta: { files: r.files, exit: r.exit } }))
  await writeFile(join(dir, `codex-check${n}.jsonl`), scrub(rows.join('\n') + '\n'))
}

/** Runs the checks; returns {outcome, version, reason, results}. Throws only on local setup errors. */
export async function probeCodex({ bin = binary(), log = console.log, recordDir = null, only = null } = {}) {
  const results = [],
    picked = selectedChecks(only)
  for (const [n, name, fn] of CHECKS) {
    if (!picked.includes(n)) continue
    let r,
      verdict,
      note = null
    for (let i = 0; i < 2; i++) {
      try {
        r = await fn({ bin })
        verdict = r.error ? 'inconclusive' : judge(n, { lines: r.lines, files: r.files, exit: r.exit })
        note = r.error ?? null
      } catch (e) {
        r = { lines: [], files: {}, exit: null, facts: {} }
        verdict = 'inconclusive'
        note = e.message
      }
      log(`codex probe: check ${n} (${name}), run ${i + 1}: ${verdict}${note ? ` (${note})` : ''}`)
      if (recordDir) {
        await record(recordDir, n, r)
        for (const x of r.extras ?? []) await record(recordDir, x.name.replace(/^check/, ''), x)
      }
      if (verdict !== 'inconclusive') break
    }
    results.push({ n, name, verdict, note, facts: r.facts ?? {} })
  }
  const bad = results.find((r) => r.verdict === 'fail') ?? results.find((r) => r.verdict === 'inconclusive')
  const version = results.map((r) => r.facts.userAgent).find(Boolean) ?? cliVersion(bin)
  log('codex probe: summary')
  for (const r of results)
    log(`  check ${r.n} ${r.name}: ${r.verdict.toUpperCase()}${r.note ? ` (${r.note})` : ''}\n    facts: ${JSON.stringify(r.facts)}`)
  const f = (n) => results.find((r) => r.n === n)?.facts ?? {}
  log(`  userAgent: ${version}`)
  if (results.some((r) => r.n <= 6)) {
    // the lines below read checks 1-6
    log(
      `  MCP tool as the model names it: ${f(5).reportedName ?? '?'} (mcpToolCall server=${f(5).mcpToolCall?.server ?? '?'} tool=${f(5).mcpToolCall?.tool ?? '?'})`
    )
    log(
      `  MCP elicitation came: auto mode ${f(5).elicitation ? 'yes' : 'no'}, manual mode ${(f(5).elicitationManual?.length ?? 0) > 0 ? 'yes' : 'no'}`
    )
    log(
      `  outside read asked (manual mode): ${f(3).readAsked ?? '?'}; the same read inside the workspace asked: ${f(3).readInsideAsked ?? '?'}`
    )
    log(
      `  instruction swap on resume works through: ${f(2).mechanism ?? '?'} (developerInstructions: ${f(2).tried?.developerInstructions?.verdict ?? '?'}, baseInstructions: ${f(2).tried?.baseInstructions?.verdict ?? 'not tried'})`
    )
  }
  return {
    outcome: bad ? bad.verdict : 'pass',
    version,
    reason: bad ? `check ${bad.n} (${bad.name})${bad.note ? `: ${bad.note}` : ''}` : null,
    results
  }
}

/** The exit code: 0 pass (or skipped, or inconclusive with --soft), 1 failed, 2 inconclusive. */
export async function main(args = [], probe = probeCodex) {
  if (process.env.ZUMIBOT_SKIP_CODEX_PROBE === '1') {
    console.log('codex probe: skipped (ZUMIBOT_SKIP_CODEX_PROBE=1)')
    return 0
  }
  const arg = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : null
  }
  const only = parseOnly(arg('--only'))
  let outcome,
    version = 'unknown',
    reason
  try {
    ;({ outcome, version, reason } = await probe({ recordDir: arg('--record'), only }))
  } catch (e) {
    outcome = 'inconclusive'
    reason = `the probe could not run: ${e.message}`
  }
  if (outcome === 'pass') {
    console.log(`codex probe: PASS (${version})`)
    return 0
  }
  if (outcome === 'fail') {
    console.error(`FAILED: ${version}: ${reason}`)
    return 1
  }
  console.error(`INCONCLUSIVE: ${version}: ${reason}`)
  if (!args.includes('--soft')) return 2
  console.error(
    '!!! WARNING: the codex probe was SKIPPED as inconclusive: the Codex app-server behaviour is NOT verified for this codex version.'
  )
  console.error(
    '!!! Run `node zumi-bot-server/e2e/codexProbe.mjs` again (signed in with `codex login`, with quota) before relying on Codex agents.'
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A Ctrl-C or kill must not leave an app-server and its stub MCP server running.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ])
    process.once(signal, () => {
      for (const c of live) killGroup(c)
      process.exit(code)
    })
  // Exit explicitly: a race-losing timer of a check would otherwise keep the process alive for minutes.
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
