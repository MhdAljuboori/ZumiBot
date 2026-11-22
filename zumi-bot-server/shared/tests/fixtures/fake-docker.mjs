#!/usr/bin/env node
// A stand-in for `docker` that dockerInstall.test.ts puts on PATH. It records every call and answers only what
// docker/install.sh asks; anything else is a test bug, so it exits 99 to make that loud.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const env = process.env
const entry = { argv, cwd: process.cwd() }
const done = (code) => {
  if (env.FAKE_DOCKER_LOG) appendFileSync(env.FAKE_DOCKER_LOG, `${JSON.stringify(entry)}\n`)
  process.exit(code)
}
const running = join(env.FAKE_DOCKER_STATE ?? '/nonexistent', 'running')

if (argv[0] === 'info') done(env.FAKE_DOCKER_INFO_FAIL === '1' ? 1 : 0)
if (argv[0] === 'pull') done(0)

if (argv[0] === 'run') {
  // docker run [flags] IMAGE node -e CODE: run the real node, with only the -e NAME=VALUE pairs as its env.
  const own = {}
  let i = 1
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-e') {
      const [name, ...value] = argv[++i].split('=')
      own[name] = value.join('=')
    } else if (a === '--network' || a === '--user') i++
    else if (a.startsWith('-')) continue
    else break
  }
  const rest = argv.slice(i + 1)
  if (rest[0] !== 'node' || rest[1] !== '-e') done(99)
  const r = spawnSync(process.execPath, ['-e', rest[2]], { env: { PATH: env.PATH, ...own }, stdio: 'ignore' })
  done(r.status ?? 1)
}

if (argv[0] === 'compose') {
  const args = argv.slice(1)
  if (args[0] === 'version') {
    if (args[1] === '--short') console.log('2.30.0')
    done(0)
  }
  let file = null
  while (args[0] === '-f') {
    file = args[1]
    args.splice(0, 2)
  }
  const [cmd, ...rest] = args
  if (cmd === 'pull') {
    // What the test checks: the pull runs against the staged copy, before the live folder is touched.
    const live = env.FAKE_DOCKER_DIR ? join(env.FAKE_DOCKER_DIR, 'VERSION') : null
    entry.pull = {
      nextFolder: file !== null && basename(dirname(file)).endsWith('.next'),
      liveVersion: live && existsSync(live) ? readFileSync(live, 'utf8') : null
    }
    done(env.FAKE_COMPOSE_PULL_FAIL === '1' ? 1 : 0)
  }
  if (cmd === 'ps' && rest[0] === '-q') {
    if (existsSync(running)) console.log('0123456789ab')
    done(0)
  }
  if (cmd === 'exec' && rest[rest.length - 1] === 'busy') {
    const busy = env.FAKE_BUSY ?? '0'
    if (busy === 'fail') done(1)
    console.log(busy === 'x' ? 'unknown' : busy)
    done(0)
  }
  if (cmd === 'up') {
    mkdirSync(dirname(running), { recursive: true })
    writeFileSync(running, '')
    done(0)
  }
}

console.error(`fake docker: unexpected call: ${argv.join(' ')}`)
done(99)
