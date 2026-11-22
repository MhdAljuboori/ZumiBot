import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, promises as fs, realpathSync } from 'node:fs'
import os from 'node:os'
import { join, resolve, sep } from 'node:path'
import { EXT_TEXT, type McpServerDef } from '@zumibot/shared/extensions'
import {
  localProjectKey,
  mergeInput,
  readProjectServers,
  readUserServers,
  serverView,
  writeProjectServer
} from '../../../src/core/extensions/mcpFiles'
import { stampOf } from '../../../src/core/extensions/settingsFile'
import { isWindows, symlinksWork } from '../../support/platform'

// A folder link needs no privilege on Windows as a junction; a file link needs symlinksWork.
const dirLink = isWindows ? 'junction' : undefined

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-mcp-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const file = () => join(dir, '.mcp.json')
const read = async () => await fs.readFile(file(), 'utf8')
const GH: McpServerDef = { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer secret' } }
const DB: McpServerDef = { command: 'node', args: ['db.js'], env: { TOKEN: 's3cret', REGION: 'eu' } }

describe('localProjectKey', () => {
  // A real path, so the expected keys compare with what realpath gives back.
  const tree = async (...parts: string[]) => {
    const p = join(realpathSync(dir), ...parts)
    await fs.mkdir(p, { recursive: true })
    return p
  }
  const gitDir = async (at: string) => fs.mkdir(join(at, '.git'))

  it('is the folder itself when it holds .git', async () => {
    const repo = await tree('repo')
    await gitDir(repo)
    expect(localProjectKey(repo)).toBe(repo)
    // The same folder spelled with a trailing slash or `..` still reads as the repo.
    expect(localProjectKey(join(repo, 'x', '..') + '/')).toBe(repo)
  })

  it('is the repo root for a folder inside a repo', async () => {
    const repo = await tree('repo')
    await gitDir(repo)
    expect(localProjectKey(await tree('repo', 'packages', 'app'))).toBe(repo)
  })

  it('takes the nearest repo when repos nest', async () => {
    const outer = await tree('outer')
    const inner = await tree('outer', 'inner')
    await gitDir(outer)
    await gitDir(inner)
    expect(localProjectKey(await tree('outer', 'inner', 'sub'))).toBe(inner)
  })

  it('counts a .git file, as a worktree has', async () => {
    const wt = await tree('wt')
    await fs.writeFile(join(wt, '.git'), 'gitdir: /elsewhere\n')
    expect(localProjectKey(await tree('wt', 'src'))).toBe(wt)
  })

  it('never keys a symlinked folder by the link: the real path, or its repo root', async () => {
    const real = await tree('real', 'proj')
    await gitDir(real)
    const link = join(realpathSync(dir), 'link')
    await fs.symlink(real, link, dirLink)
    expect(localProjectKey(link)).toBe(real)
    const repo = await tree('repo2')
    await gitDir(repo)
    const sub = await tree('repo2', 'sub')
    const subLink = join(realpathSync(dir), 'sublink')
    await fs.symlink(sub, subLink, dirLink)
    expect(localProjectKey(subLink)).toBe(repo)
  })

  it('with no .git on the way is an existing ancestor-or-self real path, and the folder once it holds one', async () => {
    // This machine may hold a .git above the temp folder (an empty /tmp/.git was seen), so only the shape is checked here.
    const plain = await tree('plain', 'deep')
    const key = localProjectKey(plain)
    expect(existsSync(key)).toBe(true)
    expect(key === plain || plain.startsWith(key === sep ? key : key + sep)).toBe(true)
    await gitDir(plain)
    expect(localProjectKey(plain)).toBe(plain)
  })

  it('walks up from the resolved path of a folder that is not there', async () => {
    const repo = await tree('repo3')
    await gitDir(repo)
    expect(localProjectKey(join(repo, 'a', '..', 'missing'))).toBe(repo)
    const nowhere = join(realpathSync(dir), 'gone', 'x')
    const key = localProjectKey(nowhere)
    expect(key === resolve(nowhere) || (existsSync(join(key, '.git')) && nowhere.startsWith(key === sep ? key : key + sep))).toBe(true)
  })
})

describe('readUserServers', () => {
  const claudeJson = JSON.stringify({
    numStartups: 4,
    mcpServers: { gh: GH, 'claude.ai Odd': { command: 'x', cwd: '/' }, broken: 'nope' },
    projects: {
      '/work/app': { mcpServers: { db: DB, weird: { args: [] } }, allowedTools: [] },
      '/work/app2': { mcpServers: { other: { command: 'y' } } }
    }
  })

  it('reads the top-level and the folder own servers, skipping defs the editor does not know', () => {
    expect(readUserServers(claudeJson, '/work/app')).toEqual({ user: { gh: GH }, local: { db: DB } })
  })

  it('matches the folder key exactly', () => {
    expect(readUserServers(claudeJson, '/work/app/').local).toEqual({})
    expect(readUserServers(claudeJson, '/work').local).toEqual({})
    expect(readUserServers(claudeJson, '/work/app2').local).toEqual({ other: { command: 'y' } })
  })

  it('is empty for invalid JSON, a non-object root or missing keys', () => {
    expect(readUserServers('{bad', '/work/app')).toEqual({ user: {}, local: {} })
    expect(readUserServers('[1]', '/work/app')).toEqual({ user: {}, local: {} })
    expect(readUserServers('{"projects":{"/work/app":{}}}', '/work/app')).toEqual({ user: {}, local: {} })
    expect(readUserServers('{"mcpServers":[],"projects":[]}', '/work/app')).toEqual({ user: {}, local: {} })
  })

  it('keeps names with spaces, dots and colons, and a __proto__ name as an own key', () => {
    const out = readUserServers('{"mcpServers":{"plugin:a.b c":{"command":"x"},"__proto__":{"command":"y"}}}', '/f')
    expect(Object.keys(out.user)).toEqual(['plugin:a.b c', '__proto__'])
    expect(({} as Record<string, unknown>).command).toBeUndefined()
  })
})

describe('readProjectServers', () => {
  it('reads .mcp.json with a stamp of its text', async () => {
    const text = JSON.stringify({ mcpServers: { gh: GH, bad: { cwd: 1 } } }, null, 2) + '\n'
    await fs.writeFile(file(), text)
    expect(await readProjectServers(dir)).toEqual({ servers: { gh: GH }, stamp: stampOf(text) })
  })

  it('is empty and absent for a missing file', async () => {
    expect(await readProjectServers(dir)).toEqual({ servers: {}, stamp: 'absent' })
  })

  it('is empty for invalid JSON but still stamps it', async () => {
    await fs.writeFile(file(), '{bad')
    expect(await readProjectServers(dir)).toEqual({ servers: {}, stamp: stampOf('{bad') })
  })
})

describe('writeProjectServer', () => {
  it('creates .mcp.json holding only the server', async () => {
    await writeProjectServer(dir, 'gh', GH, 'absent')
    expect(JSON.parse(await read())).toEqual({ mcpServers: { gh: GH } })
    expect((await read()).endsWith('}\n')).toBe(true)
  })

  it('adds a server and keeps the other servers, the other top-level keys and their order', async () => {
    const before = JSON.stringify({ note: 'mine', mcpServers: { db: DB }, extra: [1] }, null, 2) + '\n'
    await fs.writeFile(file(), before)
    await writeProjectServer(dir, 'gh', GH, stampOf(before))
    const after = JSON.parse(await read())
    expect(Object.keys(after)).toEqual(['note', 'mcpServers', 'extra'])
    expect(Object.keys(after.mcpServers)).toEqual(['db', 'gh'])
    expect(after.mcpServers.db).toEqual(DB)
    expect(after.extra).toEqual([1])
  })

  it('keeps a replaced server at its place and writes the def keys in a fixed order', async () => {
    const before = JSON.stringify({ mcpServers: { a: { command: 'a' }, db: DB, z: { command: 'z' } } }, null, 2) + '\n'
    await fs.writeFile(file(), before)
    await writeProjectServer(dir, 'db', { env: { K: 'v' }, args: ['x'], command: 'node', type: 'stdio' }, null)
    const after = JSON.parse(await read())
    expect(Object.keys(after.mcpServers)).toEqual(['a', 'db', 'z'])
    expect(Object.keys(after.mcpServers.db)).toEqual(['type', 'command', 'args', 'env'])
  })

  it('removes a server with null and keeps the others', async () => {
    const before = JSON.stringify({ mcpServers: { db: DB, gh: GH } }, null, 2) + '\n'
    await fs.writeFile(file(), before)
    await writeProjectServer(dir, 'db', null, stampOf(before))
    expect(JSON.parse(await read())).toEqual({ mcpServers: { gh: GH } })
    await writeProjectServer(dir, 'gh', null, null)
    expect(JSON.parse(await read())).toEqual({ mcpServers: {} })
  })

  it('refuses to remove a server that is not there, or from a missing file, creating nothing', async () => {
    await expect(writeProjectServer(dir, 'gh', null, 'absent')).rejects.toThrow(EXT_TEXT.notFound)
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.writeFile(file(), '{"mcpServers":{"db":{"command":"x"}}}')
    await expect(writeProjectServer(dir, 'gh', null, null)).rejects.toThrow(EXT_TEXT.notFound)
    expect(await read()).toBe('{"mcpServers":{"db":{"command":"x"}}}')
  })

  it('refuses a stale stamp and writes nothing', async () => {
    await fs.writeFile(file(), '{"mcpServers":{}}\n')
    const stamp = stampOf('{"mcpServers":{}}\n')
    await fs.writeFile(file(), '{"mcpServers":{"x":{"command":"y"}}}\n')
    await expect(writeProjectServer(dir, 'gh', GH, stamp)).rejects.toThrow(EXT_TEXT.stale)
    expect(await read()).toBe('{"mcpServers":{"x":{"command":"y"}}}\n')
    await expect(writeProjectServer(dir, 'gh', GH, 'absent')).rejects.toThrow(EXT_TEXT.stale)
  })

  it('refuses invalid JSON and a non-object mcpServers, leaving the file as it was', async () => {
    await fs.writeFile(file(), '{bad')
    await expect(writeProjectServer(dir, 'gh', GH, null)).rejects.toThrow(EXT_TEXT.badJson('.mcp.json'))
    expect(await read()).toBe('{bad')
    await fs.writeFile(file(), '{"mcpServers":[1]}')
    await expect(writeProjectServer(dir, 'gh', GH, null)).rejects.toThrow(EXT_TEXT.notEditable)
    expect(await read()).toBe('{"mcpServers":[1]}')
  })

  it('refuses to replace an entry with a shape it does not read whole, leaving the file byte for byte', async () => {
    const before =
      JSON.stringify(
        { mcpServers: { foo: { type: 'http', url: 'https://x', oauth: { clientId: 'c' }, headersHelper: './h.sh' }, db: DB } },
        null,
        2
      ) + '\n'
    await fs.writeFile(file(), before)
    await expect(writeProjectServer(dir, 'foo', { command: 'new' }, null)).rejects.toThrow(EXT_TEXT.notEditable)
    await expect(writeProjectServer(dir, 'foo', { command: 'new' }, stampOf(before))).rejects.toThrow(EXT_TEXT.notEditable)
    expect(await read()).toBe(before)
    // Another server of the same file is still written, and the unread one keeps every key.
    await writeProjectServer(dir, 'db', { command: 'node2' }, stampOf(before))
    const after = JSON.parse(await read())
    expect(after.mcpServers.db).toEqual({ command: 'node2' })
    expect(after.mcpServers.foo).toEqual({ type: 'http', url: 'https://x', oauth: { clientId: 'c' }, headersHelper: './h.sh' })
  })

  it('still removes an entry with a shape it does not read whole', async () => {
    await fs.writeFile(file(), JSON.stringify({ mcpServers: { foo: { url: 'https://x', oauth: {} }, db: DB } }))
    await writeProjectServer(dir, 'foo', null, null)
    expect(JSON.parse(await read())).toEqual({ mcpServers: { db: DB } })
  })

  it('refuses a def outside the CLI format', async () => {
    await expect(writeProjectServer(dir, 'x', { args: ['a'] } as McpServerDef, 'absent')).rejects.toThrow(EXT_TEXT.badName)
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a folder that does not exist, creating nothing', async () => {
    await expect(writeProjectServer(join(dir, 'nope'), 'gh', GH, 'absent')).rejects.toThrow(EXT_TEXT.notFound)
    await expect(fs.stat(join(dir, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the mode of an existing file', async () => {
    await fs.writeFile(file(), '{}\n', { mode: 0o640 })
    await fs.chmod(file(), 0o640)
    await writeProjectServer(dir, 'gh', GH, null)
    if (process.platform !== 'win32') expect((await fs.stat(file())).mode & 0o777).toBe(0o640)
  })

  it('round-trips names with spaces, dots and colons', async () => {
    await writeProjectServer(dir, 'plugin:chrome.devtools mcp', { command: 'x' }, 'absent')
    expect(JSON.parse(await read()).mcpServers).toEqual({ 'plugin:chrome.devtools mcp': { command: 'x' } })
    await writeProjectServer(dir, 'plugin:chrome.devtools mcp', null, null)
    expect(JSON.parse(await read()).mcpServers).toEqual({})
  })

  it('errors carry no file text or path', async () => {
    await fs.writeFile(file(), '{"secret-token-abc": bad')
    const err = await writeProjectServer(dir, 'gh', GH, null).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('secret-token-abc')
    expect((err as Error).message).not.toContain(dir)
  })
})

describe('writeProjectServer and links (Ruling 25)', () => {
  it.skipIf(!symlinksWork)(
    'refuses a .mcp.json that is a link to the user file (as ~/.claude.json), which stays byte for byte',
    async () => {
      const userFile = join(dir, 'home-claude.json')
      await fs.writeFile(userFile, '{"mcpServers":{"mine":{"command":"m"}},"numStartups":3}')
      const folder = join(dir, 'repo')
      await fs.mkdir(folder)
      await fs.symlink(userFile, join(folder, '.mcp.json'))
      await expect(writeProjectServer(folder, 'evil', { command: 'x' }, null)).rejects.toThrow(EXT_TEXT.notEditable)
      await expect(writeProjectServer(folder, 'mine', null, null)).rejects.toThrow(EXT_TEXT.notEditable)
      expect(await fs.readFile(userFile, 'utf8')).toBe('{"mcpServers":{"mine":{"command":"m"}},"numStartups":3}')
    }
  )

  it.skipIf(!symlinksWork)('refuses a dangling .mcp.json link, creating nothing at its target', async () => {
    const folder = join(dir, 'repo')
    await fs.mkdir(folder)
    await fs.symlink(join(dir, 'nowhere.json'), join(folder, '.mcp.json'))
    await expect(writeProjectServer(folder, 'a', { command: 'x' }, null)).rejects.toThrow(EXT_TEXT.notEditable)
    expect(existsSync(join(dir, 'nowhere.json'))).toBe(false)
  })

  it('still writes a plain .mcp.json in a folder reached through a link', async () => {
    const real = join(dir, 'real')
    await fs.mkdir(real)
    await fs.symlink(real, join(dir, 'link'), dirLink)
    await writeProjectServer(join(dir, 'link'), 'a', { command: 'x' }, null)
    expect(JSON.parse(await fs.readFile(join(real, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { a: { command: 'x' } } })
  })
})

describe('serverView', () => {
  it('replaces every env and header value with an empty text and lists the names', () => {
    const def: McpServerDef = {
      command: 'node',
      args: ['--url', 'https://x'],
      env: { TOKEN: 's3cret', REGION: 'eu' },
      headers: { Authorization: 'Bearer s' }
    }
    const v = serverView(def, 'user', 'db', 'stamp1')
    expect(v).toEqual({
      name: 'db',
      scope: 'user',
      def: { command: 'node', args: ['--url', 'https://x'], env: { TOKEN: '', REGION: '' }, headers: { Authorization: '' } },
      hidden: { env: ['TOKEN', 'REGION'], headers: ['Authorization'] },
      stamp: 'stamp1'
    })
    expect(JSON.stringify(v)).not.toContain('s3cret')
    expect(JSON.stringify(v)).not.toContain('Bearer')
    // The stored def is not changed.
    expect(def.env?.TOKEN).toBe('s3cret')
  })

  it('has empty hidden lists and no env or headers keys for a def without them', () => {
    const v = serverView({ type: 'http', url: 'https://x' }, 'project', 'gh', 'abc')
    expect(v.def).toEqual({ type: 'http', url: 'https://x' })
    expect(v.hidden).toEqual({ env: [], headers: [] })
  })
})

describe('mergeInput', () => {
  const stored: McpServerDef = { command: 'node', args: ['a'], env: { TOKEN: 's3cret', REGION: 'eu' } }

  it('keeps the stored text for a null value and takes a given text over it', () => {
    const out = mergeInput(stored, { command: 'node', args: ['a'], env: { TOKEN: null, REGION: 'us', NEW: 'v' } })
    expect(out).toEqual({ command: 'node', args: ['a'], env: { TOKEN: 's3cret', REGION: 'us', NEW: 'v' } })
  })

  it('drops a null value that has no stored text, and a name absent from the input', () => {
    expect(mergeInput(stored, { command: 'node', env: { MISSING: null } })).toEqual({ command: 'node' })
    expect(mergeInput(stored, { command: 'node', env: { TOKEN: null } })).toEqual({ command: 'node', env: { TOKEN: 's3cret' } })
  })

  it('treats an empty text as a value (the form sends null to keep)', () => {
    expect(mergeInput(stored, { command: 'node', env: { TOKEN: '' } }).env).toEqual({ TOKEN: '' })
  })

  it('takes every other field from the input as given', () => {
    const out = mergeInput(
      { type: 'stdio', command: 'old', args: ['x'] },
      { type: 'http', url: 'https://new.example', headers: { A: 'b' } }
    )
    expect(out).toEqual({ type: 'http', url: 'https://new.example', headers: { A: 'b' } })
  })

  it('keeps a stored header value by null, and never looks at the other map', () => {
    const out = mergeInput(
      { url: 'https://x', headers: { Authorization: 'Bearer s' }, env: { Authorization: 'env-side' } },
      { url: 'https://x', headers: { Authorization: null } }
    )
    expect(out).toEqual({ url: 'https://x', headers: { Authorization: 'Bearer s' } })
  })

  it('does not mutate the stored def or the input', () => {
    const storedCopy = JSON.parse(JSON.stringify(stored))
    const input = { command: 'node', env: { TOKEN: null } }
    mergeInput(stored, input)
    expect(JSON.parse(JSON.stringify(stored))).toEqual(storedCopy)
    expect(input).toEqual({ command: 'node', env: { TOKEN: null } })
  })

  it('throws badName when the result is not a server the CLI format has', () => {
    expect(() => mergeInput(stored, { args: ['a'] })).toThrow(EXT_TEXT.badName)
    expect(() => mergeInput(stored, { command: 'x', args: [1 as unknown as string] })).toThrow(EXT_TEXT.badName)
    expect(() => mergeInput(stored, { command: 'x', type: 'ws' as unknown as 'http' })).toThrow(EXT_TEXT.badName)
  })

  it('refuses an env or headers value that is not a map of texts', () => {
    expect(() => mergeInput(stored, { command: 'x', env: 'abc' as unknown as Record<string, string> })).toThrow(EXT_TEXT.badName)
    expect(() => mergeInput(stored, { command: 'x', headers: { A: 1 } as unknown as Record<string, string> })).toThrow(EXT_TEXT.badName)
  })

  it('drops keys the format does not have instead of passing them on', () => {
    const out = mergeInput(stored, { command: 'x', cwd: '/y' } as unknown as Parameters<typeof mergeInput>[1])
    expect(out).toEqual({ command: 'x' })
  })

  it('keeps a __proto__ env name as an own key', () => {
    const out = mergeInput(
      { command: 'x', env: JSON.parse('{"__proto__":"kept"}') },
      { command: 'x', env: JSON.parse('{"__proto__":null}') }
    )
    expect(Object.keys(out.env ?? {})).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>)['kept']).toBeUndefined()
  })
})
