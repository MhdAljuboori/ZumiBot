import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  editBody,
  editFields,
  editRaw,
  forTextarea,
  initEditor,
  isDirty,
  needsSave,
  markSaved,
  saveErrors,
  setMode,
  type EditorState
} from '../src/state/editorState'

import { ACP_TEXT } from '@zumibot/shared/acp'
import { AGUI_TEXT } from '@zumibot/shared/agui'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/agents/${name}`, import.meta.url), 'utf8')
const open = (name: string): EditorState => initEditor(`/agents/${name}`, fixture(name))

describe('initEditor', () => {
  it('opens a fixture clean, in form mode', () => {
    const s = open('unknown-keys.md')
    expect(isDirty(s)).toBe(false)
    expect(s.mode).toBe('form')
    expect(s.raw).toBe(fixture('unknown-keys.md'))
  })

  it('opens a CRLF fixture clean', () => {
    const s = open('crlf.md')
    expect(s.parsed.ok).toBe(true)
    expect(isDirty(s)).toBe(false)
  })

  it('opens an unparseable file in raw mode with its error', () => {
    const s = initEditor('/agents/bad.md', 'no frontmatter here')
    expect(s.mode).toBe('raw')
    expect(s.parsed.ok).toBe(false)
    expect(saveErrors(s)).toHaveLength(1)
  })

  it('seeds a new agent from the template and keeps it clean until edited', () => {
    const s = initEditor(null, null)
    expect(isDirty(s)).toBe(false)
    expect(needsSave(s)).toBe(true)
    expect(s.parsed.ok && s.parsed.fields.name).toBe('new-agent')
    expect(s.mode).toBe('form')
    const edited = editFields(s, { name: 'fresh' })
    expect(isDirty(edited)).toBe(true)
    expect(isDirty(markSaved(edited, '/agents/fresh.md'))).toBe(false)
    expect(isDirty(editFields(edited, { name: 'new-agent' }))).toBe(false)
  })

  it('needs saving only when dirty, or when it has never been written', () => {
    const open = initEditor('/agents/a.md', '---\nname: a\ndescription: d\n---\nbody\n')
    expect(needsSave(open)).toBe(false)
    expect(needsSave(editFields(open, { color: 'red' }))).toBe(true)
    expect(needsSave(markSaved(initEditor(null, null), '/agents/new-agent.md'))).toBe(false)
  })

  it('revert on a new agent returns to the template', () => {
    const edited = editFields(initEditor(null, null), { name: 'fresh' })
    const reverted = initEditor(edited.filePath, edited.baseRaw)
    expect(reverted.raw).toBe(initEditor(null, null).raw)
    expect(isDirty(reverted)).toBe(false)
  })
})

describe('editFields', () => {
  it('returns to the original bytes when a value is edited back', () => {
    const s = open('unknown-keys.md')
    const changed = editFields(s, { model: 'haiku' })
    expect(isDirty(changed)).toBe(true)
    const back = editFields(changed, { model: 'opus' })
    expect(back.raw).toBe(back.baseRaw)
    expect(isDirty(back)).toBe(false)
  })

  it('changes only the edited key and keeps unknown keys and comments', () => {
    const s = editFields(open('unknown-keys.md'), { color: 'red' })
    expect(s.raw).toBe(fixture('unknown-keys.md').replace('color: purple', 'color: red'))
  })

  it('keeps a raw-added key through a later form edit', () => {
    const base = open('unknown-keys.md')
    const withKey = editRaw(base, base.raw.replace('maxTurns: 7', 'maxTurns: 7\nextra: 3'))
    const s = editFields(withKey, { color: 'red' })
    expect(s.raw).toContain('extra: 3')
    expect(s.raw).toContain('color: red')
    expect(s.raw).toContain('mcpServers: [workiom]')
  })

  it('refuses a patch while the raw text does not parse', () => {
    const broken = editRaw(open('unknown-keys.md'), 'garbage')
    expect(editFields(broken, { color: 'red' })).toBe(broken)
  })

  it('refuses a patch that would leave the file unparseable (empty name)', () => {
    const s = open('unknown-keys.md')
    expect(editFields(s, { name: '' })).toBe(s)
  })

  it('editFields with an icon writes it after color', () => {
    const s = editFields(open('unknown-keys.md'), { icon: 'circles' })
    expect(s.raw).toContain('color: purple\nicon: circles\n')
    expect(isDirty(s)).toBe(true)
  })

  it('editing commands rewrites only the commands key', () => {
    const s = open('unknown-keys.md')
    const cmds = [{ name: 'check', description: 'c', prompt: 'p' }]
    const added = editFields(s, { commands: cmds })
    expect(added.parsed.ok && added.parsed.fields.commands).toEqual(cmds)
    expect(added.parsed.ok && added.parsed.body).toBe(s.parsed.ok && s.parsed.body)
    expect(isDirty(added)).toBe(true)
    const removed = editFields(added, { commands: null })
    expect(removed.raw).toBe(fixture('unknown-keys.md'))
    expect(isDirty(removed)).toBe(false)
  })

  it('removing the last command of a file that had commands drops the key', () => {
    const raw = '---\nname: a\ndescription: d\ncommands:\n  - name: check\n    description: c\n    prompt: p\n---\nbody\n'
    const s = initEditor('/agents/a.md', raw)
    expect(s.parsed.ok && s.parsed.fields.commands).toHaveLength(1)
    const emptied = editFields(s, { commands: null })
    expect(emptied.raw).toBe('---\nname: a\ndescription: d\n---\nbody\n')
    expect(editFields(s, { commands: [] }).raw).toBe(emptied.raw)
  })

  it('an empty commands list on a file with no commands key is a no-op', () => {
    for (const name of ['unknown-keys.md', 'odd-format.md', 'crlf.md', 'tools-list.md', 'with-icon.md']) {
      const s = open(name)
      const same = editFields(s, { commands: [] })
      expect(same.raw, name).toBe(s.raw)
      expect(isDirty(same), name).toBe(false)
      expect(editFields(s, { commands: null }).raw, name).toBe(s.raw)
    }
  })

  it('keeps CRLF line endings on a form edit', () => {
    const s = editFields(open('crlf.md'), { color: 'red' })
    expect(s.raw).not.toMatch(/[^\r]\n/)
  })
})

describe('editBody', () => {
  it('leaves the frontmatter bytes untouched', () => {
    const s = open('unknown-keys.md')
    const next = editBody(s, '\nNew body.\n')
    expect(next.raw).toBe(fixture('unknown-keys.md').replace('Body text.', 'New body.'))
    expect(next.parsed.ok && next.parsed.body).toBe('\nNew body.\n')
  })

  it('returns to clean when the body is edited back', () => {
    const s = open('unknown-keys.md')
    if (!s.parsed.ok) throw new Error('fixture must parse')
    const back = editBody(editBody(s, 'x'), s.parsed.body)
    expect(isDirty(back)).toBe(false)
  })
})

describe('editRaw and setMode', () => {
  it('refuses form mode after garbage and reports exactly one error', () => {
    const s = editRaw(open('unknown-keys.md'), 'garbage')
    expect(setMode(s, 'form')).toBe(s)
    expect(saveErrors(s)).toHaveLength(1)
  })

  it('falls back to raw mode when an edit makes the text unparseable', () => {
    const s = editRaw(open('unknown-keys.md'), 'garbage')
    expect(s.mode).toBe('raw')
  })

  it('allows switching modes while the text parses, keeping the edits', () => {
    const s = editFields(open('unknown-keys.md'), { color: 'red' })
    const raw = setMode(s, 'raw')
    expect(raw.mode).toBe('raw')
    expect(raw.raw).toBe(s.raw)
    expect(setMode(raw, 'form').mode).toBe('form')
  })

  it('reports validation errors for a parseable but invalid agent', () => {
    const s = editFields(open('unknown-keys.md'), { name: 'Bad Name', description: ' ' })
    expect(saveErrors(s)).toHaveLength(2)
  })
})

describe('an ACP agent', () => {
  it('picking ACP in the Engine select refuses Save until the agent has a command', () => {
    const picked = editFields(initEditor(null, null), { provider: 'acp' })
    expect(picked.parsed.ok && picked.parsed.fields.provider).toBe('acp')
    expect(saveErrors(picked)).toEqual([ACP_TEXT.commandRequired])
    const set = editFields(picked, { acp: { command: 'gemini', args: ['--acp'], authEnv: [] } })
    expect(saveErrors(set)).toEqual([])
    expect(set.raw).toContain('command: gemini')
  })

  it('an acp: the form could not read gets the hint to quote numbers, not the missing-command sentence', () => {
    const s = initEditor(
      '/agents/a.md',
      '---\nname: a\ndescription: d\nprovider: acp\nacp:\n  command: srv\n  args: [--port, 8080]\n---\nB\n'
    )
    expect(saveErrors(s)).toEqual([ACP_TEXT.launchUnreadable])
  })
})

describe('a remote (AG-UI) agent', () => {
  it('picking it refuses Save until the agent has an endpoint', () => {
    const picked = editFields(initEditor(null, null), { provider: 'ag-ui' })
    expect(saveErrors(picked)).toEqual([AGUI_TEXT.endpointRequired])
    expect(
      saveErrors(editFields(picked, { agui: { endpoint: 'https://agents.example.com/run', authKey: null, authHeader: null } }))
    ).toEqual([])
  })

  it("names the card's own problem in place of the missing-endpoint sentence while the card holds an invalid draft", () => {
    const picked = editFields(initEditor(null, null), { provider: 'ag-ui' })
    expect(saveErrors(picked, AGUI_TEXT.endpointInvalid)).toEqual([AGUI_TEXT.endpointInvalid])
    expect(saveErrors(picked, AGUI_TEXT.authHeaderWithoutKey)).toEqual([AGUI_TEXT.authHeaderWithoutKey])
    // No draft problem leaves the sentence as it was; so does a form that holds a launch (nothing is missing).
    expect(saveErrors(picked, null)).toEqual([AGUI_TEXT.endpointRequired])
    const launched = editFields(picked, { agui: { endpoint: 'https://agents.example.com/run', authKey: null, authHeader: null } })
    expect(saveErrors(launched, AGUI_TEXT.endpointInvalid)).toEqual([])
    // Other errors stay, in their order.
    expect(saveErrors(editFields(picked, { description: '' }), AGUI_TEXT.endpointInvalid)).toEqual([
      'Description is required',
      AGUI_TEXT.endpointInvalid
    ])
    // A file that does not parse has one error, whatever the card says.
    expect(saveErrors(editRaw(picked, 'garbage'), AGUI_TEXT.endpointInvalid)).toHaveLength(1)
    expect(saveErrors(editRaw(picked, 'garbage'), AGUI_TEXT.endpointInvalid)[0]).not.toBe(AGUI_TEXT.endpointInvalid)
  })

  it('an agui: the form could not read gets the Raw view hint, not the missing-endpoint sentence', () => {
    const s = initEditor('/agents/a.md', '---\nname: a\ndescription: d\nprovider: ag-ui\nagui: https://agents.example.com/run\n---\nB\n')
    expect(saveErrors(s)).toEqual([AGUI_TEXT.launchUnreadable])
  })
})

describe('markSaved', () => {
  it('makes the editor clean and records the new path', () => {
    const s = editFields(initEditor(null, null), { name: 'fresh' })
    expect(isDirty(s)).toBe(true)
    const saved = markSaved(s, '/agents/fresh.md')
    expect(saved.filePath).toBe('/agents/fresh.md')
    expect(saved.baseRaw).toBe(s.raw)
    expect(isDirty(saved)).toBe(false)
  })
})

describe('line endings', () => {
  // A textarea hands back LF-only text, so edits on a CRLF file must be mapped back to CRLF.
  const crlf = (): EditorState => open('crlf.md')
  const lf = (text: string): string => text.replace(/\r\n/g, '\n')

  it('keeps CRLF everywhere on a Raw edit', () => {
    const s = crlf()
    const next = editRaw(s, lf(s.raw).replace('maxTurns: 7', 'maxTurns: 8'))
    expect(next.raw).toBe(s.raw.replace('maxTurns: 7', 'maxTurns: 8'))
    expect(next.raw).not.toMatch(/[^\r]\n/)
  })

  it('keeps CRLF on a Prompt edit', () => {
    const next = editBody(crlf(), '\nNew body.\nSecond line.\n')
    expect(next.raw).not.toMatch(/[^\r]\n/)
    expect(next.raw.endsWith('\r\n\r\nNew body.\r\nSecond line.\r\n')).toBe(true)
  })

  it('is clean again after a Raw edit is typed back', () => {
    const s = crlf()
    const edited = editRaw(s, lf(s.raw) + 'x')
    expect(isDirty(edited)).toBe(true)
    expect(isDirty(editRaw(edited, lf(s.raw)))).toBe(false)
  })

  it('is clean again after a Prompt edit is typed back', () => {
    const s = crlf()
    if (!s.parsed.ok) throw new Error('fixture must parse')
    const back = editBody(editBody(s, 'x'), lf(s.parsed.body))
    expect(isDirty(back)).toBe(false)
  })

  it('does not touch an LF file', () => {
    const s = open('unknown-keys.md')
    expect(editRaw(s, s.raw + 'x\ny').raw).toBe(s.raw + 'x\ny')
    expect(editBody(s, 'a\nb\n').raw).not.toContain('\r')
  })

  it('shows a CRLF file to the textarea as LF so the cursor is not reset', () => {
    expect(forTextarea('a\r\nb\n')).toBe('a\nb\n')
  })
})
