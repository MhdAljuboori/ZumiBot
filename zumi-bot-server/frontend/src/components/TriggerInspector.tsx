import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { JEV_CONDITION_MAX } from '@zumibot/shared/jev'
import { fieldList, flattenCall } from '@zumibot/shared/routineFields'
import type { VaultListItem } from '@zumibot/shared/vault'
import { MAIL_FOLDER_DEFAULT, isEventKind } from '@zumibot/shared/workflowEvents'
import type { EventKind, FileChange, TriggerFilter, WorkflowInput, WorkflowTrigger } from '@zumibot/shared/workflows'
import { api } from '../api'
import { useConnected } from '../useConnected'
import { folderName } from '../state/sidebarTree'
import { conditionShown, switchTrigger, withConditionText, withLimitPolicy, withMissedPolicy, withSpendCap } from '../state/workflowEditor'
import {
  accountKnown,
  eventFieldRows,
  mailAccountLabel,
  mailAccounts,
  mailCheckText,
  portDraft,
  portOnBlur,
  toggleChange
} from '../state/workflowTriggers'
import { FolderIcon } from './FolderIcon'
import { SchedulePicker } from './SchedulePicker'
import { CapBlocked, SpendCapInput } from './SpendCapInput'
import { FILTER_TEXT_MAX, TriggerFilters } from './TriggerFilters'
import { WebhookPanel } from './WebhookPanel'
import { SearchSelect } from './SearchSelect'

type EmailTrigger = Extract<WorkflowTrigger, { kind: 'email' }>
type FileTrigger = Extract<WorkflowTrigger, { kind: 'file' }>

const EVENT_HINTS: Partial<Record<WorkflowTrigger['kind'], string>> = {
  reply: "Runs when an agent's reply ends in any chat or room (replied or failed). Chats a workflow made never start it.",
  todo: 'Runs when you or an agent add to-dos to any chat. Its output is the new to-dos, one per line.',
  inbox: "Runs when another workflow's Notify step files an Inbox message. Its own messages never start it."
}

const CHANGES: { value: FileChange; label: string }[] = [
  { value: 'added', label: 'Added' },
  { value: 'changed', label: 'Changed' },
  { value: 'removed', label: 'Removed' }
]

/** The Vault logins a workflow may use, refetched on every vault change; names and flags only, never a password. `null` while loading, `'error'` when the Vault could not be read. */
function useMailAccounts(): ReturnType<typeof mailAccounts> | 'error' | null {
  const [items, setItems] = useState<ReturnType<typeof mailAccounts> | 'error' | null>(null)
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    let live = true
    const load = (): void => {
      api.vault.list().then(
        (all: VaultListItem[]) => {
          if (live) setItems(mailAccounts(all))
        },
        () => {
          if (live) setItems('error')
        }
      )
    }
    load()
    const off = api.vault.onChanged(load)
    return () => {
      live = false
      off()
    }
  }, [connected])
  return items
}

const isEvent = (t: WorkflowTrigger): t is Extract<WorkflowTrigger, { kind: EventKind }> => isEventKind(t.kind)

/** The fields a run of an event kind has, from an example call; its Filter button starts a filter on one, empty, since the example's values are not the user's. */
function EventFields({ kind, onFilter }: { kind: EventKind; onFilter: (path: string) => void }) {
  return (
    <div className="rt-got" data-testid="wf-event-fields">
      <div className="rt-got-head">
        <span>Fields, as in this example</span>
      </div>
      {eventFieldRows(kind).map((f) => (
        <div key={f.path} className="rt-frow" data-testid="wf-event-field" data-path={f.path}>
          <span className="rt-fk mono">{f.path}</span>
          <span className="rt-fv">{f.sample}</span>
          <button type="button" className="rt-insert" onClick={() => onFilter(f.path)}>
            Filter
          </button>
        </div>
      ))}
    </div>
  )
}

