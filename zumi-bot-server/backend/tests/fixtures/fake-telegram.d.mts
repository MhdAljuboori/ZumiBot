export const FAKE_TOKEN: string
export const FAKE_BOT: { id: number; is_bot: true; first_name: string; username: string }
export interface FakeCall { method: string; params: any; at: number; messageId?: number }
export interface FakeTelegram {
  origin: string
  calls: FakeCall[]
  sent(): any[]
  update(u: object): number
  message(from: number, text: string, extra?: object): number
  press(from: number, msgId: number, data: string): number
  addFile(id: string, bytes: Uint8Array): void
  failNext(method: string, err: { code: number; retry_after?: number; description?: string }, times?: number): void
  waitFor(pred: (c: FakeCall) => boolean, ms?: number): Promise<FakeCall>
  close(): Promise<void>
}
export function startFakeTelegram(o?: { token?: string }): Promise<FakeTelegram>
