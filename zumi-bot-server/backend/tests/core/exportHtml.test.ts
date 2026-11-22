import { describe, expect, it } from 'vitest'
import { buildExport } from '../../src/core/export/chatExport'
import { markdownToHtml, toHtml } from '../../src/core/export/exportHtml'
import { safeUrl } from '../../src/core/export/hastHtml'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'

const T = Date.UTC(2026, 10, 12, 13, 5)
const meta = (over: Partial<ChatMeta> = {}): ChatMeta => ({
  id: 'abc',
  agentName: 'x-expert',
  sessionId: null,
  cwd: '/w',
  title: 'Report',
  createdAt: 1,
  updatedAt: 2,
  inFlight: false,
  ...over
})

describe('markdownToHtml', () => {
  it('renders GFM: tables, task lists, strikethrough, autolinks', () => {
    const html = markdownToHtml('| a | b |\n|:--|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~old~~ https://example.com', 'm0-')
    expect(html).toContain('<table>')
    expect(html).toContain('<th style="text-align:left">a</th>')
    expect(html).toContain('<td style="text-align:right">2</td>')
    expect(html).toContain('<input type="checkbox" checked disabled>')
    expect(html).toContain('<del>old</del>')
    expect(html).toContain('<a href="https://example.com">https://example.com</a>')
  })

  it('keeps code blocks with their language and escapes them', () => {
    expect(markdownToHtml('```ts\nconst a = <b>1</b>\n```', 'm0-')).toBe(
      '<pre><code class="language-ts">const a = &lt;b&gt;1&lt;/b&gt;\n</code></pre>'
    )
  })

  it('shows raw HTML as text, never as markup', () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> there', 'm0-')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('drops links and images it cannot trust', () => {
    const html = markdownToHtml(
      '[a](javascript:alert(1)) [b](java\tscript:x) [c](javascript&#58;alert(1)) [d](mailto:x@y.z) [e](/chat/1) ![i](http://x/i.png) ![j](https://x/j.png) ![k](data:image/png;base64,AA)',
      'm0-'
    )
    expect(html).not.toMatch(/javascript/i)
    expect(html).toContain('<a href="mailto:x@y.z">d</a>')
    expect(html).toContain('<a href="/chat/1">e</a>')
    expect(html).toContain('<img src="https://x/j.png" alt="j" loading="lazy" referrerpolicy="no-referrer">')
    expect(html).not.toContain('http://x/i.png')
    expect(html).not.toContain('data:image')
  })

  it('keeps math as TeX and prices as text, the way the chat reads them', () => {
    const html = markdownToHtml('area $\\pi r^2$ costs $5 and $10\n\n$$\na_1 * b_1\n$$', 'm0-')
    expect(html).toContain('<code class="language-math math-inline">\\pi r^2</code>')
    expect(html).toContain('costs $5 and $10')
    expect(html).toContain('<pre><code class="language-math math-display">a_1 * b_1</code></pre>')
  })

  it('keeps footnote ids apart by prefix', () => {
    const html = markdownToHtml('Note[^1]\n\n[^1]: Text', 'm3-')
    expect(html).toContain('id="m3-fnref-1"')
    expect(html).toContain('href="#m3-fn-1"')
    expect(html).not.toContain('user-content')
  })
})

describe('safeUrl', () => {
  it('allows relative and listed schemes only', () => {
    expect(safeUrl('https://a.b', false)).toBe('https://a.b')
    expect(safeUrl('#x', false)).toBe('#x')
    expect(safeUrl('a/b:c', false)).toBe('a/b:c')
    expect(safeUrl('vbscript:x', false)).toBeNull()
    expect(safeUrl('HTTPS://a.b/i.png', true)).toBe('HTTPS://a.b/i.png')
    expect(safeUrl('i.png', true)).toBeNull()
  })
})

describe('toHtml', () => {
  it('is one self-contained page with no script and a strict CSP', () => {
    const items: ChatItem[] = [
      { type: 'user', id: 'u1', text: 'Hi </title><script>x</script>', ts: T },
      { type: 'assistant', id: 'a1', text: '**Done**', ts: T },
      { type: 'tool', id: 't1', name: 'Bash', input: { command: 'rm <x>' }, result: '', isError: true, blocked: false, ts: T }
    ]
    const page = toHtml(buildExport(meta({ title: 'A <b>title</b>' }), items, { steps: true, item: null, now: T, zone: 'UTC' })!)
    expect(page.startsWith('<!doctype html>')).toBe(true)
    expect(page).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src https:"`)
    expect(page).toContain('<title>A &lt;b&gt;title&lt;/b&gt;</title>')
    expect(page).not.toMatch(/<script/i)
    expect(page).toContain('<strong>Done</strong>')
    expect(page).toContain(
      '<details class="steps"><summary>1 step</summary><ul><li class="error"><code>Bash(rm &lt;x&gt;) (failed)</code></li></ul></details>'
    )
    expect(page).toContain('<time datetime="2026-11-12T13:05:00.000Z">2026-11-12 13:05</time>')
  })
})
