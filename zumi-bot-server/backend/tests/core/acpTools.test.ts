import { describe, expect, it } from 'vitest'
import { ACP_CARD_DIFF_MAX, ACP_DIFF_MAX, acpRememberable, classifyTool } from '../../src/core/acp/acpTools'

const ROOT = '/work/proj'

describe('classifyTool', () => {
  it('execute with a command is Bash {command}, rememberable', () => {
    expect(classifyTool({ kind: 'execute', title: 'Run', rawInput: { command: 'ls -la' } }, ROOT)).toEqual({
      toolName: 'Bash',
      input: { command: 'ls -la' },
      rememberable: true
    })
  })

  it('execute without a string command is unclassified', () => {
    for (const rawInput of [undefined, {}, { command: 7 }, { command: '' }, { command: ['ls'] }, 'ls']) {
      const c = classifyTool({ kind: 'execute', title: 'Run it', rawInput }, ROOT)
      expect(c.toolName).toBe('AcpCall')
      expect(c.rememberable).toBe(false)
    }
  })

  it('edit is AcpEdit with the paths and a diff per file, rememberable inside the root', () => {
    const c = classifyTool(
      {
        kind: 'edit',
        title: 'Edit a',
        content: [{ type: 'diff', path: '/work/proj/src/a.ts', oldText: 'x', newText: 'y' }],
        locations: [{ path: '/work/proj/src/a.ts' }]
      },
      ROOT
    )
    expect(c.toolName).toBe('AcpEdit')
    expect(c.rememberable).toBe(true)
    const input = c.input as { paths: string[]; diffs: { path: string; kind: string; diff: string }[] }
    expect(input.paths).toEqual(['/work/proj/src/a.ts'])
    expect(input.diffs).toHaveLength(1)
    expect(input.diffs[0]).toMatchObject({ path: '/work/proj/src/a.ts', kind: 'edit' })
    expect(input.diffs[0].diff).toContain('-x')
    expect(input.diffs[0].diff).toContain('+y')
  })

  it('a new file (no oldText) shows only added lines', () => {
    const c = classifyTool({ kind: 'edit', content: [{ type: 'diff', path: 'n.txt', newText: 'hello' }] }, ROOT)
    const input = c.input as { diffs: { diff: string }[] }
    expect(input.diffs[0].diff).toContain('+hello')
    expect(input.diffs[0].diff).not.toMatch(/^-(?!--)/m)
  })

  it('delete and move are AcpEdit too, paths from locations when there is no diff', () => {
    for (const kind of ['delete', 'move']) {
      const c = classifyTool({ kind, title: kind, locations: [{ path: '/work/proj/a' }, { path: '/work/proj/b' }] }, ROOT)
      expect(c.toolName).toBe('AcpEdit')
      expect((c.input as { paths: string[] }).paths).toEqual(['/work/proj/a', '/work/proj/b'])
    }
    expect(classifyTool({ kind: 'delete', locations: [{ path: '/work/proj/a' }] }, ROOT).rememberable).toBe(true)
  })

  it('a move is never rememberable: its destination may be named nowhere the paths are read from', () => {
    const c = classifyTool(
      { kind: 'move', title: 'Move a', locations: [{ path: '/work/proj/a' }], rawInput: { source: 'a', destination: '/etc/cron.d/x' } },
      ROOT
    )
    expect(c).toMatchObject({ toolName: 'AcpEdit', input: { paths: ['/work/proj/a'], move: true }, rememberable: false })
    // Even with every path it shows inside the folder.
    expect(classifyTool({ kind: 'move', locations: [{ path: 'a' }, { path: 'b' }] }, ROOT).rememberable).toBe(false)
  })

  it('relative paths resolve against the root', () => {
    expect(classifyTool({ kind: 'edit', locations: [{ path: 'src/a.ts' }] }, ROOT).rememberable).toBe(true)
    expect(classifyTool({ kind: 'edit', locations: [{ path: '../other/a.ts' }] }, ROOT).rememberable).toBe(false)
  })

  it('is not rememberable when any path is outside the root', () => {
    expect(classifyTool({ kind: 'edit', locations: [{ path: '/work/proj/a' }, { path: '/etc/passwd' }] }, ROOT).rememberable).toBe(false)
    expect(classifyTool({ kind: 'edit', locations: [{ path: '/work/proj-evil/a' }] }, ROOT).rememberable).toBe(false)
    expect(classifyTool({ kind: 'edit', locations: [{ path: '/work/proj/../x' }] }, ROOT).rememberable).toBe(false)
  })

  it('is not rememberable with no path at all, or an empty root', () => {
    expect(classifyTool({ kind: 'edit', title: 'Edit' }, ROOT).rememberable).toBe(false)
    expect(classifyTool({ kind: 'edit', locations: [{ path: '/work/proj/a' }] }, '').rememberable).toBe(false)
  })

  it('cuts each diff at 4000 characters and keeps a digest of the whole', () => {
    const big = 'a'.repeat(10_000)
    const c = classifyTool({ kind: 'edit', content: [{ type: 'diff', path: 'a', newText: big }] }, ROOT)
    const d = (c.input as { diffs: { diff: string; sha256?: string }[] }).diffs[0]
    expect(d.diff.length).toBe(ACP_DIFF_MAX + '…[cut]'.length)
    expect(d.diff.endsWith('…[cut]')).toBe(true)
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cuts a card at 20000 characters across its diffs', () => {
    const content = Array.from({ length: 8 }, (_, i) => ({ type: 'diff', path: `f${i}`, newText: 'b'.repeat(4_000) }))
    const c = classifyTool({ kind: 'edit', content }, ROOT)
    const diffs = (c.input as { diffs: { diff: string; sha256?: string }[] }).diffs
    const total = diffs.reduce((n, d) => n + d.diff.replace('…[cut]', '').length, 0)
    expect(total).toBeLessThanOrEqual(ACP_CARD_DIFF_MAX)
    expect(diffs.at(-1)!.sha256).toBeDefined()
  })

  it('read and search are AcpRead, per agent', () => {
    for (const kind of ['read', 'search']) {
      const c = classifyTool({ kind, title: 'Read a file', locations: [{ path: '/etc/hosts' }] }, ROOT)
      expect(c).toEqual({ toolName: 'AcpRead', input: { paths: ['/etc/hosts'] }, rememberable: true })
    }
    expect(classifyTool({ kind: 'search', title: 'Grep foo' }, ROOT).input).toEqual({ title: 'Grep foo' })
  })

  it('fetch is AcpFetch with the url, else the title', () => {
    expect(classifyTool({ kind: 'fetch', title: 'Fetch', rawInput: { url: 'https://x.test/a' } }, ROOT)).toEqual({
      toolName: 'AcpFetch',
      input: { url: 'https://x.test/a' },
      rememberable: true
    })
    expect(classifyTool({ kind: 'fetch', title: 'Fetch it' }, ROOT).input).toEqual({ title: 'Fetch it' })
  })

  it('anything else is AcpCall with the title and rawInput, never rememberable', () => {
    for (const kind of ['think', 'switch_mode', 'other', 'weird', undefined, 7]) {
      const c = classifyTool({ kind: kind as never, title: 'Do', rawInput: { a: 1 } }, ROOT)
      expect(c).toEqual({ toolName: 'AcpCall', input: { title: 'Do', rawInput: { a: 1 } }, rememberable: false })
    }
  })

  it('never throws on odd input', () => {
    for (const tc of [
      null,
      undefined,
      5,
      'x',
      [],
      { kind: 'edit', content: 'x', locations: 7 },
      { kind: 'edit', content: [null, 3, { type: 'diff' }, { type: 'diff', path: 5 }] }
    ] as never[]) {
      expect(() => classifyTool(tc, ROOT)).not.toThrow()
    }
    expect(classifyTool(null as never, ROOT).toolName).toBe('AcpCall')
  })
})

