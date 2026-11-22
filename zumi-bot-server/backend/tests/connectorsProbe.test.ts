// The real-CLI connectors probe (e2e/connectorsProbe.mjs): its copy of the catalog, its verdict judge, and a whole run against a fake
// claude that lists claude.ai servers and applies the run's deniedMcpServers, so the plumbing is checked with no account and no quota.
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONNECTOR_IDS,
  CONNECTORS,
  connectorOf as appConnectorOf,
  denyEntries,
  unknownTools as appUnknownTools
} from '@zumibot/shared/connectors'
import * as probe from '../../e2e/connectorsProbe.mjs'
import { writeFakeBin } from './support/fakeBin'
import { removeDir } from './support/platform'

// A whole run starts the fake CLI several times, each through a launcher and a slower node start on Windows: seconds there.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []
afterEach(async () => {
  for (const k of ['FAKE_SERVERS', 'FAKE_DROP_MERGED', 'FAKE_NO_SETTINGS', 'FAKE_ASK', 'FAKE_ARGS_OUT', 'FAKE_TMP_OUT'])
    delete process.env[k]
  for (const d of dirs.splice(0)) removeDir(d)
})

it('pins its copy of the catalog and the matcher to the app ones', () => {
  expect(probe.CATALOG).toEqual(
    CONNECTORS.map((c) => ({ id: c.id, urls: c.urls, names: c.names, reads: c.read.length, tools: [...c.read, ...c.write] }))
  )
  expect(probe.denyAllEntries()).toEqual(denyEntries(CONNECTOR_IDS).deniedMcpServers)
  for (const [id, tools] of [
    ['gmail', ['search_threads', 'mcp__claude_ai_Gmail__search_threads', 'nope']],
    ['github', []],
    ['slack', ['x']]
  ] as const)
    expect(probe.unknownTools(id, tools)).toEqual(appUnknownTools(id, tools))
  // check e merges the connector deny and the vault guard's file rule into ONE object
  const merged = probe.mergedSettings()
  expect(merged.deniedMcpServers).toEqual(denyEntries(CONNECTOR_IDS).deniedMcpServers)
  expect(merged.permissions.deny).toEqual([expect.stringMatching(/^Read\(\/\/.+\/\*\*\)$/)])
  // ... and the ask rules of every connected connector's prefix
  expect(probe.mergedSettings(['mcp__claude_ai_Gmail', 'mcp__My_GitHub']).permissions.ask).toEqual([
    'mcp__claude_ai_Gmail__*',
    'mcp__My_GitHub__*'
  ])
  expect(merged.permissions.ask).toBeUndefined()
  for (const [url, name] of [
    ['https://gmailmcp.googleapis.com/mcp/v1', 'claude.ai Gmail'],
    ['https://gmail.mcp.claude.com/mcp', 'x'],
    ['https://api.githubcopilot.com/mcp/', 'My GitHub'],
    ['https://example.invalid/mcp', 'claude.ai Slack (2)'],
    ['https://example.invalid/mcp', 'claude.ai Fake Drive'],
    [null, 'claude.ai Notion'],
    ['http://mcp.slack.com/mcp', 'y']
  ] as const)
    expect(probe.connectorOf(url, name)).toBe(appConnectorOf(url, name))
})

const server = (name: string, url: string | null, status = 'connected', tools: unknown[] = []) => ({
  name,
  status,
  scope: 'claudeai',
  config: url === null ? {} : { type: 'claudeai-proxy', url },
  tools
})
const answers = (servers: unknown[], errors: Record<string, string> = {}, deny?: string[]) => ({
  version: '9.9.9',
  mcp: { mcpServers: servers },
  skills: null,
  hooks: null,
  errors,
  ...(deny ? { effective: { effective: { permissions: { deny } } } } : {})
})
const GMAIL_TOOLS = ['search_threads', 'send_message', 'list_labels', 'brand_new_tool']
const GMAIL = server('claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1', 'connected', GMAIL_TOOLS)
const GITHUB = server('My GitHub', 'https://api.githubcopilot.com/mcp/', 'connected', [{ name: 'get_me' }])
const OTHER = server('plain', null)
const RULE = probe.mergedSettings().permissions.deny[0]

