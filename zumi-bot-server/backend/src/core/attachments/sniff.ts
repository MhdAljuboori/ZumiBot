export interface ImageInfo {
  mime: string
  width: number | null
  height: number | null
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(b: Uint8Array, bytes: number[], at = 0): boolean {
  return b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v)
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = ''
  for (let i = at; i < at + len && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

const u16le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8)
const u16be = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1]
const u32le = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const u32be = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const i32le = (b: Uint8Array, at: number): number => u32le(b, at) | 0

function size(mime: string, width: number | null, height: number | null): ImageInfo {
  return { mime, width, height }
}

function webp(b: Uint8Array): ImageInfo {
  const none = size('image/webp', null, null)
  const kind = ascii(b, 12, 4)
  if (kind === 'VP8 ' && b.length >= 30 && startsWith(b, [0x9d, 0x01, 0x2a], 23)) {
    return size('image/webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff)
  }
  if (kind === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = u32le(b, 21)
    return size('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (kind === 'VP8X' && b.length >= 30) {
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
    return size('image/webp', w, h)
  }
  return none
}

function jpeg(b: Uint8Array): ImageInfo {
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    // standalone markers carry no length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= b.length) break
      return size('image/jpeg', u16be(b, i + 7), u16be(b, i + 5))
    }
    i += 2 + u16be(b, i + 2)
  }
  return size('image/jpeg', null, null)
}

/** Identifies an image by its magic bytes. Width and height are null when the bytes don't reach the size field. */
export function imageInfo(buf: Uint8Array): ImageInfo | null {
  if (startsWith(buf, PNG_SIG)) {
    if (buf.length >= 24) return size('image/png', u32be(buf, 16), u32be(buf, 20))
    return size('image/png', null, null)
  }
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') {
    if (buf.length >= 10) return size('image/gif', u16le(buf, 6), u16le(buf, 8))
    return size('image/gif', null, null)
  }
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return webp(buf)
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return jpeg(buf)
  if (ascii(buf, 0, 2) === 'BM') {
    if (buf.length >= 26) return size('image/bmp', Math.abs(i32le(buf, 18)), Math.abs(i32le(buf, 22)))
    return size('image/bmp', null, null)
  }
  return null
}
