import { describe, expect, it } from 'vitest'
import { RfbClientFilter } from '../../../src/core/desktop/rfbFilter'

const bytes = (...n: number[]) => Uint8Array.from(n)
const cat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const ascii = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'))
const fill = (len: number, v = 0) => new Uint8Array(len).fill(v)

const HANDSHAKE_IN = cat([ascii('RFB 003.008\n'), bytes(1), bytes(0)])
const HANDSHAKE_OUT = cat([ascii('RFB 003.008\n'), bytes(1), bytes(1)])

const setPixelFormat = () => cat([bytes(0, 0, 0, 0), fill(16, 7)])
const setEncodings = (n: number) => cat([bytes(2, 0, 0, n), fill(4 * n, 9)])
const fbRequest = () => bytes(3, 1, 0, 0, 0, 0, 1, 0, 1, 0)
const keyEvent = () => bytes(4, 1, 0, 0, 0, 0, 0, 65)
const pointerEvent = () => bytes(5, 1, 0, 10, 0, 20)
const cutText = (len: number) => cat([bytes(6, 0, 0, 0, ...u32(len)), fill(len, 0x61)])
const cutHeader = (lenField: number) => bytes(6, 0, 0, 0, ...u32(lenField))
const enableCU = () => bytes(150, 1, 0, 0, 0, 0, 1, 0, 1, 0)
const fence = (len: number) => cat([bytes(248, 0, 0, 0, 0, 0, 0, 3, len), fill(len, 5)])
const setDesktopSize = (n: number) => cat([bytes(251, 0, 1, 0, 1, 0, n, 0), fill(16 * n, 3)])
const xvp = () => bytes(250, 0, 1, 1)
const i32 = (n: number) => u32(n >>> 0)
const encodings = (...e: number[]) => cat([bytes(2, 0, 0, e.length), ...e.map((x) => bytes(...i32(x)))])
const EXT_MB = -316
// Extended clipboard: length field is -(4 + data bytes), then flags, then data.
const extClip = (action: number, low: number, dataLen: number, lenOverride?: number) =>
  cat([bytes(6, 0, 0, 0, ...i32(lenOverride ?? -(4 + dataLen))), bytes(action, 0, (low >>> 8) & 255, low & 255), fill(dataLen, 0x61)])
const clipCaps = (formats = 0x0001, sizes = 1) => extClip(CAPS, formats, 4 * sizes)
const CAPS = 0x01,
  REQUEST = 0x02,
  PEEK = 0x04,
  NOTIFY = 0x08,
  PROVIDE = 0x10
const qemuKey = () => bytes(255, 0, 0, 1, 0, 0, 0, 65, 0, 0, 0, 30)

const run = (input: boolean, chunks: Uint8Array[]) => {
  const f = new RfbClientFilter({ canInput: () => input })
  const fwd: Uint8Array[] = []
  let close = false
  for (const c of chunks) {
    const r = f.push(c)
    fwd.push(...r.forward)
    close = close || r.close
  }
  return { forward: cat(fwd), close }
}
const started = (input: boolean) => {
  const f = new RfbClientFilter({ canInput: () => input })
  f.push(HANDSHAKE_IN)
  return f
}

describe('RfbClientFilter handshake', () => {
  it('passes handshake and forces shared flag', () => {
    const r = run(false, [HANDSHAKE_IN])
    expect(r.close).toBe(false)
    expect(r.forward).toEqual(HANDSHAKE_OUT)
  })
  it('accepts only the 3.8 version line', () => {
    expect(run(false, [ascii('RFB 003.008\n')]).close).toBe(false)
    for (const v of ['RFB 003.003\n', 'RFB 003.007\n']) {
      const r = run(false, [ascii(v)])
      expect(r.close).toBe(true)
      expect(r.forward.length).toBe(0)
    }
  })
  it('bad protocol version closes', () => {
    for (const v of ['RFB 003.009\n', 'RFB 003.008 ', 'XFB 003.008\n', 'RFB 004.008\n']) {
      const r = run(false, [ascii(v)])
      expect(r.close).toBe(true)
      expect(r.forward.length).toBe(0)
    }
  })
  it('security type 2 closes, 0 closes', () => {
    for (const s of [2, 0, 255]) {
      const r = run(false, [ascii('RFB 003.008\n'), bytes(s)])
      expect(r.close).toBe(true)
      expect(r.forward).toEqual(ascii('RFB 003.008\n'))
    }
  })
  it('forces shared flag for any ClientInit value', () => {
    const r = run(false, [ascii('RFB 003.008\n'), bytes(1), bytes(255)])
    expect(r.forward.at(-1)).toBe(1)
  })
  it('ignores input after close', () => {
    const f = new RfbClientFilter({ canInput: () => true })
    expect(f.push(ascii('RFB 009.999\n')).close).toBe(true)
    expect(f.push(HANDSHAKE_IN)).toEqual({ forward: [], close: true })
    const g = started(true)
    expect(g.push(bytes(77)).close).toBe(true)
    expect(g.push(fbRequest())).toEqual({ forward: [], close: true })
  })
})

