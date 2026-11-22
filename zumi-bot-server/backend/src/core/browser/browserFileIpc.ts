import type { BrowserFileHooks } from './types'

export type BrowserFilePacket = {
  type: 'file'
  transferId: string
  sequence: number
  phase: 'begin' | 'chunk' | 'end' | 'error' | 'cleanup'
  generation?: string
  name?: string
  bytes?: Uint8Array
}
type Ack = (value?: unknown, error?: boolean) => void
type Pending = {
  sequence: number
  abort: AbortController
  answer: Ack
  deliver?: (packet: BrowserFilePacket, ack: Ack) => void
  fail?: (error: Error) => void
  endAck?: Ack
  settled?: Promise<void>
}
const unavailable = () => new Error('Browser file unavailable')

/** A single chunk can be in flight; ACK follows the sink's write, not message receipt. */
export class BrowserFileReceiver {
  private closed = false
  private transfers = new Map<string, Pending>()
  constructor(
    private files: BrowserFileHooks | undefined,
    private generation: () => string
  ) {}
  receive(raw: unknown, ack: Ack): void {
    const packet = raw as BrowserFilePacket
    if (!packet || packet.type !== 'file' || !/^[a-zA-Z0-9-]{1,128}$/.test(packet.transferId) || !Number.isSafeInteger(packet.sequence)) {
      ack(undefined, true)
      return
    }
    if (packet.phase === 'cleanup') {
      const pending = this.transfers.get(packet.transferId)
      if (!pending || packet.sequence !== -1) {
        ack(undefined, true)
        return
      }
      void this.confirm(packet.transferId, pending).then(
        () => ack(),
        () => ack(undefined, true)
      )
      return
    }
    if (packet.phase === 'begin') {
      if (
        this.closed ||
        !this.files ||
        this.transfers.has(packet.transferId) ||
        this.transfers.size >= 4 ||
        packet.sequence !== 0 ||
        packet.generation !== this.generation() ||
        typeof packet.name !== 'string' ||
        packet.name.length > 512
      ) {
        ack(undefined, true)
        return
      }
      const pending: Pending = { sequence: 0, abort: new AbortController(), answer: ack }
      this.transfers.set(packet.transferId, pending)
      const source = {
        retainsSource: true as const,
        sourceId: packet.transferId,
        [Symbol.asyncIterator]: async function* () {
          while (true) {
            if (pending.abort.signal.aborted) throw unavailable()
            const next = await new Promise<BrowserFilePacket>((resolve, reject) => {
              pending.deliver = (value, answer) => {
                pending.deliver = undefined
                pending.fail = undefined
                pending.answer = answer
                resolve(value)
              }
              pending.fail = reject
              pending.answer()
            })
            if (next.phase === 'error') throw unavailable()
            if (next.phase === 'end') {
              pending.endAck = pending.answer
              return
            }
            yield next.bytes!
          }
        }
      }
      pending.settled = this.files.download(source, packet.name, packet.generation!, pending.abort.signal).then(
        (result) => {
          pending.endAck?.(result)
        },
        () => {
          ;(pending.endAck ?? pending.answer)(undefined, true)
          pending.fail?.(unavailable())
        }
      )
      return
    }
    const pending = this.transfers.get(packet.transferId)
    if (
      !pending ||
      !pending.deliver ||
      packet.sequence !== pending.sequence + 1 ||
      !['chunk', 'end', 'error'].includes(packet.phase) ||
      (packet.phase === 'chunk' && (!(packet.bytes instanceof Uint8Array) || !packet.bytes.length || packet.bytes.length > 65536))
    ) {
      ack(undefined, true)
      if (pending) this.cancel(packet.transferId)
      return
    }
    pending.sequence = packet.sequence
    pending.deliver(packet, ack)
  }
  cancel(id: string): void {
    const pending = this.transfers.get(id)
    pending?.abort.abort()
    pending?.fail?.(unavailable())
  }
  close(): void {
    this.closed = true
    for (const id of this.transfers.keys()) this.cancel(id)
  }
  private async confirm(id: string, pending: Pending): Promise<void> {
    await pending.settled
    await this.files?.sourceClosed?.(id)
    this.transfers.delete(id)
  }
  /** Only after verified process teardown and removal of every worker scratch source. */
  async confirmClosed(): Promise<void> {
    await Promise.all([...this.transfers].map(([id, pending]) => this.confirm(id, pending)))
  }
}
