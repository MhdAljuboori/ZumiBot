import { describe, expect, it } from 'vitest'
import { renderTelegram, splitMessage, tailOf } from '@zumibot/shared/channelText'

describe('renderTelegram', () => {
  it('escapes HTML in text and code, so agent text can never inject a tag', () => {
    expect(renderTelegram('a <b>x</b> & y')).toBe('a &lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(renderTelegram('`<i>`')).toBe('<code>&lt;i&gt;</code>')
    expect(renderTelegram('```html\n<div a="1">&</div>\n```')).toBe(
      '<pre><code class="language-html">&lt;div a="1"&gt;&amp;&lt;/div&gt;</code></pre>'
    )
  })

  it('renders emphasis, headings, lists, quotes and rules', () => {
    expect(renderTelegram('**b** *i* ~~s~~ __b2__ _i2_')).toBe('<b>b</b> <i>i</i> <s>s</s> <b>b2</b> <i>i2</i>')
    expect(renderTelegram('## Title')).toBe('<b>Title</b>')
    expect(renderTelegram('- one\n  - two\n1. first\n- [x] done')).toBe('• one\n  • two\n1. first\n☑ done')
    expect(renderTelegram('> quoted *a*\n> more')).toBe('<blockquote>quoted <i>a</i>\nmore</blockquote>')
    expect(renderTelegram('---')).toBe('———')
  })

  it('leaves snake_case and lone stars alone', () => {
    expect(renderTelegram('snake_case_name and 2 * 3 * 4')).toBe('snake_case_name and 2 * 3 * 4')
  })

  it('keeps only http(s) links and escapes their attributes', () => {
    expect(renderTelegram("[x](https://a.example/?q='1'&b)")).toBe('<a href="https://a.example/?q=\'1\'&amp;b">x</a>')
    expect(renderTelegram('[x](https://a.example/"q)')).toBe('x')
    expect(renderTelegram('[x](javascript:alert)')).toBe('x')
    expect(renderTelegram('![alt](https://img.example/a.png)')).toBe('<a href="https://img.example/a.png">alt</a>')
    // Emphasis markers inside a URL are not read.
    expect(renderTelegram('[l](https://a.example/a_b_c)')).toBe('<a href="https://a.example/a_b_c">l</a>')
  })

  it('shows tables, math and diagrams as preformatted text', () => {
    expect(renderTelegram('| a | bb |\n|---|---|\n| ccc | d |')).toBe('<pre>a    bb\nccc  d</pre>')
    expect(renderTelegram('$$\nx^2 < y\n$$')).toBe('<pre>$$\nx^2 &lt; y\n$$</pre>')
    expect(renderTelegram('```mermaid\ngraph TD; A-->B\n```')).toBe(
      '<i>Diagram (open in ZumiBot to see it drawn)</i>\n<pre>graph TD; A--&gt;B</pre>'
    )
  })
})

describe('splitMessage', () => {
  it('keeps a short reply in one part, with its source as the plain fallback', () => {
    expect(splitMessage('Hello **you**', 4096)).toEqual([{ html: 'Hello <b>you</b>', plain: 'Hello **you**' }])
  })

  it('packs paragraphs and cuts between them', () => {
    const md = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].join('\n\n')
    const parts = splitMessage(md, 90)
    expect(parts.map((p) => p.html)).toEqual(['a'.repeat(40) + '\n\n' + 'b'.repeat(40), 'c'.repeat(40)])
  })

  it('closes and reopens a cut code block with its language, never changing the code', () => {
    const code = Array.from({ length: 30 }, (_, i) => `line ${i} <x>`).join('\n')
    const parts = splitMessage('```ts\n' + code + '\n```', 200)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(p.html.length).toBeLessThanOrEqual(200)
      expect(p.html.startsWith('<pre><code class="language-ts">')).toBe(true)
      expect(p.html.endsWith('</code></pre>')).toBe(true)
      expect(p.plain.startsWith('```ts\n')).toBe(true)
    }
    const back = parts.map((p) => p.html.replace(/^<pre><code class="language-ts">|<\/code><\/pre>$/g, '')).join('\n')
    expect(back).toBe(code.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  })

  it('cuts one long line at spaces, and code hard, each part within the limit', () => {
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ')
    const parts = splitMessage(words, 100)
    expect(parts.every((p) => p.html.length <= 100)).toBe(true)
    expect(parts.map((p) => p.html).join(' ')).toBe(words)
    const long = '```\n' + 'x&'.repeat(300) + '\n```'
    const code = splitMessage(long, 120)
    expect(code.every((p) => p.html.length <= 120)).toBe(true)
    expect(code.map((p) => p.html.replace(/^<pre>|<\/pre>$/g, '')).join('')).toBe('x&amp;'.repeat(300))
  })

  it('measures the rendered length, escapes included', () => {
    const parts = splitMessage('&'.repeat(100), 50)
    expect(parts.every((p) => p.html.length <= 50)).toBe(true)
    expect(parts.map((p) => p.html).join('')).toBe('&amp;'.repeat(100))
  })
})

describe('tailOf', () => {
  it('keeps the end of a long live reply', () => {
    expect(tailOf('abcdef', 10)).toBe('abcdef')
    expect(tailOf('abcdef', 4)).toBe('…def')
  })
  it('never starts with half an emoji', () => {
    expect(tailOf('ab😀cd', 4)).toBe('…cd')
  })
})

describe('surrogate pairs and NUL', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  it('a cut never splits an emoji', () => {
    const parts = splitMessage('😀'.repeat(200), 51)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(lone.test(p.plain)).toBe(false)
    expect(parts.map((p) => p.plain).join('')).toBe('😀'.repeat(200))
  })
  it('a NUL in the text is not read as a placeholder', () => {
    expect(renderTelegram('**b** x\u00000\u0000y')).toBe('<b>b</b> x0y')
  })
})

describe('renderSlack', () => {
  it('speaks mrkdwn and escapes what would ping or link', async () => {
    const { renderSlack } = await import('@zumibot/shared/channelText')
    expect(renderSlack('**b** *i* ~~s~~ `c<d>`')).toBe('*b* _i_ ~s~ `c&lt;d&gt;`')
    expect(renderSlack('## Title')).toBe('*Title*')
    expect(renderSlack('<!here> <@U123> & co')).toBe('&lt;!here&gt; &lt;@U123&gt; &amp; co')
    expect(renderSlack('[a|b>](https://x.example/?q=1&r=2|3)')).toBe('<https://x.example/?q=1&amp;r=2%7C3|a b&gt;>')
    expect(renderSlack('[x](javascript:alert)')).toBe('x')
    expect(renderSlack('```ts\nconst a = `x` && b\n```')).toBe('```\nconst a = `x` &amp;&amp; b\n```')
    expect(renderSlack('> quoted *a*')).toBe('&gt; quoted _a_')
    // Bold made from **…** is never read again as Markdown italic.
    expect(renderSlack('**a** and *b*')).toBe('*a* and _b_')
  })

  it('splits for Slack, reopening a cut code fence', async () => {
    const { splitMessage, SLACK } = await import('@zumibot/shared/channelText')
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const parts = splitMessage('```\n' + code + '\n```', 120, SLACK)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(p.html.length).toBeLessThanOrEqual(120)
      expect(p.html.startsWith('```\n') && p.html.endsWith('\n```')).toBe(true)
    }
  })
})
