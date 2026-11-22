import { useState, type RefObject } from 'react'
import type { HookFile, HookInput } from '@zumibot/shared/extensions'
import { errorMessage } from '../errors'
import {
  HOOK_EVENTS,
  emptyHookDraft,
  hasErrors,
  hookDraftOf,
  hookErrors,
  hookInputOf,
  isHookDirty,
  type HookDraft,
  type HookSeed
} from '../state/extensionForms'
import { HOOK_FILE_LABEL } from '../state/extensionsPage'
import type { EditorHandle } from './AgentEditor'
import { Field, SaveError, useCancel, useFormGuard, useHeadingFocus } from './ExtFormParts'
import { SearchSelect } from './SearchSelect'

interface Props {
  /** The hook being edited, or null for a new one. */
  value: HookSeed | null
  /** The settings file an edit writes to (where the hook already is). */
  file?: HookFile
  /** The files a new hook may go to; null when there is nothing to choose (an agent's own hooks live in its file). */
  files: HookFile[] | null
  /** The folder the project and local files belong to, named under the choice. */
  folder?: string
  /** Rejects with the sentence to show; resolving closes the form. A new hook passes a null stamp. */
  onSave: (file: HookFile | null, input: HookInput, stamp: string | null) => void | Promise<void>
  onCancel: () => void
  handle?: RefObject<EditorHandle | null>
  /** Reopens the form from a fresh view, offered beside a stale or lost save's error. */
  onReload?: () => void
}

/** One command hook: event, matcher, command and timeout. An existing hook keeps its event and file, since its place in the file is named by them. */
export function HookForm(p: Props) {
  const editing = p.value !== null
  const [opened] = useState<HookDraft>(() => (p.value ? hookDraftOf(p.value, p.file ?? 'user') : emptyHookDraft(p.files?.[0] ?? 'user')))
  const [draft, setDraft] = useState(opened)
  const heading = useHeadingFocus<HTMLHeadingElement>()
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const dirty = isHookDirty(draft, opened)
  const { cancel, dialog } = useCancel(dirty, p.onCancel)
  const errors = hookErrors(draft)
  const err = (k: string): string | undefined => (showErrors ? errors[k] : undefined)
  const set = <K extends keyof HookDraft>(k: K, v: HookDraft[K]): void => setDraft((d) => ({ ...d, [k]: v }))

  const submit = async (): Promise<boolean> => {
    const d = draft
    if (saving) return false
    if (hasErrors(hookErrors(d))) {
      setShowErrors(true)
      return false
    }
    setSaving(true)
    setSaveError(null)
    try {
      await p.onSave(editing ? (p.file ?? null) : p.files === null ? null : d.file, hookInputOf(d), d.stamp)
      return true
    } catch (e) {
      setSaveError(errorMessage(e))
      return false
    } finally {
      setSaving(false)
    }
  }
  useFormGuard(p.handle, () => isHookDirty(draft, opened), submit)

  return (
    <div data-testid="ext-hook-form">
      <div className="vault-form-head">
        <button type="button" className="btn ghost small" data-testid="ext-form-back" onClick={cancel}>
          ← Back
        </button>
        <h2 className="vault-form-title" tabIndex={-1} ref={heading}>
          {editing ? 'Edit hook' : 'New hook'}
        </h2>
      </div>
      <div className="set-card">
        <div className="set-block vault-fields">
          {!editing && p.files !== null && (
            <Field label="Save it in" hint={draft.file !== 'user' && p.folder ? `The folder is ${p.folder}.` : undefined}>
              <SearchSelect
                className="field"
                aria-label="Save it in"
                data-testid="ext-form-file"
                value={draft.file}
                onChange={(v) => set('file', v as HookFile)}
              >
                {p.files.map((f) => (
                  <option key={f} value={f}>
                    {HOOK_FILE_LABEL[f]}
                  </option>
                ))}
              </SearchSelect>
            </Field>
          )}
          {editing && p.file !== undefined && (
            <Field label="Saved in">
              <span className="set-hint" data-testid="ext-form-file">
                {HOOK_FILE_LABEL[p.file]}
              </span>
            </Field>
          )}
          <Field
            label="Event"
            error={err('event')}
            hint={editing ? 'An existing hook keeps its event.' : 'When it runs. Pick one or type another.'}
          >
            <input
              className="field"
              aria-label="Event"
              aria-invalid={err('event') ? true : undefined}
              list="ext-hook-events"
              placeholder="PreToolUse"
              autoComplete="off"
              spellCheck={false}
              readOnly={editing}
              value={draft.event}
              onChange={(e) => set('event', e.target.value)}
            />
            <datalist id="ext-hook-events">
              {HOOK_EVENTS.map((e) => (
                <option key={e} value={e} />
              ))}
            </datalist>
          </Field>
          <Field
            label="Matcher"
            error={err('matcher')}
            hint="Which tools it applies to, such as Bash or Edit|Write. Empty means every tool."
          >
            <input
              className="field vault-mono"
              aria-label="Matcher"
              aria-invalid={err('matcher') ? true : undefined}
              autoComplete="off"
              spellCheck={false}
              value={draft.matcher}
              onChange={(e) => set('matcher', e.target.value)}
            />
          </Field>
          <Field label="Command" error={err('command')}>
            <textarea
              className="field vault-mono"
              aria-label="Command"
              aria-invalid={err('command') ? true : undefined}
              rows={3}
              autoComplete="off"
              spellCheck={false}
              value={draft.command}
              onChange={(e) => set('command', e.target.value)}
            />
          </Field>
          <Field label="Timeout (seconds)" error={err('timeout')} hint="Empty uses Claude Code's own default.">
            <input
              className="field"
              aria-label="Timeout (seconds)"
              aria-invalid={err('timeout') ? true : undefined}
              inputMode="decimal"
              autoComplete="off"
              value={draft.timeoutText}
              onChange={(e) => set('timeoutText', e.target.value)}
            />
          </Field>
        </div>
      </div>
      <SaveError error={saveError} onReload={p.onReload} />
      <div className="vault-actions">
        <button type="button" className="btn primary" data-testid="ext-form-save" disabled={saving} onClick={() => void submit()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" disabled={saving} onClick={cancel}>
          Cancel
        </button>
      </div>
      {dialog}
    </div>
  )
}
