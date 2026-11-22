import http from 'node:http'
import net from 'node:net'
import { hostAllowed } from '@zumibot/shared/isolation'
import { addressClass, checkedAddresses, publicOrLocal, type AddressLookup } from '../addressGuard'

// A contained run's network (governance.md 2.4, "Network"). The container has none of its own (`--network none`); its
// HTTP(S)_PROXY points at the entry's forwarder, which reaches this proxy over a mounted Unix socket. Only the agent's list
// gets through, on ports 80 and 443; everything else is refused and reported, so the chat and the audit can say what was blocked.
// A listed name must also resolve to public addresses only (a wildcard could point at 127.0.0.1 or the LAN), and the
// connection goes to the address that was checked, so DNS cannot answer differently in between.

const PORTS = new Set([80, 443])

export interface NetProxyOptions {
  network: readonly string[]
  /** A refused host, as `host:port`. */
  denied(target: string): void
  /** Tests only: where an allowed connection goes instead of the checked address. */
  connect?: (port: number, address: string) => net.Socket
  /** Tests only: a promise-style `dns.lookup` with `{all: true}`. */
  lookup?: AddressLookup
}

const NOT_LISTED = "Blocked by ZumiBot: not on this agent's network list\n"
const NOT_PUBLIC = 'Blocked by ZumiBot: the host resolves to this machine, the local network or a reserved address\n'

const refuse = (sock: net.Socket, why: string) => {
  sock.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${why}`)
}

// The only local hosts an agent may name, and only as exact entries (hostError allows no other address): they mean this
// machine on purpose, so they pass to loopback and nothing else.
const LOCAL_ENTRIES = new Set(['localhost', '127.0.0.1'])

export function createNetProxy(o: NetProxyOptions): http.Server {
  const dial = o.connect ?? ((port: number, address: string) => net.connect(port, address))
  const listed = (host: string, port: number) => PORTS.has(port) && hostAllowed(host, o.network)
  // The address to dial, or why not: `denied` is reported as a refusal, `resolve` is a bad gateway.
  const target = async (host: string): Promise<{ address: string } | { error: 'denied' | 'resolve' }> => {
    const h = host.toLowerCase().replace(/\.$/, '')
    const ok = LOCAL_ENTRIES.has(h) && o.network.includes(h) ? (a: string) => addressClass(a) === 'loopback' : publicOrLocal(false)
    const checked = await checkedAddresses(host, ok, o.lookup)
    if ('error' in checked) return { error: checked.error === 'resolve' ? 'resolve' : 'denied' }
    return { address: checked.addresses[0] }
  }
  const server = http.createServer((req, res) => {
    // A plain-HTTP request through the proxy names its absolute URL.
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const port = Number(url.port || 80)
    const deny = (why: string) => {
      o.denied(`${url.hostname}:${port}`)
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end(why)
    }
    if (url.protocol !== 'http:' || !listed(url.hostname, port)) return deny(NOT_LISTED)
    req.pause()
    void target(url.hostname).then((t) => {
      if ('error' in t) {
        if (t.error === 'denied') return deny(NOT_PUBLIC)
        res.writeHead(502)
        res.end()
        return
      }
      const headers = { ...req.headers }
      delete headers['proxy-connection']
      delete headers['proxy-authorization']
      const fwd = http.request(
        {
          host: url.hostname,
          port,
          path: url.pathname + url.search,
          method: req.method,
          headers,
          createConnection: () => dial(port, t.address)
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers)
          r.pipe(res)
        }
      )
      fwd.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502)
          res.end()
        } else res.destroy()
      })
      req.pipe(fwd)
      req.resume()
    })
  })
  server.on('connect', (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    sock.on('error', () => {})
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '')
    const host = m?.[1] ?? '',
      port = Number(m?.[2] ?? 0)
    if (!m || !listed(host, port)) {
      o.denied(`${host || '?'}:${port}`)
      return refuse(sock, NOT_LISTED)
    }
    void target(host).then((t) => {
      if ('error' in t) {
        if (t.error === 'denied') {
          o.denied(`${host}:${port}`)
          return refuse(sock, NOT_PUBLIC)
        }
        sock.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n')
        return
      }
      const upstream = dial(port, t.address)
      upstream.on('error', () => sock.destroy())
      upstream.on('connect', () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(sock)
        sock.pipe(upstream)
      })
    })
  })
  return server
}
