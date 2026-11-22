// Plain HTTPS calls to the Telegram Bot API (no SDK: a few methods, and an SDK's logging and retry layers would have to be
// audited to keep the token out of logs). The token sits in the request path (`/bot<token>/<method>`), so a URL is built
// only here and never logged, thrown, or handed out: every error names the method and a code.

export const TELEGRAM_ORIGIN = 'https://api.telegram.org'

/** A failed call. `code`: Telegram's error_code (400, 401, 403, 409, 429, ...), or 0 for a network failure or timeout. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly retryAfter: number | null,
    readonly description: string
  ) {
    super(`Telegram ${method} failed (${code === 0 ? 'network' : code})`)
  }
}

export interface TelegramApi {
  call<T>(method: string, params?: Record<string, unknown>, o?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>
  upload<T>(method: string, fields: Record<string, string>, file: { field: string; name: string; bytes: Uint8Array }): Promise<T>
  /** A file Telegram stores, by its `file_path`; refused past `max` bytes before or while reading. */
  download(filePath: string, max: number): Promise<Uint8Array>
}

export interface TelegramApiDeps {
  token: string
  origin?: string // the dev hook's http://127.0.0.1:<port>, else Telegram's
  fetch?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Telegram's answer, or a TelegramError with the method and code only (never the URL, which carries the token). */
async function read<T>(method: string, res: Response): Promise<T> {
  type Answer = { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
  let body: Answer | null
  try {
    body = (await res.json()) as Answer | null
  } catch {
    throw new TelegramError(method, res.status || 0, null, 'not json')
  }
  if (body?.ok === true) return body.result as T
  const retry = typeof body?.parameters?.retry_after === 'number' ? body.parameters.retry_after : null
  throw new TelegramError(
    method,
    body?.error_code ?? res.status ?? 0,
    retry,
    typeof body?.description === 'string' ? body.description.slice(0, 200) : ''
  )
}

export function createTelegramApi(d: TelegramApiDeps): TelegramApi {
  const origin = d.origin ?? TELEGRAM_ORIGIN
  const f = d.fetch ?? fetch
  const url = (method: string) => `${origin}/bot${d.token}/${method}`

  const guarded = async <T>(
    method: string,
    run: (signal: AbortSignal) => Promise<Response>,
    timeoutMs: number,
    outer?: AbortSignal
  ): Promise<T> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const onOuter = () => ctl.abort()
    outer?.addEventListener('abort', onOuter, { once: true })
    try {
      let res: Response
      try {
        res = await run(ctl.signal)
      } catch {
        // A fetch error's message can carry the URL; it is never passed on.
        throw new TelegramError(method, 0, null, outer?.aborted ? 'aborted' : 'network')
      }
      return await read<T>(method, res)
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
    }
  }

  return {
    call: (method, params = {}, o = {}) =>
      guarded(
        method,
        (signal) =>
          f(url(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal }),
        o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        o.signal
      ),

    upload: (method, fields, file) => {
      const form = new FormData()
      for (const [k, v] of Object.entries(fields)) form.append(k, v)
      form.append(file.field, new Blob([Uint8Array.from(file.bytes)]), file.name)
      return guarded(method, (signal) => f(url(method), { method: 'POST', body: form, signal }), 120_000)
    },

    download: async (filePath, max) => {
      if (!/^[\w./-]{1,300}$/.test(filePath) || filePath.includes('..')) throw new TelegramError('download', 400, null, 'bad path')
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 120_000)
      try {
        let res: Response
        try {
          res = await f(`${origin}/file/bot${d.token}/${filePath}`, { signal: ctl.signal })
        } catch {
          throw new TelegramError('download', 0, null, 'network')
        }
        if (!res.ok || !res.body) throw new TelegramError('download', res.status, null, '')
        const declared = Number(res.headers.get('content-length') ?? '0')
        if (declared > max) throw new TelegramError('download', 413, null, 'too big')
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length
          if (size > max) {
            ctl.abort()
            throw new TelegramError('download', 413, null, 'too big')
          }
          chunks.push(chunk)
        }
        const out = new Uint8Array(size)
        let at = 0
        for (const c of chunks) {
          out.set(c, at)
          at += c.length
        }
        return out
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

/** The dev hook's origin: only `http://127.0.0.1:<port>`, no path; anything else is ignored (as `testVoiceOrigin`). */
export function testChannelOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (
      u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' ||
      u.port === '' ||
      (u.pathname !== '/' && u.pathname !== '') ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      return null
    return `http://127.0.0.1:${u.port}`
  } catch {
    return null
  }
}
