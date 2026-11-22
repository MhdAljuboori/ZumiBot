import { describe, expect, it } from 'vitest'
import type { VaultItem } from '@zumibot/shared/vault'
import { fillPlan } from '../../src/core/vault/vaultFill'
import { totpAt } from '../../src/auth/totp'

const login: VaultItem = {
  id: 'l1',
  updatedAt: 1,
  name: 'Work mail',
  agents: ['helper'],
  kind: 'login',
  sites: ['mail.example.com', '*.example.org'],
  username: 'bob@example.com',
  password: 'correct-horse',
  totp: 'JBSWY3DPEHPK3PXP'
}
const card: VaultItem = {
  id: 'c1',
  updatedAt: 1,
  name: 'Work Visa',
  agents: ['helper'],
  kind: 'card',
  holder: 'Bob Builder',
  number: '4242 4242 4242 4242',
  expiry: '07/29',
  cvc: '123',
  approved: [{ site: 'shop.example.com', frameSite: 'js.stripe.com', at: 5 }]
}
const contact = {
  id: 'p1',
  updatedAt: 1,
  name: 'Home',
  agents: ['helper'],
  kind: 'contact',
  fullName: 'Bob Builder',
  company: '',
  email: 'bob@example.com',
  phone: '+1 555',
  line1: '1 Main St',
  line2: '',
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US'
} as VaultItem
const NOW = 1_800_000_000_000

