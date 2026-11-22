import { describe, expect, it } from 'vitest'
import { EXT_TEXT, type LoadoutHook, type LoadoutPlugin, type LoadoutServer, type LoadoutSkill } from '@zumibot/shared/extensions'
import {
  FOLDER_RUN_NOTE,
  HOOK_FILE_LABEL,
  findHookRow,
  offersReload,
  SCOPE_LABEL,
  TAB_LABEL,
  TAB_ORDER,
  emptyText,
  hookKey,
  hookRow,
  listedHooks,
  listedServers,
  loginCommand,
  oneLine,
  pluginLine,
  removeText,
  serverRow,
  shownOn,
  skillRow,
  sortByName,
  statusInfo,
  tabKeyTarget,
  tokensText,
  toolsText
} from '../src/state/extensionsPage'

const server = (over: Partial<LoadoutServer> = {}): LoadoutServer => ({
  name: 'echo-test',
  status: 'connected',
  source: 'user',
  transport: 'stdio',
  plugin: null,
  tools: [],
  scope: 'user',
  note: null,
  connector: null,
  ...over
})
const skill = (over: Partial<LoadoutSkill> = {}): LoadoutSkill => ({
  name: 'my-skill',
  description: 'Does a thing',
  source: 'user',
  plugin: null,
  tokens: 120,
  on: true,
  editable: true,
  ...over
})
const hook = (over: Partial<LoadoutHook> = {}): LoadoutHook => ({
  event: 'PreToolUse',
  matcher: 'Bash',
  type: 'command',
  command: 'echo hi',
  timeout: null,
  source: 'user',
  plugin: null,
  at: { group: 0, hook: 0 },
  stamp: 'st',
  ...over
})
const plugin = (over: Partial<LoadoutPlugin> = {}): LoadoutPlugin => ({
  id: 'caveman@caveman',
  enabled: true,
  skills: 2,
  servers: 1,
  hooks: 3,
  ...over
})

describe('tabs', () => {
  it('lists the four tabs in order with their labels', () => {
    expect(TAB_ORDER).toEqual(['servers', 'plugins', 'skills', 'hooks'])
    expect(TAB_LABEL).toEqual({ servers: 'Servers', plugins: 'Plugins', skills: 'Skills', hooks: 'Hooks' })
  })

  it('moves with the arrow keys (wrapping), Home and End, and ignores other keys', () => {
    expect(tabKeyTarget('ArrowRight', 'servers')).toBe('plugins')
    expect(tabKeyTarget('ArrowRight', 'hooks')).toBe('servers')
    expect(tabKeyTarget('ArrowLeft', 'servers')).toBe('hooks')
    expect(tabKeyTarget('ArrowLeft', 'skills')).toBe('plugins')
    expect(tabKeyTarget('Home', 'skills')).toBe('servers')
    expect(tabKeyTarget('End', 'plugins')).toBe('hooks')
    expect(tabKeyTarget('Enter', 'plugins')).toBeNull()
    expect(tabKeyTarget('a', 'plugins')).toBeNull()
  })
})

describe('statusInfo', () => {
  it('names every status the CLI reports', () => {
    expect(statusInfo('connected')).toEqual({ label: 'Connected', tone: 'ok' })
    expect(statusInfo('needs-auth')).toEqual({ label: 'Needs sign-in', tone: 'warn' })
    expect(statusInfo('failed')).toEqual({ label: 'Failed', tone: 'bad' })
    expect(statusInfo('pending')).toEqual({ label: 'Connecting…', tone: 'busy' })
    expect(statusInfo('disabled')).toEqual({ label: 'Off', tone: 'idle' })
    expect(statusInfo('unknown')).toEqual({ label: 'Unknown', tone: 'idle' })
  })
})

