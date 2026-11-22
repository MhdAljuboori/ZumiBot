#!/usr/bin/env node
// A deterministic Claude stand-in. It launches the ACTUAL injected MCP bridge;
// no SDK mock, Claude binary, paid prompt, personal HOME or external site is used.
// Scenario steps: {tool, args, save, server?} calls an MCP tool (server defaults to zumibot_browser; zumibot_vault
// for vault_items); {wait: path} waits for a gate file; {parallel: [...]}; {bash: {env}} emits a Bash tool call whose
// result is the value of that env var, as the CLI would show `printenv`; {say: {env}} emits assistant text holding it,
// split across two deltas; {fail: {env}} ends the run with that value in stderr.
// Plan options: rows (emit every MCP call as tool_use/tool_result lines), results (append every MCP result received).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'

const argv = process.argv.slice(2), input = createInterface({ input: process.stdin })
// Groups run a separate JSON moderator invocation through the same configured CLI.
if (argv.includes('--json-schema')) {
  process.stdin.resume()
  input.on('close', () => { console.log(JSON.stringify({ structured_output: { next: [], drop: [], skip: [], askUser: false } })); process.exit(0) })
} else {
  const bridges = new Map()
  try {
    const [line] = await Promise.race([
      new Promise(resolve => input.once('line', value => resolve([value]))),
      new Promise((_, reject) => setTimeout(() => reject(Error('No stream-json input')), 10000).unref())
    ])
    const match = /BROWSER_SCENARIO:([A-Za-z0-9+/=]+)/.exec(line)
    if (!match) throw Error('Missing browser fixture scenario')
    const plan = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
    // Each injected server comes in its own --mcp-config; the browser's is the first.
    const configs = argv.flatMap((arg, i) => arg === '--mcp-config' ? [JSON.parse(argv[i + 1]).mcpServers] : [])
    assert.ok(configs.length > 0, 'CLI must receive MCP configuration')
    const serverOf = name => configs.find(c => c[name])?.[name]
    const server = configs[0].zumibot_browser
    assert.ok(server, 'zumibot_browser comes first')
    assert.ok(argv.includes('--no-chrome'))
    assert.equal(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
    assert.equal(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, '0')
    assert.equal(server.timeout, 86400000)
    assert.equal(process.env.ZUMIBOT_LOCAL_SECRET, undefined)
    const connect = async (name, config) => {
      const env = { ...process.env }
      for (const [key, value] of Object.entries(config.env ?? {})) env[key] = value.replace(/\$\{([^}]+)\}/g, (_, n) => process.env[n] ?? '')
      const child = spawn(config.command, config.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      // Deliberately never record args, capability, IPC path or inherited environment.
      const pending = new Map(), output = createInterface({ input: child.stdout })
      let id = 0
      output.on('line', raw => {
        const message = JSON.parse(raw), waiter = pending.get(message.id)
        if (!waiter) return
        pending.delete(message.id)
        message.error ? waiter.reject(Error('MCP rejected fixture request')) : waiter.resolve(message.result)
      })
      child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(Error('MCP bridge exited')); pending.clear() })
      const request = (method, params) => new Promise((resolve, reject) => {
        const next = ++id; pending.set(next, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
      })
      const bridge = { child, request }
      bridges.set(name, bridge)
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-browser-claude', version: '1' } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      bridge.tools = (await request('tools/list', {})).tools
      return bridge
    }
    const browser = await connect('zumibot_browser', server)
    assert.ok(browser.tools.some(t => t.name === 'browser_observe'))
    const bridgeOf = async name => {
      if (bridges.has(name)) return bridges.get(name)
      const config = serverOf(name)
      assert.ok(config, `CLI must receive the ${name} server`)
      return connect(name, config)
    }
    const saved = {}, session = randomUUID()
    const emit = message => process.stdout.write(JSON.stringify(message) + '\n')
    emit({ type: 'system', subtype: 'init', session_id: session })
    // A tool row as the CLI writes it: the assistant's tool_use, then the user's tool_result.
    const toolRow = (name, toolInput, content, extra = {}) => {
      const id = `toolu_${randomUUID().replaceAll('-', '')}`
      emit({ type: 'assistant', message: { id: `msg_${randomUUID().replaceAll('-', '')}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: toolInput }] }, parent_tool_use_id: null, session_id: session })
      return () => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: null, session_id: session, ...extra })
    }
    const hash = value => createHash('sha256').update(value).digest('hex')
    const resolve = value => {
      if (Array.isArray(value)) return value.map(resolve)
      if (value && typeof value === 'object') {
        if (value.$stamp) return saved[value.$stamp].data.stamp
        if (value.$ref) {
          const element = saved[value.$ref.observation].data.elements.find(e => e.name === value.$ref.name)
          assert.ok(element, `Missing fixture reference ${value.$ref.name}`); return element.ref
        }
        if (value.$item) {
          const item = saved[value.$item.list].find(i => i.name === value.$item.name)
          assert.ok(item, `Missing vault item ${value.$item.name}`); return item.id
        }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]))
      }
      return value
    }
    const runStep = async step => {
      if (step.parallel) { await Promise.all(step.parallel.map(runStep)); return }
      if (step.wait) {
        const end = Date.now() + 25000
        while (!(await access(step.wait).then(() => true, () => false))) {
          if (Date.now() > end) throw Error('Fixture gate timed out')
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return
      }
      if (step.bash) {
        const value = process.env[step.bash.env] ?? ''
        toolRow('Bash', { command: `printenv ${step.bash.env}`, description: 'Read a variable' }, value,
          { tool_use_result: { stdout: value, stderr: '', interrupted: false, isImage: false } })()
        // The log holds a hash, never the value: the suite compares it with the one it saved.
        if (step.save) await appendFile(plan.log, JSON.stringify({ name: step.save, time: Date.now(), result: { present: step.bash.env in process.env, sha256: hash(value), length: value.length } }) + '\n')
        return
      }
      if (step.say) {
        const text = `The value is ${process.env[step.say.env] ?? ''}.`, cut = Math.floor(text.length / 2) + 7
        for (const part of [text.slice(0, cut), text.slice(cut)]) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } }, session_id: session })
        emit({ type: 'assistant', message: { id: `msg_${randomUUID().replaceAll('-', '')}`, role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session })
        return
      }
      if (step.fail) throw Error(`fixture stops with ${process.env[step.fail.env] ?? ''}`)
      const name = step.server ?? 'zumibot_browser', bridge = await bridgeOf(name), args = resolve(step.args ?? {})
      const finish = plan.rows ? toolRow(`mcp__${name}__${step.tool}`, args) : null
      const result = await bridge.request('tools/call', { name: step.tool, arguments: args })
      const text = result.content.find(c => c.type === 'text')?.text, image = result.content.find(c => c.type === 'image')
      // A screenshot answers with an image only; what it was is enough here. A vault refusal is a plain sentence.
      const parse = t => { try { return JSON.parse(t) } catch { return { ok: false, message: t } } }
      const value = text !== undefined ? parse(text) : { ok: true, image: { mimeType: image?.mimeType, length: image?.data?.length ?? 0 } }
      if (plan.results) await appendFile(plan.results, JSON.stringify({ server: name, tool: step.tool, text: text ?? null, image: !!image }) + '\n')
      finish?.(text !== undefined ? [{ type: 'text', text }] : [{ type: 'text', text: '[image]' }])
      if (step.save) { saved[step.save] = value; await appendFile(plan.log, JSON.stringify({ name: step.save, time: Date.now(), result: value }) + '\n') }
    }
    for (const step of plan.steps) await runStep(step)
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Browser fixture complete.' } } })
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Browser fixture complete.' }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: session, result: 'Browser fixture complete.', total_cost_usd: 0, permission_denials: [] })
  } catch (error) { process.stderr.write(`Browser fixture failed: ${error.message}\n`); process.exitCode = 1 }
  finally {
    for (const { child } of bridges.values()) if (child.exitCode === null) { child.stdin.end(); child.kill('SIGTERM') }
    input.close(); process.stdin.destroy()
  }
}
