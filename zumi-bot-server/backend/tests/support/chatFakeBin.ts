import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFakeBin, writeFakeNodeBin } from './fakeBin'

// Fixtures with a `#!/usr/bin/env node` line are spawned as they are on Linux and macOS. Windows cannot spawn a script,
// so there it gets a fake-bin launcher that runs the script with node; the returned path is what to hand the app.

const cache = new Map<string, string>()

/** `script` itself off Windows; elsewhere a launcher for it in a temp folder, made once per script. */
export function scriptBin(script: string): string {
  if (process.platform !== 'win32') return script
  const hit = cache.get(script)
  if (hit) return hit
  const bin = writeFakeBin(mkdtempSync(join(tmpdir(), 'zb-scriptbin-')), basename(script).replace(/\.[cm]?js$/, ''), script)
  cache.set(script, bin)
  return bin
}

/**
 * A bin that runs `prelude` (JavaScript: log the args, set env...) and then the fake in the same node process, as a shell
 * shim that ends in `exec node <fake>` would: same pid, same stdio, `process.argv.slice(2)` still the caller's args.
 */
export function writePreludeBin(dir: string, name: string, prelude: string, fake: string): string {
  return writeFakeNodeBin(dir, name, `${prelude}\nawait import(${JSON.stringify(pathToFileURL(fake).href)})\n`)
}
