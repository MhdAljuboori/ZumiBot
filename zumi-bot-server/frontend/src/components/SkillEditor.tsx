import { useState, type RefObject } from 'react'
import { errorMessage } from '../errors'
import { emptySkillDraft, hasErrors, isSkillDirty, skillDraftOf, skillErrors, skillInputOf, type SkillDraft } from '../state/extensionForms'
import { removeText } from '../state/extensionsPage'
import type { SkillView } from '@zumibot/shared/extensions'
import type { EditorHandle } from './AgentEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { Field, SaveError, useCancel, useFormGuard, useHeadingFocus } from './ExtFormParts'
import { SearchSelect } from './SearchSelect'

type SkillScope = 'user' | 'project'

const SCOPE_TEXT: Record<SkillScope, string> = {
  user: 'You: available in every folder (~/.claude/skills)',
  project: 'This folder, shared with the project (.claude/skills)'
}

interface Props {
  /** The skill being edited, or null for a new one. */
  view: SkillView | null
  /** The folder a project skill belongs to, named under the choice. */
  folder?: string
  /** Rejects with the sentence to show; resolving closes the editor. */
  onSave: (scope: SkillScope, input: { name: string; description: string; body: string; stamp?: string }) => void | Promise<void>
  /** Moves the skill's folder to the Trash. Only an existing skill has it. */
  onDelete?: (scope: SkillScope, name: string) => void | Promise<void>
  onCancel: () => void
  handle?: RefObject<EditorHandle | null>
  /** Reopens the form from a fresh view, offered beside a stale or lost save's error. */
  onReload?: () => void
}

/** A user or project skill: description and instructions. The name is the folder, so an existing skill's is fixed; its other files are kept. */
export function SkillEditor(p: Props) {
  const editing = p.view !== null
  const [opened] = useState<SkillDraft>(() => (p.view ? skillDraftOf(p.view) : emptySkillDraft('user')))
  const [draft, setDraft] = useState(opened)
  const heading = useHeadingFocus<HTMLHeadingElement>()
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const dirty = isSkillDirty(draft, opened)
  const { cancel, dialog } = useCancel(dirty, p.onCancel)
  const errors = skillErrors(draft)
  const err = (k: string): string | undefined => (showErrors ? errors[k] : undefined)
  const set = <K extends keyof SkillDraft>(k: K, v: SkillDraft[K]): void => setDraft((d) => ({ ...d, [k]: v }))

  const submit = async (): Promise<boolean> => {
    const d = draft
    if (saving) return false
    if (hasErrors(skillErrors(d))) {
      setShowErrors(true)
      return false
    }
    setSaving(true)
    setSaveError(null)
    try {
      await p.onSave(d.scope, skillInputOf(d))
      return true
    } catch (e) {
      setSaveError(errorMessage(e))
      return false
    } finally {
      setSaving(false)
    }
  }
  useFormGuard(p.handle, () => isSkillDirty(draft, opened), submit)

  const remove = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      await p.onDelete?.(draft.scope, draft.name)
    } catch (e) {
      setSaveError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="ext-skill-form">
      <div className="vault-form-head">
        <button type="button" className="btn ghost small" data-testid="ext-form-back" onClick={cancel}>
          ← Back
        </button>
        <h2 className="vault-form-title" tabIndex={-1} ref={heading}>
          {editing ? 'Edit skill' : 'New skill'}
        </h2>
      </div>
      <div className="set-card">
        <div className="set-block vault-fields">
          <Field
            label="Name"
            error={err('name')}
            hint={
              editing
                ? 'The skill folder’s name, so it cannot change.'
                : 'Lower-case letters, digits and single hyphens. It becomes the skill’s folder.'
            }
          >
            <input
              className="field vault-mono"
              aria-label="Name"
              aria-invalid={err('name') ? true : undefined}
              placeholder="my-skill"
              autoComplete="off"
              spellCheck={false}
              readOnly={editing}
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label="Save it for" hint={draft.scope === 'project' && p.folder ? `The folder is ${p.folder}.` : undefined}>
            {editing ? (
              <span className="set-hint" data-testid="ext-form-scope">
                {SCOPE_TEXT[draft.scope]}
              </span>
            ) : (
              <SearchSelect
                className="field"
                aria-label="Save it for"
                data-testid="ext-form-scope"
                value={draft.scope}
                onChange={(v) => set('scope', v as SkillScope)}
              >
                {(['user', 'project'] as const).map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_TEXT[s]}
                  </option>
                ))}
              </SearchSelect>
            )}
          </Field>
          <Field label="Description" error={err('description')} hint="Claude reads this to decide when to use the skill.">
            <textarea
              className="field"
              aria-label="Description"
              aria-invalid={err('description') ? true : undefined}
              rows={2}
              autoComplete="off"
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>
          <Field label="Instructions" error={err('body')} hint="Markdown. Claude reads it when the skill is used.">
            <textarea
              className="field vault-mono ext-skill-body"
              aria-label="Instructions"
              aria-invalid={err('body') ? true : undefined}
              rows={14}
              autoComplete="off"
              spellCheck={false}
              value={draft.body}
              onChange={(e) => set('body', e.target.value)}
            />
          </Field>
          {draft.files.length > 0 && (
            <Field label="Files in this skill's folder">
              <ul className="ext-skill-files" data-testid="ext-skill-files">
                {draft.files.map((f) => (
                  <li key={f} className="vault-mono">
                    {f}
                  </li>
                ))}
              </ul>
              <span className="set-hint">Only SKILL.md is edited here. The other files are kept as they are.</span>
            </Field>
          )}
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
        <span className="grow" />
        {editing && p.onDelete && (
          <button
            type="button"
            className="btn danger-outline"
            data-testid="ext-skill-delete"
            disabled={saving}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
        )}
      </div>
      {dialog}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete skill"
          message={removeText.skill(draft.name)}
          buttons={[
            { label: 'Move to Trash', value: 'delete', danger: true },
            { label: 'Cancel', value: 'cancel' }
          ]}
          initialFocus="cancel"
          onResolve={(v) => {
            setConfirmDelete(false)
            if (v === 'delete') void remove()
          }}
        />
      )}
    </div>
  )
}
