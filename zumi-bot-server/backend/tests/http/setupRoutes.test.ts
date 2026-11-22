import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { AuthStore } from '../../src/auth/authStore'
import { newRecoveryCodes } from '../../src/auth/recovery'
import { normalizeSetupCode } from '../../src/auth/setupCode'
import { newTotpSecret, totpAt } from '../../src/auth/totp'
import { controlPath, queryBusy } from '../../src/control'
import { startSetupServer } from '../../src/setupServer'
import { SETUP_ORIGIN, SEEDED_PASSWORD, setupTestConfig, startSetupRig, type SetupRig } from './helpers'

const PASSWORD = 'correct horse battery staple'

let rig: SetupRig | null = null
afterEach(async () => {
  await rig?.close()
  rig = null
})

/** A setup server of its own for one case, always closed. */
async function withRig(fn: (r: SetupRig) => Promise<void>): Promise<void> {
  const r = await startSetupRig()
  try {
    await fn(r)
  } finally {
    await r.close()
  }
}

/** Walks the wizard to the TOTP step and returns the secret it was handed. */
async function toTotp(r: SetupRig): Promise<string> {
  const set = await r.post('/api/setup/password', { password: PASSWORD })
  expect(set.status).toBe(200)
  const start = await r.post('/api/setup/totp/start')
  expect(start.status).toBe(200)
  return (await start.json()).secret as string
}

describe('setup server: what it says at start', () => {
  it('prints LISTENING, the setup URL and a one-time code', async () => {
    rig = await startSetupRig()
    expect(rig.lines[0]).toBe(`LISTENING ${rig.port}`)
    expect(rig.lines.join('\n')).toContain(`Open ${SETUP_ORIGIN}/setup`)
    expect(rig.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/)
    expect(rig.lines.join('\n')).toContain('only in this server')
  })

  it('writes the code nowhere: only its hash is kept, in memory', async () => {
    rig = await startSetupRig()
    const bare = normalizeSetupCode(rig.code)
    // The only file a fresh data folder has is the lock; auth.json appears once a password is set.
    await rig.post('/api/setup/password', { password: PASSWORD })
    const auth = await readFile(join(rig.dataDir, 'auth.json'), 'utf8')
    expect(auth).not.toContain(bare)
    expect(auth).not.toContain(rig.code)
    expect(auth).not.toContain(PASSWORD)
  })

  it('answers nothing on 127.0.0.1 alone', async () => {
    rig = await startSetupRig()
    // listen() was given 127.0.0.1, so the loopback address is the only one bound.
    expect(rig.base).toContain('127.0.0.1')
    const res = await rig.get('/setup')
    expect(res.status).toBe(200)
  })

  it('answers the control socket with 0, so a first deploy sees the service up', async () => {
    rig = await startSetupRig()
    expect(await queryBusy(controlPath(rig.dataDir))).toBe(0)
    await rig.close()
    const closed = rig.dataDir
    rig = null
    // Closed with the server, so the app's own control socket takes the path.
    await expect(queryBusy(controlPath(closed), 500)).rejects.toThrow()
  })

  it('returns null when the server is already set up, so the app starts instead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-setup-done-'))
    try {
      const auth = new AuthStore(dir, Date.now)
      await auth.setPassword('whatever-is-stored-here')
      await auth.setTotp(newTotpSecret(), newRecoveryCodes().hashes)
      expect(await startSetupServer(setupTestConfig(dir), { out: () => {} })).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves no lock behind when it cannot bind the port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-setup-busy-'))
    const taken = createServer()
    try {
      await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r))
      const port = (taken.address() as AddressInfo).port
      await expect(startSetupServer(setupTestConfig(dir, port), { out: () => {} })).rejects.toThrow()
      // The lock went with it, so the operator can free the port and start again.
      taken.close()
      await new Promise<void>((r) => taken.close(() => r()))
      const second = await startSetupServer(setupTestConfig(dir, port), { out: () => {} })
      expect(second).not.toBeNull()
      await second!.close()
    } finally {
      taken.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a second setup server on the same data folder', async () => {
    rig = await startSetupRig()
    await expect(startSetupServer(setupTestConfig(rig.dataDir), { out: () => {} })).rejects.toThrow(/Another ZumiBot server/)
  })
})

