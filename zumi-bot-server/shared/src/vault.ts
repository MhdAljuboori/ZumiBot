// Pure vault types and rules, shared by the server and the UI: no `node:` imports.
import { ZUMI_BOT_NAME } from './zumiBot'
import type { VaultFillField } from './browser'

// The fill fields live in browser.ts, which must import nothing (see there); handed on from here for the vault's readers.
export { VAULT_FILL_FIELD_NAMES, isFillField, type VaultFillField } from './browser'

export type VaultKind = 'login' | 'card' | 'contact' | 'apiKey'

export const CONTACT_FIELDS = [
  'fullName',
  'company',
  'email',
  'phone',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'country'
] as const
export type ContactField = (typeof CONTACT_FIELDS)[number]

/** A (page host, frame host) pair the user pressed Allow for on a card. */
export interface VaultApproval {
  site: string
  frameSite: string
  at: number
}

type Base = { id: string; updatedAt: number; name: string; agents: string[] }
// workflows: a workflow's email trigger may sign in with it (absent: only the granted agents fill it).
type LoginBody = { kind: 'login'; sites: string[]; username: string; password: string; totp: string | null; workflows?: true }
type CardBody = { kind: 'card'; holder: string; number: string; expiry: string; cvc: string; approved: VaultApproval[] }
type ContactBody = { kind: 'contact' } & Record<ContactField, string>
// workflows: workflow HTTP request steps may send it (absent: only the granted agents' env).
type ApiKeyBody = { kind: 'apiKey'; env: string; value: string; description: string; workflows?: true }

export type VaultItem = Base & (LoginBody | CardBody | ContactBody | ApiKeyBody)

/** What the UI saves: an absent secret field keeps the stored one. */
export type VaultInput = { id?: string; name: string; agents: string[] } & (
  | (Omit<LoginBody, 'password' | 'totp' | 'workflows'> & { password?: string; totp?: string | null; workflows?: boolean })
  | (Omit<CardBody, 'number' | 'expiry' | 'cvc' | 'approved'> & { number?: string; expiry?: string; cvc?: string })
  | ContactBody
  | (Omit<ApiKeyBody, 'value' | 'workflows'> & { value?: string; workflows?: boolean })
)

/** The UI's list view: every secret replaced by a flag. */
export type VaultListItem = Base & { label: string } & (
    | (Pick<LoginBody, 'kind' | 'sites' | 'username'> & { hasPassword: boolean; hasCode: boolean; workflows: boolean })
    | Pick<CardBody, 'kind' | 'holder' | 'approved'>
    | ContactBody
    | (Pick<ApiKeyBody, 'kind' | 'env' | 'description'> & { hasValue: boolean; workflows: boolean })
  )

/** What an agent may read through `vault_items`. */
export type VaultAgentItem =
  | { id: string; kind: 'login'; name: string; sites: string[]; username: string; hasCode: boolean }
  | { id: string; kind: 'card'; name: string; label: string; holder: string }
  | ({ id: string; kind: 'contact'; name: string } & Record<ContactField, string>)
  | { id: string; kind: 'apiKey'; name: string; env: string; description: string }

export type VaultStatus = 'empty' | 'ready' | 'keyMissing' | 'keyMismatch'

export const FILL_FIELDS: Record<VaultKind, readonly VaultFillField[]> = {
  login: ['username', 'password', 'code'],
  card: ['number', 'expiry', 'expiryMonth', 'expiryYear', 'expiryYear2', 'cvc', 'holder'],
  contact: CONTACT_FIELDS,
  apiKey: []
}

/** How a fill row names its field: "Filled from vault · Work Visa · card number". */
export const FILL_FIELD_LABELS: Record<VaultFillField, string> = {
  username: 'username',
  password: 'password',
  code: '2FA code',
  number: 'card number',
  expiry: 'expiry date',
  expiryMonth: 'expiry month',
  expiryYear: 'expiry year',
  expiryYear2: 'expiry year',
  cvc: 'security code',
  holder: 'card holder',
  fullName: 'full name',
  company: 'company',
  email: 'email',
  phone: 'phone',
  line1: 'address line 1',
  line2: 'address line 2',
  city: 'city',
  region: 'region',
  postalCode: 'postal code',
  country: 'country'
}

/** Secret fields go only into a visible input and are masked afterwards. */
export const SECRET_FIELDS: ReadonlySet<VaultFillField> = new Set<VaultFillField>(['password', 'code', 'number', 'expiry', 'cvc'])

export interface VaultApprovalRequest {
  id: string
  chatId: string
  turnId: string
  profileId: string
  itemId: string
  itemName: string
  label: string
  site: string
  frameSite: string
  status: 'pending' | 'allowed' | 'denied' | 'interrupted'
}

