/** Filters one viewer's client-to-server RFB stream before it reaches Xvnc.
 *  Messages are judged whole: a watcher's input never reaches the desktop, and a
 *  message we cannot size exactly closes the viewer, since a wrong guess would
 *  let later bytes be read as a different message.
 *
 *  Depends on Xvnc running with `-SecurityTypes None` only: the viewer's single
 *  security-choice byte is checked as None, and nothing else is negotiated. */

const MAX_ENCODINGS = 64
const MAX_FENCE = 64
const DEFAULT_MAX_CUT = 1024 * 1024
// ExtendedMouseButtons makes TigerVNC >= 1.15 read a 7-byte PointerEvent, older
// versions a 6-byte one. We strip the encoding so every version reads 6 bytes.
const ENC_EXTENDED_MOUSE_BUTTONS = -316
const POINTER_EXT_BUTTONS = 0x80
// Extended clipboard actions (the top byte of the flags word).
const CLIP_CAPS = 0x01,
  CLIP_REQUEST = 0x02,
  CLIP_PEEK = 0x04,
  CLIP_NOTIFY = 0x08,
  CLIP_PROVIDE = 0x10

type Kind = 'version' | 'security' | 'init' | 'forward' | 'input' | 'drop' | 'encodings'
// need: bytes required before the length is known; close: refuse.
type Sized = { len: number; kind: Kind } | { need: number } | { close: true }

export interface RfbFilterResult {
  forward: Uint8Array[]
  close: boolean
}

const popcount16 = (n: number) => {
  let c = 0
  for (let i = 0; i < 16; i++) c += (n >>> i) & 1
  return c
}

export class RfbClientFilter {
  private state: 'version' | 'security' | 'init' | 'messages' | 'closed' = 'version'
  // A partial message: `acc` holds `have` bytes; `want` is its full length once known.
  private acc = new Uint8Array(16)
  private have = 0
  private want = 0
  private readonly canInput: () => boolean
  private readonly maxCutText: number

  constructor(o: { canInput(): boolean; maxCutText?: number }) {
    this.canInput = o.canInput
    this.maxCutText = o.maxCutText ?? DEFAULT_MAX_CUT
  }

  private get closed(): boolean {
    return this.state === 'closed'
  }

  push(chunk: Uint8Array): RfbFilterResult {
    const parts: Uint8Array[] = []
    let at = 0
    // A partial message may become complete with no bytes left in this chunk.
    while (!this.closed && (at < chunk.length || this.have > 0)) {
      if (this.have === 0) {
        const view = chunk.subarray(at)
        const s = this.size(view)
        if ('close' in s) {
          this.state = 'closed'
          break
        }
        if ('need' in s || view.length < s.len) {
          // Stash the partial; allocate the whole message once if its length is known.
          if (!('need' in s)) {
            this.acc = new Uint8Array(s.len)
            this.want = s.len
          }
          this.acc.set(view)
          this.have = view.length
          break
        }
        this.complete(view.subarray(0, s.len), s.kind, parts)
        at += s.len
        continue
      }
      if (this.want === 0) {
        // Header not complete yet: top up to what the sizer asked for.
        const s = this.size(this.acc.subarray(0, this.have))
        if ('close' in s) {
          this.state = 'closed'
          break
        }
        if ('need' in s) {
          const take = Math.min(s.need - this.have, chunk.length - at)
          if (take === 0) break
          this.acc.set(chunk.subarray(at, at + take), this.have)
          this.have += take
          at += take
          continue
        }
        if (s.len > this.acc.length) {
          const big = new Uint8Array(s.len)
          big.set(this.acc.subarray(0, this.have))
          this.acc = big
        }
        this.want = s.len
        continue
      }
      const take = Math.min(this.want - this.have, chunk.length - at)
      this.acc.set(chunk.subarray(at, at + take), this.have)
      this.have += take
      at += take
      if (this.have < this.want) break
      const msg = this.acc.subarray(0, this.want)
      const s = this.size(msg)
      this.have = 0
      this.want = 0
      this.acc = new Uint8Array(16) // msg still views the old buffer until merged
      if ('close' in s || 'need' in s) {
        this.state = 'closed'
        break
      }
      this.complete(msg, s.kind, parts)
    }
    if (this.closed) {
      this.have = 0
      this.want = 0
      this.acc = new Uint8Array(16)
    }
    return { forward: merge(parts), close: this.closed }
  }

