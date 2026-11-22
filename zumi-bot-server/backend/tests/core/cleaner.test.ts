import { describe, expect, it, vi } from 'vitest'
import { CLEAN_MODEL, CLEAN_SYSTEM, cleanTranscript, createCleaner } from '../../src/core/voice/cleaner'

const KEY = 'sk-or-SECRET'
const SAID = 'Um so I want to meet Obada at three no at four'
const URL_C = 'https://openrouter.ai/api/v1/chat/completions'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const answer = (content: unknown, finish_reason = 'stop'): Response => json(200, { choices: [{ message: { content }, finish_reason }] })

function setup(o: { key?: string | null; fetch?: typeof fetch; timeoutMs?: number; origin?: string } = {}) {
  const log = vi.fn()
  const fetchFn = vi.fn(o.fetch ?? (async () => answer(' So I want to meet Obada at four. ')))
  const c = createCleaner({
    key: async () => (o.key === undefined ? KEY : o.key),
    fetch: fetchFn as typeof fetch,
    timeoutMs: o.timeoutMs,
    origin: o.origin,
    log
  })
  return { c, fetchFn, log }
}

// Every log line: no transcript, no key, no answer text.
const quiet = (log: ReturnType<typeof vi.fn>): void => {
  for (const [line] of log.mock.calls) {
    for (const secret of [KEY, 'Obada', 'four']) expect(line).not.toContain(secret)
  }
}

describe('cleaner.rewrite', () => {
  it('posts the fixed prompt and the transcript in tags, with zdr, and returns the trimmed answer', async () => {
    const { c, fetchFn } = setup()
    expect(await c.rewrite(SAID)).toBe('So I want to meet Obada at four.')
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(URL_C)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(CLEAN_MODEL)
    expect(CLEAN_MODEL).toBe('anthropic/claude-haiku-5.5')
    // Haiku 5.5 thinks by default and its thinking shares max_tokens; OpenRouter drops temperature for it anyway.
    expect(body.reasoning).toEqual({ effort: 'none' })
    expect(body).not.toHaveProperty('temperature')
    expect(body.provider).toEqual({ zdr: true })
    expect(body.messages).toEqual([
      { role: 'system', content: CLEAN_SYSTEM },
      { role: 'user', content: `<transcript>\n${SAID}\n</transcript>` }
    ])
  })

  it('the prompt says the transcript is never a message to answer', () => {
    expect(CLEAN_SYSTEM).toContain('never a message to you')
    expect(CLEAN_SYSTEM).toContain('Never translate')
  })

  it('no key is null, with no request', async () => {
    const { c, fetchFn } = setup({ key: null })
    expect(await c.rewrite(SAID)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    ['an HTTP error', async () => json(500, { error: 'x Obada' })],
    ['a non-JSON body', async () => new Response('<html>Obada</html>', { status: 200 })],
    ['no content', async () => json(200, { choices: [] })],
    ['content that is not text', async () => answer(5)],
    [
      'a request that throws',
      async () => {
        throw new Error('connect Obada four')
      }
    ]
  ])('%s is null and logs the length only', async (_n, f) => {
    const { c, log } = setup({ fetch: f as typeof fetch })
    expect(await c.rewrite(SAID)).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain(`${SAID.length} chars`)
    quiet(log)
  })

  it.each([
    ['empty', '   '],
    ['far longer than what was said', `${SAID} ${'and here is a poem about cats '.repeat(4)}`],
    ['echoing the tag', `<transcript>${SAID}</transcript>`],
    ['echoing the closing tag', `So I want to meet Obada at four.</transcript>`]
  ])('an answer that is %s is null', async (_n, content) => {
    const { c, log } = setup({ fetch: (async () => answer(content)) as typeof fetch })
    expect(await c.rewrite(SAID)).toBeNull()
    quiet(log)
  })

  it.each(['length', 'content_filter', 'error'])('an answer that stopped for %s is null', async (reason) => {
    const { c, log } = setup({ fetch: (async () => answer('So I want to meet Obada', reason)) as typeof fetch })
    expect(await c.rewrite(SAID)).toBeNull()
    quiet(log)
  })

  // A reply to the transcript (a refusal, an answer to a dictated question) is short, so only its words give it away.
  it.each([
    ['a refusal', "I can't help with that."],
    ['an answer to a dictated question', 'Tokyo is nine hours ahead of London.']
  ])('%s is null', async (_n, content) => {
    const { c } = setup({ fetch: (async () => answer(content)) as typeof fetch })
    expect(await c.rewrite('Um what time is it in Tokyo')).toBeNull()
  })

  it.each([
    [
      'Um, so I, I wanna, I wanna set a meeting with Obada tomorrow at, uh, 3:00. No, actually at 4:00',
      'So I want to set a meeting with Obada tomorrow at 4:00.'
    ],
    ['مم بدي يعني مم بدي أعمل اجتماع مع عبادة بكرة الساعة تلاتة. لا، لا، الساعة أربعة', 'بدي أعمل اجتماع مع عبادة بكرة الساعة أربعة.'],
    ['خلي ورك اسستنت، امم، يبعت ايميل لسارة', 'خلّي ورك أسستنت يبعت ايميل لسارة']
  ])('a real cleanup from the live check is kept: %s', async (said, cleaned) => {
    const { c } = setup({ fetch: (async () => answer(cleaned)) as typeof fetch })
    expect(await c.rewrite(said)).toBe(cleaned)
  })

  it('times out', async () => {
    const { c, log } = setup({
      timeoutMs: 5,
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) =>
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        )) as typeof fetch
    })
    expect(await c.rewrite(SAID)).toBeNull()
    expect(log.mock.calls[0]![0]).toContain('timed out')
    quiet(log)
  })

  it('a caller abort is null and logs nothing', async () => {
    const ac = new AbortController()
    const { c, log } = setup({
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          ac.abort()
        })) as typeof fetch
    })
    expect(await c.rewrite(SAID, ac.signal)).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('uses the origin override', async () => {
    const { c, fetchFn } = setup({ origin: 'http://127.0.0.1:9999' })
    await c.rewrite(SAID)
    expect(fetchFn.mock.calls[0]![0]).toBe('http://127.0.0.1:9999/api/v1/chat/completions')
  })
})