describe('serverRow', () => {
  it('lets a user, local or project server be edited and removed from its own scope', () => {
    expect(serverRow(server({ source: 'user', scope: 'user' }))).toMatchObject({ scope: 'user', note: null })
    expect(serverRow(server({ source: 'local', scope: 'local' }))).toMatchObject({ scope: 'local' })
    expect(serverRow(server({ source: 'project', scope: 'project' }))).toMatchObject({ scope: 'project' })
  })

  it('gives no actions to a row without a scope, and says where it can be changed', () => {
    expect(serverRow(server({ source: 'user', scope: null })).scope).toBeNull()
    expect(serverRow(server({ source: 'plugin', scope: null, plugin: 'chrome-devtools-mcp' }))).toEqual({
      scope: null,
      note: 'Comes with plugin chrome-devtools-mcp',
      signIn: null
    })
    expect(serverRow(server({ source: 'plugin', scope: null, plugin: null })).note).toBe('Comes with a plugin')
    expect(serverRow(server({ source: 'claudeai', scope: null })).note).toBe('Manage in claude.ai › Settings › Connectors')
    expect(serverRow(server({ source: 'other', scope: null })).note).toBe('Not editable here')
  })

  it("keeps the loadout's own note on a project row it made read-only (a parent folder's .mcp.json, a linked file)", () => {
    expect(serverRow(server({ source: 'project', scope: null, note: "From /repo's .mcp.json" }))).toEqual({
      scope: null,
      note: "From /repo's .mcp.json",
      signIn: null
    })
    expect(serverRow(server({ source: 'project', scope: 'project', note: null })).scope).toBe('project')
  })

  it('never offers actions to a server a plugin or claude.ai provides, even if a scope came with it', () => {
    expect(serverRow(server({ source: 'plugin', scope: 'user', plugin: 'p' })).scope).toBeNull()
    expect(serverRow(server({ source: 'claudeai', scope: 'user' })).scope).toBeNull()
  })

  it('tells a needs-auth server how to sign in, and a claude.ai one to use the connectors', () => {
    expect(serverRow(server({ status: 'needs-auth', name: 'linear' })).signIn).toBe('Sign in from a terminal: claude mcp login linear')
    expect(serverRow(server({ status: 'needs-auth', name: 'claude.ai Gmail', source: 'claudeai', scope: null })).signIn).toBe(
      'Sign in from claude.ai › Settings › Connectors'
    )
    expect(serverRow(server({ status: 'connected' })).signIn).toBeNull()
  })

  it('quotes a name the shell would split', () => {
    expect(loginCommand('linear')).toBe('claude mcp login linear')
    expect(loginCommand('plugin:chrome-devtools-mcp:chrome-devtools')).toBe('claude mcp login plugin:chrome-devtools-mcp:chrome-devtools')
    expect(loginCommand('my server')).toBe("claude mcp login 'my server'")
    expect(loginCommand("it's")).toBe("claude mcp login 'it'\\''s'")
  })
})

describe('toolsText', () => {
  it('counts with a singular', () => {
    expect(toolsText(0)).toBe('No tools')
    expect(toolsText(1)).toBe('1 tool')
    expect(toolsText(12)).toBe('12 tools')
  })
})

describe('pluginLine', () => {
  it('counts what a plugin adds with singulars', () => {
    expect(pluginLine(plugin())).toBe('2 skills · 1 server · 3 hooks')
    expect(pluginLine(plugin({ skills: 1, servers: 2, hooks: 1 }))).toBe('1 skill · 2 servers · 1 hook')
  })

  it('says what to do for a switched-off plugin, which loads nothing to count', () => {
    expect(pluginLine(plugin({ enabled: false, skills: 0, servers: 0, hooks: 0 }))).toBe('Switch it on to see what it adds')
    expect(pluginLine(plugin({ enabled: true, skills: 0, servers: 0, hooks: 0 }))).toBe('0 skills · 0 servers · 0 hooks')
  })

  it("in the agent card reads the agent's own state: on globally but off for the agent loads nothing for it", () => {
    expect(pluginLine(plugin({ enabled: true, skills: 0, servers: 0, hooks: 0 }), false)).toBe('Off for this agent')
    expect(pluginLine(plugin({ enabled: true }), false)).toBe('Off for this agent')
    expect(pluginLine(plugin({ enabled: false }), true)).toBe('2 skills · 1 server · 3 hooks')
  })
})

