import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, '..', '..', 'src', 'http', 'login')
const html = readFileSync(join(dir, 'login.html'), 'utf8')
const js = readFileSync(join(dir, 'login.js'), 'utf8')

describe('login page desktop link', () => {
  it('has a Switch server link that is hidden by default', () => {
    expect(html).toMatch(/<button[^>]*id="switch-server"[^>]*\bhidden\b[^>]*>\s*Switch server/)
  })

  it('shows it only when the desktop bridge exists, and calls switchServer()', () => {
    expect(js).toMatch(/window\.zumibotDesktop/)
    expect(js).toMatch(/switchServer\(\)/)
    expect(js).toMatch(/switch-server/)
  })

  it('stays CSP-clean: no inline script, style or handlers', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/\sstyle=|\sonclick=|\sonload=/i)
  })
})

describe('login page way back', () => {
  // The page's own function, run against a stand-in location: the script itself touches the DOM at load.
  const src = /function nextPath\(\) \{[\s\S]*?\n\}\n/.exec(js)?.[0]
  const nextFrom = (href: string): string => runInNewContext(`${src}; nextPath()`, { location: new URL(href), URL, URLSearchParams })
  it('replaces the page with nextPath() after a sign-in', () => {
    expect(src).toBeDefined()
    expect(js).toMatch(/window\.location\.replace\(nextPath\(\)\)/)
  })
  it('goes back to a path on this site', () => {
    expect(nextFrom('https://z.test/login?next=%2Fchat%2Fx%3Fpopout%3D1')).toBe('/chat/x?popout=1')
  })
  it('goes to the root for anything else', () => {
    for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example/x', 'javascript:alert(1)', '/login', '/api/x', '']) {
      expect(nextFrom(`https://z.test/login?next=${encodeURIComponent(next)}`), next).toBe('/')
    }
    expect(nextFrom('https://z.test/login')).toBe('/')
  })
})
