import { AGUI_TEXT } from '@zumibot/shared/agui'
import {
  NEW_AGENT_TEMPLATE,
  parseAgent,
  serializeAgent,
  validateFields,
  type AgentFields,
  type ParsedAgent
} from '@zumibot/shared/frontmatter'

/** `raw` is the source of truth; `parsed` is always `parseAgent(raw)`. */
export interface EditorState {
  filePath: string | null
  baseRaw: string
  raw: string
  mode: 'form' | 'raw'
  parsed: ParsedAgent
}

export function initEditor(filePath: string | null, raw: string | null): EditorState {
  const text = raw ?? NEW_AGENT_TEMPLATE
  const parsed = parseAgent(text)
  return { filePath, baseRaw: text, raw: text, mode: parsed.ok ? 'form' : 'raw', parsed }
}

function withRaw(s: EditorState, raw: string): EditorState {
  const parsed = parseAgent(raw)
  return { ...s, raw, parsed, mode: parsed.ok ? s.mode : 'raw' }
}

export function editFields(s: EditorState, patch: Partial<AgentFields>): EditorState {
  if (!s.parsed.ok) return s
  const next = withRaw(s, serializeAgent(s.raw, { ...s.parsed.fields, ...patch }, s.parsed.body))
  // A patch the frontmatter cannot represent (an empty name) would leave nothing for the form to show.
  return next.parsed.ok ? next : s
}

// A textarea reports its text with LF-only line breaks; a CRLF file must get its CRLFs back.
function matchLineEndings(s: EditorState, text: string): string {
  return s.raw.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text
}

/** The text to put in a textarea: LF-only, so the DOM value equals the prop and the cursor is not reset. */
export function forTextarea(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function editBody(s: EditorState, body: string): EditorState {
  if (!s.parsed.ok) return s
  return withRaw(s, serializeAgent(s.raw, s.parsed.fields, matchLineEndings(s, body)))
}

export function editRaw(s: EditorState, raw: string): EditorState {
  return withRaw(s, matchLineEndings(s, raw))
}

export function setMode(s: EditorState, mode: 'form' | 'raw'): EditorState {
  if (mode === s.mode || (mode === 'form' && !s.parsed.ok)) return s
  return { ...s, mode }
}

/** Unsaved edits: what the leave-guard asks about. An untouched new agent has none. */
export function isDirty(s: EditorState): boolean {
  return s.raw !== s.baseRaw
}

/** Whether Save does anything: edits, or a new agent that was never written (even untouched). */
export function needsSave(s: EditorState): boolean {
  return isDirty(s) || s.filePath === null
}

/**
 * Why Save is refused. `aguiDraft` is the remote card's own sentence for the draft it holds (`aguiDraftError`), null without
 * one: while that draft is no valid launch the form holds none, so its sentence stands in for the missing-endpoint one.
 */
export function saveErrors(s: EditorState, aguiDraft: string | null = null): string[] {
  if (!s.parsed.ok) return [s.parsed.error]
  const errors = validateFields(s.parsed.fields, s.parsed.acpEditable, s.parsed.aguiEditable)
  return aguiDraft === null ? errors : errors.map((e) => (e === AGUI_TEXT.endpointRequired ? aguiDraft : e))
}

export function markSaved(s: EditorState, filePath: string): EditorState {
  return { ...s, filePath, baseRaw: s.raw }
}
