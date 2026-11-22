import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ASK_SERVER, ASK_SIDE_NAME } from '@zumibot/shared/agentAsk'
import { AskIpcClient } from './askIpc'
import { askTools, parseAskCall, parseSideCall } from './askTools'

/** Only this child entry imports the SDK. It holds one capability and can name no chat of its own. */
async function main(): Promise<void> {
  const token = process.env.ZUMIBOT_ASKS_CAPABILITY,
    path = process.env.ZUMIBOT_ASKS_IPC
  // Keep the capability and Electron child mode out of any descendants.
  delete process.env.ZUMIBOT_ASKS_CAPABILITY
  delete process.env.ZUMIBOT_ASKS_IPC
  delete process.env.ELECTRON_RUN_AS_NODE
  if (!token || !path) throw new Error('Agents unavailable')
  const ipc = await AskIpcClient.connect(path, token)
  const server = new Server({ name: ASK_SERVER, version: '1.0.0' }, { capabilities: { tools: {} } })
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: askTools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const { name } = request.params,
        args = request.params.arguments ?? {}
      // The SDK's signal fires when the CLI cancels the call; the IPC passes that on to the asked agent.
      const text =
        name === ASK_SIDE_NAME
          ? await ipc.side(parseSideCall(name, args), extra.signal)
          : await ipc.run(parseAskCall(name, args), extra.signal)
      return { content: [{ type: 'text' as const, text }] }
    } catch (error) {
      // The messages are the service's plain sentences or ours; never an I/O detail (the IPC filters those).
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Agents unavailable' }] }
    }
  })
  await server.connect(new StdioServerTransport())
}
void main().catch(() => {
  process.stderr.write('Agents unavailable\n')
  process.exitCode = 1
})
