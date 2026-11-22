// Renders every app icon PNG from zumibot-svg/zumi-z.svg (Zumi Bot's Z): the favicons, the PWA icons, the notification
// badge and the desktop icon (which the tray also uses). Run `npm run icons` after changing the Z or the colours below.
// Pure Node: the Z's curves are cut into short straight steps, so an even-odd scanline fill with 8x8 supersampling and a
// small PNG writer are all it needs, and the output does not depend on a browser.
import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SS = 8 // samples per axis per pixel
const BACKGROUND = [0x0d, 0x10, 0x16] // the icon set's own dark background, a blue-black
const Z_COLOR = [0x4a, 0x86, 0xff] // zumi-z's blue, the default color theme's (--bot-zumi in dark)
const WHITE = [0xff, 0xff, 0xff]

// App icons: the Z on a dark rounded square. The badge: a white Z on transparent, since Android draws a notification
// badge from its alpha alone. `onWhite`: every pixel's colour is stored already blended onto white, alpha kept, because
// Chrome's WebAPK splash drops the alpha and black clear corners turned the rounded tile into a square. `square`: no
// rounded corners, for iOS, which masks the icon itself and turns clear corners black. `ico`: one ICO of PNG frames,
// for crawlers and bookmarks that only ask for /favicon.ico.
const OUTPUTS = [
  { file: 'zumi-bot-server/frontend/public/favicon.png', size: 64, kind: 'app' },
  { file: 'zumi-bot-server/backend/src/http/login/favicon.png', size: 64, kind: 'app' },
  { file: 'zumi-bot-site/public/favicon.png', size: 64, kind: 'app' },
  { file: 'zumi-bot-site/public/favicon.ico', ico: [16, 32, 48], kind: 'app' },
  { file: 'zumi-bot-site/public/apple-touch-icon.png', size: 180, kind: 'app', square: true },
  { file: 'zumi-bot-server/frontend/public/icon-192.png', size: 192, kind: 'app', onWhite: true },
  { file: 'zumi-bot-server/frontend/public/icon-512.png', size: 512, kind: 'app', onWhite: true },
  { file: 'zumi-bot-desktop/build/icon.png', size: 512, kind: 'app' },
  { file: 'zumi-bot-server/frontend/public/badge-96.png', size: 96, kind: 'badge' }
]

/** The Z's sub-paths as polygons in its 100 box: line ends as they are, each cubic cut into 32 steps (well under a pixel
 * off the curve at 512). The source uses absolute M, L, C and Z only. */
function zumiPolygons() {
  const svg = readFileSync(join(HERE, 'zumibot-svg', 'zumi-z.svg'), 'utf8')
  const d = svg.match(/ d="([^"]+)"/)[1]
  if (/[^MLCZ\d.\s-]/.test(d)) throw new Error('zumi-z.svg uses path commands other than M, L, C and Z')
  return d
    .split('M')
    .filter((s) => s.trim())
    .map((s) => {
      const tokens = ('M' + s).match(/[MLCZ]|-?[\d.]+/g)
      const pts = []
      let cmd = ''
      for (let i = 0; i < tokens.length; ) {
        if (/[MLCZ]/.test(tokens[i])) {
          cmd = tokens[i++]
          continue
        }
        const n = (k) => Number(tokens[i + k])
        if (cmd === 'C') {
          const [x0, y0] = pts[pts.length - 1]
          for (let step = 1; step <= 32; step++) {
            const t = step / 32
            const u = 1 - t
            const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
            pts.push([w[0] * x0 + w[1] * n(0) + w[2] * n(2) + w[3] * n(4), w[0] * y0 + w[1] * n(1) + w[2] * n(3) + w[3] * n(5)])
          }
          i += 6
        } else {
          pts.push([n(0), n(1)])
          i += 2
        }
      }
      return pts
    })
}

