import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DESKTOP_SERVER } from '@zumibot/shared/desktop'
import { BoundedStdioTransport } from '../ipc/stdioTransport'
import { DesktopIpcClient } from './desktopIpc'
import { desktopTools, desktopToolCommand, desktopToolResult } from './desktopTools'

/** Only this child entry imports the SDK. Discovery never starts a desktop. */
async function main(): Promise<void> {
  const token = process.env.ZUMIBOT_DESKTOP_CAPABILITY,
    path = process.env.ZUMIBOT_DESKTOP_IPC
  // Keep capability and Electron child mode out of any descendants.
  delete process.env.ZUMIBOT_DESKTOP_CAPABILITY
  delete process.env.ZUMIBOT_DESKTOP_IPC
  delete process.env.ELECTRON_RUN_AS_NODE
  if (!token || !path) throw new Error('Desktop unavailable')
  const ipc = await DesktopIpcClient.connect(path, token)
  const server = new Server({ name: DESKTOP_SERVER, version: '1.0.0' }, { capabilities: { tools: {} } })
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
      // Node's special stdout can retain a blocked native write after destroy; bound fatal child exit too.
      setTimeout(() => process.exit(1), 100).unref()
    },
    'Desktop transport closed'
  )
  server.onclose = shutdown
  process.stdin.once('end', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: desktopTools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let progress: ReturnType<typeof setInterval> | undefined
    try {
      const command = desktopToolCommand(request.params.name, request.params.arguments ?? {})
      const progressToken = extra._meta?.progressToken
      // A user wait outlives the client's idle timeout; progress keeps it alive without exposing the reason.
      if (command.op === 'requestUserAction' && progressToken !== undefined) {
        let count = 0
        progress = setInterval(() => {
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: ++count, message: 'Waiting for desktop user action' }
            })
            .catch(() => {})
        }, 30000)
        progress.unref()
      }
      return desktopToolResult(await ipc.run(command, AbortSignal.any([lifetime.signal, extra.signal, transport.signal(extra.requestId)])))
    } catch {
      return desktopToolResult({ ok: false, code: 'unavailable', message: 'Desktop request is invalid, cancelled, or unavailable' })
    } finally {
      if (progress) clearInterval(progress)
    }
  })
  await server.connect(transport)
}
void main().catch(() => {
  process.stderr.write('Desktop unavailable\n')
  process.exitCode = 1
})
