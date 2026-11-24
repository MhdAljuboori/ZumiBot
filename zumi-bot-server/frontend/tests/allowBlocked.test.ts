import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import {
  allHeld,
  allowCardState,
  canAllowBlocked,
  chosenFolders,
  chosenPrefixes,
  gitAfterFolder,
  inLatestTurn,
  sheetRows
} from '../src/state/allowBlocked'

type ToolItem = Extract<ChatItem, { type: 'tool' }>

const tool = (over: Partial<ToolItem> = {}): ToolItem => ({
  type: 'tool',
  id: 't1',
  name: 'Bash',
  input: { command: 'git branch -D a' },
  result: null,
  isError: false,
  blocked: true,
  blockedBy: 'classifier',
  ts: 1,
  ...over
})
const chat = (over: Partial<ChatMeta> = {}): ChatMeta => ({ id: 'c1', agentName: 'dev', ...over }) as ChatMeta

describe('allowBlocked: canAllowBlocked', () => {
  it('is true for a classifier-refused Bash call in a plain idle chat', () => {
    expect(canAllowBlocked(tool(), chat(), false)).toBe(true)
  })
  it.each([
    ['another tool', tool({ name: 'Read' })],
    ['no classifier mark', tool({ blockedBy: undefined })],
    ['a non-string command', tool({ input: { command: 3 } })],
    ['no command', tool({ input: {} })],
    ['a live turn', tool({ turn: 'x' })],
    ['already allowed', tool({ allowedAs: 'chat' })],
    ['a zumi-bot row', tool({ agent: 'zumi-bot' })]
  ])('is false for %s', (_n, item) => {
    expect(canAllowBlocked(item, chat(), false)).toBe(false)
  })
  it('is false for zumi-bot as the chat agent, a workflow chat, a test chat or a running chat', () => {
    expect(canAllowBlocked(tool(), chat({ agentName: 'zumi-bot' }), false)).toBe(false)
    expect(canAllowBlocked(tool(), chat({ workflow: { workflowId: 'w' } as ChatMeta['workflow'] }), false)).toBe(false)
    expect(canAllowBlocked(tool(), chat({ workflowTest: 'W' }), false)).toBe(false)
    expect(canAllowBlocked(tool(), chat(), true)).toBe(false)
  })
  it("uses the row's agent in a room, whose chat agent is empty", () => {
    expect(canAllowBlocked(tool({ agent: 'dev' }), chat({ agentName: '' }), false)).toBe(true)
    expect(canAllowBlocked(tool(), chat({ agentName: '' }), false)).toBe(false)
  })
})

const script = 'C=/r; cd $C\ngit branch -D a\ngit push origin :a | tail -1'

describe('allowBlocked: sheetRows', () => {
  it('lists every part with a suggested prefix, the safe ones unticked', () => {
    const rows = sheetRows(script, [])
    expect(rows.map((r) => r.part)).toEqual(['cd $C', 'git branch -D a', 'git push origin :a', 'tail -1'])
    expect(rows.map((r) => r.ticked)).toEqual([false, true, true, false])
    expect(rows[1].prefix).toBe('git branch -D')
    expect(rows.every((r) => r.heldBy === null)).toBe(true)
  })
  it('marks a part a held rule covers as held and ticked', () => {
    const rows = sheetRows(script, ['Bash(git branch -D:*)'])
    expect(rows[1].heldBy).toBe('Bash(git branch -D:*)')
    expect(rows[1].ticked).toBe(true)
    expect(rows[2].heldBy).toBeNull()
  })
  it('allHeld is true only when every ticked row is held', () => {
    expect(allHeld(sheetRows(script, []))).toBe(false)
    expect(allHeld(sheetRows(script, ['Bash(git branch -D:*)']))).toBe(false)
    expect(allHeld(sheetRows(script, ['Bash(git branch -D:*)', 'Bash(git push origin:*)']))).toBe(true)
    // Nothing ticked is not "all held": the sheet just has nothing to allow.
    expect(allHeld(sheetRows('ls -la', []))).toBe(false)
  })
})

