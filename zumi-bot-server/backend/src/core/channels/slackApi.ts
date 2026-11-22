// Plain HTTPS calls to Slack's Web API (no SDK, for the same reason as Telegram: a few methods, and an SDK's logging and
// retry layers would have to be audited to keep tokens out of logs). Tokens travel only in the Authorization header; an
// error names the method and Slack's error code (`invalid_auth`, `ratelimited`), never a token or a URL with a query.

export const SLACK_ORIGIN = 'https://slack.com'

/** A failed call. `status`: the HTTP status (429 for a rate limit), 0 for a network failure; `error`: Slack's own code. */
export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly error: string,
    readonly retryAfter: number | null
  ) {
    super(`Slack ${method} failed (${error || status || 'network'})`)
  }
}

export interface SlackApi {
  /** A Web API method with the bot token (or `app`: the app-level token, for apps.connections.open). JSON unless `form`. */
  call<T>(method: string, body?: Record<string, unknown>, o?: { token?: 'bot' | 'app'; form?: boolean; timeoutMs?: number }): Promise<T>
  /** A file upload URL from files.getUploadURLExternal; refused unless it is Slack's file host (or the dev hook's). */
  upload(url: string, bytes: Uint8Array, name: string): Promise<void>
  /** A file Slack stores (`url_private_download`), with the bot token; refused unless it is Slack's file host. */
  download(url: string, max: number): Promise<Uint8Array>
  /** The Socket Mode URL apps.connections.open handed out is one this client may open. */
  socketUrlOk(url: string): boolean
}

export interface SlackApiDeps {
  botToken: string
  appToken: string
  origin?: string // the dev hook's http://127.0.0.1:<port>, else Slack's
  fetch?: typeof fetch
}

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type'])
export const isAuthError = (err: unknown): boolean => err instanceof SlackError && AUTH_ERRORS.has(err.error)

export function createSlackApi(d: SlackApiDeps): SlackApi {
  const test = d.origin !== undefined
  const origin = d.origin ?? SLACK_ORIGIN
  const f = d.fetch ?? fetch

  // Slack's own file host only; the dev hook allows its own origin and nothing else.
  const fileUrlOk = (raw: string): boolean => {
    try {
      const u = new URL(raw)
      if (test) return u.origin === origin
      return (
        u.protocol === 'https:' && (u.hostname === 'files.slack.com' || u.hostname.endsWith('.slack.com')) && !u.username && !u.password
      )
    } catch {
      return false
    }
  }

  const timed = async (method: string, run: (signal: AbortSignal) => Promise<Response>, ms: number): Promise<Response> => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), ms)
    try {
      return await run(ctl.signal)
    } catch {
      throw new SlackError(method, 0, 'network', null)
    } finally {
      clearTimeout(t)
    }
  }

  return {
    call: async <T>(
      method: string,
      body: Record<string, unknown> = {},
      o: { token?: 'bot' | 'app'; form?: boolean; timeoutMs?: number } = {}
    ): Promise<T> => {
      const token = o.token === 'app' ? d.appToken : d.botToken
      const res = await timed(
        method,
        (signal) =>
          f(`${origin}/api/${method}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': o.form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8'
            },
            body: o.form ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(body),
            signal
          }),
        o.timeoutMs ?? 30_000
      )
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'))
        throw new SlackError(method, 429, 'ratelimited', Number.isFinite(after) && after > 0 ? after : 1)
      }
      let json: { ok?: boolean; error?: string } & Record<string, unknown>
      try {
        json = (await res.json()) as typeof json
      } catch {
        throw new SlackError(method, res.status, 'not_json', null)
      }
      if (json.ok !== true)
        throw new SlackError(method, res.status, typeof json.error === 'string' ? json.error.slice(0, 60) : 'error', null)
      return json as T
    },

    upload: async (url, bytes, name) => {
      if (!fileUrlOk(url)) throw new SlackError('upload', 400, 'bad_upload_url', null)
      const form = new FormData()
      form.append('file', new Blob([Uint8Array.from(bytes)]), name)
      const res = await timed('upload', (signal) => f(url, { method: 'POST', body: form, signal }), 120_000)
      if (!res.ok) throw new SlackError('upload', res.status, 'upload_failed', null)
    },

    download: async (url, max) => {
      if (!fileUrlOk(url)) throw new SlackError('download', 400, 'bad_file_url', null)
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 120_000)
      try {
        let res: Response
        try {
          res = await f(url, { headers: { authorization: `Bearer ${d.botToken}` }, signal: ctl.signal })
        } catch {
          throw new SlackError('download', 0, 'network', null)
        }
        if (!res.ok || !res.body) throw new SlackError('download', res.status, 'download_failed', null)
        if (Number(res.headers.get('content-length') ?? '0') > max) throw new SlackError('download', 413, 'too_big', null)
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += c.length
          if (size > max) {
            ctl.abort()
            throw new SlackError('download', 413, 'too_big', null)
          }
          chunks.push(c)
        }
        const out = new Uint8Array(size)
        let at = 0
        for (const c of chunks) {
          out.set(c, at)
          at += c.length
        }
        return out
      } finally {
        clearTimeout(t)
      }
    },

    socketUrlOk: (raw) => {
      try {
        const u = new URL(raw)
        if (test) return u.protocol === 'ws:' && u.hostname === '127.0.0.1' && u.port === new URL(origin).port
        return u.protocol === 'wss:' && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com')) && !u.username && !u.password
      } catch {
        return false
      }
    }
  }
}
