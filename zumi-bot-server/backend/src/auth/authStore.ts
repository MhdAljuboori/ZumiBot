import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../core/fsutil'
import { verifyPassword } from './password'
import { hashRecovery, normalizeRecovery } from './recovery'
import { verifyTotp } from './totp'

const SESSION_MS = 30 * 24 * 60 * 60 * 1000

type AuthFile = {
  passwordHash?: string
  totp?: { secret: string; lastStep: number; recoveryHashes: string[] }
  sessions: { key: string; expiresAt: number }[]
}

/** What auth.json stores and what the hub keys sockets by: never the raw token. */
export function sessionKeyOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class AuthStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  private readonly verify: (pw: string, stored: string) => Promise<boolean>

  constructor(
    dataDir: string,
    private readonly now: () => number,
    opts: { verify?: (pw: string, stored: string) => Promise<boolean> } = {}
  ) {
    this.verify = opts.verify ?? verifyPassword
    this.file = join(dataDir, 'auth.json')
  }

  // Always read from disk, so a CLI change applies to the running server at once.
  private async read(): Promise<AuthFile> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [] }
      throw err
    }
    let data: Partial<AuthFile>
    try {
      data = JSON.parse(raw) as Partial<AuthFile>
    } catch {
      // Fail closed, and never echo the file: V8 parse errors quote its text.
      throw new Error('auth.json is not valid JSON')
    }
    return { ...data, sessions: Array.isArray(data.sessions) ? data.sessions : [] }
  }

  private async write(data: AuthFile): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(data, null, 2) + '\n', 0o600)
    await fs.chmod(this.file, 0o600)
  }

  /** Runs read-modify-write steps one at a time so concurrent calls cannot lose each other's updates. */
  private mutate<T>(fn: (data: AuthFile) => Promise<{ data?: AuthFile; result: T }>): Promise<T> {
    const run = this.queue.then(async () => {
      const { data, result } = await fn(await this.read())
      if (data) await this.write(data)
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  async configured(): Promise<{ password: boolean; totp: boolean }> {
    const d = await this.read()
    return { password: !!d.passwordHash, totp: !!d.totp }
  }

  setPassword(hash: string): Promise<void> {
    return this.mutate(async (d) => ({ data: { ...d, passwordHash: hash, sessions: [] }, result: undefined }))
  }

  /** lastStep: the step of a code already used (the setup confirmation), so it cannot be replayed to log in. */
  setTotp(secret: string, recoveryHashes: string[], lastStep = 0): Promise<void> {
    return this.mutate(async (d) => ({
      data: { ...d, totp: { secret, lastStep, recoveryHashes }, sessions: [] },
      result: undefined
    }))
  }

  async checkLogin(password: string, code: string): Promise<boolean> {
    // scrypt runs outside the queue (~100 ms) so logins do not stall logout or CLI changes.
    const first = await this.read()
    if (!first.passwordHash || !first.totp) return false
    if (!(await this.verify(password, first.passwordHash))) return false
    // Re-read inside the queue: the file may have changed meanwhile (CLI, another request), and we write from this read.
    return this.mutate(async (d) => {
      if (d.passwordHash !== first.passwordHash || !d.totp) return { result: false }
      const totp = d.totp
      const compact = code.replace(/\s/g, '')
      const normalized = normalizeRecovery(code)
      let step: number | null = null
      let usedHash: string | null = null
      if (/^\d{6}$/.test(compact)) {
        step = verifyTotp(totp.secret, compact, this.now(), totp.lastStep)
      } else if (/^[A-Z2-7]{10}$/.test(normalized)) {
        const h = hashRecovery(normalized)
        for (const stored of totp.recoveryHashes) if (safeEqual(stored, h)) usedHash = stored
      }
      if (step === null && usedHash === null) return { result: false }
      const next: AuthFile = {
        ...d,
        totp: {
          ...totp,
          lastStep: step ?? totp.lastStep,
          recoveryHashes: usedHash ? totp.recoveryHashes.filter((h) => h !== usedHash) : totp.recoveryHashes
        }
      }
      return { data: next, result: true }
    })
  }

  createSession(): Promise<string> {
    return this.mutate(async (d) => {
      const token = randomBytes(32).toString('base64url')
      const now = this.now()
      const sessions = d.sessions.filter((s) => s.expiresAt > now)
      sessions.push({ key: sessionKeyOf(token), expiresAt: now + SESSION_MS })
      return { data: { ...d, sessions }, result: token }
    })
  }

  async checkSession(token: string): Promise<boolean> {
    return this.checkSessionKey(sessionKeyOf(token))
  }

  async checkSessionKey(key: string): Promise<boolean> {
    const d = await this.read()
    const now = this.now()
    return d.sessions.some((s) => s.expiresAt > now && safeEqual(s.key, key))
  }

  revokeSession(token: string): Promise<void> {
    const key = sessionKeyOf(token)
    return this.mutate(async (d) => ({
      data: { ...d, sessions: d.sessions.filter((s) => s.key !== key) },
      result: undefined
    }))
  }

  revokeAll(): Promise<void> {
    return this.mutate(async (d) => ({ data: { ...d, sessions: [] }, result: undefined }))
  }
}