  // A whole unit is here: decide what goes on. Copies, so callers may reuse chunks.
  private complete(msg: Uint8Array, kind: Kind, out: Uint8Array[]): void {
    switch (kind) {
      case 'version':
        if (String.fromCharCode(...msg) !== 'RFB 003.008\n') {
          this.state = 'closed'
          return
        }
        this.state = 'security'
        out.push(msg)
        return
      case 'security':
        if (msg[0] !== 1) {
          this.state = 'closed'
          return
        } // only None
        this.state = 'init'
        out.push(msg)
        return
      case 'init':
        this.state = 'messages'
        out.push(Uint8Array.of(1)) // always shared: a viewer cannot take the desktop exclusively
        return
      case 'forward':
        out.push(msg)
        return
      case 'input':
        if (this.canInput()) out.push(msg)
        return
      case 'drop':
        return
      case 'encodings':
        out.push(stripEncoding(msg))
        return
    }
  }

  private size(b: Uint8Array): Sized {
    const need = (n: number): Sized => ({ need: n })
    if (this.state === 'version') return { len: 12, kind: 'version' }
    if (this.state === 'security') return { len: 1, kind: 'security' }
    if (this.state === 'init') return { len: 1, kind: 'init' }
    const dv = () => new DataView(b.buffer, b.byteOffset, b.byteLength)
    switch (b[0]) {
      case 0:
        return { len: 20, kind: 'forward' }
      case 2: {
        if (b.length < 4) return need(4)
        const n = dv().getUint16(2)
        return n > MAX_ENCODINGS ? { close: true } : { len: 4 + 4 * n, kind: 'encodings' }
      }
      case 3:
        return { len: 10, kind: 'forward' }
      case 4:
        return { len: 8, kind: 'input' }
      case 5:
        if (b.length < 2) return need(2)
        return b[1]! & POINTER_EXT_BUTTONS ? { close: true } : { len: 6, kind: 'input' }
      case 6:
        return this.sizeCutText(b, dv)
      case 150:
        return { len: 10, kind: 'forward' }
      case 248: {
        if (b.length < 9) return need(9)
        return b[8]! > MAX_FENCE ? { close: true } : { len: 9 + b[8]!, kind: 'forward' }
      }
      case 250:
        return { len: 4, kind: 'drop' }
      case 251: {
        if (b.length < 7) return need(7)
        return { len: 8 + 16 * b[6]!, kind: 'drop' }
      }
      case 255: {
        if (b.length < 2) return need(2)
        return b[1] === 0 ? { len: 12, kind: 'input' } : { close: true }
      }
      default:
        return { close: true }
    }
  }

  private sizeCutText(b: Uint8Array, dv: () => DataView): Sized {
    if (b.length < 8) return { need: 8 }
    const field = dv().getInt32(4)
    const n = Math.abs(field)
    if (n > this.maxCutText) return { close: true }
    if (field >= 0) return { len: 8 + n, kind: 'input' }
    // Extended clipboard: TigerVNC consumes only what the action needs, so the
    // length must match it exactly or the stream would desync from ours.
    if (n < 4) return { close: true }
    if (b.length < 12) return { need: 12 }
    const flags = dv().getUint32(8)
    const action = flags >>> 24
    if (action & CLIP_CAPS) {
      // Capabilities carry no user content: forwarded even for a watcher, so
      // noVNC's reply to the server's caps does not break pasting later.
      return n === 4 + 4 * popcount16(flags & 0xffff) ? { len: 8 + n, kind: 'forward' } : { close: true }
    }
    if (action === CLIP_REQUEST || action === CLIP_PEEK || action === CLIP_NOTIFY) {
      return n === 4 ? { len: 8 + n, kind: 'input' } : { close: true }
    }
    if (action === CLIP_PROVIDE) return { len: 8 + n, kind: 'input' }
    return { close: true }
  }
}

// Copy of a whole SetEncodings message without the ExtendedMouseButtons entry.
function stripEncoding(msg: Uint8Array): Uint8Array {
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength)
  const n = dv.getUint16(2)
  const kept: number[] = []
  for (let i = 0; i < n; i++) {
    const e = dv.getInt32(4 + 4 * i)
    if (e !== ENC_EXTENDED_MOUSE_BUTTONS) kept.push(e)
  }
  const out = new Uint8Array(4 + 4 * kept.length)
  const od = new DataView(out.buffer)
  out[0] = 2
  out[1] = msg[1]!
  od.setUint16(2, kept.length)
  kept.forEach((e, i) => od.setInt32(4 + 4 * i, e))
  return out
}

// One output chunk per push; copies so the caller's chunk is never aliased.
function merge(parts: Uint8Array[]): Uint8Array[] {
  if (!parts.length) return []
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return [out]
}
