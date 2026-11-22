import { spawn, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DOCKER_BUNDLE, DOCKER_BUNDLE_DIR, DOCKER_IMAGE, bundleCompose } from '@zumibot/shared/dockerBundle'
import { dockerBundleSignedText, releaseSignedText } from '@zumibot/shared/update'

// docker/install.sh run for real, with a fake `docker` and `curl` on PATH and a signed bundle packed by the test
// itself. Every installer copy carries a test public key: the production script has no override on purpose.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const repo = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

// ENOENT is the only error that says the program is missing.
const has = (cmd: string): boolean => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error === undefined
// The installer is for a Linux or macOS Docker host: the harness builds a ':' PATH of fakes, which C:\ folders break.
const canRun =
  process.platform !== 'win32' &&
  has('sh') &&
  has('tar') &&
  (has('sha256sum') || has('shasum')) &&
  Number(process.versions.node.split('.')[0]) >= 22 &&
  process.getuid?.() !== 0
const test = it.skipIf(!canRun)

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const TEST_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const KEY_LINE = /^RELEASE_PUBLIC_KEY='[^']*'$/m
const installerSource = repo('docker/install.sh')
/** The repo's installer with the test key in place of the publisher's, plus optional lines after `set -eu`. */
function testInstaller(extra = ''): string {
  expect(installerSource).toMatch(KEY_LINE)
  const withKey = installerSource.replace(KEY_LINE, `RELEASE_PUBLIC_KEY='${TEST_KEY}'`)
  return extra ? withKey.replace(/^set -eu$/m, `set -eu\n${extra}`) : withKey
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const signText = (text: string, key: KeyObject = privateKey): string => sign(null, Buffer.from(text), key).toString('base64')
const fakeCurl = `#!/bin/sh
# https://site.test/<path> is $FAKE_SITE/<path>; a missing file is curl's 22.
out=
url=
while [ $# -gt 0 ]; do
  case $1 in
    --proto) shift 2 ;;
    -o) out=$2; shift 2 ;;
    --) url=$2; shift 2 ;;
    *) shift ;;
  esac
done
case $url in https://site.test/*) ;; *) exit 6 ;; esac
file=$FAKE_SITE/\${url#https://site.test/}
[ -f "$file" ] || exit 22
cp "$file" "$out"
`

interface Run {
  status: number | null
  stdout: string
  stderr: string
}
interface Pack {
  /** What the signature is for, when it is not the packed version. */
  signedVersion?: string
  /** What VERSION inside says, when it is not the packed version. */
  versionFile?: string
  /** What the signature covers, when it is not the bundle's own sha. */
  signedText?: (version: string, sha: string) => string
  /** A line the bundle's own installer copy runs right after `set -eu`. */
  extra?: string
  /** Whether releases/latest.json should name this version (default yes). */
  latest?: boolean
}

const scratches: string[] = []
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class Harness {
  readonly root = mkdtempSync(join(tmpdir(), 'zumibot-docker-install-test-'))
  readonly bin = join(this.root, 'bin')
  readonly site = join(this.root, 'site')
  readonly home = join(this.root, 'home')
  readonly tmp = join(this.root, 'tmp')
  readonly state = join(this.root, 'state')
  readonly log = join(this.root, 'docker.log')
  readonly dir = join(this.home, 'zumibot-docker')
  readonly script = join(this.root, 'install.sh')
  private readonly path: string

  constructor() {
    scratches.push(this.root)
    for (const d of [this.bin, join(this.site, 'releases'), this.home, this.tmp, this.state]) mkdirSync(d, { recursive: true })
    copyFileSync(join(FIXTURES, 'fake-docker.mjs'), join(this.bin, 'docker'))
    writeFileSync(join(this.bin, 'curl'), fakeCurl)
    for (const f of ['docker', 'curl']) chmodSync(join(this.bin, f), 0o755)
    writeFileSync(this.script, testInstaller())
    this.path = [this.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  }

  /** A signed bundle in the bundle layout, under releases/<version>/. Returns the archive's path. */
  pack(version: string, o: Pack = {}): string {
    const stage = join(this.root, `stage-${version}`)
    const top = join(stage, DOCKER_BUNDLE_DIR)
    mkdirSync(join(top, 'docker'), { recursive: true })
    const image = `${DOCKER_IMAGE}:${version}@sha256:${createHash('sha256').update(version).digest('hex')}`
    writeFileSync(join(top, 'docker-compose.yml'), bundleCompose(repo('docker-compose.yml'), image))
    for (const f of ['docker/Caddyfile', 'docker/Caddyfile.local', '.env.example']) writeFileSync(join(top, f), repo(f))
    writeFileSync(join(top, 'docker/install.sh'), testInstaller(o.extra))
    writeFileSync(join(top, 'VERSION'), o.versionFile ?? `${version}\n`)
    const folder = join(this.site, 'releases', version)
    mkdirSync(folder, { recursive: true })
    const archive = join(folder, DOCKER_BUNDLE)
    const tar = spawnSync('tar', ['-czf', archive, '-C', stage, DOCKER_BUNDLE_DIR], { encoding: 'utf8' })
    expect(tar.status, tar.stderr).toBe(0)
    const text = (o.signedText ?? dockerBundleSignedText)(o.signedVersion ?? version, sha256(archive))
    writeFileSync(`${archive}.sig`, `${signText(text)}\n`)
    if (o.latest !== false) this.latest(version)
    return archive
  }

  latest(version: string): void {
    writeFileSync(join(this.site, 'releases', 'latest.json'), JSON.stringify({ version }))
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: this.path,
      HOME: this.home,
      TMPDIR: this.tmp,
      ZUMIBOT_UPDATE_URL: 'https://site.test',
      ZUMIBOT_DOCKER_DIR: this.dir,
      FAKE_SITE: this.site,
      FAKE_DOCKER_LOG: this.log,
      FAKE_DOCKER_STATE: this.state,
      FAKE_DOCKER_DIR: this.dir,
      ...extra
    }
  }

  run(args: string[] = [], env: Record<string, string> = {}, path?: string): Run {
    const e = this.env(env)
    if (path) e.PATH = `${path}:${this.path}`
    const r = spawnSync('sh', [this.script, ...args], { env: e, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  /** Every docker call so far, in order. */
  calls(): Array<{ argv: string[]; cwd: string; pull?: { nextFolder: boolean; liveVersion: string | null } }> {
    if (!existsSync(this.log)) return []
    return readFileSync(this.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  read(rel: string): string {
    return readFileSync(join(this.dir, rel), 'utf8')
  }

  /** What the leftover scratch tmp holds: the installer must not leave its work folder. */
  tmpLeft(): string[] {
    return readdirSync(this.tmp)
  }
}

const isComposePull = (c: { argv: string[] }): boolean => c.argv[0] === 'compose' && c.argv.includes('pull')
const isUp = (c: { argv: string[] }): boolean => c.argv[0] === 'compose' && c.argv.includes('up')
/** A call that fetches or changes something: past the host checks (version, info), which every run makes. */
const isWork = (c: { argv: string[] }): boolean => c.argv[0] === 'run' || c.argv[0] === 'pull' || isComposePull(c) || isUp(c)

describe('docker/install.sh run against a fake docker and a signed bundle', () => {
  test('a first install with no --domain: loopback profile, private .env, pulls before it starts, never builds', () => {
    const h = new Harness()
    h.pack('1.0.0')
    const r = h.run()
    expect(r.status, r.stderr + r.stdout).toBe(0)
    const compose = h.read('docker-compose.yml')
    expect(compose).toContain(`${DOCKER_IMAGE}:1.0.0@sha256:${createHash('sha256').update('1.0.0').digest('hex')}`)
    const env = h.read('.env')
    expect(env).toMatch(/^COMPOSE_PROFILES=local$/m)
    expect(env).toMatch(/^ZUMIBOT_LOCAL_PUBLISH=127\.0\.0\.1:8443$/m)
    if (process.platform !== 'win32') expect(statSync(join(h.dir, '.env')).mode & 0o777).toBe(0o600)

    const calls = h.calls()
    const verify = calls.findIndex(
      (c) => c.argv[0] === 'run' && c.argv.includes('--network') && c.argv[c.argv.indexOf('--network') + 1] === 'none'
    )
    const pull = calls.findIndex(isComposePull)
    const up = calls.findIndex(isUp)
    expect(verify).toBeGreaterThanOrEqual(0)
    expect(verify).toBeLessThan(pull)
    expect(pull).toBeLessThan(up)
    expect(calls[up]!.argv).toEqual(expect.arrayContaining(['up', '-d', '--remove-orphans']))
    expect(calls.some((c) => c.argv.includes('--build'))).toBe(false)
    expect(r.stdout).toContain('docker compose logs zumibot-local')
    expect(r.stdout).not.toContain('To go back')
    expect(existsSync(`${h.dir}.prev`)).toBe(false)
    expect(h.tmpLeft()).toEqual([])
  })

  test('an update to a newer version keeps .env byte for byte, keeps the old tree and pulls from .next first', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run().status).toBe(0)
    writeFileSync(join(h.dir, '.env'), `${h.read('.env')}CUSTOM=kept\n`, { mode: 0o600 })
    const before = h.read('.env')
    h.pack('1.1.0')
    const r = h.run()
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(h.read('.env')).toBe(before)
    expect(h.read('VERSION')).toBe('1.1.0\n')
    expect(readFileSync(join(`${h.dir}.prev`, 'VERSION'), 'utf8')).toBe('1.0.0\n')
    const pull = h.calls().filter(isComposePull).at(-1)!.pull!
    expect(pull).toEqual({ nextFolder: true, liveVersion: '1.0.0\n' })
    expect(r.stdout).toContain(`mv ${h.dir} ${h.dir}.failed && mv ${h.dir}.prev ${h.dir}`)
  })

  test('refuses while replies run and leaves everything as it was; --force goes on', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run().status).toBe(0)
    h.pack('1.1.0')
    const before = h.calls().length
    const r = h.run([], { FAKE_BUSY: '2' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('2 reply/replies running')
    expect(h.read('VERSION')).toBe('1.0.0\n')
    expect(h.calls().slice(before).some(isUp)).toBe(false)
    expect(existsSync(`${h.dir}.next`)).toBe(false)
    expect(existsSync(`${h.dir}.prev`)).toBe(false)

    const forced = h.run(['--force'], { FAKE_BUSY: '2' })
    expect(forced.status, forced.stderr + forced.stdout).toBe(0)
    expect(h.read('VERSION')).toBe('1.1.0\n')
  })

  test('refuses when it cannot read the running-reply count', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run().status).toBe(0)
    h.pack('1.1.0')
    const r = h.run([], { FAKE_BUSY: 'x' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Could not read the running-reply count')
    expect(h.read('VERSION')).toBe('1.0.0\n')
    expect(existsSync(`${h.dir}.next`)).toBe(false)
  })

  test('refuses a signature over other bytes and one made for the server tarball label', () => {
    for (const bad of [{ signedText: (v: string) => dockerBundleSignedText(v, 'f'.repeat(64)) }, { signedText: releaseSignedText }]) {
      const h = new Harness()
      h.pack('9.9.9', bad)
      const r = h.run()
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('does not verify')
      expect(existsSync(h.dir)).toBe(false)
      expect(h.calls().some(isComposePull)).toBe(false)
      expect(h.tmpLeft()).toEqual([])
    }
  })

  test('refuses a bundle whose VERSION is not the one that was signed', () => {
    const h = new Harness()
    h.pack('9.9.9', { versionFile: '9.9.8\n' })
    const r = h.run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('says it is 9.9.8')
    expect(existsSync(h.dir)).toBe(false)
  })

  test("hands over to the bundle's own installer copy", () => {
    const h = new Harness()
    h.pack('1.0.0', { extra: "printf 'bundle installer ran\\n'" })
    const r = h.run()
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(r.stdout).toContain('bundle installer ran')
  })

  test('says so when the latest release has no Docker bundle on the site', () => {
    const h = new Harness()
    h.latest('9.9.9')
    const r = h.run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('has no Docker bundle')
    expect(existsSync(h.dir)).toBe(false)
  })

  test('running the installed version again repairs it: .env kept, a .prev left', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run().status).toBe(0)
    const env = h.read('.env')
    const again = h.run()
    expect(again.status, again.stderr + again.stdout).toBe(0)
    expect(h.read('.env')).toBe(env)
    expect(h.read('VERSION')).toBe('1.0.0\n')
    expect(readFileSync(join(`${h.dir}.prev`, 'VERSION'), 'utf8')).toBe('1.0.0\n')
  })

  test('updates a source-built install: .env kept, busy asked of the domain service, the old tree kept', () => {
    const h = new Harness()
    h.pack('1.0.0')
    mkdirSync(h.dir, { recursive: true })
    writeFileSync(join(h.dir, 'Dockerfile'), 'FROM scratch\n')
    writeFileSync(join(h.dir, 'docker-compose.yml'), 'services:\n  zumibot:\n    build:\n      context: .\n')
    const env = '# source install\nCOMPOSE_PROFILES=domain\nZUMIBOT_DOMAIN=z.example.com\n'
    writeFileSync(join(h.dir, '.env'), env)
    writeFileSync(join(h.state, 'running'), '')
    const r = h.run()
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(h.read('.env')).toBe(env)
    expect(existsSync(join(`${h.dir}.prev`, 'Dockerfile'))).toBe(true)
    const asked = h.calls().filter((c) => c.argv.includes('exec') && c.argv.includes('busy'))
    expect(asked.length).toBeGreaterThan(0)
    for (const c of asked) {
      expect(c.argv).toContain('zumibot')
      expect(c.argv).not.toContain('zumibot-local')
    }
    expect(
      h
        .calls()
        .filter((c) => c.argv.includes('ps'))
        .every((c) => c.argv.at(-1) === 'zumibot')
    ).toBe(true)
  })

  test('replaces a leftover .next from an interrupted run', () => {
    const h = new Harness()
    h.pack('1.0.0')
    mkdirSync(`${h.dir}.next`, { recursive: true })
    writeFileSync(join(`${h.dir}.next`, 'junk.txt'), 'old')
    const r = h.run()
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(existsSync(join(h.dir, 'junk.txt'))).toBe(false)
    expect(existsSync(`${h.dir}.next`)).toBe(false)
  })

  test('refuses --domain over an install that says something else', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run().status).toBe(0)
    const env = h.read('.env')
    const r = h.run(['--domain', 'other.example.com'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('already exists and says something else')
    expect(h.read('.env')).toBe(env)
  })

  const TS = 'https://mac.tail1234.ts.net:8443'
  const TS_CMD = 'tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443'

  test('a first install with --origin writes the origin, publishes on loopback and tells the Tailscale steps', () => {
    const h = new Harness()
    h.pack('1.0.0')
    const r = h.run(['--origin', 'HTTPS://Mac.Tail1234.TS.net:8443'])
    expect(r.status, r.stderr + r.stdout).toBe(0)
    const env = h.read('.env')
    expect(env).toMatch(/^COMPOSE_PROFILES=local$/m)
    expect(env).toMatch(/^ZUMIBOT_LOCAL_PUBLISH=127\.0\.0\.1:8443$/m)
    expect(env).toContain(`ZUMIBOT_LOCAL_ORIGIN=${TS}\n`)
    expect(r.stdout).toContain(TS_CMD)
    expect(r.stdout).toContain(`${TS}/setup`)
    expect(r.stdout).not.toContain('ssh -L')
  })

  test('the default first install keeps the ssh -L form and names --origin for Tailscale', () => {
    const h = new Harness()
    h.pack('1.0.0')
    const r = h.run()
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(h.read('.env')).toContain('ZUMIBOT_LOCAL_ORIGIN=https://localhost:8443\n')
    expect(r.stdout).toContain('ssh -L 8443:127.0.0.1:8443')
    expect(r.stdout).toContain('--origin https://<this-machine>.<tailnet>.ts.net:8443')
    expect(r.stdout).not.toContain(TS_CMD)
  })

  test.each([
    ['another port', ['--origin', 'https://mac.ts.net:9443'], '--origin must be https://HOST:8443'],
    ['http', ['--origin', 'http://mac.ts.net:8443'], '--origin must be https://HOST:8443'],
    ['no port', ['--origin', 'https://mac.ts.net'], '--origin must be https://HOST:8443'],
    ['a path', ['--origin', 'https://mac.ts.net:8443/setup'], '--origin must be https://HOST:8443'],
    ['a bad host', ['--origin', 'https://-mac..ts.net:8443'], '--origin must be https://HOST:8443'],
    ['--domain', ['--origin', 'https://mac.ts.net:8443', '--domain', 'z.example.com'], '--origin is for the loopback profile']
  ])('refuses --origin with %s before any download', (_name, args, message) => {
    const h = new Harness()
    h.pack('1.0.0')
    const r = h.run(args)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(message)
    expect(existsSync(h.dir)).toBe(false)
    expect(h.calls().filter(isWork)).toEqual([])
    expect(h.tmpLeft()).toEqual([])
  })

  test('--origin over an existing install: a different origin is refused, the same one goes on', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run(['--origin', TS]).status).toBe(0)
    const env = h.read('.env')
    const before = h.calls().filter(isWork).length
    const other = h.run(['--origin', 'https://other.tail1234.ts.net:8443'])
    expect(other.status).not.toBe(0)
    expect(other.stderr).toContain('already exists and says something else')
    expect(h.calls().filter(isWork).length).toBe(before)
    expect(h.read('.env')).toBe(env)

    const same = h.run(['--origin', TS])
    expect(same.status, same.stderr + same.stdout).toBe(0)
    expect(h.read('.env')).toBe(env)

    // An install on the default origin is not this one either.
    const h2 = new Harness()
    h2.pack('1.0.0')
    expect(h2.run().status).toBe(0)
    const r = h2.run(['--origin', TS])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('already exists and says something else')
    expect(h2.calls().filter(isComposePull)).toHaveLength(1)
  })

  test('a download older than the installed version is refused before anything is fetched', () => {
    const h = new Harness()
    h.pack('9.9.9')
    expect(h.run().status).toBe(0)
    const before = h.calls().filter(isWork).length
    h.pack('9.9.8')
    const snapshot = readFileSync(join(h.dir, '.env'), 'utf8')
    const r = h.run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('which is older')
    expect(r.stderr).toContain('.prev')
    expect(r.stderr).toContain('--bundle')
    expect(h.calls().filter(isWork).length).toBe(before)
    expect(h.read('VERSION')).toBe('9.9.9\n')
    expect(h.read('.env')).toBe(snapshot)
    expect(existsSync(`${h.dir}.prev`)).toBe(false)
    expect(h.tmpLeft()).toEqual([])
  })

  test('versions are compared per number, not as text', () => {
    const h = new Harness()
    h.pack('0.1.9')
    expect(h.run().status).toBe(0)
    h.pack('0.1.10')
    const up = h.run()
    expect(up.status, up.stderr + up.stdout).toBe(0)
    expect(h.read('VERSION')).toBe('0.1.10\n')
    h.pack('0.1.9')
    const down = h.run()
    expect(down.status).not.toBe(0)
    expect(down.stderr).toContain('which is older')
  })

  test('--version below the installed one is refused too; a source install without VERSION is not checked', () => {
    const h = new Harness()
    h.pack('2.0.0')
    expect(h.run().status).toBe(0)
    h.pack('1.0.0', { latest: false })
    const r = h.run(['--version', '1.0.0'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('which is older')

    const src = new Harness()
    src.pack('0.0.1')
    mkdirSync(src.dir, { recursive: true })
    writeFileSync(join(src.dir, '.env'), 'COMPOSE_PROFILES=domain\nZUMIBOT_DOMAIN=z.example.com\n')
    expect(src.run().status).toBe(0)
  })

  test('a --bundle older than the installed version installs: going back on purpose', () => {
    const h = new Harness()
    h.pack('9.9.9')
    expect(h.run().status).toBe(0)
    const archive = h.pack('9.9.8')
    const r = h.run(['--bundle', archive])
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(h.read('VERSION')).toBe('9.9.8\n')
    expect(readFileSync(join(`${h.dir}.prev`, 'VERSION'), 'utf8')).toBe('9.9.9\n')
  })

  test('on a Mac an unreachable daemon names Docker Desktop, OrbStack or Colima and never usermod; on Linux it still does', () => {
    const h = new Harness()
    h.pack('1.0.0')
    const shims = join(h.root, 'mac')
    mkdirSync(shims)
    writeFileSync(join(shims, 'uname'), `#!/bin/sh\necho Darwin\n`)
    chmodSync(join(shims, 'uname'), 0o755)
    const mac = h.run([], { FAKE_DOCKER_INFO_FAIL: '1' }, shims)
    expect(mac.status).not.toBe(0)
    expect(mac.stderr).toContain('Start Docker Desktop, OrbStack or Colima')
    expect(mac.stderr).not.toContain('usermod')

    // A uname shim here too, so the Linux half holds on a Mac host.
    const linuxShims = join(h.root, 'linux')
    mkdirSync(linuxShims)
    writeFileSync(join(linuxShims, 'uname'), `#!/bin/sh\necho Linux\n`)
    chmodSync(join(linuxShims, 'uname'), 0o755)
    const linux = h.run([], { FAKE_DOCKER_INFO_FAIL: '1' }, linuxShims)
    expect(linux.status).not.toBe(0)
    expect(linux.stderr).toContain('usermod')
    expect(linux.stderr).not.toContain('Colima')
    expect(existsSync(h.dir)).toBe(false)
  })

  test('refuses --version together with --bundle', () => {
    const h = new Harness()
    const archive = h.pack('1.0.0')
    const r = h.run(['--version', '1.0.0', '--bundle', archive])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('do not go together')
    expect(existsSync(h.dir)).toBe(false)
  })

  test('takes an https update address only', () => {
    const h = new Harness()
    h.pack('1.0.0')
    const r = h.run([], { ZUMIBOT_UPDATE_URL: 'http://site.test' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('ZUMIBOT_UPDATE_URL must be an https address')
    expect(h.calls()).toEqual([])
  })

  test('refuses a bundle whose VERSION is not x.y.z', () => {
    const h = new Harness()
    const archive = h.pack('1.0.0', { versionFile: '1.2\n' })
    const r = h.run(['--bundle', archive])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('a VERSION that is not a release')
    expect(existsSync(h.dir)).toBe(false)
    expect(h.tmpLeft()).toEqual([])
  })

  test('a failed pull removes .next and leaves the running install alone', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run().status).toBe(0)
    h.pack('1.1.0')
    const r = h.run([], { FAKE_COMPOSE_PULL_FAIL: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Could not pull the images, so nothing was changed')
    expect(existsSync(`${h.dir}.next`)).toBe(false)
    expect(h.read('VERSION')).toBe('1.0.0\n')
  })

  test('puts the old install back when the second move fails', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run().status).toBe(0)
    const env = h.read('.env')
    h.pack('1.1.0')
    // A mv that fails only for the staged folder, which is the second move of the swap.
    const shims = join(h.root, 'shims')
    mkdirSync(shims)
    const realMv = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(
      join(shims, 'mv'),
      `#!/bin/sh\ncase $1 in *.next) echo 'mv: simulated failure' >&2; exit 1 ;; esac\nexec ${realMv} "$@"\n`
    )
    chmodSync(join(shims, 'mv'), 0o755)
    const r = h.run([], {}, shims)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('the previous install was put back')
    expect(h.read('VERSION')).toBe('1.0.0\n')
    expect(h.read('.env')).toBe(env)
    expect(existsSync(`${h.dir}.prev`)).toBe(false)
    expect(existsSync(`${h.dir}.next`)).toBe(false)
  })

  test('says where the old install is when it cannot be put back either', () => {
    const h = new Harness()
    h.pack('1.0.0')
    expect(h.run().status).toBe(0)
    h.pack('1.1.0')
    // Both the staged move and the restore fail (their sources end in .next and .prev).
    const shims = join(h.root, 'shims')
    mkdirSync(shims)
    const realMv = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(
      join(shims, 'mv'),
      `#!/bin/sh\ncase $1 in *.next|*.prev) echo 'mv: simulated failure' >&2; exit 1 ;; esac\nexec ${realMv} "$@"\n`
    )
    chmodSync(join(shims, 'mv'), 0o755)
    const r = h.run([], {}, shims)
    expect(r.status).not.toBe(0)
    expect(r.stderr).not.toContain('the previous install was put back')
    expect(r.stderr).toContain(`it is at ${h.dir}.prev`)
  })

  test('exits non-zero and cleans up when it is terminated while waiting for the server', async () => {
    const h = new Harness()
    const archive = h.pack('1.0.0')
    // The server never answers, so the script sits in its one-second wait loop.
    const child = spawn('sh', [h.script, '--bundle', archive], {
      env: h.env({ FAKE_BUSY: 'fail' }),
      stdio: ['ignore', 'ignore', 'ignore']
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
      child.on('exit', (code, signal) => res({ code, signal }))
    )
    const deadline = Date.now() + 20_000
    while (!h.calls().some((c) => c.argv.includes('exec')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(h.calls().some((c) => c.argv.includes('exec'))).toBe(true)
    child.kill('SIGTERM')
    try {
      expect(await exited).toEqual({ code: 1, signal: null })
    } finally {
      child.kill('SIGKILL') // a script that ignored the signal must not outlive the test
    }
    expect(h.tmpLeft()).toEqual([])
  })
})
