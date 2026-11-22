import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script with no types
import { addSection, changelogSection } from '../../deploy/changelog.mjs'
// @ts-expect-error plain ESM script with no types
import { bumpArg } from '../../deploy/bump.mjs'

const CHANGELOG = fileURLToPath(new URL('../../deploy/changelog.mjs', import.meta.url))

const SAMPLE = `# Changelog

Notes for each release.

## v0.2.0 — 2026-12-01

- Second thing

## v0.1.0 — 2026-11-20

- First thing
- Another thing

## v0.0.9 — 2026-11-01

   

## v0.0.8 — 2026-10-01

- Old
`

describe('changelogSection', () => {
  it('returns the body between this heading and the next, trimmed and without the heading', () => {
    expect(changelogSection(SAMPLE, '0.1.0')).toBe('- First thing\n- Another thing')
    expect(changelogSection(SAMPLE, '0.2.0')).toBe('- Second thing')
  })

  it('returns the last section up to the end of the file', () => {
    expect(changelogSection(SAMPLE, '0.0.8')).toBe('- Old')
  })

  it('accepts the version with or without a leading v', () => {
    expect(changelogSection(SAMPLE, 'v0.1.0')).toBe(changelogSection(SAMPLE, '0.1.0'))
  })

  it('returns null for a missing version and for a heading with only whitespace under it', () => {
    expect(changelogSection(SAMPLE, '9.9.9')).toBeNull()
    expect(changelogSection(SAMPLE, '0.0.9')).toBeNull()
  })

  it('reads a file with CRLF line endings', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n')
    expect(changelogSection(crlf, '0.1.0')).toBe('- First thing\r\n- Another thing')
    expect(changelogSection(crlf, '0.0.9')).toBeNull()
  })

  it('does not match a longer version that starts the same way', () => {
    expect(changelogSection(SAMPLE, '0.1')).toBeNull()
    expect(changelogSection('# Changelog\n\n## v0.1.01 — 2026-11-20\n\n- x\n', '0.1.0')).toBeNull()
  })
})

describe('addSection', () => {
  const BASE = '# Changelog\n\nNotes for each release.\n'

  it('inserts the newest section under the intro, before older ones', () => {
    const once = addSection(SAMPLE, '0.3.0', '2027-01-01')
    expect(once.indexOf('## v0.3.0 — 2027-01-01')).toBeLessThan(once.indexOf('## v0.2.0'))
    expect(once.startsWith('# Changelog\n\nNotes for each release.\n\n## v0.3.0 — 2027-01-01\n\n')).toBe(true)
    expect(once).toContain('## v0.1.0 — 2026-11-20\n\n- First thing')
  })

  it('works on a changelog with no sections yet', () => {
    expect(addSection(BASE, '0.1.0', '2026-11-20')).toBe(`${BASE}\n## v0.1.0 — 2026-11-20\n\n`)
  })

  it('is idempotent', () => {
    const once = addSection(BASE, '0.1.0', '2026-11-20')
    expect(addSection(once, '0.1.0', '2027-02-02')).toBe(once)
    expect(addSection(SAMPLE, '0.1.0', '2027-02-02')).toBe(SAMPLE)
  })

  it('leaves an empty new section that changelogSection reports as missing', () => {
    expect(changelogSection(addSection(BASE, '0.1.0', '2026-11-20'), '0.1.0')).toBeNull()
  })
})

describe('bumpArg', () => {
  it('accepts a level or an exact version', () => {
    for (const a of ['patch', 'minor', 'major', '0.1.0', '10.6.4', '1.2.3']) expect(bumpArg(a), a).toBe(a)
  })

  it('rejects anything else, so nothing odd reaches npm', () => {
    for (const a of [undefined, '', 'prerelease', 'v0.1.0', '1.2', '1.2.3-beta', '01.2.3', '--help', '1.2.3 && ls', 'patch '])
      expect(() => bumpArg(a), String(a)).toThrow(/patch\|minor\|major\|X\.Y\.Z/)
  })
})

describe('changelog.mjs notes', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  const run = (text: string, version: string) => {
    dir = mkdtempSync(join(tmpdir(), 'changelog-'))
    writeFileSync(join(dir, 'CHANGELOG.md'), text)
    const out = join(dir, 'NOTES.md')
    const r = spawnSync(process.execPath, [CHANGELOG, 'notes', version, out], { cwd: dir, encoding: 'utf8' })
    return { r, out }
  }

  it('writes the notes of the version to the out file', () => {
    const { r, out } = run(SAMPLE, '0.1.0')
    expect(r.status).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe('- First thing\n- Another thing\n')
  })

  it('exits 1 and names the missing version when there are no notes', () => {
    const { r } = run(SAMPLE, '0.0.9')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('CHANGELOG.md has no notes for v0.0.9')
  })
})