describe('acpRememberable (the card the permission event carries, re-judged for rules)', () => {
  it('an unclassified call is never remembered', () => {
    expect(acpRememberable('AcpCall', { title: 'Think', rawInput: {} }, ROOT)).toBe(false)
  })

  it('Bash, AcpRead and AcpFetch are remembered as the classification says', () => {
    expect(acpRememberable('Bash', { command: 'ls' }, ROOT)).toBe(true)
    expect(acpRememberable('AcpRead', { paths: ['/etc/hosts'] }, ROOT)).toBe(true)
    expect(acpRememberable('AcpFetch', { url: 'https://example.com' }, ROOT)).toBe(true)
  })

  it('an AcpEdit only when every path is inside the root', () => {
    expect(acpRememberable('AcpEdit', { paths: ['src/a.ts', '/work/proj/b.ts'], diffs: [] }, ROOT)).toBe(true)
    expect(acpRememberable('AcpEdit', { paths: ['src/a.ts', '/etc/passwd'], diffs: [] }, ROOT)).toBe(false)
    expect(acpRememberable('AcpEdit', { paths: ['../other/a.ts'] }, ROOT)).toBe(false)
    expect(acpRememberable('AcpEdit', { paths: ['/work/project-two/a.ts'] }, ROOT)).toBe(false)
  })

  it('a move (an AcpEdit marked move) is asked every time, even inside the root', () => {
    expect(acpRememberable('AcpEdit', { paths: ['src/a.ts'], diffs: [], move: true }, ROOT)).toBe(false)
  })

  it('an AcpEdit with no readable paths, or no root, is asked every time', () => {
    for (const input of [{ paths: [] }, {}, null, 'a.ts', { paths: 'src/a.ts' }, { paths: [7] }, { paths: ['a\0b'] }, { paths: [''] }]) {
      expect(acpRememberable('AcpEdit', input, ROOT)).toBe(false)
    }
    expect(acpRememberable('AcpEdit', { paths: ['src/a.ts'] }, '')).toBe(false)
  })

  it('agrees with classifyTool on the same call', () => {
    const calls = [
      { kind: 'edit', locations: [{ path: 'src/a.ts' }] },
      { kind: 'edit', locations: [{ path: '/etc/passwd' }] },
      { kind: 'move', locations: [{ path: 'src/a.ts' }] },
      { kind: 'delete', locations: [{ path: 'src/a.ts' }] },
      { kind: 'read', locations: [{ path: 'x' }] },
      { kind: 'think', title: 'Thinking' },
      { kind: 'execute', rawInput: { command: 'ls' } }
    ]
    for (const tc of calls) {
      const c = classifyTool(tc, ROOT)
      expect(acpRememberable(c.toolName, c.input, ROOT)).toBe(c.rememberable)
    }
  })

  it('any other tool name is asked every time (fail closed)', () => {
    for (const name of ['Edit', 'Write', 'AskUserQuestion', 'mcp__x__y', '']) expect(acpRememberable(name, {}, ROOT)).toBe(false)
  })
})
