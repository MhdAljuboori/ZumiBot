// The desktop installers: which file is which, which one this visitor wants, and how to name them. Plain, erasable-only
// TypeScript, since scripts/fetchRelease.mjs imports it as is; pure, so tests/downloads.test.ts can check it.

// The checksum list electron-build.yml attaches to the release after the installers. Only files it lists are published.
export const INSTALLER_SUMS = 'SHA256SUMS-desktop'

export type Platform = 'macos' | 'windows' | 'linux'
export type Arch = 'x64' | 'arm64'
export type Kind = 'dmg' | 'exe' | 'deb' | 'AppImage'

export interface Installer {
  file: string
  platform: Platform
  arch: Arch
  kind: Kind
}

/** One installer as release.json carries it: the file name (the folder is the release's version) and its size. */
export interface PublishedInstaller {
  file: string
  size: number
}

export interface Download extends Installer {
  href: string // a path on this site
  size: number
}

const PLATFORM_OF: Record<Kind, Platform> = { dmg: 'macos', exe: 'windows', deb: 'linux', AppImage: 'linux' }
const ARCH_OF: Record<string, Arch> = { x64: 'x64', amd64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64' }

// electron-builder.yml's artifactName patterns: ZumiBot_<v>_<arch>.deb|AppImage, ZumiBot-Setup-<v>-<arch>.exe,
// ZumiBot-<v>-<arch>.dmg. A name becomes a file on disk and a URL, so anything else (a slash, a dotfile) is refused.
const NAME = /^ZumiBot[-_](?:Setup-)?\d+\.\d+\.\d+[-_](x64|amd64|x86_64|arm64|aarch64)\.(dmg|exe|deb|AppImage)$/

/** What an installer file is, or null for any name that is not one of ours. */
export function classifyInstaller(file: string): Installer | null {
  const m = NAME.exec(file)
  if (!m) return null
  const kind = m[2] as Kind
  return { file, platform: PLATFORM_OF[kind], arch: ARCH_OF[m[1]], kind }
}

/** The installers named in a `sha256sum` list, with their hashes; other lines and names are skipped. */
export function installersIn(sums: string): { file: string; sha256: string }[] {
  const out: { file: string; sha256: string }[] = []
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+?)\r?$/.exec(line)
    if (m && classifyInstaller(m[2]) && !out.some((x) => x.file === m[2])) out.push({ file: m[2], sha256: m[1].toLowerCase() })
  }
  return out
}

const PLATFORM_ORDER: Platform[] = ['macos', 'windows', 'linux']

const KIND_ORDER: Kind[] = ['dmg', 'exe', 'deb', 'AppImage']

/** The page's list from release.json: unknown names dropped, Mac then Windows then Linux, Apple silicon first. */
export function downloadsFor(version: string, published: readonly PublishedInstaller[] | undefined): Download[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return []
  const list: Download[] = []
  for (const p of published ?? []) {
    const i = typeof p?.file === 'string' ? classifyInstaller(p.file) : null
    if (i && typeof p.size === 'number') list.push({ ...i, href: `/releases/${version}/${i.file}`, size: p.size })
  }
  const rank = (d: Download): number => PLATFORM_ORDER.indexOf(d.platform) * 100 + KIND_ORDER.indexOf(d.kind) * 10 + (d.arch === 'arm64' ? 0 : 1)
  return list.sort((a, b) => rank(a) - rank(b))
}

/** The list cut into one group per system, in page order, so a system's builds share one heading and one note. */
export function byPlatform(list: readonly Download[]): { platform: Platform; builds: Download[] }[] {
  const groups: { platform: Platform; builds: Download[] }[] = []
  for (const d of list) {
    const g = groups.find((x) => x.platform === d.platform)
    if (g) g.builds.push(d)
    else groups.push({ platform: d.platform, builds: [d] })
  }
  return groups
}

export type Visitor = Platform | 'mobile' | 'unknown'

/**
 * The visitor's system from what the browser says. Phones and tablets first: Android's agent names Linux, and an iPad
 * asks for the desktop site as a Mac (only its touch points give it away).
 */
