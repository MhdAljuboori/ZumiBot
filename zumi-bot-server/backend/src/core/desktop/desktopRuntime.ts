import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DesktopRuntime {
  xvnc: string | null
  dbusDaemon: string | null
  /** argv of the session command; its first word is absolute. */
  session: string[] | null
  cuaDriver: string | null
  node: string
  bridgeEntry: string
  electronNode: boolean
  /** Fixed human names of what is not found, for the UI and `desktop-check`. */
  missing: string[]
}

export const DESKTOP_PROGRAMS = {
  xvnc: 'TigerVNC (Xvnc)',
  dbusDaemon: 'D-Bus (dbus-daemon)',
  session: 'desktop session (xfwm4)',
  cuaDriver: 'cua-driver'
} as const
// XFCE parts without xfce4-session: startxfce4 runs the host's autostart (updaters, an upgrade
// dialog, ssh-agent escaping the process group). Positional args keep the paths unquoted.
const SESSION_PARTS = ['xfsettingsd', 'xfwm4', 'xfce4-panel', 'xfdesktop']
const SESSION_SCRIPT = '"$0" & "$1" & "$2" & exec "$3"'

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}
/** PATH lookup that ignores relative and empty entries, so the server's cwd never supplies a program. */
function onPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(':')) {
    if (!dir || !isAbsolute(dir)) continue
    if (executable(join(dir, name))) return join(dir, name)
  }
  return null
}
/** An explicit override wins; when it is unusable the program counts as missing rather than found elsewhere. */
function override(value: string | undefined): string | null | undefined {
  if (value === undefined || value === '') return undefined
  return isAbsolute(value) && executable(value) ? value : null
}

/** Pure preflight: nothing is started, so a text-only server never needs the desktop stack. */
export function resolveDesktopRuntime(env: NodeJS.ProcessEnv = process.env, moduleUrl: string = import.meta.url): DesktopRuntime {
  const pathEnv = env.PATH ?? ''
  const find = (variable: string, name: string): string | null => {
    const chosen = override(env[variable])
    return chosen === undefined ? onPath(name, pathEnv) : chosen
  }
  const xvnc = find('ZUMIBOT_DESKTOP_XVNC', 'Xvnc')
  const dbusDaemon = find('ZUMIBOT_DESKTOP_DBUS_DAEMON', 'dbus-daemon')
  let session: string[] | null
  if (env.ZUMIBOT_DESKTOP_SESSION) {
    const words = env.ZUMIBOT_DESKTOP_SESSION.split(' ').filter(Boolean)
    session = words.length && override(words[0]) ? words : null
  } else {
    const parts = SESSION_PARTS.map((name) => onPath(name, pathEnv))
    session = parts.every(Boolean) ? ['/bin/sh', '-c', SESSION_SCRIPT, ...(parts as string[])] : null
  }
  let cuaDriver = find('ZUMIBOT_CUA_DRIVER', 'cua-driver')
  if (cuaDriver === null && override(env.ZUMIBOT_CUA_DRIVER) === undefined) {
    // The per-user installer's real binary; ~/.local/bin/cua-driver is only a symlink to it.
    const installed = join(env.HOME || homedir(), '.cua-driver', 'packages', 'current', 'cua-driver')
    if (executable(installed)) cuaDriver = installed
  }
  const found = { xvnc, dbusDaemon, session, cuaDriver }
  const missing = (Object.keys(DESKTOP_PROGRAMS) as (keyof typeof DESKTOP_PROGRAMS)[])
    .filter((k) => !found[k])
    .map((k) => DESKTOP_PROGRAMS[k])
  const dir = dirname(fileURLToPath(moduleUrl))
  // Source servers use the bridge emitted by the normal backend build, like the browser's.
  const packaged = existsSync(join(dir, 'desktopBridge.mjs')) || moduleUrl.endsWith('.mjs')
  return {
    ...found,
    node: process.execPath,
    bridgeEntry: join(packaged ? dir : join(dir, '../../../dist'), 'desktopBridge.mjs'),
    electronNode: Boolean((process.versions as { electron?: string }).electron),
    missing
  }
}
