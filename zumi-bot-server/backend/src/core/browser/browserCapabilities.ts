import { randomBytes } from 'node:crypto'
import type { BrowserOwner } from './types'

type Entry = { owner: BrowserOwner; revoked: Set<() => void> }
/** Opaque process-local grants: the caller never chooses an owner over IPC. */
export class BrowserCapabilities {
  private readonly entries = new Map<string, Entry>()
  issue(owner: BrowserOwner): { token: string; revoke(): void } {
    const token = randomBytes(32).toString('base64url')
    const entry: Entry = { owner: { ...owner }, revoked: new Set() }
    this.entries.set(token, entry)
    return {
      token,
      revoke: () => {
        if (!this.entries.delete(token)) return
        for (const callback of entry.revoked) callback()
        entry.revoked.clear()
      }
    }
  }
  resolve(token: string): BrowserOwner | null {
    const owner = this.entries.get(token)?.owner
    return owner ? { ...owner } : null
  }
  onRevoke(token: string, callback: () => void): () => void {
    const entry = this.entries.get(token)
    if (!entry) {
      callback()
      return () => {}
    }
    entry.revoked.add(callback)
    return () => {
      entry.revoked.delete(callback)
    }
  }
}
