import { describe, expect, it } from 'vitest'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import { toLoadout, type LoadoutContext } from '../../../src/core/extensions/sanitize'
import type { ProbeAnswers } from '../../../src/core/extensions/probe'

const ctx = (over: Partial<LoadoutContext> = {}): LoadoutContext => ({
  engine: 'claude',
  folder: '/work/app',
  agent: null,
  now: 1234,
  skillDirs: new Map(),
  ...over
})

const answers = (over: Partial<ProbeAnswers> = {}): ProbeAnswers => ({
  version: '2.1.322',
  mcp: null,
  skills: null,
  hooks: null,
  errors: {},
  ...over
})

// The shapes of claude 2.1.322's mcp_status, with synthetic values.
const mcpAnswer = () => ({
  mcpServers: [
    {
      name: 'plugin:playwright:playwright',
      status: 'connected',
      serverInfo: { name: 'Playwright', version: '1.0', instructions: 'leak-from-server-info' },
      config: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest', '--token', 's3cr3t-arg'], env: { SECRET_TOKEN: 's3cr3t' } },
      transport: 'stdio',
      scope: 'dynamic',
      source: 'plugin',
      tools: [{ name: 'browser_close', annotations: { destructive: true } }, { name: 'browser_click' }]
    },
    {
      name: 'claude.ai Gmail',
      status: 'connected',
      serverInfo: { name: 'Gmail', version: '1' },
      config: {
        type: 'claudeai-proxy',
        url: 'https://example.invalid/mcp',
        id: 'mcpsrv_x',
        headers: { Authorization: 'Bearer s3cr3t-header' }
      },
      transport: 'claudeai-proxy',
      sessionProxied: true,
      scope: 'claudeai',
      source: 'claudeai',
      tools: [{ name: 'search_threads' }]
    },
    {
      name: 'plugin:context7:context7',
      status: 'needs-auth',
      config: { type: 'http', url: 'https://example.invalid/mcp' },
      transport: 'http',
      scope: 'dynamic',
      source: 'plugin'
    },
    {
      name: 'stubsrv',
      status: 'connected',
      config: { type: 'stdio', command: 'node', args: ['/expanded/s3cr3t-expanded.js'] },
      scope: 'dynamic'
    },
    { name: 'my db', status: 'failed', config: { type: 'stdio', command: 'db' }, transport: 'stdio', scope: 'user', tools: [] },
    { name: 'localsrv', status: 'pending', config: { type: 'http', url: 'https://example.invalid/l' }, transport: 'http', scope: 'local' },
    {
      name: 'projsrv',
      status: 'weird-new-status',
      config: { type: 'sse', url: 'https://example.invalid/p' },
      transport: 'sse',
      scope: 'project'
    }
  ]
})

