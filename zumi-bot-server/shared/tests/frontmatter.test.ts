import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { displayName, extensionsOf, NEW_AGENT_TEMPLATE, parseAgent, serializeAgent, validateFields } from '@zumibot/shared/frontmatter'
import { ACP_TEXT } from '@zumibot/shared/acp'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import { NO_EXTENSIONS } from '@zumibot/shared/extensions'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const fx = (n: string) => readFileSync(`${fixtures}agents/${n}.md`, 'utf8')
const NO_EXT_FIELDS = { serversOff: null, skillsOff: null, plugins: null, mcpServers: null, hooks: null, acp: null, agui: null }
const unchanged = (raw: string) => {
  const p = parseAgent(raw)
  if (!p.ok) throw new Error(p.error)
  return serializeAgent(raw, p.fields, p.body)
}

test.each(['long-description', 'unknown-keys', 'crlf', 'tools-list', 'with-icon'])('unchanged %s is byte-identical', (n) => {
  expect(unchanged(fx(n))).toBe(fx(n))
})
test('parses fields', () => {
  const p = parseAgent(fx('unknown-keys'))
  expect(p.ok && p.fields).toEqual({
    name: 'odd-agent',
    description: 'Odd one',
    model: 'opus',
    color: 'purple',
    icon: null,
    tools: null,
    commands: null,
    memory: null,
    memoryLimit: null,
    computerUse: null,
    autoCompactWindow: null,
    dailySpendCap: null,
    recall: null,
    provider: null,
    ...NO_EXT_FIELDS,
    mcpServers: { entries: [{ name: 'workiom', def: null }], editable: true }
  })
})
test('tools: comma string and sequence both parse', () => {
  expect((parseAgent('---\nname: a\ndescription: d\ntools: Read, Grep\n---\n') as any).fields.tools).toEqual(['Read', 'Grep'])
  expect((parseAgent(fx('tools-list')) as any).fields.tools).toEqual(['Read', 'Grep'])
})
test('model → null removes only that line, keeps comment, unknown keys, order', () => {
  const raw = fx('unknown-keys')
  const p = parseAgent(raw) as any
  const out = serializeAgent(raw, { ...p.fields, model: null }, p.body)
  expect(out).toBe(raw.replace('model: opus\n', ''))
})
test('long description edit is not folded', () => {
  const raw = fx('long-description')
  const p = parseAgent(raw) as any
  const out = serializeAgent(raw, { ...p.fields, description: p.fields.description + ' more' }, p.body)
  expect(out.split('\n').filter((l) => l.startsWith('description:'))).toHaveLength(1)
  expect(out.endsWith(p.body)).toBe(true)
})
test('crlf round-trip keeps CRLF after an edit', () => {
  const raw = fx('crlf')
  const p = parseAgent(raw) as any
  const out = serializeAgent(raw, { ...p.fields, color: 'red' }, p.body)
  expect(out).toContain('color: red\r\n')
  expect(out.replace(/\r\n/g, '')).not.toContain('\n')
})
test('tools stays a sequence when edited', () => {
  const raw = fx('tools-list')
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, tools: ['Read'] }, p.body)).toMatch(/tools:\n\s+- Read\n---/)
})
test('new agent from template', () => {
  const out = serializeAgent(
    NEW_AGENT_TEMPLATE,
    {
      name: 'helper',
      description: 'Helps.',
      model: 'haiku',
      color: 'blue',
      icon: 'wink',
      tools: ['Read', 'Grep'],
      commands: null,
      memory: null,
      memoryLimit: null,
      computerUse: null,
      autoCompactWindow: null,
      dailySpendCap: null,
      recall: null,
      provider: null,
      ...NO_EXT_FIELDS
    },
    'Be helpful.\n'
  )
  expect(out).toBe('---\nname: helper\ndescription: Helps.\nmodel: haiku\ncolor: blue\nicon: wink\ntools: Read, Grep\n---\nBe helpful.\n')
})
test('parse rejects missing frontmatter, bad yaml, missing name', () => {
  expect(parseAgent('just text')).toEqual({ ok: false, error: 'No frontmatter block (file must start with ---)' })
  expect(parseAgent('---\nname: [oops\n---\n').ok).toBe(false)
  expect(parseAgent('---\ndescription: x\n---\n')).toEqual({ ok: false, error: 'Frontmatter has no name' })
})
test('validateFields', () => {
  const ok = {
    name: 'my-agent2',
    description: 'd',
    model: null,
    color: null,
    icon: null,
    tools: null,
    commands: null,
    memory: null,
    memoryLimit: null,
    computerUse: null,
    autoCompactWindow: null,
    dailySpendCap: null,
    recall: null,
    provider: null,
    ...NO_EXT_FIELDS
  }
  expect(validateFields(ok)).toEqual([])
  expect(validateFields({ ...ok, icon: 'robot' })).toEqual([])
  expect(validateFields({ ...ok, name: 'Bad Name' })).toEqual(['Name must be lowercase letters, digits and single hyphens'])
  expect(validateFields({ ...ok, description: '  ' })).toEqual(['Description is required'])
})
test('validateFields: an ACP agent needs a readable launch with a command', () => {
  const ok = {
    name: 'a',
    description: 'd',
    model: null,
    color: null,
    icon: null,
    tools: null,
    commands: null,
    memory: null,
    memoryLimit: null,
    computerUse: null,
    autoCompactWindow: null,
    dailySpendCap: null,
    recall: null,
    provider: null,
    ...NO_EXT_FIELDS
  }
  const launch = { command: 'gemini', args: ['--acp'], authEnv: [] }
  expect(validateFields({ ...ok, provider: 'acp', acp: launch })).toEqual([])
  // Picked in the Engine select with no command yet: refused, never saved as an agent that can't run.
  expect(validateFields({ ...ok, provider: 'acp' })).toEqual([ACP_TEXT.commandRequired])
  // A file whose acp: did not parse (an unquoted number in args, say): the hint, not "no command".
  expect(validateFields({ ...ok, provider: 'acp' }, false)).toEqual([ACP_TEXT.launchUnreadable])
  // A caller's launch that would be dropped on write is refused instead.
  expect(validateFields({ ...ok, provider: 'acp', acp: { ...launch, command: '' } })).toEqual([ACP_TEXT.commandRequired])
  expect(validateFields({ ...ok, provider: 'acp', acp: { ...launch, authEnv: ['lower'] } })).toEqual([ACP_TEXT.authEnvInvalid])
  // A refused argument blocks the save, as agents:save does.
  expect(validateFields({ ...ok, provider: 'acp', acp: { ...launch, args: ['--yolo'] } })).toEqual([ACP_TEXT.refusedArg('--yolo')])
  // Not an ACP agent: an absent or unreadable acp: is inert and kept untouched.
  expect(validateFields(ok)).toEqual([])
  expect(validateFields(ok, false)).toEqual([])
})
test('validateFields reads parseAgent: an unquoted number in args gets the hint', () => {
  const p = parseAgent('---\nname: a\ndescription: d\nprovider: acp\nacp:\n  command: srv\n  args: [--port, 8080]\n---\nB\n') as any
  expect(validateFields(p.fields, p.acpEditable)).toEqual([ACP_TEXT.launchUnreadable])
  const q = parseAgent('---\nname: a\ndescription: d\nprovider: acp\nacp:\n  command: srv\n  args: [--port, "8080"]\n---\nB\n') as any
  expect(validateFields(q.fields, q.acpEditable)).toEqual([])
})
test('body-only edit keeps oddly formatted frontmatter verbatim', () => {
  const raw = fx('odd-format')
  const p = parseAgent(raw) as any
  const head = raw.slice(0, raw.indexOf('Old body.') - 1)
  expect(serializeAgent(raw, p.fields, '\nNew body.\n')).toBe(head + '\nNew body.\n')
})
test('parses icon', () => {
  const p = parseAgent(fx('with-icon'))
  expect(p.ok && p.fields).toEqual({
    name: 'icon-agent',
    description: 'Has a face',
    model: null,
    color: 'green',
    icon: 'wink',
    tools: null,
    commands: null,
    memory: null,
    memoryLimit: null,
    computerUse: null,
    autoCompactWindow: null,
    dailySpendCap: null,
    recall: null,
    provider: null,
    ...NO_EXT_FIELDS
  })
})
test('icon added goes right after color', () => {
  const raw = fx('unknown-keys')
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, icon: 'wink' }, p.body)).toBe(raw.replace('color: purple\n', 'color: purple\nicon: wink\n'))
})
test('icon added without color is appended', () => {
  const raw = '---\nname: a\ndescription: d\n---\nB\n'
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, icon: 'circles' }, p.body)).toBe('---\nname: a\ndescription: d\nicon: circles\n---\nB\n')
})
test('icon → null removes only that line', () => {
  const raw = fx('with-icon')
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, icon: null }, p.body)).toBe(raw.replace('icon: wink\n', ''))
})
test('odd icon values stay strings and round-trip', () => {
  expect((parseAgent('---\nname: a\ndescription: d\nicon: Wink\n---\n') as any).fields.icon).toBe('Wink')
  expect((parseAgent('---\nname: a\ndescription: d\nicon: 3\n---\n') as any).fields.icon).toBe('3')
  const raw = '---\nname: a\ndescription: d\nicon: robot\n---\nB\n'
  expect(unchanged(raw)).toBe(raw)
})

