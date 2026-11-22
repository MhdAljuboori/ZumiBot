import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxSupport } from '@zumibot/shared/isolation'

// Whether this machine can run the CLI's OS sandbox. Where it cannot, Sandboxed is shown unavailable with the reason and a
// sandboxed agent's run is refused; `failIfUnavailable` in the run's settings is the second lock.

export interface SupportDeps {
  platform: NodeJS.Platform
  path: string // PATH as the CLI will see it (the shell's)
  exists(path: string): boolean
  /** Runs a program; resolves with its exit code (null on a spawn error or timeout). */
  run(bin: string, args: string[]): Promise<number | null>
}

export const realSupportDeps = (path: string): SupportDeps => ({
  platform: process.platform,
  path,
  exists: existsSync,
  run: (bin, args) =>
    new Promise((done) => {
      execFile(bin, args, { timeout: 5_000 }, (err) => {
        if (!err) return done(0)
        const code = (err as { code?: unknown }).code
        done(typeof code === 'number' ? code : null)
      })
    })
})

const which = (d: SupportDeps, name: string): string | null => {
  for (const dir of d.path.split(':')) {
    if (!dir) continue
    const p = join(dir, name)
    if (d.exists(p)) return p
  }
  return null
}

export async function checkSandbox(d: SupportDeps): Promise<SandboxSupport> {
  if (d.platform === 'darwin') return { available: true }
  if (d.platform !== 'linux') return { available: false, reason: `The Claude CLI's sandbox does not run on ${d.platform}.` }
  // Docker or Podman: the nested sandbox would need enableWeakerNestedSandbox, which is not offered.
  if (d.exists('/.dockerenv') || d.exists('/run/.containerenv')) {
    return {
      available: false,
      reason: 'The server runs inside a container, where the sandbox would need a weaker nested mode that ZumiBot does not use.'
    }
  }
  const bwrap = which(d, 'bwrap')
  const missing = [bwrap === null ? 'bubblewrap (bwrap)' : null, which(d, 'socat') === null ? 'socat' : null].filter(Boolean)
  if (missing.length > 0) return { available: false, reason: `Install ${missing.join(' and ')} on the server to use the sandbox.` }
  // AppArmor (Ubuntu 24.04+) or a sysctl may refuse unprivileged user namespaces: try one.
  const code = await d.run(bwrap!, ['--ro-bind', '/', '/', '--unshare-user', '--unshare-net', '--dev', '/dev', 'true'])
  if (code !== 0)
    return {
      available: false,
      reason: 'bubblewrap cannot make a sandbox here (unprivileged user namespaces are blocked, often by AppArmor).'
    }
  return { available: true }
}