it('judges the runs, every connected catalog connector on its own', () => {
  const run = (o: Parameters<typeof probe.judgeConnectors>[0]) => probe.judgeConnectors(o)
  const base = answers([GMAIL, GITHUB, OTHER])
  const clean = answers([OTHER], {}, [RULE])
  const all = {
    base,
    byUrl: { gmail: answers([GITHUB, OTHER]), github: answers([GMAIL, OTHER]) },
    byName: { gmail: answers([GITHUB, OTHER]) },
    merged: clean
  }
  const ok = run(all)
  expect(ok.verdict).toBe('PASS')
  // GitHub has no catalog name, so only the URL check is made for it
  expect(ok.checks.map((c) => `${c.key}${c.id ? `:${c.id}` : ''}`)).toEqual([
    'a',
    'b:gmail',
    'b:github',
    'c:gmail',
    'd:gmail',
    'd:github',
    'e'
  ])
  // The second connector is checked too: a CLI that denies Gmail by URL but not GitHub fails
  const second = run({ ...all, byUrl: { gmail: answers([GITHUB, OTHER]), github: answers([GITHUB, GMAIL, OTHER]) } })
  expect(second.verdict).toBe('FAILED')
  expect(second.checks.filter((c) => c.verdict === 'FAILED')).toMatchObject([{ key: 'b', id: 'github' }])
  expect(run({ ...all, byName: { gmail: answers([GMAIL, GITHUB]) } }).checks.find((c) => c.key === 'c')).toMatchObject({
    id: 'gmail',
    verdict: 'FAILED'
  })
  // A deny run that did not answer is inconclusive, never a pass
  expect(
    run({ ...all, byUrl: { gmail: answers([], { mcp: 'timeout' }), github: all.byUrl.github } }).checks.find(
      (c) => c.key === 'b' && c.id === 'gmail'
    )
  ).toMatchObject({ verdict: 'INCONCLUSIVE' })
  expect(run({ ...all, byUrl: { gmail: all.byUrl.gmail } }).checks.find((c) => c.key === 'b' && c.id === 'github')).toMatchObject({
    verdict: 'INCONCLUSIVE'
  })
  // The deny by URL is the real guard: a Gmail connector on a host no pattern covers is a failure, found in check a
  const odd = answers([server('claude.ai Gmail', 'https://gmail.example.invalid/mcp')])
  expect(run({ base: odd }).checks[0]).toMatchObject({ key: 'a', verdict: 'FAILED' })
  // Nothing signed in or connected: inconclusive, never a pass
  expect(run({ base: answers([OTHER]) })).toMatchObject({ verdict: 'INCONCLUSIVE' })
  // (a needs-auth connector is no target, but the merged run not listing it still shows the deny working)
  expect(
    run({ base: answers([server('claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1', 'needs-auth')]), merged: clean }).checks.map(
      (c) => c.verdict
    )
  ).toEqual(['PASS', 'INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE', 'PASS'])
  expect(run({ base: answers([], { mcp: 'error' }) }).checks[0].verdict).toBe('FAILED')
  expect(run({ base: answers([], { mcp: 'timeout' }) }).checks[0].verdict).toBe('INCONCLUSIVE')
  expect(run({ base: null }).verdict).toBe('INCONCLUSIVE')
})

it("check d fails when none of a connector's tool names is a bare catalog name, and prints counts only", () => {
  const prefixed = server('claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1', 'connected', [
    'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude_ai_Gmail__send_message'
  ])
  const r = probe.judgeConnectors({
    base: answers([prefixed]),
    byUrl: { gmail: answers([]) },
    byName: { gmail: answers([]) },
    merged: answers([], {}, [RULE])
  })
  const d = r.checks.find((c) => c.key === 'd')
  expect(d).toMatchObject({
    id: 'gmail',
    verdict: 'FAILED',
    text: "the CLI's tool names are not the bare names the catalog lists: 2 of 2 tools of claude.ai Gmail are unknown to it"
  })
  expect(r.verdict).toBe('FAILED')
  expect(JSON.stringify(r.checks)).not.toContain('search_threads')
  // One known tool is enough (the catalog may lag the connector); no tools at all cannot be checked
  expect(probe.judgeConnectors({ base: answers([GMAIL]) }).checks.find((c) => c.key === 'd')).toMatchObject({ verdict: 'PASS' })
  expect(
    probe
      .judgeConnectors({ base: answers([server('claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1')]) })
      .checks.find((c) => c.key === 'd')
  ).toMatchObject({ verdict: 'INCONCLUSIVE' })
})

