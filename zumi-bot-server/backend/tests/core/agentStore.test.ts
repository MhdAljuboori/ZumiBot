import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join, relative } from 'node:path'
import { AgentStore } from '../../src/core/agents/agentStore'
import { symlinksWork } from '../support/platform'
import { ACP_TEXT } from '@zumibot/shared/acp'
import { AGUI_TEXT } from '@zumibot/shared/agui'

const agent = (name: string, extra = '') => `---\nname: ${name}\ndescription: Does ${name} things\n${extra}---\nBody for ${name}.\n`

let dir: string
let trash: ReturnType<typeof vi.fn<(p: string) => Promise<void>>>
let store: AgentStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-agents-'))
  trash = vi.fn(async () => {})
  store = new AgentStore(dir, trash)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('AgentStore', () => {
  it('lists broken file with error', async () => {
    await fs.writeFile(join(dir, 'good.md'), agent('good'))
    await fs.writeFile(join(dir, 'bad.md'), 'hello')
    const list = await store.list()
    expect(list).toHaveLength(2)
    const bad = list.find((a) => a.filePath === join(dir, 'bad.md'))
    expect(bad).toMatchObject({ name: 'bad', icon: null, error: 'No frontmatter block (file must start with ---)' })
  })

  it('lists provider only for a codex file', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('a', 'provider: codex\n'))
    await fs.writeFile(join(dir, 'b.md'), agent('b', 'provider: claude\n'))
    await fs.writeFile(join(dir, 'c.md'), agent('c'))
    const list = await store.list()
    expect(list.find((x) => x.name === 'a')?.provider).toBe('codex')
    expect(list.find((x) => x.name === 'b')).not.toHaveProperty('provider')
    expect(list.find((x) => x.name === 'c')).not.toHaveProperty('provider')
  })

  it('definitionOf gives the body and model, null when missing or broken', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('a', 'model: gpt-x\n'))
    await fs.writeFile(join(dir, 'b.md'), agent('b'))
    await fs.writeFile(join(dir, 'bad.md'), 'hello')
    expect(await store.definitionOf('a')).toEqual({ body: 'Body for a.\n', model: 'gpt-x' })
    expect(await store.definitionOf('b')).toEqual({ body: 'Body for b.\n', model: null })
    expect(await store.definitionOf('missing')).toBeNull()
    expect(await store.definitionOf('bad')).toBeNull()
  })

  it('acpOf gives the body and the ACP launch as the file has it now; null launch when absent or unreadable, null for no loadable agent', async () => {
    await fs.writeFile(
      join(dir, 'g.md'),
      agent('g', 'provider: acp\nacp:\n  command: gemini\n  args: ["--acp"]\n  authEnv: [GEMINI_API_KEY]\n')
    )
    await fs.writeFile(join(dir, 'n.md'), agent('n', 'provider: acp\n'))
    await fs.writeFile(join(dir, 'u.md'), agent('u', 'provider: acp\nacp:\n  command: gemini\n  args: "--acp"\n'))
    await fs.writeFile(join(dir, 'bad.md'), 'hello')
    expect(await store.acpOf('g')).toEqual({
      provider: 'acp',
      body: 'Body for g.\n',
      launch: { command: 'gemini', args: ['--acp'], authEnv: ['GEMINI_API_KEY'] }
    })
    expect(await store.acpOf('n')).toEqual({ provider: 'acp', body: 'Body for n.\n', launch: null })
    expect(await store.acpOf('u')).toEqual({ provider: 'acp', body: 'Body for u.\n', launch: null })
    expect(await store.acpOf('missing')).toBeNull()
    expect(await store.acpOf('bad')).toBeNull()
  })

  it('aguiOf gives the provider and the remote launch as the file has it now; null launch when absent or unreadable, null for no loadable agent', async () => {
    await fs.writeFile(
      join(dir, 'r.md'),
      agent('r', 'provider: ag-ui\nagui:\n  endpoint: https://agents.example.com/run\n  authKey: EXAMPLE_AGENT_KEY\n')
    )
    await fs.writeFile(join(dir, 'n.md'), agent('n', 'provider: ag-ui\n'))
    await fs.writeFile(join(dir, 'u.md'), agent('u', 'provider: ag-ui\nagui: https://agents.example.com/run\n'))
    await fs.writeFile(join(dir, 'c.md'), agent('c', 'agui:\n  endpoint: https://agents.example.com/run\n'))
    await fs.writeFile(join(dir, 'bad.md'), 'hello')
    expect(await store.aguiOf('r')).toEqual({
      provider: 'ag-ui',
      launch: { endpoint: 'https://agents.example.com/run', authKey: 'EXAMPLE_AGENT_KEY', authHeader: null }
    })
    expect(await store.aguiOf('n')).toEqual({ provider: 'ag-ui', launch: null })
    expect(await store.aguiOf('u')).toEqual({ provider: 'ag-ui', launch: null })
    // The provider goes with the launch: a run (ChatService) refuses a file that is no longer a remote agent.
    expect(await store.aguiOf('c')).toEqual({
      provider: null,
      launch: { endpoint: 'https://agents.example.com/run', authKey: null, authHeader: null }
    })
    expect(await store.aguiOf('missing')).toBeNull()
    expect(await store.aguiOf('bad')).toBeNull()
  })

  it("a remote agent's summary names its endpoint's host (with a non-default port), never the path or the query", async () => {
    await fs.writeFile(
      join(dir, 'r.md'),
      agent('r', 'provider: ag-ui\nagui:\n  endpoint: https://agents.example.com:8443/run/secret?team=a\n')
    )
    await fs.writeFile(join(dir, 'p.md'), agent('p', 'provider: ag-ui\nagui:\n  endpoint: https://agents.example.com/run\n'))
    await fs.writeFile(join(dir, 'n.md'), agent('n', 'provider: ag-ui\n'))
    await fs.writeFile(join(dir, 'c.md'), agent('c', 'agui:\n  endpoint: https://agents.example.com/run\n'))
    const list = await store.list()
    expect(list.find((x) => x.name === 'r')).toMatchObject({ provider: 'ag-ui', remoteHost: 'agents.example.com:8443' })
    expect(list.find((x) => x.name === 'p')?.remoteHost).toBe('agents.example.com')
    expect(JSON.stringify(list)).not.toMatch(/secret|team=a/)
    // No endpoint, or not a remote agent: no host.
    expect(list.find((x) => x.name === 'n')).not.toHaveProperty('remoteHost')
    expect(list.find((x) => x.name === 'c')).not.toHaveProperty('remoteHost')
  })

  it('extensionsOf gives the parsed extension keys, empty lists for absent ones, null for no loadable agent', async () => {
    await fs.writeFile(
      join(dir, 'x.md'),
      agent(
        'x',
        'serversOff: [claude.ai Gmail]\nskillsOff: [apple-design]\nplugins: {a@m: false}\nmcpServers:\n  - github\n  - db:\n      command: node\nhooks:\n  Stop:\n    - hooks:\n        - type: prompt\n          prompt: p\n'
      )
    )
    await fs.writeFile(join(dir, 'plain.md'), agent('plain'))
    await fs.writeFile(join(dir, 'bad.md'), 'hello')
    expect(await store.extensionsOf('x')).toEqual({
      serversOff: ['claude.ai Gmail'],
      skillsOff: ['apple-design'],
      plugins: { 'a@m': false },
      servers: [
        { name: 'github', def: null },
        { name: 'db', def: { command: 'node' } }
      ],
      serversEditable: true,
      hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'p' }] }] },
      hooksEditable: false
    })
    expect(await store.extensionsOf('plain')).toEqual({
      serversOff: [],
      skillsOff: [],
      plugins: {},
      servers: [],
      serversEditable: true,
      hooks: {},
      hooksEditable: true
    })
    expect(await store.extensionsOf('missing')).toBeNull()
    expect(await store.extensionsOf('bad')).toBeNull()
  })

  it('extensionsOf reads the file fresh', async () => {
    await fs.writeFile(join(dir, 'x.md'), agent('x', 'serversOff: [a]\n'))
    expect((await store.extensionsOf('x'))?.serversOff).toEqual(['a'])
    await fs.writeFile(join(dir, 'x.md'), agent('x', 'serversOff: [b]\n'))
    expect((await store.extensionsOf('x'))?.serversOff).toEqual(['b'])
  })

  it('lists icon and color', async () => {
    await fs.writeFile(join(dir, 'faced.md'), agent('faced', 'color: green\nicon: wink\n'))
    const list = await store.list()
    expect(list[0]).toMatchObject({ name: 'faced', color: 'green', icon: 'wink', error: null })
  })

  it('lists duplicate names separately and flags the non-canonical one', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('same'))
    await fs.writeFile(join(dir, 'b.md'), agent('same'))
    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ filePath: join(dir, 'a.md'), name: 'same', error: null })
    expect(list[1]).toMatchObject({
      filePath: join(dir, 'b.md'),
      name: 'same',
      error: 'Duplicate name "same" \u2014 also declared in a.md'
    })
  })

  it('prefers <name>.md as the real agent among duplicates', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('same'))
    await fs.writeFile(join(dir, 'same.md'), agent('same'))
    const list = await store.list()
    expect(list.find((x) => x.filePath === join(dir, 'same.md'))?.error).toBeNull()
    expect(list.find((x) => x.filePath === join(dir, 'a.md'))?.error).toBe('Duplicate name "same" \u2014 also declared in same.md')
  })

  it('save new writes <name>.md', async () => {
    const raw = agent('helper')
    const res = await store.save(null, raw)
    expect(res).toMatchObject({ ok: true, name: 'helper', renamedFrom: null })
    expect(await fs.readFile(join(dir, 'helper.md'), 'utf8')).toBe(raw)
  })

  it('refuses an ACP agent with no command, or with an acp: it cannot read, writing nothing', async () => {
    expect(await store.save(null, agent('gem', 'provider: acp\n'))).toEqual({ ok: false, error: ACP_TEXT.commandRequired })
    expect(await store.save(null, agent('gem', 'provider: acp\nacp:\n  command: srv\n  args: [--port, 8080]\n'))).toEqual({
      ok: false,
      error: ACP_TEXT.launchUnreadable
    })
    await expect(fs.readdir(dir)).resolves.toEqual([])
    expect(await store.save(null, agent('gem', 'provider: acp\nacp:\n  command: srv\n  args: [--port, "8080"]\n'))).toMatchObject({
      ok: true,
      name: 'gem'
    })
  })

  it('refuses a remote agent with no endpoint, or with an agui: it cannot read, writing nothing', async () => {
    expect(await store.save(null, agent('rem', 'provider: ag-ui\n'))).toEqual({ ok: false, error: AGUI_TEXT.endpointRequired })
    expect(await store.save(null, agent('rem', 'provider: ag-ui\nagui: https://agents.example.com/run\n'))).toEqual({
      ok: false,
      error: AGUI_TEXT.launchUnreadable
    })
    await expect(fs.readdir(dir)).resolves.toEqual([])
    expect(await store.save(null, agent('rem', 'provider: ag-ui\nagui:\n  endpoint: https://agents.example.com/run\n'))).toMatchObject({
      ok: true,
      name: 'rem'
    })
  })

  it('save new refuses existing', async () => {
    const existing = agent('helper', 'color: red\n')
    await fs.writeFile(join(dir, 'helper.md'), existing)
    const res = await store.save(null, agent('helper'))
    expect(res).toEqual({ ok: false, error: 'An agent file named helper.md already exists' })
    expect(await fs.readFile(join(dir, 'helper.md'), 'utf8')).toBe(existing)
  })

  it('rename moves file', async () => {
    await fs.writeFile(join(dir, 'helper.md'), agent('helper'))
    const raw = agent('helper-2')
    const res = await store.save(join(dir, 'helper.md'), raw)
    expect(res).toMatchObject({ ok: true, name: 'helper-2', renamedFrom: 'helper' })
    await expect(fs.access(join(dir, 'helper.md'))).rejects.toThrow()
    expect(await fs.readFile(join(dir, 'helper-2.md'), 'utf8')).toBe(raw)
  })

  it('rename onto existing refuses', async () => {
    const a = agent('helper')
    const b = agent('helper-2', 'color: red\n')
    await fs.writeFile(join(dir, 'helper.md'), a)
    await fs.writeFile(join(dir, 'helper-2.md'), b)
    const res = await store.save(join(dir, 'helper.md'), agent('helper-2'))
    expect(res).toEqual({ ok: false, error: 'An agent file named helper-2.md already exists' })
    expect(await fs.readFile(join(dir, 'helper.md'), 'utf8')).toBe(a)
    expect(await fs.readFile(join(dir, 'helper-2.md'), 'utf8')).toBe(b)
  })

  it('saves a file whose basename differs from its name in place when the name is unchanged', async () => {
    await fs.writeFile(join(dir, 'legacy.md'), agent('other-name'))
    const raw = agent('other-name', 'color: red\n')
    const res = await store.save(join(dir, 'legacy.md'), raw)
    expect(res).toEqual({ ok: true, filePath: join(dir, 'legacy.md'), name: 'other-name', renamedFrom: null })
    expect(await fs.readFile(join(dir, 'legacy.md'), 'utf8')).toBe(raw)
    await expect(fs.access(join(dir, 'other-name.md'))).rejects.toThrow()
  })

  it('refuses a save whose name another file already declares', async () => {
    await fs.writeFile(join(dir, 'bar.md'), agent('foo'))
    await fs.writeFile(join(dir, 'baz.md'), agent('baz'))
    const expected = { ok: false, error: 'Another agent already uses the name "foo" (bar.md)' }
    expect(await store.save(null, agent('foo'))).toEqual(expected)
    expect(await store.save(join(dir, 'baz.md'), agent('foo'))).toEqual(expected)
    expect(await fs.readFile(join(dir, 'baz.md'), 'utf8')).toBe(agent('baz'))
    await expect(fs.access(join(dir, 'foo.md'))).rejects.toThrow()
  })

  it('refuses an in-place save of a flagged duplicate, then lets it be renamed without moving the real agent chats', async () => {
    await fs.writeFile(join(dir, 'same.md'), agent('same'))
    await fs.writeFile(join(dir, 'dupe.md'), agent('same'))
    const refused = await store.save(join(dir, 'dupe.md'), agent('same', 'model: haiku\n'))
    expect(refused).toEqual({ ok: false, error: 'Another agent already uses the name "same" (same.md)' })
    expect(await fs.readFile(join(dir, 'dupe.md'), 'utf8')).toBe(agent('same'))
    const res = await store.save(join(dir, 'dupe.md'), agent('fresh'))
    expect(res).toEqual({ ok: true, filePath: join(dir, 'fresh.md'), name: 'fresh', renamedFrom: null })
    await expect(fs.access(join(dir, 'dupe.md'))).rejects.toThrow()
    expect(await fs.readFile(join(dir, 'same.md'), 'utf8')).toBe(agent('same'))
    expect((await store.list()).every((a) => a.error === null)).toBe(true)
  })

  it('saves the real agent in place while a flagged duplicate exists, and still refuses the duplicate', async () => {
    await fs.writeFile(join(dir, 'same.md'), agent('same'))
    await fs.writeFile(join(dir, 'same (copy).md'), agent('same'))
    const raw = agent('same', 'color: red\n')
    const res = await store.save(join(dir, 'same.md'), raw)
    expect(res).toEqual({ ok: true, filePath: join(dir, 'same.md'), name: 'same', renamedFrom: null })
    expect(await fs.readFile(join(dir, 'same.md'), 'utf8')).toBe(raw)
    const refused = await store.save(join(dir, 'same (copy).md'), agent('same', 'color: blue\n'))
    expect(refused).toEqual({ ok: false, error: 'Another agent already uses the name "same" (same.md)' })
    expect(await fs.readFile(join(dir, 'same (copy).md'), 'utf8')).toBe(agent('same'))
  })

  it('still refuses a new agent or a rename onto a name a real agent owns while duplicates exist', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('same'))
    await fs.writeFile(join(dir, 'b.md'), agent('same'))
    await fs.writeFile(join(dir, 'other.md'), agent('other'))
    const expected = { ok: false, error: 'Another agent already uses the name "same" (a.md)' }
    expect(await store.save(null, agent('same', 'color: red\n'))).toEqual(expected)
    expect(await store.save(join(dir, 'other.md'), agent('same'))).toEqual(expected)
    expect(await fs.readFile(join(dir, 'other.md'), 'utf8')).toBe(agent('other'))
  })

  it('renaming a flagged duplicate works and does not claim the real agent chats, even when the agents dir is a relative path', async () => {
    const odd = new AgentStore(relative(process.cwd(), dir), trash) // relative with .. segments: scan paths are not absolute
    await fs.writeFile(join(dir, 'same.md'), agent('same'))
    await fs.writeFile(join(dir, 'same (copy).md'), agent('same'))
    const res = await odd.save(join(dir, 'same (copy).md'), agent('fresh'))
    expect(res).toEqual({ ok: true, filePath: join(dir, 'fresh.md'), name: 'fresh', renamedFrom: null })
    expect(await fs.readFile(join(dir, 'same.md'), 'utf8')).toBe(agent('same'))
  })

  it('renaming the real agent of a duplicate pair still reports the old name', async () => {
    await fs.writeFile(join(dir, 'same.md'), agent('same'))
    await fs.writeFile(join(dir, 'dupe.md'), agent('same'))
    const res = await store.save(join(dir, 'same.md'), agent('fresh'))
    expect(res).toMatchObject({ ok: true, name: 'fresh', renamedFrom: 'same' })
  })

  it('saves in place when the new name makes the target the file being saved', async () => {
    await fs.writeFile(join(dir, 'legacy.md'), agent('other'))
    const raw = agent('legacy', 'color: red\n')
    const res = await store.save(join(dir, 'legacy.md'), raw)
    expect(res).toEqual({ ok: true, filePath: join(dir, 'legacy.md'), name: 'legacy', renamedFrom: 'other' })
    expect(await fs.readFile(join(dir, 'legacy.md'), 'utf8')).toBe(raw)
  })

  it('renames a mismatched file when the name does change, and still refuses an existing target', async () => {
    await fs.writeFile(join(dir, 'legacy.md'), agent('other-name'))
    await fs.writeFile(join(dir, 'taken.md'), agent('taken'))
    const refused = await store.save(join(dir, 'legacy.md'), agent('taken'))
    expect(refused).toEqual({ ok: false, error: 'An agent file named taken.md already exists' })
    expect(await fs.readFile(join(dir, 'legacy.md'), 'utf8')).toBe(agent('other-name'))
    const res = await store.save(join(dir, 'legacy.md'), agent('fresh'))
    expect(res).toMatchObject({ ok: true, name: 'fresh', renamedFrom: 'other-name' })
    await expect(fs.access(join(dir, 'legacy.md'))).rejects.toThrow()
    expect(await fs.readFile(join(dir, 'fresh.md'), 'utf8')).toBe(agent('fresh'))
  })

  it.skipIf(!symlinksWork)('saving a symlinked agent keeps the link and updates the target', async () => {
    const outside = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-agents-real-'))
    try {
      const real = join(outside, 'linked.md')
      await fs.writeFile(real, agent('linked'))
      await fs.symlink(real, join(dir, 'linked.md'))
      const raw = agent('linked', 'color: red\n')
      const res = await store.save(join(dir, 'linked.md'), raw)
      expect(res).toMatchObject({ ok: true, filePath: join(dir, 'linked.md') })
      expect((await fs.lstat(join(dir, 'linked.md'))).isSymbolicLink()).toBe(true)
      expect(await fs.readFile(real, 'utf8')).toBe(raw)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('invalid name refused', async () => {
    const res = await store.save(null, agent('Bad'))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('lowercase')
  })

  it('save with deleted original returns ok:false', async () => {
    const res = await store.save(join(dir, 'gone.md'), agent('helper-2'))
    expect(res.ok).toBe(false)
  })

  it('rename rolls back when the write fails', async () => {
    const original = agent('helper')
    await fs.writeFile(join(dir, 'helper.md'), original)
    const failing = new AgentStore(dir, trash, async () => {
      throw new Error('disk full')
    })
    const res = await failing.save(join(dir, 'helper.md'), agent('helper-2'))
    expect(res).toEqual({ ok: false, error: 'disk full' })
    expect(await fs.readFile(join(dir, 'helper.md'), 'utf8')).toBe(original)
    await expect(fs.access(join(dir, 'helper-2.md'))).rejects.toThrow()
  })

  it('reports new location when rollback also fails', async () => {
    await fs.writeFile(join(dir, 'helper.md'), agent('helper'))
    const failing = new AgentStore(dir, trash, async (p) => {
      await fs.rm(p) // make the rollback rename fail
      throw new Error('disk full')
    })
    const res = await failing.save(join(dir, 'helper.md'), agent('helper-2'))
    expect(res).toEqual({
      ok: false,
      error: 'disk full. The file is now at helper-2.md with its old content'
    })
  })

  it('watch survives the directory being removed', async () => {
    const stop = store.watch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
    await new Promise((r) => setTimeout(r, 100))
    expect(() => stop()).not.toThrow()
  })

  it('trash calls injected trash', async () => {
    const p = join(dir, 'x.md')
    await fs.writeFile(p, agent('x'))
    await store.trash(p)
    expect(trash).toHaveBeenCalledWith(p)
    await expect(store.trash('/etc/passwd')).rejects.toThrow('Path outside')
  })

  it('watch debounces', async () => {
    const onChange = vi.fn()
    const stop = store.watch(onChange)
    try {
      for (let i = 0; i < 3; i++) {
        await fs.writeFile(join(dir, `w${i}.md`), agent('w'))
        await new Promise((r) => setTimeout(r, 15))
      }
      await new Promise((r) => setTimeout(r, 450))
      expect(onChange).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })
})

describe('AgentStore folders and built-in', () => {
  it('lists folder agents one level deep', async () => {
    await fs.mkdir(join(dir, 'yt'))
    await fs.writeFile(join(dir, 'yt', 'yt.md'), agent('yt'))
    expect(await store.list()).toEqual([
      {
        filePath: join(dir, 'yt', 'yt.md'),
        name: 'yt',
        description: 'Does yt things',
        color: null,
        icon: null,
        error: null,
        builtIn: false
      }
    ])
  })

  it('ignores deeper nesting and dot folders', async () => {
    await fs.mkdir(join(dir, 'a', 'b'), { recursive: true })
    await fs.writeFile(join(dir, 'a', 'b', 'c.md'), agent('c'))
    await fs.mkdir(join(dir, '.hidden'))
    await fs.writeFile(join(dir, '.hidden', 'h.md'), agent('h'))
    expect(await store.list()).toEqual([])
  })

  it('skips Markdown without frontmatter inside agent folders', async () => {
    await fs.mkdir(join(dir, 'yt'))
    await fs.writeFile(join(dir, 'yt', 'yt.md'), agent('yt'))
    await fs.writeFile(join(dir, 'yt', 'notes.md'), 'just notes')
    await fs.writeFile(join(dir, 'yt', 'broken.md'), '---\nname: [\n---\n')
    const names = (await store.list()).map((a) => a.filePath)
    expect(names).toEqual([join(dir, 'yt', 'broken.md'), join(dir, 'yt', 'yt.md')]) // broken frontmatter still shows, with its error
  })

  it('flags a folder copy of a flat agent as a duplicate', async () => {
    await fs.writeFile(join(dir, 'same.md'), agent('same'))
    await fs.mkdir(join(dir, 'same'))
    await fs.writeFile(join(dir, 'same', 'same.md'), agent('same'))
    const list = await store.list()
    expect(list.find((a) => a.filePath === join(dir, 'same.md'))?.error).toBeNull()
    expect(list.find((a) => a.filePath === join(dir, 'same', 'same.md'))?.error).toBe('Duplicate name "same" — also declared in same.md')
  })

  describe('with a built-in agent', () => {
    const builtIn = () => join(dir, 'zumi-bot.md')
    beforeEach(() => {
      store = new AgentStore(dir, trash, undefined, 'zumi-bot')
    })

    it('marks the built-in agent and lists it first', async () => {
      await fs.writeFile(join(dir, 'aaa.md'), agent('aaa'))
      await fs.writeFile(builtIn(), agent('zumi-bot'))
      const list = await store.list()
      expect(list.map((a) => [a.name, a.builtIn])).toEqual([
        ['zumi-bot', true],
        ['aaa', false]
      ])
    })

    it('keeps the flat built-in canonical over a folder copy', async () => {
      await fs.writeFile(builtIn(), agent('zumi-bot'))
      await fs.mkdir(join(dir, 'zumi-bot'))
      await fs.writeFile(join(dir, 'zumi-bot', 'zumi-bot.md'), agent('zumi-bot'))
      const list = await store.list()
      expect(list[0]).toMatchObject({ filePath: builtIn(), builtIn: true, error: null })
      expect(list[1]).toMatchObject({ builtIn: false, error: 'Duplicate name "zumi-bot" — also declared in zumi-bot.md' })
    })

    it('refuses to save or trash the built-in agent', async () => {
      await fs.writeFile(builtIn(), agent('zumi-bot'))
      await fs.writeFile(join(dir, 'x.md'), agent('x'))
      const refused = { ok: false, error: 'zumi-bot is built in and cannot be changed' }
      expect(await store.save(builtIn(), agent('zumi-bot', 'color: red\n'))).toEqual(refused)
      expect(await store.save(null, agent('zumi-bot'))).toEqual(refused)
      expect(await store.save(join(dir, 'x.md'), agent('zumi-bot'))).toEqual(refused)
      await expect(store.trash(builtIn())).rejects.toThrow('zumi-bot is built in and cannot be changed')
      expect(trash).not.toHaveBeenCalled()
    })
  })

  it('watch fires for a file created in a subfolder', async () => {
    await fs.mkdir(join(dir, 'sub'))
    const onChange = vi.fn()
    const stop = store.watch(onChange)
    try {
      await new Promise((r) => setTimeout(r, 50))
      await fs.writeFile(join(dir, 'sub', 'sub.md'), agent('sub'))
      await new Promise((r) => setTimeout(r, 450))
      expect(onChange).toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  describe('folder agents', () => {
    const folderAgent = async (folder: string, name: string, extra = '') => {
      await fs.mkdir(join(dir, folder), { recursive: true })
      await fs.writeFile(join(dir, folder, `${name}.md`), agent(name, extra))
    }

    it('renames a folder agent by moving its folder and file', async () => {
      await folderAgent('old', 'old')
      await fs.writeFile(join(dir, 'old', 'helper.txt'), 'h')
      const raw = agent('new')
      expect(await store.save(join(dir, 'old', 'old.md'), raw)).toEqual({
        ok: true,
        filePath: join(dir, 'new', 'new.md'),
        name: 'new',
        renamedFrom: 'old'
      })
      expect(await fs.readFile(join(dir, 'new', 'new.md'), 'utf8')).toBe(raw)
      expect(await fs.readFile(join(dir, 'new', 'helper.txt'), 'utf8')).toBe('h')
      await expect(fs.access(join(dir, 'old'))).rejects.toThrow()
    })

    it('refuses a folder rename onto an existing folder', async () => {
      await folderAgent('old', 'old')
      await fs.mkdir(join(dir, 'new'))
      expect(await store.save(join(dir, 'old', 'old.md'), agent('new'))).toEqual({
        ok: false,
        error: 'An agent folder named new already exists'
      })
      await fs.access(join(dir, 'old', 'old.md'))
    })

    it('renames an agent inside a differently named folder in place', async () => {
      await folderAgent('misc', 'old')
      const res = await store.save(join(dir, 'misc', 'old.md'), agent('new'))
      expect(res).toMatchObject({ ok: true, filePath: join(dir, 'misc', 'new.md'), renamedFrom: 'old' })
    })

    it('rolls back a folder rename when the write fails', async () => {
      await folderAgent('old', 'old')
      const before = await fs.readFile(join(dir, 'old', 'old.md'), 'utf8')
      const failing = new AgentStore(dir, trash, async () => {
        throw new Error('disk full')
      })
      expect(await failing.save(join(dir, 'old', 'old.md'), agent('new'))).toEqual({ ok: false, error: 'disk full' })
      expect(await fs.readFile(join(dir, 'old', 'old.md'), 'utf8')).toBe(before)
      await expect(fs.access(join(dir, 'new'))).rejects.toThrow()
    })

    it('trashes the whole folder of a folder agent', async () => {
      await folderAgent('yt', 'yt')
      await store.trash(join(dir, 'yt', 'yt.md'))
      expect(trash).toHaveBeenCalledWith(join(dir, 'yt'))
    })

    it('trashes only the file when its folder holds another agent', async () => {
      await folderAgent('team', 'team')
      await folderAgent('team', 'other')
      await store.trash(join(dir, 'team', 'team.md'))
      expect(trash).toHaveBeenCalledWith(join(dir, 'team', 'team.md'))
    })
  })

  it('lists memory and memoryLimit only when the file has them', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('a', 'memory: user\nmemoryLimit: 50\n'))
    await fs.writeFile(join(dir, 'b.md'), agent('b'))
    const [a, b] = await store.list()
    expect(a).toMatchObject({ memory: 'user', memoryLimit: 50 })
    expect(b).not.toHaveProperty('memory')
    expect(b).not.toHaveProperty('memoryLimit')
  })

  it("lists the file's model and each valid command's model", async () => {
    await fs.writeFile(
      join(dir, 'a.md'),
      agent(
        'a',
        'model: opus\ncommands:\n  - name: card\n    description: d\n    model: sonnet\n    prompt: |\n      p\n  - name: fix\n    description: d\n    prompt: |\n      p\n'
      )
    )
    await fs.writeFile(join(dir, 'b.md'), agent('b'))
    const [a, b] = await store.list()
    expect(a).toMatchObject({
      model: 'opus',
      commands: [
        { name: 'card', description: 'd', model: 'sonnet' },
        { name: 'fix', description: 'd' }
      ]
    })
    expect(a.commands?.[1]).not.toHaveProperty('model')
    expect(b).not.toHaveProperty('model')
  })

  it('lists autoCompactWindow only when the file has a usable one', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('a', 'autoCompactWindow: 400000\n'))
    await fs.writeFile(join(dir, 'b.md'), agent('b', 'autoCompactWindow: 5\n'))
    const [a, b] = await store.list()
    expect(a).toMatchObject({ autoCompactWindow: 400000 })
    expect(b).not.toHaveProperty('autoCompactWindow')
  })

  it('lists computerUse only when the file has computerUse: true', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('a', 'computerUse: true\n'))
    await fs.writeFile(join(dir, 'b.md'), agent('b'))
    await fs.writeFile(join(dir, 'c.md'), agent('c', 'computerUse: "yes"\n'))
    const [a, b, c] = await store.list()
    expect(a.computerUse).toBe(true)
    expect(b).not.toHaveProperty('computerUse')
    expect(c).not.toHaveProperty('computerUse')
  })

  it('lists only valid commands on the summary', async () => {
    const extra =
      'commands:\n  - {name: check, description: d, prompt: p}\n  - {name: Bad, description: d, prompt: p}\n  - {name: fix, description: d}\n'
    await fs.writeFile(join(dir, 'a.md'), agent('a', extra))
    const [summary] = await store.list()
    expect(summary.commands).toEqual([{ name: 'check', description: 'd' }])
    expect(await store.commandsOf('a')).toEqual([{ name: 'check', description: 'd', prompt: 'p' }])
  })

  it('the summary and commandsOf carry todos: true for a flagged command only', async () => {
    const extra =
      'commands:\n  - {name: my-day, description: d, todos: true, prompt: p}\n  - {name: check, description: d, todos: yes, prompt: p}\n'
    await fs.writeFile(join(dir, 'a.md'), agent('a', extra))
    const [summary] = await store.list()
    expect(summary.commands).toEqual([
      { name: 'my-day', description: 'd', todos: true },
      { name: 'check', description: 'd' }
    ])
  })

  it('saving tools [Read] writes Read plus the vault tool, the seven to-do tools, the two ask tools and the five process tools, once, and no tools writes no key', async () => {
    const withTools = await store.save(null, agent('helper', 'tools: Read\n'))
    expect(withTools.ok).toBe(true)
    const text = await fs.readFile(join(dir, 'helper.md'), 'utf8')
    expect(text).toContain(
      'tools: Read, mcp__zumibot_vault__vault_items, mcp__zumibot_todos__list, mcp__zumibot_todos__add, mcp__zumibot_todos__check, mcp__zumibot_todos__remove, mcp__zumibot_todos__ask_user, mcp__zumibot_todos__ready_for_review, mcp__zumibot_todos__comment, mcp__zumibot_agents__ask, mcp__zumibot_agents__side_question, mcp__zumibot_processes__start, mcp__zumibot_processes__list, mcp__zumibot_processes__logs, mcp__zumibot_processes__wait, mcp__zumibot_processes__stop\n'
    )
    expect(text).toContain('Body for helper.')
    // Saving the result again (the editor does) adds nothing and leaves the file as it is.
    await store.save(join(dir, 'helper.md'), text)
    expect(await fs.readFile(join(dir, 'helper.md'), 'utf8')).toBe(text)
    const listed = await store.save(null, agent('lister', 'tools:\n  - Read\n  - Grep\n'))
    expect(listed.ok).toBe(true)
    expect(await fs.readFile(join(dir, 'lister.md'), 'utf8')).toContain(
      '  - Grep\n  - mcp__zumibot_vault__vault_items\n  - mcp__zumibot_todos__list\n'
    )
    expect(await fs.readFile(join(dir, 'lister.md'), 'utf8')).toContain('  - mcp__zumibot_agents__ask\n')
    expect(await fs.readFile(join(dir, 'lister.md'), 'utf8')).toContain('  - mcp__zumibot_agents__side_question\n')
    await store.save(null, agent('plain'))
    expect(await fs.readFile(join(dir, 'plain.md'), 'utf8')).toBe(agent('plain'))
    await store.save(null, agent('empty', 'tools: ""\n'))
    expect(await fs.readFile(join(dir, 'empty.md'), 'utf8')).not.toContain('mcp__zumibot_todos')
    expect(await fs.readFile(join(dir, 'empty.md'), 'utf8')).not.toContain('mcp__zumibot_agents')
  })

  it('adds vault_items to a non-empty tools list', async () => {
    await store.save(null, agent('helper', 'tools: Read\n'))
    const text = await fs.readFile(join(dir, 'helper.md'), 'utf8')
    expect(text).toContain('mcp__zumibot_vault__vault_items')
    expect(text.match(/mcp__zumibot_vault__vault_items/g)).toHaveLength(1)
    // Saving the result again adds nothing.
    await store.save(join(dir, 'helper.md'), text)
    expect(await fs.readFile(join(dir, 'helper.md'), 'utf8')).toBe(text)
    await store.save(null, agent('lister', 'tools:\n  - Read\n'))
    expect(await fs.readFile(join(dir, 'lister.md'), 'utf8')).toContain('  - mcp__zumibot_vault__vault_items\n')
    await store.save(null, agent('plain'))
    expect(await fs.readFile(join(dir, 'plain.md'), 'utf8')).not.toContain('zumibot_vault')
    await store.save(null, agent('empty', 'tools: ""\n'))
    expect(await fs.readFile(join(dir, 'empty.md'), 'utf8')).not.toContain('zumibot_vault')
  })

  it('an odd commands value never breaks the agent', async () => {
    await fs.writeFile(join(dir, 'a.md'), agent('a', 'commands: nope\n'))
    await fs.writeFile(join(dir, 'b.md'), agent('b', 'commands:\n  a: 1\n'))
    for (const s of await store.list()) {
      expect(s.error).toBeNull()
      expect(s.commands).toBeUndefined()
    }
  })

  it('commandsOf a missing agent is empty', async () => {
    expect(await store.commandsOf('ghost')).toEqual([])
  })
})
