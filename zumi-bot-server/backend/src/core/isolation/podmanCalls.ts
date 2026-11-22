import { execFile, type ChildProcess } from 'node:child_process'

export type PodmanResult = { code: number | null; stdout: string }
/** Runs podman with these args (the binary is bound). */
export type Exec = (args: string[]) => Promise<PodmanResult>

/**
 * The server's own podman calls (the support check, the owner sweep, pruning, a turn's `rm`), so that close() can end the ones still
 * running. A call left behind outlives the server and keeps writing Podman storage into its HOME: `podman info` takes over a second,
 * so one started by an Agent Studio opened just before a stop came back after the e2e harness had removed that HOME.
 */
export class PodmanCalls {
  private live = new Map<ChildProcess, Promise<void>>()
  private closed = false

  /** Resolves with the exit code (null on a spawn error, a timeout or a kill) and stdout. After close() nothing starts. */
  run(bin: string, args: string[], timeoutMs: number): Promise<PodmanResult> {
    if (this.closed) return Promise.resolve({ code: null, stdout: '' })
    return new Promise((done) => {
      let ended!: () => void
      const gone = new Promise<void>((r) => (ended = r))
      const child = execFile(bin, args, { timeout: timeoutMs }, (err, stdout) => {
        this.live.delete(child)
        ended()
        const code = err ? (err as { code?: unknown }).code : 0
        done({ code: typeof code === 'number' ? code : null, stdout: String(stdout ?? '') })
      })
      // The exit, not the callback: a grandchild holding stdout must not keep close() waiting.
      child.once('exit', () => ended())
      this.live.set(child, gone)
    })
  }

  exec(podman: string, timeoutMs = 30_000): Exec {
    return (args) => this.run(podman, args, timeoutMs)
  }

  /** Refuses new calls, SIGTERMs the running ones (podman exits within milliseconds) and waits for them; SIGKILL after `graceMs`. */
  async close(graceMs = 3000): Promise<void> {
    this.closed = true
    if (this.live.size === 0) return
    const waits = [...this.live.values()]
    for (const child of this.live.keys()) child.kill('SIGTERM')
    const timer = setTimeout(() => {
      for (const child of this.live.keys()) child.kill('SIGKILL')
    }, graceMs)
    await Promise.all(waits)
    clearTimeout(timer)
  }
}