describe('toLoadout servers', () => {
  it('maps status, source, transport, plugin and tool names', () => {
    const l = toLoadout(answers({ mcp: mcpAnswer() }), ctx())
    expect(l.errors.servers).toBeUndefined()
    const by = Object.fromEntries(l.servers.map((s) => [s.name, s]))
    expect(by['plugin:playwright:playwright']).toEqual({
      name: 'plugin:playwright:playwright',
      status: 'connected',
      source: 'plugin',
      transport: 'stdio',
      plugin: 'playwright',
      tools: ['browser_close', 'browser_click'],
      scope: null,
      note: null,
      connector: null
    })
    // The URL is not a catalog one, so the name decides.
    expect(by['claude.ai Gmail']).toMatchObject({
      status: 'connected',
      source: 'claudeai',
      transport: 'claudeai-proxy',
      plugin: null,
      tools: ['search_threads'],
      scope: null,
      connector: 'gmail'
    })
    expect(by['plugin:context7:context7']).toMatchObject({ status: 'needs-auth', source: 'plugin', plugin: 'context7', tools: [] })
    // An agent's own server comes with no source and no transport; the service labels it later.
    expect(by.stubsrv).toMatchObject({ source: 'other', transport: null, scope: null, plugin: null, tools: [] })
    expect(by['my db']).toMatchObject({ status: 'failed', source: 'user', scope: 'user' })
    expect(by.localsrv).toMatchObject({ status: 'pending', source: 'local', scope: 'local' })
    expect(by.projsrv).toMatchObject({ status: 'unknown', source: 'project', scope: 'project', transport: 'sse' })
  })

  it('derives the connector id from the raw URL or the name, and never carries the URL', () => {
    const mcp = {
      mcpServers: [
        {
          name: 'claude.ai Notion',
          status: 'connected',
          config: { type: 'claudeai-proxy', url: 'https://mcp.notion.com/mcp' },
          scope: 'claudeai',
          source: 'claudeai'
        },
        { name: 'my linear', status: 'connected', config: { type: 'http', url: 'https://mcp.linear.app/mcp' }, scope: 'user' },
        { name: 'no url', status: 'connected', config: { type: 'stdio', command: 'x' }, scope: 'user' }
      ]
    }
    const l = toLoadout(answers({ mcp }), ctx())
    expect(l.servers.map((s) => s.connector)).toEqual(['notion', 'linear', null])
    for (const s of l.servers) expect(s).not.toHaveProperty('url')
    expect(JSON.stringify(l)).not.toContain('https://mcp.notion.com')
    expect(JSON.stringify(l)).not.toContain('mcp.linear.app')
  })

  it('never lets config, serverInfo or a secret into the loadout', () => {
    const text = JSON.stringify(toLoadout(answers({ mcp: mcpAnswer() }), ctx()))
    for (const leak of [
      's3cr3t',
      'SECRET_TOKEN',
      'leak-from-server-info',
      'Authorization',
      'example.invalid',
      'mcpsrv_x',
      'config',
      'serverInfo'
    ])
      expect(text).not.toContain(leak)
  })

  it('keeps odd names exactly as listed', () => {
    const l = toLoadout(
      answers({ mcp: { mcpServers: [{ name: 'claude.ai Google Drive', status: 'connected', scope: 'claudeai', source: 'claudeai' }] } }),
      ctx()
    )
    expect(l.servers[0].name).toBe('claude.ai Google Drive')
  })

  it('takes the plugin segment only from a plugin:<p>:<s> name', () => {
    const l = toLoadout(
      answers({ mcp: { mcpServers: [{ name: 'weird', status: 'connected', scope: 'dynamic', source: 'plugin' }] } }),
      ctx()
    )
    expect(l.servers[0]).toMatchObject({ source: 'plugin', plugin: null })
  })

  it('turns a non-array mcpServers into the servers error and no rows', () => {
    const l = toLoadout(answers({ mcp: { mcpServers: 'nope' }, skills: { skills: [] } }), ctx())
    expect(l.servers).toEqual([])
    expect(l.errors.servers).toBe(EXT_TEXT.unsupported('servers'))
    // The skills answer was fine, so only the servers section failed.
    expect(l.errors.skills).toBeUndefined()
  })

  it('treats a row without a name as an unexpected shape, never a throw', () => {
    for (const mcp of [null, 5, 'x', [], { mcpServers: [{ status: 'connected' }] }, { mcpServers: [null] }]) {
      const l = toLoadout(answers({ mcp }), ctx())
      expect(l.servers).toEqual([])
      expect(l.errors.servers).toBe(EXT_TEXT.unsupported('servers'))
    }
  })

  it('carries a probe error for a section and skips its answer', () => {
    const l = toLoadout(answers({ mcp: mcpAnswer(), errors: { mcp: EXT_TEXT.timeout } }), ctx())
    expect(l.servers).toEqual([])
    expect(l.errors.servers).toBe(EXT_TEXT.timeout)
  })
})

