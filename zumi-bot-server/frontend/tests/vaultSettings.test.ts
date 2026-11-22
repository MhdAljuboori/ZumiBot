import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '@zumibot/shared/types'
import type { VaultListItem } from '@zumibot/shared/vault'
import { vaultGrantNote } from '../src/state/agentEngine'
import {
  agentChoices,
  deleteMessage,
  draftErrors,
  draftOf,
  emptyDraft,
  groupVault,
  hasErrors,
  inputOf,
  isDraftDirty,
  keepReveal,
  keyProblem,
  keyProblemCopy,
  rowLine,
  showLabel,
  vaultErrorText
} from '../src/state/vaultSettings'

const base = { updatedAt: 1, agents: [] as string[] }
const login = (over: Partial<Extract<VaultListItem, { kind: 'login' }>> = {}): VaultListItem => ({
  ...base,
  id: 'l1',
  name: 'GitHub',
  label: 'GitHub',
  kind: 'login',
  sites: ['github.com', 'gist.github.com'],
  username: 'ann',
  hasPassword: true,
  hasCode: false,
  ...over
})
const card = (over: Partial<Extract<VaultListItem, { kind: 'card' }>> = {}): VaultListItem => ({
  ...base,
  id: 'c1',
  name: 'Work Visa',
  label: 'Visa •4242',
  kind: 'card',
  holder: 'Ann Lee',
  approved: [],
  ...over
})
const contact = (over: Partial<Extract<VaultListItem, { kind: 'contact' }>> = {}): VaultListItem => ({
  ...base,
  id: 'p1',
  name: 'Home',
  label: 'Home',
  kind: 'contact',
  fullName: 'Ann Lee',
  company: '',
  email: 'ann@example.com',
  phone: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  ...over
})
const key = (over: Partial<Extract<VaultListItem, { kind: 'apiKey' }>> = {}): VaultListItem => ({
  ...base,
  id: 'k1',
  name: 'Azure PAT',
  label: 'Azure PAT',
  kind: 'apiKey',
  env: 'AZURE_DEVOPS_EXT_PAT',
  description: '',
  hasValue: true,
  ...over
})
const agent = (name: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...over
})

describe('groupVault', () => {
  it('groups by kind in order and filters by query', () => {
    const items = [
      key(),
      contact(),
      card(),
      login(),
      login({ id: 'l2', name: 'Azure portal', label: 'Azure portal', username: 'bob', sites: ['portal.azure.com'] })
    ]
    expect(groupVault(items, '').map((g) => [g.kind, g.items.map((i) => i.id)])).toEqual([
      ['login', ['l2', 'l1']],
      ['card', ['c1']],
      ['contact', ['p1']],
      ['apiKey', ['k1']]
    ])
    // Matches the name and the row line, ignoring case; empty groups are left out.
    expect(groupVault(items, '  AZURE ').map((g) => [g.kind, g.items.map((i) => i.id)])).toEqual([
      ['login', ['l2']],
      ['apiKey', ['k1']]
    ])
    expect(groupVault(items, '4242').map((g) => g.kind)).toEqual(['card'])
    expect(groupVault(items, 'nothing')).toEqual([])
  })
})

describe('rowLine', () => {
  it('per kind', () => {
    expect(rowLine(login())).toBe('ann · github.com, gist.github.com')
    expect(rowLine(login({ username: '' }))).toBe('github.com, gist.github.com')
    expect(rowLine(card())).toBe('Visa •4242 · Ann Lee')
    expect(rowLine(card({ holder: '' }))).toBe('Visa •4242')
    expect(rowLine(contact())).toBe('ann@example.com')
    expect(rowLine(contact({ email: '' }))).toBe('')
    expect(rowLine(key())).toBe('$AZURE_DEVOPS_EXT_PAT')
  })
})