describe('skillRow and tokensText', () => {
  it('formats tokens, and nothing when unknown', () => {
    expect(tokensText(null)).toBeNull()
    expect(tokensText(0)).toBe('0 tokens')
    expect(tokensText(1)).toBe('1 token')
    expect(tokensText(1234)).toBe('1,234 tokens')
  })

  it('edits a user or project skill the loadout calls editable, in its own scope', () => {
    expect(skillRow(skill({ source: 'user' }))).toEqual({ scope: 'user', note: null })
    expect(skillRow(skill({ source: 'project' }))).toEqual({ scope: 'project', note: null })
  })

  it('says why a skill is not editable', () => {
    expect(skillRow(skill({ source: 'plugin', editable: false, plugin: 'caveman' }))).toEqual({
      scope: null,
      note: 'Comes with plugin caveman'
    })
    expect(skillRow(skill({ source: 'plugin', editable: false, plugin: null })).note).toBe('Comes with a plugin')
    expect(skillRow(skill({ source: 'claudeai', editable: false })).note).toBe('Synced from claude.ai')
    expect(skillRow(skill({ source: 'bundled', editable: false })).note).toBe('Built into Claude Code')
    expect(skillRow(skill({ source: 'other', editable: false })).note).toBe('Not editable here')
    // A user skill the server does not call editable (a name the editor refuses) stays read-only.
    expect(skillRow(skill({ source: 'user', editable: false }))).toEqual({ scope: null, note: 'Not editable here' })
  })
})

describe('hookRow', () => {
  it('lets a command hook with a position in a settings file be edited, in that file, with its stamp', () => {
    for (const source of ['user', 'project', 'local'] as const) {
      expect(hookRow(hook({ source }))).toMatchObject({ file: source, editable: true, note: null })
    }
  })

  it('keeps everything else read-only and says why', () => {
    expect(hookRow(hook({ source: 'plugin', plugin: 'caveman@caveman', at: null, stamp: null }))).toMatchObject({
      file: null,
      editable: false,
      note: 'Plugin hooks follow their plugin'
    })
    expect(hookRow(hook({ type: 'prompt' })).editable).toBe(false)
    expect(hookRow(hook({ type: 'prompt' })).note).toBe('Not editable here')
    expect(hookRow(hook({ at: null })).editable).toBe(false)
    expect(hookRow(hook({ stamp: null })).editable).toBe(false)
    expect(hookRow(hook({ source: 'zumibot', at: null, stamp: null })).note).toBe('Not editable here')
    expect(hookRow(hook({ source: 'agent', at: null, stamp: null })).editable).toBe(false)
  })

  it('shows the command on one line and the timeout in seconds', () => {
    expect(hookRow(hook({ command: 'echo a\n  && echo b', timeout: 30 }))).toMatchObject({ line: 'echo a && echo b', timeout: '30 s' })
    expect(hookRow(hook({ timeout: null })).timeout).toBeNull()
    expect(hookRow(hook({ matcher: '' })).matcher).toBe('Every tool')
    expect(hookRow(hook({ matcher: 'Bash' })).matcher).toBe('Bash')
  })
})

describe('listedServers and listedHooks', () => {
  it("leaves out what ZumiBot adds to a run and an agent's own, which are not this folder's", () => {
    const rows = [
      server({ name: 'a' }),
      server({ name: 'b', source: 'zumibot', scope: null }),
      server({ name: 'c', source: 'agent', scope: null }),
      server({ name: 'd', source: 'plugin', scope: null })
    ]
    expect(listedServers({ servers: rows }).map((s) => s.name)).toEqual(['a', 'd'])
    const hooks = [
      hook({ command: 'one' }),
      hook({ source: 'zumibot', command: 'two', at: null }),
      hook({ source: 'agent', command: 'three', at: null })
    ]
    expect(listedHooks({ hooks }).map((h) => h.command)).toEqual(['one'])
  })
})

describe('hookKey', () => {
  it('names a hook row by its file, event and place, so two rows of one event differ', () => {
    expect(hookKey(hook())).toBe('hook:user:PreToolUse:0.0')
    expect(hookKey(hook({ at: { group: 1, hook: 2 } }))).toBe('hook:user:PreToolUse:1.2')
    expect(hookKey(hook({ source: 'plugin', at: null }))).toBe('hook:plugin:PreToolUse:-')
  })
})

describe('oneLine', () => {
  it('collapses white space and cuts a long text with an ellipsis', () => {
    expect(oneLine('  a \n\t b  ')).toBe('a b')
    expect(oneLine('x'.repeat(300), 10)).toBe('xxxxxxxxx…')
    expect(oneLine('short', 10)).toBe('short')
  })
})

describe('sortByName', () => {
  it('sorts by name ignoring case without changing the list it is given', () => {
    const rows = [{ name: 'b' }, { name: 'A' }, { name: 'c' }]
    expect(sortByName(rows).map((r) => r.name)).toEqual(['A', 'b', 'c'])
    expect(rows.map((r) => r.name)).toEqual(['b', 'A', 'c'])
  })
})

