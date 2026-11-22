import type { ChildProcess } from 'node:child_process'

/**
 * Ends a spawned `server.mjs serve` the way a service manager does: SIGTERM, so close() runs and removes its IPC folders
 * (`/tmp/cb-?-*`) and ends its podman calls; SIGKILL only past `graceMs` (under vitest's 10 s hook timeout). A plain SIGKILL
 * left one set of those folders behind per test.
 */
export async function stopServer(child: ChildProcess | null | undefined, graceMs = 8000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
  await exited
  clearTimeout(timer)
}
