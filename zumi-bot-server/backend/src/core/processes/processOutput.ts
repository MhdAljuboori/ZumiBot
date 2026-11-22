import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { PROCESS_LOG_FILE_BYTES, PROCESS_RING_BYTES } from '@zumibot/shared/processes'

/** Where a record's output lives on disk: `<dir>/<id>.log` and its one older generation `<id>.log.1`. */
export interface LogFiles {
  current: string
  previous: string
}

/**
 * One process's output as a byte stream with cursors: a ring of the newest bytes in memory and the same bytes in a log file that
 * rotates once (current + previous), so a process holds at most two files. `base` is the cursor of the first byte still on disk;
 * `end` the cursor after the last byte produced. Writes to disk are queued; a read from disk waits for them.
 */
export class ProcessOutput {
  private ring: Buffer[] = []
  private ringBytes = 0
  private queue: Promise<void> = Promise.resolve()
  private fh: FileHandle | null = null
  private currentBytes: number
  private previousBytes: number
  private failed = false
  private closed = false

  private constructor(
    private readonly files: LogFiles,
    public base: number,
    public end: number,
    currentBytes: number,
    previousBytes: number,
    private readonly opts: { ringBytes: number; fileBytes: number; onRotate(base: number): void; onError(code: string): void }
  ) {
    this.currentBytes = currentBytes
    this.previousBytes = previousBytes
  }

  /**
   * Opens the output of a record: a new one (base and end 0), or one already on disk whose cursors are read from the file sizes, so
   * an index written before a crash still lines the cursors up with what the files hold.
   */
  static async open(
    files: LogFiles,
    base: number,
    o: Partial<{ ringBytes: number; fileBytes: number }> & { onRotate(base: number): void; onError(code: string): void }
  ): Promise<ProcessOutput> {
    const size = async (p: string) => {
      try {
        return (await stat(p)).size
      } catch {
        return 0
      }
    }
    const prev = await size(files.previous),
      cur = await size(files.current)
    return new ProcessOutput(files, base, base + prev + cur, cur, prev, {
      ringBytes: o.ringBytes ?? PROCESS_RING_BYTES,
      fileBytes: o.fileBytes ?? PROCESS_LOG_FILE_BYTES,
      onRotate: o.onRotate,
      onError: o.onError
    })
  }

  /** The cursor of the oldest byte the ring holds. */
  get ringStart(): number {
    return this.end - this.ringBytes
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0 || this.closed) return
    this.end += chunk.length
    this.ring.push(chunk)
    this.ringBytes += chunk.length
    while (this.ringBytes - this.ring[0].length >= this.opts.ringBytes) this.ringBytes -= this.ring.shift()!.length
    if (this.ringBytes > this.opts.ringBytes) {
      // Keep exactly the newest ringBytes: the head chunk is cut, so the ring's start is still a byte cursor.
      const over = this.ringBytes - this.opts.ringBytes
      this.ring[0] = this.ring[0].subarray(over)
      this.ringBytes -= over
    }
    this.queue = this.queue.then(() => this.write(chunk))
  }

  private async write(chunk: Buffer): Promise<void> {
    if (this.failed) return
    try {
      if (this.currentBytes + chunk.length > this.opts.fileBytes && this.currentBytes > 0) await this.rotate()
      this.fh ??= await open(this.files.current, 'a', 0o600)
      await this.fh.write(chunk)
      this.currentBytes += chunk.length
    } catch (err) {
      // A full disk keeps the ring: the process goes on, its file stops growing. The code only: paths stay out of logs.
      this.failed = true
      const code = (err as { code?: unknown } | null)?.code
      this.opts.onError(typeof code === 'string' ? code : 'error')
    }
  }

  private async rotate(): Promise<void> {
    await this.fh?.close()
    this.fh = null
    await rename(this.files.current, this.files.previous)
    this.base += this.previousBytes
    this.previousBytes = this.currentBytes
    this.currentBytes = 0
    this.opts.onRotate(this.base)
  }

  /** Bytes [from, from + max) of the stream, as much as is still held, with the cursor the text really starts at. */
  async read(from: number, max: number): Promise<{ bytes: Buffer; from: number; to: number; dropped: number }> {
    const want = Math.max(0, Math.min(from, this.end))
    if (want >= this.ringStart) return { ...this.fromRing(want, max), dropped: 0 }
    await this.queue
    const start = Math.max(want, this.base)
    const dropped = start - want
    const stop = Math.min(start + max, this.end)
    const parts: Buffer[] = []
    // The previous file holds [base, base + previousBytes), the current one the rest up to the bytes written.
    const prevEnd = this.base + this.previousBytes
    if (start < prevEnd) parts.push(await readRange(this.files.previous, start - this.base, Math.min(stop, prevEnd) - start))
    if (stop > prevEnd) {
      const s = Math.max(start, prevEnd)
      parts.push(await readRange(this.files.current, s - prevEnd, stop - s))
    }
    const bytes = Buffer.concat(parts)
    // A short read (a file the disk would not write) ends where the bytes do; the ring covers the rest on the next read.
    return { bytes, from: start, to: start + bytes.length, dropped }
  }

  private fromRing(from: number, max: number): { bytes: Buffer; from: number; to: number } {
    const all = Buffer.concat(this.ring)
    const at = from - this.ringStart
    const bytes = all.subarray(at, at + max)
    return { bytes, from, to: from + bytes.length }
  }

  /** The newest `max` bytes. */
  tail(max: number): Promise<{ bytes: Buffer; from: number; to: number; dropped: number }> {
    return this.read(Math.max(0, this.end - max), max)
  }

  /** Waits for every queued write and closes the file. Later pushes are ignored. */
  async close(): Promise<void> {
    this.closed = true
    await this.queue
    await this.fh?.close().catch(() => {})
    this.fh = null
  }

  static async remove(files: LogFiles): Promise<void> {
    await rm(files.current, { force: true })
    await rm(files.previous, { force: true })
  }
}

async function readRange(path: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0)
  let fh: FileHandle | null = null
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    await fh?.close().catch(() => {})
  }
}