describe('allowBlocked: sheetRows with a wrapper-led part', () => {
  it('shows a part led by a shell or wrapper unticked, with its reason and no prefix', () => {
    const rows = sheetRows('timeout 30 git push origin x\ngit branch -D a\n$SHELL -c x', [])
    expect(rows.map((r) => r.part)).toEqual(['timeout 30 git push origin x', 'git branch -D a', '$SHELL -c x'])
    expect(rows.map((r) => r.ticked)).toEqual([false, true, false])
    expect(rows[0].prefix).toBe('')
    expect(rows[0].refused).toMatch(/Auto ignores/)
    expect(rows[1].refused).toBeNull()
    expect(rows[2].refused).toMatch(/Auto ignores/)
  })
  it('is never ticked even if a held rule would cover it, and chosenPrefixes skips it', () => {
    const rows = sheetRows('nohup git push', ['Bash(nohup:*)'])
    expect(rows[0].ticked).toBe(false)
    expect(chosenPrefixes(rows, 'nohup git push')).toEqual({ prefixes: [], errors: [null] })
  })
})

describe('allowBlocked: inLatestTurn', () => {
  const user = (id: string): ChatItem => ({ type: 'user', id, text: 'x', ts: 1 }) as ChatItem
  it('is true when no user message comes after the tool row', () => {
    expect(inLatestTurn([user('u1'), tool()], 't1')).toBe(true)
  })
  it('is false when a user message comes after it', () => {
    expect(inLatestTurn([user('u1'), tool(), user('u2')], 't1')).toBe(false)
  })
  it('is false when the tool id is not found', () => {
    expect(inLatestTurn([user('u1'), tool()], 'nope')).toBe(false)
  })
})

describe('allowBlocked: allowCardState', () => {
  it('is pending for an allowable row in the latest turn', () => {
    expect(allowCardState(tool(), chat(), false, true)).toBe('pending')
  })
  it('is collapsed for an allowable row in an older turn', () => {
    expect(allowCardState(tool(), chat(), false, false)).toBe('collapsed')
  })
  it('is running while the chat runs, in the latest turn or not', () => {
    expect(allowCardState(tool(), chat(), true, true)).toBe('running')
    expect(allowCardState(tool(), chat(), true, false)).toBe('running')
  })
  it('is done once allowed, whatever else holds', () => {
    expect(allowCardState(tool({ allowedAs: 'chat' }), chat(), false, true)).toBe('done')
    expect(allowCardState(tool({ allowedAs: 'agent' }), chat(), true, false)).toBe('done')
  })
  it.each([
    ['another tool', tool({ name: 'Read' }), chat()],
    ['no classifier mark', tool({ blockedBy: undefined }), chat()],
    ['a non-string command', tool({ input: { command: 3 } }), chat()],
    ['no command', tool({ input: {} }), chat()],
    ['a zumi-bot row', tool({ agent: 'zumi-bot' }), chat()],
    ['zumi-bot as the chat agent', tool(), chat({ agentName: 'zumi-bot' })],
    ['an empty agent', tool(), chat({ agentName: '' })],
    ['a workflow chat', tool(), chat({ workflow: { workflowId: 'w' } as ChatMeta['workflow'] })],
    ['a workflow test chat', tool(), chat({ workflowTest: 'W' })],
    ['a turn that never ended', tool({ turn: 'x' }), chat()]
  ])('is hidden for %s', (_n, item, c) => {
    expect(allowCardState(item, c, false, true)).toBe('hidden')
    expect(allowCardState(item, c, true, true)).toBe('hidden')
  })
  it("uses the row's agent in a room", () => {
    expect(allowCardState(tool({ agent: 'dev' }), chat({ agentName: '' }), false, true)).toBe('pending')
  })
  it('agrees with canAllowBlocked', () => {
    expect(canAllowBlocked(tool(), chat(), false)).toBe(allowCardState(tool(), chat(), false, true) === 'pending')
  })
})

