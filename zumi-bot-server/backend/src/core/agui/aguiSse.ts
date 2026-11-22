import { StringDecoder } from 'node:string_decoder'

// A hand-written reader for an AG-UI event stream, after the HTML SSE rules: LF framing, `data:` lines only, comments and
// other fields ignored. No dependency, and a cap per event so one endless line cannot fill memory.

/** One event (every line since the last blank line, comments too, the blank line itself not) passed the cap. */
export class SseTooBig extends Error {
  /** The events the same chunk completed before it: one read may carry several (Windows hands over larger reads). */
  constructor(readonly before: string[] = []) {
    super('SSE event over the size cap')
    this.name = 'SseTooBig'
  }
}

const LF = 0x0a
const CR = 0x0d

export class SseReader {
  private readonly decoder = new StringDecoder('utf8')
  private line = ''
  private data: string[] = []
  // Bytes of the event's whole lines (with their CR and LF), counted before decoding so a split character never
  // under-counts; and of the line still being read, and whether that line's last byte so far is a CR.
  private bytes = 0
  private lineBytes = 0
  private cr = false
  private first = true

  constructor(private readonly maxEventBytes: number) {}

  /** The data payloads of every event this chunk completes. Throws `SseTooBig`. */
  push(chunk: Buffer): string[] {
    const out: string[] = []
    let start = 0
    for (;;) {
      const lf = chunk.indexOf(LF, start)
      const piece = chunk.subarray(start, lf < 0 ? chunk.length : lf)
      if (piece.length > 0) {
        this.lineBytes += piece.length
        this.cr = piece[piece.length - 1] === CR
      }
      // The blank line (LF or CRLF) that dispatches is never counted. A line still open does not count a trailing CR yet:
      // it may be that blank line's.
      const blank = this.lineBytes === 0 || (this.lineBytes === 1 && this.cr)
      const size = this.bytes + (lf < 0 ? this.lineBytes - (this.cr ? 1 : 0) : blank ? 0 : this.lineBytes + 1)
      if (size > this.maxEventBytes) throw new SseTooBig(out)
      if (lf < 0) {
        this.line += this.decoder.write(piece)
        return out
      }
      this.bytes = size
      this.lineBytes = 0
      this.cr = false
      // An LF byte never sits inside a UTF-8 sequence, so the line is whole here.
      this.line += this.decoder.write(piece) + this.decoder.end()
      const payload = this.take()
      if (payload !== null) out.push(payload)
      start = lf + 1
    }
  }

  /** The stream ended: an event it ended in the middle of is discarded, as the SSE rules say. */
  end(): void {
    this.decoder.end()
    this.line = ''
    this.data = []
    this.bytes = 0
    this.lineBytes = 0
    this.cr = false
  }

  // Reads one whole line; gives the payload when it is the blank line that ends an event with data.
  private take(): string | null {
    let l = this.line
    this.line = ''
    if (this.first) {
      this.first = false
      if (l.startsWith('\uFEFF')) l = l.slice(1)
    }
    if (l.endsWith('\r')) l = l.slice(0, -1)
    if (l === '') {
      const payload = this.data.length > 0 ? this.data.join('\n') : null
      this.data = []
      this.bytes = 0
      return payload
    }
    if (l.startsWith(':')) return null
    const colon = l.indexOf(':')
    if ((colon < 0 ? l : l.slice(0, colon)) !== 'data') return null
    const value = colon < 0 ? '' : l.slice(colon + 1)
    this.data.push(value.startsWith(' ') ? value.slice(1) : value)
    return null
  }
}
