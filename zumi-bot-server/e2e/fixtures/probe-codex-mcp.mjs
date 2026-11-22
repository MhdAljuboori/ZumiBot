// Tiny stdio MCP server for codexProbe.mjs check 5, configured as `mcp_servers.probe` with one tool, `probe_echo {text}`.
// A call that runs writes marker-mcp.txt in the server's cwd: the text, then the value of env PROBE_TOKEN (which only
// arrives when the CLI forwards it through `env_vars`), so the probe sees what really ran and what env the server got.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

const TOOLS = [
  {
    name: 'probe_echo',
    description: 'Echoes the text back. Use it when asked to call probe_echo.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
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
          serverInfo: { name: 'probe', version: '1.0.0' }
        }
      })
    case 'ping':
      return send({ id: m.id, result: {} })
    case 'tools/list':
      return send({ id: m.id, result: { tools: TOOLS } })
    case 'tools/call': {
      if (m.params?.name !== 'probe_echo') return send({ id: m.id, error: { code: -32602, message: 'Unknown tool' } })
      const text = String(m.params?.arguments?.text ?? '')
      writeFileSync('marker-mcp.txt', `${text}\n${process.env.PROBE_TOKEN ?? ''}\n`)
      return send({ id: m.id, result: { content: [{ type: 'text', text: `echo: ${text}` }] } })
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
// The CLI closes our stdin when it exits; leave no orphan behind.
rl.on('close', () => process.exit(0))
