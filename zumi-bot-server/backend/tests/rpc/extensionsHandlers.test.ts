import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import type { AgentSummary } from '@zumibot/shared/types'
import { createHandlers, type HandlerDeps, type Handlers } from '../../src/rpc/handlers'

let dir: string
let folder: string
let h: Handlers
let calls: Array<[string, unknown[]]>
let forgot: number

const agent = (name: string, error: string | null = null): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error,
  builtIn: name === 'zumi-bot'
})
const METHODS = [
  'loadout',
  'server',
  'saveServer',
  'removeServer',
  'setPlugin',
  'skill',
  'saveSkill',
  'removeSkill',
  'setSkill',
  'saveHook',
  'removeHook'
] as const

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-ext-rpc-')))
  folder = join(dir, 'work')
  mkdirSync(folder)
  writeFileSync(join(dir, 'file.txt'), 'x')
  calls = []
  forgot = 0
  const service = Object.fromEntries(
    METHODS.map((m) => [
      m,
      async (...args: unknown[]) => {
        calls.push([m, args])
        return m === 'loadout' ? { loaded: true } : undefined
      }
    ])
  )
  h = createHandlers({
    extensions: {
      ...service,
      forget: () => {
        forgot++
      }
    },
    agents: {
      list: async () => [agent('dev'), agent('broken', 'bad frontmatter'), agent('zumi-bot')],
      save: async () => ({ ok: true, filePath: '/agents/dev.md', name: 'dev', renamedFrom: null })
    }
  } as unknown as HandlerDeps)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const lastCall = () => calls[calls.length - 1]
const server = { type: 'stdio', command: 'x', args: ['a'], env: { A: null, B: 'v' } }
const hook = { event: 'PreToolUse', matcher: 'Bash', command: 'a.sh' }