test.each(['icon:', 'icon: ~'])('picking a face when the file has an empty "%s" key yields one icon line', (empty) => {
  const raw = `---\nname: a\ndescription: d\ncolor: red\n${empty}\n---\nB\n`
  const p = parseAgent(raw) as any
  const out = serializeAgent(raw, { ...p.fields, icon: 'wink' }, p.body)
  expect(out.match(/^icon:/gm)).toHaveLength(1)
  expect(out).toContain('icon: wink\n')
  expect(parseAgent(out).ok).toBe(true)
})
test('changing an existing icon keeps the key position', () => {
  const raw = fx('with-icon')
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, icon: 'circles' }, p.body)).toBe(raw.replace('icon: wink', 'icon: circles'))
})
test.each([
  ['workiom5-assistance', 'Workiom5 Assistance'],
  ['zumi-bot', 'Zumi Bot'],
  ['lister', 'Lister'],
  ['Gym Exercise Creator', 'Gym Exercise Creator'],
  ['odd--name-', 'Odd Name'],
  ['', '']
])('displayName(%j) is %j', (name, label) => {
  expect(displayName(name)).toBe(label)
})

test('parses commands and leaves an unchanged file verbatim', () => {
  const raw =
    '---\nname: a\ndescription: d\ncommands:\n  - name: check\n    description: c\n    prompt: |\n      Use $ARGUMENTS\n---\nbody\n'
  const p = parseAgent(raw)
  if (!p.ok) throw new Error(p.error)
  expect(p.fields.commands).toEqual([{ name: 'check', description: 'c', prompt: 'Use $ARGUMENTS\n' }])
  expect(serializeAgent(raw, p.fields, 'body\n')).toBe(raw)
})
test('writes commands and removes the key when emptied', () => {
  const raw = '---\nname: a\ndescription: d\n---\nbody\n'
  const p = parseAgent(raw)
  if (!p.ok) throw new Error(p.error)
  const added = serializeAgent(raw, { ...p.fields, commands: [{ name: 'fix', description: 'f', prompt: 'line1\nline2' }] }, p.body)
  const back = parseAgent(added)
  if (!back.ok) throw new Error(back.error)
  expect(back.fields.commands).toEqual([{ name: 'fix', description: 'f', prompt: 'line1\nline2' }])
  expect(serializeAgent(added, { ...back.fields, commands: null, memory: null, memoryLimit: null, computerUse: null }, back.body)).toBe(raw)
})
test('an empty commands list equals an absent key, so nothing is rewritten', () => {
  const raw = '---\nname:   a   # odd\ndescription: >\n  folded\n  text\n---\nbody\n'
  const p = parseAgent(raw)
  if (!p.ok) throw new Error(p.error)
  expect(serializeAgent(raw, { ...p.fields, commands: [] }, p.body)).toBe(raw)
  const withKey = '---\nname: a\ndescription: d\ncommands:\n  - name: c\n    description: d\n    prompt: p\n---\nbody\n'
  const q = parseAgent(withKey)
  if (!q.ok) throw new Error(q.error)
  expect(serializeAgent(withKey, { ...q.fields, commands: [] }, q.body)).toBe('---\nname: a\ndescription: d\n---\nbody\n')
})
test('an agent whose commands is not a list still parses', () => {
  const p = parseAgent('---\nname: a\ndescription: d\ncommands: nope\n---\n')
  expect(p.ok && p.fields.commands).toEqual([])
})

