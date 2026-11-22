import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AUTOMATIONS_SERVER } from '@zumibot/shared/automations'
import { AutomationIpcClient } from './automationIpc'
import { automationTools, parseAutomationCall } from './automationTools'

/** Only this child entry imports the SDK. It holds one capability and can name no chat of its own. */
async function main(): Promise<void> {
  const token = process.env.ZUMIBOT_AUTOMATIONS_CAPABILITY,
    path = process.env.ZUMIBOT_AUTOMATIONS_IPC
  // Keep the capability and Electron child mode out of any descendants.
  delete process.env.ZUMIBOT_AUTOMATIONS_CAPABILITY
  delete process.env.ZUMIBOT_AUTOMATIONS_IPC
  delete process.env.ELECTRON_RUN_AS_NODE
  if (!token || !path) throw new Error('Routines and workflows unavailable')
  const ipc = await AutomationIpcClient.connect(path, token)
  const server = new Server({ name: AUTOMATIONS_SERVER, version: '1.0.0' }, { capabilities: { tools: {} } })
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    ipc.close()
    void server.close()
    process.stdin.pause()
  }
  server.onclose = shutdown
  process.stdin.once('end', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: automationTools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const call = parseAutomationCall(request.params.name, request.params.arguments ?? {})
      return { content: [{ type: 'text' as const, text: await ipc.run(call) }] }
    } catch (error) {
      // The messages are the service's plain sentences or ours; never an I/O detail (the IPC filters those).
      return {
        isError: true,
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Routines and workflows unavailable' }]
      }
    }
  })
  await server.connect(new StdioServerTransport())
}
void main().catch(() => {
  process.stderr.write('Routines and workflows unavailable\n')
  process.exitCode = 1
})
