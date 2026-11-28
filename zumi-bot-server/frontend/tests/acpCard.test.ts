import { describe, expect, it } from 'vitest'
import { ACP_STUDIO_TEXT, ACP_TEXT, type AcpLaunch, type AcpTestInfo } from '@zumibot/shared/acp'
import { engineCaps, missingFeatures } from '@zumibot/shared/engine'
import type { VaultListItem } from '@zumibot/shared/vault'
import {
  acpDraftError,
  acpDraftOf,
  acpTestBlocked,
  acpTestKey,
  acpTestRows,
  argsOfText,
  confirmedLaunchName,
  confirmPending,
  editAcpDraft,
  launchCompare,
  launchLine,
  shownAcpDraft,
  signInKeyChoices,
  studioCards,
  toggleSignInKey
} from '../src/state/acpCard'

const gemini: AcpLaunch = { command: 'gemini', args: ['--acp'], authEnv: [] }

describe('studioCards', () => {
  it('hides the model, tools, Compact at, daily cap, loadout, memory, desktop and browser cards for ACP, and shows its own card', () => {
    expect(studioCards('acp')).toEqual({
      models: false,
      tools: false,
      compact: false,
      dailyCap: false,
      loadout: false,
      memory: false,
      desktop: false,
      browser: false,
      recall: false,
      acp: true,
      agui: false,
      instructionsNote: null
    })
  })
  it('keeps every card for Claude, and Codex as before', () => {
    expect(studioCards('claude')).toEqual({
      models: true,
      tools: true,
      compact: true,
      dailyCap: true,
      loadout: true,
      memory: true,
      desktop: true,
      browser: true,
      recall: true,
      acp: false,
      agui: false,
      instructionsNote: null
    })
    expect(studioCards('codex')).toMatchObject({
      models: true,
      tools: false,
      compact: true,
      dailyCap: true,
      loadout: true,
      memory: false,
      desktop: false,
      acp: false
    })
  })
  it('reads the caps, not the name', () => {
    const allOn = () => ({ ...engineCaps('claude') })
    expect(studioCards('acp', allOn)).toMatchObject({
      models: true,
      compact: true,
      dailyCap: true,
      loadout: true,
      memory: true,
      desktop: true,
      acp: true
    })
  })
})

describe('the launch draft', () => {
  it('takes one argument per non-blank line, each trimmed', () => {
    expect(argsOfText('--acp\n\n  --model x  \n')).toEqual(['--acp', '--model x'])
    expect(argsOfText('')).toEqual([])
  })

  it('starts from the form launch, or empty', () => {
    expect(acpDraftOf(gemini)).toEqual({ command: 'gemini', argsText: '--acp', authEnv: [] })
    expect(acpDraftOf(null)).toEqual({ command: '', argsText: '', authEnv: [] })
  })

  it('an edit gives the launch to write: the command trimmed; none while there is no command, so Save is refused', () => {
    expect(editAcpDraft(acpDraftOf(null), { command: ' gemini ' }).acp).toEqual({ command: 'gemini', args: [], authEnv: [] })
    expect(editAcpDraft(acpDraftOf(gemini), { command: '' }).acp).toBeNull()
    expect(editAcpDraft(acpDraftOf(gemini), { argsText: '--acp\n--debug\n' }).acp).toEqual({
      command: 'gemini',
      args: ['--acp', '--debug'],
      authEnv: []
    })
    expect(editAcpDraft(acpDraftOf(gemini), { authEnv: ['GEMINI_API_KEY'] }).acp).toEqual({ ...gemini, authEnv: ['GEMINI_API_KEY'] })
  })

  it("shows the user's own text while the form holds what it made (a trailing new line, a cleared command), else the form's launch", () => {
    const typing = editAcpDraft(acpDraftOf(gemini), { argsText: '--acp\n' })
    expect(shownAcpDraft(typing.draft, typing.acp)).toBe(typing.draft)
    const cleared = editAcpDraft(acpDraftOf(gemini), { command: '' })
    expect(shownAcpDraft(cleared.draft, cleared.acp)).toBe(cleared.draft)
    // Arguments typed before a command are kept, not lost.
    const early = editAcpDraft(acpDraftOf(null), { argsText: '--acp' })
    expect(shownAcpDraft(early.draft, null).argsText).toBe('--acp')
    // Revert or a Raw edit moved the launch away: the form's wins.
    expect(shownAcpDraft(typing.draft, { command: 'opencode', args: ['acp'], authEnv: [] })).toEqual({
      command: 'opencode',
      argsText: 'acp',
      authEnv: []
    })
    expect(shownAcpDraft(null, gemini)).toEqual(acpDraftOf(gemini))
  })

  it("names the draft's problem: no command, or a refused argument with the -f sentence", () => {
    expect(acpDraftError(acpDraftOf(null))).toBe(ACP_TEXT.commandRequired)
    expect(acpDraftError(acpDraftOf(gemini))).toBeNull()
    expect(acpDraftError({ command: 'cursor-agent', argsText: 'acp\n-f', authEnv: [] })).toBe(ACP_TEXT.refusedArg('-f'))
    expect(acpDraftError({ command: 'x', argsText: Array(65).fill('a').join('\n'), authEnv: [] })).toBe(ACP_TEXT.argsInvalid)
  })
})

