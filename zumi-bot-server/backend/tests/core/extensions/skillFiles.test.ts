import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import { listSkillDirs, readSkill, removeSkill, saveSkill } from '../../../src/core/extensions/skillFiles'
import { stampOf } from '../../../src/core/extensions/settingsFile'
import { isWindows } from '../../support/platform'

// A folder link needs no privilege on Windows as a junction; a file link needs symlinksWork.
const dirLink = isWindows ? 'junction' : undefined

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-skills-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const put = async (folder: string, text: string, files: Record<string, string> = {}) => {
  await fs.mkdir(join(root, folder), { recursive: true })
  await fs.writeFile(join(root, folder, 'SKILL.md'), text)
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(root, folder, name, '..'), { recursive: true })
    await fs.writeFile(join(root, folder, name), content)
  }
}

const SKILL = '---\nname: review\ndescription: Review code\nallowed-tools: Read, Grep\n# keep this comment\n---\n# Review\n\nDo it.\n'

describe('listSkillDirs', () => {
  it('maps each frontmatter name to its folder, skipping synced, .trash and folders with no SKILL.md', async () => {
    await put('review', SKILL)
    await put('folder-name', '---\nname: other-name\ndescription: x\n---\nbody\n')
    await put('synced', '---\nname: from-claude-ai\ndescription: x\n---\n')
    await put('.trash', '---\nname: trashed\ndescription: x\n---\n')
    await fs.mkdir(join(root, 'empty'))
    await fs.writeFile(join(root, 'loose.md'), 'x')
    const map = await listSkillDirs(root)
    expect([...map.keys()].sort()).toEqual(['other-name', 'review'])
    expect(map.get('review')).toBe(join(root, 'review'))
    expect(map.get('other-name')).toBe(join(root, 'folder-name'))
  })

  it('falls back to the folder name when the file has no name, and skips an unreadable file', async () => {
    await put('plain', 'just text, no frontmatter\n')
    await put('noname', '---\ndescription: x\n---\nbody\n')
    await put('broken', '---\nname: [unclosed\n---\nbody\n')
    const map = await listSkillDirs(root)
    expect([...map.keys()].sort()).toEqual(['noname', 'plain'])
  })

  it('is empty for a missing root', async () => {
    expect((await listSkillDirs(join(root, 'nope'))).size).toBe(0)
  })

  it('leaves out a symlinked skill folder, which this page does not edit', async () => {
    await put('real', SKILL)
    const elsewhere = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-skills-ext-'))
    try {
      await fs.writeFile(join(elsewhere, 'SKILL.md'), '---\nname: linked\ndescription: x\n---\n')
      await fs.symlink(elsewhere, join(root, 'linked'), dirLink)
      expect([...(await listSkillDirs(root)).keys()]).toEqual(['review'])
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('readSkill', () => {
  it('returns the description, body, sibling files and a stamp of SKILL.md', async () => {
    await put('review', SKILL, { 'script.sh': '#!/bin/sh\n', 'ref/notes.md': 'n' })
    const v = await readSkill(root, join(root, 'review'), 'user')
    expect(v).toEqual({
      scope: 'user',
      name: 'review',
      description: 'Review code',
      body: '# Review\n\nDo it.\n',
      // The native separator: the same string on POSIX.
      files: [join('ref', 'notes.md'), 'script.sh'],
      stamp: stampOf(SKILL)
    })
  })

  it('reads a multi-line description whole', async () => {
    await put('long', '---\nname: long\ndescription: |-\n  first line\n  second line\n---\nb\n')
    expect((await readSkill(root, join(root, 'long'), 'project')).description).toBe('first line\nsecond line')
  })

  it('caps the file list at 200', async () => {
    await put('many', SKILL.replace('review', 'many'))
    for (let i = 0; i < 230; i++) await fs.writeFile(join(root, 'many', `f${String(i).padStart(3, '0')}.txt`), '')
    expect((await readSkill(root, join(root, 'many'), 'user')).files).toHaveLength(200)
  })

  it('refuses a folder with no SKILL.md', async () => {
    await fs.mkdir(join(root, 'empty'))
    await expect(readSkill(root, join(root, 'empty'), 'user')).rejects.toThrow(EXT_TEXT.notFound)
  })
})

describe('saveSkill', () => {
  it('creates <root>/<name>/SKILL.md with name, description and body', async () => {
    await saveSkill(join(root, 'skills'), { name: 'my-skill', description: 'Does: a thing # really', body: '# Hi\n' })
    const text = await fs.readFile(join(root, 'skills', 'my-skill', 'SKILL.md'), 'utf8')
    expect(text).toBe('---\nname: my-skill\ndescription: "Does: a thing # really"\n---\n# Hi\n')
    const v = await readSkill(join(root, 'skills'), join(root, 'skills', 'my-skill'), 'user')
    expect(v).toMatchObject({ name: 'my-skill', description: 'Does: a thing # really', body: '# Hi\n', files: [] })
  })

  it('ends a new skill body with a newline', async () => {
    await saveSkill(root, { name: 'a', description: 'd', body: 'text' })
    expect(await fs.readFile(join(root, 'a', 'SKILL.md'), 'utf8')).toBe('---\nname: a\ndescription: d\n---\ntext\n')
  })

  it.each(['Bad Name', 'a/b', '../x', '..', 'a--b', '-a', '', 'a'.repeat(101)])('refuses the new name %j', async (name) => {
    await expect(saveSkill(root, { name, description: 'd', body: '' })).rejects.toThrow(EXT_TEXT.badName)
    expect(await fs.readdir(root)).toEqual([])
  })

  it('refuses a new name whose folder is taken by something else', async () => {
    await put('taken', '---\nname: other\ndescription: x\n---\n')
    await expect(saveSkill(root, { name: 'taken', description: 'd', body: '' })).rejects.toThrow(EXT_TEXT.notEditable)
    expect((await fs.readFile(join(root, 'taken', 'SKILL.md'), 'utf8')).includes('name: other')).toBe(true)
  })

  it('refuses a stamp for a skill that is not there', async () => {
    await expect(saveSkill(root, { name: 'ghost', description: 'd', body: '', stamp: 'abc' })).rejects.toThrow(EXT_TEXT.notFound)
    expect(await fs.readdir(root)).toEqual([])
  })

  it('edits only description and body: other keys, comments and sibling files stay', async () => {
    await put('review', SKILL, { 'script.sh': '#!/bin/sh\necho hi\n' })
    const { stamp } = await readSkill(root, join(root, 'review'), 'user')
    await saveSkill(root, { name: 'review', description: 'Review code, twice', body: 'New body.\n', stamp })
    const text = await fs.readFile(join(root, 'review', 'SKILL.md'), 'utf8')
    expect(text).toContain('allowed-tools: Read, Grep')
    expect(text).toContain('# keep this comment')
    expect(text).toContain('name: review')
    expect(text).toContain('description: Review code, twice')
    expect(text.endsWith('---\nNew body.\n')).toBe(true)
    expect(await fs.readFile(join(root, 'review', 'script.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
    // The folder keeps its name even when the skill's name is edited elsewhere.
    expect(await fs.readdir(root)).toEqual(['review'])
  })

  it('splices the frontmatter verbatim when only the body changes', async () => {
    const odd = '---\nname:   review\ndescription:    "Review   code"\nallowed-tools: [Read,   Grep]\n---\nold\n'
    await put('review', odd)
    await saveSkill(root, { name: 'review', description: 'Review   code', body: 'new\n' })
    expect(await fs.readFile(join(root, 'review', 'SKILL.md'), 'utf8')).toBe(odd.replace('old', 'new'))
  })

  it('finds an existing skill by its frontmatter name, not its folder', async () => {
    await put('folder-name', '---\nname: other-name\ndescription: old\n---\nb\n')
    await saveSkill(root, { name: 'other-name', description: 'new', body: 'b2\n' })
    expect(await fs.readdir(root)).toEqual(['folder-name'])
    expect(await fs.readFile(join(root, 'folder-name', 'SKILL.md'), 'utf8')).toBe('---\nname: other-name\ndescription: new\n---\nb2\n')
  })

  it('refuses an edit whose stamp is stale, changing nothing', async () => {
    await put('review', SKILL)
    const { stamp } = await readSkill(root, join(root, 'review'), 'user')
    await fs.writeFile(join(root, 'review', 'SKILL.md'), SKILL + 'more\n')
    await expect(saveSkill(root, { name: 'review', description: 'x', body: 'y', stamp })).rejects.toThrow(EXT_TEXT.stale)
    expect(await fs.readFile(join(root, 'review', 'SKILL.md'), 'utf8')).toBe(SKILL + 'more\n')
  })

  it('adds a frontmatter block to a skill that has none', async () => {
    await put('plain', 'old text\n')
    await saveSkill(root, { name: 'plain', description: 'now described', body: 'new text\n' })
    expect(await fs.readFile(join(root, 'plain', 'SKILL.md'), 'utf8')).toBe('---\nname: plain\ndescription: now described\n---\nnew text\n')
  })

  it('refuses to put a description into a frontmatter that is no map, leaving the file', async () => {
    await put('odd', '---\njust text\n---\nbody\n')
    await expect(saveSkill(root, { name: 'odd', description: 'd', body: 'b' })).rejects.toThrow(EXT_TEXT.notEditable)
    expect(await fs.readFile(join(root, 'odd', 'SKILL.md'), 'utf8')).toBe('---\njust text\n---\nbody\n')
  })

  it('keeps CRLF line ends of an edited file', async () => {
    await put('crlf', '---\r\nname: crlf\r\ndescription: old\r\n---\r\nbody\r\n')
    await saveSkill(root, { name: 'crlf', description: 'new', body: 'body2\r\n' })
    expect(await fs.readFile(join(root, 'crlf', 'SKILL.md'), 'utf8')).toBe('---\r\nname: crlf\r\ndescription: new\r\n---\r\nbody2\r\n')
  })

  it('keeps the file mode and leaves no temp file', async () => {
    await put('review', SKILL)
    await fs.chmod(join(root, 'review', 'SKILL.md'), 0o640)
    await saveSkill(root, { name: 'review', description: 'changed', body: 'b\n' })
    if (process.platform !== 'win32') expect((await fs.stat(join(root, 'review', 'SKILL.md'))).mode & 0o777).toBe(0o640)
    expect((await fs.readdir(join(root, 'review'))).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('removeSkill', () => {
  it('hands the whole skill folder to the trash', async () => {
    await put('review', SKILL, { 'script.sh': 'x' })
    const trash = vi.fn(async () => {})
    await removeSkill(root, join(root, 'review'), trash)
    expect(trash).toHaveBeenCalledExactlyOnceWith(join(root, 'review'))
  })

  it('refuses a folder that holds no SKILL.md, calling nothing', async () => {
    await fs.mkdir(join(root, 'docs'))
    const trash = vi.fn(async () => {})
    await expect(removeSkill(root, join(root, 'docs'), trash)).rejects.toThrow(EXT_TEXT.notFound)
    await expect(removeSkill(root, join(root, 'missing'), trash)).rejects.toThrow(EXT_TEXT.notFound)
    expect(trash).not.toHaveBeenCalled()
  })
})

describe('a skill folder must be a direct child of its root', () => {
  const outside = async (): Promise<string> => {
    const other = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-skills-out-'))
    await fs.writeFile(join(other, 'SKILL.md'), '---\nname: out\ndescription: x\n---\n')
    return other
  }

  it('readSkill and removeSkill refuse the root itself, even with a SKILL.md at its top', async () => {
    await put('', SKILL)
    const trash = vi.fn(async () => {})
    await expect(removeSkill(root, root, trash)).rejects.toThrow(EXT_TEXT.notFound)
    await expect(removeSkill(root, root + '/', trash)).rejects.toThrow(EXT_TEXT.notFound)
    await expect(readSkill(root, root, 'user')).rejects.toThrow(EXT_TEXT.notFound)
    expect(trash).not.toHaveBeenCalled()
  })

  it('refuse a .. path, whether or not it lands on a skill', async () => {
    await put('review', SKILL)
    const trash = vi.fn(async () => {})
    for (const bad of [
      join(root, 'review', '..'),
      join(root, 'review', '..', '..'),
      join(root, '..', 'review'),
      root + '/review/../review/..'
    ]) {
      await expect(removeSkill(root, bad, trash)).rejects.toThrow(EXT_TEXT.notFound)
      await expect(readSkill(root, bad, 'user')).rejects.toThrow(EXT_TEXT.notFound)
    }
    expect(trash).not.toHaveBeenCalled()
  })

  it('refuse a skill folder outside the root, with no path in the error', async () => {
    const other = await outside()
    try {
      const trash = vi.fn(async () => {})
      const err = await removeSkill(root, other, trash).catch((e: Error) => e)
      expect((err as Error).message).toBe(EXT_TEXT.notFound)
      await expect(readSkill(root, other, 'user')).rejects.toThrow(EXT_TEXT.notFound)
      expect(trash).not.toHaveBeenCalled()
    } finally {
      await fs.rm(other, { recursive: true, force: true })
    }
  })

  it('refuse a nested skill folder, two levels down', async () => {
    await put('group/inner', SKILL.replace('review', 'inner'))
    await put('group', SKILL.replace('review', 'group'))
    const trash = vi.fn(async () => {})
    await expect(removeSkill(root, join(root, 'group', 'inner'), trash)).rejects.toThrow(EXT_TEXT.notFound)
    await expect(readSkill(root, join(root, 'group', 'inner'), 'user')).rejects.toThrow(EXT_TEXT.notFound)
    expect(trash).not.toHaveBeenCalled()
  })

  it('still read and remove a direct child folder, given with a trailing slash too', async () => {
    await put('review', SKILL)
    expect((await readSkill(root, join(root, 'review') + '/', 'user')).name).toBe('review')
    const trash = vi.fn(async () => {})
    await removeSkill(root, join(root, 'review') + '/', trash)
    expect(trash).toHaveBeenCalledExactlyOnceWith(join(root, 'review'))
  })
})

// Ruling 25: a project skills root (`<folder>/.claude/skills`) is written only where it really lies in the folder.
describe('project skills and links (Ruling 25)', () => {
  const setup = async () => {
    const folder = join(root, 'proj')
    const outside = join(root, 'outside')
    await fs.mkdir(folder, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    return { folder, outside, skills: join(folder, '.claude', 'skills') }
  }

  it('refuses a .claude/skills folder that is a link to elsewhere: no create, no edit, no remove', async () => {
    const { folder, outside, skills } = await setup()
    await fs.mkdir(join(outside, 'review'))
    await fs.writeFile(join(outside, 'review', 'SKILL.md'), SKILL)
    await fs.mkdir(join(folder, '.claude'))
    await fs.symlink(outside, skills, dirLink)
    await expect(saveSkill(skills, { name: 'new-one', description: 'd', body: 'b' }, folder)).rejects.toThrow(EXT_TEXT.notEditable)
    await expect(saveSkill(skills, { name: 'review', description: 'changed', body: 'b' }, folder)).rejects.toThrow(EXT_TEXT.notEditable)
    const trash = vi.fn(async () => {})
    await expect(removeSkill(skills, join(skills, 'review'), trash, folder)).rejects.toThrow(EXT_TEXT.notEditable)
    expect(trash).not.toHaveBeenCalled()
    expect((await fs.readdir(outside)).sort()).toEqual(['review'])
    expect(await fs.readFile(join(outside, 'review', 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('refuses a .claude folder that is a link to elsewhere, creating nothing there', async () => {
    const { folder, outside, skills } = await setup()
    await fs.symlink(outside, join(folder, '.claude'), dirLink)
    await expect(saveSkill(skills, { name: 'new-one', description: 'd', body: 'b' }, folder)).rejects.toThrow(EXT_TEXT.notEditable)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('refuses a dangling skills link', async () => {
    const { folder, outside, skills } = await setup()
    await fs.mkdir(join(folder, '.claude'))
    await fs.symlink(join(outside, 'gone'), skills, dirLink)
    await expect(saveSkill(skills, { name: 'new-one', description: 'd', body: 'b' }, folder)).rejects.toThrow(EXT_TEXT.notEditable)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('creates a project skill that really lies in the folder', async () => {
    const { folder, skills } = await setup()
    await saveSkill(skills, { name: 'new-one', description: 'd', body: 'b' }, folder)
    expect(await fs.readFile(join(skills, 'new-one', 'SKILL.md'), 'utf8')).toContain('name: new-one')
    const trash = vi.fn(async () => {})
    await removeSkill(skills, join(skills, 'new-one'), trash, folder)
    expect(trash).toHaveBeenCalledWith(join(skills, 'new-one'))
  })
})
