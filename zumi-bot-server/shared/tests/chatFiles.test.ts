import { describe, expect, it } from 'vitest'
import { isBookkeeping, listChatFiles, resolvePath, shownPath } from '@zumibot/shared/chatFiles'
import type { FileChange } from '@zumibot/shared/files'
import type { ChatItem } from '@zumibot/shared/types'

const change = (id: string, ts: number, path: string, extra: Partial<FileChange> = {}): FileChange => ({
  id,
  ts,
  path,
  op: 'update',
  patch: null,
  before: null,
  after: null,
  ...extra
})

function tool(id: string, ts: number, over: Partial<Extract<ChatItem, { type: 'tool' }>> = {}): ChatItem {
  return { type: 'tool', id, name: 'Edit', input: {}, result: 'ok', isError: false, blocked: false, ts, ...over }
}

describe('resolvePath', () => {
  it('joins a relative path to cwd and folds ..', () => {
    expect(resolvePath('a/../b.txt', '/w')).toBe('/w/b.txt')
  })
  it('normalizes an absolute path', () => {
    expect(resolvePath('/x//y/./z', '/w')).toBe('/x/y/z')
  })
  it('does not climb above the root', () => {
    expect(resolvePath('../../a', '/w')).toBe('/a')
  })
})

describe('shownPath', () => {
  it('is relative inside cwd', () => {
    expect(shownPath('/w/d/a.md', '/w', '/h')).toBe('d/a.md')
  })
  it('uses ~ inside home', () => {
    expect(shownPath('/h/n.txt', '/w', '/h')).toBe('~/n.txt')
  })
  it('keeps other paths whole', () => {
    expect(shownPath('/etc/x', '/w', '/h')).toBe('/etc/x')
  })
  it('does not treat a sibling with the same prefix as inside', () => {
    expect(shownPath('/work/a', '/w', '/h')).toBe('/work/a')
  })
})

describe('isBookkeeping', () => {
  it('matches project memory and plans', () => {
    expect(isBookkeeping('/h/.claude/projects/p/memory/x.md', '/h')).toBe(true)
    expect(isBookkeeping('/h/.claude/plans/p.md', '/h')).toBe(true)
  })
  it('matches agent memory', () => {
    expect(isBookkeeping('/h/.claude/agent-memory/writer/MEMORY.md', '/h')).toBe(true)
    expect(isBookkeeping('/h/.claude/agent-memory/writer/notes/x.md', '/h')).toBe(true)
  })
  it('matches the same folders under a CLAUDE_CONFIG_DIR', () => {
    expect(isBookkeeping('/cfg/agent-memory/writer/x.md', '/h', '/cfg')).toBe(true)
    expect(isBookkeeping('/cfg/plans/p.md', '/h', '/cfg')).toBe(true)
    expect(isBookkeeping('/cfg/agents/a.md', '/h', '/cfg')).toBe(false)
  })
  it('leaves other .claude files alone', () => {
    expect(isBookkeeping('/h/.claude/agents/a.md', '/h')).toBe(false)
    expect(isBookkeeping('/h/work/agent-memory/x.md', '/h')).toBe(false)
  })
})