test('memory and memoryLimit parse; a non-number limit is null', () => {
  const p = parseAgent('---\nname: a\ndescription: d\nmemory: user\nmemoryLimit: 50\n---\n') as any
  expect([p.fields.memory, p.fields.memoryLimit]).toEqual(['user', 50])
  expect((parseAgent('---\nname: a\ndescription: d\nmemoryLimit: lots\n---\n') as any).fields.memoryLimit).toBeNull()
  expect((parseAgent('---\nname: a\ndescription: d\nmemoryLimit: 2.5\n---\n') as any).fields.memoryLimit).toBeNull()
})
test('memory added to unknown-keys adds one line, keeps the rest', () => {
  const raw = fx('unknown-keys')
  const p = parseAgent(raw) as any
  const out = serializeAgent(raw, { ...p.fields, memory: 'user' }, p.body)
  const rawLines = raw.split('\n')
  expect(out.split('\n').filter((l) => !rawLines.includes(l))).toEqual(['memory: user'])
  expect(out.split('\n').filter((l) => rawLines.includes(l))).toEqual(rawLines)
})
test('memory null deletes the key; memoryLimit change writes only that key', () => {
  const raw = '---\nname: a\ndescription: d\nmemory: user\nmemoryLimit: 50\n---\nB\n'
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, memory: null }, p.body)).toBe(raw.replace('memory: user\n', ''))
  expect(serializeAgent(raw, { ...p.fields, memoryLimit: 100 }, p.body)).toBe(raw.replace('memoryLimit: 50', 'memoryLimit: 100'))
  expect(serializeAgent(raw, { ...p.fields, memoryLimit: null }, p.body)).toBe(raw.replace('memoryLimit: 50\n', ''))
  expect(serializeAgent(raw, p.fields, 'C\n')).toBe(raw.replace('B\n', 'C\n'))
})

test('autoCompactWindow parses a whole token count the CLI accepts (100K to 1M); anything else is null', () => {
  const f = (line: string) => (parseAgent(`---\nname: a\ndescription: d\n${line}---\n`) as any).fields.autoCompactWindow
  expect(f('autoCompactWindow: 400000\n')).toBe(400000)
  expect(f('autoCompactWindow: 100000\n')).toBe(100000)
  expect(f('autoCompactWindow: 1000000\n')).toBe(1000000)
  expect(f('')).toBeNull()
  expect(f('autoCompactWindow: 99999\n')).toBeNull()
  expect(f('autoCompactWindow: 1000001\n')).toBeNull()
  expect(f('autoCompactWindow: 400k\n')).toBeNull()
  expect(f('autoCompactWindow: 400000.5\n')).toBeNull()
})
test('autoCompactWindow change writes only that key, and null deletes it', () => {
  const raw = '---\nname: a\ndescription: d\nautoCompactWindow: 400000\n---\nB\n'
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, autoCompactWindow: 300000 }, p.body)).toBe(raw.replace('400000', '300000'))
  expect(serializeAgent(raw, { ...p.fields, autoCompactWindow: null }, p.body)).toBe(raw.replace('autoCompactWindow: 400000\n', ''))
  const plain = '---\nname: a\ndescription: d\n---\nB\n'
  expect(serializeAgent(plain, { ...(parseAgent(plain) as any).fields, autoCompactWindow: 200000 }, 'B\n')).toBe(
    '---\nname: a\ndescription: d\nautoCompactWindow: 200000\n---\nB\n'
  )
})

test('computerUse parses: true only for YAML true, absent is null, anything else false', () => {
  const f = (line: string) => (parseAgent(`---\nname: a\ndescription: d\n${line}---\n`) as any).fields.computerUse
  expect(f('computerUse: true\n')).toBe(true)
  expect(f('')).toBeNull()
  expect(f('computerUse: "yes"\n')).toBe(false)
  expect(f('computerUse: false\n')).toBe(false)
})
test('computerUse true adds the key, null deletes it, unchanged splices the head verbatim', () => {
  const raw = '---\nname: a\ndescription: d\n---\nB\n'
  const p = parseAgent(raw) as any
  const on = serializeAgent(raw, { ...p.fields, computerUse: true }, p.body)
  expect(on).toBe('---\nname: a\ndescription: d\ncomputerUse: true\n---\nB\n')
  const q = parseAgent(on) as any
  expect(serializeAgent(on, { ...q.fields, computerUse: null }, q.body)).toBe(raw)
  expect(serializeAgent(on, q.fields, 'C\n')).toBe(on.replace('B\n', 'C\n'))
})

test('a command model round-trips, written after description, and a model change rewrites the file', () => {
  const raw = '---\nname: a\ndescription: d\n---\nbody\n'
  const p = parseAgent(raw)
  if (!p.ok) throw new Error(p.error)
  const cmds = [{ name: 'card', description: 'Create a card', prompt: 'Make $ARGUMENTS\n', todos: true as const, model: 'sonnet' }]
  const out = serializeAgent(raw, { ...p.fields, commands: cmds }, p.body)
  expect(out).toContain('    description: Create a card\n    model: sonnet\n    todos: true\n    prompt: |\n')
  const back = parseAgent(out)
  if (!back.ok) throw new Error(back.error)
  expect(back.fields.commands?.[0].model).toBe('sonnet')
  expect(serializeAgent(out, back.fields, back.body)).toBe(out)
  const none = serializeAgent(
    out,
    { ...back.fields, commands: [{ name: 'card', description: 'Create a card', prompt: 'Make $ARGUMENTS\n', todos: true }] },
    back.body
  )
  expect(none).not.toContain('model:')
})

test('a command with todos round-trips through write and parse with prompt still a block scalar', () => {
  const raw = '---\nname: a\ndescription: d\n---\nbody\n'
  const p = parseAgent(raw)
  if (!p.ok) throw new Error(p.error)
  // todos comes last in the object, as the editor spreads it, but the file keeps description, todos, prompt.
  const cmds = [
    { name: 'my-day', description: 'Daily brief', prompt: 'Plan: my day\nthen: more\n', todos: true as const },
    { name: 'fix', description: 'f', prompt: 'x' }
  ]
  const out = serializeAgent(raw, { ...p.fields, commands: cmds }, p.body)
  expect(out).toContain('    description: Daily brief\n    todos: true\n    prompt: |\n      Plan: my day\n      then: more\n')
  expect(out.match(/todos:/g)).toHaveLength(1)
  const back = parseAgent(out)
  if (!back.ok) throw new Error(back.error)
  expect(back.fields.commands).toEqual([
    { name: 'my-day', description: 'Daily brief', todos: true, prompt: 'Plan: my day\nthen: more\n' },
    { name: 'fix', description: 'f', prompt: 'x' }
  ])
  // Unticking omits the key, and a no-change save leaves the file as it is.
  expect(serializeAgent(out, back.fields, back.body)).toBe(out)
  const off = serializeAgent(
    out,
    { ...back.fields, commands: [{ name: 'my-day', description: 'Daily brief', prompt: 'Plan: my day\nthen: more\n' }, cmds[1]] },
    back.body
  )
  expect(off).not.toContain('todos')
})

