import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFakeBin } from './fakeBin'

// A fake bin that runs some JavaScript first (log its argv, its env, its pid...) and then the given script in the same
// process, with the caller's args. It replaces `#!/bin/sh` shims that did that work in shell before `exec node script`,
// which Windows cannot spawn. `before` sees `fs` (node:fs) and `args` (the caller's args).

export function codexShim(dir: string, name: string, script: string, before = ''): string {
  const wrapper = join(dir, `${name}.shim.mjs`)
  writeFileSync(
    wrapper,
    `import * as fs from 'node:fs'\nconst args = process.argv.slice(2)\n${before}\nawait import(${JSON.stringify(pathToFileURL(script).href)})\n`
  )
  return writeFakeBin(dir, name, wrapper)
}

/** JavaScript for `before` that appends one line to `file`. */
export const appendLine = (file: string, expr: string): string => `fs.appendFileSync(${JSON.stringify(file)}, ${expr} + '\\n')\n`
