import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { AgentSummary } from '@zumibot/shared/types'
import {
  CONTACT_FIELDS,
  cardDigits,
  envNameError,
  luhnOk,
  normalizeSite,
  totpSecretOf,
  VAULT_CHANGED,
  VAULT_FULL,
  VAULT_MAX_ITEMS,
  VAULT_UNAVAILABLE,
  type ContactField,
  type VaultInput,
  type VaultKind,
  type VaultListItem,
  type VaultStatus
} from '@zumibot/shared/vault'

/** The editor's form state: every field a string, a blank secret meaning "keep the stored one". */
export interface VaultDraft {
  kind: VaultKind
  /** Absent for an item not saved yet. */
  id?: string
  /** The stored time the form was opened at: a save from an older copy is refused by the server. */
  updatedAt?: number
  name: string
  agents: string[]
  // Login
  sitesText: string // one site per line
  username: string
  password: string
  totp: string
  /** Remove the stored 2FA secret; a blank `totp` alone keeps it. */
  clearTotp: boolean
  // Card
  holder: string
  number: string
  expiry: string
  cvc: string
  // Contact
  contact: Record<ContactField, string>
  // API key
  env: string
  value: string
  description: string
  /** Workflows may use it: an API key in HTTP request steps, a login in the email trigger. */
  workflows: boolean
}

export const KIND_ORDER: readonly VaultKind[] = ['login', 'card', 'contact', 'apiKey']
export const KIND_LABELS: Record<VaultKind, string> = { login: 'Login', card: 'Card', contact: 'Contact', apiKey: 'API key' }

const NAME_MAX = 100
const TEXT_MAX = 300
const PASSWORD_MAX = 1000
const SITES_MAX = 10
const KEY_MIN = 8
const KEY_MAX = 8000
const WARNING = "This card number doesn't pass the usual check. Make sure it is typed right."

/** A one-line summary under an item's name. */
export function rowLine(item: VaultListItem): string {
  switch (item.kind) {
    case 'login':
      return [item.username, item.sites.join(', ')].filter((s) => s !== '').join(' · ')
    case 'card':
      return [item.label, item.holder].filter((s) => s !== '').join(' · ')
    case 'contact':
      return item.email
    case 'apiKey':
      return `$${item.env}`
  }
}

/** The kinds that have a match, in the fixed order, items by name. A query matches the name or the row line. */
export function groupVault(items: readonly VaultListItem[], query: string): { kind: VaultKind; items: VaultListItem[] }[] {
  const q = query.trim().toLowerCase()
  const match = (i: VaultListItem): boolean => q === '' || i.name.toLowerCase().includes(q) || rowLine(i).toLowerCase().includes(q)
  const byName = (a: VaultListItem, b: VaultListItem): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  return KIND_ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind && match(i)).sort(byName) })).filter(
    (g) => g.items.length > 0
  )
}

const emptyContact = (): Record<ContactField, string> =>
  Object.fromEntries(CONTACT_FIELDS.map((f) => [f, ''])) as Record<ContactField, string>

export function emptyDraft(kind: VaultKind): VaultDraft {
  return {
    kind,
    name: '',
    agents: [],
    sitesText: '',
    username: '',
    password: '',
    totp: '',
    clearTotp: false,
    holder: '',
    number: '',
    expiry: '',
    cvc: '',
    contact: emptyContact(),
    env: '',
    value: '',
    description: '',
    workflows: false
  }
}

/** The form for a stored item; its secrets are never in the list, so they start blank. */
export function draftOf(item: VaultListItem): VaultDraft {
  const d: VaultDraft = { ...emptyDraft(item.kind), id: item.id, updatedAt: item.updatedAt, name: item.name, agents: [...item.agents] }
  switch (item.kind) {
    case 'login':
      return { ...d, sitesText: item.sites.join('\n'), username: item.username, workflows: item.workflows === true }
    case 'card':
      return { ...d, holder: item.holder }
    case 'contact':
      return { ...d, contact: Object.fromEntries(CONTACT_FIELDS.map((f) => [f, item[f]])) as Record<ContactField, string> }
    case 'apiKey':
      return { ...d, env: item.env, description: item.description, workflows: item.workflows }
  }
}

