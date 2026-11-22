import { describe, expect, it } from 'vitest'
import { EXT_TEXT, type LoadoutHook, type McpServerView, type SkillView } from '@zumibot/shared/extensions'
import {
  HOOK_EVENTS,
  emptyHookDraft,
  emptyServerDraft,
  emptySkillDraft,
  hasErrors,
  hookDraftOf,
  hookErrors,
  hookInputOf,
  isHookDirty,
  isPlainValue,
  isServerDirty,
  isSkillDirty,
  serverDraftOf,
  serverErrors,
  serverInputOf,
  skillDraftOf,
  skillErrors,
  skillInputOf,
  vaultReference,
  withArgsText,
  showVaultPicker,
  withVaultReference,
  type ServerDraft
} from '../src/state/extensionForms'

const stdio = (over: Partial<ServerDraft> = {}): ServerDraft => ({
  ...emptyServerDraft('user'),
  name: 'echo-test',
  command: 'true',
  ...over
})

const view = (over: Partial<McpServerView> = {}): McpServerView => ({
  name: 'echo-test',
  scope: 'user',
  def: { command: 'node', args: ['server.js'] },
  hidden: { env: [], headers: [] },
  stamp: 'abc',
  ...over
})

describe('serverInputOf', () => {
  it('sends a stdio server with its typed transport, split args and plain env values', () => {
    const d = stdio({
      argsText: '-y\r\n  pkg  \n\n',
      env: [
        { name: ' TOKEN ', value: 'abc', stored: false },
        { name: '', value: '', stored: false }
      ]
    })
    expect(serverInputOf(d)).toEqual({ type: 'stdio', command: 'true', args: ['-y', 'pkg'], env: { TOKEN: 'abc' } })
  })

  it('sends null for a stored value left blank and the text for a typed one', () => {
    const d = stdio({
      env: [
        { name: 'KEEP', value: '', stored: true },
        { name: 'NEW', value: 'x', stored: true },
        { name: 'ADDED', value: '', stored: false }
      ]
    })
    expect(serverInputOf(d).env).toEqual({ KEEP: null, NEW: 'x', ADDED: '' })
  })

  it('sends only the url and headers for an http server, never the stdio fields', () => {
    const d = stdio({
      transport: 'http',
      command: 'leftover',
      argsText: 'a',
      url: ' https://x.example/mcp ',
      env: [{ name: 'E', value: 'v', stored: false }],
      headers: [{ name: 'Authorization', value: '', stored: true }]
    })
    const input = serverInputOf(d)
    expect(input).toEqual({ type: 'http', url: 'https://x.example/mcp', headers: { Authorization: null } })
    expect('command' in input || 'args' in input || 'env' in input).toBe(false)
  })

  it('never sends both a command and a url', () => {
    expect(Object.keys(serverInputOf(stdio({ url: 'https://x' })))).not.toContain('url')
    const http = serverInputOf(stdio({ transport: 'sse', url: 'https://x', command: 'true' }))
    expect(http).toEqual({ type: 'sse', url: 'https://x' })
  })

  it('omits empty args, env and headers', () => {
    expect(serverInputOf(stdio())).toEqual({ type: 'stdio', command: 'true' })
  })

  it('keeps a __proto__ name as an own key', () => {
    const input = serverInputOf(stdio({ env: [{ name: '__proto__', value: 'v', stored: false }] }))
    expect(Object.hasOwn(input.env ?? {}, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(input.env)).toBe(Object.prototype)
  })
})

describe('serverDraftOf', () => {
  it('reads a stdio server: args one per line, hidden values as stored blank rows', () => {
    const d = serverDraftOf(
      view({ def: { command: 'node', args: ['a', 'b'], env: { TOKEN: '' } }, hidden: { env: ['TOKEN'], headers: [] } })
    )
    expect(d).toMatchObject({ name: 'echo-test', scope: 'user', transport: 'stdio', command: 'node', argsText: 'a\nb', argsLossy: false })
    expect(d.env).toEqual([{ name: 'TOKEN', value: '', stored: true }])
  })

  it('shows values that are not hidden (the agent file mode)', () => {
    const d = serverDraftOf(view({ def: { command: 'node', env: { TOKEN: 'secret' } }, hidden: { env: [], headers: [] } }))
    expect(d.env).toEqual([{ name: 'TOKEN', value: 'secret', stored: false }])
  })

  it('reads a url server as http unless it says sse', () => {
    expect(serverDraftOf(view({ def: { url: 'https://x' } })).transport).toBe('http')
    expect(serverDraftOf(view({ def: { type: 'sse', url: 'https://x' } })).transport).toBe('sse')
    expect(
      serverDraftOf(view({ def: { type: 'http', url: 'https://x', headers: { A: '' } }, hidden: { env: [], headers: ['A'] } })).headers
    ).toEqual([{ name: 'A', value: '', stored: true }])
  })

  it('flags an argument the one-per-line box would change', () => {
    for (const args of [[''], [' lead'], ['trail '], ['two\nlines']]) {
      expect(serverDraftOf(view({ def: { command: 'x', args } })).argsLossy).toBe(true)
    }
    expect(serverDraftOf(view({ def: { command: 'x', args: ['ok', '--flag=1'] } })).argsLossy).toBe(false)
  })

  it('round-trips an unchanged edit to the same input', () => {
    const d = serverDraftOf(
      view({ def: { type: 'stdio', command: 'node', args: ['a'], env: { K: '' } }, hidden: { env: ['K'], headers: [] } })
    )
    expect(serverInputOf(d)).toEqual({ type: 'stdio', command: 'node', args: ['a'], env: { K: null } })
  })

  it('keeps the odd name as read', () => {
    expect(serverDraftOf(view({ name: 'claude.ai Google Drive' })).name).toBe('claude.ai Google Drive')
  })
})

describe('serverErrors', () => {
  it('accepts a complete stdio server', () => {
    expect(serverErrors(stdio(), ['user'])).toEqual({})
  })

  it('asks for a name, then checks its characters and the leading dash', () => {
    expect(serverErrors(stdio({ name: '  ' }), ['user']).name).toBe('Give the server a name.')
    expect(serverErrors(stdio({ name: 'bad/name' }), ['user']).name).toBe(EXT_TEXT.badName)
    expect(serverErrors(stdio({ name: '-x' }), ['user']).name).toBe(EXT_TEXT.badName)
    expect(serverErrors(stdio({ name: 'a'.repeat(101) }), ['user']).name).toBe(EXT_TEXT.badName)
  })

  it('takes the CLI-style names with spaces, dots and colons', () => {
    for (const name of ['claude.ai Google Drive', 'plugin:chrome-devtools-mcp:chrome-devtools', 'a@b_c-d']) {
      expect(serverErrors(stdio({ name }), ['user']).name).toBeUndefined()
    }
  })

  it('refuses a reserved name when it is written, however it is spelled', () => {
    for (const name of ['zumibot_browser', 'zumibot.browser', 'zumibot browser']) {
      expect(serverErrors(stdio({ name }), ['user']).name).toBe(EXT_TEXT.reservedName)
    }
  })

  it('needs a command for stdio and a url for http and sse', () => {
    expect(serverErrors(stdio({ command: '  ' }), ['user']).command).toBe('Enter the command that starts the server.')
    expect(serverErrors(stdio({ transport: 'http', url: '' }), ['user']).url).toBe('Enter the server URL.')
    expect(serverErrors(stdio({ transport: 'sse', url: ' ' }), ['user']).url).toBe('Enter the server URL.')
    // The other transport's field is not asked for.
    expect(serverErrors(stdio({ transport: 'http', url: 'https://x', command: '' }), ['user'])).toEqual({})
  })

  it('refuses env and header names that would break the CLI or the file', () => {
    const row = (name: string, value = 'v') => ({ name, value, stored: false })
    expect(serverErrors(stdio({ env: [row('A=B')] }), ['user']).env).toBe('A name cannot contain "=" or a line break.')
    expect(serverErrors(stdio({ env: [row('A\nB')] }), ['user']).env).toBe('A name cannot contain "=" or a line break.')
    expect(serverErrors(stdio({ env: [row('A\0B')] }), ['user']).env).toBe('A name cannot contain "=" or a line break.')
    expect(serverErrors(stdio({ env: [row('', 'value')] }), ['user']).env).toBe('Give every value a name.')
    expect(serverErrors(stdio({ env: [row('A'), row(' A ')] }), ['user']).env).toBe('"A" is listed twice.')
    expect(serverErrors(stdio({ env: [row('x'.repeat(201))] }), ['user']).env).toBe('A name can be at most 200 characters.')
    const http = stdio({ transport: 'http', url: 'https://x', headers: [row('Authorization'), row('Authorization')] })
    expect(serverErrors(http, ['user']).headers).toBe('"Authorization" is listed twice.')
  })

  it('does not check the env rows of a url server, which sends none', () => {
    const d = stdio({ transport: 'http', url: 'https://x', env: [{ name: 'A=B', value: '', stored: false }] })
    expect(serverErrors(d, ['user'])).toEqual({})
  })

  it('allows a blank row (no name, no value)', () => {
    expect(serverErrors(stdio({ env: [{ name: '', value: '', stored: false }] }), ['user'])).toEqual({})
  })

  it('refuses text longer than the server takes', () => {
    expect(serverErrors(stdio({ command: 'x'.repeat(10_001) }), ['user']).command).toBe('The command can be at most 10000 characters.')
    expect(serverErrors(stdio({ env: [{ name: 'A', value: 'x'.repeat(10_001), stored: false }] }), ['user']).env).toBe(
      'A value can be at most 10000 characters.'
    )
  })

  it('refuses a scope the form does not offer, and ignores scope in the agent file mode', () => {
    expect(serverErrors(stdio({ scope: 'project' }), ['user', 'local']).scope).toBe('Pick where to save the server.')
    expect(serverErrors(stdio({ scope: null }), ['user', 'local']).scope).toBe('Pick where to save the server.')
    expect(serverErrors(stdio({ scope: null }), null)).toEqual({})
  })

  it('refuses to save over an argument it cannot show', () => {
    expect(serverErrors(stdio({ argsLossy: true }), ['user']).args).toContain('cannot')
  })

  it('hasErrors is true only when a message exists', () => {
    expect(hasErrors({})).toBe(false)
    expect(hasErrors({ name: 'x' })).toBe(true)
    expect(hasErrors({ name: undefined })).toBe(false)
  })
})

describe('withArgsText', () => {
  it('clears the lossy flag when the Arguments box is rewritten, and keeps it for an untouched box', () => {
    const lossy = serverDraftOf(view({ def: { command: 'x', args: ['two\nlines'] } }))
    expect(lossy.argsLossy).toBe(true)
    const edited = withArgsText(lossy, 'a\nb')
    expect(edited).toMatchObject({ argsText: 'a\nb', argsLossy: false })
    expect(serverErrors(edited, ['user']).args).toBeUndefined()
    // Untouched: the draft as opened still refuses to save.
    expect(serverErrors(lossy, ['user']).args).toContain('cannot')
    // Typing in other fields never clears it (only the args path calls this helper).
    expect({ ...lossy, command: 'y' }.argsLossy).toBe(true)
  })
})

describe('showVaultPicker', () => {
  it('shows only in the agent file mode (no scopes) with keys to pick', () => {
    const keys = [{ env: 'TOKEN', name: 'Token' }]
    expect(showVaultPicker(null, keys)).toBe(true)
    expect(showVaultPicker(['user', 'local', 'project'], keys)).toBe(false)
    expect(showVaultPicker(['user'], keys)).toBe(false)
    expect(showVaultPicker(null, [])).toBe(false)
    expect(showVaultPicker(null, undefined)).toBe(false)
  })
})

describe('isServerDirty', () => {
  it('is false for the draft it was opened with and true after any edit', () => {
    const opened = serverDraftOf(view())
    expect(isServerDirty(opened, opened)).toBe(false)
    expect(isServerDirty({ ...opened, command: 'node2' }, opened)).toBe(true)
    expect(isServerDirty({ ...opened, env: [{ name: 'A', value: '', stored: false }] }, opened)).toBe(true)
  })
})

describe('vaultReference', () => {
  it('writes the reference the run rewrites', () => {
    expect(vaultReference('GITHUB_TOKEN')).toBe('${vault:GITHUB_TOKEN}')
  })

  it('fills an empty value with it, keeps a typed prefix before it, and never repeats it', () => {
    expect(withVaultReference('', 'TOKEN')).toBe('${vault:TOKEN}')
    expect(withVaultReference('Bearer ', 'TOKEN')).toBe('Bearer ${vault:TOKEN}')
    expect(withVaultReference('Bearer ${vault:TOKEN}', 'TOKEN')).toBe('Bearer ${vault:TOKEN}')
    expect(withVaultReference('${vault:OTHER}', 'TOKEN')).toBe('${vault:OTHER}${vault:TOKEN}')
  })
})

const hook = (over: Partial<LoadoutHook> = {}): LoadoutHook => ({
  event: 'PreToolUse',
  matcher: 'Bash',
  type: 'command',
  command: 'echo hi',
  timeout: 5,
  source: 'user',
  plugin: null,
  at: { group: 1, hook: 2 },
  stamp: 'st',
  ...over
})

describe('hook form', () => {
  it('reads a row into a draft that edits in place, and sends it back with its position', () => {
    const d = hookDraftOf(hook(), 'user')
    expect(d).toEqual({
      file: 'user',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'echo hi',
      timeoutText: '5',
      at: { group: 1, hook: 2 },
      stamp: 'st'
    })
    expect(hookInputOf(d)).toEqual({ event: 'PreToolUse', matcher: 'Bash', command: 'echo hi', timeout: 5, at: { group: 1, hook: 2 } })
  })

  it('makes an add with no position, no stamp and no timeout when left empty', () => {
    const d = { ...emptyHookDraft('project'), event: 'Stop', command: ' ls ' }
    expect(hookInputOf(d)).toEqual({ event: 'Stop', matcher: '', command: 'ls' })
    expect(d.stamp).toBeNull()
  })

  it('knows the usual event names', () => {
    expect(HOOK_EVENTS).toEqual(expect.arrayContaining(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart']))
  })

  it('validates the event, the command and the timeout like the server does', () => {
    const ok = { ...emptyHookDraft('user'), event: 'Stop', command: 'ls' }
    expect(hookErrors(ok)).toEqual({})
    expect(hookErrors({ ...ok, event: '' }).event).toBe('Enter the event, like PreToolUse.')
    expect(hookErrors({ ...ok, event: 'pre tool' }).event).toBe('An event is letters and digits only, like PreToolUse.')
    expect(hookErrors({ ...ok, event: '__proto__' }).event).toBe('An event is letters and digits only, like PreToolUse.')
    expect(hookErrors({ ...ok, command: '  ' }).command).toBe('Enter the command to run.')
    expect(hookErrors({ ...ok, command: 'x'.repeat(20_001) }).command).toBe('The command can be at most 20000 characters.')
    expect(hookErrors({ ...ok, matcher: 'x'.repeat(1001) }).matcher).toBe('The matcher can be at most 1000 characters.')
    for (const t of ['0', '-3', 'abc', 'Infinity', '1e999'])
      expect(hookErrors({ ...ok, timeoutText: t }).timeout).toBe('The timeout is a number of seconds above 0, or empty.')
    for (const t of ['', ' ', '30', '0.5']) expect(hookErrors({ ...ok, timeoutText: t }).timeout).toBeUndefined()
  })

  it('sends a typed timeout as a number', () => {
    expect(hookInputOf({ ...emptyHookDraft('user'), event: 'Stop', command: 'ls', timeoutText: ' 12.5 ' }).timeout).toBe(12.5)
  })

  it('is dirty after any edit', () => {
    const opened = hookDraftOf(hook(), 'user')
    expect(isHookDirty(opened, opened)).toBe(false)
    expect(isHookDirty({ ...opened, matcher: 'Edit' }, opened)).toBe(true)
  })
})

const skillView = (over: Partial<SkillView> = {}): SkillView => ({
  scope: 'user',
  name: 'my-skill',
  description: 'Does a thing',
  body: '# Body\n',
  files: ['SKILL.md', 'notes.md'],
  stamp: 'sk',
  ...over
})

describe('skill form', () => {
  it('reads a stored skill with its stamp and files, and sends the stamp back', () => {
    const d = skillDraftOf(skillView())
    expect(d).toMatchObject({
      scope: 'user',
      name: 'my-skill',
      description: 'Does a thing',
      body: '# Body\n',
      stamp: 'sk',
      files: ['SKILL.md', 'notes.md']
    })
    expect(skillInputOf(d)).toEqual({ name: 'my-skill', description: 'Does a thing', body: '# Body\n', stamp: 'sk' })
  })

  it('makes a new skill with no stamp', () => {
    const d = { ...emptySkillDraft('project'), name: 'new-skill', description: ' Does it ', body: 'a\r\nb' }
    expect(skillInputOf(d)).toEqual({ name: 'new-skill', description: 'Does it', body: 'a\nb' })
  })

  it('checks the name of a new skill only, and the reserved folder name', () => {
    const fresh = { ...emptySkillDraft('user'), description: 'd', body: 'b' }
    expect(skillErrors({ ...fresh, name: 'ok-name' })).toEqual({})
    expect(skillErrors({ ...fresh, name: '' }).name).toBe('Give the skill a name.')
    for (const bad of ['My_Skill', 'two--hyphens', '-lead', 'trail-', 'UPPER', 'a'.repeat(101)])
      expect(skillErrors({ ...fresh, name: bad }).name).toBe(EXT_TEXT.badSkillName)
    expect(skillErrors({ ...fresh, name: 'synced' }).name).toBe('That name is reserved.')
    // An existing skill's name is read-only, so an odd stored one never blocks a save.
    expect(skillErrors({ ...skillDraftOf(skillView({ name: 'My_Skill' })) })).toEqual({})
  })

  it('requires a description and limits the sizes the server takes', () => {
    const ok = { ...emptySkillDraft('user'), name: 'ok', description: 'd', body: '' }
    expect(skillErrors({ ...ok, description: '  ' }).description).toBe('Describe when Claude should use the skill.')
    expect(skillErrors({ ...ok, description: 'x'.repeat(5001) }).description).toBe('The description can be at most 5000 characters.')
    expect(skillErrors({ ...ok, body: 'x'.repeat(500_001) }).body).toBe('The instructions can be at most 500000 characters.')
  })

  it('is dirty after any edit', () => {
    const opened = skillDraftOf(skillView())
    expect(isSkillDirty(opened, opened)).toBe(false)
    expect(isSkillDirty({ ...opened, body: opened.body + 'x' }, opened)).toBe(true)
  })
})

describe('isPlainValue', () => {
  it('marks a typed secret-like value, not an empty one or one holding a Vault reference', () => {
    expect(isPlainValue('sk-123')).toBe(true)
    expect(isPlainValue('Bearer abc')).toBe(true)
    expect(isPlainValue('')).toBe(false)
    expect(isPlainValue('  ')).toBe(false)
    expect(isPlainValue('${vault:TOKEN}')).toBe(false)
    expect(isPlainValue('Bearer ${vault:TOKEN}')).toBe(false)
    expect(isPlainValue('${vault:')).toBe(true)
  })
})
