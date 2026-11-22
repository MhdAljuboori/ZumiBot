#!/usr/bin/env node
// A deterministic Claude stand-in for the computer use e2e. It launches the ACTUAL injected desktop
// MCP bridge and plays the CLI's part of "actions always ask": an action tool (or a step marked
// `ask: true`) first sends a can_use_tool control_request and runs only on allow, as the `--settings`
// ask rules make the real CLI do. No model, quota or personal HOME is used.
//
// The first stdin line carries DESKTOP_SCENARIO:<base64 JSON> {log, desktop?, steps}. Steps:
//   {tool: 'desktop_click', args, save?, ask?}  args may hold {$stamp: '<saved name>'}
//   {wait: '<file>'}                             blocks until the file exists
// Each saved result, denial and the argv check is appended to `log` as a JSON line, tagged with the agent.
// `desktop: false` asserts this run got no desktop server at all and logs `argv`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, appendFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { DESKTOP_ACTIONS as ACTIONS, PROCESS_START } from './fake-desktop-actions.mjs'

const SERVER = 'zumibot_desktop'
const argv = process.argv.slice(2)
// Both spellings the CLI takes: `--name value` from the CLI runner, `--name=value` from the Agent SDK adapter.
const agent = argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length)
  ?? (argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : undefined) ?? null
const emit = message => process.stdout.write(JSON.stringify(message) + '\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// `plugin list --json`, which Agent Studio's loadout card asks for every Claude agent: a CLI with no plugins. Its stdin is
// closed, so waiting for a first line below would end in exit 13, which the server logs as an error.
if (argv[0] === 'plugin' && argv[1] === 'list') {
  process.stdout.write('[]\n')
  process.exit(0)
}

// Every stdin line after the first is a control_response; one reader serves both.
let buffered = '', first
const firstLine = new Promise(resolve => { first = resolve })
const answers = new Map(), waiters = new Map()
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  for (let i; (i = buffered.indexOf('\n')) >= 0;) {
    const line = buffered.slice(0, i); buffered = buffered.slice(i + 1)
    if (!line) continue
    if (first) { const f = first; first = null; f(line); continue }
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m?.type !== 'control_response') continue
    const id = m.response?.request_id
    answers.set(id, m.response)
    waiters.get(id)?.(m.response)
  }
})
const answerOf = id => answers.has(id) ? Promise.resolve(answers.get(id)) : new Promise(resolve => waiters.set(id, resolve))

/** Every `--flag value` pair of one flag, in order. */
const values = flag => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []))

