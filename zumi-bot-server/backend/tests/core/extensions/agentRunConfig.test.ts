import { describe, expect, it } from 'vitest'
import { askRules, CONNECTOR_IDS, connectorPrefixes, type ConnectorId } from '@zumibot/shared/connectors'
import { NO_EXTENSIONS, type AgentExtensions, type AgentOwnServer } from '@zumibot/shared/extensions'
import { extensionsOf, parseAgent } from '@zumibot/shared/frontmatter'
import type { VaultItem } from '@zumibot/shared/vault'
import { buildArgs } from '../../../src/core/chat/claudeRunner'
import { pauseSettings } from '../../../src/core/chat/pauseSettings'
import { buildAgentRunConfig, CONNECTORS_ALL_OFF, NO_RUN_CONFIG } from '../../../src/core/extensions/agentRunConfig'

const ext = (over: Partial<AgentExtensions> = {}): AgentExtensions => ({
  serversOff: [],
  skillsOff: [],
  plugins: {},
  servers: [],
  serversEditable: true,
  hooks: {},
  hooksEditable: true,
  ...over
})

const key = (env: string, value: string, name = env): VaultItem => ({
  id: `id-${name}`,
  updatedAt: 1,
  name,
  agents: ['a'],
  kind: 'apiKey',
  env,
  value,
  description: ''
})

const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]) as Record<string, unknown>
const mcpOf = (args: string[]) =>
  JSON.parse(args[args.indexOf('--mcp-config') + 1]) as { mcpServers: Record<string, Record<string, unknown>> }

