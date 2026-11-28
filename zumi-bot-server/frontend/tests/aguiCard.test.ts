import { describe, expect, it } from 'vitest'
import { AGUI_STUDIO_TEXT, AGUI_TEXT, type AguiLaunch, type AguiTestInfo } from '@zumibot/shared/agui'
import { ACP_STUDIO_TEXT, type AcpLaunch } from '@zumibot/shared/acp'
import { engineCaps, missingFeatures } from '@zumibot/shared/engine'
import type { VaultListItem } from '@zumibot/shared/vault'
import {
  aguiDraftError,
  aguiDraftOf,
  aguiLaunchLine,
  aguiTestBlocked,
  aguiTestKey,
  aguiTestRows,
  confirmedAgui,
  editAguiDraft,
  isAguiLaunch,
  keyChoices,
  keyOptionLabel,
  olderChatsNote,
  remoteNotice,
  shownAguiDraft,
  type AguiDraft
} from '../src/state/aguiCard'
import { editFields, initEditor, saveErrors, type EditorState } from '../src/state/editorState'
import { confirmedAcp, confirmedFor, confirmedLaunchName, confirmPending, launchCompare, studioCards } from '../src/state/acpCard'

const remote: AguiLaunch = { endpoint: 'https://agents.example.com/run', authKey: 'REMOTE_KEY', authHeader: null }
const gemini: AcpLaunch = { command: 'gemini', args: ['--acp'], authEnv: [] }

describe('studioCards for a remote agent', () => {
  it('shows only its own card and the instructions note, and hides every card its engine cannot use', () => {
    expect(studioCards('ag-ui')).toEqual({
      models: false,
      tools: false,
      compact: false,
      dailyCap: false,
      loadout: false,
      memory: false,
      desktop: false,
      browser: false,
      recall: false,
      acp: false,
      agui: true,
      instructionsNote: AGUI_STUDIO_TEXT.body
    })
  })
  it('no other engine gets the card or the note', () => {
    for (const e of ['claude', 'codex', 'acp'] as const) {
      expect(studioCards(e)).toMatchObject({ agui: false, instructionsNote: null })
    }
    expect(studioCards('acp').acp).toBe(true)
  })
  it('the Recall card follows the bridges: Claude and Codex agents, never ACP or remote ones', () => {
    expect(studioCards('claude').recall).toBe(true)
    expect(studioCards('codex').recall).toBe(true)
    expect(studioCards('acp').recall).toBe(false)
  })
})

