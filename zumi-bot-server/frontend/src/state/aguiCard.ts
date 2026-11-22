// Pure rules for Agent Studio's remote agent (AG-UI) card: the launch draft, the auth key, the notes and Test. It mirrors
// acpCard.ts, which holds what both cards share (launch compare, confirm pending). See docs/architecture/protocol-engines.md,
// "Agent file, auth and the remote notice".
import type { AcpLaunch } from '@zumibot/shared/acp'
import {
  AGUI_STUDIO_TEXT,
  AGUI_TEXT,
  aguiHost,
  aguiLaunchError,
  aguiLaunchRecord,
  type AguiLaunch,
  type AguiTestInfo
} from '@zumibot/shared/agui'
import type { Provider } from '@zumibot/shared/engine'
import type { VaultListItem } from '@zumibot/shared/vault'

/** Whether a protocol launch is a remote agent's (an ACP launch has a command, not an endpoint). */
export const isAguiLaunch = (l: AcpLaunch | AguiLaunch): l is AguiLaunch => 'endpoint' in l

/** The confirmed launch as the remote card reads it: another kind's is none, and "not known yet" stays so. */
export const confirmedAgui = (c: AcpLaunch | AguiLaunch | null | undefined): AguiLaunch | null | undefined =>
  c === undefined || c === null ? c : isAguiLaunch(c) ? c : null

/** What the card's fields hold as the user types: a blank header is no header. */
export interface AguiDraft {
  endpoint: string
  authKey: string | null
  authHeader: string
}

export const aguiDraftOf = (launch: AguiLaunch | null): AguiDraft => ({
  endpoint: launch?.endpoint ?? '',
  authKey: launch?.authKey ?? null,
  authHeader: launch?.authHeader ?? ''
})

/** The launch a draft stands for, even when it is not a valid one (the card names its problem). Null while the endpoint is blank. */
function launchOfDraft(d: AguiDraft): AguiLaunch | null {
  const endpoint = d.endpoint.trim()
  if (endpoint === '') return null
  const header = d.authHeader.trim()
  return { endpoint, authKey: d.authKey, authHeader: header === '' ? null : header }
}
const keyOf = (l: AguiLaunch | null): string => (l === null ? '' : aguiLaunchRecord(l))

/**
 * What the form gets for a draft: its launch only when valid, else none. The agent file never holds a launch that does not
 * parse (serializeAgent skips it), so the form could not keep an invalid one: it would keep the last good launch instead, which
 * Save would then write while the card shows another, and the card would snap back to it on every key. With none, Save is
 * refused ("required") while the card keeps the text as typed and names its real problem, as the ACP card does.
 */
function formLaunch(d: AguiDraft): AguiLaunch | null {
  const l = launchOfDraft(d)
  return l !== null && aguiLaunchError(l) === null ? l : null
}

/** One edit of the card: the draft to show next and the `agui` the form gets (null while the draft makes no valid launch). */
export function editAguiDraft(shown: AguiDraft, patch: Partial<AguiDraft>): { draft: AguiDraft; agui: AguiLaunch | null } {
  const draft = { ...shown, ...patch }
  return { draft, agui: formLaunch(draft) }
}

/** The draft the card shows: the user's own while the form still holds what it made, else the form's launch (Revert, a Raw edit). */
export function shownAguiDraft(draft: AguiDraft | null, launch: AguiLaunch | null): AguiDraft {
  if (draft !== null && keyOf(formLaunch(draft)) === keyOf(launch)) return draft
  return aguiDraftOf(launch)
}

/** The draft's problem as the save would name it, or null. */
export function aguiDraftError(d: AguiDraft): string | null {
  const l = launchOfDraft(d)
  return l === null ? AGUI_TEXT.endpointRequired : aguiLaunchError(l)
}

/** An auth key Agent Studio offers: an env name only, never a value. */
export interface KeyChoice {
  env: string
  name: string | null
  picked: boolean
  granted: boolean
}

