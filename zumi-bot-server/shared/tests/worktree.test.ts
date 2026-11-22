import { describe, expect, it } from 'vitest'
import {
  gitStatusOf,
  isCachePath,
  isLinkPath,
  parseStatusV2,
  releaseBlock,
  sidebarFolder,
  worktreeBranch,
  worktreePath,
  worktreeSlug
} from '@zumibot/shared/worktree'

describe('worktree names', () => {
  it('slugs odd handles', () => {
    expect(worktreeSlug('Frontend Dev!', 'a1b2c3')).toBe('frontend-dev-a1b2c3')
    expect(worktreeSlug('ux_ui', 'a1b2c3')).toBe('ux-ui-a1b2c3')
    expect(worktreeSlug('--x--', 'a1b2c3')).toBe('x-a1b2c3')
    expect(worktreeSlug('!!!', 'a1b2c3')).toBe('chat-a1b2c3')
  })
  it('names branch and sibling folder', () => {
    expect(worktreeBranch('room-a1b2c3')).toBe('zumibot/room-a1b2c3')
    expect(worktreePath('/home/u/Angular/WebFrontend', 'fd-a1b2c3')).toBe('/home/u/Angular/WebFrontend-fd-a1b2c3')
    expect(worktreePath('/home/u/my repo/', 'x-000000')).toBe('/home/u/my repo-x-000000')
  })
})

describe('parseStatusV2', () => {
  it('parses porcelain v2', () => {
    const s = parseStatusV2(
      '# branch.oid 0123456789abcdef\n# branch.head main\n1 .M N... 100644 100644 100644 a b src/a.ts\n2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts\n? angular/node_modules\n? notes.md\n! dist/\n! docs/superpowers/specs/x.md\n'
    )
    expect(s).toEqual({
      oid: '0123456789abcdef',
      head: 'main',
      changed: ['src/a.ts', 'new.ts', 'angular/node_modules', 'notes.md'],
      ignored: ['dist/', 'docs/superpowers/specs/x.md']
    })
    expect(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n').head).toBeNull()
  })
  it('keeps spaces in a path and reads unmerged lines', () => {
    const s = parseStatusV2(
      '# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 a b my docs/a b.ts\n2 R. N... 100644 100644 100644 a b R100 new name.ts\told name.ts\nu UU N... 100644 100644 100644 100644 a b c conflict file.ts\n? new folder/x y.md\n'
    )
    expect(s.changed).toEqual(['my docs/a b.ts', 'new name.ts', 'conflict file.ts', 'new folder/x y.md'])
  })
})

describe('link and cache paths', () => {
  it('matches a link with or without a trailing slash', () => {
    expect(isLinkPath('angular/node_modules/', ['angular/node_modules'])).toBe(true)
    expect(isLinkPath('angular/node_modules', ['angular/node_modules'])).toBe(true)
    expect(isLinkPath('angular/node_modules/x', ['angular/node_modules'])).toBe(false)
  })
  it('matches cache segments and logs', () => {
    expect(isCachePath('.angular/cache/')).toBe(true)
    expect(isCachePath('a/dist/x.js')).toBe(true)
    expect(isCachePath('debug.log')).toBe(true)
    expect(isCachePath('docs/superpowers/plans/p.md')).toBe(false)
  })
})

describe('gitStatusOf', () => {
  it('counts changes without links', () => {
    const s = parseStatusV2('# branch.oid 0123456789abcdef\n# branch.head main\n? angular/node_modules\n')
    expect(gitStatusOf(s, ['angular/node_modules'])).toEqual({ branch: 'main', head: '0123456', changed: 0 })
  })
  it('reports a detached head as a null branch', () => {
    const s = parseStatusV2('# branch.oid 0123456789abcdef\n# branch.head (detached)\n? a.ts\n')
    expect(gitStatusOf(s, [])).toEqual({ branch: null, head: '0123456', changed: 1 })
  })
})

describe('releaseBlock', () => {
  const p = (t: string) => parseStatusV2('# branch.oid 0123456789abcdef\n' + t)
  it('blocks release in order', () => {
    expect(releaseBlock(p('# branch.head (detached)\n'), [])).toBe('detached')
    expect(releaseBlock(p('# branch.head b\n? a.ts\n'), [])).toBe('dirty')
    expect(releaseBlock(p('# branch.head b\n! docs/superpowers/plans/p.md\n'), [])).toBe('ignored')
    expect(
      releaseBlock(p('# branch.head b\n! angular/node_modules\n! dist/\n! .angular/cache/\n! debug.log\n'), ['angular/node_modules'])
    ).toBeNull()
  })
  it('puts dirty before ignored before detached', () => {
    expect(releaseBlock(p('# branch.head (detached)\n? a.ts\n! x.md\n'), [])).toBe('dirty')
    expect(releaseBlock(p('# branch.head (detached)\n! x.md\n'), [])).toBe('ignored')
  })
})

describe('sidebarFolder', () => {
  it('groups by picked folder', () => {
    expect(
      sidebarFolder({ cwd: '/r-x/angular', worktree: { root: '/r-x', branch: 'b', source: '/r', folder: '/r/angular', links: [] } })
    ).toBe('/r/angular')
    expect(sidebarFolder({ cwd: '/r' })).toBe('/r')
  })
})
