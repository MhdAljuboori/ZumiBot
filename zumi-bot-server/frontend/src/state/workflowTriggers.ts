import { fieldList } from '@zumibot/shared/routineFields'
import type { VaultListItem } from '@zumibot/shared/vault'
import { EVENT_SAMPLES, MAIL_PORT_DEFAULT, eventCall, eventLabel } from '@zumibot/shared/workflowEvents'
import type { EventKind, FileChange, TriggerFilter, WorkflowRunSummary } from '@zumibot/shared/workflows'

// What the trigger inspector and the sidebar's run tags decide, without a DOM.

/** The filter with its test set; equals is the stored default, so it leaves no `op` key behind. */
export function setFilterOp(f: TriggerFilter, op: 'equals' | 'contains'): TriggerFilter {
  const { op: _old, ...rest } = f
  return op === 'contains' ? { ...rest, op } : rest
}

/** The filters' two hints: a webhook call that fails one is kept as a skipped run, an event that fails one writes nothing. */
export function filterHints(kind: 'webhook' | EventKind): { none: string; rule: string } {
  return kind === 'webhook'
    ? {
        none: 'Every call runs. Add a filter to run only on some calls.',
        rule: 'Text compares exactly, or contains it (capitals matter), all of them must match. A call that fails one is kept as a skipped run.'
      }
    : {
        none: 'Every event runs. Add a filter to run only on some events.',
        rule: 'Exact or contains compares; all must match. An event that fails one starts nothing.'
      }
}

/**
 * The hint under a filter row: a field's Filter button adds one with an empty value, which (as equals) matches only an
 * empty field, so the workflow would quietly never start. Contains '' matches any value, so it needs none.
 */
export const emptyValueHint = (f: TriggerFilter): string | null =>
  f.op !== 'contains' && f.equals === '' ? 'An empty value matches only an empty field.' : null

/** The fields a run of this kind has, from its example call: the rows of the field list beside the filters. */
export const eventFieldRows = (kind: EventKind): { path: string; sample: string }[] => fieldList(eventCall(EVENT_SAMPLES[kind], 0))

type Login = Extract<VaultListItem, { kind: 'login' }>

/** The Vault logins a workflow's email trigger may sign in with. */
export const mailAccounts = (items: readonly VaultListItem[]): Login[] => items.filter((i): i is Login => i.kind === 'login' && i.workflows)

export const mailAccountLabel = (i: Login): string => (i.username ? `${i.name} (${i.username})` : i.name)

/** Check mailbox's answer: the count, or the server's own error text. */
export const mailCheckText = (r: { messages: number } | { error: string }): string =>
  'error' in r ? r.error : `${r.messages} ${r.messages === 1 ? 'message' : 'messages'}`

const CHANGE_ORDER: FileChange[] = ['added', 'changed', 'removed']

/**
 * The watched changes with one turned on or off, in a fixed order so toggling twice stores the same list. The last one
 * stays on: an empty list is refused on save.
 */
export function toggleChange(changes: FileChange[], change: FileChange, on: boolean): FileChange[] {
  const next = CHANGE_ORDER.filter((c) => (c === change ? on : changes.includes(c)))
  return next.length === 0 ? changes : next
}

/** Whether the Account select has an option for this id: none picked is the placeholder, and a list not yet loaded is trusted. */
export const accountKnown = (id: string, accounts: readonly { id: string }[] | null): boolean =>
  id === '' || (accounts?.some((a) => a.id === id) ?? true)

/** The Port input as typed: digits only (at most five), and the port to store, which only a 1-65535 draft has. */
export function portDraft(raw: string): { text: string; port: number | null; valid: boolean } {
  const text = raw.replace(/\D/g, '').slice(0, 5)
  const n = Number(text)
  const valid = text !== '' && n >= 1 && n <= 65_535
  return { text, port: valid ? n : null, valid }
}

/** The port to store when the input loses focus: the typed one if valid, else the default. */
export const portOnBlur = (text: string): number => portDraft(text).port ?? MAIL_PORT_DEFAULT

/** The tag a sidebar run row carries for how the run started; null for the kinds that need none. */
export function runTag(run: Pick<WorkflowRunSummary, 'via' | 'event'>): string | null {
  if (run.via === 'manual') return 'manual'
  if (run.via === 'chat') return 'from chat'
  if (run.via === 'event') return run.event ? eventLabel(run.event).toLowerCase() : 'event'
  return null
}