test('provider parses: only the exact string codex, anything else is null', () => {
  const f = (line: string) => (parseAgent(`---\nname: a\ndescription: d\n${line}---\n`) as any).fields.provider
  expect(f('provider: codex\n')).toBe('codex')
  expect(f('provider: Codex\n')).toBeNull()
  expect(f('provider: claude\n')).toBeNull()
  expect(f('provider: "codex "\n')).toBeNull()
  expect(f('')).toBeNull()
})
test('provider change writes only that key, null deletes it, body-only keeps the frontmatter verbatim', () => {
  const raw = '---\nname: a\ndescription: d\nprovider: codex\n---\nB\n'
  const p = parseAgent(raw) as any
  expect(p.fields.provider).toBe('codex')
  expect(serializeAgent(raw, { ...p.fields, provider: null }, p.body)).toBe('---\nname: a\ndescription: d\n---\nB\n')
  const plain = '---\nname: a\n# keep me\ndescription:   d\n---\nB\n'
  const q = parseAgent(plain) as any
  expect(serializeAgent(plain, { ...q.fields, provider: 'codex' }, 'B\n')).toBe(
    '---\nname: a\n# keep me\ndescription: d\nprovider: codex\n---\nB\n'
  )
  expect(serializeAgent(plain, q.fields, 'New body\n')).toBe('---\nname: a\n# keep me\ndescription:   d\n---\nNew body\n')
})

// ---- Servers / Plugins / Skills / Hooks keys ----
const head = '---\nname: a\ndescription: d\n'
const fieldsOf = (yaml: string) => {
  const p = parseAgent(`${head}${yaml}---\nB\n`)
  if (!p.ok) throw new Error(p.error)
  return p.fields
}

