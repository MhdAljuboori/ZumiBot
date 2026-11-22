// Fake gh CLI for tests: no network, no credentials, no real remote. Behaviour is driven by env vars, like fake-claude.
//
//   FAKE_GH_AUTH=out            `gh auth status` exits 1 ("not logged in"); anything else exits 0
//   FAKE_GH_PR=<json>           what `gh pr view` prints (one PR object)
//   FAKE_GH_PR_FAIL=<line>      `gh pr view` instead fails with this line on stderr
//   FAKE_GH_CREATE_FAIL=<line>  `gh pr create` fails with this line on stderr
//   FAKE_GH_LOG=<text>          what `gh run view --log-failed` prints; empty makes it print nothing
//   FAKE_GH_DEFAULT=<branch>    what `gh repo view --json defaultBranchRef` reports
//   FAKE_GH_CALLS=<file>        every call is appended as a JSON line {args, cwd}
//   FAKE_GH_STATE=<file>        a JSON file read on every call, whose keys override the env vars above (without the
//                               FAKE_GH_ prefix: auth, pr, prFail, createFail, log, default). An e2e writes it to
//                               change what gh answers while the server keeps running.
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const state = (() => {
  if (!process.env.FAKE_GH_STATE) return {}
  try {
    return JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
  } catch {
    return {}
  }
})()
const at = (key, env) => (state[key] !== undefined ? state[key] : process.env[env])
if (process.env.FAKE_GH_CALLS) appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\n')

const out = (text) => process.stdout.write(text.endsWith('\n') ? text : text + '\n')
const fail = (line) => {
  process.stderr.write(line + '\n')
  process.exit(1)
}

const is = (...want) => want.every((w, i) => args[i] === w)

if (is('auth', 'status')) {
  if (at('auth', 'FAKE_GH_AUTH') === 'out') fail('You are not logged into any GitHub hosts. To log in, run: gh auth login')
  out('github.com\n  ✓ Logged in to github.com account tester')
} else if (is('repo', 'view')) {
  out(JSON.stringify({ defaultBranchRef: { name: at('default', 'FAKE_GH_DEFAULT') ?? 'main' } }))
} else if (is('pr', 'create')) {
  const why = at('createFail', 'FAKE_GH_CREATE_FAIL')
  if (why) fail(why)
  out('https://github.com/acme/app/pull/7')
} else if (is('pr', 'view')) {
  const bad = at('prFail', 'FAKE_GH_PR_FAIL')
  if (bad) fail(bad)
  const pr = at('pr', 'FAKE_GH_PR')
  out(typeof pr === 'object' ? JSON.stringify(pr) : pr ?? JSON.stringify({ number: 7, url: 'https://github.com/acme/app/pull/7', state: 'OPEN', isDraft: false, statusCheckRollup: [] }))
} else if (is('run', 'view')) {
  out(at('log', 'FAKE_GH_LOG') ?? '')
} else {
  fail(`unknown gh command: ${args.join(' ')}`)
}
