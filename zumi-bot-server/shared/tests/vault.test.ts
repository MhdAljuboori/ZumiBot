import { describe, expect, it } from 'vitest'
import { ZUMI_BOT_NAME } from '../src/zumiBot'
import { VAULT_FILL_FIELD_NAMES, isFillField as browserIsFillField } from '../src/browser'
import {
  CONTACT_FIELDS,
  FILL_FIELDS,
  FILL_FIELD_LABELS,
  FILL_TOOL,
  isFillField,
  SECRET_FIELDS,
  VAULT_MAX_ITEMS,
  VAULT_TOOL,
  agentView,
  cardBrand,
  cardDigits,
  cardLabel,
  envNameError,
  listView,
  luhnOk,
  normalizeSite,
  secureHost,
  siteMatches,
  totpSecretOf,
  vaultInputError,
  withVaultTools,
  type VaultInput,
  type VaultItem
} from '../src/vault'

const login: VaultItem = {
  id: 'l1',
  updatedAt: 1700000000000,
  name: 'Azure',
  agents: ['dev'],
  kind: 'login',
  sites: ['dev.azure.com'],
  username: 'ada',
  password: 'hunter22',
  totp: 'JBSWY3DPEHPK3PXP'
}
const card: VaultItem = {
  id: 'c1',
  updatedAt: 1700000000000,
  name: 'Work Visa',
  agents: ['dev'],
  kind: 'card',
  holder: 'Ada Lovelace',
  number: '4242424242424242',
  expiry: '12/30',
  cvc: '123',
  approved: [{ site: 'shop.example.com', frameSite: 'pay.example.com', at: 1 }]
}
const contact: VaultItem = {
  id: 'p1',
  updatedAt: 1700000000000,
  name: 'Home',
  agents: [],
  kind: 'contact',
  fullName: 'Ada Lovelace',
  company: 'Analytical',
  email: 'ada@example.com',
  phone: '+44 20 7946 0958',
  line1: '1 Main St',
  line2: '',
  city: 'London',
  region: 'LDN',
  postalCode: 'SW1A 1AA',
  country: 'UK'
}
const apiKey: VaultItem = {
  id: 'k1',
  updatedAt: 1700000000000,
  name: 'Azure PAT',
  agents: ['dev'],
  kind: 'apiKey',
  env: 'AZURE_DEVOPS_EXT_PAT',
  value: 'sk-test-12345678',
  description: 'Azure DevOps'
}

