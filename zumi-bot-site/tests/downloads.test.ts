import { describe, expect, it } from 'vitest'
import { archFromHint, byPlatform, classifyInstaller, detectVisitor, downloadsFor, firstOpen, formatSize, installersIn, isPreview, pickFor } from '../src/downloads.ts'

// The names electron-builder.yml's artifactName patterns give each build.
const FILES = [
  'ZumiBot_0.2.0_amd64.deb',
  'ZumiBot_0.2.0_x86_64.AppImage',
  'ZumiBot-Setup-0.2.0-x64.exe',
  'ZumiBot-0.2.0-x64.dmg',
  'ZumiBot-0.2.0-arm64.dmg'
]
const published = FILES.map((file, i) => ({ file, size: 100_000_000 + i }))
const all = downloadsFor('0.2.0', published)

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 15000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
}

describe('classifyInstaller', () => {
  it('knows every build electron-builder names', () => {
    expect(FILES.map((f) => classifyInstaller(f))).toEqual([
      { file: FILES[0], platform: 'linux', arch: 'x64', kind: 'deb' },
      { file: FILES[1], platform: 'linux', arch: 'x64', kind: 'AppImage' },
      { file: FILES[2], platform: 'windows', arch: 'x64', kind: 'exe' },
      { file: FILES[3], platform: 'macos', arch: 'x64', kind: 'dmg' },
      { file: FILES[4], platform: 'macos', arch: 'arm64', kind: 'dmg' }
    ])
  })

  it('refuses anything else, since a name becomes a path on disk and a URL', () => {
    for (const bad of ['../ZumiBot-0.2.0-x64.dmg', 'ZumiBot-0.2.0-x64.dmg/x', '.ZumiBot-0.2.0-x64.dmg', 'zumibot-server.tar.gz', 'ZumiBot-0.2.0-x64.dmg.blockmap', 'Other-0.2.0-x64.dmg', 'ZumiBot-0.2.0-ia32.exe'])
      expect(classifyInstaller(bad)).toBeNull()
  })
})

describe('installersIn', () => {
  it('reads sha256sum output, text or binary mode, and skips what is not an installer', () => {
    const a = 'A'.repeat(64)
    const b = 'b'.repeat(64)
    const text = `${a}  ZumiBot-0.2.0-arm64.dmg\n${b} *ZumiBot-Setup-0.2.0-x64.exe\r\n${a}  notes.txt\n${b}  ../etc/passwd\nnot a line\n`
    expect(installersIn(text)).toEqual([
      { file: 'ZumiBot-0.2.0-arm64.dmg', sha256: a.toLowerCase() },
      { file: 'ZumiBot-Setup-0.2.0-x64.exe', sha256: b }
    ])
  })

  it('keeps the first line when a name is listed twice', () => {
    expect(installersIn(`${'a'.repeat(64)}  ZumiBot-0.2.0-x64.dmg\n${'b'.repeat(64)}  ZumiBot-0.2.0-x64.dmg\n`)).toHaveLength(1)
  })
})

describe('downloadsFor', () => {
  it('orders Mac, Windows, Linux, with Apple silicon first and links into the version folder', () => {
    expect(all.map((d) => d.file)).toEqual([
      'ZumiBot-0.2.0-arm64.dmg',
      'ZumiBot-0.2.0-x64.dmg',
      'ZumiBot-Setup-0.2.0-x64.exe',
      'ZumiBot_0.2.0_amd64.deb',
      'ZumiBot_0.2.0_x86_64.AppImage'
    ])
    expect(all[0]).toMatchObject({ href: '/releases/0.2.0/ZumiBot-0.2.0-arm64.dmg', size: 100_000_004 })
  })

  it('drops unknown or broken entries, and everything for a version that is not x.y.z', () => {
    expect(downloadsFor('0.2.0', [{ file: 'evil.sh', size: 1 }, { file: FILES[0] } as never, null as never])).toEqual([])
    expect(downloadsFor('0.2.0', undefined)).toEqual([])
    expect(downloadsFor('../x', published)).toEqual([])
  })
})

describe('byPlatform', () => {
  it('keeps page order and puts the builds of one system in one group', () => {
    expect(byPlatform(all).map((g) => [g.platform, g.builds.length])).toEqual([
      ['macos', 2],
      ['windows', 1],
      ['linux', 2]
    ])
  })
})

