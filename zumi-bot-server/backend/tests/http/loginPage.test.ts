import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