describe('fillPlan', () => {
  it("refuses another agent's item", () => {
    for (const item of [login, card, contact]) {
      const plan = fillPlan(item, 'other', 'username', NOW)
      expect(plan).toMatchObject({ ok: false, code: 'not_allowed' })
      // A refused item is never named: the agent may not know it exists.
      expect(JSON.stringify(plan)).not.toContain(item.name)
    }
    expect(fillPlan(null, 'helper', 'password', NOW)).toMatchObject({ ok: false, code: 'not_allowed' })
    expect(fillPlan({ ...login, agents: ['zumi-bot'] }, 'zumi-bot', 'password', NOW)).toMatchObject({ ok: false, code: 'not_allowed' })
  })

  it('gives card expiry parts in each format', () => {
    const value = (field: Parameters<typeof fillPlan>[2]) => {
      const p = fillPlan(card, 'helper', field, NOW)
      if (!p.ok) throw new Error(p.message)
      return p
    }
    expect(value('expiry')).toMatchObject({ value: '07/29', secret: true, target: 'input' })
    expect(value('expiryMonth')).toMatchObject({ value: '07', secret: false, target: 'inputOrSelect' })
    expect(value('expiryYear')).toMatchObject({ value: '2029', secret: false, target: 'inputOrSelect' })
    expect(value('expiryYear2')).toMatchObject({ value: '29', secret: false, target: 'inputOrSelect' })
    expect(value('number')).toMatchObject({ value: '4242424242424242', secret: true, target: 'input' })
    expect(value('cvc')).toMatchObject({ value: '123', secret: true, target: 'input' })
    expect(value('holder')).toMatchObject({ value: 'Bob Builder', secret: false, target: 'any' })
    const plan = value('number')
    expect(plan).toMatchObject({
      itemName: 'Work Visa',
      label: 'Visa •4242',
      hosts: { kind: 'card', approved: [{ site: 'shop.example.com', frameSite: 'js.stripe.com' }] }
    })
    expect(fillPlan({ ...card, expiry: '' }, 'helper', 'expiryMonth', NOW)).toMatchObject({ ok: false, code: 'no_field' })
    // A card has no password; a login has no card number.
    expect(fillPlan(card, 'helper', 'password', NOW)).toMatchObject({ ok: false, code: 'no_field' })
    expect(fillPlan(login, 'helper', 'number', NOW)).toMatchObject({ ok: false, code: 'no_field' })
  })

  it('masks every card part, the password and the code in an input, apart from what may go into a select', () => {
    const plan = (item: VaultItem, field: Parameters<typeof fillPlan>[2]) => {
      const p = fillPlan(item, 'helper', field, NOW)
      if (!p.ok) throw new Error(p.message)
      return p
    }
    for (const field of ['number', 'expiry', 'expiryMonth', 'expiryYear', 'expiryYear2', 'cvc'] as const)
      expect(plan(card, field).mask, field).toBe(true)
    for (const field of ['password', 'code'] as const) expect(plan(login, field).mask, field).toBe(true)
    // The expiry parts stay non-secret for the element rule (a select may take them), yet are masked once in an input.
    for (const field of ['expiryMonth', 'expiryYear', 'expiryYear2'] as const)
      expect(plan(card, field)).toMatchObject({ secret: false, mask: true, target: 'inputOrSelect' })
    expect(plan(card, 'holder').mask).toBe(false)
    expect(plan(login, 'username').mask).toBe(false)
    for (const field of ['fullName', 'email', 'phone', 'city'] as const) expect(plan(contact, field).mask, field).toBe(false)
  })

  it('compares every field a page may reformat loosely, and only the password exactly', () => {
    const loose = (item: VaultItem, field: Parameters<typeof fillPlan>[2]) => {
      const p = fillPlan(item, 'helper', field, NOW)
      if (!p.ok) throw new Error(p.message)
      return p.loose
    }
    for (const field of ['number', 'expiry', 'expiryMonth', 'expiryYear', 'expiryYear2', 'cvc', 'holder'] as const)
      expect(loose(card, field), field).toBe(true)
    for (const field of ['username', 'code'] as const) expect(loose(login, field), field).toBe(true)
    for (const field of ['fullName', 'email', 'phone', 'line1', 'city', 'region', 'postalCode', 'country'] as const)
      expect(loose(contact, field), field).toBe(true)
    expect(loose(login, 'password')).toBe(false)
  })

  it('gives a current TOTP code', () => {
    const p = fillPlan(login, 'helper', 'code', NOW)
    expect(p).toMatchObject({ ok: true, value: totpAt('JBSWY3DPEHPK3PXP', NOW), secret: true, target: 'input' })
    expect(fillPlan(login, 'helper', 'code', NOW + 30_000)).toMatchObject({ value: totpAt('JBSWY3DPEHPK3PXP', NOW + 30_000) })
    expect(fillPlan({ ...login, totp: null }, 'helper', 'code', NOW)).toMatchObject({ ok: false, code: 'no_field' })
    const broken = fillPlan({ ...login, totp: 'not base32!' }, 'helper', 'code', NOW)
    expect(broken).toMatchObject({ ok: false, code: 'vault_unavailable' })
    expect(JSON.stringify(broken)).not.toContain('not base32')
  })

  it('targets password fields for passwords', () => {
    expect(fillPlan(login, 'helper', 'password', NOW)).toMatchObject({
      ok: true,
      value: 'correct-horse',
      secret: true,
      target: 'password',
      itemName: 'Work mail',
      label: 'Work mail',
      hosts: { kind: 'login', sites: ['mail.example.com', '*.example.org'] }
    })
    expect(fillPlan(login, 'helper', 'username', NOW)).toMatchObject({ ok: true, value: 'bob@example.com', secret: false, target: 'any' })
    expect(fillPlan({ ...login, password: '' }, 'helper', 'password', NOW)).toMatchObject({ ok: false, code: 'no_field' })
    expect(fillPlan(contact, 'helper', 'city', NOW)).toMatchObject({
      ok: true,
      value: 'Springfield',
      secret: false,
      target: 'any',
      hosts: { kind: 'any' }
    })
    expect(fillPlan(contact, 'helper', 'company', NOW)).toMatchObject({ ok: false, code: 'no_field' })
    // A failure names the item and the field, never a value.
    const missing = fillPlan({ ...login, password: '' }, 'helper', 'password', NOW)
    expect(missing.ok === false && missing.message).toContain('Work mail')
  })
})
