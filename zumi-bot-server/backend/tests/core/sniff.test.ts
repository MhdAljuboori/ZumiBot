import { describe, expect, it } from 'vitest'
import { imageInfo } from '../../src/core/attachments/sniff'

const u32be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u16le = (n: number): number[] => [n & 255, (n >> 8) & 255]
const u32le = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
const ascii = (s: string): number[] => [...Buffer.from(s, 'latin1')]

function pngBytes(w: number, h: number): Buffer {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(w),
    ...u32be(h),
    8,
    6,
    0,
    0,
    0
  ])
}

function riff(chunk: number[]): Buffer {
  return Buffer.from([...ascii('RIFF'), ...u32le(chunk.length + 4), ...ascii('WEBP'), ...chunk])
}

describe('imageInfo', () => {
  it('reads png size from IHDR', () => {
    expect(imageInfo(pngBytes(32, 16))).toEqual({ mime: 'image/png', width: 32, height: 16 })
  })

  it('reads gif size', () => {
    const b = Buffer.from([...ascii('GIF89a'), ...u16le(40), ...u16le(20), 0, 0, 0])
    expect(imageInfo(b)).toEqual({ mime: 'image/gif', width: 40, height: 20 })
    expect(imageInfo(Buffer.from([...ascii('GIF87a'), ...u16le(3), ...u16le(4)]))?.width).toBe(3)
  })

  it('reads webp size', () => {
    // VP8 (lossy): 3 byte frame tag, start code 9d 01 2a, then 14-bit w/h
    const vp8 = riff([...ascii('VP8 '), ...u32le(10), 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(50), ...u16le(30)])
    expect(imageInfo(vp8)).toEqual({ mime: 'image/webp', width: 50, height: 30 })
    // VP8L: signature 0x2f, then 14 bits (w-1) and 14 bits (h-1)
    const bits = (60 - 1) | ((25 - 1) << 14)
    const vp8l = riff([...ascii('VP8L'), ...u32le(5), 0x2f, ...u32le(bits)])
    expect(imageInfo(vp8l)).toEqual({ mime: 'image/webp', width: 60, height: 25 })
    // VP8X: 24-bit (w-1) at 12..14 of chunk payload, (h-1) at 15..17
    const w = 70 - 1
    const h = 35 - 1
    const vp8x = riff([
      ...ascii('VP8X'),
      ...u32le(10),
      0,
      0,
      0,
      0,
      w & 255,
      (w >> 8) & 255,
      (w >> 16) & 255,
      h & 255,
      (h >> 8) & 255,
      (h >> 16) & 255
    ])
    expect(imageInfo(vp8x)).toEqual({ mime: 'image/webp', width: 70, height: 35 })
  })

  it('reads jpeg size from the first SOF marker after an APP1 block', () => {
    const app1 = [0xff, 0xe1, 0x00, 0x08, 1, 2, 3, 4, 5, 6]
    const dht = [0xff, 0xc4, 0x00, 0x04, 0, 0]
    const sof = [0xff, 0xc0, 0x00, 0x11, 8, 0x00, 0x64, 0x00, 0xc8, 3]
    const b = Buffer.from([0xff, 0xd8, ...app1, ...dht, ...sof])
    expect(imageInfo(b)).toEqual({ mime: 'image/jpeg', width: 200, height: 100 })
  })

  it('reads bmp mime', () => {
    const b = Buffer.alloc(30)
    b.write('BM', 0, 'latin1')
    b.writeInt32LE(12, 18)
    b.writeInt32LE(-9, 22)
    expect(imageInfo(b)).toEqual({ mime: 'image/bmp', width: 12, height: 9 })
  })

  it('returns null for text bytes', () => {
    expect(imageInfo(Buffer.from('hello'))).toBeNull()
    expect(imageInfo(Buffer.alloc(0))).toBeNull()
  })

  it('gives null sizes for a truncated header', () => {
    expect(imageInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({
      mime: 'image/png',
      width: null,
      height: null
    })
  })
})