export const VAULT_MAX_ITEMS = 500
/** Error messages of `VaultStore`: the save was stale, the vault cannot be read or written, or it is full. */
export const VAULT_CHANGED = 'VAULT_CHANGED'
export const VAULT_UNAVAILABLE = 'VAULT_UNAVAILABLE'
export const VAULT_FULL = 'VAULT_FULL'
export const VAULT_TOOL = 'mcp__zumibot_vault__vault_items'
export const FILL_TOOL = 'mcp__zumibot_browser__browser_fill_from_vault'

const LIMITS = {
  name: 100,
  text: 300,
  password: 1000,
  site: 253,
  sites: 10,
  totp: 128,
  totpRaw: 512,
  keyMin: 8,
  keyMax: 8000,
  description: 300
}

// Sites ---------------------------------------------------------------

/** A bare lowercased punycode host (or `*.host`), from a pasted URL or host; null when it is not one. */
export function normalizeSite(input: string): string | null {
  let s = input.trim()
  if (s === '' || /\s/.test(s)) return null
  const wildcard = s.startsWith('*.')
  if (wildcard) s = s.slice(2)
  if (s.includes('*')) return null
  let host: string
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s).hostname
  } catch {
    return null
  }
  host = host.replace(/\.+$/, '').toLowerCase()
  if (host === '' || host.length > LIMITS.site) return null
  if (!/^[a-z0-9.\-[\]:]+$/.test(host)) return null
  // `*.com` would match a whole top-level domain.
  if (wildcard) return host.includes('.') ? '*.' + host : null
  return host
}

/** `example.com` is that host only; `*.example.com` is any subdomain, never the apex. */
export function siteMatches(site: string, host: string): boolean {
  if (site.startsWith('*.')) return host.endsWith(site.slice(1)) && host.length > site.length - 1
  return site === host
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|[^.]+(\.[^.]+)*\.localhost)$/

/** The host of an https or loopback http URL; anything else gets no secrets. */
export function secureHost(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/\.+$/, '').toLowerCase()
  if (host === '') return null
  if (u.protocol === 'https:') return host
  if (u.protocol === 'http:' && LOOPBACK.test(host)) return host
  return null
}

// Cards ---------------------------------------------------------------

export function cardDigits(number: string): string | null {
  const d = number.replace(/[\s-]/g, '')
  return /^\d{12,19}$/.test(d) ? d : null
}

export function cardBrand(digits: string): 'Visa' | 'Mastercard' | 'Amex' | 'Discover' | 'Card' {
  if (/^4/.test(digits)) return 'Visa'
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]|[3-6]|7[01]|720))/.test(digits)) return 'Mastercard'
  if (/^3[47]/.test(digits)) return 'Amex'
  if (/^(6011|65|64[4-9])/.test(digits)) return 'Discover'
  return 'Card'
}

export function cardLabel(digits: string): string {
  return `${cardBrand(digits)} •${digits.slice(-4)}`
}

export function luhnOk(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return digits.length > 0 && sum % 10 === 0
}

// 2FA and env names -----------------------------------------------------

/** A base32 secret from the text, or from the `secret` of an `otpauth://totp/` URI. */
export function totpSecretOf(input: string): string | null {
  let s = input.trim()
  if (/^otpauth:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      if (u.host.toLowerCase() !== 'totp') return null
      s = u.searchParams.get('secret') ?? ''
    } catch {
      return null
    }
  }
  s = s.replace(/\s/g, '').toUpperCase()
  return /^[A-Z2-7]{8,}=*$/.test(s) ? s : null
}

const RESERVED_PREFIXES = ['ZUMIBOT_', 'CLAUDE_', 'ANTHROPIC_', 'NODE_', 'ELECTRON_', 'LD_', 'DYLD_', 'XDG_']
const RESERVED_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'PWD',
  'LANG',
  'TERM',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS'
]

export function envNameError(name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name))
    return 'The variable name must be 2-64 characters: capital letters, digits and underscores, starting with a letter.'
  if (RESERVED_NAMES.includes(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) return 'That variable name is reserved.'
  return null
}

// Validation ----------------------------------------------------------

const tooLong = (v: string | undefined, max: number) => v !== undefined && v.length > max

