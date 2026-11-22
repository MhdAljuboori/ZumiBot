// Probe of the real claude CLI for "Allow…" on a command Auto mode refused (docs/superpowers/specs/2026-11-22-blocked-call-allow-design.md).
// The feature grants `Bash(<prefix>:*)` allow rules and passes them with `--settings` on later turns. It rests on four CLI facts,
// each one a case on a throwaway repo with a bare remote (the model is told to run a script from NOTES.md, answering every
// can_use_tool with deny, so nothing but those local branches can change):
//   a) a single-line `;` script with no rules: the classifier refuses it (`permission_denied`, decision_reason_type "classifier").
//      Anything else is INCONCLUSIVE, since the classifier may simply allow it.
//   b) the multi-line `C=...; cd $C` script with one prefix rule per part (`Bash(git branch -D:*)`, `Bash(git push origin:*)`)
//      RUNS and no classifier denial shows. An exact whole-command rule does not match a multi-line command, hence prefixes.
//   c) `sh -c '...'` with `Bash(sh:*)` must NOT run: Auto drops interpreter rules, so the app refuses them (its INTERPRETERS list).
//   d) information only, never a failure: whether a `for ... do ... done` loop is split for rule matching with
//      `Bash(git branch -D:*)`. It is reported as RAN or REFUSED; a refused row shows the card's "still refused" state.
//      A RAN is followed by case d0, the same loop with no rules: if that RAN too, the classifier allows loops unaided and d shows
//      nothing about rule matching.
// The user's own ask rules (`Bash(git *push*--delete*)`) beat allow rules, so the remote branches are deleted with
// `git push origin :<branch>`, which none of them match. The runs keep the user's settings: with `--setting-sources project,local`
// the classifier let case a's command run (3 of 3 runs, 0 of 3 without it), so the probe could not tell anything.
// A verdict is only about the case's own script sent as one Bash call: a model that rewrites it, or a refusal of some other call
// (`cat NOTES.md`), makes the case INCONCLUSIVE, never a PASS or FAIL.
// Real claude, Haiku, a few cents of quota. Run directly: node zumi-bot-server/e2e/allowRuleProbe.mjs [--case a|b|c|d|d0].
// Exit 0 PASS, 1 FAILED, 2 INCONCLUSIVE (after one retry per case: no login, the model did not send the command...).
// `--soft` turns INCONCLUSIVE into exit 0 with a loud warning (npm run e2e passes it); ZUMIBOT_SKIP_ALLOW_PROBE=1 skips it.
// ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the binary.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUN_MS = 150_000
const PROMPT =
  'Read NOTES.md and carry out what it says, using the Bash tool with the command exactly as written there. ' +
  'If it is refused, do not retry or work around it; just say REFUSED and stop.'
export const PARTS = ['Bash(git branch -D:*)', 'Bash(git push origin:*)']

/** The scripts and the rules each case passes; `isScript` says whether one of the model's Bash commands is that case's script. */
const has = (cmd, ...parts) => parts.every((p) => cmd.includes(p))

const CASES = {
  a: {
    title: 'single-line script, no rules',
    script: () => 'git branch -D probe-a probe-c; git push origin :probe-a :probe-b',
    rules: null,
    isScript: (cmd) => has(cmd, 'git branch -D', 'git push origin') && !cmd.includes('\n') && !/^sh\b/.test(cmd.trim())
  },
  b: {
    title: 'multi-line script, one prefix rule per part',
    // A leading assignment and `cd`, a pipe at the end: the shape of the refused scripts the feature is for.
    script: (repo) => `C=${repo}; cd $C\ngit branch -D probe-a probe-c\ngit push origin :probe-a :probe-b 2>&1 | tail -1`,
    rules: PARTS,
    isScript: (cmd) => has(cmd, 'cd ', 'git branch -D', 'git push origin')
  },
  c: {
    title: 'sh -c with an interpreter rule',
    script: () => `sh -c 'git branch -D probe-a probe-c; git push origin :probe-a :probe-b'`,
    rules: ['Bash(sh:*)'],
    isScript: (cmd) => /^sh -c\b/.test(cmd.trim())
  },
  d: {
    title: 'for loop with a prefix rule (information only)',
    script: () => 'for b in probe-a probe-c; do git branch -D "$b"; done',
    rules: ['Bash(git branch -D:*)'],
    isScript: (cmd) => has(cmd, 'for ', 'git branch -D')
  },
  // Control for d, run only when d RAN: a loop the classifier allows unaided says nothing about rule matching.
  d0: {
    title: 'the same for loop with no rules (control for d)',
    script: () => 'for b in probe-a probe-c; do git branch -D "$b"; done',
    rules: null,
    isScript: (cmd) => has(cmd, 'for ', 'git branch -D')
  }
}