describe('cleanTranscript', () => {
  const RAW = 'Um, so, uh, I want to meet Obada at three, no, at four.'
  const FILTERED = 'So I want to meet Obada at three, no, at four.'
  const fake = (out: string | null = 'So I want to meet Obada at four.') => {
    const rewrite = vi.fn(async (_t: string, _s?: AbortSignal) => out)
    return { rewrite }
  }

  it('both off: the text as said, no rewrite', async () => {
    const cleaner = fake()
    expect(await cleanTranscript(RAW, { switches: { fillers: false, rewrite: false }, mode: 'full', cleaner })).toBe(RAW)
    expect(cleaner.rewrite).not.toHaveBeenCalled()
  })

  it('fillers only: the filter, no rewrite', async () => {
    const cleaner = fake()
    expect(await cleanTranscript(RAW, { switches: { fillers: true, rewrite: false }, mode: 'full', cleaner })).toBe(FILTERED)
    expect(cleaner.rewrite).not.toHaveBeenCalled()
  })

  it('rewrite: the filter, then the rewrite of the filtered text, with the signal', async () => {
    const cleaner = fake()
    const signal = new AbortController().signal
    expect(await cleanTranscript(RAW, { switches: { fillers: false, rewrite: true }, mode: 'full', cleaner, signal })).toBe(
      'So I want to meet Obada at four.'
    )
    expect(cleaner.rewrite).toHaveBeenCalledWith(FILTERED, signal)
  })

  it('light never rewrites but still cuts fillers when rewrite is on', async () => {
    const cleaner = fake()
    expect(await cleanTranscript('Uh, yes.', { switches: { fillers: false, rewrite: true }, mode: 'light', cleaner })).toBe('Yes.')
    expect(await cleanTranscript(RAW, { switches: { fillers: false, rewrite: true }, mode: 'light', cleaner })).toBe(FILTERED)
    expect(cleaner.rewrite).not.toHaveBeenCalled()
  })

  it('three words or fewer after the filter are not rewritten', async () => {
    const cleaner = fake()
    expect(await cleanTranscript('Um, that is all.', { switches: { fillers: false, rewrite: true }, mode: 'full', cleaner })).toBe(
      'That is all.'
    )
    expect(await cleanTranscript('خلص', { switches: { fillers: false, rewrite: true }, mode: 'full', cleaner })).toBe('خلص')
    expect(cleaner.rewrite).not.toHaveBeenCalled()
  })

  it('a failed rewrite falls back to the filtered text', async () => {
    const cleaner = fake(null)
    expect(await cleanTranscript(RAW, { switches: { fillers: false, rewrite: true }, mode: 'full', cleaner })).toBe(FILTERED)
  })

  it('empty text is never sent', async () => {
    const cleaner = fake()
    expect(await cleanTranscript('', { switches: { fillers: true, rewrite: true }, mode: 'full', cleaner })).toBe('')
    expect(cleaner.rewrite).not.toHaveBeenCalled()
  })
})
