export class FakeSocket {
  static instances: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  // test helpers
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
  static reset(): void {
    FakeSocket.instances = []
  }
  static last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1]
  }
}