describe('RfbClientFilter messages', () => {
  it('forwards FramebufferUpdateRequest split across three pushes as one 10-byte chunk', () => {
    const f = started(false)
    const m = fbRequest()
    expect(f.push(m.slice(0, 3))).toEqual({ forward: [], close: false })
    expect(f.push(m.slice(3, 7))).toEqual({ forward: [], close: false })
    const r = f.push(m.slice(7))
    expect(r.close).toBe(false)
    expect(r.forward.length).toBe(1)
    expect(r.forward[0]).toEqual(m)
  })
  it('forwards non-input messages regardless of input', () => {
    for (const m of [setPixelFormat(), setEncodings(0), setEncodings(64), fbRequest(), enableCU(), fence(0), fence(64)]) {
      for (const input of [false, true]) {
        const r = started(input).push(m)
        expect(r.close).toBe(false)
        expect(cat(r.forward)).toEqual(m)
      }
    }
  })
  it('drops KeyEvent and PointerEvent without input', () => {
    const f = started(false)
    for (const m of [keyEvent(), pointerEvent(), cutText(5), qemuKey()]) {
      expect(f.push(m)).toEqual({ forward: [], close: false })
    }
    // stream stays in sync after drops
    expect(cat(f.push(fbRequest()).forward)).toEqual(fbRequest())
  })
  it('forwards them with input', () => {
    for (const m of [keyEvent(), pointerEvent(), cutText(5), cutText(0), qemuKey()]) {
      expect(cat(started(true).push(m).forward)).toEqual(m)
    }
  })
  it('PointerEvent with the extended-buttons bit closes, a plain 6-byte one does not', () => {
    for (const input of [false, true]) {
      expect(started(input).push(bytes(5, 0x80, 0, 1, 0, 1)).close).toBe(true)
      expect(started(input).push(bytes(5, 0x81, 0, 1, 0, 1, 2)).close).toBe(true)
      expect(started(input).push(bytes(5)).close).toBe(false)
      expect(started(input).push(bytes(5, 0x80)).close).toBe(true)
      expect(started(input).push(bytes(5, 0x7f, 0, 1, 0, 1)).close).toBe(false)
    }
  })
  it('SetEncodings drops -316 wherever it is and keeps the rest in order', () => {
    const E = [0, 1, 7, -239, 16]
    const cases: [number[], number[]][] = [
      [[EXT_MB, ...E], E],
      [[0, 1, EXT_MB, 7, -239, 16], E],
      [[...E, EXT_MB], E],
      [[EXT_MB], []],
      [[EXT_MB, EXT_MB, 5], [5]],
      [[], []],
      [E, E]
    ]
    for (const [inp, want] of cases) {
      for (const input of [false, true]) {
        const r = started(input).push(encodings(...inp))
        expect(r.close).toBe(false)
        expect(cat(r.forward)).toEqual(encodings(...want))
      }
    }
  })
  it('SetEncodings with -316 split at every byte offset', () => {
    const m = encodings(0, EXT_MB, 7, EXT_MB, 16)
    for (let i = 0; i <= m.length; i++) {
      const f = started(true)
      const a = f.push(m.slice(0, i)),
        b = f.push(m.slice(i))
      expect(cat([...a.forward, ...b.forward])).toEqual(encodings(0, 7, 16))
    }
    // and the following message still lines up
    const f = started(true)
    const out: Uint8Array[] = []
    for (const byte of cat([m, fbRequest()])) out.push(...f.push(bytes(byte)).forward)
    expect(cat(out)).toEqual(cat([encodings(0, 7, 16), fbRequest()]))
  })
  it('does not treat similar encodings as -316', () => {
    expect(cat(started(true).push(encodings(316, -315, -317)).forward)).toEqual(encodings(316, -315, -317))
  })
  it('canInput is checked when the message completes', () => {
    let input = true
    const f = new RfbClientFilter({ canInput: () => input })
    f.push(HANDSHAKE_IN)
    const m = pointerEvent()
    expect(f.push(m.slice(0, 3)).forward).toEqual([])
    input = false
    expect(f.push(m.slice(3))).toEqual({ forward: [], close: false })
    // and the other way round
    const m2 = pointerEvent()
    f.push(m2.slice(0, 2))
    input = true
    expect(cat(f.push(m2.slice(2)).forward)).toEqual(m2)
  })
  it('drops SetDesktopSize and xvp always', () => {
    for (const input of [false, true]) {
      const f = started(input)
      for (const m of [setDesktopSize(0), setDesktopSize(1), setDesktopSize(3), xvp()]) {
        expect(f.push(m)).toEqual({ forward: [], close: false })
      }
      expect(cat(f.push(fbRequest()).forward)).toEqual(fbRequest())
    }
  })
  it('SetEncodings count above 64 closes', () => {
    expect(started(true).push(bytes(2, 0, 0, 65)).close).toBe(true)
    expect(started(true).push(bytes(2, 0, 1, 0)).close).toBe(true)
  })
  it('ClientFence length above 64 closes', () => {
    expect(started(true).push(bytes(248, 0, 0, 0, 0, 0, 0, 0, 65)).close).toBe(true)
  })
  it('ClientCutText length bound', () => {
    const f = new RfbClientFilter({ canInput: () => true })
    f.push(HANDSHAKE_IN)
    expect(f.push(cutHeader(2 * 1024 * 1024)).close).toBe(true)
    const g = started(true)
    expect(g.push(cutHeader(1024 * 1024 + 1)).close).toBe(true)
    // at the bound it is accepted and buffered
    const h = started(true)
    expect(h.push(cutHeader(1024 * 1024))).toEqual({ forward: [], close: false })
  })
  it('ClientCutText bound is configurable and closes even without input', () => {
    const f = new RfbClientFilter({ canInput: () => false, maxCutText: 10 })
    f.push(HANDSHAKE_IN)
    expect(f.push(cutHeader(11)).close).toBe(true)
  })
  it('extended clipboard length uses absolute value', () => {
    const m = extClip(PROVIDE, 0x0001, 5)
    expect(cat(started(true).push(m).forward)).toEqual(m)
    expect(started(false).push(m)).toEqual({ forward: [], close: false })
    // -2 MiB is too big as well
    expect(started(true).push(cutHeader(-(2 * 1024 * 1024) >>> 0)).close).toBe(true)
    // 0x80000000 has no positive int32 absolute value: refuse
    expect(started(true).push(cutHeader(0x80000000)).close).toBe(true)
  })
  it('extended clipboard shorter than its flags word closes', () => {
    for (const v of [0xffffffff, 0xfffffffe, 0xfffffffd, 0xfffffffc]) {
      // |len| 1..3 cannot hold the flags; -4 (0xfffffffc) needs flags, so needs 12 bytes
      const r = started(true).push(cutHeader(v))
      expect(r.close).toBe(v !== 0xfffffffc)
    }
  })
  it('extended Caps needs |len| = 4 + 4 * formats, and is forwarded even without input', () => {
    for (const input of [false, true]) {
      for (const [formats, sizes] of [
        [0x0001, 1],
        [0x0005, 2],
        [0x000f, 4],
        [0xffff, 16],
        [0, 0]
      ] as const) {
        const m = clipCaps(formats, sizes)
        expect(cat(started(input).push(m).forward)).toEqual(m)
      }
      // wrong sizes count
      expect(started(input).push(clipCaps(0x0005, 1)).close).toBe(true)
      expect(started(input).push(clipCaps(0x0001, 2)).close).toBe(true)
      expect(started(input).push(clipCaps(0, 1)).close).toBe(true)
    }
  })
  it('extended Request, Peek and Notify need |len| = 4 and are input', () => {
    for (const action of [REQUEST, PEEK, NOTIFY]) {
      const m = extClip(action, 0x0001, 0)
      expect(cat(started(true).push(m).forward)).toEqual(m)
      expect(started(false).push(m)).toEqual({ forward: [], close: false })
      for (const extra of [1, 4, 100]) expect(started(true).push(extClip(action, 1, extra)).close).toBe(true)
    }
  })
  it('extended Provide allows 4 <= |len| <= maxCutText, and is input', () => {
    const m = extClip(PROVIDE, 0x0001, 20)
    expect(cat(started(true).push(m).forward)).toEqual(m)
    expect(started(false).push(m)).toEqual({ forward: [], close: false })
    expect(cat(started(true).push(extClip(PROVIDE, 1, 0)).forward)).toEqual(extClip(PROVIDE, 1, 0))
    const f = new RfbClientFilter({ canInput: () => true, maxCutText: 64 })
    f.push(HANDSHAKE_IN)
    expect(f.push(extClip(PROVIDE, 1, 60)).close).toBe(false)
    expect(f.push(cutHeader(-65 >>> 0)).close).toBe(true)
  })
  it('extended clipboard with an unknown or combined action closes', () => {
    for (const action of [0x00, 0x06, 0x0a, 0x12, 0x20, 0x40, 0x80, 0x14]) {
      expect(started(true).push(extClip(action, 1, 4)).close).toBe(true)
    }
  })
  it('extended clipboard split at every byte offset', () => {
    const msgs = [clipCaps(0x0005, 2), extClip(REQUEST, 1, 0), extClip(PROVIDE, 1, 9), cutText(3)]
    const stream = cat(msgs)
    for (const input of [false, true]) {
      const want = cat(msgs.filter((m, i) => input || i === 0))
      for (let i = 0; i <= stream.length; i++) {
        const f = started(input)
        const r1 = f.push(stream.slice(0, i)),
          r2 = f.push(stream.slice(i))
        expect(r1.close || r2.close).toBe(false)
        expect(cat([...r1.forward, ...r2.forward])).toEqual(want)
      }
      const g = started(input)
      const out: Uint8Array[] = []
      for (let i = 0; i < stream.length; i++) out.push(...g.push(stream.slice(i, i + 1)).forward)
      expect(cat(out)).toEqual(want)
    }
  })
  it('QEMU extended key event is input', () => {
    const m = qemuKey()
    expect(started(false).push(m)).toEqual({ forward: [], close: false })
    expect(cat(started(true).push(m).forward)).toEqual(m)
  })
  it('QEMU other subtype closes', () => {
    expect(started(true).push(bytes(255, 1)).close).toBe(true)
    expect(started(true).push(bytes(255, 255)).close).toBe(true)
  })
  it('unknown type 77 closes', () => {
    for (const t of [1, 7, 77, 149, 249, 252, 254]) {
      expect(started(true).push(bytes(t)).close).toBe(true)
    }
  })
  it('does not forward a closing message or what follows it in the same push', () => {
    const r = started(true).push(cat([fbRequest(), bytes(77), fbRequest()]))
    expect(r.close).toBe(true)
    expect(cat(r.forward)).toEqual(fbRequest())
  })
  it('does not mutate or alias caller chunks', () => {
    const f = new RfbClientFilter({ canInput: () => true })
    const hs = HANDSHAKE_IN.slice()
    const r = f.push(hs)
    expect(hs).toEqual(HANDSHAKE_IN)
    expect(cat(r.forward)).toEqual(HANDSHAKE_OUT)
    const m = fbRequest()
    const out = f.push(m).forward[0]
    m.fill(0)
    expect(out).toEqual(fbRequest())
  })
})