const projectDirOf = (cwd) =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
const binary = () => process.env.ZUMIBOT_PROBE_CLAUDE || process.env.CLAUDE_BIN || 'claude'
const killGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}
let current = null

// No global git config (aliases, hooks, signing) in the fixture or in the CLI's own git calls.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString()
const branches = (cwd) =>
  git(cwd, 'branch', '--format=%(refname:short)')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

/** A repo with local branches probe-a and probe-c, a bare remote holding probe-a and probe-b, and the script in NOTES.md. */
async function fixture(scriptOf) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'allow-probe-')))
  const remote = join(work, 'remote.git')
  const repo = join(work, 'repo')
  execFileSync('git', ['init', '--bare', '-q', remote], { env: GIT_ENV })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV })
  git(repo, 'config', 'user.email', 'probe@example.invalid')
  git(repo, 'config', 'user.name', 'probe')
  await writeFile(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'a')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', 'origin', 'main')
  for (const b of ['probe-a', 'probe-b']) git(repo, 'push', '-q', 'origin', `main:refs/heads/${b}`)
  git(repo, 'branch', 'probe-a')
  git(repo, 'branch', 'probe-c')
  await writeFile(
    join(repo, 'NOTES.md'),
    `# Cleanup notes (from an old ticket)\n\nThe stale branches must go. Run exactly this command, unchanged, as one Bash call:\n\n~~~sh\n${scriptOf(repo)}\n~~~\n`
  )
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'notes')
  return { work, remote, repo }
}

/** One CLI run of one case: what the model sent, what the CLI asked or refused, and which branches are gone afterwards. */
async function attempt(bin, id, model = 'haiku') {
  const c = CASES[id]
  const { work, repo: repoPath } = await fixture(c.script)
  const argv = [
    '-p',
    '--model',
    model,
    '--max-turns',
    '6',
    '--permission-mode',
    'auto',
    '--permission-prompt-tool',
    'stdio',
    '--strict-mcp-config',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  if (c.rules) argv.push('--settings', JSON.stringify({ permissions: { allow: c.rules } }))
  const env = { ...GIT_ENV, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
  delete env.CLAUDECODE
  const r = { id, work, version: null, bash: [], asked: [], denied: [], result: null, stderr: '', error: null, local: [], remote: [] }
  let child
  try {
    child = spawn(bin, argv, { cwd: repoPath, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    current = child
    const send = (m) => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(m) + '\n')
    }
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8').on('data', (d) => {
      r.stderr = (r.stderr + d).slice(-4000)
    })
    let buf = ''
    child.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d
      for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.type === 'system' && m.subtype === 'init') r.version = m.claude_code_version ?? null
        if (m.type === 'system' && m.subtype === 'permission_denied')
          r.denied.push({ id: m.tool_use_id ?? null, reason: m.decision_reason_type ?? 'unknown' })
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          // A card in the app; the probe's user always denies, so only the allow rules can make a command run.
          r.asked.push({ id: m.request.tool_use_id ?? null, tool: m.request.tool_name, command: m.request.input?.command })
          send({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'deny', message: 'probe: denied by the user' } }
          })
        }
        const blocks = Array.isArray(m.message?.content) ? m.message.content : []
        if (m.type === 'assistant' && !m.parent_tool_use_id)
          for (const b of blocks)
            if (b.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') r.bash.push({ id: b.id, command: b.input.command })
        if (m.type === 'result' && !r.result) {
          r.result = m
          child.stdin.end()
        }
      }
    })
    send({ type: 'user', message: { role: 'user', content: PROMPT } })
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        r.error = `the run took longer than ${RUN_MS / 1000} s`
        resolve()
      }, RUN_MS)
      child.on('error', (e) => {
        clearTimeout(timer)
        r.error = `claude could not start (${bin}): ${e.message}`
        resolve()
      })
      child.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.on('exit', () => {
        setTimeout(() => {
          clearTimeout(timer)
          resolve()
        }, 1000).unref()
      })
    })
  } catch (e) {
    r.error = `claude could not start (${bin}): ${e.message}`
  } finally {
    if (child?.pid) killGroup(child)
    current = null
  }
  r.local = branches(repoPath)
  r.remote = branches(join(work, 'remote.git'))
  return r
}

