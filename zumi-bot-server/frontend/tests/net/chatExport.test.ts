import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportError, exportError, fetchExport } from '../../src/net/chatExport'

const opts = { format: 'md' as const, steps: false, item: null, timeZone: 'UTC' }

afterEach(() => vi.unstubAllGlobals())

describe('exportError', () => {
  it('says what went wrong in fixed words', () => {
    expect(exportError(404, false)).toBe('This chat no longer exists.')
    expect(exportError(404, true)).toBe('That reply is no longer in this chat.')
    expect(exportError(401, false)).toBe('Signed out. Sign in again to export.')
    expect(exportError(500, false)).toBe('Export failed. Try again.')
    expect(exportError(null, false)).toBe('Export failed. Check the connection and try again.')
  })
})

describe('fetchExport', () => {
  it('asks the export route and returns its text', async () => {
    const fetch = vi.fn(async () => new Response('# Hi\n'))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchExport('c1', opts)).toBe('# Hi\n')
    expect(fetch).toHaveBeenCalledWith('/api/export/c1?format=md&tz=UTC', { credentials: 'same-origin', cache: 'no-store' })
  })
  it('turns a failure into an ExportError with fixed text, never the server body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"secret detail"}', { status: 500 }))
    )
    const err = await fetchExport('c1', opts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ExportError)
    expect((err as Error).message).toBe('Export failed. Try again.')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network')
      })
    )
    expect(((await fetchExport('c1', { ...opts, item: 'a1' }).catch((e: unknown) => e)) as Error).message).toBe(
      'Export failed. Check the connection and try again.'
    )
  })
})
