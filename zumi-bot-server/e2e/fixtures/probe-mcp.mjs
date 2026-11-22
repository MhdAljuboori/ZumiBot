// Tiny stdio MCP server for btwProbe.mjs: one tool, touch_marker, that writes marker.txt in its cwd.
// If marker.txt ever appears, an MCP tool ran in a side answer, which the guard must make impossible.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

const TOOL = {
  name: 'touch_marker',
  description: 'Writes marker.txt in the working folder.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
}

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
          serverInfo: { name: 'probe', version: '1.0.0' }
        }
      })
    case 'ping':
      return send({ id: m.id, result: {} })
    case 'tools/list':
      return send({ id: m.id, result: { tools: [TOOL] } })
    case 'tools/call':
      if (m.params?.name !== 'touch_marker') return send({ id: m.id, error: { code: -32602, message: 'Unknown tool' } })
      writeFileSync(join(process.cwd(), 'marker.txt'), 'touched\n')
      return send({ id: m.id, result: { content: [{ type: 'text', text: 'marker.txt written' }] } })
    default:
      return send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
// The CLI closes our stdin when it exits; leave no orphan behind.
rl.on('close', () => process.exit(0))
