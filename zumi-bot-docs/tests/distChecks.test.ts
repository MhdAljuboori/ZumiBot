import { describe, expect, it } from 'vitest'
import { htmlComments, remoteLoads } from '../src/lib/distChecks.ts'

const page = (body: string, head = '') => `<html><head>${head}</head><body>${body}</body></html>`

describe('remoteLoads', () => {
  it('flags a remote script, in double, single and no quotes, and protocol-relative', () => {
    expect(remoteLoads(page('<script src="https://cdn.example.com/a.js"></script>'))).toHaveLength(1)
    expect(remoteLoads(page("<script src='https://cdn.example.com/a.js'></script>"))).toHaveLength(1)
    expect(remoteLoads(page('<script src=https://cdn.example.com/a.js></script>'))).toHaveLength(1)
    expect(remoteLoads(page('<script src="//cdn.example.com/a.js"></script>'))).toHaveLength(1)
    expect(remoteLoads(page('<script async src = "http://cdn.example.com/a.js"></script>'))).toHaveLength(1)
  })

  it('flags a remote stylesheet whatever its rel or quotes', () => {
    expect(remoteLoads(page('', '<link rel="stylesheet" href="https://x.example.com/a.css">'))).toHaveLength(1)
    expect(remoteLoads(page('', "<link rel='stylesheet' href='https://x.example.com/a.css'>"))).toHaveLength(1)
    expect(remoteLoads(page('', '<link rel="preload stylesheet" as="style" href="//x.example.com/a.css">'))).toHaveLength(1)
    expect(remoteLoads(page('', '<link href="https://x.example.com/a.css" rel="preload">'))).toHaveLength(1)
    expect(remoteLoads(page('', '<link href="https://x.example.com/a.css">'))).toHaveLength(1)
  })

  it('flags images, frames, sources, srcset and poster', () => {
    expect(remoteLoads(page('<img src="https://x.example.com/a.png">'))).toHaveLength(1)
    expect(remoteLoads(page('<iframe src="//x.example.com/"></iframe>'))).toHaveLength(1)
    expect(remoteLoads(page('<picture><source srcset="/a.png 1x, https://x.example.com/b.png 2x"></picture>'))).toHaveLength(1)
    expect(remoteLoads(page('<img srcset="//x.example.com/a.png 1x" src="/a.png">'))).toHaveLength(1)
    expect(remoteLoads(page('<video poster="https://x.example.com/p.png"></video>'))).toHaveLength(1)
    expect(remoteLoads(page('<svg><use href="https://x.example.com/s.svg#a"></use></svg>'))).toHaveLength(1)
  })

  it('flags @import and url() with a host in a style block or attribute', () => {
    expect(remoteLoads(page('', '<style>@import "https://x.example.com/a.css";</style>'))).toHaveLength(1)
    expect(remoteLoads(page('', "<style>@import url('//x.example.com/a.css');</style>"))).toHaveLength(1)
    expect(remoteLoads(page('', '<style>a{background:url(https://x.example.com/a.png)}</style>'))).toHaveLength(1)
    expect(remoteLoads(page('<p style="background: url(&quot;https://x.example.com/a.png&quot;)">x</p>'))).toHaveLength(1)
  })

  it('passes what the built pages legitimately hold', () => {
    const ok = page(
      [
        '<a href="https://example.com/">An external site</a>',
        '<a href="//example.com/">Another</a>',
        '<img src="/_astro/a.webp" srcset="/_astro/a.webp 1x, /_astro/b.webp 2x">',
        '<script type="module" src="/_astro/a.js"></script>',
        '<script>const u = "<img src=\\"https://x.example.com/a.png\\">"</script>',
        '<p style="--depth: 0; font-family: &quot;A&quot;">x</p>'
      ].join(''),
      [
        '<link rel="canonical" href="https://docs.zumibot.example.com/a/">',
        '<link rel="sitemap" href="/sitemap-index.xml">',
        '<link rel="alternate" hreflang="en" href="https://docs.zumibot.example.com/a/">',
        '<link rel="stylesheet" href="/_astro/a.css">',
        '<link rel="icon" href="/favicon.png">',
        '<style>a{background:url(/a.png)} @import "local.css";</style>'
      ].join('')
    )
    expect(remoteLoads(ok)).toEqual([])
  })

  it('does not let a canonical link hide another rel', () => {
    expect(remoteLoads(page('', '<link rel="canonical stylesheet" href="https://x.example.com/a.css">'))).toHaveLength(1)
  })
})

describe('htmlComments', () => {
  it('flags a comment in the page', () => {
    expect(htmlComments(page('<p>hi</p><!-- a note -->'))).toHaveLength(1)
    expect(htmlComments(page('<!-- one --><p>x</p><!-- two -->'))).toHaveLength(2)
  })

  it('passes a page with none, and text inside a script', () => {
    expect(htmlComments(page('<p>hi</p>'))).toEqual([])
    expect(htmlComments(page('<script>const s = "<!-- not markup -->"</script>'))).toEqual([])
  })
})
