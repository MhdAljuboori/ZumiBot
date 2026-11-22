import { describe, expect, it } from 'vitest'
import {
  EXT_TEXT,
  NO_EXTENSIONS,
  VAULT_REF_PATTERN,
  isReservedServerName,
  isServerName,
  parseHooks,
  parseMcpDef,
  toolPrefix,
  vaultRefs,
  type LoadoutSection
} from '@zumibot/shared/extensions'

describe('toolPrefix', () => {
  it('turns spaces and dots into underscores', () => expect(toolPrefix('claude.ai Gmail')).toBe('mcp__claude_ai_Gmail'))
  it('keeps hyphens and turns colons into underscores', () =>
    expect(toolPrefix('plugin:chrome-devtools-mcp:chrome-devtools')).toBe('mcp__plugin_chrome-devtools-mcp_chrome-devtools'))
  it('leaves a plain name alone', () => expect(toolPrefix('github_2')).toBe('mcp__github_2'))
  it('turns every character outside the set into one underscore', () => expect(toolPrefix('a b.c')).toBe('mcp__a_b_c'))
})

describe('isReservedServerName', () => {
  it('reserves zumibot_ names after the CLI normalizes them', () => {
    expect(isReservedServerName('zumibot_x')).toBe(true)
    // Shares the real bridge's `mcp__zumibot_browser__` tool prefix.
    expect(isReservedServerName('zumibot.browser')).toBe(true)
    expect(isReservedServerName('zumibot browser')).toBe(true)
  })
  it('leaves other names alone', () => {
    for (const n of ['github', 'zumibot', 'my_zumibot_x', 'ZumiBot_x', 'claude.ai Gmail']) expect(isReservedServerName(n), n).toBe(false)
  })
})

describe('isServerName', () => {
  it('refuses names that read as Object prototype keys', () => {
    for (const n of ['__proto__', 'constructor', 'prototype']) expect(isServerName(n), n).toBe(false)
  })
  it('takes the names the CLI lists', () => {
    for (const n of ['github', 'claude.ai Google Drive', 'plugin:chrome-devtools-mcp:chrome-devtools', 'a@b', 'x-1_2'])
      expect(isServerName(n), n).toBe(true)
  })
  it('refuses paths, other characters, empty and long names', () => {
    for (const n of ['', '../x', 'a/b', 'a\\b', 'a\nb', 'a"b', 'x'.repeat(101), 'é']) expect(isServerName(n), n).toBe(false)
  })
  it('refuses a leading dash, which `claude mcp` would read as a flag', () => {
    expect(isServerName('-s')).toBe(false)
    expect(isServerName('--help')).toBe(false)
    expect(isServerName('a-b')).toBe(true)
  })
})

describe('parseMcpDef', () => {
  it('round-trips a stdio def', () => {
    const def = { command: 'node', args: ['a'], env: { A: '1' } }
    expect(parseMcpDef(def)).toEqual(def)
  })
  it('round-trips an http def', () => {
    const def = { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${vault:GH}' } }
    expect(parseMcpDef(def)).toEqual(def)
  })
  it('takes the three transports', () => {
    for (const type of ['stdio', 'http', 'sse']) expect(parseMcpDef({ type, url: 'https://x.test' })?.type).toBe(type)
  })
  it('returns a copy, not the input', () => {
    const env = { A: '1' }
    const def = parseMcpDef({ command: 'x', env })
    expect(def?.env).toEqual(env)
    expect(def?.env).not.toBe(env)
  })
  it('keeps a __proto__ env name as an own key', () => {
    const def = parseMcpDef(JSON.parse('{"command":"x","env":{"__proto__":"1"}}'))
    expect(Object.keys(def?.env ?? {})).toEqual(['__proto__'])
  })
  it.each([
    ['a key outside the six', { command: 'x', cwd: '/' }],
    ['neither command nor url', { args: [] }],
    ['an empty object', {}],
    ['a non-string command', { command: 5 }],
    ['a non-string url', { url: 5 }],
    ['an unknown transport', { command: 'x', type: 'websocket' }],
    ['args that are not a list', { command: 'x', args: 'a' }],
    ['a non-string arg', { command: 'x', args: ['a', 1] }],
    ['an env that is a list', { command: 'x', env: ['A=1'] }],
    ['a non-string env value', { command: 'x', env: { A: 1 } }],
    ['a null header value', { url: 'u', headers: { A: null } }],
    ['null', null],
    ['a list', [{ command: 'x' }]],
    ['a string', 'node']
  ])('is null for %s', (_n, v) => expect(parseMcpDef(v)).toBeNull())
})

describe('parseHooks', () => {
  const command = { type: 'command', command: 'echo' }
  it('reads an editable command hook', () => {
    const v = { PreToolUse: [{ matcher: 'Bash', hooks: [command] }] }
    expect(parseHooks(v)).toEqual({ config: v, editable: true })
  })
  it('accepts a group with no matcher and a hook with a timeout', () => {
    const v = { Stop: [{ hooks: [{ ...command, timeout: 5 }] }] }
    expect(parseHooks(v)).toEqual({ config: v, editable: true })
  })
  it('reads an empty block as editable', () => expect(parseHooks({})).toEqual({ config: {}, editable: true }))
  it('reads an event with no groups as editable', () => expect(parseHooks({ Stop: [] })).toEqual({ config: { Stop: [] }, editable: true }))
  it('is not editable with a prompt hook, and keeps it as parsed', () => {
    const prompt = { type: 'prompt', prompt: 'x' }
    expect(parseHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [prompt] }] })).toEqual({
      config: { PreToolUse: [{ matcher: 'Bash', hooks: [prompt] }] },
      editable: false
    })
  })
  it.each([
    ['a group with another key', { PreToolUse: [{ matcher: 'Bash', hooks: [command], extra: 1 }] }],
    ['a command hook with another key', { Stop: [{ hooks: [{ ...command, async: true }] }] }],
    ['a command that is not text', { Stop: [{ hooks: [{ type: 'command', command: 5 }] }] }],
    ['a timeout that is not a number', { Stop: [{ hooks: [{ ...command, timeout: '5' }] }] }],
    ['a matcher that is not text', { Stop: [{ matcher: 5, hooks: [command] }] }],
    ['a group with no hooks list', { Stop: [{ matcher: 'x' }] }],
    ['a group that is not an object', { Stop: ['x'] }],
    ['a hook that is not an object', { Stop: [{ hooks: ['x'] }] }]
  ])('is not editable with %s', (_n, v) => {
    const r = parseHooks(v)
    expect(r).not.toBeNull()
    expect(r?.editable).toBe(false)
  })
  // Ruling 23: claude 2.1.322 silently drops a run's WHOLE merged --settings (guards included) for a PreToolUse hook timed 0 or below.
  it.each([
    ['0', 0],
    ['-0', -0],
    ['a negative number', -5],
    ['NaN', NaN],
    ['Infinity', Infinity]
  ])('is not editable with a timeout of %s', (_n, timeout) =>
    expect(parseHooks({ Stop: [{ hooks: [{ ...command, timeout }] }] })?.editable).toBe(false)
  )
  it.each([
    ['1.5', 1.5],
    ['1e20', 1e20],
    ['1', 1]
  ])('is editable with a timeout of %s', (_n, timeout) =>
    expect(parseHooks({ Stop: [{ hooks: [{ ...command, timeout }] }] })?.editable).toBe(true)
  )
  it('keeps only shapes the types allow in config when editable is false', () => {
    const r = parseHooks({ Stop: ['x', { hooks: ['y', command] }, { matcher: 'm' }] })
    expect(r?.config).toEqual({ Stop: [{ hooks: [command] }, { matcher: 'm', hooks: [] }] })
  })
  it('keeps an event named __proto__ as an own key', () => {
    const r = parseHooks(JSON.parse('{"__proto__":[{"hooks":[{"type":"command","command":"x"}]}]}'))
    expect(Object.keys(r?.config ?? {})).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(r?.config)).toBe(Object.prototype)
  })
  it.each([
    ['a list', []],
    ['null', null],
    ['a string', 'x'],
    ['an event that is not a list', { Stop: {} }],
    ['a map of maps', { Stop: { matcher: 'x' } }]
  ])('is null for %s', (_n, v) => expect(parseHooks(v)).toBeNull())
})

