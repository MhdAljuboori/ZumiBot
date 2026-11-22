import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import {
  editSettings,
  hookRows,
  removeHook,
  setHook,
  setSkillOverride,
  settingsPath,
  stampOf,
  writeSettings
} from '../../../src/core/extensions/settingsFile'
import { isWindows, symlinksWork } from '../../support/platform'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-settings-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const hooksOf = (text: string) => (JSON.parse(text) as { hooks?: Record<string, unknown> }).hooks

describe('stampOf', () => {
  it('is the sha256 hex of the text, and absent for a missing file', () => {
    expect(stampOf(null)).toBe('absent')
    expect(stampOf('')).toMatch(/^[0-9a-f]{64}$/)
    expect(stampOf('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
    expect(stampOf('a')).not.toBe(stampOf('b'))
  })
})

describe('editSettings', () => {
  it('creates a missing settings file holding only the edited key', () => {
    expect(editSettings(null, (s) => setSkillOverride(s, 'a', false))).toBe('{\n  "skillOverrides": {\n    "a": "off"\n  }\n}\n')
    expect(JSON.parse(editSettings(null, (s) => setSkillOverride(s, 'a', false)))).toEqual({ skillOverrides: { a: 'off' } })
  })

  it('treats an empty file as an empty object', () => {
    expect(JSON.parse(editSettings('  \n', (s) => setSkillOverride(s, 'a', false)))).toEqual({ skillOverrides: { a: 'off' } })
  })

  it('refuses invalid JSON and a non-object root with the fixed sentence', () => {
    const noop = () => {}
    expect(() => editSettings('{bad', noop)).toThrow(EXT_TEXT.badJson('settings file'))
    expect(() => editSettings('[1]', noop)).toThrow(EXT_TEXT.badJson('settings file'))
    expect(() => editSettings('null', noop)).toThrow(EXT_TEXT.badJson('settings file'))
    expect(() => editSettings('"x"', noop, 'Project settings.json')).toThrow(EXT_TEXT.badJson('Project settings.json'))
  })

  it('keeps the order of untouched keys and every unknown key when only hooks change', () => {
    const before = JSON.stringify(
      { model: 'opus', hooks: { Stop: [] }, permissions: { allow: ['Bash(ls:*)'] }, env: { A: '1' }, zzz: [1, 2] },
      null,
      2
    )
    const out = editSettings(before, (s) => setHook(s, { event: 'PreToolUse', matcher: 'Bash', command: 'echo hi' }))
    expect(Object.keys(JSON.parse(out))).toEqual(['model', 'hooks', 'permissions', 'env', 'zzz'])
    expect(JSON.parse(out)).toMatchObject({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, env: { A: '1' }, zzz: [1, 2] })
    expect(out.endsWith('}\n')).toBe(true)
  })

  it('round-trips a key named __proto__ without polluting anything', () => {
    const out = editSettings('{"__proto__": {"polluted": true}, "a": 1}', (s) => setSkillOverride(s, '__proto__', false))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(out).toContain('"polluted": true')
    expect(JSON.parse(out).skillOverrides).toEqual({ ['__proto__']: 'off' })
    expect(Object.keys(JSON.parse(out).skillOverrides)).toEqual(['__proto__'])
  })
})

describe('setSkillOverride', () => {
  it('writes exactly "off" and keeps other overrides', () => {
    const s: Record<string, unknown> = { skillOverrides: { b: 'off' } }
    setSkillOverride(s, 'a', false)
    expect(s).toEqual({ skillOverrides: { b: 'off', a: 'off' } })
  })

  it('deletes the key and an emptied skillOverrides when turned on', () => {
    const s: Record<string, unknown> = { model: 'x', skillOverrides: { a: 'off' } }
    setSkillOverride(s, 'a', true)
    expect(s).toEqual({ model: 'x' })
    const t: Record<string, unknown> = { skillOverrides: { a: 'off', b: 'off' } }
    setSkillOverride(t, 'a', true)
    expect(t).toEqual({ skillOverrides: { b: 'off' } })
  })

  it('is a no-op for turning on what is not overridden', () => {
    const s: Record<string, unknown> = { model: 'x' }
    setSkillOverride(s, 'a', true)
    expect(s).toEqual({ model: 'x' })
  })

  it('round-trips names with spaces, dots and colons', () => {
    const name = 'plugin:my.skill name'
    const out = editSettings('{"model":"x"}', (s) => setSkillOverride(s, name, false))
    expect(JSON.parse(out).skillOverrides[name]).toBe('off')
    expect(JSON.parse(editSettings(out, (s) => setSkillOverride(s, name, true)))).toEqual({ model: 'x' })
  })

  it('does not overwrite a skillOverrides value it does not understand', () => {
    const s: Record<string, unknown> = { skillOverrides: 'weird' }
    expect(() => setSkillOverride(s, 'a', false)).toThrow(EXT_TEXT.notEditable)
    expect(s).toEqual({ skillOverrides: 'weird' })
  })
})

describe('hookRows', () => {
  const text = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'a.sh', timeout: 5 },
            { type: 'prompt', prompt: 'x' }
          ]
        },
        { hooks: [{ type: 'command', command: 'b.sh' }] }
      ],
      Stop: 'not an array'
    }
  })

  it('lists one row per hook with its position, matcher and timeout', () => {
    expect(hookRows(text, 'user')).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', at: { group: 0, hook: 0 }, type: 'command', command: 'a.sh', timeout: 5 },
      { event: 'PreToolUse', matcher: 'Bash', at: { group: 0, hook: 1 }, type: 'prompt', command: '', timeout: null },
      { event: 'PreToolUse', matcher: '', at: { group: 1, hook: 0 }, type: 'command', command: 'b.sh', timeout: null }
    ])
  })

  it('lists a hook of an unknown shape with type unknown', () => {
    const rows = hookRows('{"hooks":{"Stop":[{"hooks":["x",{"command":"c"}]}]}}', 'project')
    expect(rows.map((r) => [r.type, r.command, r.at])).toEqual([
      ['unknown', '', { group: 0, hook: 0 }],
      ['unknown', '', { group: 0, hook: 1 }]
    ])
  })

  it('is empty for a missing file or no hooks key', () => {
    expect(hookRows(null, 'user')).toEqual([])
    expect(hookRows('{"model":"x"}', 'local')).toEqual([])
  })

  it('refuses invalid JSON naming the file kind', () => {
    expect(() => hookRows('{bad', 'local')).toThrow(/settings\.local\.json is not valid JSON/)
  })
})