describe('detectVisitor', () => {
  it('reads each desktop system from its user agent', () => {
    expect(detectVisitor({ userAgent: UA.mac })).toBe('macos')
    expect(detectVisitor({ userAgent: UA.windows })).toBe('windows')
    expect(detectVisitor({ userAgent: UA.linux })).toBe('linux')
  })

  it('treats phones and tablets as mobile, including an iPad that asks for the desktop site', () => {
    expect(detectVisitor({ userAgent: UA.android })).toBe('mobile')
    expect(detectVisitor({ userAgent: UA.iphone })).toBe('mobile')
    expect(detectVisitor({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe('mobile')
  })

  it('has no build for a Chromebook, and takes the client hint when there is one', () => {
    expect(detectVisitor({ userAgent: UA.chromebook })).toBe('unknown')
    expect(detectVisitor({ userAgent: 'Mozilla/5.0', platform: 'Windows' })).toBe('windows')
    expect(detectVisitor({ userAgent: 'Mozilla/5.0' })).toBe('unknown')
  })
})

describe('pickFor', () => {
  it('features Apple silicon on a Mac, Intel beside it, and the rest below', () => {
    const p = pickFor(all, 'macos')!
    expect(p.main.file).toBe('ZumiBot-0.2.0-arm64.dmg')
    expect(p.alts.map((d) => d.file)).toEqual(['ZumiBot-0.2.0-x64.dmg'])
    expect(p.others.map((d) => d.platform)).toEqual(['windows', 'linux', 'linux'])
  })

  it('features Intel when the browser says so', () => {
    expect(pickFor(all, 'macos', 'x64')!.main.file).toBe('ZumiBot-0.2.0-x64.dmg')
  })

  it('features the .deb on Linux, with the AppImage beside it', () => {
    const p = pickFor(all, 'linux')!
    expect(p.main.kind).toBe('deb')
    expect(p.alts.map((d) => d.kind)).toEqual(['AppImage'])
  })

  it('features nothing on a phone, an unknown system, or a system the release has no build for', () => {
    expect(pickFor(all, 'mobile')).toBeNull()
    expect(pickFor(all, 'unknown')).toBeNull()
    expect(pickFor(all.filter((d) => d.platform !== 'windows'), 'windows')).toBeNull()
  })

  it('still features the only build there is when the CPU does not match', () => {
    expect(pickFor(all, 'linux', 'arm64')!.main.kind).toBe('deb')
  })
})

describe('archFromHint', () => {
  it('maps Chromium hints and ignores 32-bit and unknown values', () => {
    expect(archFromHint('arm', '64')).toBe('arm64')
    expect(archFromHint('x86', '64')).toBe('x64')
    expect(archFromHint('x86', '32')).toBeNull()
    expect(archFromHint('', '')).toBeNull()
    expect(archFromHint(undefined, undefined)).toBeNull()
  })
})

describe('firstOpen', () => {
  it('names the command a Linux package needs, with its own file name', () => {
    expect(firstOpen(all.find((d) => d.kind === 'deb')!).code).toBe('sudo apt install ./ZumiBot_0.2.0_amd64.deb')
    expect(firstOpen(all.find((d) => d.kind === 'AppImage')!).code).toBe('chmod +x ZumiBot_0.2.0_x86_64.AppImage')
    expect(firstOpen(all.find((d) => d.kind === 'dmg')!).code).toBe('xattr -cr /Applications/ZumiBot.app')
    expect(firstOpen(all.find((d) => d.kind === 'exe')!).code).toBeUndefined()
  })
})

describe('isPreview', () => {
  it('tags only the macOS builds as a preview', () => {
    expect(isPreview('macos')).toBe(true)
    expect(isPreview('windows')).toBe(false)
    expect(isPreview('linux')).toBe(false)
  })
})

describe('formatSize', () => {
  it('uses decimal units', () => {
    expect(formatSize(148_400_000)).toBe('148 MB')
    expect(formatSize(1_230_000_000)).toBe('1.2 GB')
    expect(formatSize(900)).toBe('1 KB')
    expect(formatSize(-1)).toBe('')
  })
})
