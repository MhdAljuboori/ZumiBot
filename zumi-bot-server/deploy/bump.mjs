import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addSection } from './changelog.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Only a level or a plain X.Y.Z reaches npm, so no option or shell text can ride along. */
export function bumpArg(arg) {
  if (typeof arg === 'string' && /^(?:patch|minor|major|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.test(arg)) return arg
  throw new Error('usage: bump.mjs <patch|minor|major|X.Y.Z>')
}

// Windows has no `npm` executable, only `npm.cmd`, which cannot be spawned without a shell. Under `npm run` npm names its
// own script in npm_execpath, so it runs through this same node on every platform.
function npmCommand(args) {
  const cli = process.env.npm_execpath
  return cli && /\.c?js$/.test(cli) ? [process.execPath, [cli, ...args]] : ['npm', args]
}

function run(cmd, args) {
  if (cmd === 'npm') [cmd, args] = npmCommand(args)
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status === null ? `signal ${r.signal}` : `exit ${r.status}`})`)
}

function bump(arg) {
  const level = bumpArg(arg)
  run('npm', ['version', level, '--workspaces', '--no-git-tag-version', '--no-workspaces-update'])
  run('npm', ['run', 'bump:lock'])
  const version = JSON.parse(readFileSync(join(repoRoot, 'zumi-bot-server', 'backend', 'package.json'), 'utf8')).version
  const file = join(repoRoot, 'CHANGELOG.md')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '# Changelog\n'
  writeFileSync(file, addSection(text, version, new Date().toISOString().slice(0, 10)))
  console.log(`Fill in CHANGELOG.md for v${version}`)
}

function isEntry() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  } catch {
    return false // e.g. `node -`: argv[1] is not a file
  }
}
if (isEntry()) {
  try {
    bump(process.argv[2])
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}
