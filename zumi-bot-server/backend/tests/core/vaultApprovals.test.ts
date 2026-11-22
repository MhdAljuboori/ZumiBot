import { describe, expect, it, vi } from 'vitest'
import type { VaultApprovalRequest } from '@zumibot/shared/vault'
import { VaultApprovals } from '../../src/core/vault/vaultApprovals'
import { browserVaultOf } from '../../src/core/vault/browserVault'

const base = {
  chatId: 'chat1',
  turnId: 'turn1',
  profileId: 'profile1',
  itemId: 'item1',
  itemName: 'Work Visa',
  label: 'Visa •4242',
  site: 'shop.example.com',
  frameSite: 'shop.example.com'
}

function make() {
  let n = 0
  const approvals = new VaultApprovals({ now: () => 1000, newId: () => `req${++n}` })
  const seen: VaultApprovalRequest[] = []
  approvals.registerTurn('turn1', async (r) => {
    seen.push(r)
  })
  return { approvals, seen }
}

describe('VaultApprovals', () => {
  it('resolves allow and deny by answer', async () => {
    const { approvals, seen } = make()
    const ctl = new AbortController()
    const first = approvals.request(base, ctl.signal)
    expect(seen).toEqual([expect.objectContaining({ id: 'req1', status: 'pending', itemName: 'Work Visa' })])
    expect(approvals.pendingId('profile1')).toBe('req1')
    await approvals.answer('chat1', 'req1', 'allow')
    expect(await first).toBe('allow')
    expect(seen.at(-1)).toMatchObject({ id: 'req1', status: 'allowed' })
    expect(approvals.pendingId('profile1')).toBeNull()

    const second = approvals.request(base, ctl.signal)
    await approvals.answer('chat1', 'req2', 'deny')
    expect(await second).toBe('deny')
    expect(seen.at(-1)).toMatchObject({ id: 'req2', status: 'denied' })
  })

  it('a Stop resolves interrupted and publishes the final status', async () => {
    const { approvals, seen } = make()
    const ctl = new AbortController()
    const result = approvals.request(base, ctl.signal)
    ctl.abort()
    expect(await result).toBe('interrupted')
    expect(seen.map((r) => r.status)).toEqual(['pending', 'interrupted'])
    expect(approvals.pendingId('profile1')).toBeNull()
    // A signal already aborted never shows a card.
    expect(await approvals.request(base, ctl.signal)).toBe('interrupted')
    expect(seen).toHaveLength(2)
  })

  it('refuses an answer from another chat or after it ended', async () => {
    const { approvals } = make()
    const result = approvals.request(base, new AbortController().signal)
    await expect(approvals.answer('other', 'req1', 'allow')).rejects.toThrow('Stale vault request')
    await expect(approvals.answer('chat1', 'nope', 'allow')).rejects.toThrow('Stale vault request')
    expect(approvals.pendingId('profile1')).toBe('req1')
    await approvals.answer('chat1', 'req1', 'deny')
    await result
    await expect(approvals.answer('chat1', 'req1', 'allow')).rejects.toThrow('Stale vault request')
  })

  it('one pending per profile', async () => {
    const { approvals, seen } = make()
    const first = approvals.request(base, new AbortController().signal)
    // The second is told another card waits, at once and with no card of its own: nobody pressed Deny.
    expect(await approvals.request({ ...base, itemId: 'item2' }, new AbortController().signal)).toBe('pending')
    expect(seen).toHaveLength(1)
    // Another profile waits on its own.
    const other = approvals.request({ ...base, profileId: 'profile2' }, new AbortController().signal)
    expect(approvals.pendingId('profile2')).toBe('req2')
    await approvals.answer('chat1', 'req1', 'allow')
    await approvals.answer('chat1', 'req2', 'allow')
    expect(await first).toBe('allow')
    expect(await other).toBe('allow')
  })

  it('a server stop ends every waiting request interrupted, and ending the turn does too', async () => {
    const { approvals, seen } = make()
    const a = approvals.request(base, new AbortController().signal)
    await approvals.close()
    expect(await a).toBe('interrupted')
    expect(seen.at(-1)).toMatchObject({ status: 'interrupted' })
    expect(await approvals.request(base, new AbortController().signal)).toBe('interrupted')

    const live = new VaultApprovals({ now: () => 1, newId: () => 'r' })
    const got: string[] = []
    const unregister = live.registerTurn('turn1', async (r) => {
      got.push(r.status)
    })
    const b = live.request(base, new AbortController().signal)
    unregister()
    expect(await b).toBe('interrupted')
    expect(got).toEqual(['pending', 'interrupted'])
  })

  it('answers unavailable for a turn with no card callback (nobody could click), and one whose card could not be stored ends interrupted', async () => {
    const approvals = new VaultApprovals({ now: () => 1, newId: () => 'r' })
    expect(await approvals.request(base, new AbortController().signal)).toBe('unavailable')
    expect(approvals.pendingId('profile1')).toBeNull()
    approvals.registerTurn('turn1', async (r) => {
      if (r.status === 'pending') throw new Error('disk full')
    })
    expect(await approvals.request(base, new AbortController().signal)).toBe('interrupted')
  })

  it('logs a failed card store by an error code only when it looks like one, never a path', async () => {
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a)
    })
    try {
      for (const code of ['ENOSPC', '/home/u/.local/share/zumibot/chats/x.json', 'EACCES: open /home/u/x', 'e'.repeat(41), 42]) {
        const approvals = new VaultApprovals({ now: () => 1, newId: () => 'r' })
        approvals.registerTurn('turn1', async () => {
          throw Object.assign(new Error('failed at /home/u/secret'), { code })
        })
        expect(await approvals.request(base, new AbortController().signal)).toBe('interrupted')
      }
      const words = logged.map((a) => a.slice(1).join(' '))
      expect(new Set(words)).toEqual(new Set(['ENOSPC', 'error']))
      expect(JSON.stringify(logged)).not.toContain('/home/u')
      expect(logged.every((a) => a[0] === 'vault approval card not stored:')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("browserVaultOf (the browser manager's vault, as app.ts wires it)", () => {
  const store = { get: () => null, status: () => 'ready' as const, addApproval: async () => {}, secrets: () => ({ values: [], cards: [] }) }
  const ask = { itemId: 'item1', itemName: 'Work Visa', label: 'Visa •4242', site: 'shop.example.com', frameSite: 'js.stripe.com' }

  it("asks under the browser owner's chat, turn and profile, and tells a second card on that browser apart from a Deny", async () => {
    const { approvals, seen } = make()
    const vault = browserVaultOf(store, approvals)
    const ctl = new AbortController()
    const first = vault.approve({ ...ask, owner: { profileId: 'profile1', chatId: 'chat1', turnId: 'turn1' } }, ctl.signal)
    // The card goes to the callback ChatService registered under the owner's turn id, naming the owner's chat and profile.
    expect(seen).toEqual([{ ...ask, id: 'req1', status: 'pending', chatId: 'chat1', turnId: 'turn1', profileId: 'profile1' }])
    // Another card on the same browser while one waits: `pending` (not a Deny), and nothing new is shown.
    expect(await vault.approve({ ...ask, owner: { profileId: 'profile1', chatId: 'chat2', turnId: 'turn1' } }, ctl.signal)).toBe('pending')
    // A turn with no card callback: `unavailable`.
    expect(await vault.approve({ ...ask, owner: { profileId: 'profile2', chatId: 'chat1', turnId: 'no-turn' } }, ctl.signal)).toBe(
      'unavailable'
    )
    expect(seen).toHaveLength(1)
    await approvals.answer('chat1', 'req1', 'allow')
    expect(await first).toBe('allow')
  })

  it('passes the rest straight to the store', async () => {
    const added: string[][] = []
    const vault = browserVaultOf(
      {
        ...store,
        get: (id: string) => ({ id }) as never,
        addApproval: async (...a: string[]) => {
          added.push(a)
        },
        secrets: () => ({ values: ['v'], cards: ['4242424242424242'] })
      },
      make().approvals
    )
    expect(vault.item('x')).toEqual({ id: 'x' })
    expect(vault.status()).toBe('ready')
    await vault.addApproval('x', 'a.test', 'b.test')
    expect(added).toEqual([['x', 'a.test', 'b.test']])
    expect(vault.secrets()).toEqual({ values: ['v'], cards: ['4242424242424242'] })
  })
})