describe('drafts', () => {
  it('opens an item with every secret blank', () => {
    const d = draftOf(login({ hasPassword: true, hasCode: true, agents: ['dev'] }))
    expect(d).toMatchObject({
      kind: 'login',
      id: 'l1',
      updatedAt: 1,
      name: 'GitHub',
      username: 'ann',
      password: '',
      totp: '',
      clearTotp: false,
      agents: ['dev'],
      sitesText: 'github.com\ngist.github.com'
    })
    expect(draftOf(card())).toMatchObject({ number: '', expiry: '', cvc: '', holder: 'Ann Lee' })
    expect(draftOf(key())).toMatchObject({ value: '', env: 'AZURE_DEVOPS_EXT_PAT' })
    expect(draftOf(contact()).contact.email).toBe('ann@example.com')
  })

  it('inputOf leaves blank secrets out and normalizes sites', () => {
    const d = { ...draftOf(login()), sitesText: ' https://GitHub.com/login \n\n*.Example.org\ngithub.com\nnot a host ' }
    const input = inputOf(d)
    expect(input).toEqual({
      kind: 'login',
      id: 'l1',
      name: 'GitHub',
      agents: [],
      sites: ['github.com', '*.example.org'],
      username: 'ann',
      workflows: false
    })
    expect('password' in input).toBe(false)
    expect('totp' in input).toBe(false)
    expect(inputOf({ ...d, password: 'pw', totp: ' JBSWY3DPEHPK3PXP ' })).toMatchObject({ password: 'pw', totp: 'JBSWY3DPEHPK3PXP' })
    // Removing the 2FA secret is explicit, never a blank field.
    expect(inputOf({ ...d, clearTotp: true })).toMatchObject({ totp: null })
    const c = inputOf({ ...draftOf(card()), number: '4242 4242 4242 4242', cvc: '123' })
    expect(c).toEqual({ kind: 'card', id: 'c1', name: 'Work Visa', agents: [], holder: 'Ann Lee', number: '4242424242424242', cvc: '123' })
    expect(inputOf({ ...draftOf(key()), value: 'abcdefgh' })).toMatchObject({
      kind: 'apiKey',
      env: 'AZURE_DEVOPS_EXT_PAT',
      value: 'abcdefgh'
    })
    expect('value' in inputOf(draftOf(key()))).toBe(false)
    expect(inputOf({ ...emptyDraft('login'), name: 'New' }).id).toBeUndefined()
  })

  it("opens and saves a login's workflows switch (the email trigger), off by default", () => {
    expect(emptyDraft('login').workflows).toBe(false)
    expect(draftOf(login({ workflows: true } as Partial<Extract<VaultListItem, { kind: 'login' }>>)).workflows).toBe(true)
    expect(inputOf({ ...draftOf(login()), workflows: true })).toMatchObject({ kind: 'login', workflows: true })
    expect(
      inputOf({ ...draftOf(login({ workflows: true } as Partial<Extract<VaultListItem, { kind: 'login' }>>)), workflows: false })
    ).toMatchObject({ workflows: false })
  })

  it('trims a pasted API key, so a stray space never keeps the bare token from being scrubbed', () => {
    expect(inputOf({ ...draftOf(key()), value: '  sk-test-12345678 \n' })).toMatchObject({ value: 'sk-test-12345678' })
    // Only spaces is no key: left out, so the stored one stays.
    expect('value' in inputOf({ ...draftOf(key()), value: '   ' })).toBe(false)
    const ok = { ...emptyDraft('apiKey'), name: 'K', env: 'MY_KEY', value: ' abcdefg ' }
    // 7 characters once trimmed: too short, as the server will see it.
    expect(draftErrors(ok, []).value).toBeDefined()
    expect(draftErrors({ ...ok, value: '   ' }, []).value).toBe('Paste the key.')
  })
})