describe('setup server: nothing but the wizard', () => {
  it('serves the wizard and its files', async () => {
    rig = await startSetupRig()
    const page = await rig.get('/setup')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('Set up ZumiBot')
    for (const [path, type] of [
      ['/setup.js', 'javascript'],
      ['/setup.css', 'css'],
      ['/login.css', 'css'],
      ['/favicon.png', 'image/png']
    ] as const) {
      const res = await rig.get(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type'), path).toContain(type)
    }
  })

  it('sends every other page to the wizard', async () => {
    rig = await startSetupRig()
    for (const path of ['/', '/login', '/chat/abc', '/api/attachments/stage', '/index.html']) {
      const res = await rig.get(path)
      expect(res.status, path).toBe(302)
      expect(res.headers.get('location'), path).toBe('/setup')
    }
  })

  it('404s every write that is not a setup call', async () => {
    rig = await startSetupRig()
    for (const path of ['/api/login', '/api/logout', '/hooks/abc', '/api/setup', '/api/setup/other']) {
      const res = await rig.post(path)
      expect(res.status, path).toBe(404)
    }
  })

  it('applies the security headers to the page and to a refusal', async () => {
    rig = await startSetupRig()
    for (const res of [await rig.get('/setup'), await rig.post('/api/setup/password', {}, { code: 'nope' })]) {
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
  })

  it('refuses a WebSocket: there is no hub to attach to', async () => {
    rig = await startSetupRig()
    const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/ws`, { origin: SETUP_ORIGIN })
    await expect(
      new Promise((resolve, reject) => {
        ws.on('open', () => resolve('opened'))
        ws.on('error', reject)
      })
    ).rejects.toThrow()
  })

  it('tells the page where to resume without asking for the code', async () => {
    rig = await startSetupRig()
    expect(await (await rig.get('/api/setup/state')).json()).toEqual({ step: 'password' })
    await rig.post('/api/setup/password', { password: PASSWORD })
    expect(await (await rig.get('/api/setup/state')).json()).toEqual({ step: 'totp' })
  })

  it('resumes at the TOTP step when a password was set by the CLI', async () => {
    rig = await startSetupRig({ configure: 'password' })
    expect(await (await rig.get('/api/setup/state')).json()).toEqual({ step: 'totp' })
    // And the CLI's password is never replaced from here.
    expect((await rig.post('/api/setup/password', { password: PASSWORD })).status).toBe(409)
    const secret = (await (await rig.post('/api/setup/totp/start')).json()).secret as string
    await rig.post('/api/setup/totp/confirm', { totp: totpAt(secret, Date.now()) })
    expect(await rig.auth.checkLogin(SEEDED_PASSWORD, totpAt(secret, Date.now() + 30_000))).toBe(true)
  })
})

describe('setup server: the one-time code', () => {
  // A fresh server per case: three wrong codes from one IP is already enough to be throttled, which is the point
  // of the rate-limit test below.
  it('refuses every call without the right code, and never echoes it', async () => {
    for (const path of [
      '/api/setup/password',
      '/api/setup/totp/start',
      '/api/setup/totp/confirm',
      '/api/setup/check',
      '/api/setup/finish'
    ]) {
      await withRig(async (r) => {
        const res = await r.post(path, { password: PASSWORD, totp: '000000' }, { code: 'AAAA-AAAA-AAAA-AAAA' })
        expect(res.status, path).toBe(401)
        const text = await res.text()
        expect(text).toContain('That setup code is not right.')
        expect(text, path).not.toContain(normalizeSetupCode(r.code))
        expect((await r.auth.configured()).password, path).toBe(false)
      })
    }
  })

  it('refuses a missing, non-string or oversized code', async () => {
    for (const body of ['{}', '{"code":123}', `{"code":"${'A'.repeat(2000)}"}`, 'not json']) {
      await withRig(async (r) => {
        const res = await fetch(`${r.base}/api/setup/password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: SETUP_ORIGIN },
          body
        })
        expect(res.status, body.slice(0, 20)).toBe(401)
      })
    }
  })

  it('rate-limits wrong codes like sign-in, with Retry-After', async () => {
    rig = await startSetupRig()
    let last = await rig.post('/api/setup/check', {}, { code: 'AAAA-AAAA-AAAA-AAAA' })
    for (let i = 0; i < 12 && last.status !== 429; i++) {
      last = await rig.post('/api/setup/check', {}, { code: 'AAAA-AAAA-AAAA-AAAA' })
    }
    expect(last.status).toBe(429)
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await last.json()).error).toMatch(/Too many tries/)
  })

  it('checks our own Origin on every call', async () => {
    rig = await startSetupRig()
    for (const origin of [null, 'https://evil.example', 'http://zumibot.test']) {
      const res = await rig.post('/api/setup/password', { password: PASSWORD }, { origin })
      expect(res.status, String(origin)).toBe(403)
    }
    expect((await rig.auth.configured()).password).toBe(false)
  })
})