/**
 * The env names of the API keys granted to this (saved) agent, then the listed one if it is no longer granted, so it can be
 * changed (a run refuses it). An unsaved agent has no grants yet.
 */
export function keyChoices(items: readonly VaultListItem[], agent: string | null, authKey: string | null): KeyChoice[] {
  const out: KeyChoice[] = []
  for (const i of items) {
    if (i.kind !== 'apiKey' || agent === null || !i.agents.includes(agent) || out.some((c) => c.env === i.env)) continue
    out.push({ env: i.env, name: i.name, picked: authKey === i.env, granted: true })
  }
  if (authKey !== null && !out.some((c) => c.env === authKey)) out.push({ env: authKey, name: null, picked: true, granted: false })
  return out
}

/** A launch as one line, for the confirmed-beside-current note: the endpoint, then its key and header names. */
export function aguiLaunchLine(l: AguiLaunch): string {
  if (l.authKey === null) return l.endpoint
  return `${l.endpoint} (auth key: ${l.authKey}${l.authHeader === null ? '' : `, header: ${l.authHeader}`})`
}

/** The remote notice with the endpoint's host, or null while the form has no readable endpoint. */
export function remoteNotice(launch: AguiLaunch | null): string | null {
  const host = launch === null ? null : aguiHost(launch.endpoint)
  return host === null ? null : AGUI_STUDIO_TEXT.remote(host)
}

/**
 * The note that chats the agent had on another engine do not continue: shown once the Engine select moves a saved agent onto the
 * remote engine (a new agent has no chats, and one already saved as remote keeps its own).
 */
export function olderChatsNote(saved: { provider: Provider | null } | null, form: { provider: Provider | null }): string | null {
  return saved !== null && saved.provider !== 'ag-ui' && form.provider === 'ag-ui' ? AGUI_STUDIO_TEXT.olderChats : null
}

type SavedRemote = { provider: Provider | null; agui: AguiLaunch | null }

/** Why Test is off (a fixed sentence), or null: it checks the saved file's endpoint, so nothing about it may be unsaved. */
export function aguiTestBlocked(saved: ({ name: string } & SavedRemote) | null, fields: SavedRemote): string | null {
  if (saved === null || saved.provider !== 'ag-ui' || saved.agui === null) return AGUI_STUDIO_TEXT.testSaveFirst
  if (fields.provider !== 'ag-ui' || keyOf(fields.agui) !== keyOf(saved.agui)) return AGUI_STUDIO_TEXT.testUnsaved
  return null
}

/** What a Test press answers: the saved name and launch at the press (a Save of another one, or a rename, makes a result stale). */
export const aguiTestKey = (saved: { name: string; agui: AguiLaunch | null } | null): string =>
  saved === null ? '' : JSON.stringify([saved.name, keyOf(saved.agui)])

export interface AguiTestRow {
  label: string
  value: string
}

/** The Test's answer as rows: where ZumiBot connected, how, the key, and what it hides for this engine. */
export function aguiTestRows(r: AguiTestInfo): AguiTestRow[] {
  const T = AGUI_STUDIO_TEXT
  const key = r.authKey === null ? T.noKey : `${r.authKey}, ${r.authKeyGranted ? T.keyGranted : T.notGranted}`
  return [
    { label: T.rowHost, value: r.host },
    { label: T.rowAddresses, value: r.addresses.join(', ') },
    { label: T.rowConnection, value: r.tls ? T.secure : T.plain },
    { label: T.rowAuthKey, value: key },
    { label: T.rowHides, value: r.hidden.length === 0 ? T.hidesNothing : r.hidden.join(', ') }
  ]
}

/** An option of the Auth key select: the env name, the item's name when it differs, and a note when it is no longer granted. */
export const keyOptionLabel = (c: KeyChoice): string =>
  `${c.env}${c.name !== null && c.name !== c.env ? ` (${c.name})` : ''}${c.granted ? '' : ` - ${AGUI_STUDIO_TEXT.notGranted}`}`