describe('the launch draft', () => {
  it('starts from the form launch, or empty', () => {
    expect(aguiDraftOf(remote)).toEqual({ endpoint: remote.endpoint, authKey: 'REMOTE_KEY', authHeader: '' })
    expect(aguiDraftOf({ ...remote, authHeader: 'X-Api-Key' }).authHeader).toBe('X-Api-Key')
    expect(aguiDraftOf(null)).toEqual({ endpoint: '', authKey: null, authHeader: '' })
  })

  it('an edit gives the launch to write: trimmed, a blank header as none; none while the endpoint is blank, so Save is refused', () => {
    expect(editAguiDraft(aguiDraftOf(null), { endpoint: ' https://a.example.com/run ' }).agui).toEqual({
      endpoint: 'https://a.example.com/run',
      authKey: null,
      authHeader: null
    })
    expect(editAguiDraft(aguiDraftOf(remote), { authHeader: ' X-Api-Key ' }).agui).toEqual({ ...remote, authHeader: 'X-Api-Key' })
    expect(editAguiDraft(aguiDraftOf(remote), { authHeader: '  ' }).agui).toEqual(remote)
    expect(editAguiDraft(aguiDraftOf(remote), { endpoint: '' }).agui).toBeNull()
    expect(editAguiDraft(aguiDraftOf(remote), { authKey: null }).agui).toEqual({ ...remote, authKey: null })
  })

  it('an edit that makes a bad launch gives the form none, so Save is refused rather than saving the last launch the card no longer shows', () => {
    // The file never holds a launch that does not parse (serializeAgent skips it), so the form could not hold this one anyway.
    const bad = editAguiDraft(aguiDraftOf(remote), { endpoint: 'https://u:p@agents.example.com/run' })
    expect(bad.agui).toBeNull()
    expect(shownAguiDraft(bad.draft, bad.agui)).toBe(bad.draft)
    expect(aguiDraftError(bad.draft)).toBe(AGUI_TEXT.endpointInvalid)
    expect(editAguiDraft(aguiDraftOf(remote), { authHeader: 'Host' }).agui).toBeNull()
    expect(editAguiDraft(aguiDraftOf(null), { authHeader: 'Host' }).agui).toBeNull()
  })

  // What the browser does: each key goes through the form, the agent file and back (editFields), and the card shows the result.
  const typeInto = (s: EditorState, field: 'endpoint' | 'authHeader', text: string): { s: EditorState; draft: AguiDraft } => {
    let draft: AguiDraft | null = null
    const formLaunch = (e: EditorState) => (e.parsed.ok ? e.parsed.fields.agui : null)
    for (const ch of text) {
      const shown = shownAguiDraft(draft, formLaunch(s))
      const next = editAguiDraft(shown, { [field]: shown[field] + ch })
      draft = next.draft
      s = editFields(s, { agui: next.agui })
    }
    return { s, draft: shownAguiDraft(draft, formLaunch(s)) }
  }
  const remoteEditor = () => editFields(initEditor(null, null), { provider: 'ag-ui' })

  it('keeps every key typed, through the agent file, whether the endpoint ends up good or bad', () => {
    const good = typeInto(remoteEditor(), 'endpoint', 'https://agents.example.com/run')
    expect(good.draft.endpoint).toBe('https://agents.example.com/run')
    expect(good.s.parsed.ok && good.s.parsed.fields.agui).toEqual({
      endpoint: 'https://agents.example.com/run',
      authKey: null,
      authHeader: null
    })
    expect(saveErrors(good.s)).toEqual([])
    const bad = typeInto(remoteEditor(), 'endpoint', 'https://u:p@agents.example.com/run#x')
    expect(bad.draft.endpoint).toBe('https://u:p@agents.example.com/run#x')
    expect(aguiDraftError(bad.draft)).toBe(AGUI_TEXT.endpointInvalid)
    expect(bad.s.parsed.ok && bad.s.parsed.fields.agui).toBeNull()
    expect(saveErrors(bad.s)).toEqual([AGUI_TEXT.endpointRequired])
  })

  it('keeps a refused header as typed, and drops the saved launch from the form so Save is refused', () => {
    const saved = editFields(remoteEditor(), { agui: remote })
    const typed = typeInto(saved, 'authHeader', 'Content-Type')
    expect(typed.draft.authHeader).toBe('Content-Type')
    expect(aguiDraftError(typed.draft)).toBe(AGUI_TEXT.authHeaderInvalid('Content-Type'))
    expect(saveErrors(typed.s)).toEqual([AGUI_TEXT.endpointRequired])
  })

  it("shows the user's own text while the form holds what it made, else the form's launch", () => {
    const typing = editAguiDraft(aguiDraftOf(remote), { endpoint: 'https://agents.example.com/run ' })
    expect(shownAguiDraft(typing.draft, typing.agui)).toBe(typing.draft)
    const cleared = editAguiDraft(aguiDraftOf(remote), { endpoint: '' })
    expect(shownAguiDraft(cleared.draft, cleared.agui)).toBe(cleared.draft)
    // A header typed before a key is kept, not lost.
    const early = editAguiDraft(aguiDraftOf(null), { authHeader: 'X-Api-Key' })
    expect(shownAguiDraft(early.draft, early.agui).authHeader).toBe('X-Api-Key')
    // Revert or a Raw edit moved the launch away: the form's wins.
    expect(shownAguiDraft(typing.draft, { ...remote, endpoint: 'https://other.example.com/run' }).endpoint).toBe(
      'https://other.example.com/run'
    )
    expect(shownAguiDraft(null, remote)).toEqual(aguiDraftOf(remote))
  })

  it("names the draft's problem as the save would", () => {
    expect(aguiDraftError(aguiDraftOf(null))).toBe(AGUI_TEXT.endpointRequired)
    expect(aguiDraftError(aguiDraftOf(remote))).toBeNull()
    expect(aguiDraftError({ ...aguiDraftOf(remote), endpoint: 'ftp://x' })).toBe(AGUI_TEXT.endpointInvalid)
    expect(aguiDraftError({ ...aguiDraftOf(remote), endpoint: 'https://u:p@x.example.com/' })).toBe(AGUI_TEXT.endpointInvalid)
    expect(aguiDraftError({ ...aguiDraftOf(remote), authHeader: 'Host' })).toBe(AGUI_TEXT.authHeaderInvalid('Host'))
    expect(aguiDraftError({ endpoint: remote.endpoint, authKey: null, authHeader: 'X-Api-Key' })).toBe(AGUI_TEXT.authHeaderWithoutKey)
  })
})