describe('toLoadout skills', () => {
  const skills = {
    skills: [
      { name: 'mine', display_name: 'mine', description: 'My own', source: 'user', tokens: 120, state: 'on', advertised: true },
      { name: 'proj', description: 'In the repo', source: 'project', tokens: 90, state: 'off', advertised: false },
      { name: 'caveman:caveman', description: 'Plugin one', source: 'plugin', tokens: 40, state: 'on' },
      { name: 'anthropic-skills:deep-research', description: 'Synced', source: 'claude.ai sync', tokens: 200, state: 'on' },
      { name: 'loop', description: 'Built in', source: 'bundled', state: 'on' },
      { name: 'other-thing', description: 'x', source: 'somewhere-new', tokens: 'many', state: 'on' }
    ]
  }

  it('maps source, plugin, state, tokens and editability', () => {
    const skillDirs = new Map<string, 'user' | 'project'>([
      ['mine', 'user'],
      ['proj', 'project'],
      ['loop', 'user'],
      ['caveman:caveman', 'user']
    ])
    const l = toLoadout(answers({ skills }), ctx({ skillDirs }))
    expect(l.errors.skills).toBeUndefined()
    const by = Object.fromEntries(l.skills.map((s) => [s.name, s]))
    expect(by.mine).toEqual({ name: 'mine', description: 'My own', source: 'user', plugin: null, tokens: 120, on: true, editable: true })
    expect(by.proj).toMatchObject({ source: 'project', on: false, editable: true })
    expect(by['caveman:caveman']).toMatchObject({ source: 'plugin', plugin: 'caveman', editable: false })
    expect(by['anthropic-skills:deep-research']).toMatchObject({ source: 'claudeai', plugin: null, editable: false })
    // A folder with the same name does not make a bundled skill editable.
    expect(by.loop).toMatchObject({ source: 'bundled', tokens: null, editable: false })
    expect(by['other-thing']).toMatchObject({ source: 'other', tokens: null })
  })

  it('is editable only under a name the skill RPCs take (lower case, digits and single hyphens, at most 100)', () => {
    const odd = [
      { name: 'My_Skill', description: '', source: 'user', state: 'on' },
      { name: 'double--hyphen', description: '', source: 'user', state: 'on' },
      { name: 'a'.repeat(101), description: '', source: 'project', state: 'on' },
      { name: 'fine-one', description: '', source: 'user', state: 'on' }
    ]
    const skillDirs = new Map<string, 'user' | 'project'>(odd.map((s) => [s.name, s.source as 'user' | 'project']))
    const l = toLoadout(answers({ skills: { skills: odd } }), ctx({ skillDirs }))
    expect(l.skills.map((s) => [s.name.slice(0, 20), s.editable])).toEqual([
      ['My_Skill', false],
      ['double--hyphen', false],
      ['a'.repeat(20), false],
      ['fine-one', true]
    ])
  })

  it('is not editable without a skill folder of that name', () => {
    const l = toLoadout(answers({ skills }), ctx())
    expect(l.skills.find((s) => s.name === 'mine')?.editable).toBe(false)
  })

  it('turns a bad skills answer into the skills error', () => {
    for (const s of [{ skills: {} }, { skills: [{ description: 'no name' }] }, 7]) {
      const l = toLoadout(answers({ skills: s }), ctx())
      expect(l.skills).toEqual([])
      expect(l.errors.skills).toBe(EXT_TEXT.unsupported('skills'))
    }
  })
})

describe('toLoadout hooks', () => {
  const row = (source: string, extra: Record<string, unknown> = {}) => ({
    event: 'PreToolUse',
    matcher: 'Bash',
    source,
    sourceLabel: 'x',
    type: 'command',
    displayText: 'd',
    commandText: 'sh check.sh',
    contentLabel: 'Command',
    ...extra
  })

  it('maps each source and the plugin name', () => {
    const hooks = {
      events: [],
      hooks: [
        row('userSettings', { timeout: 5 }),
        row('projectSettings'),
        row('localSettings'),
        row('pluginHook', { pluginName: 'caveman@caveman', event: 'SessionStart', matcher: '' }),
        row('flagSettings'),
        row('policySettings')
      ]
    }
    const l = toLoadout(answers({ hooks }), ctx({ agent: 'helper' }))
    expect(l.errors.hooks).toBeUndefined()
    expect(l.hooks.map((h) => h.source)).toEqual(['user', 'project', 'local', 'plugin', 'agent', 'other'])
    expect(l.hooks[0]).toEqual({
      event: 'PreToolUse',
      matcher: 'Bash',
      type: 'command',
      command: 'sh check.sh',
      timeout: 5,
      source: 'user',
      plugin: null,
      at: null,
      stamp: null
    })
    expect(l.hooks[3]).toMatchObject({ event: 'SessionStart', matcher: '', plugin: 'caveman@caveman', timeout: null })
    expect(toLoadout(answers({ hooks }), ctx({ agent: null })).hooks[4].source).toBe('other')
  })

  it('turns a bad hooks answer into the hooks error', () => {
    for (const h of [{ hooks: 'x' }, { hooks: [{ matcher: '' }] }, null]) {
      const l = toLoadout(answers({ hooks: h }), ctx())
      expect(l.hooks).toEqual([])
      expect(l.errors.hooks).toBe(EXT_TEXT.unsupported('hooks'))
    }
  })
})

