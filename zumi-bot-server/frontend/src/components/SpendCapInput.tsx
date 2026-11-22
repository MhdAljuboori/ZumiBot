import { useEffect, useState } from 'react'
import { capField, capText, textMeans } from '../state/spendCapField'

interface Props {
  id: string
  value: number | null
  onChange(v: number | null): void
  testId: string
  /** The routine and workflow editors' input look; Agent Studio's otherwise. */
  routine?: boolean
}

/**
 * A dollar amount, or empty for no cap. Typing a valid amount changes the value at once; an invalid one is shown as such and
 * changes nothing. A value set from outside (a restore, Discard changes) replaces the text unless the text already means it.
 */
export function SpendCapInput({ id, value, onChange, testId, routine }: Props) {
  const [text, setText] = useState(capText(value))
  useEffect(() => {
    setText((t) => (textMeans(t, value) ? t : capText(value)))
  }, [value])
  const { error } = capField(text)
  return (
    <span className="spend-cap">
      <span className="spend-cap-row">
        <span className="spend-cap-prefix" aria-hidden="true">
          $
        </span>
        <input
          id={id}
          className={`${routine ? 'rt-input' : 'field'} spend-cap-field`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="No cap"
          value={text}
          aria-invalid={error !== null}
          aria-describedby={error ? `${id}-error` : undefined}
          data-testid={testId}
          onChange={(e) => {
            setText(e.target.value)
            const next = capField(e.target.value)
            if (!next.error && next.value !== value) onChange(next.value)
          }}
        />
      </span>
      {error && (
        <span id={`${id}-error`} className="spend-cap-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

/**
 * The cap field's place while an agent's engine can't hold a cap: the fixed sentence. A cap already set can still be removed,
 * since the server refuses to save it. With no cap set it reads as a hint, not an error.
 */
export function CapBlocked({ reason, hasCap, onClear, testId }: { reason: string; hasCap: boolean; onClear: () => void; testId: string }) {
  return (
    <span className="spend-cap" data-testid={testId}>
      <span className={hasCap ? 'spend-cap-error' : 'rt-hint'} role="status">
        {reason}
      </span>
      {hasCap && (
        <button type="button" className="btn small" data-testid={`${testId}-clear`} onClick={onClear}>
          Remove the cap
        </button>
      )}
    </span>
  )
}