describe('draftErrors', () => {
  const ok = { ...emptyDraft('apiKey'), name: 'Other', env: 'AZURE_DEVOPS_EXT_PAT', value: 'abcdefgh', agents: ['dev'] }

  it('flags an env var another key gives the same agent', () => {
    const others = [key({ agents: ['dev', 'ops'] })]
    expect(draftErrors(ok, others).env).toMatch(/already/)
    expect(draftErrors({ ...ok, agents: ['qa'] }, others).env).toBeUndefined()
    expect(draftErrors({ ...ok, env: 'OTHER_VAR' }, others).env).toBeUndefined()
    // The item itself does not clash with its own stored copy.
    expect(draftErrors({ ...ok, id: 'k1' }, others).env).toBeUndefined()
  })

  it('asks for what the kind needs', () => {
    expect(hasErrors(draftErrors(emptyDraft('login'), []))).toBe(true)
    expect(draftErrors({ ...emptyDraft('login'), name: ' ' }, []).name).toBeDefined()
    expect(draftErrors({ ...emptyDraft('login'), name: 'x', sitesText: 'nope nope' }, []).sites).toBeDefined()
    expect(draftErrors({ ...emptyDraft('login'), name: 'x', sitesText: 'a.com', totp: 'zz' }, []).totp).toBeDefined()
    expect(draftErrors({ ...emptyDraft('apiKey'), name: 'x', env: 'path', value: 'abcdefgh' }, []).env).toBeDefined()
    expect(draftErrors({ ...ok, value: '' }, []).value).toBeDefined()
    expect(draftErrors({ ...ok, id: 'k1', value: '' }, [key()]).value).toBeUndefined()
    expect(draftErrors({ ...emptyDraft('card'), name: 'x' }, []).number).toBeDefined()
    expect(draftErrors({ ...emptyDraft('card'), name: 'x', number: '4242424242424242', expiry: '13/30', cvc: '12' }, [])).toMatchObject({
      expiry: expect.any(String),
      cvc: expect.any(String)
    })
    expect(hasErrors(draftErrors({ ...emptyDraft('contact'), name: 'Home' }, []))).toBe(false)
    expect(hasErrors(draftErrors({ ...emptyDraft('login'), name: 'x', sitesText: 'a.com' }, []))).toBe(false)
  })

  it('a failed Luhn check is a warning only', () => {
    const d = { ...emptyDraft('card'), name: 'Test', number: '4242 4242 4242 4241', expiry: '12/30', cvc: '123' }
    const e = draftErrors(d, [])
    expect(e.warning).toMatch(/check/i)
    expect(hasErrors(e)).toBe(false)
    expect(draftErrors({ ...d, number: '4242424242424242' }, []).warning).toBeUndefined()
    expect(draftErrors({ ...d, number: '', id: 'c1' }, []).warning).toBeUndefined()
  })
})

describe('agentChoices', () => {
  it('leaves out Zumi Bot and broken agents', () => {
    const agents = [agent('zed'), agent('zumi-bot', { builtIn: true }), agent('broken', { error: 'bad yaml' }), agent('alpha')]
    expect(agentChoices(agents)).toEqual(['alpha', 'zed'])
  })

  it('lists a Codex agent like any other, with no note beside it on any kind of item', () => {
    const agents = [agent('zed'), agent('cx', { provider: 'codex' }), agent('alpha')]
    expect(agentChoices(agents)).toEqual(['alpha', 'cx', 'zed'])
    for (const kind of ['login', 'card', 'contact', 'apiKey'] as const) expect(vaultGrantNote(kind, { provider: 'codex' })).toBeNull()
  })
})

describe('vaultErrorText', () => {
  it('turns the vault codes into plain sentences and passes anything else through', () => {
    expect(vaultErrorText('VAULT_CHANGED')).toBe('This item changed elsewhere. Reload and try again.')
    expect(vaultErrorText("Error invoking remote method 'x': Error: VAULT_CHANGED")).toBe(
      'This item changed elsewhere. Reload and try again.'
    )
    expect(vaultErrorText('VAULT_UNAVAILABLE')).toMatch(/key file/)
    expect(vaultErrorText('VAULT_FULL')).toMatch(/500/)
    expect(vaultErrorText('Give the item a name.')).toBe('Give the item a name.')
  })
})

describe('hasErrors', () => {
  it('blocks a save for any message but a warning', () => {
    expect(hasErrors({})).toBe(false)
    expect(hasErrors({ warning: "This card number doesn't pass the usual check." })).toBe(false)
    expect(hasErrors({ name: 'Give the item a name.' })).toBe(true)
    expect(hasErrors({ warning: 'w', cvc: 'The security code has 3 or 4 digits.' })).toBe(true)
    // A key present but unset is no error.
    expect(hasErrors({ name: undefined })).toBe(false)
    expect(hasErrors(draftErrors(emptyDraft('login'), []))).toBe(true)
    expect(hasErrors(draftErrors({ ...emptyDraft('card'), name: 'Visa', number: '4242 4242 4242 4241' }, []))).toBe(false)
  })
})