describe('vault rules', () => {
  it('normalizes pasted URLs, case, trailing dots and IDN', () => {
    expect(normalizeSite('https://Dev.Azure.com/org/')).toBe('dev.azure.com')
    expect(normalizeSite('Example.COM.')).toBe('example.com')
    expect(normalizeSite('bücher.de')).toBe('xn--bcher-kva.de')
    expect(normalizeSite('*.Example.com')).toBe('*.example.com')
    expect(normalizeSite('ex ample.com')).toBeNull()
  })
  it('matches exact hosts and wildcard subdomains but not the apex', () => {
    expect(siteMatches('example.com', 'example.com')).toBe(true)
    expect(siteMatches('example.com', 'www.example.com')).toBe(false)
    expect(siteMatches('*.example.com', 'a.b.example.com')).toBe(true)
    expect(siteMatches('*.example.com', 'example.com')).toBe(false)
    expect(siteMatches('*.example.com', 'badexample.com')).toBe(false)
  })
  it('accepts https and loopback hosts only', () => {
    expect(secureHost('https://shop.example.com/pay')).toBe('shop.example.com')
    expect(secureHost('http://127.0.0.1:4000/')).toBe('127.0.0.1')
    expect(secureHost('http://app.localhost/')).toBe('app.localhost')
    expect(secureHost('http://shop.example.com/')).toBeNull()
    expect(secureHost('about:blank')).toBeNull()
  })
  it('reads card digits, brand, label and Luhn', () => {
    expect(cardDigits('4242 4242-4242 4242')).toBe('4242424242424242')
    expect(cardDigits('1234')).toBeNull()
    expect(cardLabel('4242424242424242')).toBe('Visa •4242')
    expect(cardBrand('378282246310005')).toBe('Amex')
    expect(luhnOk('4242424242424241')).toBe(false)
    expect(luhnOk('4242424242424242')).toBe(true)
  })
  it('refuses bad and reserved env names', () => {
    expect(envNameError('AZURE_DEVOPS_EXT_PAT')).toBeNull()
    for (const n of ['path', '1ABC', 'ZUMIBOT_X', 'ANTHROPIC_API_KEY', 'HOME', 'XDG_DATA_HOME']) expect(envNameError(n)).not.toBeNull()
  })
  it('reads a TOTP secret from base32 or an otpauth URI', () => {
    expect(totpSecretOf('jbsw y3dp ehpk 3pxp')).toBe('JBSWY3DPEHPK3PXP')
    expect(totpSecretOf('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=y')).toBe('JBSWY3DPEHPK3PXP')
    expect(totpSecretOf('not base32!')).toBeNull()
  })
  it('refuses Zumi Bot, caps, and an env var two keys give one agent', () => {
    const key = (env: string, agents: string[]): Extract<VaultInput, { kind: 'apiKey' }> => ({
      kind: 'apiKey',
      name: 'K',
      env,
      value: 'x'.repeat(8),
      description: '',
      agents
    })
    expect(vaultInputError(key('GH_TOKEN', [ZUMI_BOT_NAME]), [])).not.toBeNull()
    expect(vaultInputError({ ...key('GH_TOKEN', []), value: 'short' }, [])).not.toBeNull()
    expect(vaultInputError({ ...key('GH_TOKEN', []), name: 'n'.repeat(101) }, [])).not.toBeNull()
    const other = { ...key('GH_TOKEN', ['a']), id: 'o', updatedAt: 1 } as VaultItem
    expect(vaultInputError(key('GH_TOKEN', ['a', 'b']), [other])).not.toBeNull()
    expect(vaultInputError(key('GH_TOKEN', ['b']), [other])).toBeNull()
  })
  it('checks logins, cards and the item cap', () => {
    const l: VaultInput = { kind: 'login', name: 'L', agents: [], sites: ['https://Example.com/x'], username: 'u', password: 'secret1' }
    expect(vaultInputError(l, [])).toBeNull()
    expect(vaultInputError({ ...l, sites: [] }, [])).not.toBeNull()
    expect(vaultInputError({ ...l, sites: ['a b'] }, [])).not.toBeNull()
    expect(vaultInputError({ ...l, sites: Array.from({ length: 11 }, (_, i) => `s${i}.com`) }, [])).not.toBeNull()
    expect(vaultInputError({ ...l, password: 'p'.repeat(1001) }, [])).not.toBeNull()
    expect(vaultInputError({ ...l, totp: 'not base32!' }, [])).not.toBeNull()
    const c: VaultInput = { kind: 'card', name: 'C', agents: [], holder: 'A', number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' }
    expect(vaultInputError(c, [])).toBeNull()
    expect(vaultInputError({ ...c, number: '1234' }, [])).not.toBeNull()
    expect(vaultInputError({ ...c, expiry: '13/30' }, [])).not.toBeNull()
    expect(vaultInputError({ ...c, number: undefined, expiry: undefined, cvc: undefined }, [])).toBeNull()
    const many = Array.from({ length: VAULT_MAX_ITEMS }, (_, i) => ({ ...apiKey, id: `m${i}`, env: `K_${i}_X` }) as VaultItem)
    expect(vaultInputError(l, many)).not.toBeNull()
    expect(vaultInputError({ ...l, id: 'm0' }, many)).toBeNull()
  })
  it('caps the 2FA secret, not the pasted otpauth link', () => {
    const l: VaultInput = { kind: 'login', name: 'L', agents: [], sites: ['example.com'], username: 'u' }
    const uri = `otpauth://totp/${'x'.repeat(200)}?secret=JBSWY3DPEHPK3PXP&issuer=${'y'.repeat(100)}`
    expect(uri.length).toBeGreaterThan(128)
    expect(vaultInputError({ ...l, totp: uri }, [])).toBeNull()
    expect(vaultInputError({ ...l, totp: 'A'.repeat(129) }, [])).not.toBeNull()
    expect(vaultInputError({ ...l, totp: 'A'.repeat(128) }, [])).toBeNull()
    expect(vaultInputError({ ...l, totp: `otpauth://totp/x?secret=${'A'.repeat(600)}` }, [])).not.toBeNull()
  })
  it('refuses an unknown kind from RPC JSON', () => {
    expect(vaultInputError({ kind: 'bogus', name: 'x', agents: [] } as unknown as VaultInput, [])).toBe('Unknown item kind.')
  })
  it('shows agents no secret', () => {
    for (const item of [login, card, contact, apiKey]) {
      const view = JSON.stringify(agentView(item))
      for (const secret of ['hunter22', '4242424242424242', '12/30', '123', 'JBSWY3DPEHPK3PXP', 'sk-test-12345678'])
        expect(view).not.toContain(secret)
    }
    expect(agentView(card)).toMatchObject({ label: 'Visa •4242', holder: 'Ada Lovelace' })
    expect(agentView(login)).toMatchObject({ hasCode: true, username: 'ada' })
    expect(agentView(contact)).toMatchObject({ email: 'ada@example.com' })
  })
  it('lists items for the UI with flags instead of secrets', () => {
    for (const item of [login, card, contact, apiKey]) {
      const view = JSON.stringify(listView(item))
      for (const secret of ['hunter22', '4242424242424242', '12/30', '"123"', 'JBSWY3DPEHPK3PXP', 'sk-test-12345678'])
        expect(view).not.toContain(secret)
    }
    expect(listView(login)).toMatchObject({ hasPassword: true, hasCode: true, workflows: false })
    expect(listView(apiKey)).toMatchObject({ hasValue: true, label: 'Azure PAT' })
    expect(listView(card)).toMatchObject({ label: 'Visa •4242', approved: card.kind === 'card' ? card.approved : [] })
  })
  it('lists whether workflows may use a login (the email trigger), as for an API key', () => {
    expect(listView({ ...login, workflows: true } as VaultItem)).toMatchObject({ kind: 'login', workflows: true })
    expect(listView({ ...apiKey, workflows: true } as VaultItem)).toMatchObject({ kind: 'apiKey', workflows: true })
    expect(agentView({ ...login, workflows: true } as VaultItem)).not.toHaveProperty('workflows')
    const l: VaultInput = { kind: 'login', name: 'Mail', agents: [], sites: ['imap.example.com'], username: 'ann', workflows: true }
    expect(vaultInputError(l, [])).toBeNull()
  })
  it('takes its fill fields from the one list in browser.ts, so the two never drift', () => {
    const names = [...VAULT_FILL_FIELD_NAMES].sort()
    // Every name in exactly one kind's list, in the right one, none missing or extra.
    expect(Object.values(FILL_FIELDS).flat().sort()).toEqual(names)
    expect(FILL_FIELDS).toEqual({
      login: ['username', 'password', 'code'],
      card: ['number', 'expiry', 'expiryMonth', 'expiryYear', 'expiryYear2', 'cvc', 'holder'],
      contact: [...CONTACT_FIELDS],
      apiKey: []
    })
    expect(Object.keys(FILL_FIELD_LABELS).sort()).toEqual(names)
    expect(FILL_FIELDS.contact).toEqual(CONTACT_FIELDS)
    // The secrets are the password, the code and the card's own parts, never a contact field.
    expect([...SECRET_FIELDS].every((f) => VAULT_FILL_FIELD_NAMES.includes(f) && !FILL_FIELDS.contact.includes(f))).toBe(true)
    // One guard: vault.ts hands on browser.ts's own, which takes only an own name of the list.
    expect(isFillField).toBe(browserIsFillField)
    for (const f of VAULT_FILL_FIELD_NAMES) expect(isFillField(f)).toBe(true)
    for (const v of ['toString', '__proto__', 'constructor', 'value', '', 1, null]) expect(isFillField(v)).toBe(false)
  })

  it('knows the fill fields and adds the vault tool to tools lists', () => {
    expect(FILL_FIELDS.login).toEqual(['username', 'password', 'code'])
    expect([...SECRET_FIELDS].sort()).toEqual(['code', 'cvc', 'expiry', 'number', 'password'])
    expect(FILL_TOOL).toBe('mcp__zumibot_browser__browser_fill_from_vault')
    expect(withVaultTools(null)).toBeNull()
    expect(withVaultTools(['Read'])).toEqual(['Read', VAULT_TOOL])
    expect(withVaultTools(['Read', VAULT_TOOL])).toEqual(['Read', VAULT_TOOL])
  })
})
