import { describe, expect, it } from 'vitest'
import { SseReader, SseTooBig } from '../../src/core/agui/aguiSse'

const b = (s: string) => Buffer.from(s, 'utf8')

function read(chunks: (string | Buffer)[], max = 1024 * 1024): string[] {
  const r = new SseReader(max)
  const out: string[] = []
  for (const c of chunks) out.push(...r.push(typeof c === 'string' ? b(c) : c))
  r.end()
  return out
}

describe('SseReader', () => {
  it('gives one payload per event, at its blank line', () => {
    expect(read(['data: {"a":1}\n\ndata: {"b":2}\n\n'])).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('reads an event split across chunks anywhere', () => {
    expect(read(['da', 'ta: {"a"', ':1}\n', '\n'])).toEqual(['{"a":1}'])
  })

  it('drops a trailing CR (CRLF framing)', () => {
    expect(read(['data: x\r\n\r\ndata: y\r', '\n\r\n'])).toEqual(['x', 'y'])
  })

  it('keeps a UTF-8 character split across chunks whole', () => {
    const bytes = b('data: héllo ✓\n\n')
    const cut = bytes.indexOf(0xe2) + 1 // inside the 3-byte check mark
    expect(read([bytes.subarray(0, 5), bytes.subarray(5, cut), bytes.subarray(cut)])).toEqual(['héllo ✓'])
  })

  it('joins several data lines with LF', () => {
    expect(read(['data: one\ndata: two\ndata:three\n\n'])).toEqual(['one\ntwo\nthree'])
  })

  it('takes one leading space off a value, and only one', () => {
    expect(read(['data:  two spaces\n\n'])).toEqual([' two spaces'])
  })

  it('ignores comments, other fields and a blank line with no data', () => {
    expect(read([': keep-alive\n\nevent: message\nid: 7\nretry: 100\nfoo: bar\ndata: x\n\n\n\n'])).toEqual(['x'])
  })

  it('dispatches an empty data line as an empty payload', () => {
    expect(read(['data:\n\ndata\n\n'])).toEqual(['', ''])
  })

  it('drops one leading BOM, even split, and only at the start', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    expect(read([bom.subarray(0, 2), Buffer.concat([bom.subarray(2), b('data: x\n\n')])])).toEqual(['x'])
    expect(read([Buffer.concat([bom, bom, b('data: x\n\ndata: y\n\n')])])).toEqual(['y'])
  })

  it('discards an event the stream ends in the middle of', () => {
    expect(read(['data: done\n\ndata: half'])).toEqual(['done'])
    expect(read(['data: done\n\ndata: whole line\n'])).toEqual(['done'])
  })

  it('throws SseTooBig once one event passes the cap, counting bytes before decoding', () => {
    const r = new SseReader(16)
    expect(r.push(b('data: 1234567\n\n'))).toEqual(['1234567']) // 15 bytes
    expect(() => r.push(b('data: ✓✓✓✓\n'))).toThrow(SseTooBig) // 11 characters, 19 bytes
  })

  it('throws on a long line before it ends, and counts comments too', () => {
    expect(() => new SseReader(16).push(b('data: 01234567890123456789'))).toThrow(SseTooBig)
    const r = new SseReader(16)
    r.push(b(': ping\n'))
    expect(() => r.push(b(': ping\n: ping\n'))).toThrow(SseTooBig)
  })

  it('passes an event exactly at the cap and throws one byte over, never counting the blank line that ends it', () => {
    expect(new SseReader(9).push(b('data: xy\n\n'))).toEqual(['xy']) // 9 bytes of lines, then the blank line
    expect(() => new SseReader(8).push(b('data: xy\n\n'))).toThrow(SseTooBig)
    expect(new SseReader(10).push(b('data: xy\r\n\r\n'))).toEqual(['xy'])
    expect(() => new SseReader(9).push(b('data: xy\r\n\r\n'))).toThrow(SseTooBig)
    expect(new SseReader(16).push(b('data: a\ndata: b\n\n'))).toEqual(['a\nb']) // 8 + 8
    expect(() => new SseReader(15).push(b('data: a\ndata: b\n\n'))).toThrow(SseTooBig)
  })

  it('waits for the LF before counting a CR that may start the blank line', () => {
    const r = new SseReader(10)
    expect(r.push(b('data: xy\r\n\r'))).toEqual([])
    expect(r.push(b('\n'))).toEqual(['xy'])
    const open = new SseReader(9)
    expect(open.push(b('data: xy\r'))).toEqual([]) // 8 counted: the CR waits for its LF
    expect(() => open.push(b('\n'))).toThrow(SseTooBig) // the whole line is 10
  })

  it('counts each event on its own', () => {
    const r = new SseReader(16)
    for (let i = 0; i < 10; i++) expect(r.push(b('data: 1234567\n\n'))).toEqual(['1234567'])
  })
})
