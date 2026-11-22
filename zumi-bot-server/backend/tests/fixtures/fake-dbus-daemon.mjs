#!/usr/bin/env node
// Fake `dbus-daemon --session --nofork ... --address=unix:path=<p>` for desktop tests: listens on
// the socket path (accepting and ignoring clients) until SIGTERM.
// Env: FAKE_DBUS_LOG (one JSON line {args, env keys}), FAKE_DBUS_DELAY_MS (wait before listening).
import { appendFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'

const args = process.argv.slice(2)
if (process.env.FAKE_DBUS_LOG) appendFileSync(process.env.FAKE_DBUS_LOG, JSON.stringify({ args, pid: process.pid, env: Object.keys(process.env) }) + '\n')
const prefix = '--address=unix:path='
const path = args.find(a => a.startsWith(prefix))?.slice(prefix.length)
if (!path) { process.stderr.write('fake dbus-daemon: no --address\n'); process.exit(1) }

const server = createServer(s => s.on('error', () => {}))
process.on('SIGTERM', () => { server.close(); rmSync(path, { force: true }); process.exit(0) })
setTimeout(() => server.listen(path), Number(process.env.FAKE_DBUS_DELAY_MS ?? 0))
