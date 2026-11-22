import http from 'node:http'
import https from 'node:https'
import { timingSafeEqual } from 'node:crypto'

// A contained run's only way to the model (governance.md 2.4, "Signing in"). The container holds a per-run dummy key; this proxy,
// on a Unix socket only that run's container has mounted, checks it, drops it, adds the user's real sign-in and forwards to the
// Anthropic API. The real token never enters the container, so the agent can neither read nor send it anywhere.

/** The user's sign-in as the proxy adds it: a subscription's OAuth token, or an API key. */
export type Credential = { kind: 'oauth'; token: string } | { kind: 'apiKey'; key: string }

/** Read per request: the host CLI refreshes the subscription token in its own file, and the next request picks it up. */
export type CredentialSource = () => Promise<Credential | null>

export const OAUTH_BETA = 'oauth-2025-04-20'

// What the CLI needs for a turn (checked against 2.1.322, e2e/containerProbe.mjs). Nothing else: the account's own endpoints
// (profile, keys, usage) stay out of reach of an agent that calls the proxy itself with the dummy key from its env.
const ALLOWED = [/^\/v1\/messages(\/count_tokens)?(\?.*)?$/, /^\/api\/hello$/]

export const pathAllowed = (path: string): boolean => ALLOWED.some((r) => r.test(path))

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a),
    y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The request headers sent on: the run's key and any auth the container sent dropped, the user's sign-in added. */
export function upstreamHeaders(inbound: http.IncomingHttpHeaders, cred: Credential): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(inbound)) {
    if (
      v === undefined ||
      ['x-api-key', 'authorization', 'host', 'connection', 'proxy-authorization', 'keep-alive', 'transfer-encoding'].includes(k)
    )
      continue
    out[k] = v
  }
  if (cred.kind === 'apiKey') out['x-api-key'] = cred.key
  else {
    out['authorization'] = `Bearer ${cred.token}`
    const beta = String(inbound['anthropic-beta'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!beta.includes(OAUTH_BETA)) beta.push(OAUTH_BETA)
    out['anthropic-beta'] = beta.join(',')
  }
  return out
}

export interface AuthProxyOptions {
  runKey: string
  credential: CredentialSource
  /** Tests point it at a local server; the server always sends to the Anthropic API. */
  upstream?: { request: typeof https.request; host: string; port?: number }
}

const reply = (res: http.ServerResponse, status: number, message: string) => {
  // The Messages API's error shape, so the CLI shows the message as the turn's error.
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message } }))
}

export function createAuthProxy(o: AuthProxyOptions): http.Server {
  const up = o.upstream ?? { request: https.request, host: 'api.anthropic.com' }
  return http.createServer((req, res) => {
    const path = req.url ?? '/'
    const key = req.headers['x-api-key']
    if (typeof key !== 'string' || !same(key, o.runKey))
      return reply(res, 401, 'ZumiBot: this request did not come from the agent run it was made for.')
    if (!pathAllowed(path)) return reply(res, 403, 'ZumiBot: a contained agent reaches only the Messages API.')
    o.credential().then(
      (cred) => {
        if (cred === null)
          return reply(res, 401, 'ZumiBot: no Claude sign-in found on the server. Sign in with `claude` on the server, then try again.')
        const fwd = up.request(
          { host: up.host, ...(up.port ? { port: up.port } : {}), path, method: req.method, headers: upstreamHeaders(req.headers, cred) },
          (r) => {
            res.writeHead(r.statusCode ?? 502, r.headers)
            r.pipe(res)
          }
        )
        // The error's code only: a message could quote the request.
        fwd.on('error', (e) => {
          console.error('container auth proxy:', (e as NodeJS.ErrnoException).code ?? 'error')
          if (!res.headersSent) reply(res, 502, 'ZumiBot could not reach the Anthropic API.')
          else res.destroy()
        })
        req.pipe(fwd)
      },
      () => reply(res, 401, 'ZumiBot could not read the Claude sign-in on the server.')
    )
  })
}

/**
 * The server's own sign-in, in the CLI's order: an API key in its env, then an OAuth token in its env, then the subscription
 * login in ~/.claude/.credentials.json (read per request, so the host CLI's refresh is picked up). Never copied anywhere.
 */
export function serverCredential(
  env: () => NodeJS.ProcessEnv,
  credentialsFile: string,
  read: (p: string) => Promise<string>
): CredentialSource {
  return async () => {
    const e = env()
    if (e.ANTHROPIC_API_KEY) return { kind: 'apiKey', key: e.ANTHROPIC_API_KEY }
    if (e.CLAUDE_CODE_OAUTH_TOKEN) return { kind: 'oauth', token: e.CLAUDE_CODE_OAUTH_TOKEN }
    const text = await read(credentialsFile).catch(() => null)
    if (text === null) return null
    try {
      const token = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth?.accessToken
      return typeof token === 'string' && token.length > 0 ? { kind: 'oauth', token } : null
    } catch {
      return null
    }
  }
}