describe('toLoadout header fields', () => {
  it('carries engine, folder, agent, version and the time', () => {
    const l = toLoadout(answers({ mcp: { mcpServers: [] }, skills: { skills: [] }, hooks: { hooks: [] } }), ctx({ agent: 'helper' }))
    expect(l).toEqual({
      engine: 'claude',
      version: '2.1.322',
      folder: '/work/app',
      agent: 'helper',
      servers: [],
      skills: [],
      hooks: [],
      errors: {},
      at: 1234
    })
  })
})

// Real shapes of codex 0.164.0 (mcpServerStatus/list, skills/list, hooks/list), synthetic values.
describe('toLoadout for codex', () => {
  const codexCtx = (over: Partial<LoadoutContext> = {}) => ctx({ engine: 'codex', ...over })
  const mcp = {
    data: [
      {
        name: 'codex_apps',
        runtimeStatus: null,
        pluginId: null,
        httpOrigin: 'https://example.invalid/apps',
        authStatus: 'bearerToken',
        serverInfo: { name: 'apps', version: '1' },
        tools: { 'gmail.send_email': { name: 'send_email' }, 'github.fetch': {} },
        toolsError: null,
        resources: [],
        resourceTemplates: []
      },
      {
        name: 'figma',
        runtimeStatus: 'authenticationRequired',
        pluginId: 'figma@openai-curated',
        httpOrigin: null,
        authStatus: 'notLoggedIn',
        tools: {},
        toolsError: null,
        resources: [],
        resourceTemplates: []
      },
      {
        name: 'db',
        runtimeStatus: 'failed',
        pluginId: null,
        httpOrigin: null,
        authStatus: 'unsupported',
        tools: {},
        toolsError: 'boom-details',
        resources: [],
        resourceTemplates: []
      },
      {
        name: 'slow',
        runtimeStatus: 'starting',
        pluginId: null,
        httpOrigin: null,
        authStatus: 'unknown',
        tools: {},
        toolsError: null,
        resources: [],
        resourceTemplates: []
      },
      {
        name: 'quiet',
        runtimeStatus: null,
        pluginId: null,
        httpOrigin: null,
        authStatus: 'notLoggedIn',
        tools: {},
        toolsError: null,
        resources: [],
        resourceTemplates: []
      }
    ],
    nextCursor: null
  }
  const skills = {
    data: [
      {
        cwd: '/work/app',
        skills: [
          {
            name: 'google-drive:google-docs',
            description: 'Docs',
            interface: { displayName: 'Google Docs' },
            path: '/x/SKILL.md',
            scope: 'user',
            enabled: true,
            pluginId: 'google-drive@openai-curated-remote'
          },
          {
            name: 'mine',
            description: 'Mine',
            interface: null,
            path: '/home/u/.codex/skills/mine/SKILL.md',
            scope: 'user',
            enabled: false,
            pluginId: null
          },
          { name: 'repo-skill', description: 'Repo', path: '/p', scope: 'repo', enabled: true, pluginId: null },
          { name: 'sys', description: 'System', path: '/s', scope: 'system', enabled: true, pluginId: null }
        ],
        errors: []
      }
    ]
  }
  const hooks = {
    data: [
      {
        cwd: '/work/app',
        hooks: [
          {
            key: 'k1',
            eventName: 'preToolUse',
            handlerType: 'command',
            command: 'sh /h.sh',
            async: false,
            matcher: null,
            timeoutSec: 5,
            source: 'user',
            pluginId: null,
            enabled: true,
            currentHash: 'sha256:abc',
            trustStatus: 'trusted',
            sourcePath: '/h'
          },
          {
            key: 'k2',
            eventName: 'sessionStart',
            handlerType: 'mcpTool',
            server: 'srv',
            tool: 'tl',
            matcher: 'x',
            timeoutSec: 30,
            source: 'plugin',
            pluginId: 'p@m',
            enabled: true,
            currentHash: 'sha256:def',
            trustStatus: 'managed',
            sourcePath: '/p'
          },
          {
            key: 'k3',
            eventName: 'stop',
            handlerType: 'prompt',
            source: 'system',
            pluginId: null,
            enabled: true,
            currentHash: 'h',
            trustStatus: 'managed',
            sourcePath: '/s',
            timeoutSec: 1
          }
        ],
        warnings: [],
        errors: []
      }
    ]
  }

  it('maps servers, reading the status from runtimeStatus, then the tool listing', () => {
    const l = toLoadout(answers({ version: '0.164.0', mcp }), codexCtx())
    expect(l.errors.servers).toBeUndefined()
    const by = Object.fromEntries(l.servers.map((s) => [s.name, s]))
    expect(by.codex_apps).toEqual({
      name: 'codex_apps',
      status: 'connected',
      source: 'other',
      transport: 'http',
      plugin: null,
      tools: ['gmail.send_email', 'github.fetch'],
      scope: null,
      note: null,
      connector: null
    })
    expect(by.figma).toMatchObject({ status: 'needs-auth', source: 'plugin', plugin: 'figma@openai-curated', transport: null })
    expect(by.db.status).toBe('failed')
    expect(by.slow.status).toBe('pending')
    expect(by.quiet.status).toBe('needs-auth')
    expect(JSON.stringify(l)).not.toContain('boom-details')
    expect(JSON.stringify(l)).not.toContain('example.invalid')
  })

  it('maps skills from every folder entry', () => {
    const l = toLoadout(answers({ skills }), codexCtx({ skillDirs: new Map([['mine', 'user']]) }))
    const by = Object.fromEntries(l.skills.map((s) => [s.name, s]))
    expect(by['google-drive:google-docs']).toEqual({
      name: 'google-drive:google-docs',
      description: 'Docs',
      source: 'plugin',
      plugin: 'google-drive@openai-curated-remote',
      tokens: null,
      on: true,
      editable: false
    })
    expect(by.mine).toMatchObject({ source: 'user', on: false, editable: true })
    expect(by['repo-skill'].source).toBe('project')
    expect(by.sys.source).toBe('bundled')
  })

  it('maps hooks, naming the event the way Claude does', () => {
    const l = toLoadout(answers({ hooks }), codexCtx())
    expect(l.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: '',
        type: 'command',
        command: 'sh /h.sh',
        timeout: 5,
        source: 'user',
        plugin: null,
        at: null,
        stamp: null
      },
      {
        event: 'SessionStart',
        matcher: 'x',
        type: 'mcpTool',
        command: 'srv.tl',
        timeout: 30,
        source: 'plugin',
        plugin: 'p@m',
        at: null,
        stamp: null
      },
      { event: 'Stop', matcher: '', type: 'prompt', command: '', timeout: 1, source: 'other', plugin: null, at: null, stamp: null }
    ])
  })

  it('turns a bad codex answer into the section error', () => {
    const l = toLoadout(answers({ mcp: { data: 'x' }, skills: { data: [{ skills: 4 }] }, hooks: [] }), codexCtx())
    // In Codex's words: the Claude Code sentence would name the wrong program.
    expect(l.errors).toEqual({
      servers: EXT_TEXT.codexUnsupported('servers'),
      skills: EXT_TEXT.codexUnsupported('skills'),
      hooks: EXT_TEXT.codexUnsupported('hooks')
    })
  })
})

describe('toLoadout for a remote (AG-UI) agent', () => {
  it('reads no answer: every section is unsupported, with the remote sentence', () => {
    const l = toLoadout(answers({ mcp: mcpAnswer() }), ctx({ engine: 'ag-ui' }))
    expect(l.servers).toEqual([])
    expect(l.errors).toMatchObject({ servers: EXT_TEXT.aguiUnsupported, skills: EXT_TEXT.aguiUnsupported, hooks: EXT_TEXT.aguiUnsupported })
  })
})

describe('toLoadout for ACP', () => {
  it('reads no answer of an ACP agent: every section is unsupported, with the ACP sentence', () => {
    const l = toLoadout(answers({ mcp: mcpAnswer() }), ctx({ engine: 'acp' }))
    expect(l.servers).toEqual([])
    expect(l.errors).toMatchObject({ servers: EXT_TEXT.acpUnsupported, skills: EXT_TEXT.acpUnsupported, hooks: EXT_TEXT.acpUnsupported })
  })
})