function FilePanel({ t, set, onError }: { t: FileTrigger; set: (next: FileTrigger, key?: string) => void; onError: (e: unknown) => void }) {
  const choose = (): void => {
    api.app.pickFolder(null).then((path) => {
      if (path !== null) set({ ...t, path })
    }, onError)
  }
  return (
    <>
      <div className="rt-fieldset">
        <span className="rt-label">Folder</span>
        <button type="button" className="rt-pill rt-pick" data-testid="wf-file-folder" data-tip={t.path || undefined} onClick={choose}>
          <FolderIcon />
          <span>{t.path ? folderName(t.path) : 'Choose folder'}</span>
        </button>
      </div>
      <label className="rt-fieldset">
        <span className="rt-label">Pattern</span>
        <input
          className="rt-input mono"
          data-testid="wf-file-pattern"
          placeholder="*.pdf"
          maxLength={FILTER_TEXT_MAX}
          spellCheck={false}
          value={t.pattern}
          onChange={(e) => set({ ...t, pattern: e.target.value }, 'trigger:pattern')}
        />
        <span className="rt-hint">Leave empty for every file.</span>
      </label>
      <div className="rt-fieldset" role="group" aria-label="Changes">
        <span className="rt-label">Changes</span>
        <div className="wf-trigger-checks">
          {CHANGES.map((c) => (
            <label key={c.value} className="vault-check">
              <input
                type="checkbox"
                data-testid={`wf-file-${c.value}`}
                disabled={t.changes.length === 1 && t.changes[0] === c.value}
                checked={t.changes.includes(c.value)}
                onChange={(e) => set({ ...t, changes: toggleChange(t.changes, c.value, e.target.checked) })}
              />
              {c.label}
            </label>
          ))}
        </div>
      </div>
      <div className="rt-hint wf-trigger-output">
        Watches the folder and its subfolders on the machine the workflow runs on. Changes made while a run of this workflow is going are
        ignored.
      </div>
    </>
  )
}

