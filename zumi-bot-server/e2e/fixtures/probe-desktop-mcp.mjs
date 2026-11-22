// Tiny stdio MCP server for desktopAskProbe.mjs, configured under the app's server name `zumibot_desktop`, with
// one action tool (desktop_click) and one looking tool (desktop_screenshot) named like the real ones. Every call
// that runs appends {tool} to $PROBE_DIR/calls.jsonl, so the probe sees what ran, asked or not.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

const TOOLS = [
  {
    name: 'desktop_screenshot',
    description: 'Takes a screenshot of the desktop. Looks only; changes nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'desktop_click',
    description: 'Clicks the desktop at screen pixel x, y.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
      additionalProperties: false
    }
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
          serverInfo: { name: 'zumibot_desktop', version: '1.0.0' }
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
        result: { content: [{ type: 'text', text: name === 'desktop_click' ? 'Clicked.' : 'A plain grey desktop, 1280x800.' }] }
      })
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
// The CLI closes our stdin when it exits; leave no orphan behind.
rl.on('close', () => process.exit(0))
