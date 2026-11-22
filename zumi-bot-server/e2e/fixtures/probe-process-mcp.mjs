// Tiny stdio MCP server for processAskProbe.mjs, configured under the app's server name `zumibot_processes`, with the
// one tool that runs something (start) and one that only reads (list), named like the real ones. Nothing is started: every
// call that runs appends {tool} to $PROBE_DIR/calls.jsonl, so the probe sees what ran, asked or not.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

const TOOLS = [
  {
    name: 'start',
    description: 'Start a command that keeps running after your reply, in the chat folder. The user approves the exact command first.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, name: { type: 'string' } },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    name: 'list',
    description: "List this chat's processes. Reads only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id === undefined || m.id === null) return // notifications need no answer
  switch (m.method) {
    case 'initialize':
      return send({
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'zumibot_processes', version: '1.0.0' }
        }
      })
    case 'ping':
      return send({ id: m.id, result: {} })
    case 'tools/list':
      return send({ id: m.id, result: { tools: TOOLS } })
    case 'tools/call': {
      const name = m.params?.name
      if (!TOOLS.some((t) => t.name === name)) return send({ id: m.id, error: { code: -32602, message: 'Unknown tool' } })
      if (process.env.PROBE_DIR) appendFileSync(join(process.env.PROBE_DIR, 'calls.jsonl'), JSON.stringify({ tool: name }) + '\n')
      return send({
        id: m.id,
        result: { content: [{ type: 'text', text: name === 'start' ? 'Started "probe" (p_0123456789).' : 'No processes in this chat.' }] }
      })
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
// The CLI closes our stdin when it exits; leave no orphan behind.
rl.on('close', () => process.exit(0))