describe('setHook and removeHook', () => {
  const edit = (before: Record<string, unknown>, f: (s: Record<string, unknown>) => void) => {
    f(before)
    return before
  }

  it('creates the event, the group and the hook in key order', () => {
    const s = edit({}, (o) => setHook(o, { event: 'PreToolUse', matcher: 'Bash', command: 'echo hi', timeout: 10 }))
    expect(JSON.stringify(s)).toBe(
      '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi","timeout":10}]}]}}'
    )
  })

  it('stores an empty matcher as an absent key', () => {
    const s = edit({}, (o) => setHook(o, { event: 'Stop', matcher: '', command: 'x' }))
    expect(JSON.stringify(s)).toBe('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}')
  })

  it('appends to the first group with the same matcher', () => {
    const s = edit(
      {
        hooks: {
          PreToolUse: [
            { matcher: 'Edit', hooks: [{ type: 'command', command: 'e' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] }
          ]
        }
      },
      (o) => setHook(o, { event: 'PreToolUse', matcher: 'Bash', command: 'b' })
    )
    expect(hooksOf(JSON.stringify(s))).toEqual({
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'e' }] },
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'a' },
            { type: 'command', command: 'b' }
          ]
        }
      ]
    })
  })

  it('adds a group when no group has that matcher', () => {
    const s = edit({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] } }, (o) =>
      setHook(o, { event: 'Stop', matcher: 'X', command: 'b' })
    )
    expect(hooksOf(JSON.stringify(s))).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'a' }] }, { matcher: 'X', hooks: [{ type: 'command', command: 'b' }] }]
    })
  })

  it('edits in place and keeps keys it does not know', () => {
    const s = edit({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a', timeout: 3, async: true }] }] } }, (o) =>
      setHook(o, { event: 'Stop', matcher: '', command: 'b', at: { group: 0, hook: 0 } })
    )
    expect(hooksOf(JSON.stringify(s))).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'b', async: true }] }] })
  })

  it('sets a timeout when editing in place', () => {
    const s = edit({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] } }, (o) =>
      setHook(o, { event: 'Stop', matcher: '', command: 'a', timeout: 9, at: { group: 0, hook: 0 } })
    )
    expect(hooksOf(JSON.stringify(s))).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'a', timeout: 9 }] }] })
  })

  it('updates the matcher of a group holding only that hook', () => {
    const s = edit({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] }] } }, (o) =>
      setHook(o, { event: 'PreToolUse', matcher: 'Edit', command: 'a', at: { group: 0, hook: 0 } })
    )
    expect(hooksOf(JSON.stringify(s))).toEqual({ PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'a' }] }] })
    setHook(s, { event: 'PreToolUse', matcher: '', command: 'a', at: { group: 0, hook: 0 } })
    expect(hooksOf(JSON.stringify(s))).toEqual({ PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }] })
  })

  it('moves the hook to a group with the new matcher when its group holds others', () => {
    const s = edit(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'a' },
                { type: 'command', command: 'b' }
              ]
            }
          ]
        }
      },
      (o) => setHook(o, { event: 'PreToolUse', matcher: 'Edit', command: 'b2', at: { group: 0, hook: 1 } })
    )
    expect(hooksOf(JSON.stringify(s))).toEqual({
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'b2' }] }
      ]
    })
  })

  it('refuses to edit or remove a hook that is not a command hook, and changes nothing', () => {
    const hooks = { Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] }
    const s: Record<string, unknown> = { hooks: JSON.parse(JSON.stringify(hooks)) }
    expect(() => setHook(s, { event: 'Stop', matcher: '', command: 'c', at: { group: 0, hook: 0 } })).toThrow(EXT_TEXT.notEditable)
    expect(() => removeHook(s, 'Stop', { group: 0, hook: 0 })).toThrow(EXT_TEXT.notEditable)
    expect(s).toEqual({ hooks })
  })

  it('refuses a position that is not there', () => {
    const s: Record<string, unknown> = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] } }
    expect(() => setHook(s, { event: 'Stop', matcher: '', command: 'c', at: { group: 3, hook: 0 } })).toThrow(EXT_TEXT.notFound)
    expect(() => removeHook(s, 'Stop', { group: 0, hook: 4 })).toThrow(EXT_TEXT.notFound)
    expect(() => removeHook(s, 'Nope', { group: 0, hook: 0 })).toThrow(EXT_TEXT.notFound)
  })

  it('refuses a hooks block it does not understand', () => {
    expect(() => setHook({ hooks: [] }, { event: 'Stop', matcher: '', command: 'x' })).toThrow(EXT_TEXT.notEditable)
    expect(() => setHook({ hooks: { Stop: 'x' } }, { event: 'Stop', matcher: '', command: 'x' })).toThrow(EXT_TEXT.notEditable)
  })

  it('removeHook of the last hook of a group removes the group and the event', () => {
    const s: Record<string, unknown> = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }], Other: [{ hooks: [{ type: 'command', command: 'o' }] }] }
    }
    removeHook(s, 'Stop', { group: 0, hook: 0 })
    expect(s).toEqual({ hooks: { Other: [{ hooks: [{ type: 'command', command: 'o' }] }] } })
  })

  it('removeHook keeps the group while it holds other hooks, and other groups', () => {
    const s: Record<string, unknown> = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'a' },
              { type: 'command', command: 'b' }
            ]
          },
          { matcher: 'X', hooks: [{ type: 'command', command: 'c' }] }
        ]
      }
    }
    removeHook(s, 'Stop', { group: 0, hook: 0 })
    expect(s).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'b' }] }, { matcher: 'X', hooks: [{ type: 'command', command: 'c' }] }] }
    })
    removeHook(s, 'Stop', { group: 1, hook: 0 })
    expect(s).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'b' }] }] } })
  })
})

