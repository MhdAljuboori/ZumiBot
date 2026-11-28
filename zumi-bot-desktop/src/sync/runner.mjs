// Copied next to the unchanged CLI sync and its dependencies by the desktop build.
import { sync } from './sync.mjs'

let done = false
// The app went away mid-sync (even a SIGKILL closes this channel). Stop like Ctrl+C on the CLI, ssh and rsync
// included, so nothing keeps writing next to the server the next launch starts. The worker leads its process group.
process.on('disconnect', () => {
  if (done) return
  try {
    process.kill(-process.pid, 'SIGTERM')
  } catch {
    process.exit(1)
  }
})

// The local server takes its vault key path from these (backend/src/config.ts), so sync must find the same key.
const VAULT_KEY_ENV = ['XDG_CONFIG_HOME', 'ZUMIBOT_VAULT_KEY_FILE']

process.once('message', async ({ config, home, chats }) => {
  const log = (line) => {
    if (process.connected) process.send({ type: 'log', line })
  }
  const keyEnv = Object.fromEntries(VAULT_KEY_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
  try {
    process.exitCode = await sync({ env: { ...keyEnv, ...config, HOME: home }, chats: chats === true, log })
  } catch (err) {
    log(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  } finally {
    done = true
    if (process.connected) process.disconnect()
  }
})
