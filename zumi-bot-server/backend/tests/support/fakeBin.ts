import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A fake CLI the app can spawn directly, as it spawns `claude`, `codex`, `gh`...: `node <script> [args] "$@"`.
// Linux and macOS get the usual `#!/bin/sh` wrapper with `exec`. Windows cannot spawn a script, so it gets a copy of a
// tiny launcher exe (fakeBinLauncher.cs, built once per machine with the csc.exe every Windows ships in .NET Framework)
// beside a `<name>.launch` file holding the command line. Either way the returned path is what to hand the app.

const isWindows = process.platform === 'win32'
const LAUNCHER_SRC = fileURLToPath(new URL('./fakeBinLauncher.cs', import.meta.url))
const CSC = join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

let launcher: string | null = null

/** Builds the launcher on first use, cached in the temp folder by its source's hash so parallel workers share it. */
function launcherExe(): string {
  if (launcher) return launcher
  const src = readFileSync(LAUNCHER_SRC)
  const hash = createHash('sha256').update(src).digest('hex').slice(0, 16)
  const dir = join(tmpdir(), 'zumibot-fakebin')
  const exe = join(dir, `launcher-${hash}.exe`)
  if (!existsSync(exe)) {
    mkdirSync(dir, { recursive: true })
    // Built under a unique name and renamed into place, so two workers building at once never see half an exe.
    const tmp = join(dir, `launcher-${hash}-${process.pid}-${Date.now()}.exe`)
    execFileSync(CSC, ['/nologo', '/optimize+', '/target:exe', `/out:${tmp}`, LAUNCHER_SRC], { stdio: 'pipe', windowsHide: true })
    try {
      renameSync(tmp, exe)
    } catch {
      if (!existsSync(exe)) throw new Error(`could not place the fake-bin launcher at ${exe}`)
    }
  }
  return (launcher = exe)
}

/** Quotes one argument the way the Windows C runtime splits a command line back into argv. */
export function winQuote(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Writes `dir/<name>` (`dir/<name>.exe` on Windows) that runs `node <script> ...args` with the caller's arguments after
 * them, and returns its path. `program` replaces node when the fake is some other executable.
 */
export function writeFakeBin(dir: string, name: string, script: string | null, opts: { args?: string[]; program?: string } = {}): string {
  const argv = [opts.program ?? process.execPath, ...(script === null ? [] : [script]), ...(opts.args ?? [])]
  if (!isWindows) {
    const p = join(dir, name)
    writeFileSync(p, `#!/bin/sh\nexec ${argv.map(shQuote).join(' ')} "$@"\n`)
    chmodSync(p, 0o755)
    return p
  }
  const p = join(dir, `${name}.exe`)
  // A hard link, not a copy: antivirus scans each new exe on its first run, which under load costs seconds per fake.
  try {
    linkSync(launcherExe(), p)
  } catch {
    copyFileSync(launcherExe(), p) // another volume
  }
  writeFileSync(join(dir, `${name}.launch`), argv.map(winQuote).join(' '))
  return p
}

/**
 * A fake whose body is JavaScript instead of a shell script (`echo`, `exit 3`, a log of its args...), so it runs the same
 * on every platform: writes `dir/<name>.fake.mjs` and a bin that runs it. `process.argv.slice(2)` is the caller's args.
 */
export function writeFakeNodeBin(dir: string, name: string, js: string): string {
  const script = join(dir, `${name}.fake.mjs`)
  writeFileSync(script, js)
  return writeFakeBin(dir, name, script)
}

/** The file name `writeFakeBin` gives a fake called `name`: what PATH lookups find. */
export const fakeBinName = (name: string): string => (isWindows ? `${name}.exe` : name)
