import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import { vaultCardView, vaultPending } from '../src/state/vaultApproval'

type Card = Extract<ChatItem, { type: 'vault-approval' }>
const card = (status: Card['request']['status'], over: Partial<Card['request']> = {}): Card => ({
  type: 'vault-approval',
  id: 'v',
  ts: 1,
  agent: 'web-shopper',
  request: {
    id: 'v',
    chatId: 'c',
    turnId: 't',
    profileId: 'p',
    itemId: 'i',
    itemName: 'Work Visa',
    label: 'Visa •4242',
    site: 'shop.example.com',
    frameSite: 'shop.example.com',
    status,
    ...over
  }
})

describe('vaultCardView', () => {
  it('names the agent, the item with its label and the site while pending', () => {
    expect(vaultCardView(card('pending'))).toEqual({
      agent: '@Web Shopper',
      what: 'Work Visa (Visa •4242)',
      site: 'shop.example.com',
      frame: null,
      actionable: true,
      outcome: null
    })
  })
  it('adds the card form host only when it differs from the page', () => {
    expect(vaultCardView(card('pending', { frameSite: 'js.stripe.com' })).frame).toBe('js.stripe.com')
  })
  it('reads the outcome once answered, and offers nothing then', () => {
    expect(vaultCardView(card('allowed'))).toMatchObject({ actionable: false, outcome: 'Allowed — remembered for shop.example.com' })
    expect(vaultCardView(card('denied'))).toMatchObject({ actionable: false, outcome: 'Denied' })
    expect(vaultCardView(card('interrupted'))).toMatchObject({ actionable: false, outcome: 'Interrupted' })
  })
  it('keeps the card form line after the answer', () => {
    expect(vaultCardView(card('allowed', { frameSite: 'js.stripe.com' }))).toMatchObject({
      frame: 'js.stripe.com',
      outcome: 'Allowed — remembered for shop.example.com'
    })
  })
})

describe('vaultPending', () => {
  it('counts only pending vault cards', () => {
    expect(vaultPending([card('pending'), card('allowed'), { type: 'user', id: 'u', text: 'x', ts: 1 }])).toBe(1)
  })
})