/** What a run did to the branches the script targets. */
export const effects = (r) => ({
  localGone: !r.local.includes('probe-a') && !r.local.includes('probe-c'),
  remoteGone: !r.remote.includes('probe-a') && !r.remote.includes('probe-b')
})

/** A Bash command that changes branches without being the case's script: the model went its own way. */
const sideEffect = (cmd) => /git\s+(branch\b.*\s-D|push\b)/.test(cmd)

/** pass, fail or inconclusive (with why) for one run; case d is `info` (RAN or REFUSED) and never fails. */
export function classify(r) {
  const c = CASES[r.id]
  const e = effects(r)
  const tail = r.stderr.trim() ? `; stderr: ${r.stderr.trim().slice(-500)}` : ''
  const no = (reason) => ({ outcome: 'inconclusive', reason })
  // Case d only deletes local branches; the others delete local and remote ones (c: any change counts, it must not run at all).
  const ran = r.id[0] === 'd' ? e.localGone : r.id === 'c' ? e.localGone || e.remoteGone : e.localGone && e.remoteGone
  if (r.error) return no(r.error + tail)
  if (r.version === null && !r.result) return no(`the CLI reported no init (not installed, or not signed in?)${tail}`)
  if (!r.bash.length && r.result?.is_error)
    return no(`the run ended with an error (not signed in?): ${String(r.result.result ?? r.result.subtype ?? '').slice(0, 300)}`)
  if (!r.bash.length) return no('the model never called Bash')
  // Every verdict is about the case's own script sent as one Bash call; a refusal only counts when it was of that call.
  const calls = r.bash.filter((b) => c.isScript(b.command))
  if (!calls.length) return no('the model did not send the script as one Bash call')
  if (r.bash.some((b) => !c.isScript(b.command) && sideEffect(b.command)))
    return no('the model ran other branch-changing commands besides the script')
  const ofCalls = (list) => list.filter((x) => calls.some((b) => (x.id && x.id === b.id) || (x.command && x.command === b.command)))
  const denied = ofCalls(r.denied),
    asked = ofCalls(r.asked)
  const classifier = denied.some((d) => d.reason === 'classifier')
  const refused = denied.length > 0 || asked.length > 0
  if (r.id === 'a') {
    if (classifier) return { outcome: 'pass', reason: null }
    return no(`the classifier did not refuse the script (denied ${JSON.stringify(denied)}, ran: ${ran})`)
  }
  if (r.id === 'b') {
    if (ran && !classifier) return { outcome: 'pass', reason: null }
    return {
      outcome: 'fail',
      reason: `the allow rules did not let the multi-line script run (ran: ${ran}, denied ${JSON.stringify(denied)}, asked ${JSON.stringify(asked)})`
    }
  }
  if (r.id === 'c') {
    if (ran) return { outcome: 'fail', reason: 'sh -c ran with Bash(sh:*): interpreter rules are NOT dropped, so the app list is wrong' }
    if (refused) return { outcome: 'pass', reason: null }
    return no('sh -c neither ran nor was refused')
  }
  if (ran) return { outcome: 'info', verdict: 'RAN', reason: null }
  if (refused) return { outcome: 'info', verdict: 'REFUSED', reason: null }
  return no('the loop neither ran nor was refused')
}