describe('buildAgentRunConfig', () => {
  it('gives nothing for an agent with no extension keys', () => {
    const r = buildAgentRunConfig(NO_EXTENSIONS, [])
    expect(r).toEqual({ disallowedTools: [], extraArgs: [], env: {}, dropped: [], connectorPrefixes: {}, connectorsOff: [] })
    // A fresh object each time: a caller may push onto it.
    expect(r).not.toBe(NO_RUN_CONFIG)
    expect(buildAgentRunConfig(NO_EXTENSIONS, 'locked')).toEqual(NO_RUN_CONFIG)
  })

  it('NO_RUN_CONFIG is frozen all the way down', () => {
    expect(Object.isFrozen(NO_RUN_CONFIG)).toBe(true)
    expect(Object.isFrozen(NO_RUN_CONFIG.disallowedTools)).toBe(true)
    expect(Object.isFrozen(NO_RUN_CONFIG.extraArgs)).toBe(true)
    expect(Object.isFrozen(NO_RUN_CONFIG.env)).toBe(true)
    expect(Object.isFrozen(NO_RUN_CONFIG.dropped)).toBe(true)
  })

  describe('serversOff', () => {
    it('round-trips odd server names', () => {
      const off = ['claude.ai Google Drive', 'plugin:chrome-devtools-mcp:chrome-devtools']
      const r = buildAgentRunConfig(ext({ serversOff: off }), [])
      expect(settingsOf(r.extraArgs)).toEqual({ deniedMcpServers: [{ serverName: off[0] }, { serverName: off[1] }] })
      expect(r.disallowedTools).toEqual(['mcp__claude_ai_Google_Drive', 'mcp__plugin_chrome-devtools-mcp_chrome-devtools'])
      expect(r.extraArgs).toHaveLength(2)
    })

    it('omits both the deny list and the belt with serversOff: false', () => {
      const r = buildAgentRunConfig(ext({ serversOff: ['claude.ai Gmail'], plugins: { 'a@m': true } }), [], { serversOff: false })
      expect(r.disallowedTools).toEqual([])
      expect(settingsOf(r.extraArgs)).toEqual({ enabledPlugins: { 'a@m': true } })
    })

    it('adds no --settings at all when serversOff: false leaves nothing to say', () => {
      const r = buildAgentRunConfig(ext({ serversOff: ['claude.ai Gmail'] }), [], { serversOff: false })
      expect(r).toEqual({ disallowedTools: [], extraArgs: [], env: {}, dropped: [], connectorPrefixes: {}, connectorsOff: [] })
    })

    it("connectors not on are denied after the agent's own off list", () => {
      const r = buildAgentRunConfig(ext({ serversOff: ['x'] }), [], { connectorsOff: ['gmail'] })
      expect(settingsOf(r.extraArgs).deniedMcpServers).toEqual([
        { serverName: 'x' },
        { serverUrl: 'https://gmailmcp.googleapis.com/*' },
        { serverUrl: 'https://gmail.mcp.claude.com/*' },
        { serverName: 'claude.ai Gmail' }
      ])
      expect(r.disallowedTools).toEqual(['mcp__x', 'mcp__claude_ai_Gmail'])
    })

    describe('ask rules and the prefix map', () => {
      const gmail2 = { name: 'claude.ai Gmail (2)', connector: 'gmail' as ConnectorId }
      const linear = { name: 'linear', def: { url: 'https://mcp.linear.app/mcp' } }
      const make = (over: { on?: ConnectorId[]; opts?: object; e?: Partial<AgentExtensions> } = {}) => {
        const off = CONNECTOR_IDS.filter((id) => !(over.on ?? ['gmail']).includes(id))
        return buildAgentRunConfig(ext({ servers: [linear], ...over.e }), [], {
          connectorsOff: off,
          connectorServers: [gmail2],
          ...over.opts
        })
      }
      const askOf = (r: { extraArgs: string[] }) =>
        !r.extraArgs.includes('--settings') ? undefined : (settingsOf(r.extraArgs).permissions as { ask: string[] } | undefined)?.ask

      it('asks for the connectors that are on, learned servers and own ones included', () => {
        const r = make()
        const ask = askOf(r) as string[]
        expect(ask).toEqual(askRules(['gmail'], r.connectorPrefixes))
        expect(ask).toContain('mcp__claude_ai_Gmail__*')
        expect(ask).toContain('mcp__claude_ai_Gmail__2___*')
        expect(ask.some((rule) => /Slack|linear/i.test(rule))).toBe(false)
        expect(r.connectorPrefixes['mcp__linear']).toBe('linear')
        expect(r.connectorPrefixes['mcp__claude_ai_Gmail__2_']).toBe('gmail')
      })

      it('adds the own server of a connector that is on', () => {
        const r = make({ on: ['gmail', 'linear'] })
        expect(askOf(r)).toContain('mcp__linear__*')
      })

      it('does not take an own stdio server named like a catalog connector for it', () => {
        const r = make({ e: { servers: [{ name: 'claude.ai Gmail', def: { command: 'node' } }] } })
        expect(r.connectorPrefixes['mcp__claude_ai_Gmail']).toBeUndefined()
        expect(askOf(r)).not.toContain('mcp__claude_ai_Gmail__*')
      })

      it('drops a learned name the agent redefines at a non-catalog URL', () => {
        const r = make({
          opts: { connectorServers: [{ name: 'foo', connector: 'gmail' }] },
          e: { servers: [{ name: 'foo', def: { url: 'https://example.com/mcp' } }] }
        })
        expect(r.connectorPrefixes['mcp__foo']).toBeUndefined()
        expect(askOf(r)).not.toContain('mcp__foo__*')
      })

      it('keeps a learned name an own server redefines at the same connector URL', () => {
        const r = make({
          opts: { connectorServers: [{ name: 'foo', connector: 'linear' }] },
          on: ['linear'],
          e: { servers: [{ name: 'foo', def: { url: 'https://mcp.linear.app/mcp' } }] }
        })
        expect(r.connectorPrefixes['mcp__foo']).toBe('linear')
        expect(askOf(r)).toContain('mcp__foo__*')
      })

      it('adds nothing for an own server at a catalog URL that is dropped', () => {
        const dropped = { name: 'lin', def: { url: 'https://mcp.linear.app/mcp', headers: { A: '${vault:MISSING}' } } }
        const r = make({ on: ['gmail', 'linear'], e: { servers: [dropped] } })
        expect(r.dropped).toHaveLength(1)
        expect(r.connectorPrefixes['mcp__lin']).toBeUndefined()
        expect(askOf(r)).not.toContain('mcp__lin__*')
      })

      it('an own server at a non-catalog URL with a free name changes nothing', () => {
        const base = make()
        const r = make({ e: { servers: [linear, { name: 'mine', def: { url: 'https://example.com/mcp' } }] } })
        expect(r.connectorPrefixes).toEqual(base.connectorPrefixes)
        expect(askOf(r)).toEqual(askOf(base))
      })

      it('leaves an own server out of the map when its list is not applied', () => {
        const r = make({ e: { serversEditable: false } })
        expect(r.connectorPrefixes['mcp__linear']).toBeUndefined()
      })

      it('has no permissions key with every connector off', () => {
        const r = buildAgentRunConfig(ext(), [], { connectorsOff: CONNECTOR_IDS })
        expect(askOf(r)).toBeUndefined()
        expect(r.connectorPrefixes).toEqual(connectorPrefixes([]))
      })

      it('has no ask rules for the probe (serversOff: false), whose prefix map is still built', () => {
        const r = make({ opts: { serversOff: false } })
        expect(r.extraArgs).toEqual(expect.not.arrayContaining(['--settings']))
        expect(r.connectorPrefixes['mcp__linear']).toBe('linear')
      })

      it('has an empty prefix map without connectorsOff, and no ask rules', () => {
        const r = buildAgentRunConfig(ext({ servers: [linear] }), [], { connectorServers: [gmail2] })
        expect(r.connectorPrefixes).toEqual({})
        expect(askOf(r)).toBeUndefined()
      })

      it('carries the denied ids: a copy of connectorsOff, none without one, all of them in the all-off fallback', () => {
        const off: ConnectorId[] = ['gmail', 'slack']
        const r = buildAgentRunConfig(NO_EXTENSIONS, [], { connectorsOff: off })
        expect(r.connectorsOff).toEqual(['gmail', 'slack'])
        expect(r.connectorsOff).not.toBe(off)
        expect(buildAgentRunConfig(NO_EXTENSIONS, [], {}).connectorsOff).toEqual([])
        expect(buildAgentRunConfig(ext({ servers: [linear] }), [], { connectorServers: [gmail2] }).connectorsOff).toEqual([])
        expect(CONNECTORS_ALL_OFF.connectorsOff).toEqual([...CONNECTOR_IDS])
        expect(Object.isFrozen(CONNECTORS_ALL_OFF.connectorsOff)).toBe(true)
        expect(NO_RUN_CONFIG.connectorsOff).toEqual([])
        expect(Object.isFrozen(NO_RUN_CONFIG.connectorsOff)).toBe(true)
      })

      it('the fixed fallbacks carry a frozen map', () => {
        expect(Object.isFrozen(CONNECTORS_ALL_OFF.connectorPrefixes)).toBe(true)
        expect(CONNECTORS_ALL_OFF.connectorPrefixes).toEqual(connectorPrefixes([]))
        expect(askOf(CONNECTORS_ALL_OFF)).toBeUndefined()
        expect(NO_RUN_CONFIG.connectorPrefixes).toEqual({})
        expect(Object.isFrozen(NO_RUN_CONFIG.connectorPrefixes)).toBe(true)
      })
    })

    it('the probe gets no connector deny', () => {
      const r = buildAgentRunConfig(ext({ serversOff: ['x'] }), [], { serversOff: false, connectorsOff: ['gmail'] })
      expect(r.extraArgs).toEqual([])
      expect(r.disallowedTools).toEqual([])
    })

    it("no connectorsOff is today's config", () => {
      const e = ext({ serversOff: ['x', 'claude.ai Gmail'], plugins: { 'a@m': true } })
      // Every connector on adds the ask rules (and the prefix map) and nothing else.
      const on = buildAgentRunConfig(e, [], { connectorsOff: [] })
      const none = buildAgentRunConfig(e, [])
      expect(on.disallowedTools).toEqual(none.disallowedTools)
      const { permissions, ...rest } = settingsOf(on.extraArgs)
      expect(rest).toEqual(settingsOf(none.extraArgs))
      expect(permissions).toEqual({ ask: askRules(CONNECTOR_IDS, connectorPrefixes([])) })
    })

    it('a connector off alone makes the deny list and the belt', () => {
      const r = buildAgentRunConfig(ext(), [], { connectorsOff: ['gmail'] })
      expect(settingsOf(r.extraArgs).deniedMcpServers).toHaveLength(3)
      expect(r.disallowedTools).toEqual(['mcp__claude_ai_Gmail'])
    })

    it('a name denied twice (own list and connector) is one belt entry', () => {
      const r = buildAgentRunConfig(ext({ serversOff: ['claude.ai Gmail'] }), [], { connectorsOff: ['gmail'] })
      expect(r.disallowedTools).toEqual(['mcp__claude_ai_Gmail'])
    })

    it('ignores a name reserved for ZumiBot bridges: no deny and no belt for them, the card says always on', () => {
      const r = buildAgentRunConfig(ext({ serversOff: ['zumibot_browser', 'zumibot.todos', 'gh'] }), [])
      expect(settingsOf(r.extraArgs)).toEqual({ deniedMcpServers: [{ serverName: 'gh' }] })
      expect(r.disallowedTools).toEqual(['mcp__gh'])
      expect(buildAgentRunConfig(ext({ serversOff: ['zumibot_vault'] }), [])).toEqual({
        disallowedTools: [],
        extraArgs: [],
        env: {},
        dropped: [],
        connectorPrefixes: {},
        connectorsOff: []
      })
    })

    it('lists a name once even when the file repeats it', () => {
      const r = buildAgentRunConfig(ext({ serversOff: ['x y', 'x y', 'x.y'] }), [])
      expect(settingsOf(r.extraArgs).deniedMcpServers).toEqual([{ serverName: 'x y' }, { serverName: 'x.y' }])
      // `x y` and `x.y` normalize to one prefix: one belt rule.
      expect(r.disallowedTools).toEqual(['mcp__x_y'])
    })
  })

  describe('plugins and skills', () => {
    it('maps plugins to enabledPlugins and skillsOff to "off" overrides', () => {
      const r = buildAgentRunConfig(
        ext({ plugins: { 'caveman@caveman': false, 'fd@official': true }, skillsOff: ['apple-design', 'loop'] }),
        []
      )
      expect(settingsOf(r.extraArgs)).toEqual({
        enabledPlugins: { 'caveman@caveman': false, 'fd@official': true },
        skillOverrides: { 'apple-design': 'off', loop: 'off' }
      })
      expect(r.disallowedTools).toEqual([])
    })

    it('omits skillOverrides with skillsOff: false, whatever serversOff says', () => {
      const e = ext({ serversOff: ['claude.ai Gmail'], skillsOff: ['apple-design'], plugins: { 'a@m': true } })
      const noSkills = buildAgentRunConfig(e, [], { skillsOff: false })
      // serversOff left at its default still applies, the deny list and its belt included.
      expect(settingsOf(noSkills.extraArgs)).toEqual({
        deniedMcpServers: [{ serverName: 'claude.ai Gmail' }],
        enabledPlugins: { 'a@m': true }
      })
      expect(noSkills.disallowedTools).toEqual(['mcp__claude_ai_Gmail'])
      // And the reverse: serversOff: false leaves the skill overrides alone.
      const noServers = buildAgentRunConfig(e, [], { serversOff: false })
      expect(settingsOf(noServers.extraArgs)).toEqual({ enabledPlugins: { 'a@m': true }, skillOverrides: { 'apple-design': 'off' } })
      expect(noServers.disallowedTools).toEqual([])
    })

    it('with both off (the probe) keeps only the plugins and the hooks', () => {
      const hooks = { Stop: [{ hooks: [{ type: 'command' as const, command: 'c' }] }] }
      const r = buildAgentRunConfig(ext({ serversOff: ['s'], skillsOff: ['k'], plugins: { 'a@m': false }, hooks }), [], {
        serversOff: false,
        skillsOff: false
      })
      expect(settingsOf(r.extraArgs)).toEqual({ enabledPlugins: { 'a@m': false }, hooks })
      expect(r.disallowedTools).toEqual([])
      expect(buildAgentRunConfig(ext({ serversOff: ['s'], skillsOff: ['k'] }), [], { serversOff: false, skillsOff: false })).toEqual(
        NO_RUN_CONFIG
      )
    })

    it('keeps the settings keys in the documented order and holds nothing else', () => {
      const r = buildAgentRunConfig(
        ext({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo' }] }] },
          skillsOff: ['s'],
          plugins: { 'p@m': false },
          serversOff: ['srv']
        }),
        []
      )
      expect(Object.keys(settingsOf(r.extraArgs))).toEqual(['deniedMcpServers', 'enabledPlugins', 'skillOverrides', 'hooks'])
    })
  })

  describe('hooks', () => {
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: './check.sh', timeout: 5 }] }] }

    it('passes an editable hooks block through whole', () => {
      expect(settingsOf(buildAgentRunConfig(ext({ hooks }), []).extraArgs)).toEqual({ hooks })
    })

    it('skips a non-editable hooks block', () => {
      // The parser keeps a prompt hook in `config` for display; the run must not apply it.
      const odd = { PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'be careful' }] }] }
      const r = buildAgentRunConfig(ext({ hooks: odd, hooksEditable: false, plugins: { 'a@m': true } }), [])
      expect(settingsOf(r.extraArgs)).toEqual({ enabledPlugins: { 'a@m': true } })
      expect(JSON.stringify(r)).not.toContain('be careful')
      expect(buildAgentRunConfig(ext({ hooks: odd, hooksEditable: false }), [])).toEqual(NO_RUN_CONFIG)
    })

    it('leaves out events with no groups', () => {
      expect(buildAgentRunConfig(ext({ hooks: { Stop: [] } }), [])).toEqual(NO_RUN_CONFIG)
      expect(settingsOf(buildAgentRunConfig(ext({ hooks: { Stop: [], ...hooks } }), []).extraArgs)).toEqual({ hooks })
    })

    it('writes the hooks as given and leaves the input alone', () => {
      const input = ext({ hooks })
      const r = buildAgentRunConfig(input, [])
      expect(r.extraArgs[1]).toBe(JSON.stringify({ hooks }))
      expect(input.hooks).toEqual(hooks)
    })

    // Ruling 23, the belt: claude 2.1.322 drops the run's WHOLE merged --settings (pause hook, vault guard, ask rules, side guard) for
    // one PreToolUse hook timed 0 or below (another event's alone), so no such hook leaves here even when a caller marks the block editable.
    it('drops every hook whose timeout is not above 0, and a group or event it leaves empty', () => {
      const h = (command: string, timeout?: number) => ({
        type: 'command' as const,
        command,
        ...(timeout !== undefined ? { timeout } : {})
      })
      const input = ext({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [h('zero', 0), h('ok', 1.5), h('neg', -5), h('none'), h('nan', NaN), h('inf', Infinity)] },
            { matcher: 'x', hooks: [h('z', 0)] }
          ],
          Stop: [{ hooks: [h('s', -0)] }]
        }
      })
      const before = JSON.stringify(input)
      const r = buildAgentRunConfig(input, [])
      expect(settingsOf(r.extraArgs)).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [h('ok', 1.5), h('none')] }] } })
      expect(JSON.stringify(input)).toBe(before)
      expect(buildAgentRunConfig(ext({ hooks: { Stop: [{ hooks: [h('s', 0)] }] } }), [])).toEqual({
        disallowedTools: [],
        extraArgs: [],
        env: {},
        dropped: [],
        connectorPrefixes: {},
        connectorsOff: []
      })
    })

    it('keeps a timeout-0 hook of an agent file out of the merged --settings, so the guard and the ask rule stay', () => {
      const raw =
        '---\nname: a\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./log.sh\n          timeout: 0\n---\nbody\n'
      const parsed = parseAgent(raw)
      if (!parsed.ok) throw new Error('the agent file did not parse')
      const own = buildAgentRunConfig(extensionsOf(parsed.fields), [])
      const guard = JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo GUARD' }] }] },
        permissions: { ask: ['mcp__zumibot_desktop__desktop_click'] }
      })
      const args = buildArgs({
        agentName: 'a',
        resumeSessionId: null,
        permissionMode: 'auto',
        extraArgs: [...own.extraArgs, '--settings', guard]
      })
      expect(args.filter((a) => a === '--settings')).toHaveLength(1)
      const merged = JSON.parse(args[args.indexOf('--settings') + 1]) as Record<string, unknown>
      expect(merged).toEqual(JSON.parse(guard))
      expect(JSON.stringify(merged)).not.toContain('./log.sh')
    })
  })

  describe('own servers', () => {
    const gh = {
      name: 'gh',
      def: { type: 'http' as const, url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${vault:GH}' } }
    }

    it('rewrites a Vault reference and hands the value over in env only', () => {
      const r = buildAgentRunConfig(ext({ servers: [gh] }), [key('GH', 'tok')])
      expect(r.extraArgs[0]).toBe('--mcp-config')
      expect(mcpOf(r.extraArgs).mcpServers.gh).toEqual({
        type: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer ${ZUMIBOT_MCP_VAULT_0}' }
      })
      expect(r.env).toEqual({ ZUMIBOT_MCP_VAULT_0: 'tok' })
      expect(JSON.stringify(r.extraArgs)).not.toContain('tok')
      expect(JSON.stringify(r.disallowedTools)).not.toContain('tok')
      expect(r.dropped).toEqual([])
    })

    it('never puts a value anywhere but env', () => {
      const value = 'sk-very-secret-9f3a'
      const r = buildAgentRunConfig(
        ext({ servers: [{ name: 'db', def: { command: 'node', env: { A: '${vault:K}', B: 'plain' } } }], plugins: { 'a@m': true } }),
        [key('K', value)]
      )
      const { env, ...rest } = r
      expect(JSON.stringify(rest)).not.toContain(value)
      expect(Object.values(env)).toEqual([value])
    })

    it('rewrites env values and keeps text around a reference and several in one value', () => {
      const def = { command: 'node', args: ['${vault:A}'], env: { URL: 'https://u:${vault:A}@h/${vault:B}', PLAIN: 'x' } }
      const r = buildAgentRunConfig(ext({ servers: [{ name: 'db', def }] }), [key('A', 'aa'), key('B', 'bb')])
      expect(mcpOf(r.extraArgs).mcpServers.db).toEqual({
        command: 'node',
        // Only env and header values are searched: args are the CLI's, passed as written.
        args: ['${vault:A}'],
        env: { URL: 'https://u:${ZUMIBOT_MCP_VAULT_0}@h/${ZUMIBOT_MCP_VAULT_1}', PLAIN: 'x' }
      })
      expect(r.env).toEqual({ ZUMIBOT_MCP_VAULT_0: 'aa', ZUMIBOT_MCP_VAULT_1: 'bb' })
    })

    it('keeps each definition key order', () => {
      const def = { url: 'https://h/mcp', type: 'sse' as const, headers: { A: 'b' } }
      const r = buildAgentRunConfig(ext({ servers: [{ name: 's', def }] }), [])
      expect(Object.keys(mcpOf(r.extraArgs).mcpServers.s)).toEqual(['url', 'type', 'headers'])
    })

    it('numbers references over the servers that stay, one number per env name', () => {
      const servers: AgentOwnServer[] = [
        { name: 'one', def: { command: 'a', env: { T: '${vault:GH}' } } },
        // Dropped for its missing key: it must not use up a number.
        { name: 'broken', def: { command: 'b', env: { T: '${vault:NOPE}', U: '${vault:OTHER}' } } },
        { name: 'two', def: { command: 'c', env: { T: '${vault:NPM}', U: '${vault:GH}' } } }
      ]
      const r = buildAgentRunConfig(ext({ servers }), [key('GH', 'g'), key('NPM', 'n'), key('OTHER', 'o')])
      const m = mcpOf(r.extraArgs).mcpServers
      expect(m.one.env).toEqual({ T: '${ZUMIBOT_MCP_VAULT_0}' })
      expect(m.two.env).toEqual({ T: '${ZUMIBOT_MCP_VAULT_1}', U: '${ZUMIBOT_MCP_VAULT_0}' })
      expect(r.env).toEqual({ ZUMIBOT_MCP_VAULT_0: 'g', ZUMIBOT_MCP_VAULT_1: 'n' })
      expect(Object.keys(m)).toEqual(['one', 'two'])
    })

    it('leaves a server with no reference as written, whatever the Vault state', () => {
      const servers = [{ name: 'plain', def: { command: 'node', args: ['s.js'], env: { A: '1' } } }]
      for (const keys of [[], 'locked' as const]) {
        const r = buildAgentRunConfig(ext({ servers }), keys)
        expect(mcpOf(r.extraArgs).mcpServers.plain).toEqual({ command: 'node', args: ['s.js'], env: { A: '1' } })
        expect(r.env).toEqual({})
        expect(r.dropped).toEqual([])
      }
    })

    it('drops only the server whose key is not granted, naming the first one missing', () => {
      const servers: AgentOwnServer[] = [
        { name: 'good', def: { command: 'a', env: { T: '${vault:GH}' } } },
        { name: 'bad', def: { command: 'b', env: { A: '${vault:GH}', B: '${vault:GONE}', C: '${vault:ALSO_GONE}' } } },
        { name: 'plain', def: { command: 'c' } }
      ]
      const r = buildAgentRunConfig(ext({ servers }), [key('GH', 'g')])
      expect(r.dropped).toEqual([{ server: 'bad', env: 'GONE', reason: 'vault-missing' }])
      expect(Object.keys(mcpOf(r.extraArgs).mcpServers)).toEqual(['good', 'plain'])
      expect(r.env).toEqual({ ZUMIBOT_MCP_VAULT_0: 'g' })
    })

    it('treats a key with no value, and an item of another kind, as not granted', () => {
      const login: VaultItem = {
        id: 'l',
        updatedAt: 1,
        name: 'GH',
        agents: ['a'],
        kind: 'login',
        sites: [],
        username: 'u',
        password: 'pw',
        totp: null
      }
      for (const keys of [[key('GH', '')], [login]]) {
        const r = buildAgentRunConfig(ext({ servers: [gh] }), keys)
        expect(r.dropped).toEqual([{ server: 'gh', env: 'GH', reason: 'vault-missing' }])
        expect(r.extraArgs).toEqual([])
      }
    })

    it('matches the env name exactly, case included', () => {
      expect(buildAgentRunConfig(ext({ servers: [gh] }), [key('gh', 'x')]).dropped).toHaveLength(1)
    })

    it('takes the last of two granted keys with one env name, as the env does', () => {
      const r = buildAgentRunConfig(ext({ servers: [gh] }), [key('GH', 'first', 'a'), key('GH', 'last', 'b')])
      expect(r.env).toEqual({ ZUMIBOT_MCP_VAULT_0: 'last' })
    })

    it('drops every server with a reference when the Vault is locked, and says so', () => {
      const servers = [
        gh,
        { name: 'plain', def: { command: 'node' } },
        { name: 'two', def: { command: 'x', env: { A: '${vault:Z}', B: '${vault:Y}' } } }
      ]
      const r = buildAgentRunConfig(ext({ servers }), 'locked')
      expect(r.dropped).toEqual([
        { server: 'gh', env: 'GH', reason: 'vault-locked' },
        { server: 'two', env: 'Z', reason: 'vault-locked' }
      ])
      expect(Object.keys(mcpOf(r.extraArgs).mcpServers)).toEqual(['plain'])
      expect(r.env).toEqual({})
    })

    it('adds no --mcp-config when every inline server was dropped', () => {
      const r = buildAgentRunConfig(ext({ servers: [gh] }), 'locked')
      expect(r.extraArgs).toEqual([])
      expect(r.dropped).toHaveLength(1)
    })

    it('drops a server named for ZumiBot as reserved, even with a plain definition', () => {
      const servers = [
        { name: 'zumibot_x', def: { command: 'node' } },
        // The CLI turns `.` into `_`, so this one would share `mcp__zumibot_browser__` with the bridge.
        { name: 'zumibot.browser', def: { command: 'node' } },
        { name: 'mine', def: { command: 'node' } }
      ]
      const r = buildAgentRunConfig(ext({ servers }), [])
      expect(r.dropped).toEqual([
        { server: 'zumibot_x', env: null, reason: 'reserved-name' },
        { server: 'zumibot.browser', env: null, reason: 'reserved-name' }
      ])
      expect(Object.keys(mcpOf(r.extraArgs).mcpServers)).toEqual(['mine'])
    })

    it('leaves a reserved server out before the Vault is asked, so its key is not handed over', () => {
      const r = buildAgentRunConfig(ext({ servers: [{ name: 'zumibot_x', def: { command: 'n', env: { A: '${vault:GH}' } } }] }), [
        key('GH', 'tok')
      ])
      expect(r.dropped).toEqual([{ server: 'zumibot_x', env: null, reason: 'reserved-name' }])
      expect(r.env).toEqual({})
    })

    it('adds nothing for a bare reference and does not drop it', () => {
      const r = buildAgentRunConfig(
        ext({
          servers: [
            { name: 'github', def: null },
            { name: 'zumibot_x', def: null }
          ]
        }),
        'locked'
      )
      expect(r).toEqual({ disallowedTools: [], extraArgs: [], env: {}, dropped: [], connectorPrefixes: {}, connectorsOff: [] })
    })

    it('adds none of a server list the parser could not read whole', () => {
      const r = buildAgentRunConfig(ext({ servers: [{ name: 'db', def: { command: 'node' } }], serversEditable: false }), [])
      expect(r).toEqual(NO_RUN_CONFIG)
    })

    it('keeps odd server names as keys', () => {
      const r = buildAgentRunConfig(ext({ servers: [{ name: 'my db: v2.1@x', def: { command: 'node' } }] }), [])
      expect(Object.keys(mcpOf(r.extraArgs).mcpServers)).toEqual(['my db: v2.1@x'])
    })

    it('lets a later definition of one name replace the earlier and number only what stays', () => {
      const servers = [
        { name: 's', def: { command: 'a', env: { T: '${vault:A}' } } },
        { name: 's', def: { command: 'b', env: { T: '${vault:B}' } } }
      ]
      const r = buildAgentRunConfig(ext({ servers }), [key('A', 'aa'), key('B', 'bb')])
      expect(mcpOf(r.extraArgs).mcpServers.s).toEqual({ command: 'b', env: { T: '${ZUMIBOT_MCP_VAULT_0}' } })
      expect(r.env).toEqual({ ZUMIBOT_MCP_VAULT_0: 'bb' })
    })

    describe("one name twice: the last definition wins, at the first one's place", () => {
      const good = { name: 'other', def: { command: 'o' } }

      it('earlier kept, later dropped: the name is dropped and absent from the config', () => {
        const servers = [{ name: 's', def: { command: 'a' } }, good, { name: 's', def: { command: 'b', env: { T: '${vault:NOPE}' } } }]
        const r = buildAgentRunConfig(ext({ servers }), [])
        expect(r.dropped).toEqual([{ server: 's', env: 'NOPE', reason: 'vault-missing' }])
        // The earlier `s` must not start while the card says it did not.
        expect(Object.keys(mcpOf(r.extraArgs).mcpServers)).toEqual(['other'])
        expect(JSON.stringify(r.extraArgs)).not.toContain('"command":"a"')
        expect(r.env).toEqual({})
      })

      it('earlier dropped, later kept: nothing is dropped and the later one starts', () => {
        const servers = [
          { name: 's', def: { command: 'a', env: { T: '${vault:NOPE}' } } },
          good,
          { name: 's', def: { command: 'b', env: { T: '${vault:B}' } } }
        ]
        const r = buildAgentRunConfig(ext({ servers }), [key('B', 'bb')])
        expect(r.dropped).toEqual([])
        const m = mcpOf(r.extraArgs).mcpServers
        // First position, last definition; the overridden one's missing key burns no number.
        expect(Object.keys(m)).toEqual(['s', 'other'])
        expect(m.s).toEqual({ command: 'b', env: { T: '${ZUMIBOT_MCP_VAULT_0}' } })
        expect(r.env).toEqual({ ZUMIBOT_MCP_VAULT_0: 'bb' })
      })

      it('keeps the first position for the last definition', () => {
        const servers = [
          { name: 'a', def: { command: '1' } },
          { name: 's', def: { command: 'old' } },
          { name: 'b', def: { command: '2' } },
          { name: 's', def: { command: 'new' } }
        ]
        const m = mcpOf(buildAgentRunConfig(ext({ servers }), []).extraArgs).mcpServers
        expect(Object.keys(m)).toEqual(['a', 's', 'b'])
        expect(m.s).toEqual({ command: 'new' })
      })

      it('checks only the winner when the Vault is locked', () => {
        const servers = [
          { name: 's', def: { command: 'a', env: { T: '${vault:GH}' } } },
          { name: 's', def: { command: 'b' } }
        ]
        const r = buildAgentRunConfig(ext({ servers }), 'locked')
        expect(r.dropped).toEqual([])
        expect(mcpOf(r.extraArgs).mcpServers.s).toEqual({ command: 'b' })
        const flipped = buildAgentRunConfig(ext({ servers: [...servers].reverse() }), 'locked')
        expect(flipped.dropped).toEqual([{ server: 's', env: 'GH', reason: 'vault-locked' }])
        expect(flipped.extraArgs).toEqual([])
      })

      it('lets a later inline definition replace an earlier bare reference', () => {
        const servers = [
          { name: 's', def: null },
          { name: 's', def: { command: 'b' } }
        ]
        expect(mcpOf(buildAgentRunConfig(ext({ servers }), []).extraArgs).mcpServers).toEqual({ s: { command: 'b' } })
      })

      it('lets a later bare reference replace an earlier inline definition, which then adds and drops nothing', () => {
        const servers = [
          { name: 's', def: { command: 'a', env: { T: '${vault:NOPE}' } } },
          { name: 's', def: null }
        ]
        expect(buildAgentRunConfig(ext({ servers }), [])).toEqual(NO_RUN_CONFIG)
      })

      it('reports a reserved name once, not once per copy', () => {
        const servers = [
          { name: 'zumibot_x', def: { command: 'a' } },
          { name: 'zumibot_x', def: { command: 'b' } }
        ]
        expect(buildAgentRunConfig(ext({ servers }), []).dropped).toEqual([{ server: 'zumibot_x', env: null, reason: 'reserved-name' }])
      })
    })

    it('puts --settings before --mcp-config', () => {
      const r = buildAgentRunConfig(ext({ plugins: { 'a@m': true }, servers: [{ name: 's', def: { command: 'n' } }] }), [])
      expect(r.extraArgs.filter((a) => a.startsWith('--'))).toEqual(['--settings', '--mcp-config'])
      expect(r.extraArgs.indexOf('--settings')).toBeLessThan(r.extraArgs.indexOf('--mcp-config'))
    })
  })

  it('is pure: the input is not touched and two calls agree', () => {
    const input = ext({
      serversOff: ['claude.ai Gmail'],
      plugins: { 'a@m': false },
      skillsOff: ['x'],
      servers: [{ name: 's', def: { command: 'n', env: { A: '${vault:K}' } } }],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] }
    })
    const before = JSON.stringify(input)
    const keys = [key('K', 'v')]
    const a = buildAgentRunConfig(input, keys)
    const b = buildAgentRunConfig(input, keys)
    expect(JSON.stringify(input)).toBe(before)
    expect(a).toEqual(b)
    a.extraArgs.push('x')
    a.env.Z = '1'
    expect(buildAgentRunConfig(input, keys)).toEqual(b)
  })

  it('merges through buildArgs into one --settings that keeps the pause hook and carries the agent hook', () => {
    const pause = pauseSettings({ node: '/usr/bin/node', entry: '/app/pauseHook.mjs', electronNode: false })
    const hook = { type: 'command' as const, command: './check.sh' }
    const r = buildAgentRunConfig(ext({ serversOff: ['claude.ai Gmail'], hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] } }), [])
    const args = buildArgs({
      agentName: 'a',
      resumeSessionId: null,
      permissionMode: 'auto',
      disallowedTools: r.disallowedTools,
      // The run's own settings come first, the agent's after, as Task 4 wires them.
      extraArgs: ['--settings', pause, ...r.extraArgs]
    })
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    const merged = JSON.parse(args[args.indexOf('--settings') + 1]) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: unknown[] }> }
      deniedMcpServers: unknown
    }
    expect(merged.hooks.PreToolUse.map((g) => g.matcher)).toEqual(['*', 'Bash'])
    expect(merged.hooks.PreToolUse[1].hooks).toEqual([hook])
    expect(merged.hooks.PreToolUse[0].hooks).toEqual(JSON.parse(pause).hooks.PreToolUse[0].hooks)
    expect(merged.deniedMcpServers).toEqual([{ serverName: 'claude.ai Gmail' }])
    expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(['--disallowedTools', 'mcp__claude_ai_Gmail'])
  })
})
