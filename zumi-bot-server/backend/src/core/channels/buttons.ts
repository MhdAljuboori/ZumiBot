// Opaque button tokens: a button carries a random id the server issued, never the action itself, so a forged or replayed
// press can only name a token this server handed out. In memory only; tokens never reach a log.

export type ButtonAction =
  | { kind: 'newChat'; agent: string }
  | { kind: 'openChat'; chatId: string }
  | { kind: 'sendFile'; chatId: string; path: string; snapshot: string; name: string }
  // A card's button: which card (chat and request), and what this button does. The answer is looked up from it, never carried.
  | { kind: 'card'; key: string; act: CardAct; q?: number; o?: number }

export type CardAct = 'allow' | 'deny' | 'approve' | 'keep' | 'pick' | 'toggle' | 'done' | 'type'

interface Entry {
  conv: string
  action: ButtonAction
  group: string
  at: number
  once: boolean
}

export const BUTTON_TTL_MS = 24 * 60 * 60_000
const KEPT = 5000

export class ButtonTokens {
  private map = new Map<string, Entry>()

  constructor(private readonly o: { random: () => string; now: () => number }) {}

  /** A token for one button of `group` (one message's keyboard); `once`: the first press burns the whole group. */
  issue(conv: string, group: string, action: ButtonAction, once: boolean): string {
    const token = this.o.random()
    this.map.set(token, { conv, action, group, at: this.o.now(), once })
    if (this.map.size > KEPT) this.map.delete(this.map.keys().next().value as string)
    return token
  }

  /** Every token of a group stops working (a card answered anywhere). */
  burn(group: string): void {
    for (const [k, v] of this.map) if (v.group === group) this.map.delete(k)
  }

  /** The action of a press, or null: unknown, expired, used, or pressed in another conversation than it was sent to. */
  take(conv: string, token: string): ButtonAction | null {
    const e = this.map.get(token)
    if (!e || e.conv !== conv) return null
    if (this.o.now() - e.at > BUTTON_TTL_MS) {
      this.map.delete(token)
      return null
    }
    if (e.once) for (const [k, v] of this.map) if (v.group === e.group) this.map.delete(k)
    return e.action
  }
}