describe('settingsPath', () => {
  // join gives the same strings on POSIX, and the native separator on Windows.
  it('places the three files', () => {
    expect(settingsPath('user', '/work/app', '/home/u', {})).toBe(join('/home/u/.claude/settings.json'))
    expect(settingsPath('project', '/work/app', '/home/u', {})).toBe(join('/work/app/.claude/settings.json'))
    expect(settingsPath('local', '/work/app', '/home/u', {})).toBe(join('/work/app/.claude/settings.local.json'))
  })

  it('moves the user file with CLAUDE_CONFIG_DIR, and only that one', () => {
    const env = { CLAUDE_CONFIG_DIR: '/cfg' }
    expect(settingsPath('user', '/work/app', '/home/u', env)).toBe(join('/cfg/settings.json'))
    expect(settingsPath('project', '/work/app', '/home/u', env)).toBe(join('/work/app/.claude/settings.json'))
    expect(settingsPath('user', '/work/app', '/home/u', { CLAUDE_CONFIG_DIR: '' })).toBe(join('/home/u/.claude/settings.json'))
  })
})

describe('writeSettings', () => {
  const path = () => join(dir, '.claude', 'settings.local.json')

  it('creates a missing file and its folder, holding only the edited key', async () => {
    await writeSettings(path(), 'absent', (s) => setSkillOverride(s, 'a', false))
    expect(JSON.parse(await fs.readFile(path(), 'utf8'))).toEqual({ skillOverrides: { a: 'off' } })
    expect((await fs.readFile(path(), 'utf8')).endsWith('\n')).toBe(true)
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, '.claude'))).mode & 0o777).toBe(0o700)
  })

  it('does not create a file when the edit leaves nothing to say', async () => {
    await writeSettings(path(), null, (s) => setSkillOverride(s, 'a', true))
    await expect(fs.stat(path())).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(join(dir, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses invalid JSON and leaves the file byte for byte', async () => {
    await fs.mkdir(join(dir, '.claude'))
    await fs.writeFile(path(), '{bad')
    await expect(writeSettings(path(), null, (s) => setSkillOverride(s, 'a', false))).rejects.toThrow(
      EXT_TEXT.badJson('settings.local.json')
    )
    await expect(writeSettings(path(), stampOf('{bad'), (s) => setSkillOverride(s, 'a', false), 'Local settings')).rejects.toThrow(
      EXT_TEXT.badJson('Local settings')
    )
    expect(await fs.readFile(path(), 'utf8')).toBe('{bad')
  })

  it('refuses a stale stamp and writes nothing', async () => {
    await fs.mkdir(join(dir, '.claude'))
    await fs.writeFile(path(), '{"model":"x"}\n')
    const stamp = stampOf('{"model":"x"}\n')
    await fs.writeFile(path(), '{"model":"y"}\n')
    await expect(writeSettings(path(), stamp, (s) => setSkillOverride(s, 'a', false))).rejects.toThrow(EXT_TEXT.stale)
    expect(await fs.readFile(path(), 'utf8')).toBe('{"model":"y"}\n')
    // A file that appeared since an 'absent' read is stale too.
    await expect(writeSettings(path(), 'absent', (s) => setSkillOverride(s, 'a', false))).rejects.toThrow(EXT_TEXT.stale)
  })

  it('writes when the stamp matches, keeps the mode and every other key', async () => {
    await fs.mkdir(join(dir, '.claude'))
    const before = JSON.stringify({ model: 'x', hooks: {}, env: { K: 'v' } }, null, 2) + '\n'
    await fs.writeFile(path(), before, { mode: 0o640 })
    await fs.chmod(path(), 0o640)
    await writeSettings(path(), stampOf(before), (s) => setSkillOverride(s, 'a', false))
    const after = JSON.parse(await fs.readFile(path(), 'utf8'))
    expect(after).toEqual({ model: 'x', hooks: {}, env: { K: 'v' }, skillOverrides: { a: 'off' } })
    expect(Object.keys(after)).toEqual(['model', 'hooks', 'env', 'skillOverrides'])
    if (process.platform !== 'win32') expect((await fs.stat(path())).mode & 0o777).toBe(0o640)
  })

  it('a null stamp skips the stale check', async () => {
    await fs.mkdir(join(dir, '.claude'))
    await fs.writeFile(path(), '{"model":"y"}\n')
    await writeSettings(path(), null, (s) => setSkillOverride(s, 'a', false))
    expect(JSON.parse(await fs.readFile(path(), 'utf8'))).toEqual({ model: 'y', skillOverrides: { a: 'off' } })
  })

  it.skipIf(process.getuid?.() === 0)('leaves no temp file behind and reports io failures as a bare code', async () => {
    // A read-only folder: the file reads and parses, so the failure comes from the write itself.
    await fs.mkdir(join(dir, '.claude'))
    await fs.writeFile(path(), '{"theme":"dark"}\n')
    // Windows has no mode bits: the temp file's write failing with EACCES stands in for the read-only folder.
    const denied = isWindows
      ? vi.spyOn(fs, 'writeFile').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
      : await fs.chmod(join(dir, '.claude'), 0o555)
    try {
      const err = await writeSettings(path(), null, (s) => setSkillOverride(s, 'a', false)).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('EACCES')
      expect((err as Error).message).not.toContain(dir)
      expect(await fs.readdir(join(dir, '.claude'))).toEqual(['settings.local.json'])
      expect(await fs.readFile(path(), 'utf8')).toBe('{"theme":"dark"}\n')
    } finally {
      if (denied) denied.mockRestore()
      else await fs.chmod(join(dir, '.claude'), 0o755)
    }
  })
})

