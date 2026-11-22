import { afterEach, describe, expect, it } from 'vitest'
import { serveTodoIpc } from '../../src/core/todos/todoIpc'
import { serveVaultIpc } from '../../src/core/vault/vaultIpc'
import { serveAskIpc } from '../../src/core/asks/askIpc'
import { serveAutomationIpc } from '../../src/core/automations/automationIpc'
import { serveBrowserIpc } from '../../src/core/browser/browserIpc'
import { serveDesktopIpc, DESKTOP_ASK_SETTINGS } from '../../src/core/desktop/desktopIpc'
import { BrowserCapabilities } from '../../src/core/browser/browserCapabilities'
import { AUTOMATION_ASK_SETTINGS } from '../../src/core/automations/automationTools'
import { buildArgs } from '../../src/core/chat/claudeRunner'

// Pins the exact argv the Claude CLI gets from every bridge, so refactoring how the MCP configs are built can't change it.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const keep = <T extends { close(): Promise<void> }>(service: T): T => {
  cleanups.push(() => service.close())
  return service
}

// Written by hand with literal key order, so it never goes through the code under test.
function config(server: string, flags: string, cap: string, electron: boolean): string {
  const env = `"ZUMIBOT_${cap}_CAPABILITY":"\${ZUMIBOT_${cap}_CAPABILITY}","ZUMIBOT_${cap}_IPC":"\${ZUMIBOT_${cap}_IPC}"${electron ? ',"ELECTRON_RUN_AS_NODE":"1"' : ''}`
  return `{"mcpServers":{"${server}":{"type":"stdio","command":"/n","args":["/b.mjs"],${flags}"env":{${env}}}}}`
}
const LOAD = '"alwaysLoad":true,',
  DAY = '"timeout":86400000,'
// What Codex (and any other provider) renders its own MCP config from.
function spec(name: string, cap: string, electron: boolean, extra: object) {
  return {
    name,
    command: '/n',
    args: ['/b.mjs'],
    passEnv: [`ZUMIBOT_${cap}_CAPABILITY`, `ZUMIBOT_${cap}_IPC`],
    fixedEnv: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    ...extra
  }
}
const manager = { run: async () => ({ ok: true as const, data: null }), registerTurn: () => () => {}, endTurn: async () => {} }

