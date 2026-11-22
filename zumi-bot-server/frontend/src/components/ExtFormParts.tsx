import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { offersReload } from '../state/extensionsPage'
import type { EditorHandle } from './AgentEditor'
import { ConfirmDialog } from './ConfirmDialog'

/** A labelled field with its hint and error, in the Vault form's layout. */
export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="vault-field">
      <span className="vault-label">{label}</span>
      {children}
      {hint && !error && <span className="set-hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

/**
 * Lets the Settings unsaved-changes guard ask this form (is it dirty, save it), through the ref its parent passes on. It reads the
 * latest functions at call time, so the guard never holds a stale draft.
 */
export function useFormGuard(
  handle: RefObject<EditorHandle | null> | undefined,
  isDirty: () => boolean,
  save: () => Promise<boolean>
): void {
  const live = useRef({ isDirty, save })
  live.current = { isDirty, save }
  useEffect(() => {
    if (!handle) return
    handle.current = { isDirty: () => live.current.isDirty(), save: () => live.current.save() }
    return () => {
      handle.current = null
    }
  }, [handle])
}

/** A ref for a form's heading (give it `tabIndex={-1}`): focus moves there when the form opens, so keyboard and screen reader start at it. */
export function useHeadingFocus<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return ref
}

/**
 * Gives focus back to what opened a form once it closes. The opener (a row's Edit, an Add button) is unmounted while the form shows,
 * so it is found again inside `container` by its label and its place among buttons with that label; with none, focus is left alone.
 */
export function useReturnFocus(container: RefObject<HTMLElement | null>): { remember: () => void; restore: () => void } {
  const opener = useRef<{ selector: string; index: number } | null>(null)
  const due = useRef(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!due.current) return
    due.current = false
    const o = opener.current
    const box = container.current
    if (!o || !box) return
    const all = [...box.querySelectorAll<HTMLElement>(o.selector)]
    ;(all[o.index] ?? all[0])?.focus()
  }, [tick, container])
  return {
    remember: () => {
      const el = document.activeElement
      const box = container.current
      if (!(el instanceof HTMLElement) || !box?.contains(el)) {
        opener.current = null
        return
      }
      const label = el.getAttribute('aria-label')
      const testId = el.getAttribute('data-testid')
      const selector = label ? `[aria-label="${CSS.escape(label)}"]` : testId ? `[data-testid="${CSS.escape(testId)}"]` : null
      opener.current = selector ? { selector, index: Math.max(0, [...box.querySelectorAll(selector)].indexOf(el)) } : null
    },
    restore: () => {
      due.current = true
      setTick((n) => n + 1)
    }
  }
}

/** Cancel of a form: asks first when it has edits. */
export function useCancel(dirty: boolean, onCancel: () => void): { cancel: () => void; dialog: ReactNode } {
  const [asking, setAsking] = useState(false)
  const dialog = asking ? (
    <ConfirmDialog
      title="Unsaved changes"
      message="You have unsaved changes. Discard them?"
      buttons={[
        { label: 'Discard', value: 'discard', danger: true },
        { label: 'Keep editing', value: 'keep' }
      ]}
      initialFocus="keep"
      onResolve={(v) => {
        setAsking(false)
        if (v === 'discard') onCancel()
      }}
    />
  ) : null
  return { cancel: () => (dirty ? setAsking(true) : onCancel()), dialog }
}

/** A save's error. A stale or lost one can only work again from a fresh view, so it comes with Reload, which reopens the form fresh. */
export function SaveError({ error, onReload }: { error: string | null; onReload?: () => void }) {
  if (!error) return null
  return (
    <p className="set-note bad" role="alert" data-testid="ext-form-error">
      {error}
      {onReload && offersReload(error) && (
        <>
          {' '}
          <button type="button" className="btn small" data-testid="ext-form-reload" onClick={onReload}>
            Reload
          </button>
        </>
      )}
    </p>
  )
}
