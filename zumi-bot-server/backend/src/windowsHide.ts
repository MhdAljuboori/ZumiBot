import { ChildProcess } from 'node:child_process'

/**
 * Windows: the desktop runs the server under Electron's GUI exe, which has no console, so every console program it starts
 * (claude, git, gh, node bridges) would open a console window of its own. spawn, exec, execFile and fork all end in
 * `ChildProcess.prototype.spawn`, so hiding there covers every call site, present and future.
 */
export function hideChildWindows(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return
  const proto = ChildProcess.prototype as unknown as { spawn(o: { windowsHide?: boolean }): unknown; __zumibotHidden?: true }
  if (proto.__zumibotHidden) return
  const spawn = proto.spawn
  proto.spawn = function (this: unknown, options: { windowsHide?: boolean }) {
    return spawn.call(this, { ...options, windowsHide: true })
  }
  proto.__zumibotHidden = true
}
