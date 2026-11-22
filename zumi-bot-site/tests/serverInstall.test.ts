import { describe, expect, it } from 'vitest'
import { EXAMPLE_ORIGIN, SITE, installSteps, originFrom } from '../src/serverInstall.ts'

describe('originFrom', () => {
  it('takes a bare host or an https origin, trailing slash and case and all', () => {
    expect(originFrom('zumibot.example.com')).toBe('https://zumibot.example.com')
    expect(originFrom('  https://Zumibot.Example.com/ ')).toBe('https://zumibot.example.com')
    expect(originFrom('https://zumibot.example.com:8443')).toBe('https://zumibot.example.com:8443')
  })

  it('refuses what install.sh refuses: http, a path, a query, credentials, odd host characters', () => {
    for (const bad of [
      '',
      'http://zumibot.example.com',
      'https://zumibot.example.com/app',
      'https://zumibot.example.com?x=1',
      'https://user:pw@zumibot.example.com',
      "https://zumi'bot.example.com",
      'https://zumibot.example.com:99999',
      'localhost',
      'https://-bad.example.com'
    ])
      expect(originFrom(bad), bad).toBeNull()
  })
})

describe('installSteps', () => {
  it('downloads from this site, then passes the origin to install.sh and names its /setup', () => {
    const steps = installSteps('https://ai.example.org')
    expect(steps[0].commands[0]).toBe(`curl -fsSL ${SITE}/releases/latest/install.sh -o install.sh`)
    expect(steps.flatMap((s) => s.commands)).toContain('sh install.sh --origin https://ai.example.org')
    expect(steps.map((s) => s.title)).toContain('Open https://ai.example.org/setup')
  })

  it('never pipes the installer into a shell: download, read, run', () => {
    const all = installSteps(EXAMPLE_ORIGIN).flatMap((s) => s.commands)
    expect(all.some((c) => /\|\s*(ba)?sh\b/.test(c))).toBe(false)
    expect(all).toContain('less install.sh')
  })
})