describe.each([false, true])('bridge argv, electronNode %s', (electron) => {
  const base = { node: '/n', electronNode: electron }
  it('todos', async () => {
    const ipc = keep(await serveTodoIpc({ service: {} as never, runtime: { ...base, todoBridgeEntry: '/b.mjs' } }))
    const turn = ipc.createTodoTurn({ chatId: 'c', agent: () => 'a', turn: 't', label: 'l' })
    expect(turn.args).toEqual(['--mcp-config', config('zumibot_todos', LOAD, 'TODOS', electron)])
    expect(turn.mcp).toEqual(spec('zumibot_todos', 'TODOS', electron, { alwaysLoad: true }))
    turn.dispose()
  })
  it('vault', async () => {
    const ipc = keep(await serveVaultIpc({ items: () => [], runtime: { ...base, vaultBridgeEntry: '/b.mjs' } }))
    const turn = ipc.createVaultTurn({ chatId: 'c', agent: () => 'a', turn: 't' })
    expect(turn.args).toEqual(['--mcp-config', config('zumibot_vault', LOAD, 'VAULT', electron)])
    expect(turn.mcp).toEqual(spec('zumibot_vault', 'VAULT', electron, { alwaysLoad: true }))
    turn.dispose()
  })
  it('asks', async () => {
    const ipc = keep(await serveAskIpc({ service: {} as never, runtime: { ...base, askBridgeEntry: '/b.mjs' } }))
    const turn = ipc.createAskTurn({ chatId: 'c', agent: () => 'a', chain: [], turn: 't' })
    expect(turn.args).toEqual(['--mcp-config', config('zumibot_agents', DAY, 'ASKS', electron)])
    expect(turn.mcp).toEqual(spec('zumibot_agents', 'ASKS', electron, { timeoutMs: 86400000 }))
    expect(turn.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe('0')
    turn.dispose()
  })
  it('automations, with and without ask rules', async () => {
    const ipc = keep(await serveAutomationIpc({ service: {} as never, runtime: { ...base, automationBridgeEntry: '/b.mjs' } }))
    const turn = ipc.createAutomationTurn({ chatId: 'c', writable: true })
    expect(turn.args).toEqual([
      '--mcp-config',
      config('zumibot_automations', LOAD, 'AUTOMATIONS', electron),
      '--settings',
      AUTOMATION_ASK_SETTINGS
    ])
    expect(turn.mcp).toEqual(spec('zumibot_automations', 'AUTOMATIONS', electron, { alwaysLoad: true }))
    const side = ipc.createAutomationTurn({ chatId: 'c', writable: false }, { side: true })
    expect(side.args).toEqual(['--mcp-config', config('zumibot_automations', LOAD, 'AUTOMATIONS', electron)])
    expect(side.mcp).toEqual(turn.mcp)
    turn.dispose()
    side.dispose()
  })
  it('browser', async () => {
    const ipc = keep(
      await serveBrowserIpc({ capabilities: new BrowserCapabilities(), manager, runtime: { ...base, bridgeEntry: '/b.mjs' } })
    )
    const turn = await ipc.createBrowserTurn({ profileId: 'p', chatId: 'c', turnId: 't' }, async () => {})
    expect(turn.args).toEqual(['--mcp-config', config('zumibot_browser', DAY, 'BROWSER', electron), '--no-chrome'])
    expect(turn.mcp).toEqual(spec('zumibot_browser', 'BROWSER', electron, { timeoutMs: 86400000 }))
    await turn.dispose()
  })
  it('desktop, with and without ask rules', async () => {
    const ipc = keep(
      await serveDesktopIpc({ capabilities: new BrowserCapabilities(), manager, runtime: { ...base, bridgeEntry: '/b.mjs' } })
    )
    const turn = await ipc.createDesktopTurn({ profileId: 'p', chatId: 'c', turnId: 't1' }, async () => {})
    expect(turn.args).toEqual(['--mcp-config', config('zumibot_desktop', DAY, 'DESKTOP', electron), '--settings', DESKTOP_ASK_SETTINGS])
    expect(turn.mcp).toEqual(spec('zumibot_desktop', 'DESKTOP', electron, { timeoutMs: 86400000 }))
    const side = await ipc.createDesktopTurn({ profileId: 'p', chatId: 'c', turnId: 't2' }, async () => {}, { side: true })
    expect(side.mcp).toEqual(turn.mcp)
    expect(side.args).toEqual(['--mcp-config', config('zumibot_desktop', DAY, 'DESKTOP', electron)])
    await turn.dispose()
    await side.dispose()
  })
})

describe('buildArgs', () => {
  const head = ['-p', '--agent', 'bot']
  const tail = [
    '--permission-mode',
    'auto',
    '--permission-prompt-tool',
    'stdio',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages'
  ]
  const o = { agentName: 'bot', resumeSessionId: null, permissionMode: 'auto' as const }
  it('plain', () => {
    expect(buildArgs(o)).toEqual([...head, ...tail])
  })
  it('resumed', () => {
    expect(buildArgs({ ...o, resumeSessionId: 's1' })).toEqual([...head, '--resume', 's1', ...tail])
  })
  it('cut', () => {
    expect(buildArgs({ ...o, resumeSessionId: 's1', resumeAt: 'e9' })).toEqual([
      ...head,
      '--resume',
      's1',
      '--resume-session-at',
      'e9',
      '--fork-session',
      ...tail
    ])
  })
  it('model and append system prompt', () => {
    expect(buildArgs({ ...o, model: 'opus', appendSystemPrompt: 'hi' })).toEqual([
      ...head,
      '--model',
      'opus',
      ...tail,
      '--append-system-prompt',
      'hi',
      '--system-prompt-snapshot',
      'off'
    ])
  })
  it('two --settings fragments merge into one', () => {
    expect(
      buildArgs({
        ...o,
        extraArgs: ['--mcp-config', '{"a":1}', '--settings', '{"x":{"p":[1]},"k":1}', '--settings', '{"x":{"p":[2]},"j":2}']
      })
    ).toEqual([...head, ...tail, '--mcp-config', '{"a":1}', '--settings', '{"x":{"p":[1,2]},"k":1,"j":2}'])
  })
  it('disallowed tools come last', () => {
    expect(buildArgs({ ...o, extraArgs: ['--no-chrome'], disallowedTools: ['A', 'B'] })).toEqual([
      ...head,
      ...tail,
      '--no-chrome',
      '--disallowedTools',
      'A',
      'B'
    ])
  })
})