/** The valid sites of the text, one per line, normalized and without repeats. */
function sitesOf(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const s = normalizeSite(line)
    if (s !== null && !out.includes(s)) out.push(s)
  }
  return out
}

const rowsOf = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '')

/** What a save sends: a blank secret is left out so the server keeps the stored one. */
export function inputOf(d: VaultDraft): VaultInput {
  const head = { ...(d.id !== undefined ? { id: d.id } : {}), name: d.name.trim(), agents: d.agents }
  switch (d.kind) {
    case 'login': {
      const totp = d.clearTotp ? null : d.totp.trim()
      return {
        ...head,
        kind: 'login',
        sites: sitesOf(d.sitesText),
        username: d.username,
        workflows: d.workflows,
        ...(d.password !== '' ? { password: d.password } : {}),
        ...(totp === null || totp !== '' ? { totp } : {})
      }
    }
    case 'card': {
      const digits = cardDigits(d.number)
      return {
        ...head,
        kind: 'card',
        holder: d.holder.trim(),
        ...(d.number.trim() !== '' ? { number: digits ?? d.number.trim() } : {}),
        ...(d.expiry.trim() !== '' ? { expiry: d.expiry.trim() } : {}),
        ...(d.cvc.trim() !== '' ? { cvc: d.cvc.trim() } : {})
      }
    }
    case 'contact':
      return { ...head, kind: 'contact', ...d.contact }
    case 'apiKey':
      // Trimmed, as the server does: a stray space would keep the bare token from being scrubbed.
      return {
        ...head,
        kind: 'apiKey',
        env: d.env.trim(),
        description: d.description,
        workflows: d.workflows,
        ...(d.value.trim() !== '' ? { value: d.value.trim() } : {})
      }
  }
}

/** Field name to message. `warning` is advice, not a refusal (see `hasErrors`). */
export type DraftErrors = Partial<Record<string, string>>

/** Messages for the form. `others` is every listed item; the draft's own stored copy is ignored. */
export function draftErrors(d: VaultDraft, others: readonly VaultListItem[]): DraftErrors {
  const e: DraftErrors = {}
  const isNew = d.id === undefined || !others.some((o) => o.id === d.id)
  if (d.name.trim() === '') e.name = 'Give the item a name.'
  else if (d.name.length > NAME_MAX) e.name = `The name can be at most ${NAME_MAX} characters.`
  if (d.agents.includes(ZUMI_BOT_NAME)) e.agents = 'Zumi Bot cannot use vault items.'
  switch (d.kind) {
    case 'login': {
      const rows = rowsOf(d.sitesText)
      if (rows.length < 1 || rows.length > SITES_MAX) e.sites = `A login needs 1-${SITES_MAX} sites, one per line.`
      else if (rows.some((r) => normalizeSite(r) === null)) e.sites = 'One of the sites is not a valid host.'
      if (d.username.length > TEXT_MAX) e.username = `The username can be at most ${TEXT_MAX} characters.`
      if (d.password.length > PASSWORD_MAX) e.password = `The password can be at most ${PASSWORD_MAX} characters.`
      if (!d.clearTotp && d.totp.trim() !== '' && (d.totp.length > 512 || totpSecretOf(d.totp) === null))
        e.totp = 'The 2FA secret must be base32 or an otpauth:// link.'
      break
    }
    case 'card': {
      if (d.holder.length > TEXT_MAX) e.holder = `The holder name can be at most ${TEXT_MAX} characters.`
      const digits = cardDigits(d.number)
      if (d.number.trim() === '') {
        if (isNew) e.number = 'Enter the card number.'
      } else if (digits === null) e.number = 'A card number has 12-19 digits.'
      else if (!luhnOk(digits)) e.warning = WARNING
      if (d.expiry.trim() !== '' && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(d.expiry.trim())) e.expiry = 'The expiry must look like MM/YY.'
      if (d.cvc.trim() !== '' && !/^\d{3,4}$/.test(d.cvc.trim())) e.cvc = 'The security code has 3 or 4 digits.'
      break
    }
    case 'contact': {
      if (CONTACT_FIELDS.some((f) => d.contact[f].length > TEXT_MAX))
        e.contact = `Each contact field can be at most ${TEXT_MAX} characters.`
      break
    }
    case 'apiKey': {
      const env = d.env.trim()
      const bad = envNameError(env)
      if (bad) e.env = bad
      // Two keys with one variable name would make the agent's environment depend on order.
      else if (others.some((o) => o.kind === 'apiKey' && o.id !== d.id && o.env === env && o.agents.some((a) => d.agents.includes(a))))
        e.env = 'Another key already gives one of these agents that variable name.'
      const value = d.value.trim()
      if (value === '') {
        if (isNew) e.value = 'Paste the key.'
      } else if (value.length < KEY_MIN || value.length > KEY_MAX) e.value = `The key must be ${KEY_MIN}-${KEY_MAX} characters.`
      if (d.description.length > TEXT_MAX) e.description = `The description can be at most ${TEXT_MAX} characters.`
      break
    }
  }
  return e
}

