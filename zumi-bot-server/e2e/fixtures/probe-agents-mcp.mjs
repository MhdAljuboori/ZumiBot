// Tiny stdio MCP server for sideAskProbe.mjs, configured under the app's server name `zumibot_agents`, with the two tools
// the real bridge has: `side_question` and `ask`. Each call that runs writes its own marker file in the server's cwd (the
// probe's temp dir), so the probe sees what really ran, whatever the guard hook and the permission answers did.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

const schema = {
  type: 'object',
  properties: { agent: { type: 'string' }, message: { type: 'string' } },
  required: ['agent', 'message'],
  additionalProperties: false
}
const TOOLS = [
  { name: 'side_question', description: 'Asks another agent a question without changing anything.', inputSchema: schema },
  { name: 'ask', description: 'Asks another agent to do work.', inputSchema: schema }
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
          serverInfo: { name: 'zumibot_agents', version: '1.0.0' }
        }
      })
    case 'ping':
      return send({ id: m.id, result: {} })
    case 'tools/list':
      return send({ id: m.id, result: { tools: TOOLS } })
    case 'tools/call': {
      const name = m.params?.name
      if (!TOOLS.some((t) => t.name === name)) return send({ id: m.id, error: { code: -32602, message: 'Unknown tool' } })
      writeFileSync(name === 'side_question' ? 'marker-side.txt' : 'marker-ask.txt', 'ran\n')
      return send({ id: m.id, result: { content: [{ type: 'text', text: 'Noted.' }] } })
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
// The CLI closes our stdin when it exits; leave no orphan behind.
rl.on('close', () => process.exit(0))
