import { describe, expect, it } from 'vitest'
import type { ChatWorktree, GitStatus } from '@zumibot/shared/types'
import { gitChipView, shouldRefetchGit, worktreeArchiveLine } from '../src/state/gitStatus'

const status = (changed: number, extra: Partial<GitStatus> = {}): GitStatus => ({ branch: 'main', head: 'abc1234', changed, ...extra })
const wt = (extra: Partial<ChatWorktree> = {}): ChatWorktree => ({
  root: '/r-x',
  branch: 'zumibot/x',
  source: '/r',
  folder: '/r',
  links: [],
  ...extra
})

describe('chip copy', () => {
  it('counts uncommitted changes', () => {
    const v = gitChipView(status(3))
    expect(v.title.startsWith('3 uncommitted changes')).toBe(true)
    expect(v.dirty).toBe(true)
    expect(v.label).toBe('main')
    expect(v.muted).toBe(false)
  })
  it('uses the singular for one change', () => {
    expect(gitChipView(status(1)).title).toBe('1 uncommitted change\nClick to see the changes')
  })
  it('says so when clean, and is not dirty', () => {
    const v = gitChipView(status(0))
    expect(v.title).toBe('No uncommitted changes\nClick to see the changes')
    expect(v.dirty).toBe(false)
  })
  it('shows the short sha when detached', () => {
    expect(gitChipView(status(0, { branch: null })).label).toBe('abc1234')
  })
  it('adds the worktree root line', () => {
    expect(gitChipView(status(2), wt()).title).toBe('2 uncommitted changes\nWorktree: /r-x\nClick to see the changes')
  })
  it("names the agent's own worktree when the status was read there, in place of the chat's", () => {
    const v = gitChipView(status(2, { branch: 'feature/x', agentTree: '/tmp/wt-x' }), wt())
    expect(v.label).toBe('feature/x')
    expect(v.title).toBe("2 uncommitted changes\nIn the agent's worktree: /tmp/wt-x\nClick to see the changes")
    expect(gitChipView(status(0, { agentTree: '/tmp/wt-x' })).title).toBe(
      "No uncommitted changes\nIn the agent's worktree: /tmp/wt-x\nClick to see the changes"
    )
  })
  it('a removed worktree is muted and names the kept branch instead of the count', () => {
    const v = gitChipView(status(0, { removed: true }), wt({ removed: true }))
    expect(v.muted).toBe(true)
    expect(v.dirty).toBe(false)
    expect(v.title).toBe('Worktree folder removed. Branch zumibot/x is kept.\nWorktree: /r-x')
  })
})

describe('refetch rule', () => {
  it('fetches when a chat opens', () => {
    expect(shouldRefetchGit(null, { chatId: 'a', inFlight: false })).toBe(true)
  })
  it('does not refetch while the same chat runs', () => {
    expect(shouldRefetchGit({ chatId: 'a', inFlight: true }, { chatId: 'a', inFlight: true })).toBe(false)
    expect(shouldRefetchGit({ chatId: 'a', inFlight: false }, { chatId: 'a', inFlight: true })).toBe(false)
    expect(shouldRefetchGit({ chatId: 'a', inFlight: false }, { chatId: 'a', inFlight: false })).toBe(false)
  })
  it('refetches when a turn ends', () => {
    expect(shouldRefetchGit({ chatId: 'a', inFlight: true }, { chatId: 'a', inFlight: false })).toBe(true)
  })
  it('refetches when another chat opens', () => {
    expect(shouldRefetchGit({ chatId: 'a', inFlight: true }, { chatId: 'b', inFlight: true })).toBe(true)
  })
})

describe('archive line', () => {
  it('says the folder was removed', () => {
    expect(worktreeArchiveLine(wt({ removed: true }))).toBe('Its worktree folder was removed. Branch zumibot/x is kept.')
  })
  it('gives the reason it was kept', () => {
    expect(worktreeArchiveLine(wt({ kept: 'ignored' }))).toBe('Its worktree was kept: ignored files that would be lost.')
    expect(worktreeArchiveLine(wt({ kept: 'dirty' }))).toBe('Its worktree was kept: uncommitted changes.')
    expect(worktreeArchiveLine(wt({ kept: 'detached' }))).toBe('Its worktree was kept: detached HEAD.')
    expect(worktreeArchiveLine(wt({ kept: 'shared' }))).toBe('Its worktree was kept: another chat uses it.')
    expect(worktreeArchiveLine(wt({ kept: 'failed' }))).toBe('Its worktree was kept: removing its folder failed.')
  })
  it('is null without a worktree or a release outcome', () => {
    expect(worktreeArchiveLine(undefined)).toBeNull()
    expect(worktreeArchiveLine(wt())).toBeNull()
  })
})
