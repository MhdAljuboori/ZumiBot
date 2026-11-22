import { access, constants, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { pathOf, shimTarget } from '../chat/claudeLocator'

const executable = async (p: string): Promise<boolean> => {
  try {
    if (!(await stat(p)).isFile()) return false
    await access(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The path to spawn for an ACP agent's `command`: a bare name looked up on the run env's PATH (never this process's own, which
 * a desktop launch leaves short), or an absolute path that must be an executable file. A relative path, and a relative PATH
 * entry, are refused: either would resolve against the chat's folder, which the agent itself can write.
 */
export async function acpLocate(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (command === '' || command.includes('\0')) return null
  if (isAbsolute(command)) return (await executable(command)) ? command : null
  if (command.includes('/') || command.includes('\\') || command === '.' || command === '..') return null
  for (const dir of pathOf(env).split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const p = join(dir, command)
    if (process.platform !== 'win32') {
      if (await executable(p)) return p
    } else {
      // Windows has no execute bit, and an npm folder holds a bare `<name>` sh script beside its `.cmd`: only an exe counts.
      if (/\.exe$/i.test(command) && (await executable(p))) return p
      // `<name>.exe`, or the exe an npm `.cmd` shim runs (a shim itself cannot be spawned without a shell).
      if (await executable(p + '.exe')) return p + '.exe'
      const viaShim = await shimTarget(p + '.cmd')
      if (viaShim && (await executable(viaShim))) return viaShim
    }
  }
  return null
}
