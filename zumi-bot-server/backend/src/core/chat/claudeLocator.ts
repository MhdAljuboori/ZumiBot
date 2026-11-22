import { execFile } from 'node:child_process'
import { access, constants, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { loginShell } from './shellEnv'

export interface LocateDeps {
  override: string | null
  pathEnv: string
  home: string
  isExecutable(p: string): Promise<boolean>
  loginShellWhich(): Promise<string | null>
  /** Defaults to this machine's. On Windows PATH splits on `;` and a name means `<name>.exe` or an npm `.cmd` shim. */
  platform?: NodeJS.Platform
  /** Reads an npm `.cmd` shim; null when it is not there. */
  readShim?(p: string): Promise<string | null>
}

const readShimFile = (p: string): Promise<string | null> =>
  readFile(p, 'utf8').then(
    (s) => s,
    () => null
  )

/**
 * The `.exe` an npm `.cmd` shim runs (`"%dp0%\node_modules\...\claude.exe" %*`), or null when it runs a script through
 * node. Node cannot spawn a `.cmd` without a shell, and a shell would mangle the JSON arguments a turn passes.
 */
export async function shimTarget(shim: string, read: (p: string) => Promise<string | null> = readShimFile): Promise<string | null> {
  const text = await read(shim)
  const m = text && /"%dp0%\\([^"%]+\.exe)"/i.exec(text)
  return m ? win32.join(win32.dirname(shim), m[1]!) : null
}

/** An override first, then each PATH entry, then ~/.local/bin (and Homebrew's on a Mac), then what the user's login shell says. */
export async function locateBin(name: string, d: LocateDeps): Promise<string | null> {
  const windows = (d.platform ?? process.platform) === 'win32'
  const path = windows ? win32 : posix
  const read = d.readShim ?? readShimFile
  // On Windows each folder may hold `<name>.exe` (the native installer) or an npm shim `<name>.cmd`, resolved to its exe.
  const inDir = async (dir: string): Promise<string | null> => {
    if (!windows) {
      const c = path.join(dir, name)
      return (await d.isExecutable(c)) ? c : null
    }
    const exe = path.join(dir, `${name}.exe`)
    if (await d.isExecutable(exe)) return exe
    const viaShim = await shimTarget(path.join(dir, `${name}.cmd`), read)
    return viaShim && (await d.isExecutable(viaShim)) ? viaShim : null
  }
  if (d.override) {
    const override = windows && /\.cmd$/i.test(d.override) ? await shimTarget(d.override, read) : d.override
    if (override && (await d.isExecutable(override))) return override
  }
  for (const dir of d.pathEnv.split(windows ? ';' : ':')) {
    const found = dir && path.isAbsolute(dir) ? await inDir(dir) : null
    if (found) return found
  }
  if (d.home) {
    const found = await inDir(path.join(d.home, '.local', 'bin'))
    if (found) return found
  }
  // Homebrew's folders (Apple silicon, then Intel): an app opened from Finder has neither on PATH.
  if ((d.platform ?? process.platform) === 'darwin') {
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
      const found = await inDir(dir)
      if (found) return found
    }
  }
  const viaShell = windows ? null : await d.loginShellWhich()
  if (viaShell && (await d.isExecutable(viaShell))) return viaShell
  return null
}

export const locateClaude = (d: LocateDeps): Promise<string | null> => locateBin('claude', d)

/** `PATH` from an env, whatever its case: a copy of the Windows environment keeps the key `Path`. */
export function pathOf(env: NodeJS.ProcessEnv): string {
  if (env.PATH !== undefined) return env.PATH
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (key && env[key]) || ''
}

/** `name` is only what the login-shell fallback looks up; the candidate list is the caller's through `locateBin`. */
export function defaultLocateDeps(override: string | null, name = 'claude'): LocateDeps {
  return {
    override,
    pathEnv: pathOf(process.env),
    home: homedir(),
    isExecutable: async (p) => {
      try {
        if (!(await stat(p)).isFile()) return false
        // Windows has no execute bit: X_OK only says the file exists.
        await access(p, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    loginShellWhich: () => loginShellWhich(name)
  }
}

/** `command -v <name>` in the user's login shell (zsh on a Mac, see loginShell); null on Windows or a miss. */
export function loginShellWhich(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') return resolve(null)
    const shell = loginShell()
    // zsh: nvm and the like are set up in .zshrc, which only an interactive shell reads.
    execFile(shell, [shell === 'zsh' ? '-ilc' : '-lc', `command -v ${name}`], { timeout: 5000 }, (err, stdout) => {
      const p = err ? '' : (stdout.trim().split('\n').pop()?.trim() ?? '')
      resolve(p.startsWith('/') ? p : null)
    })
  })
}

/** Locates lazily and caches until the override changes; a miss is not cached so installing claude later works. */
export function createClaudeLocator(settings: {
  get(): Promise<{ claudePath: string | null }>
  set(patch: { claudePath: string | null }): Promise<unknown>
}) {
  let cached: Promise<string | null> | null = null
  const locate = (): Promise<string | null> => {
    if (!cached) {
      const p = settings.get().then((s) => locateClaude(defaultLocateDeps(s.claudePath)))
      cached = p
      void p.then(
        (r) => {
          if (r === null && cached === p) cached = null
        },
        () => {
          if (cached === p) cached = null
        }
      )
    }
    return cached
  }
  return {
    locate,
    async setPath(path: string): Promise<string | null> {
      await settings.set({ claudePath: path.trim() || null })
      cached = null
      return locate()
    }
  }
}