describe('extensions handlers', () => {
  it('has every extensions method', () => {
    for (const m of METHODS) expect(typeof h[`extensions:${m}`], m).toBe('function')
  })

  it('refuses a folder that is relative, missing or not a directory', async () => {
    for (const f of ['work', './work', join(dir, 'nope'), join(dir, 'file.txt'), '', 7, null]) {
      await expect(h['extensions:loadout'](f, null, false), String(f)).rejects.toThrow(EXT_TEXT.badFolder)
      await expect(h['extensions:saveHook']('project', f, hook, null), String(f)).rejects.toThrow(EXT_TEXT.badFolder)
    }
    expect(calls).toEqual([])
  })

  it('passes a normalized absolute folder on', async () => {
    expect(await h['extensions:loadout'](join(dir, 'work', '..', 'work') + '/', null, null)).toEqual({ loaded: true })
    expect(lastCall()).toEqual(['loadout', [folder, null, false]])
    await h['extensions:loadout'](folder, null, true)
    expect(lastCall()).toEqual(['loadout', [folder, null, true]])
  })

  it('takes a known agent, Zumi Bot included, or none; refuses others', async () => {
    await h['extensions:loadout'](folder, 'dev', false)
    await h['extensions:loadout'](folder, 'zumi-bot', false)
    expect(calls.map((c) => c[1][1])).toEqual(['dev', 'zumi-bot'])
    for (const a of ['nobody', 'broken', 5])
      await expect(h['extensions:loadout'](folder, a, false), String(a)).rejects.toThrow(EXT_TEXT.notFound)
    await expect(h['extensions:loadout'](folder, null, 'yes')).rejects.toThrow(TypeError)
  })

  it('refuses server names outside the set, a leading dash and zumibot_ names', async () => {
    for (const n of ['../x', 'a/b', '-s', '', 'x'.repeat(101)]) {
      await expect(h['extensions:saveServer'](folder, 'user', n, server, null, null), n).rejects.toThrow(EXT_TEXT.badName)
      await expect(h['extensions:server'](folder, 'user', n), n).rejects.toThrow(EXT_TEXT.badName)
      await expect(h['extensions:removeServer'](folder, 'user', n), n).rejects.toThrow(EXT_TEXT.badName)
    }
    for (const n of ['zumibot_x', 'zumibot.browser'])
      await expect(h['extensions:saveServer'](folder, 'user', n, server, null, null), n).rejects.toThrow(EXT_TEXT.reservedName)
    await expect(h['extensions:saveServer'](folder, 'user', 'ok', server, '../old', 'abc')).rejects.toThrow(EXT_TEXT.badName)
    expect(calls).toEqual([])
    await h['extensions:saveServer'](folder, 'user', 'claude.ai Gmail', server, null, null)
    expect(lastCall()).toEqual(['saveServer', [folder, 'user', 'claude.ai Gmail', server, undefined, undefined]])
    await h['extensions:saveServer'](folder, 'local', 'new', server, 'old', 'abc')
    expect(lastCall()).toEqual(['saveServer', [folder, 'local', 'new', server, 'old', 'abc']])
  })

  it('refuses a scope it does not know', async () => {
    for (const s of ['global', 'claudeai', 1]) await expect(h['extensions:server'](folder, s, 'x'), String(s)).rejects.toThrow(TypeError)
  })

  it('refuses a server definition outside the CLI format with its own sentence', async () => {
    const bad = [
      null,
      'x',
      [],
      { args: ['a'] },
      { command: 'x', extra: 1 },
      { command: 'x', type: 'ws' },
      { command: 'x', args: [1] },
      { command: 'x', env: { A: 1 } },
      { command: 'x', env: 'A=1' },
      { url: 7 },
      { command: 'x', headers: { __proto__: null, A: [] } }
    ]
    for (const d of bad)
      await expect(h['extensions:saveServer'](folder, 'user', 'ok', d, null, null), JSON.stringify(d)).rejects.toThrow(EXT_TEXT.badServer)
    expect(calls).toEqual([])
  })

  it('refuses env and header names the form refuses: empty, "=", a line break, NUL, over 200 characters', async () => {
    for (const name of ['', '  ', 'A=B', 'A\nB', 'A\rB', 'A\u0000B', 'x'.repeat(201)]) {
      for (const key of ['env', 'headers'] as const) {
        const d = { command: 'x', [key]: { [name]: 'v' } }
        await expect(h['extensions:saveServer'](folder, 'user', 'ok', d, null, null), `${key} ${JSON.stringify(name)}`).rejects.toThrow(
          EXT_TEXT.badServer
        )
      }
    }
    expect(calls).toEqual([])
    await h['extensions:saveServer'](
      folder,
      'user',
      'ok',
      { command: 'x', env: { GH_TOKEN: 'v', 'X-Odd.Name': null }, headers: { Authorization: 'v' } },
      null,
      null
    )
    expect(lastCall()[0]).toBe('saveServer')
  })

  it('refuses the server names __proto__, constructor and prototype', async () => {
    for (const n of ['__proto__', 'constructor', 'prototype'])
      await expect(h['extensions:saveServer'](folder, 'user', n, server, null, null), n).rejects.toThrow(EXT_TEXT.badName)
    expect(calls).toEqual([])
  })

  it('checks plugin ids and the switch', async () => {
    await h['extensions:setPlugin']('caveman@caveman', false)
    expect(lastCall()).toEqual(['setPlugin', ['caveman@caveman', false]])
    for (const id of ['-x', '', 'a b', 5]) await expect(h['extensions:setPlugin'](id, true), String(id)).rejects.toThrow()
    await expect(h['extensions:setPlugin']('a@b', 'yes')).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(1)
  })

  it('refuses skill names that are no folder name, and an unknown skill scope', async () => {
    for (const n of ['../x', 'Bad', 'a b', 'a--b', '']) {
      await expect(h['extensions:skill']('user', folder, n), n).rejects.toThrow(EXT_TEXT.badSkillName)
      await expect(h['extensions:saveSkill']('user', folder, { name: n, description: '', body: '' }), n).rejects.toThrow(
        EXT_TEXT.badSkillName
      )
      await expect(h['extensions:removeSkill']('project', folder, n), n).rejects.toThrow(EXT_TEXT.badSkillName)
    }
    await expect(h['extensions:skill']('local', folder, 'ok')).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
    await h['extensions:saveSkill']('project', folder, { name: 'ok', description: 'd', body: 'b', stamp: null, extra: 1 })
    expect(lastCall()).toEqual(['saveSkill', ['project', folder, { name: 'ok', description: 'd', body: 'b' }]])
    await h['extensions:saveSkill']('user', folder, { name: 'ok', description: 'd', body: 'b', stamp: 'abc' })
    expect(lastCall()).toEqual(['saveSkill', ['user', folder, { name: 'ok', description: 'd', body: 'b', stamp: 'abc' }]])
  })

  it("switches any skill the CLI lists, a plugin's included, by a name that is only a settings key", async () => {
    for (const n of ['', '../x', 'a/b', 'a\nb', '-x', 'x'.repeat(201), 7])
      await expect(h['extensions:setSkill'](n, false), String(n)).rejects.toThrow(EXT_TEXT.badSkillName)
    await expect(h['extensions:setSkill']('ok', 'no')).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
    await h['extensions:setSkill']('caveman:compress', false)
    expect(lastCall()).toEqual(['setSkill', ['caveman:compress', false]])
    await h['extensions:setSkill']('ok', true)
    expect(lastCall()).toEqual(['setSkill', ['ok', true]])
  })

  it('checks a hook: the file, the event, a finite positive timeout or none, a stamp for an edit', async () => {
    for (const t of [-1, 0, NaN, Infinity, '5'])
      await expect(h['extensions:saveHook']('user', folder, { ...hook, timeout: t }, null), String(t)).rejects.toThrow(TypeError)
    await expect(h['extensions:saveHook']('global', folder, hook, null)).rejects.toThrow(TypeError)
    for (const e of ['', '__proto__', 'Pre Tool', 'a'.repeat(65)])
      await expect(h['extensions:saveHook']('user', folder, { ...hook, event: e }, null), e).rejects.toThrow(TypeError)
    await expect(h['extensions:saveHook']('user', folder, { ...hook, command: '' }, null)).rejects.toThrow(TypeError)
    await expect(h['extensions:saveHook']('user', folder, { ...hook, at: { group: -1, hook: 0 } }, 'abc')).rejects.toThrow(TypeError)
    // An edit names a place in the file the page read, so it must carry that file's stamp.
    await expect(h['extensions:saveHook']('user', folder, { ...hook, at: { group: 0, hook: 0 } }, null)).rejects.toThrow(TypeError)
    await expect(h['extensions:removeHook']('user', folder, 'PreToolUse', { group: 0, hook: 0 }, null)).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
    await h['extensions:saveHook']('local', folder, { ...hook, timeout: 30, extra: 'x' }, null)
    expect(lastCall()).toEqual(['saveHook', ['local', folder, { ...hook, timeout: 30 }, null]])
    await h['extensions:removeHook']('user', folder, 'PreToolUse', { group: 1, hook: 2 }, 'abc')
    expect(lastCall()).toEqual(['removeHook', ['user', folder, 'PreToolUse', { group: 1, hook: 2 }, 'abc']])
  })

  it('agents:save forgets the cached loadouts', async () => {
    await h['agents:save']('/agents/dev.md', '---\nname: dev\n---\n')
    expect(forgot).toBe(1)
  })
})