function EmailPanel({ t, set }: { t: EmailTrigger; set: (next: EmailTrigger, key?: string) => void }) {
  const found = useMailAccounts()
  const accounts = found === 'error' ? null : found
  // What the user is typing in Port: a half-typed or invalid number is not stored, so it lives here.
  const [portText, setPortText] = useState(String(t.port))
  const portOk = portDraft(portText).valid
  // Undo or a switch back changes the stored port under the input.
  useEffect(() => setPortText(String(t.port)), [t.port])
  const [result, setResult] = useState<{ running: true } | { text: string; bad: boolean } | null>(null)
  // A late answer for settings the user has since changed must not land.
  const request = useRef(0)
  const change = (next: EmailTrigger, key?: string): void => {
    request.current++
    setResult(null)
    set(next, key)
  }
  const check = (): void => {
    const mine = ++request.current
    setResult({ running: true })
    api.workflows.checkMail(t).then(
      (r) => {
        if (mine === request.current) setResult({ text: mailCheckText(r), bad: 'error' in r })
      },
      (e: unknown) => {
        if (mine === request.current) setResult({ text: e instanceof Error ? e.message : String(e), bad: true })
      }
    )
  }
  const known = accountKnown(t.account, accounts)
  const running = result !== null && 'running' in result
  return (
    <>
      <label className="rt-fieldset">
        <span className="rt-label">Account</span>
        <SearchSelect className="rt-select" data-testid="wf-mail-account" value={t.account} onChange={(v) => change({ ...t, account: v })}>
          <option value="">Select account</option>
          {!known && <option value={t.account}>Not available</option>}
          {(accounts ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {mailAccountLabel(a)}
            </option>
          ))}
        </SearchSelect>
        {found === 'error' && (
          <span className="rt-hint rt-bad" role="alert" data-testid="wf-mail-vault-error">
            Could not read the Vault.
          </span>
        )}
        {accounts !== null && accounts.length === 0 && (
          <span className="rt-hint" data-testid="wf-mail-none">
            Turn on <strong>Workflows may use it</strong> on a Vault login first.
          </span>
        )}
      </label>
      <label className="rt-fieldset">
        <span className="rt-label">Server</span>
        <input
          className="rt-input mono"
          data-testid="wf-mail-host"
          placeholder="imap.example.com"
          maxLength={FILTER_TEXT_MAX}
          spellCheck={false}
          value={t.host}
          onChange={(e) => change({ ...t, host: e.target.value }, 'trigger:host')}
        />
      </label>
      <label className="rt-fieldset">
        <span className="rt-label">Port</span>
        <input
          className="rt-input mono"
          data-testid="wf-mail-port"
          inputMode="numeric"
          maxLength={5}
          aria-invalid={!portOk}
          value={portText}
          onChange={(e) => {
            const d = portDraft(e.target.value)
            setPortText(d.text)
            if (d.port !== null) change({ ...t, port: d.port }, 'trigger:port')
          }}
          onBlur={() => {
            const port = portOnBlur(portText)
            setPortText(String(port))
            if (port !== t.port) change({ ...t, port }, 'trigger:port')
          }}
        />
        {!portOk && (
          <span className="rt-hint rt-bad" role="alert" data-testid="wf-mail-port-bad">
            Port must be 1–65535
          </span>
        )}
      </label>
      <label className="rt-fieldset">
        <span className="rt-label">Folder</span>
        <input
          className="rt-input mono"
          data-testid="wf-mail-folder"
          placeholder={MAIL_FOLDER_DEFAULT}
          maxLength={FILTER_TEXT_MAX}
          spellCheck={false}
          value={t.folder}
          onChange={(e) => change({ ...t, folder: e.target.value }, 'trigger:folder')}
        />
      </label>
      <div className="wf-mail-check">
        <button
          type="button"
          className="btn"
          data-testid="wf-mail-check"
          disabled={running || !portOk || t.host.trim() === '' || t.account === ''}
          onClick={check}
        >
          Check mailbox
        </button>
        {result !== null && (
          <span className={!('running' in result) && result.bad ? 'rt-hint rt-bad' : 'rt-hint'} role="status" data-testid="wf-mail-result">
            {'running' in result ? 'Checking…' : result.text}
          </span>
        )}
      </div>
      <div className="rt-hint wf-trigger-output">
        Checks every 2 minutes. Mail already there when you turn it on never starts a run. Nothing is marked read.
      </div>
    </>
  )
}

interface Props {
  w: WorkflowInput
  /** `key` names a text field, whose typing undoes as one step. */
  edit: (change: (w: WorkflowInput) => WorkflowInput, key?: string) => void
  /** What each trigger kind held before a switch, so switching back restores it. Owned by the editor. */
  earlier: Partial<Record<WorkflowTrigger['kind'], WorkflowTrigger>>
  webhook: Omit<ComponentProps<typeof WebhookPanel>, 'onInsert' | 'insertLabel'>
  now: number
  today: string
  onError: (e: unknown) => void
  /** Jev is on with a key: a webhook condition is checked. Off, the field shows only to say a saved condition is ignored. */
  jevOn: boolean
  /** Why the run cap can't be set (an agent's engine reports no cost); null while it can. */
  capBlocked: string | null
}