// Ruling 25: a project file is written only where it really lies in the folder; user files keep following links.
describe('project files and links (Ruling 25)', () => {
  const setup = async () => {
    const folder = join(dir, 'proj')
    const outside = join(dir, 'outside')
    await fs.mkdir(folder, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    return { folder, outside }
  }
  const addHook = (s: Record<string, unknown>) => setHook(s, { event: 'Stop', matcher: '', command: 'x.sh' })
  // A folder link needs no privilege on Windows as a junction; file links need symlinksWork.
  const dirLink = (target: string, path: string) => fs.symlink(target, path, isWindows ? 'junction' : undefined)

  it.skipIf(!symlinksWork)('refuses a settings file that is a link to another file, which stays as it was', async () => {
    const { folder, outside } = await setup()
    const target = join(outside, 'claude.json')
    await fs.writeFile(target, '{"keep":1}\n')
    await fs.mkdir(join(folder, '.claude'))
    const path = join(folder, '.claude', 'settings.local.json')
    await fs.symlink(target, path)
    await expect(writeSettings(path, null, addHook, 'x', folder)).rejects.toThrow(EXT_TEXT.notEditable)
    expect(await fs.readFile(target, 'utf8')).toBe('{"keep":1}\n')
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
  })

  it('refuses a .claude folder that is a link to elsewhere, writing nothing there', async () => {
    const { folder, outside } = await setup()
    await dirLink(outside, join(folder, '.claude'))
    await expect(writeSettings(join(folder, '.claude', 'settings.json'), null, addHook, 'x', folder)).rejects.toThrow(EXT_TEXT.notEditable)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it.skipIf(!symlinksWork)('refuses a dangling link, creating nothing at its target', async () => {
    const { folder, outside } = await setup()
    await fs.mkdir(join(folder, '.claude'))
    const path = join(folder, '.claude', 'settings.json')
    await fs.symlink(join(outside, 'nowhere.json'), path)
    await expect(writeSettings(path, null, addHook, 'x', folder)).rejects.toThrow(EXT_TEXT.notEditable)
    expect(await fs.readdir(outside)).toEqual([])
    await fs.symlink(join(outside, 'gone'), join(folder, 'dangling-dir'))
    await expect(writeSettings(join(folder, 'dangling-dir', 'settings.json'), null, addHook, 'x', folder)).rejects.toThrow(
      EXT_TEXT.notEditable
    )
  })

  it('writes a project file that is really in the folder, a .claude link that stays inside included', async () => {
    const { folder } = await setup()
    await writeSettings(join(folder, '.claude', 'settings.json'), null, addHook, 'x', folder)
    expect(hooksOf(await fs.readFile(join(folder, '.claude', 'settings.json'), 'utf8'))).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'x.sh' }] }]
    })
    const other = join(dir, 'proj2')
    await fs.mkdir(join(other, 'config', 'claude'), { recursive: true })
    await dirLink(join(other, 'config', 'claude'), join(other, '.claude'))
    await writeSettings(join(other, '.claude', 'settings.local.json'), null, addHook, 'x', other)
    expect(await fs.readdir(join(other, 'config', 'claude'))).toEqual(['settings.local.json'])
  })

  it.skipIf(!symlinksWork)('keeps following a link for a user file (no folder given)', async () => {
    const { outside } = await setup()
    const real = join(outside, 'settings.json')
    await fs.writeFile(real, '{}\n')
    const link = join(dir, 'user-settings.json')
    await fs.symlink(real, link)
    await writeSettings(link, null, addHook)
    expect(hooksOf(await fs.readFile(real, 'utf8'))).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'x.sh' }] }] })
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
  })
})
