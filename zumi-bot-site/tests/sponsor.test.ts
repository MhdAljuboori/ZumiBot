import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { SITE } from '../src/serverInstall.ts'
import { USDT_TRC20 } from '../src/sponsor.ts'
import viteConfig from '../vite.config.ts'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The path's `M x y h w v1 H x z` runs back into a module grid. */
function modulesOf(path: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  for (const run of path.split('z').filter((r) => r.trim() !== '')) {
    const m = /^M(\d+)[ ,](\d+)\s*h(\d+)v1H\d+$/.exec(run)
    if (!m) throw new Error(`not a QR run: ${run}`)
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])]
    for (let i = 0; i < w; i++) grid[y][x + i] = true
  }
  return grid
}

/** True when some error correction level and mask make exactly this grid from `text`. */
function encodes(grid: boolean[][], text: string): boolean {
  for (const errorCorrectionLevel of ['L', 'M', 'Q', 'H'] as const) {
    for (let mask = 0; mask < 8; mask++) {
      const qr = QRCode.create(text, { errorCorrectionLevel, maskPattern: mask as QRCode.QRCodeMaskPattern })
      if (qr.modules.size !== grid.length) continue
      if (grid.every((row, y) => row.every((on, x) => Boolean(qr.modules.get(y, x)) === on))) return true
    }
  }
  return false
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest()

/** A TRON address is base58check: version byte 0x41, a 20-byte account, then 4 bytes of double SHA-256. */
function isTronAddress(address: string): boolean {
  let n = 0n
  for (const ch of address) {
    const i = BASE58.indexOf(ch)
    if (i < 0) return false
    n = n * 58n + BigInt(i)
  }
  const bytes = Buffer.from(n.toString(16).padStart(50, '0'), 'hex')
  if (bytes.length !== 25 || bytes[0] !== 0x41) return false
  return sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4).equals(bytes.subarray(21))
}

describe('sponsor wallet', () => {
  it('is a valid TRON address', () => {
    expect(USDT_TRC20.address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/)
    expect(isTronAddress(USDT_TRC20.address)).toBe(true)
    // One changed character breaks the checksum.
    expect(isTronAddress(USDT_TRC20.address.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBe(false)
  })

  it('has a QR code that encodes exactly that address', () => {
    const grid = modulesOf(USDT_TRC20.qr, USDT_TRC20.qrSize)
    expect(encodes(grid, USDT_TRC20.address)).toBe(true)
    expect(encodes(grid, 'TQ7LtP2Bd4aBbGtvRtbfsDwVxK1c1hJ2Ff')).toBe(false)
  })
})

describe('sponsor page', () => {
  const html = readFileSync(join(site, 'sponsor.html'), 'utf8')
  const meta = (attr: 'name' | 'property', key: string): string | undefined => {
    for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
      if (new RegExp(`\\b${attr}="${key}"`).test(tag)) return tag.match(/\bcontent="([^"]*)"/)?.[1]
    }
    return undefined
  }

  it('is served at /sponsor: an html entry in the build, with clean URLs on', () => {
    // vite.config.ts builds every root *.html; the input name sets the chunk names.
    const input = viteConfig.build?.rolldownOptions?.input as Record<string, string>
    expect(input.sponsor).toBe(join(site, 'sponsor.html'))
    const vercel = JSON.parse(readFileSync(join(site, 'vercel.json'), 'utf8')) as { cleanUrls?: boolean }
    expect(vercel.cleanUrls).toBe(true)
    expect(html).toContain('src="/src/sponsorMain.tsx"')
    expect(existsSync(join(site, 'src', 'sponsorMain.tsx'))).toBe(true)
  })

  it('has its own link preview', () => {
    expect(html).toMatch(/<title>Sponsor ZumiBot<\/title>/)
    expect(meta('property', 'og:url')).toBe(`${SITE}/sponsor`)
    expect(meta('property', 'og:title')).toBe('Sponsor ZumiBot')
    expect(meta('property', 'og:image')).toBe(`${SITE}/og-image.png`)
    expect(meta('name', 'description')).toBeTruthy()
    expect(meta('property', 'og:description')).toBe(meta('name', 'description'))
  })
})
