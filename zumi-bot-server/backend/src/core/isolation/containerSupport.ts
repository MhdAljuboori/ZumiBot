import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { SandboxSupport } from '@zumibot/shared/isolation'
import type { PodmanCalls } from './podmanCalls'

// Whether this machine can run level 3 (governance.md 2.4). Where it cannot, Container is shown unavailable with the reason and a
// contained agent's run is refused, never run with less.

/** Built by `npm run container:image` from zumi-bot-server/container/Dockerfile. Raise the number when that file changes. */
export const AGENT_IMAGE = 'localhost/zumibot-agent:1'

export interface ContainerSupportDeps {
  platform: NodeJS.Platform
  path: string
  exists(path: string): boolean
  /** Runs a program; resolves with its exit code and stdout (code null on a spawn error or timeout). */
  run(bin: string, args: string[]): Promise<{ code: number | null; stdout: string }>
  /** The claude binary the server runs, resolved; null when not found. */
  claudeBin(): Promise<string | null>
  /** Whether a file is a native executable (the container mounts it; a script would need the host's interpreter). */
  isNative(path: string): Promise<boolean>
}

export const which = (path: string, exists: (p: string) => boolean, name: string): string | null => {
  for (const dir of path.split(':')) {
    if (!dir) continue
    const p = join(dir, name)
    if (exists(p)) return p
  }
  return null
}

/** `calls` is the server's own: its close() ends a check still running (`podman info` takes over a second). */
export const realContainerDeps = (path: string, claudeBin: () => Promise<string | null>, calls: PodmanCalls): ContainerSupportDeps => ({
  platform: process.platform,
  path,
  exists: existsSync,
  run: (bin, args) => calls.run(bin, args, 15_000),
  claudeBin,
  isNative: async (p) => {
    const fh = await open(p, 'r').catch(() => null)
    if (!fh) return false
    try {
      const b = Buffer.alloc(4)
      await fh.read(b, 0, 4, 0)
      return b.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    } finally {
      await fh.close()
    }
  }
})

export type ContainerCheck = { available: true; podman: string; claudeBin: string } | { available: false; reason: string }

export async function checkContainer(d: ContainerSupportDeps): Promise<ContainerCheck> {
  if (d.platform !== 'linux') return { available: false, reason: `Container isolation runs on Linux only, not ${d.platform}.` }
  // The server's own container: running agents' containers would need the host's container socket, which is root on the host.
  if (d.exists('/.dockerenv') || d.exists('/run/.containerenv')) {
    return {
      available: false,
      reason: 'The server runs inside a container; containers for agents would need the host’s container socket, which ZumiBot never uses.'
    }
  }
  const podman = which(d.path, d.exists, 'podman')
  if (podman === null) return { available: false, reason: 'Install Podman on the server (rootless) to use container isolation.' }
  const info = await d.run(podman, ['info', '--format', '{{.Host.Security.Rootless}}'])
  if (info.code !== 0) return { available: false, reason: 'Podman is installed but `podman info` failed for this user.' }
  if (info.stdout.trim() !== 'true')
    return { available: false, reason: 'Podman runs rootful for this user; ZumiBot only uses rootless Podman.' }
  const image = await d.run(podman, ['image', 'exists', AGENT_IMAGE])
  if (image.code !== 0)
    return { available: false, reason: 'The agent image is not built yet: run `npm run container:image` on the server.' }
  const bin = await d.claudeBin()
  if (bin === null) return { available: false, reason: 'The claude CLI was not found.' }
  if (!(await d.isNative(bin)))
    return {
      available: false,
      reason:
        'The claude CLI here is a script install; container isolation mounts the native build (install it with the official installer).'
    }
  return { available: true, podman, claudeBin: bin }
}

export const toSupport = (c: ContainerCheck): SandboxSupport => (c.available ? { available: true } : { available: false, reason: c.reason })
