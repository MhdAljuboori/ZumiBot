#!/usr/bin/env node
// A deterministic Claude stand-in for background processes. It launches the ACTUAL injected zumibot_processes bridge and
// plays the CLI's part of the `start` ask rule: a start first sends a can_use_tool control_request and runs only on allow, as
// the one merged --settings makes the real CLI do. Every other process tool runs straight away (the server answers their
// permission requests itself when asked, but the CLI does not ask for them). No model, quota or personal HOME is used.
//
// The user message carries PROCESS_SCENARIO:<base64 JSON> {log, steps}. Steps:
//   {tool: 'start' | 'list' | 'logs' | 'wait' | 'stop', args, save?}   args may hold {$id: '<saved name>'} for a process id
//   {argv: true}                                                         records which servers and ask rules the run got
// Saved results, denials and errors are appended to `log` as JSON lines. A process id a start returned is saved under
// `save` in the log, and a later step's {$id} reads it back from there (each turn is its own process).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const SERVER = 'zumibot_processes'
const argv = process.argv.slice(2)
const emit = message => process.stdout.write(JSON.stringify(message) + '\n')
const values = flag => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []))

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

if (argv.includes('--json-schema')) {
  process.stdin.resume()
  process.stdin.on('end', () => { console.log(JSON.stringify({ structured_output: { next: [], drop: [], skip: [], askUser: false } })); process.exit(0) })
} else {
  let bridge, log = null
  const session = randomUUID()
  const finish = text => {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: session, result: text, total_cost_usd: 0, permission_denials: [] })
  }
  try {
    const line = await Promise.race([firstLine, new Promise((_, reject) => setTimeout(() => reject(Error('No stream-json input')), 10000).unref())])
    emit({ type: 'system', subtype: 'init', session_id: session })
    const match = /PROCESS_SCENARIO:([A-Za-z0-9+/=]+)/.exec(line)
    if (!match) { finish('No scenario.'); process.exit(0) }
    const plan = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
    log = plan.log
    const record = entry => appendFile(plan.log, JSON.stringify({ time: Date.now(), ...entry }) + '\n')
    const recorded = async () => (await readFile(plan.log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l))
    const servers = values('--mcp-config').map(v => JSON.parse(v).mcpServers ?? {})
    const server = servers.find(s => s[SERVER])?.[SERVER]
    const asks = values('--settings').flatMap(s => JSON.parse(s).permissions?.ask ?? [])
    // The CLI must not run background tasks of its own, whatever the process tools do.
    assert.equal(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
    for (const step of plan.steps) {
      if (step.argv) {
        await record({ name: 'argv', servers: servers.flatMap(s => Object.keys(s)), settings: values('--settings').length, asks, timeout: server?.timeout ?? null })
        continue
      }
      assert.ok(server, 'CLI must receive the zumibot_processes MCP server')
      if (!bridge) {
        const env = { ...process.env }
        for (const [key, value] of Object.entries(server.env)) env[key] = value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
        bridge = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
        bridge.pending = new Map(); bridge.next = 0
        let out = ''
        bridge.stdout.setEncoding('utf8').on('data', chunk => {
          out += chunk
          for (let i; (i = out.indexOf('\n')) >= 0;) {
            const raw = out.slice(0, i); out = out.slice(i + 1)
            const message = JSON.parse(raw), waiter = bridge.pending.get(message.id)
            if (!waiter) continue
            bridge.pending.delete(message.id)
            message.error ? waiter.reject(Error('MCP rejected fixture request')) : waiter.resolve(message.result)
          }
        })
        bridge.request = (method, params) => new Promise((resolve, reject) => {
          const n = ++bridge.next; bridge.pending.set(n, { resolve, reject })
          bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
        })
        await bridge.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-process-claude', version: '1' } })
        bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
        assert.deepEqual((await bridge.request('tools/list', {})).tools.map(t => t.name).sort(), ['list', 'logs', 'start', 'stop', 'wait'])
      }
      const saved = await recorded()
      const resolve = value => {
        if (Array.isArray(value)) return value.map(resolve)
        if (value && typeof value === 'object') {
          if (value.$id) { const hit = saved.find(e => e.name === value.$id && e.id); assert.ok(hit, `No id saved as ${value.$id}`); return hit.id }
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]))
        }
        return value
      }
      const name = `mcp__${SERVER}__${step.tool}`, useId = `toolu_${randomUUID().replace(/-/g, '')}`
      let input = resolve(step.args ?? {})
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: useId, name, input }] } })
      if (asks.includes(name)) {
        const requestId = randomUUID()
        emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, input, description: null, decision_reason: 'Ask rule', tool_use_id: useId } })
        const answer = await answerOf(requestId)
        const decision = answer?.response
        if (answer?.subtype !== 'success' || decision?.behavior !== 'allow') {
          await record({ name: step.save ?? step.tool, denied: true, message: decision?.message ?? null })
          emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: decision?.message ?? 'Denied', is_error: true }] } })
          continue
        }
        input = decision.updatedInput ?? input
      }
      const result = await bridge.request('tools/call', { name: step.tool, arguments: input })
      const text = result.content.find(c => c.type === 'text')?.text ?? ''
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: text, is_error: result.isError === true }] } })
      const id = /\((p_[0-9a-f]{10})\)/.exec(text)?.[1]
      await record({ name: step.save ?? step.tool, text, isError: result.isError === true, ...(step.tool === 'start' && id ? { id } : {}) })
    }
    finish('Process fixture complete.')
  } catch (error) {
    process.stderr.write(`Process fixture failed: ${error.message}\n`)
    if (log) await appendFile(log, JSON.stringify({ name: 'fixture-error', message: error.message }) + '\n').catch(() => {})
    finish('Process fixture failed.')
  } finally {
    if (bridge && bridge.exitCode === null) { bridge.stdin.end(); bridge.kill('SIGTERM') }
    process.stdin.destroy()
  }
}
