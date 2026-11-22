import { Fragment, useId } from 'react'
import type { EventKind, TriggerFilter } from '@zumibot/shared/workflows'
import { emptyValueHint, filterHints, setFilterOp } from '../state/workflowTriggers'
import { SearchSelect } from './SearchSelect'

// The server's cap on a filter's field and value (FILTER_TEXT_MAX in workflowInput.ts).
export const FILTER_TEXT_MAX = 1_000

interface Props {
  filters: TriggerFilter[]
  /** `key` names a text field, whose typing undoes as one step. */
  onChange: (next: TriggerFilter[], key?: string) => void
  /** Field paths the Field input suggests. */
  paths: string[]
  placeholder: { field: string; value: string }
  /** Whose filters: a webhook keeps a skipped run for a call that fails one, an event starts nothing. */
  kind: 'webhook' | EventKind
}

/** "Only run when" rows: field, equals or contains, value. Shared by every trigger kind that has filters. */
export function TriggerFilters({ filters, onChange, paths, placeholder, kind }: Props) {
  const listId = useId()
  const hints = filterHints(kind)
  const patch = (i: number, change: Partial<TriggerFilter>, key?: string): void =>
    onChange(
      filters.map((x, j) => (j === i ? { ...x, ...change } : x)),
      key
    )
  return (
    <div className="rt-fieldset wf-filters" data-testid="wf-filters">
      <span className="rt-label">Only run when</span>
      {filters.length === 0 && <div className="rt-hint">{hints.none}</div>}
      {filters.map((f, i) => (
        <Fragment key={i}>
          <div className="wf-filter" data-testid="wf-filter">
            <input
              className="rt-input mono wf-filter-field"
              aria-label="Field"
              placeholder={placeholder.field}
              list={listId}
              maxLength={FILTER_TEXT_MAX}
              value={f.field}
              onChange={(e) => patch(i, { field: e.target.value }, `trigger:filter${i}.field`)}
            />
            <SearchSelect
              className="rt-select wf-filter-op"
              aria-label="Compare"
              data-testid="wf-filter-op"
              value={f.op ?? 'equals'}
              onChange={(v) =>
                onChange(
                  filters.map((x, j) => (j === i ? setFilterOp(x, v === 'contains' ? 'contains' : 'equals') : x)),
                  `trigger:filter${i}.op`
                )
              }
            >
              <option value="equals">equals</option>
              <option value="contains">contains</option>
            </SearchSelect>
            <input
              className="rt-input wf-filter-value"
              aria-label="Value"
              placeholder={placeholder.value}
              maxLength={FILTER_TEXT_MAX}
              value={f.equals}
              onChange={(e) => patch(i, { equals: e.target.value }, `trigger:filter${i}.equals`)}
            />
            <button
              type="button"
              className="icon-btn wf-filter-remove"
              aria-label="Remove filter"
              onClick={() => onChange(filters.filter((_x, j) => j !== i))}
            >
              ✕
            </button>
          </div>
          {emptyValueHint(f) !== null && (
            <div className="rt-hint wf-filter-empty" data-testid="wf-filter-empty">
              {emptyValueHint(f)}
            </div>
          )}
        </Fragment>
      ))}
      <datalist id={listId}>
        {paths.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <button
        type="button"
        className="btn wf-filter-add"
        data-testid="wf-filter-add"
        onClick={() => onChange([...filters, { field: '', equals: '' }])}
      >
        Add filter
      </button>
      {filters.length > 0 && <div className="rt-hint">{hints.rule}</div>}
    </div>
  )
}
