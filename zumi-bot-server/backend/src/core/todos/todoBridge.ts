import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TodoIpcClient } from './todoIpc'
import { parseTodoCall, todoTools } from './todoTools'

/** Only this child entry imports the SDK. It holds one capability and can name no chat of its own. */
async function main(): Promise<void> {
  const token = process.env.ZUMIBOT_TODOS_CAPABILITY,
    path = process.env.ZUMIBOT_TODOS_IPC
  // Keep the capability and Electron child mode out of any descendants.
  delete process.env.ZUMIBOT_TODOS_CAPABILITY
  delete process.env.ZUMIBOT_TODOS_IPC
  delete process.env.ELECTRON_RUN_AS_NODE
  if (!token || !path) throw new Error('To-do list unavailable')
  const ipc = await TodoIpcClient.connect(path, token)
  const server = new Server({ name: 'zumibot_todos', version: '1.0.0' }, { capabilities: { tools: {} } })
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: todoTools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const call = parseTodoCall(request.params.name, request.params.arguments ?? {})
      return { content: [{ type: 'text' as const, text: await ipc.run(call) }] }
    } catch (error) {
      // The messages are the service's plain sentences or ours; never an I/O detail (the IPC filters those).
      return {
        isError: true,
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'To-do list unavailable' }]
      }
    }
  })
  await server.connect(new StdioServerTransport())
}
void main().catch(() => {
  process.stderr.write('To-do list unavailable\n')
  process.exitCode = 1
})