it('check e needs both: no catalog connector listed and the file deny rule still in effect', () => {
  const e = (merged: ReturnType<typeof answers> | null) =>
    probe
      .judgeConnectors({ base: answers([GMAIL]), byUrl: { gmail: answers([]) }, byName: { gmail: answers([]) }, merged })
      .checks.find((c) => c.key === 'e')
  expect(e(answers([OTHER], {}, [RULE]))).toMatchObject({ verdict: 'PASS' })
  expect(e(answers([OTHER], {}, ['Bash(x)', RULE]))).toMatchObject({ verdict: 'PASS' })
  // The CLI dropped the whole settings object: the connector shows (so the deny is lost too) or the rule is gone
  expect(e(answers([OTHER], {}, []))).toMatchObject({
    verdict: 'FAILED',
    text: expect.stringContaining('dropped the whole settings object')
  })
  expect(e(answers([GMAIL], {}, [RULE]))).toMatchObject({ verdict: 'FAILED' })
  expect(e(answers([server('claude.ai Slack (2)', null)], {}, [RULE]))).toMatchObject({ verdict: 'FAILED' })
  // The rules could not be read: inconclusive, never a pass
  expect(e(answers([OTHER]))).toMatchObject({ verdict: 'INCONCLUSIVE' })
  expect(e(answers([OTHER], { settings: 'error' }))).toMatchObject({ verdict: 'INCONCLUSIVE', text: expect.stringContaining('(error)') })
  expect(e(answers([], { mcp: 'timeout' }))).toMatchObject({ verdict: 'INCONCLUSIVE' })
  expect(e(null)).toMatchObject({ verdict: 'INCONCLUSIVE' })
})