describe('sign-in keys', () => {
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
    key('GEMINI_API_KEY', ['gem'], 'Gemini'),
    key('OPENAI_API_KEY', ['other']),
    {
      id: 'l',
      updatedAt: 1,
      name: 'Login',
      agents: ['gem'],
      label: 'Login',
      kind: 'login',
      sites: ['x.com'],
      username: 'u',
      hasPassword: true,
      hasCode: false,
      workflows: false
    }
  ]
  it('lists the env names of the API keys granted to this agent, never a value, and marks the picked ones', () => {
    expect(signInKeyChoices(items, 'gem', ['GEMINI_API_KEY'])).toEqual([
      { env: 'GEMINI_API_KEY', name: 'Gemini', picked: true, granted: true }
    ])
    expect(signInKeyChoices(items, 'gem', [])).toEqual([{ env: 'GEMINI_API_KEY', name: 'Gemini', picked: false, granted: true }])
  })
  it('keeps a picked name that is not granted, so it can be removed', () => {
    expect(signInKeyChoices(items, 'gem', ['OPENAI_API_KEY'])).toEqual([
      { env: 'GEMINI_API_KEY', name: 'Gemini', picked: false, granted: true },
      { env: 'OPENAI_API_KEY', name: null, picked: true, granted: false }
    ])
  })
  it('an unsaved agent has no grants yet', () => {
    expect(signInKeyChoices(items, null, [])).toEqual([])
  })
  it('toggles a name, keeping the order', () => {
    expect(toggleSignInKey(['A_KEY'], 'B_KEY', true)).toEqual(['A_KEY', 'B_KEY'])
    expect(toggleSignInKey(['A_KEY', 'B_KEY'], 'A_KEY', false)).toEqual(['B_KEY'])
    expect(toggleSignInKey(['A_KEY'], 'A_KEY', true)).toEqual(['A_KEY'])
  })
})

describe('the confirmed launch beside the current one', () => {
  it('writes a launch as one line, quoting an argument with a space', () => {
    expect(launchLine(gemini)).toBe('gemini --acp')
    expect(launchLine({ command: 'x', args: ['--name', 'a b'], authEnv: ['K_EY'] })).toBe('x --name "a b" (sign-in keys: K_EY)')
  })
  it('shows nothing while they agree, before the confirmed launch is known, or with no launch in the form', () => {
    expect(launchCompare(gemini, gemini)).toBeNull()
    expect(launchCompare(undefined, gemini)).toBeNull()
    expect(launchCompare(gemini, null)).toBeNull()
  })
  it('shows both when they differ, so Save confirms a change the user has seen', () => {
    expect(launchCompare(gemini, { ...gemini, args: ['--acp', '--yolo-free'] })).toEqual({
      confirmed: 'gemini --acp',
      current: 'gemini --acp --yolo-free',
      note: ACP_STUDIO_TEXT.changed
    })
    expect(launchCompare(null, gemini)).toEqual({ confirmed: null, current: 'gemini --acp', note: ACP_STUDIO_TEXT.unconfirmed })
  })
  it('a saved ACP launch that is not the confirmed one needs a Save even with no edit', () => {
    expect(confirmPending(null, { provider: 'acp', acp: gemini })).toBe(true)
    expect(confirmPending({ ...gemini, args: [] }, { provider: 'acp', acp: gemini })).toBe(true)
    expect(confirmPending(gemini, { provider: 'acp', acp: gemini })).toBe(false)
    expect(confirmPending(undefined, { provider: 'acp', acp: gemini })).toBe(false)
    expect(confirmPending(null, { provider: 'acp', acp: null })).toBe(false)
    expect(confirmPending(null, { provider: null, acp: gemini })).toBe(false)
    expect(confirmPending(null, null)).toBe(false)
  })
})