describe('vaultRefs', () => {
  it('lists env names in first-appearance order, env before headers, unique', () => {
    expect(vaultRefs({ headers: { Authorization: 'Bearer ${vault:GH}' }, env: { A: '${vault:GH}', B: '${vault:X_1}' } })).toEqual([
      'GH',
      'X_1'
    ])
  })
  it('finds several references and text around them in one value', () => {
    expect(vaultRefs({ env: { A: 'a ${vault:ONE}-${vault:TWO}:${vault:ONE}' } })).toEqual(['ONE', 'TWO'])
  })
  it('is empty for a def with no references', () => expect(vaultRefs({ command: 'x', env: { A: '1' } })).toEqual([]))
  it('ignores a malformed name', () => expect(vaultRefs({ env: { A: '${vault:1BAD} ${vault:} ${vault:A-B}' } })).toEqual([]))
  it('is not thrown off by the shared pattern having been used', () => {
    VAULT_REF_PATTERN.test('${vault:A}')
    expect(vaultRefs({ env: { A: '${vault:A}' } })).toEqual(['A'])
  })
})

describe('NO_EXTENSIONS', () => {
  it('is empty and editable', () =>
    expect(NO_EXTENSIONS).toEqual({
      serversOff: [],
      skillsOff: [],
      plugins: {},
      servers: [],
      serversEditable: true,
      hooks: {},
      hooksEditable: true
    }))
})

describe('EXT_TEXT', () => {
  it('has the fixed sentences', () => {
    for (const k of [
      'stale',
      'notFound',
      'cliMissing',
      'timeout',
      'badName',
      'reservedName',
      'vaultLocked',
      'addFailedRestored',
      'notEditable',
      'badServer',
      'badSkillName',
      'badFolder',
      'cliFailed',
      'addFailedLost',
      'nameTaken'
    ] as const)
      expect(EXT_TEXT[k], k).toMatch(/\S/)
  })
  it('says machineOnly exactly', () =>
    expect(EXT_TEXT.machineOnly).toBe('Changes here apply to this machine only; sync does not copy them.'))
  it('says a Vault that cannot be opened in Vault words, and a lost server with what to do', () => {
    expect(EXT_TEXT.vaultLocked).toBe('Not started: the Vault key is missing or does not match, so its keys are not available.')
    expect(EXT_TEXT.addFailedLost).toBe(
      'The server could not be saved, and the previous one could not be put back, so it is no longer set up. Reload to add it again.'
    )
  })
  it('names the file that is not JSON', () => expect(EXT_TEXT.badJson('settings.json')).toContain('settings.json'))
  it('names the missing Vault key', () =>
    expect(EXT_TEXT.vaultMissing('GITHUB_TOKEN')).toBe('Not started: no Vault key GITHUB_TOKEN is granted to this agent.'))
  it('names what a CLI does not report', () => {
    expect(EXT_TEXT.unsupported('servers')).toBe('This Claude Code version does not report MCP servers.')
    const sections: LoadoutSection[] = ['servers', 'plugins', 'skills', 'hooks']
    for (const s of sections) expect(EXT_TEXT.unsupported(s)).toMatch(/does not report/)
  })
})