describe('the auth key', () => {
  const key = (env: string, agents: string[], name = env): VaultListItem => ({
    id: env,
    updatedAt: 1,
    name,
    agents,
    label: name,
    kind: 'apiKey',
    env,
    description: '',
    hasValue: true,
    workflows: false
  })
  const items: VaultListItem[] = [
    key('REMOTE_KEY', ['rem'], 'Remote'),
    key('OTHER_KEY', ['other']),
    {
      id: 'l',
      updatedAt: 1,
      name: 'Login',
      agents: ['rem'],
      label: 'Login',
      kind: 'login',
      sites: ['x.com'],
      username: 'u',
      hasPassword: true,
      hasCode: false,
      workflows: false
    }
  ]
  it('lists the env names of the API keys granted to this agent, never a value, and marks the picked one', () => {
    expect(keyChoices(items, 'rem', 'REMOTE_KEY')).toEqual([{ env: 'REMOTE_KEY', name: 'Remote', picked: true, granted: true }])
    expect(keyChoices(items, 'rem', null)).toEqual([{ env: 'REMOTE_KEY', name: 'Remote', picked: false, granted: true }])
  })
  it('keeps a listed name that is not granted, so it can be changed', () => {
    expect(keyChoices(items, 'rem', 'OTHER_KEY')).toEqual([
      { env: 'REMOTE_KEY', name: 'Remote', picked: false, granted: true },
      { env: 'OTHER_KEY', name: null, picked: true, granted: false }
    ])
  })
  it('an unsaved agent has no grants yet', () => {
    expect(keyChoices(items, null, null)).toEqual([])
    expect(keyChoices(items, null, 'REMOTE_KEY')).toEqual([{ env: 'REMOTE_KEY', name: null, picked: true, granted: false }])
  })
})

describe('keyOptionLabel', () => {
  it('names the env, the item when it differs, and a key no longer granted', () => {
    expect(keyOptionLabel({ env: 'A_KEY', name: 'A_KEY', picked: false, granted: true })).toBe('A_KEY')
    expect(keyOptionLabel({ env: 'A_KEY', name: 'Alpha', picked: false, granted: true })).toBe('A_KEY (Alpha)')
    expect(keyOptionLabel({ env: 'A_KEY', name: null, picked: true, granted: false })).toBe(`A_KEY - ${AGUI_STUDIO_TEXT.notGranted}`)
  })
})