// Lists the servers in FAKE_SERVERS (JSON) as mcp_status, minus what the run's --settings deniedMcpServers names (by serverName or serverUrl),
// and answers get_settings with the permissions.deny of that --settings. FAKE_DROP_MERGED: a CLI that drops the whole settings object
// when it holds both a deny entry and a permissions rule. FAKE_NO_SETTINGS: get_settings answers with an error. FAKE_ARGS_OUT: one JSON
// line of argv per start. FAKE_TMP_OUT: one line per start with its CLAUDE_CODE_TMPDIR, under which it then writes a file, as the CLI
// puts its per-run folders there. A `type: user` line is the ask check's turn (it names the tool in the prompt); FAKE_ASK says what the CLI does:
// ask (default: sends can_use_tool for a tool the run's permissions.ask covers, then ends on the answer), unasked (the tool runs with no
// can_use_tool and a good result: an ask rule that did not hold), refused (an error result with no can_use_tool: the CLI's own refusal), never (no tool call), auth (an error result).
const FAKE = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const argv = process.argv.slice(2)
if (process.env.FAKE_ARGS_OUT) appendFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify(argv) + '\\n')
const tmpRoot = process.env.CLAUDE_CODE_TMPDIR ?? ''
if (process.env.FAKE_TMP_OUT) appendFileSync(process.env.FAKE_TMP_OUT, tmpRoot + '\\n')
if (process.env.FAKE_TMP_OUT && tmpRoot) { mkdirSync(join(tmpRoot, 'claude-fake', 'run'), { recursive: true }); writeFileSync(join(tmpRoot, 'claude-fake', 'run', 'out'), 'x') }
let settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}')
if (process.env.FAKE_DROP_MERGED && settings.deniedMcpServers && settings.permissions) settings = {}
const denied = settings.deniedMcpServers ?? []
const match = (p, u) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('.*') + '$').test(u)
const servers = JSON.parse(process.env.FAKE_SERVERS).filter((s) => !denied.some((d) => d.serverName === s.name || (d.serverUrl && s.config?.url && match(d.serverUrl, s.config.url))))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let answer = null
const mode = process.env.FAKE_ASK ?? 'ask'
const finish = (result, isError = false) => out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result, session_id: 's' })
const toolResult = (isError) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: isError ? 'Denied' : 'secret payload', is_error: isError }] } })
async function turn(prompt) {
  out({ type: 'system', subtype: 'init', session_id: 's', claude_code_version: '9.9.9-fake' })
  if (mode === 'auth') return finish('Invalid API key', true)
  if (mode === 'never') return finish('done')
  const tool = /mcp__[A-Za-z0-9_-]+/.exec(prompt)[0]
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: tool, input: {} }] } })
  const asked = mode === 'ask' && (settings.permissions?.ask ?? []).some((r) => r.endsWith('*') ? tool.startsWith(r.slice(0, -1)) : r === tool)
  if (!asked) { toolResult(mode === 'refused'); return finish('done') }
  const response = await new Promise((resolve) => { answer = resolve; out({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: tool, input: {}, tool_use_id: 't1' } }) })
  toolResult(response?.response?.behavior !== 'allow')
  finish('done')
}
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.type === 'control_response') return answer?.(m.response)
  if (m.type === 'user') return void turn(typeof m.message?.content === 'string' ? m.message.content : '')
  if (m.type !== 'control_request') return
  if (m.request.subtype === 'get_settings' && process.env.FAKE_NO_SETTINGS) return out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'no' } })
  const body = { initialize: { claude_code_version: '9.9.9-fake' }, mcp_status: { mcpServers: servers }, get_skills_dialog: { skills: [] }, get_hooks_listing: { events: [], hooks: [] }, get_settings: { effective: { permissions: { deny: settings.permissions?.deny ?? [] } } } }[m.request.subtype]
  out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: body ?? {} } })
}).on('close', () => process.exit(0))
`

async function fakeClaude(servers: unknown[], env: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-connprobe-test-'))
  dirs.push(dir)
  const script = join(dir, 'claude.mjs')
  await writeFile(script, FAKE)
  const bin = writeFakeBin(dir, 'claude', script)
  process.env.FAKE_SERVERS = JSON.stringify(servers)
  Object.assign(process.env, env)
  return bin
}

const NOTION_AUTH = server('claude.ai Notion', 'https://mcp.notion.com/mcp', 'needs-auth')

it('a whole run against a fake claude passes when every deny works, and prints no URL beyond a host', async () => {
  const bin = await fakeClaude([GMAIL, NOTION_AUTH, GITHUB, OTHER])
  const r = await probe.probeConnectors({ bin, log: () => {} })
  expect(r.verdict).toBe('PASS')
  expect(r.version).toBe('9.9.9-fake')
  expect(r.checks.map((c) => `${c.key}${c.id ? `:${c.id}` : ''}:${c.verdict}`)).toEqual([
    'a:PASS',
    'b:gmail:PASS',
    'b:github:PASS',
    'c:gmail:PASS',
    'd:gmail:PASS',
    'd:github:PASS',
    'e:PASS',
    'f:gmail:PASS'
  ])
  const printed = JSON.stringify(r.checks)
  expect(printed).not.toContain('https://')
  expect(printed).not.toContain('secret payload')
  expect(printed).toContain('gmailmcp.googleapis.com')
})

it("runs the merged check with ask rules for every connected connector, and the ask check as the app's main run is set up", async () => {
  const argsOut = join(await mkdtemp(join(tmpdir(), 'cb-connprobe-args-')), 'args.jsonl')
  dirs.push(join(argsOut, '..'))
  const bin = await fakeClaude([GMAIL, NOTION_AUTH, GITHUB, OTHER], { FAKE_ARGS_OUT: argsOut })
  await probe.probeConnectors({ bin, log: () => {} })
  const calls = (await readFile(argsOut, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])
  const settingsOf = (a: string[]) => JSON.parse(a[a.indexOf('--settings') + 1])
  const merged = calls.map(settingsOf).filter((s) => s.deniedMcpServers && s.permissions)
  expect(merged).toHaveLength(1)
  // Connected catalog connectors only (Notion needs auth), the file deny rule beside them
  expect(merged[0].permissions).toEqual({ ask: ['mcp__claude_ai_Gmail__*', 'mcp__My_GitHub__*'], deny: [RULE] })
  const turn = calls.filter((a) => a.includes('--permission-mode'))
  expect(turn).toHaveLength(1)
  const a = turn[0]
  expect(a[a.indexOf('--permission-mode') + 1]).toBe('auto')
  expect(a[a.indexOf('--permission-prompt-tool') + 1]).toBe('stdio')
  expect(a[a.indexOf('--model') + 1]).toBe('haiku')
  expect(settingsOf(a)).toEqual({ permissions: { ask: ['mcp__claude_ai_Gmail__*'], allow: ['mcp__claude_ai_Gmail__list_labels'] } })
})

it("gives every CLI start one temp root of its own and removes it, so no run leaves folders in the user's temp folder", async () => {
  const tmpOut = join(await mkdtemp(join(tmpdir(), 'cb-connprobe-tmp-')), 'tmp.txt')
  dirs.push(join(tmpOut, '..'))
  const bin = await fakeClaude([GMAIL, NOTION_AUTH, GITHUB, OTHER], { FAKE_TMP_OUT: tmpOut })
  const r = await probe.probeConnectors({ bin, log: () => {} })
  expect(r.verdict).toBe('PASS')
  const roots = (await readFile(tmpOut, 'utf8')).split('\n').slice(0, -1)
  expect(roots.length).toBeGreaterThan(1)
  expect(new Set(roots).size).toBe(1)
  expect(roots[0]).not.toBe('')
  expect(roots[0]).not.toBe(process.env.CLAUDE_CODE_TMPDIR)
  await expect(stat(roots[0])).rejects.toThrow()
})

it('a whole run fails when the CLI drops the merged settings (the vault guard with them)', async () => {
  const bin = await fakeClaude([GMAIL, GITHUB, OTHER], { FAKE_DROP_MERGED: '1' })
  const r = await probe.probeConnectors({ bin, log: () => {} })
  expect(r.verdict).toBe('FAILED')
  expect(r.checks.filter((c) => c.verdict === 'FAILED').map((c) => c.key)).toEqual(['e'])
})

it('a whole run is inconclusive when the effective settings cannot be read', async () => {
  const bin = await fakeClaude([GMAIL, OTHER], { FAKE_NO_SETTINGS: '1' })
  const r = await probe.probeConnectors({ bin, log: () => {} })
  expect(r.verdict).toBe('INCONCLUSIVE')
  expect(r.checks.find((c) => c.key === 'e')).toMatchObject({ verdict: 'INCONCLUSIVE' })
})

it('a whole run is inconclusive with nothing connected and the exit code follows --strict', async () => {
  const bin = await fakeClaude([OTHER])
  const r = await probe.probeConnectors({ bin, log: () => {} })
  expect(r.verdict).toBe('INCONCLUSIVE')
  const code = async (args: string[]) => {
    const e = console.error,
      l = console.log
    console.error = () => {}
    console.log = () => {}
    try {
      return await probe.main(args, async () => r)
    } finally {
      console.error = e
      console.log = l
    }
  }
  expect(await code([])).toBe(0)
  expect(await code(['--strict'])).toBe(2)
})

// ---- the ask check: a read tool still asks under the ask rule, even with an allow rule for it ----
const run = (o: Partial<Parameters<typeof probe.classifyAsk>[0]> = {}) => ({
  version: '9.9.9',
  asked: [] as string[],
  attempted: [] as Array<{ id: string; name: string }>,
  unasked: [] as string[],
  refused: [] as string[],
  result: null,
  error: null,
  ...o
})
const TOOL = 'mcp__claude_ai_Gmail__list_labels'

it('classifies the ask run: a can_use_tool is PASS, a result without one FAILED, anything else INCONCLUSIVE', () => {
  const ask = (o: Parameters<typeof run>[0]) => probe.classifyAsk(run(o), TOOL)
  expect(ask({ asked: [TOOL], attempted: [{ id: 't1', name: TOOL }] })).toMatchObject({ outcome: 'PASS' })
  // A can_use_tool for it wins even when a later result also arrived
  expect(ask({ asked: [TOOL], unasked: ['t2'] })).toMatchObject({ outcome: 'PASS' })
  expect(ask({ attempted: [{ id: 't1', name: TOOL }], unasked: ['t1'] })).toMatchObject({
    outcome: 'FAILED',
    text: expect.stringContaining('ran with no can_use_tool')
  })
  // An error result with no can_use_tool is the CLI refusing the call itself: nothing ran, so it proves nothing either way
  expect(ask({ attempted: [{ id: 't1', name: TOOL }], refused: ['t1'] })).toMatchObject({
    outcome: 'INCONCLUSIVE',
    text: expect.stringContaining('refused by the CLI itself')
  })
  // ... but a call that provably ran unasked still fails, whatever else was refused
  expect(ask({ attempted: [{ id: 't1', name: TOOL }], unasked: ['t1'], refused: ['t2'] })).toMatchObject({ outcome: 'FAILED' })
  // A can_use_tool for another tool proves nothing about this one
  expect(ask({ asked: ['mcp__claude_ai_Gmail__send_message'] })).toMatchObject({ outcome: 'INCONCLUSIVE' })
  expect(ask({ error: 'the run took longer than 180 s' })).toMatchObject({
    outcome: 'INCONCLUSIVE',
    text: expect.stringContaining('longer than')
  })
  expect(ask({ version: null })).toMatchObject({ outcome: 'INCONCLUSIVE', text: expect.stringContaining('no init') })
  expect(ask({ result: { is_error: true, subtype: 'error_during_execution' } })).toMatchObject({
    outcome: 'INCONCLUSIVE',
    text: expect.stringContaining('ended with an error')
  })
  expect(ask({ result: { is_error: false, subtype: 'success' } })).toMatchObject({
    outcome: 'INCONCLUSIVE',
    text: expect.stringContaining('never called')
  })
  expect(ask({ result: { is_error: false, subtype: 'success' }, attempted: [{ id: 't1', name: TOOL }] })).toMatchObject({
    outcome: 'INCONCLUSIVE',
    text: expect.stringContaining('neither asked nor ran')
  })
})

it("picks the ask target: the preferred read tools in order, else any connected connector's first listed read tool", () => {
  const rows = (...r: Array<[string, string, string[]]>) =>
    r.map(([name, url, tools]) => ({ name, status: 'connected', url, id: probe.connectorOf(url, name), tools }))
  const GM = ['claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1'] as const
  const SL = ['claude.ai Slack', 'https://mcp.slack.com/mcp'] as const
  const DR = ['claude.ai Google Drive', 'https://drivemcp.googleapis.com/mcp/v1'] as const
  const GH = ['My GitHub', 'https://api.githubcopilot.com/mcp/'] as const
  expect(probe.pickAskTarget(rows([...GM, ['send_message', 'list_labels']], [...SL, ['slack_search_channels']]))).toEqual({
    id: 'gmail',
    name: 'claude.ai Gmail',
    tool: 'list_labels',
    prefix: 'mcp__claude_ai_Gmail'
  })
  // Gmail lists no preferred read tool: the next preferred connector
  expect(
    probe.pickAskTarget(rows([...GM, ['send_message']], [...DR, ['list_recent_files']], [...SL, ['slack_search_channels']]))?.tool
  ).toBe('slack_search_channels')
  expect(probe.pickAskTarget(rows([...DR, ['list_recent_files']]))?.tool).toBe('list_recent_files')
  // None preferred: a read tool the catalog knows (never a write), by the CLI's own listing
  expect(probe.pickAskTarget(rows([...GM, ['send_message', 'get_thread']], [...GH, ['create_branch', 'get_me']]))).toMatchObject({
    id: 'gmail',
    tool: 'get_thread'
  })
  expect(probe.pickAskTarget(rows([...GM, ['send_message', 'brand_new']]))).toBeNull()
  // Not connected, not in the catalog or no tools: no target
  expect(
    probe.pickAskTarget([{ name: 'claude.ai Gmail', status: 'needs-auth', url: GM[1], id: 'gmail', tools: ['list_labels'] }])
  ).toBeNull()
  expect(probe.pickAskTarget(rows(['plain', 'https://example.invalid/mcp', ['list_labels']]))).toBeNull()
})

it(
  'a whole run: the ask check fails when the tool runs with no can_use_tool, and is inconclusive after one retry otherwise',
  async () => {
    for (const [mode, verdict] of [
      ['unasked', 'FAILED'],
      ['refused', 'INCONCLUSIVE'],
      ['never', 'INCONCLUSIVE'],
      ['auth', 'INCONCLUSIVE']
    ] as const) {
      const bin = await fakeClaude([GMAIL, GITHUB, OTHER], { FAKE_ASK: mode })
      const r = await probe.probeConnectors({ bin, log: () => {} })
      expect(
        r.checks.find((c) => c.key === 'f'),
        mode
      ).toMatchObject({ id: 'gmail', verdict })
      expect(r.verdict, mode).toBe(verdict)
    }
    // Four whole runs.
  },
  process.platform === 'win32' ? 90_000 : undefined
)

it("the ask check is inconclusive when no connected connector lists a read tool, and prints neither the tool's payload nor a URL", async () => {
  const bin = await fakeClaude([server('claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1', 'connected', ['send_message']), OTHER])
  const r = await probe.probeConnectors({ bin, log: () => {} })
  expect(r.checks.find((c) => c.key === 'f')).toMatchObject({ verdict: 'INCONCLUSIVE', text: expect.stringContaining('read tool') })
  expect(JSON.stringify(r.checks)).not.toContain('https://')
})
