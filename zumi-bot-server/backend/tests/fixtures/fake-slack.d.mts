export const FAKE_BOT_TOKEN: string
export const FAKE_APP_TOKEN: string
export const TEAM: string
export const BOT_USER: string
export interface SlackCall { method: string; params: any; at: number; ts?: string }
export interface FakeSlack {
  origin: string
  calls: SlackCall[]
  acks: Set<string>
  posts(): SlackCall[]
  connected(): boolean
  event(event: object, o?: { eventId?: string; retry?: number }): string
  dm(user: string, text: string, extra?: object): { ts: string; env: string }
  say(user: string, channel: string, text: string, thread?: string, extra?: object): { ts: string; env: string }
  press(user: string, channel: string, messageTs: string, value: string, thread?: string): string
  disconnect(): void
  addFile(id: string, bytes: Uint8Array): void
  fileUrl(id: string): string
  failNext(method: string, err: { status?: number; retryAfter?: number; error?: string }, times?: number): void
  waitFor(pred: (c: SlackCall) => boolean, ms?: number): Promise<SlackCall>
  close(): Promise<void>
}
export function startFakeSlack(): Promise<FakeSlack>
