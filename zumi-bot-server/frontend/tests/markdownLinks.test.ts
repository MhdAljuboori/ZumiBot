import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/components/Markdown'

describe('markdown links', () => {
  it('open in a new tab without opener or referrer', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: 'see [x](https://example.com)' }))
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})
