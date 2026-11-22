import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// The shell was ClaudeBot before 0.1.0, so its settings lived in <appData>/ClaudeBot. That folder is also the
// previous Electron app's, so it is never moved: only this shell's own files are copied, once, and the old one stays.
export const LEGACY_APP_DIR = 'ClaudeBot'
export const SHELL_FILES = ['server.json', 'island.json', 'window-state.json', 'sync.env'] as const

export interface LegacyFs {
  existsSync(path: string): boolean
  mkdirSync(dir: string, o: { recursive: true }): unknown
  copyFileSync(from: string, to: string): void
  rmSync(path: string, o: { force: true }): void
}

/** Returns the files it copied. The old login entry goes too: the island setting writes the new one at start. */
export function migrateLegacyShell(
  o: { appData: string; userData: string; autostartDir: string },
  fs: LegacyFs = { existsSync, mkdirSync, copyFileSync, rmSync }
): string[] {
  const from = join(o.appData, LEGACY_APP_DIR)
  const copied: string[] = []
  if (!fs.existsSync(from) || from === o.userData) return copied
  for (const name of SHELL_FILES) {
    const src = join(from, name)
    const dst = join(o.userData, name)
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue
    fs.mkdirSync(o.userData, { recursive: true })
    fs.copyFileSync(src, dst)
    copied.push(name)
  }
  if (copied.length) fs.rmSync(join(o.autostartDir, 'claudebot.desktop'), { force: true })
  return copied
}
