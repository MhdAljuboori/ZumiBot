import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/**
 * Windows has no process groups and no signals: `kill(-pid)` throws and every `child.kill(sig)` is TerminateProcess on that
 * one process, which orphans its children (an agent's shells, MCP servers). taskkill /T ends the whole tree instead.
 */
export function killTree(pid: number | undefined): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 4 || pid === process.pid) return
  try {
    const child = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* taskkill missing: nothing else can end the tree */
  }
}

/**
 * `process.kill(-pgid, sig)` for a group made with `detached: true`; on Windows the leader's tree. Signal 0 only asks whether
 * it lives (the leader, there). Throws like process.kill does when the group is gone. For a child of this process use
 * signalChildGroup: on Windows a bare pid may already name someone else.
 */
export function signalGroup(pgid: number, sig: NodeJS.Signals | 0, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return void process.kill(-pgid, sig)
  if (sig === 0) return void process.kill(pgid, 0)
  killTree(pgid)
}

/** What a kill needs of a ChildProcess: node sets exitCode or signalCode as it closes the child's handle. */
export type KillableChild = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>

const gone = (): NodeJS.ErrnoException => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', errno: -3, syscall: 'kill' })

/**
 * signalGroup for a child spawned with `detached: true`. On POSIX the group outlives its leader, so a kill after the exit
 * still reaches what the child left running. Windows frees a pid once nothing holds the process's handle (node closes its
 * own at the exit) and hands it to the next process at once: a taskkill by it then ends a stranger's whole tree, and could not
 * reach the dead child's orphans anyway (/T walks from a live root). So there a child node saw exit is gone (ESRCH), and
 * signal 0 asks node instead of the pid.
 */
export function signalChildGroup(child: KillableChild, sig: NodeJS.Signals | 0, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid
  if (pid === undefined) throw gone()
  if (platform !== 'win32') return void process.kill(-pid, sig)
  if (child.exitCode !== null || child.signalCode !== null) throw gone()
  if (sig !== 0) killTree(pid)
}

/**
 * The bash an agent's shell commands run in. Claude Code on Windows itself runs its Bash tool in Git Bash
 * (`CLAUDE_CODE_GIT_BASH_PATH`, else the one next to git), so a background process gets the same shell and the same syntax.
 */
export function defaultBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return '/bin/bash'
  const given = env.CLAUDE_CODE_GIT_BASH_PATH
  if (given && existsSync(given)) return given
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  for (const dir of (pathKey ? (env[pathKey] ?? '') : '').split(delimiter)) {
    if (!dir || !existsSync(join(dir, 'git.exe'))) continue
    // git.exe lives in <Git>\cmd or <Git>\bin; bash.exe in <Git>\bin.
    for (const bash of [join(dir, 'bash.exe'), join(dirname(dir), 'bin', 'bash.exe')]) if (existsSync(bash)) return bash
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    const bash = root && join(root, 'Git', 'bin', 'bash.exe')
    if (bash && existsSync(bash)) return bash
  }
  return 'bash.exe'
}
