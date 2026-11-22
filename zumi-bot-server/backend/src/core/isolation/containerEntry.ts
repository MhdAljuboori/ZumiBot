import net from 'node:net'
import { spawn } from 'node:child_process'

// PID 1 of a contained run (governance.md 2.4). The container has no network: this forwards 127.0.0.1:8787 (the model, through
// ZumiBot's auth proxy) and 127.0.0.1:3128 (the agent's network list, through its filtering proxy) to the Unix sockets the
// run dir holds, then runs `claude` with the given args on the same stdio and passes Stop's signals on.

const API_PORT = 8787,
  NET_PORT = 3128

async function main(): Promise<void> {
  const pairs: [number, string | undefined][] = [
    [API_PORT, process.env.CB_API_SOCK],
    [NET_PORT, process.env.CB_NET_SOCK]
  ]
  delete process.env.CB_API_SOCK
  delete process.env.CB_NET_SOCK
  await Promise.all(
    pairs
      .filter((p): p is [number, string] => !!p[1])
      .map(
        ([port, sock]) =>
          new Promise<void>((ok, bad) => {
            const srv = net.createServer((c) => {
              const u = net.connect(sock)
              c.pipe(u)
              u.pipe(c)
              u.on('error', () => c.destroy())
              c.on('error', () => u.destroy())
            })
            srv.on('error', bad)
            srv.listen(port, '127.0.0.1', () => ok())
            srv.unref()
          })
      )
  )
  const [bin, ...args] = process.argv.slice(2)
  if (!bin) {
    process.stderr.write('containerEntry: no command\n')
    process.exit(2)
  }
  const child = spawn(bin, args, { stdio: 'inherit' })
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(s, () => {
      child.kill(s)
    })
  child.on('error', (e) => {
    process.stderr.write(`containerEntry: ${e.message}\n`)
    process.exit(127)
  })
  child.on('exit', (code, sig) => process.exit(code ?? (sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 1)))
}

void main().catch((e) => {
  process.stderr.write(`containerEntry: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