export function detectVisitor(nav: { userAgent: string; platform?: string; maxTouchPoints?: number }): Visitor {
  const ua = nav.userAgent
  const hint = (nav.platform ?? '').toLowerCase()
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || hint === 'android' || hint === 'ios') return 'mobile'
  if (/Macintosh|Mac OS X/i.test(ua) || hint === 'macos') return (nav.maxTouchPoints ?? 0) > 1 ? 'mobile' : 'macos'
  if (/Windows/i.test(ua) || hint === 'windows') return 'windows'
  if (/CrOS/i.test(ua) || hint === 'chrome os') return 'unknown'
  if (/Linux|X11/i.test(ua) || hint === 'linux') return 'linux'
  return 'unknown'
}

export interface Pick {
  main: Download
  alts: Download[] // the same system's other builds, offered inside the featured card
  others: Download[] // everything else, in page order
}

/**
 * The featured installer for this visitor, or null when there is none for their system (a phone, an unknown system,
 * or a release without that build). A Mac gets Apple silicon unless the browser says Intel, since most Macs sold since
 * 2020 are; Linux gets the .deb, with the AppImage beside it.
 */
export function pickFor(list: readonly Download[], visitor: Visitor, arch: Arch | null = null): Pick | null {
  if (visitor === 'mobile' || visitor === 'unknown') return null
  const mine = list.filter((d) => d.platform === visitor)
  if (mine.length === 0) return null
  const prefer = arch ?? (visitor === 'macos' ? 'arm64' : 'x64')
  const main = mine.find((d) => d.arch === prefer && d.kind !== 'AppImage') ?? mine.find((d) => d.arch === prefer) ?? mine[0]
  return { main, alts: mine.filter((d) => d !== main), others: list.filter((d) => d.platform !== visitor) }
}

/** The browser's own architecture hint (Chromium's `getHighEntropyValues`), as an Arch; null when it gives none. */
export function archFromHint(architecture: unknown, bitness: unknown): Arch | null {
  if (architecture === 'arm') return bitness === '32' ? null : 'arm64'
  if (architecture === 'x86') return bitness === '32' ? null : 'x64'
  return null
}

export const PLATFORM_NAME: Record<Platform, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }

// Systems whose build has had little real use yet, so the page tags it Preview. Drop one once it has been tried for real.
const PREVIEW: readonly Platform[] = ['macos']

/** Whether a system's builds are still a preview. */
export function isPreview(platform: Platform): boolean {
  return PREVIEW.includes(platform)
}

/** "Apple silicon", "Intel", ".deb · Debian, Ubuntu": what tells two builds of one system apart. */
export function buildLabel(d: Installer): string {
  switch (d.kind) {
    case 'dmg':
      return d.arch === 'arm64' ? 'Apple silicon' : 'Intel'
    case 'exe':
      return d.arch === 'arm64' ? 'Arm' : '64-bit'
    case 'deb':
      return 'Debian, Ubuntu'
    case 'AppImage':
      return 'Any distribution'
  }
}

/**
 * What to know before the first open. The builds are unsigned for now (docs/ELECTRON_CLOUD_BUILD.md), so macOS and
 * Windows ask first; a Linux package needs a command. `code` is a command to show as code.
 */
export function firstOpen(d: Installer): { text: string; code?: string } {
  switch (d.kind) {
    case 'dmg':
      return { text: 'Not notarized yet. If macOS will not open it ("Apple could not verify" or "damaged"), run this once after moving it to Applications:', code: 'xattr -cr /Applications/ZumiBot.app' }
    case 'exe':
      return { text: 'Not signed yet, so SmartScreen asks first: choose More info, then Run anyway.' }
    case 'deb':
      return { text: 'Install it from the folder you saved it to:', code: `sudo apt install ./${d.file}` }
    case 'AppImage':
      return { text: 'Make it runnable first. It needs FUSE (libfuse2t64 on Ubuntu 24.04).', code: `chmod +x ${d.file}` }
  }
}

/** "148 MB", "1.2 GB": decimal units, as Finder and most download pages show them. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