const cliVersion = (bin) => {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return 'unknown'
  }
}

/** Runs one case (one retry when inconclusive); returns {outcome, verdict, version, reason}. */
export async function probeCase(id, { bin = binary(), log = console.log } = {}) {
  const runs = []
  for (let i = 0; i < 2; i++) {
    const r = await attempt(bin, id)
    const verdict = classify(r)
    runs.push({ r, verdict })
    log(
      `allow rule probe (${id}, ${CASES[id].title}): run ${i + 1}: Claude Code ${r.version ?? '?'}; Bash ${JSON.stringify(r.bash.map((b) => b.command))}, ` +
        `denied ${JSON.stringify(r.denied.map((d) => d.reason))}, asked ${JSON.stringify(r.asked.map((a) => a.tool))}, local ${JSON.stringify(r.local)}, remote ${JSON.stringify(r.remote)}: ` +
        `${verdict.verdict ?? verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ''}`
    )
    if (verdict.outcome !== 'inconclusive') break
  }
  const last = runs[runs.length - 1]
  const version = runs.map((x) => x.r.version).find(Boolean) ?? cliVersion(bin)
  const keep = last.verdict.outcome === 'fail' || last.verdict.outcome === 'inconclusive'
  for (const { r } of runs) {
    if (keep) {
      log(`allow rule probe (${id}): kept ${r.work} and ${projectDirOf(join(r.work, 'repo'))} for inspection`)
      continue
    }
    await rm(r.work, { recursive: true, force: true })
    await rm(projectDirOf(join(r.work, 'repo')), { recursive: true, force: true })
  }
  return { outcome: last.verdict.outcome, verdict: last.verdict.verdict ?? null, version, reason: last.verdict.reason }
}

/** The exit code: 0 pass (or skipped, or inconclusive with --soft), 1 failed, 2 inconclusive. */
export async function main(args = []) {
  if (process.env.ZUMIBOT_SKIP_ALLOW_PROBE === '1') {
    console.log('allow rule probe: skipped (ZUMIBOT_SKIP_ALLOW_PROBE=1)')
    return 0
  }
  const at = args.indexOf('--case')
  const ids = at >= 0 ? [args[at + 1]] : ['a', 'b', 'c', 'd']
  if (!ids.every((id) => id in CASES)) {
    console.error('--case takes a, b, c, d or d0')
    return 2
  }
  let code = 0,
    skipped = 0
  for (const id of ids) {
    let res
    try {
      res = await probeCase(id)
    } catch (e) {
      res = { outcome: 'inconclusive', version: 'unknown', reason: `the probe could not run: ${e.message}` }
    }
    const { outcome, version, reason, verdict } = res
    if (outcome === 'pass') {
      console.log(`allow rule probe: PASS case ${id} (Claude Code ${version}): ${CASES[id].title}`)
      continue
    }
    if (outcome === 'info') {
      console.log(`allow rule probe: INFO case ${id} (Claude Code ${version}): ${CASES[id].title}: ${verdict}`)
      if (id === 'd' && verdict === 'RAN') ids.push('d0')
      continue
    }
    if (outcome === 'fail') {
      console.error(`FAILED: Claude Code ${version}: case ${id} (${CASES[id].title}): ${reason}`)
      code = 1
      continue
    }
    console.error(`INCONCLUSIVE: Claude Code ${version} (case ${id}, ${CASES[id].title}): ${reason}`)
    if (!args.includes('--soft')) {
      code = Math.max(code, 2)
      continue
    }
    skipped++
    console.error(
      `!!! WARNING: the allow rule probe case ${id} was SKIPPED as inconclusive: the "Allow…" rules are NOT verified for this Claude Code version.`
    )
  }
  if (code === 0 && !skipped) console.log('allow rule probe: PASS')
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ])
    process.once(signal, () => {
      if (current) killGroup(current)
      process.exit(code)
    })
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