/** True when something other than a warning blocks the save. */
export const hasErrors = (e: DraftErrors): boolean => Object.keys(e).some((k) => k !== 'warning' && e[k] !== undefined)

/** True when the form differs from the one it was opened with. */
export const isDraftDirty = (draft: VaultDraft, opened: VaultDraft): boolean => JSON.stringify(draft) !== JSON.stringify(opened)

/** A missing or wrong key: the vault can't be opened, so the explanation replaces the list and any open form. */
export const keyProblem = (status: VaultStatus | null): boolean => status === 'keyMissing' || status === 'keyMismatch'

/**
 * What the explanation says, naming the key path the server reports (`vault:keyFile`): a server set up with
 * ZUMIBOT_VAULT_KEY_FILE or XDG_CONFIG_HOME looks elsewhere than the default. Without one it says so in words.
 */
export function keyProblemCopy(
  status: 'keyMissing' | 'keyMismatch',
  keyFile: string | null
): { title: string; hint: string; path: string | null } {
  const where = keyFile === null ? 'where this server looks for it' : 'at this path'
  return status === 'keyMissing'
    ? {
        title: 'The vault key file is missing',
        hint: `The vault holds items, but the key that opens them cannot be found on this machine. Put the key file back ${where} and the vault opens again.`,
        path: keyFile
      }
    : {
        title: 'The vault key does not match',
        hint: `The key file on this machine is not the one the vault was sealed with, so its items cannot be opened. Put the right key file back ${where} and the vault opens again.`,
        path: keyFile
      }
}

/**
 * Whether a fetched value may fill the secret field: `run` is still the latest request (Hide and unmount move it on),
 * and nothing was typed while it ran, since the stored value would cover the typed text.
 */
export const keepReveal = (run: number, latest: number, typed: string): boolean => run === latest && typed === ''

/** The Show button's text: Hide while a value shows, else what Show would reveal: the typed text, or the stored value. */
export const showLabel = (visible: boolean, typed: string, labels: { stored: string; typed: string }): string =>
  visible ? 'Hide' : typed !== '' ? labels.typed : labels.stored

/** The delete question, naming the item as stored: the form may hold a name not saved yet. */
export function deleteMessage(id: string | undefined, items: readonly VaultListItem[]): string {
  const name = items.find((i) => i.id === id)?.name.trim() || 'this item'
  return `Delete ${name}? Agents lose access. This can't be undone.`
}

/** The agents a user may grant: loadable ones, never Zumi Bot, by name. */
export function agentChoices(agents: readonly AgentSummary[]): string[] {
  return agents
    .filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME)
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b))
}

/** A server refusal as a sentence for the form (the codes are `VaultStore`'s; anything else is already readable). */
export function vaultErrorText(message: string): string {
  if (message.includes(VAULT_CHANGED)) return 'This item changed elsewhere. Reload and try again.'
  if (message.includes(VAULT_UNAVAILABLE)) return "The vault can't be read or written right now. Check that the vault key file is in place."
  if (message.includes(VAULT_FULL)) return `The vault holds at most ${VAULT_MAX_ITEMS} items.`
  return message
}