describe('listChatFiles', () => {
  it('groups by path, oldest step first, newest file first', () => {
    const items = [
      tool('t1', 10, { changes: [change('c1', 10, '/w/a.md')] }),
      tool('t2', 20, { changes: [change('c2', 20, '/w/b.md')] }),
      tool('t3', 30, { changes: [change('c3', 30, '/w/a.md')] })
    ]
    const { changed } = listChatFiles(items, '/w', '/h')
    expect(changed.map((f) => f.path)).toEqual(['/w/a.md', '/w/b.md'])
    expect(changed[0].changes.map((s) => s.ts)).toEqual([10, 30])
    expect(changed[0].shown).toBe('a.md')
    expect(changed[0].created).toBe(false)
  })

  it('marks a file created when its first step creates it', () => {
    const items = [
      tool('t1', 10, { name: 'Write', changes: [change('c1', 10, '/w/n.md', { op: 'create' })] }),
      tool('t2', 20, { changes: [change('c2', 20, '/w/n.md')] })
    ]
    expect(listChatFiles(items, '/w', '/h').changed[0].created).toBe(true)
  })

  it('splits an Agent item into files, keeping itemId, agent and subagent', () => {
    const items = [
      tool('ag', 10, {
        name: 'Agent',
        agent: 'boss',
        changes: [change('c1', 11, '/w/a.md', { subagent: 'sub' }), change('c2', 12, '/w/b.md', { subagent: 'sub' })]
      })
    ]
    const { changed } = listChatFiles(items, '/w', '/h')
    expect(changed).toHaveLength(2)
    for (const f of changed) {
      expect(f.changes[0].itemId).toBe('ag')
      expect(f.changes[0].agent).toBe('boss')
      expect(f.changes[0].subagent).toBe('sub')
    }
  })

  it('lists a legacy Edit with its strings', () => {
    const items = [tool('t1', 10, { input: { file_path: 'a.md', old_string: 'x', new_string: 'y' } })]
    const [f] = listChatFiles(items, '/w', '/h').changed
    expect(f.path).toBe('/w/a.md')
    expect(f.changes[0]).toMatchObject({ itemId: 't1', op: 'update', legacy: { oldString: 'x', newString: 'y' }, patch: null })
  })

  it('lists a legacy Write as unknown with its content', () => {
    const items = [tool('t1', 10, { name: 'Write', input: { file_path: '/w/n.md', content: 'hi' } })]
    expect(listChatFiles(items, '/w', '/h').changed[0].changes[0]).toMatchObject({ op: 'unknown', legacy: { content: 'hi' } })
  })

  it('skips a failed, blocked, unfinished or malformed legacy item', () => {
    const input = { file_path: '/w/a.md', old_string: 'x', new_string: 'y' }
    const items = [
      tool('e', 1, { input, isError: true }),
      tool('b', 2, { input, blocked: true }),
      tool('r', 3, { input, result: null }),
      tool('m', 4, { input: { file_path: '/w/a.md', old_string: 1, new_string: 'y' } }),
      tool('n', 5, { input: null })
    ]
    expect(listChatFiles(items, '/w', '/h').changed).toEqual([])
  })

  it('does not double count an item that has changes', () => {
    const items = [
      tool('t1', 10, { input: { file_path: '/w/a.md', old_string: 'x', new_string: 'y' }, changes: [change('c1', 10, '/w/a.md')] })
    ]
    expect(listChatFiles(items, '/w', '/h').changed[0].changes).toHaveLength(1)
  })

  it('leaves out bookkeeping files', () => {
    const items = [tool('t1', 10, { changes: [change('c1', 10, '/h/.claude/projects/p/memory/m.md')] })]
    expect(listChatFiles(items, '/w', '/h').changed).toEqual([])
  })

  it('lists attachments of user items, newest first', () => {
    const att = (id: string) => ({ id, name: id, mime: 'text/plain', size: 1, kind: 'file' as const })
    const items: ChatItem[] = [
      { type: 'user', id: 'u1', text: '', ts: 5, attachments: [att('a'), att('b')] },
      { type: 'user', id: 'u2', text: '', ts: 9, attachments: [att('c')] },
      { type: 'user', id: 'u3', text: '', ts: 12 }
    ]
    const { attached } = listChatFiles(items, '/w', '/h')
    expect(attached.map((a) => a.attachment.id)).toEqual(['c', 'a', 'b'])
    expect(attached[0]).toMatchObject({ itemId: 'u2', ts: 9 })
  })
})

describe('Windows paths', () => {
  it('resolves drive paths with either slash, relative to a drive cwd', () => {
    expect(resolvePath('C:/proj/src/../a.ts', 'C:\\x')).toBe('C:\\proj\\a.ts')
    expect(resolvePath('src\\a.ts', 'c:\\proj')).toBe('C:\\proj\\src\\a.ts')
    expect(resolvePath('\\other\\b.ts', 'D:\\proj')).toBe('D:\\other\\b.ts')
  })
  it('shows paths under the cwd or home without letter case mattering', () => {
    expect(shownPath('C:\\Proj\\src\\a.ts', 'c:\\proj', 'C:\\Users\\u')).toBe('src/a.ts')
    expect(shownPath('C:\\Users\\u\\notes.md', 'C:\\proj', 'C:\\Users\\u')).toBe('~/notes.md')
    expect(shownPath('D:\\elsewhere.md', 'C:\\proj', 'C:\\Users\\u')).toBe('D:\\elsewhere.md')
  })
  it("recognises the CLI's own notes", () => {
    expect(isBookkeeping('C:\\Users\\u\\.claude\\plans\\p.md', 'C:\\Users\\u')).toBe(true)
    expect(isBookkeeping('C:\\Users\\u\\.claude\\projects\\C--proj\\memory\\m.md', 'C:\\Users\\u')).toBe(true)
    expect(isBookkeeping('C:\\Users\\u\\code\\plans\\p.md', 'C:\\Users\\u')).toBe(false)
  })
})