/** The trigger step's settings: they live on the workflow (`trigger`), since the scheduler and the hooks read them there. */
export function TriggerInspector({ w, edit, earlier, webhook, now, today, onError, jevOn, capBlocked }: Props) {
  const t = w.trigger
  const setTrigger = (next: WorkflowTrigger, key?: string): void => edit((d) => ({ ...d, trigger: next }), key)
  const setKind = (kind: WorkflowTrigger['kind']): void => {
    if (kind === t.kind) return
    earlier[t.kind] = t
    setTrigger(switchTrigger(kind, earlier))
  }
  const hasFilters = t.kind !== 'manual' && t.kind !== 'schedule'
  const filters = hasFilters ? t.filters : []
  const setFilters = (next: TriggerFilter[], key?: string): void =>
    edit(
      (d) => (d.trigger.kind !== 'manual' && d.trigger.kind !== 'schedule' ? { ...d, trigger: { ...d.trigger, filters: next } } : d),
      key
    )
  const paths =
    t.kind === 'webhook'
      ? webhook.latest
        ? fieldList(webhook.latest).map((f) => f.path)
        : []
      : isEvent(t)
        ? eventFieldRows(t.kind).map((f) => f.path)
        : []

  // A webhook field row's button adds a filter that the test call itself passes, ready to edit.
  const filterOn = (path: string): void => {
    const sample = webhook.latest ? (flattenCall(webhook.latest)[path] ?? '') : ''
    setFilters([...filters, { field: path, equals: sample.slice(0, FILTER_TEXT_MAX) }])
  }
  // An event's example values are not the user's data, so its filter starts empty.
  const filterOnEvent = (path: string): void => setFilters([...filters, { field: path, equals: '' }])

  return (
    <div className="wf-trigger" data-testid="wf-trigger">
      <label className="rt-fieldset">
        <span className="rt-label">Starts</span>
        <SearchSelect
          className="rt-select"
          data-testid="wf-trigger-kind"
          value={t.kind}
          onChange={(v) => setKind(v as WorkflowTrigger['kind'])}
        >
          <option value="manual">By hand</option>
          <option value="schedule">On a schedule</option>
          <option value="webhook">From a webhook</option>
          <option value="reply">When a reply ends</option>
          <option value="todo">When a to-do is added</option>
          <option value="inbox">When an Inbox message arrives</option>
          <option value="file">When a file changes</option>
          <option value="email">When an email arrives</option>
        </SearchSelect>
      </label>
      {t.kind === 'manual' && (
        <div className="rt-hint">Runs when you press Run workflow. What you type in its Input box is the trigger's output.</div>
      )}
      {t.kind === 'schedule' && (
        <div className="rt-fieldset">
          <SchedulePicker
            schedule={t.schedule}
            timeZone={w.timeZone}
            now={now}
            today={today}
            onChange={(schedule) => setTrigger({ ...t, schedule })}
          />
          <div className="rt-hint">Runs while the workflow is on.</div>
        </div>
      )}
      {(t.kind === 'reply' || t.kind === 'todo' || t.kind === 'inbox') && (
        <div className="rt-hint" data-testid="wf-event-hint">
          {EVENT_HINTS[t.kind]}
        </div>
      )}
      {t.kind === 'file' && <FilePanel t={t} set={setTrigger} onError={onError} />}
      {t.kind === 'email' && <EmailPanel t={t} set={setTrigger} />}
      {t.kind === 'webhook' && (
        <>
          <div className="rt-fieldset">
            <WebhookPanel {...webhook} onInsert={filterOn} insertLabel="Filter" />
            <div className="rt-hint wf-trigger-output">
              The call's body, as JSON, is the trigger's output. Run workflow uses the latest test call.
            </div>
          </div>
          <div className="wf-trigger-note">
            <div className="wf-trigger-note-title">From GitHub</div>
            <p>A GitHub webhook works too: give it this secret, and GitHub signs each call (X-Hub-Signature-256).</p>
            {/* GitHub's default form encoding sends one payload field holding the JSON, so body.action filters never match. */}
            <p data-testid="wf-github-json">
              In GitHub choose the content type <span className="mono">application/json</span>.
            </p>
          </div>
        </>
      )}
      {isEvent(t) && (
        <div className="rt-fieldset">
          <EventFields kind={t.kind} onFilter={filterOnEvent} />
          <div className="rt-hint wf-trigger-output">
            The event's text is the trigger's output, and the fields above are in {'{{trigger.body.…}}'}.
          </div>
        </div>
      )}
      {hasFilters && (
        <TriggerFilters
          kind={t.kind}
          filters={filters}
          onChange={setFilters}
          paths={paths}
          placeholder={t.kind === 'webhook' ? { field: 'body.action', value: 'opened' } : { field: 'body.subject', value: 'invoice' }}
        />
      )}
      {t.kind === 'webhook' && conditionShown(t, jevOn) && (
        <div className="rt-fieldset rt-condition" data-testid="wf-condition-field">
          <label className="rt-label" htmlFor="wf-condition">
            Only run when (optional)
          </label>
          <textarea
            id="wf-condition"
            className="rt-input"
            data-testid="wf-condition"
            rows={2}
            maxLength={JEV_CONDITION_MAX}
            placeholder="The CI run failed on the main branch"
            value={t.condition ?? ''}
            onChange={(e) => edit((d) => withConditionText(d, e.target.value), 'trigger:condition')}
          />
          <div className={jevOn ? 'rt-hint' : 'rt-hint rt-bad'}>
            {jevOn
              ? 'Jev reads each call and skips the run when this is not true. Leave it empty to run on every call.'
              : 'Jev is off, so this is ignored and every call runs. Turn Jev on in Settings › Jev decisions.'}
          </div>
        </div>
      )}
      <label className="rt-fieldset">
        <span className="rt-label">At the usage limit</span>
        <SearchSelect
          className="rt-select"
          data-testid="wf-limit-policy"
          value={w.limitPolicy ?? 'wait'}
          onChange={(v) => edit((d) => withLimitPolicy(d, v as 'wait' | 'skip'))}
        >
          <option value="wait">Wait, then continue</option>
          <option value="skip">Skip the run</option>
        </SearchSelect>
        <span className="rt-hint">
          {w.limitPolicy === 'skip'
            ? 'A run whose agent turn the usage limit stops ends there, marked skipped.'
            : 'Sends "continue" in the same chat once the limit resets, then the run goes on.'}
        </span>
      </label>
      {t.kind === 'schedule' && (
        <label className="rt-fieldset">
          <span className="rt-label">If a run was missed</span>
          <SearchSelect
            className="rt-select"
            data-testid="wf-missed-policy"
            value={w.missedPolicy ?? 'run-once'}
            onChange={(v) => edit((d) => withMissedPolicy(d, v as 'run-once' | 'skip'))}
          >
            <option value="run-once">Run once when back</option>
            <option value="skip">Skip it</option>
          </SearchSelect>
          <span className="rt-hint">
            {w.missedPolicy === 'skip'
              ? 'ZumiBot was off at the time: no run, it waits for the next one.'
              : 'ZumiBot was off at the time: one late run, however many were missed.'}
          </span>
        </label>
      )}
      <div className="rt-fieldset" data-testid="wf-spend-cap-field">
        <label className="rt-label" htmlFor="wf-spend-cap">
          Spend cap per run
        </label>
        {capBlocked === null ? (
          <>
            <SpendCapInput
              id="wf-spend-cap"
              value={w.spendCap ?? null}
              onChange={(cap) => edit((d) => withSpendCap(d, cap), 'workflow:spendCap')}
              testId="wf-spend-cap"
              routine
            />
            <div className="rt-hint">
              {w.spendCap === undefined
                ? 'No cap: a run spends what it needs.'
                : 'Once a run has spent this much, priced at API rates, nothing new starts, its agents pause and you are notified. Continue allows the same again.'}
            </div>
          </>
        ) : (
          <CapBlocked
            reason={capBlocked}
            hasCap={w.spendCap !== undefined}
            testId="wf-spend-cap-blocked"
            onClear={() => edit((d) => withSpendCap(d, null), 'workflow:spendCap')}
          />
        )}
      </div>
    </div>
  )
}