describe('the confirmed launch beside the current one', () => {
  it('writes a launch as one line, with its key and header', () => {
    expect(aguiLaunchLine({ endpoint: 'https://a.example.com/run', authKey: null, authHeader: null })).toBe('https://a.example.com/run')
    expect(aguiLaunchLine(remote)).toBe('https://agents.example.com/run (auth key: REMOTE_KEY)')
    expect(aguiLaunchLine({ ...remote, authHeader: 'X-Api-Key' })).toBe(
      'https://agents.example.com/run (auth key: REMOTE_KEY, header: X-Api-Key)'
    )
  })
  it('tells the two launch kinds apart', () => {
    expect(isAguiLaunch(remote)).toBe(true)
    expect(isAguiLaunch(gemini)).toBe(false)
    expect(confirmedAgui(undefined)).toBeUndefined()
    expect(confirmedAgui(null)).toBeNull()
    expect(confirmedAgui(remote)).toBe(remote)
    expect(confirmedAgui(gemini)).toBeNull()
    expect(confirmedAcp(gemini)).toBe(gemini)
    expect(confirmedAcp(remote)).toBeNull()
    expect(confirmedAcp(undefined)).toBeUndefined()
  })
  it('launchCompare shows nothing while they agree, before the confirmed one is known, or with no launch in the form', () => {
    expect(launchCompare(remote, remote)).toBeNull()
    expect(launchCompare(undefined, remote)).toBeNull()
    expect(launchCompare(remote, null)).toBeNull()
  })
  it("launchCompare uses the remote agent's notes, and says a moved endpoint keeps the existing chats", () => {
    expect(launchCompare(null, remote)).toEqual({ confirmed: null, current: aguiLaunchLine(remote), note: AGUI_STUDIO_TEXT.unconfirmed })
    const moved = { ...remote, endpoint: 'https://new.example.com/run' }
    const c = launchCompare(remote, moved)
    expect(c).toEqual({ confirmed: aguiLaunchLine(remote), current: aguiLaunchLine(moved), note: AGUI_STUDIO_TEXT.changed })
    expect(c?.note).toContain('Existing chats continue at the new host')
    // A changed key or header counts too.
    expect(launchCompare(remote, { ...remote, authKey: 'OTHER_KEY' })?.note).toBe(AGUI_STUDIO_TEXT.changed)
    expect(launchCompare(remote, { ...remote, authHeader: 'X-Api-Key' })?.note).toBe(AGUI_STUDIO_TEXT.changed)
  })
  it('launchCompare keeps ACP its own notes', () => {
    expect(launchCompare(null, gemini)?.note).toBe(ACP_STUDIO_TEXT.unconfirmed)
  })
  it('a saved remote launch that is not the confirmed one needs a Save even with no edit', () => {
    expect(confirmPending(null, { provider: 'ag-ui', acp: null, agui: remote })).toBe(true)
    expect(confirmPending({ ...remote, authKey: null }, { provider: 'ag-ui', acp: null, agui: remote })).toBe(true)
    expect(confirmPending(remote, { provider: 'ag-ui', acp: null, agui: remote })).toBe(false)
    expect(confirmPending(undefined, { provider: 'ag-ui', acp: null, agui: remote })).toBe(false)
    expect(confirmPending(null, { provider: 'ag-ui', acp: null, agui: null })).toBe(false)
    // An agui: kept on another engine is no pending confirmation.
    expect(confirmPending(null, { provider: null, acp: null, agui: remote })).toBe(false)
    expect(confirmPending(null, { provider: 'acp', acp: null, agui: remote })).toBe(false)
  })
  it('a loaded launch counts only for the engine it was asked for, so a flip between ACP and remote never shows the old one', () => {
    expect(confirmedFor('ag-ui', { engine: 'ag-ui', launch: remote })).toBe(remote)
    expect(confirmedFor('ag-ui', { engine: 'ag-ui', launch: null })).toBeNull()
    expect(confirmedFor('ag-ui', { engine: 'acp', launch: gemini })).toBeUndefined()
    expect(confirmedFor('ag-ui', { engine: 'acp', launch: null })).toBeUndefined()
    expect(confirmedFor('acp', { engine: 'ag-ui', launch: remote })).toBeUndefined()
    expect(confirmedFor('acp', undefined)).toBeUndefined()
  })
  it("the confirmed launch is asked for whenever the form's engine is a protocol engine", () => {
    expect(confirmedLaunchName('ag-ui', 'rem')).toBe('rem')
    expect(confirmedLaunchName('ag-ui', null)).toBeNull()
    expect(confirmedLaunchName('claude', 'rem')).toBeNull()
  })
})

describe('the notes', () => {
  it('the remote notice names the host, with a non-default port, and is absent without a readable endpoint', () => {
    expect(remoteNotice(remote)).toBe(AGUI_STUDIO_TEXT.remote('agents.example.com'))
    expect(remoteNotice({ ...remote, endpoint: 'https://agents.example.com:8443/run?x=1' })).toBe(
      AGUI_STUDIO_TEXT.remote('agents.example.com:8443')
    )
    expect(remoteNotice({ ...remote, endpoint: 'not a url' })).toBeNull()
    expect(remoteNotice(null)).toBeNull()
  })
  it('older chats are noted once the Engine select moves a saved agent onto a remote engine, not for a new or already remote one', () => {
    const form = { provider: 'ag-ui' as const }
    expect(olderChatsNote({ provider: null }, form)).toBe(AGUI_STUDIO_TEXT.olderChats)
    expect(olderChatsNote({ provider: 'acp' }, form)).toBe(AGUI_STUDIO_TEXT.olderChats)
    expect(olderChatsNote({ provider: 'ag-ui' }, form)).toBeNull()
    expect(olderChatsNote(null, form)).toBeNull()
    expect(olderChatsNote({ provider: null }, { provider: null })).toBeNull()
  })
})

