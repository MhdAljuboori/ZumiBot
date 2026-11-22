import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthStore } from '../src/auth/authStore'
import { hashPassword, verifyPassword } from '../src/auth/password'
import { hashRecovery, normalizeRecovery } from '../src/auth/recovery'
import { otpauthUri, totpAt } from '../src/auth/totp'
import { armWatchdog, createLinePrompter, formatRecoveryCodes, qrText, runCli, scrubServerSecrets, type CliDeps } from '../src/cli'

let dir: string
let out: string[]
let err: string[]

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'cb-cli-')), 'data') // not created yet: the CLI must create it
  out = []
  err = []
})
afterEach(() => rm(join(dir, '..'), { recursive: true, force: true }))

function deps(answers: string[], over: Partial<CliDeps> = {}): CliDeps & { asked: { q: string; hidden: boolean }[] } {
  const asked: { q: string; hidden: boolean }[] = []
  return {
    env: { ZUMIBOT_DATA_DIR: dir },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    prompt: async (q, hidden) => {
      asked.push({ q, hidden })
      return answers.length ? answers.shift()! : null
    },
    now: () => Date.now(),
    asked,
    ...over
  }
}

const storedHash = async (): Promise<string> => JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).passwordHash

describe('set-password', () => {
  it('rejects 15 chars with "Use at least 16 characters."', async () => {
    const code = await runCli(['set-password'], deps(['a'.repeat(15), 'a'.repeat(15)]))
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('Use at least 16 characters.')
    await expect(stat(join(dir, 'auth.json'))).rejects.toThrow()
  })

  it('stores a hash that verifyPassword accepts', async () => {
    const pw = 'correct horse battery staple'
    const d = deps([pw, pw])
    expect(await runCli(['set-password'], d)).toBe(0)
    expect(d.asked.every((a) => a.hidden)).toBe(true)
    expect(d.asked).toHaveLength(2)
    const hash = await storedHash()
    expect(hash).not.toContain(pw)
    expect(await verifyPassword(pw, hash)).toBe(true)
    expect(await verifyPassword(pw + 'x', hash)).toBe(false)
    expect(out.join('\n')).not.toContain(pw)
  })

  it('accepts exactly 16 chars', async () => {
    const pw = 'x'.repeat(16)
    expect(await runCli(['set-password'], deps([pw, pw]))).toBe(0)
  })

  it('refuses when the two entries differ', async () => {
    expect(await runCli(['set-password'], deps(['a'.repeat(20), 'b'.repeat(20)]))).toBe(1)
    expect(err.join('\n')).toContain('do not match')
    await expect(stat(join(dir, 'auth.json'))).rejects.toThrow()
  })

  it('aborts when input ends before a password is given', async () => {
    expect(await runCli(['set-password'], deps([]))).toBe(1)
  })

  it('--generate output is 24 chars and is accepted', async () => {
    const d = deps([])
    expect(await runCli(['set-password', '--generate'], d)).toBe(0)
    expect(d.asked).toHaveLength(0)
    const pw = out.find((l) => /^[A-Za-z0-9_-]{24}$/.test(l))
    expect(pw).toBeDefined()
    expect(await verifyPassword(pw!, await storedHash())).toBe(true)
  })

  it('creates the data dir with mode 700 and auth.json 600', async () => {
    await runCli(['set-password', '--generate'], deps([]))
    if (process.platform !== 'win32') expect((await stat(dir)).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') expect((await stat(join(dir, 'auth.json'))).mode & 0o777).toBe(0o600)
  })

  it('tightens an existing looser data dir to 700', async () => {
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o755)
    await runCli(['set-password', '--generate'], deps([]))
    if (process.platform !== 'win32') expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it('signs out existing sessions', async () => {
    const auth = new AuthStore(dir, Date.now)
    await runCli(['set-password', '--generate'], deps([]))
    const token = await auth.createSession()
    await runCli(['set-password', '--generate'], deps([]))
    expect(await auth.checkSession(token)).toBe(false)
  })
})

describe('setup-2fa', () => {
  async function run(extra: Partial<CliDeps> = {}) {
    const auth = new AuthStore(dir, Date.now)
    // first read the secret from the printed otpauth URI, then answer with a valid code
    const d = deps([], {
      prompt: async () => {
        const uri = out.find((l) => l.startsWith('otpauth://'))!
        const secret = new URL(uri).searchParams.get('secret')!
        return totpAt(secret, Date.now())
      },
      ...extra
    })
    return { code: await runCli(['setup-2fa'], d), auth }
  }

  it('prints the QR, the URI and 10 recovery codes once, then saves them hashed', async () => {
    const { code, auth } = await run()
    expect(code).toBe(0)
    const text = out.join('\n')
    const uri = out.find((l) => l.startsWith('otpauth://'))!
    expect(uri).toContain('issuer=ZumiBot')
    expect(text).toContain('Store these somewhere safe. Each works once.')
    const codes = out.filter((l) => /^\s*[A-Z2-7]{5}-[A-Z2-7]{5}\s*$/.test(l)).map((l) => l.trim())
    expect(codes).toHaveLength(10)
    const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
    expect(saved.totp.recoveryHashes).toEqual(codes.map((c) => hashRecovery(normalizeRecovery(c))))
    expect(JSON.stringify(saved)).not.toContain(codes[0])
    expect((await auth.configured()).totp).toBe(true)
  })

  it('the confirmation code cannot be used to log in straight afterwards', async () => {
    await mkdir(dir, { recursive: true })
    await new AuthStore(dir, Date.now).setPassword(await hashPassword('correct horse battery staple'))
    let code = ''
    const { code: rc, auth } = await run({
      prompt: async () => {
        const secret = new URL(out.find((l) => l.startsWith('otpauth://'))!).searchParams.get('secret')!
        code = totpAt(secret, Date.now())
        return code
      }
    })
    expect(rc).toBe(0)
    expect(await auth.checkLogin('correct horse battery staple', code)).toBe(false)
  })

  it('loops until the code is right', async () => {
    let n = 0
    const { code } = await run({
      prompt: async () => {
        if (++n < 3) return '000000'
        const secret = new URL(out.find((l) => l.startsWith('otpauth://'))!).searchParams.get('secret')!
        return totpAt(secret, Date.now())
      }
    })
    expect(code).toBe(0)
    expect(n).toBe(3)
  })

  it('saves nothing and fails when input ends before a valid code', async () => {
    const { code } = await run({ prompt: async () => null })
    expect(code).toBe(1)
    await expect(stat(join(dir, 'auth.json'))).rejects.toThrow()
    expect(out.join('\n')).not.toContain('Store these')
  })
})

describe('pure helpers', () => {
  it('qrText renders the URI as terminal blocks', async () => {
    const text = await qrText(otpauthUri('JBSWY3DPEHPK3PXP'))
    expect(text.split('\n').length).toBeGreaterThan(8)
    expect(text).toMatch(/[▀▄█]/)
  })

  it('formatRecoveryCodes lists every code under the warning', () => {
    const lines = formatRecoveryCodes(['AAAAA-BBBBB', 'CCCCC-DDDDD'])
    expect(lines[0]).toBe('Store these somewhere safe. Each works once.')
    expect(lines).toContain('  AAAAA-BBBBB')
    expect(lines).toContain('  CCCCC-DDDDD')
  })
})

describe('cli misc', () => {
  it('unknown command prints usage and fails', async () => {
    expect(await runCli(['nope'], deps([]))).toBe(1)
    expect(err.join('\n')).toContain('Usage')
  })

  it('a line prompter reads answers from piped stdin', async () => {
    const input = new PassThrough()
    const written: string[] = []
    const output = new PassThrough()
    output.on('data', (b) => written.push(String(b)))
    const prompt = createLinePrompter(input, output)
    input.write('first\nsecond\n')
    input.end()
    expect(await prompt('A: ', true)).toBe('first')
    expect(await prompt('B: ', true)).toBe('second')
    expect(await prompt('C: ', true)).toBeNull()
  })
})

describe('armWatchdog', () => {
  it('releases the lock synchronously, then exits 1', async () => {
    const order: string[] = []
    armWatchdog({ releaseLock: () => order.push('release') }, 5, (code) => order.push(`exit ${code}`))
    await new Promise((r) => setTimeout(r, 40))
    expect(order).toEqual(['release', 'exit 1'])
  })
})

describe('scrubServerSecrets', () => {
  it('removes the local secret and ELECTRON_RUN_AS_NODE, keeps the rest', () => {
    const env: NodeJS.ProcessEnv = { ZUMIBOT_LOCAL_SECRET: 's'.repeat(64), ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }
    scrubServerSecrets(env)
    expect(env).toEqual({ PATH: '/bin' })
  })
})

describe('browser CLI routing', () => {
  it('offers setup commands in help without starting the app or prompting for auth', async () => {
    const d = deps([])
    expect(await runCli(['--help'], d)).toBe(0)
    expect(out.join('\n')).toContain('browser-check')
    expect(out.join('\n')).toContain('browser-install')
    expect(d.asked).toHaveLength(0)
    await expect(stat(dir)).rejects.toThrow()
  })
  it('rejects unknown setup options before any download or launch', async () => {
    expect(await runCli(['browser-install', '--with-deps'], deps([]))).toBe(1)
    expect(err.join('\n')).toContain('Usage')
    await expect(stat(dir)).rejects.toThrow()
  })
})

// Computer use is Linux-only in the app, and these fakes are sh or shebang scripts Windows cannot spawn.
const winDesktop = process.platform === 'win32'

describe('desktop-check', () => {
  const fixture = (name: string): string => join(__dirname, 'fixtures', name)
  // The fakes' `env node` shebang needs node on PATH; a folder holding only node keeps the real /usr/bin out of the lookup.
  let nodeOnly: string
  beforeEach(async () => {
    nodeOnly = await mkdtemp(join(tmpdir(), 'cb-node-'))
    if (!winDesktop) await symlink(process.execPath, join(nodeOnly, 'node'))
  })
  afterEach(() => rm(nodeOnly, { recursive: true, force: true }))
  it('exits 1 and lists the four missing programs with an empty PATH and no overrides', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cb-dcheck-'))
    try {
      const d = deps([], { env: { ZUMIBOT_DATA_DIR: dir, PATH: '', HOME: home } })
      expect(await runCli(['desktop-check'], d)).toBe(1)
      expect(out).toEqual([
        'missing TigerVNC (Xvnc)',
        'missing D-Bus (dbus-daemon)',
        'missing desktop session (xfwm4)',
        'missing cua-driver'
      ])
      await expect(stat(dir)).rejects.toThrow() // nothing is created or installed
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it.skipIf(winDesktop)('exits 0 with the fakes and prints the cua-driver version', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'cb-dcheck-'))
    try {
      const session = join(bin, 'session')
      await writeFile(session, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const env = {
        ZUMIBOT_DATA_DIR: dir,
        PATH: nodeOnly,
        HOME: bin,
        ZUMIBOT_DESKTOP_XVNC: fixture('fake-xvnc.mjs'),
        ZUMIBOT_DESKTOP_DBUS_DAEMON: fixture('fake-dbus-daemon.mjs'),
        ZUMIBOT_DESKTOP_SESSION: session,
        ZUMIBOT_CUA_DRIVER: fixture('fake-cua-driver.mjs')
      }
      expect(await runCli(['desktop-check'], deps([], { env }))).toBe(0)
      expect(out).toEqual([
        `found ${fixture('fake-xvnc.mjs')}`,
        `found ${fixture('fake-dbus-daemon.mjs')}`,
        `found ${session}`,
        `found ${fixture('fake-cua-driver.mjs')}`,
        'cua-driver 0.38.0-fake'
      ])
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
  it.skipIf(winDesktop)('reports only what is missing as missing and still exits 1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cb-dcheck-'))
    try {
      const env = {
        PATH: nodeOnly,
        HOME: home,
        ZUMIBOT_DESKTOP_XVNC: fixture('fake-xvnc.mjs'),
        ZUMIBOT_CUA_DRIVER: fixture('fake-cua-driver.mjs')
      }
      expect(await runCli(['desktop-check'], deps([], { env }))).toBe(1)
      expect(out).toEqual([
        `found ${fixture('fake-xvnc.mjs')}`,
        'missing D-Bus (dbus-daemon)',
        'missing desktop session (xfwm4)',
        `found ${fixture('fake-cua-driver.mjs')}`,
        'cua-driver 0.38.0-fake'
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it.skipIf(winDesktop)('prints no version token when cua-driver --version fails, and no raw output', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'cb-dcheck-'))
    try {
      const cua = join(bin, 'cua-driver')
      await writeFile(cua, '#!/bin/sh\necho "secret-token-xyz"\nexit 3\n', { mode: 0o755 })
      await runCli(['desktop-check'], deps([], { env: { PATH: '', HOME: bin, ZUMIBOT_CUA_DRIVER: cua } }))
      expect(out).toContain('cua-driver version unknown')
      expect(out.join('\n')).not.toContain('secret-token')
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
  it.skipIf(winDesktop)('gives cua-driver only PATH, HOME, LANG and its telemetry-off block, never the server env', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'cb-dcheck-'))
    try {
      const cua = join(bin, 'cua-driver'),
        dump = join(bin, 'env.txt')
      await writeFile(cua, `#!/bin/sh\nenv > '${dump}'\necho "cua-driver 1.2.3"\n`, { mode: 0o755 })
      const env = {
        PATH: '/usr/bin:/bin',
        HOME: bin,
        LANG: 'C.UTF-8',
        ZUMIBOT_LOCAL_SECRET: 'x'.repeat(40),
        ANTHROPIC_API_KEY: 'sk-secret',
        ZUMIBOT_CUA_DRIVER: cua
      }
      await runCli(['desktop-check'], deps([], { env }))
      expect(out).toContain('cua-driver 1.2.3')
      const seen = Object.fromEntries(
        (await readFile(dump, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
      )
      expect(seen.DO_NOT_TRACK).toBe('1')
      expect(seen.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe('0')
      expect(seen.HOME).toBe(bin)
      expect(Object.keys(seen)).not.toContain('ZUMIBOT_LOCAL_SECRET')
      expect(Object.keys(seen)).not.toContain('ANTHROPIC_API_KEY')
      expect(
        Object.keys(seen).filter(
          (k) => !['PATH', 'HOME', 'LANG', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(k) && !k.startsWith('CUA_') && k !== 'DO_NOT_TRACK'
        )
      ).toEqual([])
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
  it.skipIf(winDesktop)('does not hang on a cua-driver that ignores SIGTERM and holds its pipe, and leaves nothing running', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'cb-dcheck-'))
    try {
      const cua = join(bin, 'cua-driver'),
        pids = join(bin, 'pids')
      await writeFile(cua, `#!/bin/sh\ntrap '' TERM\necho $$ > '${pids}'\nsleep 30 &\necho $! >> '${pids}'\nwait\n`, { mode: 0o755 })
      const started = Date.now()
      await runCli(['desktop-check'], deps([], { env: { PATH: '/usr/bin:/bin', HOME: bin, ZUMIBOT_CUA_DRIVER: cua }, cuaVersionMs: 300 }))
      expect(Date.now() - started).toBeLessThan(3000)
      expect(out).toContain('cua-driver version unknown')
      for (const pid of (await readFile(pids, 'utf8')).split('\n').filter(Boolean).map(Number)) {
        await new Promise((r) => setTimeout(r, 100))
        expect(() => process.kill(pid, 0)).toThrow()
      }
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
  it('is offered in help and rejects extra arguments', async () => {
    await runCli(['--help'], deps([]))
    expect(out.join('\n')).toContain('desktop-check')
    expect(await runCli(['desktop-check', '--install'], deps([]))).toBe(1)
    expect(err.join('\n')).toContain('Usage')
  })
})