describe('setup server: the steps', () => {
  it('applies the same password rule as the CLI', async () => {
    rig = await startSetupRig()
    const short = await rig.post('/api/setup/password', { password: 'short' })
    expect(short.status).toBe(400)
    expect((await short.json()).error).toBe('Use at least 16 characters.')
    expect((await (await rig.post('/api/setup/password', { password: '' })).json()).error).toBe('Enter a password.')
    expect((await rig.auth.configured()).password).toBe(false)
  })

  it('hands out a QR code and the secret, then takes a confirmation code', async () => {
    rig = await startSetupRig()
    const secret = await toTotp(rig)
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    const start = await (await rig.post('/api/setup/totp/start')).json()
    expect(start.otpauth).toContain('otpauth://totp/ZumiBot')
    expect(start.qr).toMatch(/^data:image\/png;base64,/)
    // A reload hands out a new secret, and the old one was never stored.
    expect(start.secret).not.toBe(secret)

    const wrong = await rig.post('/api/setup/totp/confirm', { totp: '000000' })
    expect(wrong.status).toBe(400)
    expect((await wrong.json()).error).toMatch(/not valid/)
    expect((await rig.auth.configured()).totp).toBe(false)

    const ok = await rig.post('/api/setup/totp/confirm', { totp: totpAt(start.secret as string, Date.now()) })
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.step).toBe('done')
    expect(body.recoveryCodes).toHaveLength(10)
  })

  it('leaves a sign-in that works, with the password and codes it handed out', async () => {
    rig = await startSetupRig()
    const secret = await toTotp(rig)
    const body = await (await rig.post('/api/setup/totp/confirm', { totp: totpAt(secret, Date.now()) })).json()
    expect(await rig.auth.checkLogin(PASSWORD, totpAt(secret, Date.now() + 30_000))).toBe(true)
    expect(await rig.auth.checkLogin(PASSWORD, (body.recoveryCodes as string[])[0]!)).toBe(true)
    expect(await rig.auth.checkLogin('the wrong password entirely', totpAt(secret, Date.now() + 60_000))).toBe(false)
  })

  it('refuses a confirmation when no secret is pending', async () => {
    rig = await startSetupRig({ configure: 'password' })
    const res = await rig.post('/api/setup/totp/confirm', { totp: '000000' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/no pending authenticator secret/)
  })

  it('refuses a step that is already done', async () => {
    rig = await startSetupRig()
    const secret = await toTotp(rig)
    // The password is set: it is never replaced from here, even with the right code.
    expect((await rig.post('/api/setup/password', { password: 'another long password' })).status).toBe(409)
    await rig.post('/api/setup/totp/confirm', { totp: totpAt(secret, Date.now()) })
    // And neither is the TOTP secret.
    for (const path of ['/api/setup/password', '/api/setup/totp/start', '/api/setup/totp/confirm']) {
      expect((await rig.post(path, { password: PASSWORD, totp: '000000' })).status, path).toBe(409)
    }
  })

  it('refuses finish until both are set, so the code cannot strand the server', async () => {
    rig = await startSetupRig()
    expect((await rig.post('/api/setup/finish')).status).toBe(409)
    const secret = await toTotp(rig)
    expect((await rig.post('/api/setup/finish')).status).toBe(409)
    await rig.post('/api/setup/totp/confirm', { totp: totpAt(secret, Date.now()) })
    expect((await rig.post('/api/setup/finish')).status).toBe(204)
  })

  it('reports the claude CLI at every step', async () => {
    rig = await startSetupRig()
    const res = await rig.post('/api/setup/check')
    expect(res.status).toBe(200)
    const { claude } = await res.json()
    expect(typeof claude.ready).toBe('boolean')
    expect(typeof claude.message).toBe('string')
    expect(Array.isArray(claude.fix)).toBe(true)
    expect(typeof claude.user).toBe('string')
  })

  it('answers nothing more once the wizard has finished', async () => {
    rig = await startSetupRig()
    const secret = await toTotp(rig)
    await rig.post('/api/setup/totp/confirm', { totp: totpAt(secret, Date.now()) })
    expect((await rig.post('/api/setup/finish')).status).toBe(204)
    await rig.server.finished
    for (const res of [await rig.get('/setup'), await rig.get('/'), await rig.post('/api/setup/check')]) {
      expect(res.status).toBe(503)
    }
  })

  it('405s a setup call that is not a POST', async () => {
    rig = await startSetupRig()
    const res = await rig.get('/api/setup/password')
    expect(res.status).toBe(405)
  })
})