describe('RfbClientFilter chunking', () => {
  const messages = [
    setPixelFormat(),
    setEncodings(3),
    fbRequest(),
    keyEvent(),
    pointerEvent(),
    cutText(100),
    cutText(0),
    enableCU(),
    fence(7),
    fence(0),
    setDesktopSize(2),
    xvp(),
    qemuKey(),
    pointerEvent(),
    setEncodings(0),
    extClip(PROVIDE, 1, 10),
    setDesktopSize(0),
    keyEvent(),
    fbRequest(),
    clipCaps(0x0005, 2),
    extClip(REQUEST, 1, 0),
    encodings(EXT_MB, 0, EXT_MB, 5),
    encodings(EXT_MB),
    pointerEvent(),
    extClip(NOTIFY, 1, 0),
    extClip(PEEK, 1, 0)
  ]
  const isCaps = (m: Uint8Array) => m[0] === 6 && m[4]! >= 0x80 && (m[8]! & CAPS) !== 0
  const isInput = (m: Uint8Array) => [4, 5, 6, 255].includes(m[0]!) && !isCaps(m)
  // The model: what a correct filter forwards for each message.
  const fwdBytes = (m: Uint8Array) =>
    m[0] === 2
      ? encodings(
          ...Array.from({ length: m[3]! }, (_, i) => new DataView(m.buffer, m.byteOffset).getInt32(4 + 4 * i)).filter((e) => e !== EXT_MB)
        )
      : m
  const isDropped = (m: Uint8Array) => m[0] === 251 || m[0] === 250
  const expected = (input: boolean) =>
    cat([HANDSHAKE_OUT, ...messages.filter((m) => !isDropped(m) && (input || !isInput(m))).map(fwdBytes)])
  const stream = cat([HANDSHAKE_IN, ...messages])

  // deterministic PRNG so a failure reproduces
  const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const split = (data: Uint8Array, size: () => number) => {
    const out: Uint8Array[] = []
    for (let i = 0; i < data.length;) {
      const n = size()
      out.push(data.slice(i, i + n))
      i += n
    }
    return out
  }

  for (const input of [false, true]) {
    it(`one push gives the allowed messages only (input=${input})`, () => {
      const r = run(input, [stream])
      expect(r.close).toBe(false)
      expect(r.forward).toEqual(expected(input))
    })
    it(`1-byte chunks give the same bytes (input=${input})`, () => {
      const r = run(
        input,
        split(stream, () => 1)
      )
      expect(r.close).toBe(false)
      expect(r.forward).toEqual(expected(input))
    })
    it(`random chunk sizes give the same bytes (input=${input})`, () => {
      for (let seed = 1; seed <= 200; seed++) {
        const next = rng(seed)
        const r = run(
          input,
          split(stream, () => 1 + Math.floor(next() * 40))
        )
        expect(r.close).toBe(false)
        expect(r.forward).toEqual(expected(input))
      }
    })
    it(`every single split point gives the same bytes (input=${input})`, () => {
      for (let i = 0; i <= stream.length; i++) {
        const r = run(input, [stream.slice(0, i), stream.slice(i)])
        expect(r.close).toBe(false)
        expect(r.forward).toEqual(expected(input))
      }
    })
  }

  it('forwards only whole messages: after every push the output ends on a message boundary', () => {
    // Chunk boundaries are not part of the contract (one merged chunk per push); bytes are.
    const f = new RfbClientFilter({ canInput: () => true })
    const bounds = new Set<number>([0, 12, 13, 14])
    let total = 14
    for (const m of messages.filter((m) => !isDropped(m))) bounds.add((total += fwdBytes(m).length))
    let seen = 0
    for (const c of split(stream, () => 1)) {
      const r = f.push(c)
      expect(r.forward.length).toBeLessThanOrEqual(1)
      seen += r.forward.reduce((a, p) => a + p.length, 0)
      expect(bounds.has(seen)).toBe(true)
    }
  })

  it('closes at the same point for malformed streams under any chunking', () => {
    const bad = cat([HANDSHAKE_IN, fbRequest(), bytes(77), fbRequest()])
    for (let i = 0; i <= bad.length; i++) {
      const r = run(true, [bad.slice(0, i), bad.slice(i)])
      expect(r.close).toBe(true)
      expect(r.forward).toEqual(cat([HANDSHAKE_OUT, fbRequest()]))
    }
    expect(
      run(
        true,
        split(bad, () => 1)
      ).close
    ).toBe(true)
  })
})
