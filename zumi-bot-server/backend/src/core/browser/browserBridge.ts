import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BoundedStdioTransport } from '../ipc/stdioTransport'
import { BrowserIpcClient } from './browserIpc'
import { browserTools, browserToolCommand, browserToolResult } from './browserTools'

/** Only this child entry imports the SDK. Discovery never requests a browser. */
async function main(): Promise<void> {
  const token = process.env.ZUMIBOT_BROWSER_CAPABILITY,
    path = process.env.ZUMIBOT_BROWSER_IPC
  // Keep capability and Electron child mode out of any descendants.
  delete process.env.ZUMIBOT_BROWSER_CAPABILITY
  delete process.env.ZUMIBOT_BROWSER_IPC
  delete process.env.ELECTRON_RUN_AS_NODE
  if (!token || !path) throw new Error('Browser unavailable')
  const ipc = await BrowserIpcClient.connect(path, token)
  const server = new Server({ name: 'zumibot_browser', version: '1.0.0' }, { capabilities: { tools: {} } })
  const lifetime = new AbortController()
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    lifetime.abort()
    ipc.close()
    void server.close()
    process.stdin.pause()
  }
  const transport = new BoundedStdioTransport(
    process.stdout,
    () => {
      if (shuttingDown) return
      process.exitCode = 1
      shutdown()
      // Node's special stdout can retain a blocked native write after destroy.
      // IPC is already closed and send promises rejected; bound fatal child exit too.
      setTimeout(() => process.exit(1), 100).unref()
    },
    'Browser transport closed'
  )
  server.onclose = shutdown
  process.stdin.once('end', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: browserTools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let progress: ReturnType<typeof setInterval> | undefined
    try {
      const command = browserToolCommand(request.params.name, request.params.arguments ?? {})
      const progressToken = extra._meta?.progressToken
      if (command.op === 'requestUserAction' && progressToken !== undefined) {
        let count = 0
        progress = setInterval(() => {
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: ++count, message: 'Waiting for browser user action' }
            })
            .catch(() => {})
        }, 30000)
        progress.unref()
      }
      return browserToolResult(await ipc.run(command, AbortSignal.any([lifetime.signal, extra.signal, transport.signal(extra.requestId)])))
    } catch {
      return browserToolResult({ ok: false, code: 'unavailable', message: 'Browser request is invalid, cancelled, or unavailable' })
    } finally {
      if (progress) clearInterval(progress)
    }
  })
  await server.connect(transport)
}
void main().catch(() => {
  process.stderr.write('Browser unavailable\n')
  process.exitCode = 1
})