if (argv.includes('--json-schema')) {
  // A room's moderator: nobody else speaks; members run only for their mentions.
  process.stdin.resume()
  process.stdin.on('end', () => { console.log(JSON.stringify({ structured_output: { next: [], drop: [], skip: [], askUser: false } })); process.exit(0) })
} else {
  let bridge
  let log = null
  try {
    // unref'd: the timer must not hold the finished process open.
    const line = await Promise.race([firstLine, new Promise((_, reject) => setTimeout(() => reject(Error('No stream-json input')), 10000).unref())])
    const match = /DESKTOP_SCENARIO:([A-Za-z0-9+/=]+)/.exec(line)
    if (!match) throw Error('Missing desktop fixture scenario')
    const plan = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
    log = plan.log
    const record = entry => appendFile(plan.log, JSON.stringify({ agent, time: Date.now(), ...entry }) + '\n')
    const servers = values('--mcp-config').map(v => JSON.parse(v).mcpServers ?? {})
    const desktopServer = servers.find(s => s[SERVER])?.[SERVER]
    const session = randomUUID()
    emit({ type: 'system', subtype: 'init', session_id: session })
    const finish = text => {
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
      emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
      emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: session, result: text, total_cost_usd: 0, permission_denials: [] })
    }
    if (plan.desktop === false) {
      // Never record argv values: they hold the browser capability's config.
      assert.equal(argv.some(a => a.includes(SERVER)), false, 'an agent without computer use got the desktop server')
      assert.equal(process.env.ZUMIBOT_DESKTOP_CAPABILITY, undefined)
      // A plain agent's one --settings holds the pause hook and the process start ask rule every main run gets, no desktop
      // ask rule. The rules are tool names only, safe to record.
      await record({ name: 'argv', servers: servers.flatMap(s => Object.keys(s)), settings: values('--settings').length,
        ask: values('--settings').flatMap(s => JSON.parse(s).permissions?.ask ?? []), desktopEnv: false })
      finish('Desktop fixture complete.')
    } else {
      assert.ok(desktopServer, 'CLI must receive the zumibot_desktop MCP server')
      const settings = values('--settings')
      assert.equal(settings.length, 1, 'exactly one --settings')
      assert.deepEqual([...JSON.parse(settings[0]).permissions.ask].sort(), [...ACTIONS.map(t => `mcp__${SERVER}__${t}`), PROCESS_START].sort())
      assert.equal(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
      assert.equal(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, '0')
      assert.equal(desktopServer.timeout, 86400000)
      assert.equal(process.env.ZUMIBOT_LOCAL_SECRET, undefined)
      const env = { ...process.env }
      for (const [key, value] of Object.entries(desktopServer.env)) env[key] = value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
      bridge = spawn(desktopServer.command, desktopServer.args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
      // Deliberately never record args, capability, IPC path or inherited environment.
      const pending = new Map()
      let id = 0, out = ''
      bridge.stdout.setEncoding('utf8').on('data', chunk => {
        out += chunk
        for (let i; (i = out.indexOf('\n')) >= 0;) {
          const raw = out.slice(0, i); out = out.slice(i + 1)
          const message = JSON.parse(raw), waiter = pending.get(message.id)
          if (!waiter) continue
          pending.delete(message.id)
          message.error ? waiter.reject(Error('MCP rejected fixture request')) : waiter.resolve(message.result)
        }
      })
      bridge.on('exit', () => { for (const waiter of pending.values()) waiter.reject(Error('MCP bridge exited')); pending.clear() })
      const request = (method, params) => new Promise((resolve, reject) => {
        const next = ++id; pending.set(next, { resolve, reject })
        bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
      })
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-desktop-claude', version: '1' } })
      bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      const tools = await request('tools/list', {})
      assert.equal(tools.tools.length, 15)
      const saved = {}
      const resolve = value => {
        if (Array.isArray(value)) return value.map(resolve)
        if (value && typeof value === 'object') {
          if (value.$stamp) { assert.ok(saved[value.$stamp]?.stamp, `No stamp saved as ${value.$stamp}`); return saved[value.$stamp].stamp }
          return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]))
        }
        return value
      }
      // The CLI's own transcript lines, so the chat gets tool rows and their results as with the real CLI.
      const toolUse = (useId, name, input) => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: useId, name, input }] } })
      const toolResult = (useId, content, isError) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content, is_error: isError }] } })
      for (const step of plan.steps) {
        if (step.wait) {
          const end = Date.now() + 60000
          while (!(await access(step.wait).then(() => true, () => false))) {
            if (Date.now() > end) throw Error('Fixture gate timed out')
            await sleep(25)
          }
          continue
        }
        const name = `mcp__${SERVER}__${step.tool}`, useId = `toolu_${randomUUID().replace(/-/g, '')}`
        let input = resolve(step.args ?? {})
        toolUse(useId, name, input)
        if (ACTIONS.includes(step.tool) || step.ask) {
          const requestId = randomUUID()
          emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, input, description: null, decision_reason: 'Ask rule', tool_use_id: useId } })
          const answer = await answerOf(requestId)
          const decision = answer?.response
          if (answer?.subtype !== 'success' || decision?.behavior !== 'allow') {
            await record({ name: step.save ?? step.tool, denied: true })
            toolResult(useId, decision?.message ?? 'Denied', true)
            continue
          }
          input = decision.updatedInput ?? input
        }
        const result = await request('tools/call', { name: step.tool, arguments: input })
        const text = result.content.find(c => c.type === 'text')?.text ?? 'null'
        const value = JSON.parse(text)
        // The CLI hands an MCP image to the model as an image block, so the chat sees one too.
        toolResult(useId, result.content.map(c => c.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } } : c), result.isError === true)
        if (step.save) { saved[step.save] = value; await record({ name: step.save, result: value, isError: result.isError === true, image: result.content.some(c => c.type === 'image') }) }
      }
      finish('Desktop fixture complete.')
    }
  } catch (error) {
    process.stderr.write(`Desktop fixture failed: ${error.message}\n`)
    if (log) await appendFile(log, JSON.stringify({ agent, name: 'fixture-error', message: error.message }) + '\n').catch(() => {})
    process.exitCode = 1
  } finally {
    if (bridge && bridge.exitCode === null) { bridge.stdin.end(); bridge.kill('SIGTERM') }
    process.stdin.destroy()
  }
}
