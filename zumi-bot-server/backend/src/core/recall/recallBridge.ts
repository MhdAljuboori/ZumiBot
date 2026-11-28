import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { RECALL_SERVER } from '@zumibot/shared/recall'
import { RecallIpcClient } from './recallIpc'
import { parseRecallCall, recallTools } from './recallTools'

/** Only this child entry imports the SDK. It holds one capability and can name no chat or agent of its own. */
async function main(): Promise<void> {
  const token = process.env.ZUMIBOT_RECALL_CAPABILITY,
    path = process.env.ZUMIBOT_RECALL_IPC
  // Keep the capability and Electron child mode out of any descendants.
  delete process.env.ZUMIBOT_RECALL_CAPABILITY
  delete process.env.ZUMIBOT_RECALL_IPC
  delete process.env.ELECTRON_RUN_AS_NODE
  if (!token || !path) throw new Error('Recall unavailable')
  const ipc = await RecallIpcClient.connect(path, token)
  const server = new Server({ name: RECALL_SERVER, version: '1.0.0' }, { capabilities: { tools: {} } })
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: recallTools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const call = parseRecallCall(request.params.name, request.params.arguments ?? {})
      return { content: [{ type: 'text' as const, text: await ipc.run(call) }] }
    } catch (error) {
      // The messages are the service's plain sentences or ours; never an I/O detail (the IPC filters those).
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Recall unavailable' }] }
    }
  })
  await server.connect(new StdioServerTransport())
}
void main().catch(() => {
  process.stderr.write('Recall unavailable\n')
  process.exitCode = 1
})
