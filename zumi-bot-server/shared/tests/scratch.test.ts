import { describe, expect, it } from 'vitest'
import { isScratchFolder, isScratchRoot, scratchChild, scratchName, scratchParent, scratchRoot } from '../src/scratch'
import { sidebarFolder } from '../src/worktree'

describe('scratch folders', () => {
  it('lives under <home>/zumibot/cache', () => {
    expect(scratchRoot('/home/me')).toBe('/home/me/zumibot/cache')
    expect(scratchRoot('/home/me/')).toBe('/home/me/zumibot/cache')
    expect(scratchName(new Date('2026-11-18T10:00:00Z'), 'ab12cd34')).toBe('2026-11-18-ab12cd34')
  })

  it("tells the root from a chat's own folder", () => {
    expect(isScratchRoot('/home/me/zumibot/cache')).toBe(true)
    expect(isScratchFolder('/home/me/zumibot/cache')).toBe(false)
    expect(isScratchFolder('/home/me/zumibot/cache/2026-11-18-ab12cd34')).toBe(true)
    expect(isScratchFolder('/home/me/zumibot/cache/a/b')).toBe(false)
    expect(isScratchFolder('/home/me/code/site')).toBe(false)
    expect(scratchParent('/home/me/zumibot/cache/2026-11-18-ab12cd34')).toBe('/home/me/zumibot/cache')
  })

  it('groups every scratch chat under the root in the sidebar', () => {
    expect(sidebarFolder({ cwd: '/home/me/zumibot/cache/2026-11-18-ab12cd34' })).toBe('/home/me/zumibot/cache')
    expect(sidebarFolder({ cwd: '/home/me/code/site' })).toBe('/home/me/code/site')
  })

  it('keeps a Windows home in backslashes, never a mix', () => {
    expect(scratchRoot('C:\\Users\\me')).toBe('C:\\Users\\me\\zumibot\\cache')
    expect(scratchChild('C:\\Users\\me', '2026-11-18-ab12cd34')).toBe('C:\\Users\\me\\zumibot\\cache\\2026-11-18-ab12cd34')
    expect(scratchChild('/home/me', 'x')).toBe('/home/me/zumibot/cache/x')
    expect(isScratchRoot('C:\\Users\\me\\zumibot\\cache')).toBe(true)
    expect(isScratchFolder('C:\\Users\\me\\zumibot\\cache\\2026-11-18-ab12cd34')).toBe(true)
    expect(sidebarFolder({ cwd: 'C:\\Users\\me\\zumibot\\cache\\2026-11-18-ab12cd34' })).toBe('C:\\Users\\me\\zumibot\\cache')
  })
})
