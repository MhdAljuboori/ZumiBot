import { describe, expect, it } from 'vitest'
import { effortPicker, modePicker, runSummary } from '../src/state/runPickers'

const values = (v: { options: { value: string | null }[] } | null) => v?.options.map((o) => o.value)

describe('mode picker', () => {
  it("a Claude chat offers Auto (the server's), Ask permissions, Accept edits and Plan mode", () => {
    const v = modePicker('claude', {})
    expect(values(v)).toEqual([null, 'manual', 'acceptEdits', 'plan'])
    expect(v.options.map((o) => o.label)).toEqual(['Auto', 'Ask permissions', 'Accept edits', 'Plan mode'])
    expect([v.label, v.current]).toEqual(['Auto', null])
  })

  it("names the chat's own mode, and says a Plan chat goes back to Auto once its plan is approved", () => {
    const v = modePicker('claude', { permissionMode: 'plan' })
    expect([v.label, v.current]).toEqual(['Plan mode', 'plan'])
    expect(v.title).toMatch(/Approving the plan switches the chat back to Auto/)
    expect(modePicker('claude', { permissionMode: 'acceptEdits' }).label).toBe('Accept edits')
  })

  it("a Codex chat offers only Auto and Ask, and shows a Claude-only mode it can't run as Auto", () => {
    expect(values(modePicker('codex', {}))).toEqual([null, 'manual'])
    expect(modePicker('codex', { permissionMode: 'manual' }).current).toBe('manual')
    expect([modePicker('codex', { permissionMode: 'plan' }).label, modePicker('codex', { permissionMode: 'plan' }).current]).toEqual([
      'Auto',
      null
    ])
  })

  it("an ACP chat offers Ask permissions only, checked whatever the chat stored, and says the agent's own settings decide which calls ask", () => {
    for (const chat of [{}, { permissionMode: 'manual' as const }, { permissionMode: 'plan' as const }]) {
      const v = modePicker('acp', chat)
      expect(values(v)).toEqual(['manual'])
      expect(v.options.map((o) => o.label)).toEqual(['Ask permissions'])
      expect([v.label, v.current]).toEqual(['Ask permissions', 'manual'])
      expect(v.title).toMatch(/^Ask permissions: .*ask-first mode \(default\) when it has one.*own settings decide which calls ask/)
      // Nothing to change, so no "from the next message".
      expect(v.title).not.toMatch(/next message/)
    }
    expect(runSummary(null, modePicker('acp', {}), effortPicker('acp', {}))).toBe('Ask')
    expect(effortPicker('acp', {})).toBeNull()
  })

  it("a remote agent's chat offers Ask permissions only, and says the remote server decides what runs", () => {
    for (const chat of [{}, { permissionMode: 'manual' as const }, { permissionMode: 'plan' as const }]) {
      const v = modePicker('ag-ui', chat)
      expect(values(v)).toEqual(['manual'])
      expect([v.label, v.current]).toEqual(['Ask permissions', 'manual'])
      expect(v.title).toMatch(/^Ask permissions: the remote server decides what runs\..*card.*interrupt/)
      expect(v.title).not.toMatch(/next message/)
    }
    expect(effortPicker('ag-ui', {})).toBeNull()
  })
})

describe('effort picker', () => {
  it('a Claude chat offers the five levels, lowest first, and Medium when it has none of its own', () => {
    const v = effortPicker('claude', {})
    expect(values(v)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(v?.options.map((o) => o.label)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max'])
    expect([v?.label, v?.current]).toEqual(['Medium effort', 'medium'])
  })

  it("names the chat's level on the button", () => {
    const v = effortPicker('claude', { effort: 'xhigh' })
    expect([v?.label, v?.current]).toEqual(['Extra high effort', 'xhigh'])
  })

  it('a Codex chat has no effort picker', () => {
    expect(effortPicker('codex', { effort: 'high' })).toBeNull()
  })
})

describe("the phone's one chip for model, mode and effort", () => {
  it("names an agent's default model by the model alone, then the mode, and leaves the default effort out", () => {
    expect(runSummary({ label: 'Default (Opus)' }, modePicker('claude', {}), effortPicker('claude', {}))).toBe('Opus · Auto')
    expect(runSummary({ label: 'Opus' }, modePicker('claude', {}), effortPicker('claude', { effort: 'medium' }))).toBe('Opus · Auto')
  })

  it('shortens the mode to a word and adds the effort level once it is set', () => {
    expect(
      runSummary({ label: 'Sonnet' }, modePicker('claude', { permissionMode: 'plan' }), effortPicker('claude', { effort: 'high' }))
    ).toBe('Sonnet · Plan · High')
    expect(
      runSummary({ label: 'Opus' }, modePicker('claude', { permissionMode: 'acceptEdits' }), effortPicker('claude', { effort: 'xhigh' }))
    ).toBe('Opus · Accept edits · Extra high')
  })

  it('keeps a model moved by a command as the picker names it', () => {
    expect(runSummary({ label: 'Opus · /review' }, modePicker('claude', {}), null)).toBe('Opus · /review · Auto')
  })

  it('a Codex chat has no effort, and a plain Default stays as it reads', () => {
    expect(runSummary({ label: 'Default' }, modePicker('codex', { permissionMode: 'manual' }), effortPicker('codex', {}))).toBe(
      'Default · Ask'
    )
    expect(runSummary(null, null, null)).toBe('')
  })
})