describe('Test', () => {
  const saved = { name: 'gem', provider: 'acp' as const, acp: gemini }
  it('runs only the saved ACP launch, with nothing unsaved in the form', () => {
    expect(acpTestBlocked(saved, { provider: 'acp', acp: gemini })).toBeNull()
    expect(acpTestBlocked(null, { provider: 'acp', acp: gemini })).toBe(ACP_STUDIO_TEXT.testSaveFirst)
    expect(acpTestBlocked({ ...saved, provider: null }, { provider: 'acp', acp: gemini })).toBe(ACP_STUDIO_TEXT.testSaveFirst)
    expect(acpTestBlocked(saved, { provider: 'acp', acp: { ...gemini, command: 'gemini2' } })).toBe(ACP_STUDIO_TEXT.testUnsaved)
  })

  const info: AcpTestInfo = {
    agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version: '0.68.0' },
    protocolVersion: 1,
    loadSession: true,
    resume: false,
    systemPrompt: false,
    image: true,
    authMethods: [
      { name: 'Google login', terminal: null },
      { name: 'Terminal', terminal: 'gemini auth' }
    ],
    caps: engineCaps('acp'),
    hidden: missingFeatures(engineCaps('acp'))
  }
  it('lists what the agent supports, how ZumiBot works with it, and what it hides', () => {
    const rows = Object.fromEntries(acpTestRows(info).map((r) => [r.label, r.value]))
    expect(rows.Agent).toBe('Gemini CLI 0.68.0')
    expect(rows.Protocol).toBe('ACP v1')
    expect(rows.Sessions).toContain('load')
    expect(rows.Instructions).toContain('first message')
    expect(rows.Images).toBe('Yes')
    expect(rows['Sign-in']).toBe('Google login, Terminal (run: gemini auth)')
    expect(rows['ZumiBot hides']).toBe(info.hidden.join(', '))
  })
  it('says when the agent resumes, takes a system prompt, no images and no sign-in methods', () => {
    const rows = Object.fromEntries(
      acpTestRows({ ...info, agentInfo: null, resume: true, systemPrompt: true, image: false, authMethods: [] }).map((r) => [
        r.label,
        r.value
      ])
    )
    expect(rows.Agent).toBe('Not named')
    expect(rows.Sessions).toContain('resume')
    expect(rows.Instructions).toContain('system prompt')
    expect(rows.Images).toContain('No')
    expect(rows['Sign-in']).toBe('None listed')
  })
  it('a new session every turn when it can neither resume nor load', () => {
    const rows = Object.fromEntries(acpTestRows({ ...info, loadSession: false, resume: false }).map((r) => [r.label, r.value]))
    expect(rows.Sessions).toContain('new session')
  })
  it('without image prompts only an image is refused: another attachment goes as its path', () => {
    const rows = Object.fromEntries(acpTestRows({ ...info, image: false }).map((r) => [r.label, r.value]))
    expect(rows.Images).toBe('No: a message with an image is refused; other attachments go as their path')
  })

  it('a result answers the saved name and launch of its press: a Save of another launch (or a rename) since makes it stale', () => {
    const pressed = acpTestKey(saved)
    expect(acpTestKey({ ...saved, acp: { ...gemini } })).toBe(pressed)
    expect(acpTestKey({ ...saved, acp: { ...gemini, args: ['--acp', '--debug'] } })).not.toBe(pressed)
    expect(acpTestKey({ ...saved, acp: { ...gemini, authEnv: ['GEMINI_API_KEY'] } })).not.toBe(pressed)
    expect(acpTestKey({ ...saved, name: 'gem2' })).not.toBe(pressed)
    expect(acpTestKey({ ...saved, acp: null })).not.toBe(pressed)
    expect(acpTestKey(null)).not.toBe(pressed)
  })
})

describe('the confirmed launch Agent Studio asks for', () => {
  it("is the saved name's whenever the form's engine is ACP, whatever the saved file says", () => {
    expect(confirmedLaunchName('acp', 'gem')).toBe('gem')
    expect(confirmedLaunchName('claude', 'gem')).toBeNull()
    expect(confirmedLaunchName('codex', 'gem')).toBeNull()
    // A new agent has no saved name, so nothing is confirmed for it yet.
    expect(confirmedLaunchName('acp', null)).toBeNull()
  })
})
