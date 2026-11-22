import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, '..', '..', 'src', 'http', 'login')
const html = readFileSync(join(dir, 'setup.html'), 'utf8')
const js = readFileSync(join(dir, 'setup.js'), 'utf8')

describe('setup page', () => {
  it('stays CSP-clean: no inline script, style or handlers', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/\sstyle=|\sonclick=|\sonload=/i)
  })

  it('has a panel for every step the wizard walks', () => {
    for (const id of ['panel-code', 'panel-password', 'panel-totp', 'panel-recovery', 'panel-check', 'panel-done']) {
      expect(html, id).toContain(`id="${id}"`)
    }
    // Only the code panel is visible before the script runs.
    expect(html).toMatch(/id="panel-password" class="panel" hidden/)
    expect(html).toMatch(/id="panel-totp" class="panel" hidden/)
  })

  it('shares the login page tokens instead of copying them again', () => {
    expect(html).toContain('href="/login.css"')
    expect(html).toContain('href="/setup.css"')
  })

  it('never keeps the one-time code anywhere but a variable', () => {
    expect(js).not.toMatch(/localStorage|sessionStorage|document\.cookie/)
  })

  it('says the recovery codes are shown once', () => {
    expect(html).toMatch(/shown only this once/)
  })

  it('tells the operator where the server printed the code', () => {
    expect(html).toContain('journalctl -u zumibot')
    expect(html).toContain('docker compose logs zumibot')
  })

  it('waits for the app before sending the browser to the sign-in page', () => {
    expect(js).toMatch(/waitForApp/)
    expect(js).toMatch(/location\.replace\('\/login'\)/)
  })
})