describe('isDraftDirty', () => {
  it('is true only when the form differs from the one it opened as', () => {
    const opened = draftOf(login())
    expect(isDraftDirty(opened, opened)).toBe(false)
    expect(isDraftDirty({ ...opened }, opened)).toBe(false)
    expect(isDraftDirty({ ...opened, password: 'x' }, opened)).toBe(true)
    expect(isDraftDirty({ ...opened, agents: ['a'] }, opened)).toBe(true)
    expect(isDraftDirty({ ...opened, clearTotp: true }, opened)).toBe(true)
    const contactDraft = draftOf(contact())
    expect(isDraftDirty({ ...contactDraft, contact: { ...contactDraft.contact, city: 'Oslo' } }, contactDraft)).toBe(true)
    // Typing a character and taking it back leaves nothing to save.
    expect(isDraftDirty({ ...opened, username: opened.username }, opened)).toBe(false)
    expect(isDraftDirty(emptyDraft('apiKey'), emptyDraft('apiKey'))).toBe(false)
  })
})

describe('keepReveal', () => {
  it('fills the field only from the latest Show, and never over text typed while it ran', () => {
    expect(keepReveal(3, 3, '')).toBe(true)
    // Hide, unmount or a newer request moved the counter on.
    expect(keepReveal(2, 3, '')).toBe(false)
    expect(keepReveal(3, 3, 'n')).toBe(false)
    expect(keepReveal(3, 3, 'new-password')).toBe(false)
  })
})

describe('keyProblemCopy', () => {
  it('names the key path the server reports, for a missing and a wrong key', () => {
    const missing = keyProblemCopy('keyMissing', '/srv/keys/zumibot-vault/vault.key')
    expect(missing.title).toBe('The vault key file is missing')
    expect(missing.path).toBe('/srv/keys/zumibot-vault/vault.key')
    expect(missing.hint).toContain('this path')
    const wrong = keyProblemCopy('keyMismatch', '/srv/keys/zumibot-vault/vault.key')
    expect(wrong.title).toBe('The vault key does not match')
    expect(wrong.path).toBe('/srv/keys/zumibot-vault/vault.key')
    // Never the default path when the server named another one.
    for (const c of [missing, wrong]) expect(c.hint).not.toContain('~/.config')
  })
  it('without a path, says where to look in words instead of guessing the default', () => {
    const c = keyProblemCopy('keyMissing', null)
    expect(c.path).toBeNull()
    expect(c.hint).not.toContain('this path')
    expect(c.hint).toContain('where this server looks for it')
  })
})

describe('keyProblem', () => {
  it('is true for a missing or wrong key only', () => {
    expect(keyProblem('keyMissing')).toBe(true)
    expect(keyProblem('keyMismatch')).toBe(true)
    for (const s of ['empty', 'ready', null] as const) expect(keyProblem(s)).toBe(false)
  })
})

describe('showLabel', () => {
  const twoFa = { stored: 'Show code', typed: 'Show secret' }
  it('names what Show reveals: typed text as typed, a stored value by its own label', () => {
    expect(showLabel(false, '', twoFa)).toBe('Show code')
    expect(showLabel(false, 'JBSWY3DP', twoFa)).toBe('Show secret')
    expect(showLabel(true, '', twoFa)).toBe('Hide')
    expect(showLabel(true, 'JBSWY3DP', twoFa)).toBe('Hide')
    expect(showLabel(false, 'pw', { stored: 'Show', typed: 'Show' })).toBe('Show')
  })
})

describe('deleteMessage', () => {
  it('names the item as stored, not as the form has it', () => {
    const items = [card(), login()]
    expect(deleteMessage('c1', items)).toBe("Delete Work Visa? Agents lose access. This can't be undone.")
    expect(deleteMessage('gone', items)).toBe("Delete this item? Agents lose access. This can't be undone.")
    expect(deleteMessage(undefined, items)).toBe("Delete this item? Agents lose access. This can't be undone.")
    expect(deleteMessage('c1', [card({ name: '  ' })])).toBe("Delete this item? Agents lose access. This can't be undone.")
  })
})