describe('allowBlocked: chosenPrefixes', () => {
  const command = script
  it('trims, skips held and unticked rows, and drops repeats', () => {
    const rows = [
      { part: 'git branch -D a', prefix: '  git branch -D ', ticked: true, heldBy: null, refused: null },
      { part: 'git push origin :a', prefix: 'git push origin', ticked: true, heldBy: 'Bash(git push origin:*)', refused: null },
      { part: 'tail -1', prefix: 'tail', ticked: false, heldBy: null, refused: null },
      { part: 'git branch -D a', prefix: 'git branch -D', ticked: true, heldBy: null, refused: null }
    ]
    expect(chosenPrefixes(rows, command)).toEqual({ prefixes: ['git branch -D'], errors: [null, null, null, null] })
  })
  it('reports an error per ticked row with a bad prefix', () => {
    const rows = [
      { part: 'git branch -D a', prefix: 'git tag', ticked: true, heldBy: null, refused: null },
      { part: 'git push origin :a', prefix: 'git push origin', ticked: true, heldBy: null, refused: null }
    ]
    const r = chosenPrefixes(rows, command)
    expect(r.errors[0]).toMatch(/start of one command/)
    expect(r.errors[1]).toBeNull()
  })
})

describe('allowBlocked: folder rows', () => {
  const cmd = 'cd /work/repo && gh pr view 1 && gh pr merge 1; cd /cwd/sub && ls'
  it('offers a cd outside the chat folder as a ticked folder row with no prefix, and none for one inside', () => {
    const rows = sheetRows(cmd, [], '/cwd')
    expect(rows.map((r) => r.folder)).toEqual(['/work/repo', null, null, null, null])
    expect(rows[0]).toMatchObject({ part: 'cd /work/repo', folder: '/work/repo', prefix: '', ticked: true, heldBy: null, refused: null })
    expect(rows[3]).toMatchObject({ part: 'cd /cwd/sub', folder: null, ticked: false })
  })
  it('treats the chat folder itself and a sibling whose name starts the same correctly', () => {
    expect(sheetRows('cd /cwd && make x', [], '/cwd')[0].folder).toBeNull()
    expect(sheetRows('cd /cwd-loc/x && make x', [], '/cwd')[0].folder).toBe('/cwd-loc/x')
  })
  it('marks a folder a held Read rule covers as held', () => {
    const rows = sheetRows(cmd, ['Read(//work/repo/**)'], '/cwd')
    expect(rows[0].heldBy).toBe('Read(//work/repo/**)')
    expect(chosenFolders(rows)).toEqual([])
  })
  it("the reported case: every Bash part held but not the folder, so it is not stuck and the click sends the folder alone", () => {
    const user =
      `cd /home/u/Dev/OC-loc && gh pr view 242 --json state --jq '.state+" "+.x' && gh pr merge 242 --merge; gh pr view 242 --json state`
    const held = ['Bash(gh pr view:*)', 'Bash(gh pr merge:*)']
    const rows = sheetRows(user, held, '/home/u/Dev/OC')
    expect(allHeld(rows)).toBe(false)
    expect(chosenFolders(rows)).toEqual(['/home/u/Dev/OC-loc'])
    expect(chosenPrefixes(rows, user)).toEqual({ prefixes: [], errors: [null, null, null, null] })
    expect(allHeld(sheetRows(user, [...held, 'Read(//home/u/Dev/OC-loc/**)'], '/home/u/Dev/OC'))).toBe(true)
  })
  it('shows a folder that holds too much unticked with its reason', () => {
    const rows = sheetRows('cd /etc && make x', [], '/cwd')
    expect(rows[0]).toMatchObject({ folder: '/etc', ticked: false })
    expect(rows[0].refused).toMatch(/narrower/)
    expect(chosenFolders(rows)).toEqual([])
  })
  it('chosenFolders skips unticked rows and repeats', () => {
    const rows = sheetRows('cd /work/repo && make; cd /work/repo/ && make y', [], '/cwd')
    expect(chosenFolders(rows)).toEqual(['/work/repo'])
    expect(chosenFolders(rows.map((r) => ({ ...r, ticked: false })))).toEqual([])
  })
  it('gitAfterFolder names the folder a command enters before running git', () => {
    expect(gitAfterFolder(sheetRows('cd /work/repo && git push origin x', [], '/cwd'))).toBe('/work/repo')
    expect(gitAfterFolder(sheetRows('git status; cd /work/repo && gh pr view 1', [], '/cwd'))).toBeNull()
    expect(gitAfterFolder(sheetRows('cd /cwd/sub && git push', [], '/cwd'))).toBeNull()
  })
})