function roundedSquare(size, r) {
  const pts = []
  const corners = [
    [size - r, r, -Math.PI / 2],
    [size - r, size - r, 0],
    [r, size - r, Math.PI / 2],
    [r, r, Math.PI]
  ]
  for (const [cx, cy, from] of corners) {
    for (let i = 0; i <= 32; i++) {
      const a = from + (i / 32) * (Math.PI / 2)
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  return [pts]
}

/** Per-pixel coverage (0..1) of the polygons under the even-odd rule. */
function coverage(polys, size) {
  const edges = polys.flatMap((p) => p.map((a, i) => [a, p[(i + 1) % p.length]]))
  const hits = new Float32Array(size * size)
  const xs = []
  for (let sy = 0; sy < size * SS; sy++) {
    const y = (sy + 0.5) / SS
    xs.length = 0
    for (const [[x0, y0], [x1, y1]] of edges) {
      if (y0 <= y !== y1 <= y) xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0))
    }
    xs.sort((a, b) => a - b)
    const row = Math.floor(sy / SS) * size
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const first = Math.max(0, Math.ceil(xs[i] * SS - 0.5))
      const last = Math.min(size * SS - 1, Math.ceil(xs[i + 1] * SS - 0.5) - 1)
      for (let sx = first; sx <= last; sx++) hits[row + Math.floor(sx / SS)]++
    }
  }
  for (let i = 0; i < hits.length; i++) hits[i] /= SS * SS
  return hits
}

/** The Z scaled so its height is `share` of the icon, centred on its own bounds. */
function placeZ(polys, size, share) {
  const all = polys.flat()
  const [minX, maxX] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))]
  const [minY, maxY] = [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))]
  const s = (share * size) / (maxY - minY)
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2]
  return polys.map((p) => p.map(([x, y]) => [(x - cx) * s + size / 2, (y - cy) * s + size / 2]))
}

function render(size, kind, z, onWhite = false, square = false) {
  const rgba = Buffer.alloc(size * size * 4)
  if (kind === 'badge') {
    const cz = coverage(placeZ(z, size, 0.84), size)
    for (let i = 0; i < cz.length; i++) {
      rgba.set(WHITE, i * 4)
      rgba[i * 4 + 3] = Math.round(cz[i] * 255)
    }
    return rgba
  }
  const tile = square ? [[[0, 0], [size, 0], [size, size], [0, size]]] : roundedSquare(size, size * 0.1875)
  const cb = coverage(tile, size)
  const cz = coverage(placeZ(z, size, 0.7), size)
  for (let i = 0; i < cb.length; i++) {
    // The Z over the square; its eyes are holes, so the square shows through them.
    const a = cz[i] + cb[i] * (1 - cz[i])
    for (let c = 0; c < 3; c++) {
      const premul = Z_COLOR[c] * cz[i] + BACKGROUND[c] * cb[i] * (1 - cz[i])
      rgba[i * 4 + c] = onWhite ? Math.round(premul + 255 * (1 - a)) : a > 0 ? Math.round(premul / a) : 0
    }
    rgba[i * 4 + 3] = Math.round(a * 255)
  }
  return rgba
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4) // filter 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** An ICO holding each PNG as a frame (PNG frames work in every browser and since Windows Vista). */
function ico(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)
  let offset = 6 + 16 * frames.length
  const entries = frames.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e[0] = size % 256 // 0 means 256
    e[1] = size % 256
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)])
}

const z = zumiPolygons()
for (const { file, size, ico: sizes, kind, onWhite, square } of OUTPUTS) {
  const out = sizes
    ? ico(sizes.map((s) => ({ size: s, data: png(s, render(s, kind, z, onWhite, square)) })))
    : png(size, render(size, kind, z, onWhite, square))
  writeFileSync(join(ROOT, file), out)
  console.log(`wrote ${file} (${sizes ? sizes.map((s) => `${s}x${s}`).join(', ') : `${size}x${size}`}, ${out.length} bytes)`)
}