test('the five extension keys are null when absent', () => {
  const f = fieldsOf('')
  expect([f.serversOff, f.skillsOff, f.plugins, f.mcpServers, f.hooks]).toEqual([null, null, null, null, null])
})
test('serversOff and skillsOff parse as lists of non-empty strings, anything else is null', () => {
  expect(fieldsOf('serversOff: [claude.ai Gmail]\n').serversOff).toEqual(['claude.ai Gmail'])
  expect(fieldsOf('serversOff:\n  - plugin:playwright:playwright\n  - ""\n  - 3\n').serversOff).toEqual(['plugin:playwright:playwright'])
  expect(fieldsOf('skillsOff: [apple-design, caveman]\n').skillsOff).toEqual(['apple-design', 'caveman'])
  expect(fieldsOf('serversOff: []\n').serversOff).toBeNull()
  expect(fieldsOf('serversOff: nope\n').serversOff).toBeNull()
  expect(fieldsOf('skillsOff:\n').skillsOff).toBeNull()
})
test('plugins keeps only boolean entries, and none left is null', () => {
  expect(fieldsOf('plugins: {a@m: false, b@m: "yes", c@m: true}\n').plugins).toEqual({ 'a@m': false, 'c@m': true })
  expect(fieldsOf('plugins: {b@m: "yes"}\n').plugins).toBeNull()
  expect(fieldsOf('plugins: [a@m]\n').plugins).toBeNull()
})
test('mcpServers: references and inline definitions are editable', () => {
  const f = fieldsOf('mcpServers:\n  - github\n  - db:\n      command: node\n')
  expect(f.mcpServers).toEqual({
    entries: [
      { name: 'github', def: null },
      { name: 'db', def: { command: 'node' } }
    ],
    editable: true
  })
  expect(fieldsOf('mcpServers: []\n').mcpServers).toEqual({ entries: [], editable: true })
})
test('mcpServers: a map form, a multi-key item or a def the CLI format does not have is not editable', () => {
  const map = fieldsOf('mcpServers:\n  db:\n    command: node\n    cwd: /x\n').mcpServers
  expect(map?.editable).toBe(false)
  const map2 = fieldsOf('mcpServers:\n  db:\n    command: node\n').mcpServers
  expect(map2).toEqual({ entries: [{ name: 'db', def: { command: 'node' } }], editable: false })
  expect(fieldsOf('mcpServers:\n  - a:\n      command: x\n    b:\n      command: y\n').mcpServers?.editable).toBe(false)
  const odd = fieldsOf('mcpServers:\n  - github\n  - db:\n      command: node\n      cwd: /x\n').mcpServers
  expect(odd).toEqual({ entries: [{ name: 'github', def: null }], editable: false })
  expect(fieldsOf('mcpServers:\n  - 3\n').mcpServers?.editable).toBe(false)
  expect(fieldsOf('mcpServers: github\n').mcpServers).toEqual({ entries: [], editable: false })
})
test('hooks parse in settings.json format; an unknown shape is kept but not editable', () => {
  const ok = fieldsOf(
    'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n          timeout: 5\n'
  ).hooks
  expect(ok).toEqual({
    config: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh', timeout: 5 }] }] },
    editable: true
  })
  expect(fieldsOf('hooks:\n  Stop:\n    - hooks:\n        - type: prompt\n          prompt: check\n').hooks?.editable).toBe(false)
  expect(fieldsOf('hooks: nope\n').hooks).toEqual({ config: {}, editable: false })
  expect(fieldsOf('hooks: {}\n').hooks).toEqual({ config: {}, editable: true })
})
test('an unchanged agent with extension keys splices the frontmatter verbatim', () => {
  const raw = `${head}serversOff:   [claude.ai Gmail]   # why\nplugins:\n    a@m: false\nmcpServers:\n    - db:\n          command: node\nhooks:\n    Stop:\n        - hooks:\n              - {type: command, command: x}\n---\nB\n`
  expect(unchanged(raw)).toBe(raw)
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, p.fields, 'C\n')).toBe(raw.replace('B\n', 'C\n'))
})
test('serversOff and skillsOff write a list, change only their key, and null or empty deletes it', () => {
  const raw = `${head}model: opus\n---\nB\n`
  const p = parseAgent(raw) as any
  const on = serializeAgent(raw, { ...p.fields, serversOff: ['claude.ai Gmail', 'plugin:chrome-devtools-mcp:chrome-devtools'] }, p.body)
  expect(on).toBe(`${head}model: opus\nserversOff:\n  - claude.ai Gmail\n  - plugin:chrome-devtools-mcp:chrome-devtools\n---\nB\n`)
  const q = parseAgent(on) as any
  expect(q.fields.serversOff).toEqual(['claude.ai Gmail', 'plugin:chrome-devtools-mcp:chrome-devtools'])
  expect(serializeAgent(on, { ...q.fields, serversOff: ['claude.ai Gmail'] }, q.body)).toBe(
    `${head}model: opus\nserversOff:\n  - claude.ai Gmail\n---\nB\n`
  )
  expect(serializeAgent(on, { ...q.fields, serversOff: null }, q.body)).toBe(raw)
  expect(serializeAgent(on, { ...q.fields, serversOff: [] }, q.body)).toBe(raw)
  const s = serializeAgent(raw, { ...p.fields, skillsOff: ['apple-design'] }, p.body)
  expect(s).toBe(`${head}model: opus\nskillsOff:\n  - apple-design\n---\nB\n`)
  expect(serializeAgent(s, { ...(parseAgent(s) as any).fields, skillsOff: null }, 'B\n')).toBe(raw)
})
test('changing only serversOff leaves tools, commands and a comment as they were', () => {
  const tools = 'tools: Read, Grep, Bash # the agent reads only\n'
  const commands = 'commands:\n  - name: check\n    description: Check the inbox\n    prompt: |\n      Look at $ARGUMENTS.\n'
  const raw = `${head}${tools}${commands}---\nB\n`
  const p = parseAgent(raw) as any
  const out = serializeAgent(raw, { ...p.fields, serversOff: ['claude.ai Gmail'] }, p.body)
  expect(out).toContain(tools)
  expect(out).toContain(commands)
  expect(out).toContain('serversOff:\n  - claude.ai Gmail\n')
  const q = parseAgent(out) as any
  expect(q.fields.tools).toEqual(p.fields.tools)
  expect(q.fields.commands).toEqual(p.fields.commands)
  expect(q.fields.serversOff).toEqual(['claude.ai Gmail'])
})
test('plugins write a map of booleans, and null or empty deletes the key', () => {
  const raw = `${head}---\nB\n`
  const p = parseAgent(raw) as any
  const on = serializeAgent(
    raw,
    { ...p.fields, plugins: { 'caveman@caveman': false, 'frontend-design@claude-plugins-official': true } },
    p.body
  )
  expect(on).toBe(`${head}plugins:\n  caveman@caveman: false\n  frontend-design@claude-plugins-official: true\n---\nB\n`)
  const q = parseAgent(on) as any
  expect(serializeAgent(on, { ...q.fields, plugins: null }, q.body)).toBe(raw)
  expect(serializeAgent(on, { ...q.fields, plugins: {} }, q.body)).toBe(raw)
})
test('mcpServers writes a list of {name: def} with keys in order type, command, args, env, url, headers', () => {
  const raw = `${head}---\nB\n`
  const p = parseAgent(raw) as any
  const out = serializeAgent(
    raw,
    {
      ...p.fields,
      mcpServers: {
        editable: true,
        entries: [
          { name: 'github', def: null },
          { name: 'api', def: { headers: { Authorization: 'Bearer ${vault:GITHUB_TOKEN}' }, url: 'https://x.test/mcp', type: 'http' } },
          { name: 'my-db', def: { env: { DB_URL: 'postgres://x' }, args: ['server.js', '--fast'], command: 'node', type: 'stdio' } }
        ]
      }
    },
    p.body
  )
  expect(out).toBe(
    `${head}mcpServers:\n  - github\n  - api:\n      type: http\n      url: https://x.test/mcp\n      headers:\n        Authorization: Bearer \${vault:GITHUB_TOKEN}\n` +
      '  - my-db:\n      type: stdio\n      command: node\n      args:\n        - server.js\n        - --fast\n      env:\n        DB_URL: postgres://x\n---\nB\n'
  )
  const back = parseAgent(out) as any
  expect(back.fields.mcpServers).toEqual({
    editable: true,
    entries: [
      { name: 'github', def: null },
      { name: 'api', def: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${vault:GITHUB_TOKEN}' } } },
      { name: 'my-db', def: { type: 'stdio', command: 'node', args: ['server.js', '--fast'], env: { DB_URL: 'postgres://x' } } }
    ]
  })
  expect(serializeAgent(out, back.fields, back.body)).toBe(out)
  expect(serializeAgent(out, { ...back.fields, mcpServers: null }, back.body)).toBe(raw)
  expect(serializeAgent(out, { ...back.fields, mcpServers: { entries: [], editable: true } }, back.body)).toBe(raw)
})
test('a server name with spaces, dots and colons survives the file', () => {
  const raw = `${head}---\nB\n`
  const p = parseAgent(raw) as any
  const names = ['claude.ai Google Drive', 'plugin:chrome-devtools-mcp:chrome-devtools']
  const out = serializeAgent(
    raw,
    { ...p.fields, serversOff: names, mcpServers: { editable: true, entries: [{ name: 'a: b # c', def: { command: 'x' } }] } },
    p.body
  )
  const back = parseAgent(out) as any
  expect(back.fields.serversOff).toEqual(names)
  expect(back.fields.mcpServers.entries).toEqual([{ name: 'a: b # c', def: { command: 'x' } }])
})
test('hooks write a map of groups with keys matcher, hooks and type, command, timeout, and null deletes the key', () => {
  const raw = `${head}---\nB\n`
  const p = parseAgent(raw) as any
  const config = {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: './check.sh', timeout: 5 }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command' as const, command: 'echo done' }] }]
  }
  const out = serializeAgent(raw, { ...p.fields, hooks: { config, editable: true } }, p.body)
  expect(out).toBe(
    `${head}hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n          timeout: 5\n  Stop:\n    - hooks:\n        - type: command\n          command: echo done\n---\nB\n`
  )
  const back = parseAgent(out) as any
  expect(back.fields.hooks.editable).toBe(true)
  expect(serializeAgent(out, back.fields, back.body)).toBe(out)
  expect(serializeAgent(out, { ...back.fields, hooks: null }, back.body)).toBe(raw)
  expect(serializeAgent(out, { ...back.fields, hooks: { config: {}, editable: true } }, back.body)).toBe(raw)
})
test('keeps an unknown hooks shape verbatim', () => {
  const hooks = 'hooks:\n  Stop:\n    - hooks:\n        - type: prompt\n          prompt: Is the work finished?\n          model: haiku\n'
  const raw = `${head}${hooks}---\nB\n`
  const p = parseAgent(raw) as any
  expect(p.fields.hooks.editable).toBe(false)
  const out = serializeAgent(raw, { ...p.fields, serversOff: ['claude.ai Gmail'] }, p.body)
  expect(out).toBe(`${head}${hooks}serversOff:\n  - claude.ai Gmail\n---\nB\n`)
  // A caller's edit of the entries never rewrites a block the editor could not write back whole.
  const edited = serializeAgent(raw, { ...p.fields, hooks: { config: { Stop: [] }, editable: false } }, p.body)
  expect(edited).toBe(raw)
  // An explicit null still removes it.
  expect(serializeAgent(raw, { ...p.fields, hooks: null }, p.body)).toBe(`${head}---\nB\n`)
})
test('an odd-format unknown hooks block keeps its value and comments when only another field changes', () => {
  // Indentation and flow style may be normalised (the document is re-stringified); the value and every comment must survive.
  const hooks =
    'hooks:   # why hooks\n    # note one\n    Stop:   # c stop\n        - hooks:\n              - {type: prompt, prompt: x}   # flow prompt\n'
  const raw = `---\n# top comment\nname: a\ndescription: d\ncolor: blue   # keep color note\n${hooks}model: opus\n---\nB\n`
  const p = parseAgent(raw) as any
  expect(p.fields.hooks.editable).toBe(false)
  const out = serializeAgent(raw, { ...p.fields, color: 'red' }, p.body)
  const back = parseAgent(out) as any
  expect(back.ok).toBe(true)
  expect(back.fields.hooks).toEqual(p.fields.hooks)
  for (const note of ['# top comment', '# why hooks', '# note one', '# c stop', '# flow prompt', '# keep color note'])
    expect(out).toContain(note)
  expect(back.fields).toEqual({ ...p.fields, color: 'red' })
  expect(out.endsWith('---\nB\n')).toBe(true)
})
// The file's own flag decides, never the caller's: a value that only claims `editable: true` cannot touch an unrecognised block.
const SERVERS_MAP = 'mcpServers:\n  db:\n    command: node\n    cwd: /x\n'
const HOOKS_PROMPT = 'hooks:\n  Stop:\n    - hooks:\n        - type: prompt\n          prompt: Is the work finished?\n'
const claimed = (yaml: string) => {
  const raw = `${head}${yaml}---\nB\n`
  const p = parseAgent(raw) as any
  return { raw, p }
}
test('an empty editable mcpServers value does not delete a non-editable file block', () => {
  const { raw, p } = claimed(SERVERS_MAP)
  expect(p.fields.mcpServers.editable).toBe(false)
  expect(serializeAgent(raw, { ...p.fields, mcpServers: { entries: [], editable: true } }, p.body)).toBe(raw)
})
test('an editable mcpServers value does not replace a non-editable file block, so cwd is kept', () => {
  const { raw, p } = claimed(SERVERS_MAP)
  expect(
    serializeAgent(raw, { ...p.fields, mcpServers: { entries: [{ name: 'x', def: { command: 'y' } }], editable: true } }, p.body)
  ).toBe(raw)
})
test('an editable hooks value neither deletes nor overwrites a non-editable file block', () => {
  const { raw, p } = claimed(HOOKS_PROMPT)
  expect(p.fields.hooks.editable).toBe(false)
  expect(serializeAgent(raw, { ...p.fields, hooks: { config: {}, editable: true } }, p.body)).toBe(raw)
  const command = { Stop: [{ hooks: [{ type: 'command' as const, command: 'echo done' }] }] }
  expect(serializeAgent(raw, { ...p.fields, hooks: { config: command, editable: true } }, p.body)).toBe(raw)
})
test('only an explicit null removes a non-editable mcpServers or hooks block', () => {
  const s = claimed(SERVERS_MAP)
  const h = claimed(HOOKS_PROMPT)
  expect(serializeAgent(s.raw, { ...s.p.fields, mcpServers: null }, s.p.body)).toBe(`${head}---\nB\n`)
  expect(serializeAgent(h.raw, { ...h.p.fields, hooks: null }, h.p.body)).toBe(`${head}---\nB\n`)
})
test('keeps an unknown mcpServers shape verbatim through a save that changed another field', () => {
  const servers = 'mcpServers:\n  db:\n    command: node\n    cwd: /x\n'
  const raw = `${head}${servers}---\nB\n`
  const p = parseAgent(raw) as any
  expect(p.fields.mcpServers.editable).toBe(false)
  expect(serializeAgent(raw, { ...p.fields, color: 'red' }, p.body)).toBe(`${head}${servers}color: red\n---\nB\n`)
  expect(serializeAgent(raw, { ...p.fields, mcpServers: { entries: [], editable: false } }, p.body)).toBe(raw)
})
test('extensionsOf maps null to empty lists and returns fresh objects', () => {
  const none = extensionsOf(fieldsOf(''))
  expect(none).toEqual(NO_EXTENSIONS)
  expect(none).not.toBe(NO_EXTENSIONS)
  expect(none.serversOff).not.toBe(NO_EXTENSIONS.serversOff)
  expect(extensionsOf(fieldsOf(''))).not.toBe(none)
  const f = fieldsOf(
    'serversOff: [x]\nskillsOff: [s]\nplugins: {a@m: false}\nmcpServers:\n  - r\n  - db:\n      command: node\nhooks:\n  Stop:\n    - hooks:\n        - type: prompt\n          prompt: p\n'
  )
  const ext = extensionsOf(f)
  expect(ext).toEqual({
    serversOff: ['x'],
    skillsOff: ['s'],
    plugins: { 'a@m': false },
    servers: [
      { name: 'r', def: null },
      { name: 'db', def: { command: 'node' } }
    ],
    serversEditable: true,
    hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'p' }] }] },
    hooksEditable: false
  })
  // Mutating the result never reaches the parsed fields.
  ext.serversOff.push('y')
  ext.plugins['b@m'] = true
  ext.servers[1].def!.command = 'z'
  ext.hooks.Stop.length = 0
  expect(f.serversOff).toEqual(['x'])
  expect(f.plugins).toEqual({ 'a@m': false })
  expect(f.mcpServers?.entries[1].def).toEqual({ command: 'node' })
  expect(f.hooks?.config.Stop).toHaveLength(1)
})
test('a value that claims to be editable but is outside what the file format holds is not written', () => {
  const raw = `${head}---\nB\n`
  const p = parseAgent(raw) as any
  const prompt = { Stop: [{ hooks: [{ type: 'prompt', prompt: 'p' }] }] }
  expect(serializeAgent(raw, { ...p.fields, hooks: { config: prompt, editable: true } }, p.body)).toBe(raw)
  const cwd = { name: 'db', def: { command: 'node', cwd: '/x' } as any }
  expect(serializeAgent(raw, { ...p.fields, mcpServers: { entries: [cwd], editable: true } }, p.body)).toBe(raw)
})
test('extension keys keep CRLF line ends', () => {
  const raw = `---\r\nname: a\r\ndescription: d\r\n---\r\nB\r\n`
  const p = parseAgent(raw) as any
  const out = serializeAgent(
    raw,
    { ...p.fields, serversOff: ['x'], mcpServers: { entries: [{ name: 'db', def: { command: 'node' } }], editable: true } },
    p.body
  )
  expect(out).toBe(
    '---\r\nname: a\r\ndescription: d\r\nserversOff:\r\n  - x\r\nmcpServers:\r\n  - db:\r\n      command: node\r\n---\r\nB\r\n'
  )
})

