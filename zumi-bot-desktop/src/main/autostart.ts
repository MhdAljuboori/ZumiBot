import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const HIDDEN_FLAG = '--hidden'

export interface AutostartFs {
  readFileSync(file: string, enc: 'utf8'): string
  writeFileSync(file: string, data: string): void
  mkdirSync(dir: string, o: { recursive: true }): unknown
  rmSync(file: string, o: { force: true }): void
}

export function autostartFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart', 'zumibot.desktop')
}

// Desktop Entry spec: an Exec argument with a space or one of these is quoted, and these four are escaped inside.
const NEEDS_QUOTES = /[ "`$\\]/
const quoteExec = (exec: string): string => (NEEDS_QUOTES.test(exec) ? `"${exec.replace(/["`$\\]/g, '\\$&')}"` : exec)

export function autostartEntry(exec: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=ZumiBot',
    'Comment=Start ZumiBot in the tray',
    `Exec=${quoteExec(exec)} ${HIDDEN_FLAG}`,
    'Icon=zumibot',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

/** Makes the login entry match the setting. Only a packaged build owns one: a dev run must not point login at itself. */
export function syncAutostart(
  o: { on: boolean; packaged: boolean; file: string; exec: string },
  fs: AutostartFs = { readFileSync, writeFileSync, mkdirSync, rmSync }
): 'written' | 'removed' | 'skipped' {
  if (!o.packaged) return 'skipped'
  if (!o.on) {
    fs.rmSync(o.file, { force: true })
    return 'removed'
  }
  const entry = autostartEntry(o.exec)
  let current: string | null = null
  try {
    current = fs.readFileSync(o.file, 'utf8')
  } catch {
    // missing: written below
  }
  if (current === entry) return 'skipped'
  fs.mkdirSync(dirname(o.file), { recursive: true })
  fs.writeFileSync(o.file, entry)
  return 'written'
}

/** Started by the login entry: stay in the tray instead of showing the window. */
export function wantsHidden(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_FLAG)
}
