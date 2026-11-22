import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import {
  cardDigits,
  cardLabel,
  FILL_FIELD_LABELS,
  FILL_FIELDS,
  SECRET_FIELDS,
  type VaultFillField,
  type VaultItem
} from '@zumibot/shared/vault'
import type { BrowserFill } from '../browser/types'
import { totpAt } from '../../auth/totp'

export type FillPlan =
  | {
      ok: true
      value: string
      secret: boolean
      mask: boolean
      target: BrowserFill['target']
      loose: boolean
      hosts: BrowserFill['hosts']
      itemName: string
      label: string
    }
  | { ok: false; code: 'not_allowed' | 'no_field' | 'vault_unavailable'; message: string }

const EXPIRY = /^(0[1-9]|1[0-2])\/(\d{2})$/
// A page may reformat what it is given (a phone formatter, an upper-cased name, "123 456"), so fields read back loosely; a
// password must read back exactly, since a page that changed it did not keep the saved one.
const EXACT: ReadonlySet<VaultFillField> = new Set<VaultFillField>(['password'])
// Masked once in an input: the secrets, and the expiry parts, which are not secret only so that a select may take them.
const MASKED: ReadonlySet<VaultFillField> = new Set<VaultFillField>([...SECRET_FIELDS, 'expiryMonth', 'expiryYear', 'expiryYear2'])

/** The stored value of one field, '' when the item has none (a refusal then names the field, never a value). */
function valueOf(item: VaultItem, field: VaultFillField, now: number): string | null {
  switch (item.kind) {
    case 'login':
      if (field === 'username') return item.username
      if (field === 'password') return item.password
      if (field === 'code') {
        if (item.totp === null) return ''
        // A secret that no longer decodes is the vault's fault, not a missing field.
        try {
          return totpAt(item.totp, now)
        } catch {
          return null
        }
      }
      return ''
    case 'card': {
      const expiry = EXPIRY.exec(item.expiry)
      switch (field) {
        case 'number':
          return cardDigits(item.number) ?? ''
        case 'expiry':
          return expiry ? item.expiry : ''
        case 'expiryMonth':
          return expiry ? expiry[1] : ''
        case 'expiryYear':
          return expiry ? `20${expiry[2]}` : ''
        case 'expiryYear2':
          return expiry ? expiry[2] : ''
        case 'cvc':
          return item.cvc
        case 'holder':
          return item.holder
        default:
          return ''
      }
    }
    case 'contact': {
      const v = (item as Record<string, unknown>)[field]
      return typeof v === 'string' ? v : ''
    }
    case 'apiKey':
      return ''
  }
}

function targetOf(field: VaultFillField): BrowserFill['target'] {
  if (field === 'password') return 'password'
  if (SECRET_FIELDS.has(field)) return 'input'
  if (field === 'expiryMonth' || field === 'expiryYear' || field === 'expiryYear2') return 'inputOrSelect'
  return 'any'
}

/**
 * What the browser must fill for one `browser_fill_from_vault` call, or why not. Run again after an approval card is answered,
 * so a grant removed or an item deleted while the card waited fails here and nothing is typed.
 */
export function fillPlan(item: VaultItem | null, agent: string, field: VaultFillField, now: number): FillPlan {
  // An item the agent may not use is never named: the agent need not learn it exists.
  if (item === null || agent === ZUMI_BOT_NAME || !item.agents.includes(agent))
    return { ok: false, code: 'not_allowed', message: 'No vault item with that id is available to you' }
  const label = FILL_FIELD_LABELS[field]
  if (!FILL_FIELDS[item.kind].includes(field)) return { ok: false, code: 'no_field', message: `${item.name} has no ${label} field` }
  const value = valueOf(item, field, now)
  if (value === null)
    return { ok: false, code: 'vault_unavailable', message: `The ${label} of ${item.name} could not be read from the vault` }
  if (value === '') return { ok: false, code: 'no_field', message: `${item.name} has no ${label} saved` }
  const hosts: BrowserFill['hosts'] =
    item.kind === 'login'
      ? { kind: 'login', sites: [...item.sites] }
      : item.kind === 'card'
        ? { kind: 'card', approved: item.approved.map((a) => ({ site: a.site, frameSite: a.frameSite })) }
        : { kind: 'any' }
  const digits = item.kind === 'card' ? cardDigits(item.number) : null
  return {
    ok: true,
    value,
    secret: SECRET_FIELDS.has(field),
    mask: MASKED.has(field),
    target: targetOf(field),
    loose: !EXACT.has(field),
    hosts,
    itemName: item.name,
    label: item.kind === 'card' ? (digits ? cardLabel(digits) : 'Card') : item.name
  }
}