const ACP_HEAD = '---\nname: a\ndescription: d\nprovider: acp\n'
test('acp: parses the nested map, with args and authEnv optional', () => {
  const f = parseAgent(`${ACP_HEAD}acp:\n  command: gemini\n  args: ["--acp"]\n  authEnv: [GEMINI_API_KEY]\n---\nB\n`) as any
  expect(f.fields.acp).toEqual({ command: 'gemini', args: ['--acp'], authEnv: ['GEMINI_API_KEY'] })
  expect(f.acpEditable).toBe(true)
  expect((parseAgent(`${ACP_HEAD}acp:\n  command: gemini\n---\nB\n`) as any).fields.acp).toEqual({
    command: 'gemini',
    args: [],
    authEnv: []
  })
  const none = parseAgent('---\nname: a\ndescription: d\n---\nB\n') as any
  expect([none.fields.acp, none.acpEditable]).toEqual([null, true])
})
test('acp: an acp that does not parse is null and not editable', () => {
  for (const v of ['gemini', '[a]', '{command: ""}', '{command: x, args: [1]}', '{command: x, authEnv: [lower]}']) {
    const p = parseAgent(`${ACP_HEAD}acp: ${v}\n---\nB\n`) as any
    expect([v, p.fields.acp, p.acpEditable]).toEqual([v, null, false])
  }
})
test('acp: writes a nested map, and null deletes the key', () => {
  const raw = '---\nname: a\ndescription: d\n---\nB\n'
  const p = parseAgent(raw) as any
  const out = serializeAgent(raw, { ...p.fields, provider: 'acp', acp: { command: 'gemini', args: ['--acp'], authEnv: [] } }, p.body)
  expect(out).toBe('---\nname: a\ndescription: d\nprovider: acp\nacp:\n  command: gemini\n  args:\n    - --acp\n  authEnv: []\n---\nB\n')
  const back = parseAgent(out) as any
  expect(back.fields.acp).toEqual({ command: 'gemini', args: ['--acp'], authEnv: [] })
  expect(serializeAgent(out, { ...back.fields, acp: null }, back.body)).toBe('---\nname: a\ndescription: d\nprovider: acp\n---\nB\n')
})
test('acp: saving another field keeps the acp block byte for byte', () => {
  const raw = `${ACP_HEAD}acp:\n    command:   gemini   # why\n    args: [ "--acp" ]\ndescription2: x\n---\nB\n`
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields }, 'C\n')).toBe(raw.replace('B\n', 'C\n'))
  const out = serializeAgent(raw, { ...p.fields, color: 'red' }, p.body)
  expect(out).toContain('command: gemini')
  expect(parseAgent(out)).toMatchObject({ ok: true, fields: { acp: p.fields.acp, color: 'red' } })
})
test('acp: a block that does not parse is never rewritten or removed from a caller value', () => {
  const raw = `${ACP_HEAD}acp: gemini --acp\n---\nB\n`
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, color: 'red' }, p.body)).toContain('acp: gemini --acp')
  const forced = serializeAgent(raw, { ...p.fields, acp: { command: 'evil', args: [], authEnv: [] } }, p.body)
  expect(forced).toBe(raw)
  expect(serializeAgent(raw, { ...p.fields, acp: null }, p.body)).toBe(raw)
})