describe('Test', () => {
  const saved = { name: 'rem', provider: 'ag-ui' as const, agui: remote }
  it('runs only the saved endpoint, with nothing unsaved in the form', () => {
    expect(aguiTestBlocked(saved, { provider: 'ag-ui', agui: remote })).toBeNull()
    expect(aguiTestBlocked(null, { provider: 'ag-ui', agui: remote })).toBe(AGUI_STUDIO_TEXT.testSaveFirst)
    expect(aguiTestBlocked({ ...saved, provider: null }, { provider: 'ag-ui', agui: remote })).toBe(AGUI_STUDIO_TEXT.testSaveFirst)
    expect(aguiTestBlocked({ ...saved, agui: null }, { provider: 'ag-ui', agui: remote })).toBe(AGUI_STUDIO_TEXT.testSaveFirst)
    expect(aguiTestBlocked(saved, { provider: 'ag-ui', agui: { ...remote, endpoint: 'https://x.example.com' } })).toBe(
      AGUI_STUDIO_TEXT.testUnsaved
    )
    expect(aguiTestBlocked(saved, { provider: 'ag-ui', agui: { ...remote, authKey: null } })).toBe(AGUI_STUDIO_TEXT.testUnsaved)
    expect(aguiTestBlocked(saved, { provider: null, agui: remote })).toBe(AGUI_STUDIO_TEXT.testUnsaved)
  })

  it('a result answers the saved name and launch of its press: a Save of another launch (or a rename) since makes it stale', () => {
    const pressed = aguiTestKey(saved)
    expect(aguiTestKey({ ...saved, agui: { ...remote } })).toBe(pressed)
    expect(aguiTestKey({ ...saved, agui: { ...remote, endpoint: 'https://b.example.com/run' } })).not.toBe(pressed)
    expect(aguiTestKey({ ...saved, agui: { ...remote, authKey: null } })).not.toBe(pressed)
    expect(aguiTestKey({ ...saved, agui: { ...remote, authHeader: 'X-Api-Key' } })).not.toBe(pressed)
    expect(aguiTestKey({ ...saved, name: 'rem2' })).not.toBe(pressed)
    expect(aguiTestKey({ ...saved, agui: null })).not.toBe(pressed)
    expect(aguiTestKey(null)).not.toBe(pressed)
  })

  const info: AguiTestInfo = {
    host: 'agents.example.com',
    addresses: ['93.184.216.34', '2606:2800:220:1::248'],
    tls: true,
    authKey: 'REMOTE_KEY',
    authKeyGranted: true,
    caps: engineCaps('ag-ui'),
    hidden: missingFeatures(engineCaps('ag-ui'))
  }
  const T = AGUI_STUDIO_TEXT
  const rows = (r: AguiTestInfo) => Object.fromEntries(aguiTestRows(r).map((x) => [x.label, x.value]))
  it('lists the host, its addresses, the connection, the key and what ZumiBot hides', () => {
    const r = rows(info)
    expect(r[T.rowHost]).toBe('agents.example.com')
    expect(r[T.rowAddresses]).toBe('93.184.216.34, 2606:2800:220:1::248')
    expect(r[T.rowConnection]).toBe(T.secure)
    expect(r[T.rowAuthKey]).toBe(`REMOTE_KEY, ${T.keyGranted}`)
    expect(r[T.rowHides]).toBe(info.hidden.join(', '))
  })
  it('says when the key is not granted, when there is none, and when the connection is plain (the dev hook)', () => {
    expect(rows({ ...info, authKeyGranted: false })[T.rowAuthKey]).toBe(`REMOTE_KEY, ${T.notGranted}`)
    expect(rows({ ...info, authKey: null, authKeyGranted: false })[T.rowAuthKey]).toBe(T.noKey)
    expect(rows({ ...info, tls: false })[T.rowConnection]).toBe(T.plain)
    expect(rows({ ...info, hidden: [] })[T.rowHides]).toBe(T.hidesNothing)
  })
})
