import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

/** A self-signed certificate for `agent.test`; null when openssl is not installed (the test using it then stands down). */
export function selfSigned(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'cb-agui-cert-'))
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=agent.test'
      ],
      { stdio: 'ignore' }
    )
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') }
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Runs `fn` with NODE_TLS_REJECT_UNAUTHORIZED=0, which turns Node's default certificate check off for every TLS connection
 * that does not ask for it itself; Node's warning about it is silenced. The env is restored after.
 */
export async function withTlsCheckOff<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    return await fn()
  } finally {
    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before
    warn.mockRestore()
  }
}