const AGUI_HEAD = '---\nname: a\ndescription: d\n'
const EP = 'https://agents.example.com/run'
test('agui: parses the nested map, with authKey and authHeader optional', () => {
  const f = parseAgent(`${AGUI_HEAD}agui:\n  endpoint: ${EP}\n  authKey: EXAMPLE_AGENT_KEY\n  authHeader: X-Api-Key\n---\nB\n`) as any
  expect(f.fields.agui).toEqual({ endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'X-Api-Key' })
  expect(f.aguiEditable).toBe(true)
  expect((parseAgent(`${AGUI_HEAD}agui:\n  endpoint: ${EP}\n---\nB\n`) as any).fields.agui).toEqual({
    endpoint: EP,
    authKey: null,
    authHeader: null
  })
  const none = parseAgent('---\nname: a\ndescription: d\n---\nB\n') as any
  expect([none.fields.agui, none.aguiEditable]).toEqual([null, true])
  expect([none.fields.acp, none.acpEditable]).toEqual([null, true])
})
test('agui: an agui that does not parse is null and not editable', () => {
  for (const v of [
    '"https://a.example.com/run"',
    '[a]',
    '{endpoint: ""}',
    '{endpoint: "ftp://a.example.com/"}',
    '{endpoint: "https://u:p@a.example.com/"}',
    `{endpoint: "${EP}", authHeader: X-Api-Key}`,
    `{endpoint: "${EP}", authKey: lower}`,
    `{endpoint: "${EP}", authKey: [ ]}`,
    `{endpoint: "${EP}", authKey: K_X, authHeader: Host}`
  ]) {
    const p = parseAgent(`${AGUI_HEAD}agui: ${v}\n---\nB\n`) as any
    expect([v, p.fields.agui, p.aguiEditable]).toEqual([v, null, false])
    expect(p.acpEditable).toBe(true)
  }
})
test('agui: writes a nested map with authKey and authHeader only when set, and null deletes the key', () => {
  const raw = '---\nname: a\ndescription: d\n---\nB\n'
  const p = parseAgent(raw) as any
  const out = serializeAgent(raw, { ...p.fields, agui: { endpoint: EP, authKey: null, authHeader: null } }, p.body)
  expect(out).toBe(`---\nname: a\ndescription: d\nagui:\n  endpoint: ${EP}\n---\nB\n`)
  const keyed = serializeAgent(raw, { ...p.fields, agui: { endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'X-Api-Key' } }, p.body)
  expect(keyed).toBe(
    `---\nname: a\ndescription: d\nagui:\n  endpoint: ${EP}\n  authKey: EXAMPLE_AGENT_KEY\n  authHeader: X-Api-Key\n---\nB\n`
  )
  const keyOnly = serializeAgent(raw, { ...p.fields, agui: { endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: null } }, p.body)
  expect(keyOnly).toBe(`---\nname: a\ndescription: d\nagui:\n  endpoint: ${EP}\n  authKey: EXAMPLE_AGENT_KEY\n---\nB\n`)
  const back = parseAgent(keyed) as any
  expect(back.fields.agui).toEqual({ endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'X-Api-Key' })
  expect(serializeAgent(keyed, { ...back.fields, agui: null }, back.body)).toBe(raw)
})
test('agui: a changed launch rewrites the block, and acp: stays untouched beside it', () => {
  const raw = `${ACP_HEAD}acp:\n  command: gemini # why\nagui:\n  endpoint: ${EP}\n---\nB\n`
  const p = parseAgent(raw) as any
  const out = serializeAgent(
    raw,
    { ...p.fields, agui: { endpoint: 'https://other.example.com/run', authKey: null, authHeader: null } },
    p.body
  )
  expect(out).toBe(raw.replace(EP, 'https://other.example.com/run'))
  expect(out).toContain('command: gemini # why')
})
test('agui: a body-only save keeps the frontmatter byte for byte, and another field keeps the launch and unknown keys', () => {
  const ok = `${AGUI_HEAD}agui:\n    endpoint:   "${EP}"   # why\n    authKey: EXAMPLE_AGENT_KEY\nunknown: x\n---\nB\n`
  const p = parseAgent(ok) as any
  expect(serializeAgent(ok, { ...p.fields }, 'C\n')).toBe(ok.replace('B\n', 'C\n'))
  // YAML respaces the block once another key changes, but nothing else moves.
  expect(serializeAgent(ok, { ...p.fields, color: 'red' }, p.body)).toBe(
    `${AGUI_HEAD}agui:\n  endpoint: "${EP}" # why\n  authKey: EXAMPLE_AGENT_KEY\nunknown: x\ncolor: red\n---\nB\n`
  )
})
test('agui: a block that does not parse is never rewritten or removed from a caller value', () => {
  const raw = `${AGUI_HEAD}agui: ${EP}\n---\nB\n`
  const p = parseAgent(raw) as any
  expect(serializeAgent(raw, { ...p.fields, color: 'red' }, p.body)).toContain(`agui: ${EP}`)
  const forced = serializeAgent(
    raw,
    { ...p.fields, agui: { endpoint: 'https://evil.example.com/run', authKey: null, authHeader: null } },
    p.body
  )
  expect(forced).toBe(raw)
  expect(serializeAgent(raw, { ...p.fields, agui: null }, p.body)).toBe(raw)
})
test('agui: a caller launch that is not one is never written', () => {
  const raw = '---\nname: a\ndescription: d\n---\nB\n'
  const p = parseAgent(raw) as any
  for (const endpoint of ['ftp://a.example.com/', 'https://u:p@a.example.com/', '']) {
    expect(serializeAgent(raw, { ...p.fields, agui: { endpoint, authKey: null, authHeader: null } }, p.body), endpoint).toBe(raw)
  }
})
test('agui: validateFields refuses a launch that is not one, and an unreadable key does not break the callers', () => {
  const ok = { ...(parseAgent('---\nname: a\ndescription: d\n---\nB\n') as any).fields }
  expect(validateFields({ ...ok, agui: { endpoint: EP, authKey: null, authHeader: null } })).toEqual([])
  expect(validateFields({ ...ok, agui: { endpoint: 'ftp://a.example.com/', authKey: null, authHeader: null } })).toEqual([
    AGUI_TEXT.endpointInvalid
  ])
  expect(validateFields({ ...ok, agui: { endpoint: EP, authKey: null, authHeader: 'X-Api-Key' } })).toEqual([
    AGUI_TEXT.authHeaderWithoutKey
  ])
  expect(validateFields({ ...ok, agui: { endpoint: EP, authKey: 'K_X', authHeader: 'Host' } })).toEqual([
    AGUI_TEXT.authHeaderInvalid('Host')
  ])
  // A remote agent needs an endpoint: none is refused, an unreadable one gets the Raw view hint (ACP's flag is not AG-UI's).
  expect(validateFields({ ...ok, provider: 'ag-ui', agui: { endpoint: EP, authKey: null, authHeader: null } })).toEqual([])
  expect(validateFields({ ...ok, provider: 'ag-ui' })).toEqual([AGUI_TEXT.endpointRequired])
  expect(validateFields({ ...ok, provider: 'ag-ui' }, true, false)).toEqual([AGUI_TEXT.launchUnreadable])
  expect(validateFields({ ...ok, provider: 'ag-ui' }, false, true)).toEqual([AGUI_TEXT.endpointRequired])
  const p = parseAgent(`${AGUI_HEAD}provider: ag-ui\nagui: ${EP}\n---\nB\n`) as any
  expect(validateFields(p.fields, p.acpEditable, p.aguiEditable)).toEqual([AGUI_TEXT.launchUnreadable])
  // Not a remote agent: an absent or unreadable agui: is inert.
  expect(validateFields(ok, true, false)).toEqual([])
  // The two optional flags default, so an existing caller is unchanged.
  expect(validateFields(ok)).toEqual([])
  expect(validateFields(ok, true)).toEqual([])
  expect(validateFields(ok, true, true)).toEqual([])
  expect(validateFields(ok, false, false)).toEqual([])
})