/** The reason a save is refused, or null. `others` are the live items except the one being saved. */
export function vaultInputError(input: VaultInput, others: readonly VaultItem[]): string | null {
  if (input.name.trim() === '') return 'Give the item a name.'
  if (input.name.length > LIMITS.name) return `The name can be at most ${LIMITS.name} characters.`
  if (input.agents.includes(ZUMI_BOT_NAME)) return 'Zumi Bot cannot use vault items.'
  const rest = others.filter((o) => o.id !== input.id)
  if (input.id === undefined || !others.some((o) => o.id === input.id)) {
    if (rest.length >= VAULT_MAX_ITEMS) return `The vault holds at most ${VAULT_MAX_ITEMS} items.`
  }
  switch (input.kind) {
    case 'login': {
      if (input.sites.length < 1 || input.sites.length > LIMITS.sites) return `A login needs 1-${LIMITS.sites} sites.`
      if (input.sites.some((s) => normalizeSite(s) === null)) return 'One of the sites is not a valid host.'
      if (tooLong(input.username, LIMITS.text)) return `The username can be at most ${LIMITS.text} characters.`
      if (tooLong(input.password, LIMITS.password)) return `The password can be at most ${LIMITS.password} characters.`
      if (typeof input.totp === 'string') {
        // The 128 cap is on the secret itself; a pasted otpauth:// link is longer than its secret.
        const secret = input.totp.length > LIMITS.totpRaw ? null : totpSecretOf(input.totp)
        if (secret === null) return 'The 2FA secret must be base32 or an otpauth:// link.'
        if (secret.length > LIMITS.totp) return `The 2FA secret can be at most ${LIMITS.totp} characters.`
      }
      return null
    }
    case 'card': {
      if (tooLong(input.holder, LIMITS.text)) return `The holder name can be at most ${LIMITS.text} characters.`
      if (input.number !== undefined && cardDigits(input.number) === null) return 'A card number has 12-19 digits.'
      if (input.expiry !== undefined && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(input.expiry)) return 'The expiry must look like MM/YY.'
      if (input.cvc !== undefined && !/^\d{3,4}$/.test(input.cvc)) return 'The security code has 3 or 4 digits.'
      return null
    }
    case 'contact': {
      for (const f of CONTACT_FIELDS)
        if (input[f].length > LIMITS.text) return `Each contact field can be at most ${LIMITS.text} characters.`
      return null
    }
    case 'apiKey': {
      const bad = envNameError(input.env)
      if (bad) return bad
      if (input.value !== undefined && (input.value.length < LIMITS.keyMin || input.value.length > LIMITS.keyMax))
        return `The key must be ${LIMITS.keyMin}-${LIMITS.keyMax} characters.`
      if (tooLong(input.description, LIMITS.description)) return `The description can be at most ${LIMITS.description} characters.`
      // Two keys with one variable name would make the agent's env depend on order.
      if (rest.some((o) => o.kind === 'apiKey' && o.env === input.env && o.agents.some((a) => input.agents.includes(a))))
        return 'Another key already gives one of these agents that variable name.'
      return null
    }
    // The input comes from RPC JSON, so the kind may be anything.
    default:
      return 'Unknown item kind.'
  }
}

// Views -----------------------------------------------------------------

export function listView(item: VaultItem): VaultListItem {
  const base = { id: item.id, updatedAt: item.updatedAt, name: item.name, agents: item.agents }
  switch (item.kind) {
    case 'login':
      return {
        ...base,
        kind: 'login',
        label: item.name,
        sites: item.sites,
        username: item.username,
        hasPassword: item.password !== '',
        hasCode: item.totp !== null,
        workflows: item.workflows === true
      }
    case 'card':
      return { ...base, kind: 'card', label: cardLabelOf(item.number), holder: item.holder, approved: item.approved }
    case 'contact': {
      const { kind, ...fields } = pickContact(item)
      return { ...base, kind, label: item.name, ...fields }
    }
    case 'apiKey':
      return {
        ...base,
        kind: 'apiKey',
        label: item.name,
        env: item.env,
        description: item.description,
        hasValue: item.value !== '',
        workflows: item.workflows === true
      }
  }
}

export function agentView(item: VaultItem): VaultAgentItem {
  switch (item.kind) {
    case 'login':
      return { id: item.id, kind: 'login', name: item.name, sites: item.sites, username: item.username, hasCode: item.totp !== null }
    case 'card':
      return { id: item.id, kind: 'card', name: item.name, label: cardLabelOf(item.number), holder: item.holder }
    case 'contact':
      return { id: item.id, name: item.name, ...pickContact(item) }
    case 'apiKey':
      return { id: item.id, kind: 'apiKey', name: item.name, env: item.env, description: item.description }
  }
}

function cardLabelOf(number: string): string {
  const d = cardDigits(number)
  return d === null ? 'Card' : cardLabel(d)
}

function pickContact(item: Extract<VaultItem, { kind: 'contact' }>): { kind: 'contact' } & Record<ContactField, string> {
  const out = { kind: 'contact' } as { kind: 'contact' } & Record<ContactField, string>
  for (const f of CONTACT_FIELDS) out[f] = item[f]
  return out
}

/** An agent's `tools:` list needs the vault tool by name; no list (null) already means every tool. */
export function withVaultTools(tools: string[] | null): string[] | null {
  if (tools === null) return null
  return [...tools.filter((t) => t !== VAULT_TOOL), VAULT_TOOL]
}
