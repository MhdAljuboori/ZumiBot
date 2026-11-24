import { useEffect, useRef, useState } from 'react'
import type { AgentRule } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useOnReconnect } from '../useConnected'
import { addRuleCheck, ruleLabel } from '../state/approvals'

export function RememberedApprovals({ agentName }: { agentName: string }) {
  const [rules, setRules] = useState<AgentRule[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const latest = useRef(0) // an older response must not overwrite a newer one
  const alive = useRef(true)

  const load = (): void => {
    const n = ++latest.current
    api.approvals.list(agentName).then(
      (r) => {
        if (!alive.current || n !== latest.current) return
        setRules(r)
        setLoadFailed(false)
      },
      () => {
        if (alive.current && n === latest.current) setLoadFailed(true)
      }
    )
  }

  useEffect(() => {
    alive.current = true
    setRules(null)
    setLoadFailed(false)
    setRemoveError(null)
    load()
    const off = api.approvals.onChanged((name) => {
      if (name === agentName) load()
    })
    return () => {
      alive.current = false
      off()
    }
  }, [agentName])

  // A list the socket cut off, or a change pushed while it was down: read again once it is back.
  useOnReconnect(load)

  const [addKind, setAddKind] = useState<'prefix' | 'folder'>('prefix')
  const [addValue, setAddValue] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const check = addRuleCheck(addKind, addValue)

  // A new agent starts with an empty field.
  useEffect(() => {
    setAddValue('')
    setAddError(null)
  }, [agentName])

  const add = (): void => {
    if (adding || check.rule === null) return
    setAdding(true)
    setAddError(null)
    api.approvals.addCli(agentName, addKind, addValue.trim()).then(
      (r) => {
        if (!alive.current) return
        latest.current++
        setRules(r)
        setLoadFailed(false)
        setAddValue('')
        setAdding(false)
      },
      (e) => {
        if (!alive.current) return
        setAddError(errorMessage(e))
        setAdding(false)
      }
    )
  }

  const remove = (key: string): void => {
    setRemoveError(null)
    api.approvals.remove(agentName, key).then(
      (r) => {
        if (!alive.current) return
        latest.current++
        setRules(r)
        setLoadFailed(false)
      },
      (e) => {
        if (!alive.current) return
        setRemoveError(errorMessage(e))
        load() // keep the list accurate after a failed removal
      }
    )
  }

  if (rules === null && !loadFailed) return null
  return (
    <section className="remembered" aria-label="Remembered approvals">
      <h3 className="card-title">Remembered approvals</h3>
      {removeError && (
        <div className="field-error" role="alert">
          Could not remove the approval: {removeError}
        </div>
      )}
      {loadFailed && rules === null ? (
        <div className="field-error" role="alert">
          Could not load remembered approvals.
        </div>
      ) : rules !== null && rules.length === 0 ? (
        <div className="hint">
          No remembered approvals. Use &quot;Allow always for this agent&quot; on an approval card, or add a rule below.
        </div>
      ) : (
        <>
          {loadFailed && (
            <div className="field-error" role="alert">
              Could not refresh remembered approvals; this list may be out of date.
            </div>
          )}
          <ul className="remembered-list">
            {rules?.map((r) => (
              <li key={r.key} className="remembered-row">
                <span className="remembered-label">{ruleLabel(r)}</span>
                <button
                  type="button"
                  className="btn ghost small"
                  data-testid="rule-remove"
                  aria-label={`Remove ${ruleLabel(r)}`}
                  onClick={() => remove(r.key)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <form
        className="remembered-add"
        aria-label="Add a rule"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <div className="remembered-add-kind" role="radiogroup" aria-label="Rule kind">
          <label>
            <input
              type="radio"
              name={`rule-kind-${agentName}`}
              data-testid="rule-add-kind"
              data-kind="prefix"
              checked={addKind === 'prefix'}
              onChange={() => setAddKind('prefix')}
            />{' '}
            Bash commands starting with
          </label>
          <label>
            <input
              type="radio"
              name={`rule-kind-${agentName}`}
              data-testid="rule-add-kind"
              data-kind="folder"
              checked={addKind === 'folder'}
              onChange={() => setAddKind('folder')}
            />{' '}
            Folder it may read and cd into
          </label>
        </div>
        <div className="remembered-add-row">
          <input
            type="text"
            className="remembered-add-input"
            data-testid="rule-add-value"
            value={addValue}
            spellCheck={false}
            disabled={adding}
            placeholder={addKind === 'prefix' ? 'gh pr merge' : '/home/you/other-repo'}
            aria-label={addKind === 'prefix' ? 'Command start' : 'Folder path'}
            aria-invalid={check.error !== null}
            onChange={(e) => {
              setAddValue(e.target.value)
              setAddError(null)
            }}
          />
          <button type="submit" className="btn small" data-testid="rule-add" disabled={adding || check.rule === null}>
            Add
          </button>
        </div>
        {check.error !== null ? (
          <div className="field-error" role="alert">
            {check.error}
          </div>
        ) : check.rule !== null ? (
          <div className="hint">
            Rule: <code>{check.rule}</code>
          </div>
        ) : (
          <div className="hint">
            Given to this agent&rsquo;s runs outside Plan mode. A folder lets a command such as <code>cd /that/folder &amp;&amp; …</code>{' '}
            run in Auto.
          </div>
        )}
        {addError !== null && (
          <div className="field-error" role="alert" data-testid="rule-add-error">
            Could not add the rule: {addError}
          </div>
        )}
      </form>
    </section>
  )
}
