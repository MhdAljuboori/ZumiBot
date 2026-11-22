import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A third engine must never fall into Claude's or Codex's machinery by being "not the other one". So no source may branch on
// `onCodex` or on `!== 'codex'`: a Claude-only part says `=== 'claude'`, a Codex-only part `=== 'codex'`, and a part both have
// is an exhaustive `switch` or a `Record<Engine, …>` (see docs/architecture/engines.md, Phase 4).
const SERVER = fileURLToPath(new URL('../../', import.meta.url))
const ROOTS = ['backend/src', 'shared/src', 'frontend/src'].map((d) => join(SERVER, d))
const BANNED: { name: string; re: RegExp }[] = [
  { name: 'onCodex', re: /\bonCodex\b/ },
  { name: "!== 'codex'", re: /!==\s*['"]codex['"]/ }
]

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('engine checks', () => {
  it('no source treats "not Codex" as Claude, or the other way round', () => {
    const hits = ROOTS.flatMap((root) => sources(root)).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => BANNED.filter((b) => b.re.test(line)).map((b) => `${file.slice(SERVER.length)}:${i + 1}: ${b.name}`))
    )
    expect(hits).toEqual([])
  })
})