describe('labels', () => {
  it('names each scope a server can be saved in', () => {
    expect(Object.keys(SCOPE_LABEL)).toEqual(['user', 'local', 'project'])
    expect(SCOPE_LABEL.user).toContain('every folder')
    expect(SCOPE_LABEL.project).toContain('.mcp.json')
    // Ruling 21: the CLI files local servers under the repo root, so they follow the project, not the folder.
    expect(SCOPE_LABEL.local).toBe('This project, only for you')
  })

  it('names each settings file a hook can be written to', () => {
    expect(Object.keys(HOOK_FILE_LABEL)).toEqual(['user', 'project', 'local'])
    expect(HOOK_FILE_LABEL.local).toContain('settings.local.json')
  })

  it('has an empty text per section', () => {
    expect(emptyText('servers')).toBe('No MCP servers load in this folder.')
    expect(emptyText('plugins')).toBe('No plugins are installed.')
    expect(emptyText('skills')).toBe('No skills load in this folder.')
    expect(emptyText('hooks')).toBe('No hooks are set up for this folder.')
  })
})

describe('shownOn', () => {
  it('shows the state a switch was asked for until a newer loadout lands, then the loadout', () => {
    expect(shownOn(true, undefined, 5)).toBe(true)
    expect(shownOn(true, { on: false, at: 5 }, 5)).toBe(false)
    expect(shownOn(false, { on: true, at: 5 }, 5)).toBe(true)
    // A newer probe answered: its state is the truth, whatever was asked.
    expect(shownOn(true, { on: false, at: 5 }, 6)).toBe(true)
    expect(shownOn(false, { on: true, at: 5 }, null)).toBe(false)
  })
})

describe('removeText', () => {
  it('names what goes and where it goes from', () => {
    expect(removeText.server('echo-test', 'user')).toBe('Remove echo-test from your own servers? Claude Code stops loading it.')
    expect(removeText.server('echo-test', 'local')).toBe('Remove echo-test from this project (only for you)? Claude Code stops loading it.')
    expect(removeText.server('echo-test', 'project')).toBe(
      'Remove echo-test from this folder’s .mcp.json? Everyone who uses the project stops getting it.'
    )
    expect(removeText.skill('my-skill')).toBe('Move the my-skill skill, with its whole folder, to the Trash?')
    expect(removeText.hook('PreToolUse', 'user')).toBe('Remove this PreToolUse hook from your settings?')
    expect(removeText.hook('Stop', 'project')).toBe('Remove this Stop hook from this project’s settings?')
    expect(removeText.hook('Stop', 'local')).toBe('Remove this Stop hook from this folder’s local settings?')
  })
})

describe('the folder note (I3)', () => {
  it('says that looking at a folder runs it, as a chat there would', () => {
    expect(FOLDER_RUN_NOTE).toBe('Looking at a folder starts its MCP servers and runs its hooks, as a chat there would.')
  })
})

describe('offersReload', () => {
  it('offers Reload for a save that went stale or lost the server, and nothing else', () => {
    expect(offersReload(EXT_TEXT.stale)).toBe(true)
    expect(offersReload(EXT_TEXT.addFailedLost)).toBe(true)
    for (const e of [null, EXT_TEXT.addFailedRestored, EXT_TEXT.badServer, EXT_TEXT.nameTaken, 'EIO'])
      expect(offersReload(e), String(e)).toBe(false)
  })
})

describe('findHookRow', () => {
  it('finds the same hook in a fresher loadout, now editable at its new place', () => {
    const old = hook({ event: 'Stop', matcher: '', command: 'a.sh', source: 'user', at: { group: 0, hook: 0 }, stamp: 'old' })
    const fresh = [
      hook({ event: 'Stop', matcher: '', command: 'other.sh', source: 'user', at: { group: 0, hook: 0 }, stamp: 'new' }),
      hook({ event: 'Stop', matcher: '', command: 'a.sh', source: 'project', at: { group: 0, hook: 0 }, stamp: 'new' }),
      hook({ event: 'Stop', matcher: '', command: 'a.sh', source: 'user', at: { group: 1, hook: 0 }, stamp: 'new' })
    ]
    expect(findHookRow(fresh, old)).toBe(fresh[2])
    expect(findHookRow(fresh.slice(0, 2), old)).toBeNull()
    expect(findHookRow([{ ...fresh[2], at: null, stamp: null }], old)).toBeNull()
  })
})
