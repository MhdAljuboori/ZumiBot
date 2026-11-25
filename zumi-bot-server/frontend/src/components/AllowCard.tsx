import { useEffect, useMemo, useState } from 'react'
import { ruleOfFolder, ruleOfPrefix } from '@zumibot/shared/allowRules'
import { displayName } from '@zumibot/shared/frontmatter'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import {
  allHeld,
  chosenFolders,
  chosenPrefixes,
  commandOf,
  gitAfterFolder,
  rowAgent,
  sheetRows,
  unallowableParts,
  type AllowCardState
} from '../state/allowBlocked'

type ToolItem = Extract<ChatItem, { type: 'tool' }>
type Scope = 'chat' | 'agent'

interface Props {
  chat: ChatMeta
  item: ToolItem
  /** Never 'hidden': the caller draws nothing for that. */
  state: Exclude<AllowCardState, 'hidden'>
  /** The rules are stored: the text to send so the agent continues. */
  onAllowed: (text: string) => void
}

const firstLine = (command: string): string => command.split('\n')[0]

/** A command Auto mode refused, as a card in the message flow like a question: allow it and the agent carries on. */
export function AllowCard({ chat, item, state, onAllowed }: Props) {
  const command = commandOf(item) ?? ''
  if (state === 'done') return <AllowDone chat={chat} item={item} command={command} />
  if (state === 'collapsed') return <AllowCollapsed chat={chat} item={item} command={command} onAllowed={onAllowed} />
  return <AllowForm chat={chat} item={item} command={command} running={state === 'running'} status={state} onAllowed={onAllowed} />
}

/** Answered: one muted line, like an answered question. */
function AllowDone({ chat, item, command }: { chat: ChatMeta; item: ToolItem; command: string }) {
  const who = item.allowedAs === 'chat' ? 'this chat' : displayName(rowAgent(item, chat)) || 'this agent'
  return (
    <div className="approval question done allow-card allow-done" data-testid="allow-card" data-status="done">
      <div className="allow-done-line">
        <code className="allow-done-cmd" data-tip={command}>
          {firstLine(command)}
        </code>
        <span className="approval-line muted" data-testid="allowed-as">
          Allowed for {who}
        </span>
      </div>
    </div>
  )
}

/** An older refusal: one line, expanded in place on demand. */
function AllowCollapsed({
  chat,
  item,
  command,
  onAllowed
}: {
  chat: ChatMeta
  item: ToolItem
  command: string
  onAllowed: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (open) return <AllowForm chat={chat} item={item} command={command} running={false} status="pending" onAllowed={onAllowed} />
  return (
    <div className="approval question done allow-card allow-collapsed" data-testid="allow-card" data-status="collapsed">
      <span className="allow-collapsed-text">⛔ Auto mode refused a command</span>
      <button type="button" className="btn ghost small" data-testid="allow-blocked" onClick={() => setOpen(true)}>
        Allow…
      </button>
    </div>
  )
}

function AllowForm({
  chat,
  item,
  command,
  running,
  status,
  onAllowed
}: {
  chat: ChatMeta
  item: ToolItem
  command: string
  running: boolean
  status: string
  onAllowed: (text: string) => void
}) {
  const agent = rowAgent(item, chat)
  const label = displayName(agent)
  // The agent's own rules come from the server; until they arrive only this chat's count as held.
  const [agentRules, setAgentRules] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    api.approvals.list(agent).then(
      (rules) => alive && setAgentRules(rules.flatMap((r) => (r.cli === undefined ? [] : [r.cli]))),
      () => {} // held rules only mark parts "already allowed"; the server still checks
    )
    return () => {
      alive = false
    }
  }, [agent])
  const held = useMemo(() => [...(chat.allowRules ?? []), ...agentRules], [chat.allowRules, agentRules])
  const initial = useMemo(() => sheetRows(command, held, chat.cwd), [command, held, chat.cwd])

  // What the user typed or ticked, by row; a row not touched follows the held rules as they load.
  const [edits, setEdits] = useState<Record<number, { prefix?: string; ticked?: boolean }>>({})
  const rows = initial.map((r, i) => ({ ...r, ...(r.heldBy === null && r.refused === null ? edits[i] : {}) }))
  const { prefixes, errors } = chosenPrefixes(rows, command)
  const folders = chosenFolders(rows)
  const newRules = [...prefixes.map(ruleOfPrefix), ...folders.map(ruleOfFolder)]
  const [scope, setScope] = useState<Scope>('chat')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stuck = allHeld(initial)
  const blockers = unallowableParts(initial)
  const locked = busy || running
  const canSubmit = !locked && newRules.length > 0 && errors.every((e) => e === null)
  const heldRules = [...new Set(initial.flatMap((r) => (r.heldBy === null ? [] : [r.heldBy])))]
  const gitFolder = gitAfterFolder(initial)

  const submit = (): void => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    api.chats.allowBlocked(chat.id, item.id, prefixes, scope, folders).then(
      (r) => onAllowed(r.text),
      (e) => {
        setError(errorMessage(e))
        setBusy(false)
      }
    )
  }

  return (
    <div className={`approval question ${running ? 'done' : 'pending'} allow-card`} data-testid="allow-card" data-status={status}>
      <div className="question-headrow">
        <span className="question-icon allow-icon" aria-hidden="true">
          ⛔
        </span>
        <div className="question-head">Auto mode refused a command</div>
      </div>
      <pre className="approval-command allow-command">{command}</pre>
      {gitFolder !== null && (
        <p className="hint" data-testid="allow-git-note">
          Claude Code asks about a command that changes into another folder and then runs git there, whatever is allowed. Ask the
          agent to use <code>git -C {gitFolder}</code> instead.
        </p>
      )}
      {stuck && blockers.length > 0 ? (
        // The held rules are not the problem: the CLI sent the whole command to the classifier for this part.
        <>
          <p className="hint" data-testid="allow-unallowable">
            Nothing here can allow {blockers.length === 1 ? 'this part' : 'these parts'}, so Claude Code refused the whole command:
          </p>
          <ul className="allow-parts">
            {blockers.map((b) => (
              <li key={b.part} className="allow-part" data-testid="allow-unallowable-part" data-part={b.part}>
                <code className="allow-part-off">{b.part}</code>
                <div className="hint allow-part-reason">{b.reason}</div>
              </li>
            ))}
          </ul>
          <p className="hint">Ask the agent to do it another way, without {blockers.length === 1 ? 'this part' : 'these parts'}.</p>
          <div className="allow-group-label">Already allowed:</div>
          <ul className="allow-rules">
            {heldRules.map((r) => (
              <li key={r}>
                <code>{r}</code>
              </li>
            ))}
          </ul>
        </>
      ) : stuck ? (
        <>
          <p className="hint">Claude Code still refused this although these rules are allowed:</p>
          <ul className="allow-rules">
            {heldRules.map((r) => (
              <li key={r}>
                <code>{r}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="allow-group-label">{rows.some((r) => r.folder) ? 'Commands and folders:' : 'Commands starting with:'}</div>
          <ul className="allow-parts">
            {rows.map((r, i) => (
              <li
                key={`${i}:${r.part}`}
                className="allow-part"
                data-testid="allow-blocked-part"
                data-part={r.part}
                data-folder={r.folder ?? undefined}
              >
                <label className="allow-part-tick">
                  <input
                    type="checkbox"
                    checked={r.ticked}
                    disabled={r.heldBy !== null || r.refused !== null || locked}
                    aria-label={r.folder ? `Allow folder ${r.folder}` : `Allow commands starting with ${r.prefix || r.part}`}
                    onChange={(e) => setEdits((p) => ({ ...p, [i]: { ...p[i], ticked: e.target.checked } }))}
                  />
                </label>
                {r.refused !== null ? (
                  <>
                    <code className="allow-part-off">{r.part}</code>
                    <div className="hint allow-part-reason">{r.refused}</div>
                  </>
                ) : r.heldBy !== null ? (
                  <span className="allow-part-held">
                    <code>{r.part}</code> <span className="hint">already allowed</span>
                  </span>
                ) : r.folder ? (
                  // The CLI checks a cd outside the chat's folder before any Bash rule, so this one is a folder grant.
                  <span className="allow-part-held allow-part-folder">
                    Folder <code>{r.folder}</code> <span className="hint">read its files and cd into it</span>
                  </span>
                ) : r.ticked ? (
                  <input
                    type="text"
                    className="allow-prefix"
                    value={r.prefix}
                    spellCheck={false}
                    disabled={locked}
                    aria-label={`Prefix for ${r.part}`}
                    aria-invalid={errors[i] !== null}
                    onChange={(e) => setEdits((p) => ({ ...p, [i]: { ...p[i], prefix: e.target.value } }))}
                  />
                ) : (
                  <code className="allow-part-off">{r.part}</code>
                )}
                {errors[i] !== null && (
                  <div className="field-error" role="alert">
                    {errors[i]}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {newRules.length > 0 && (
            <div className="allow-rules-box">
              <div className="allow-group-label">Rules:</div>
              <ul className="allow-rules">
                {newRules.map((rule) => (
                  <li key={rule}>
                    <code>{rule}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="allow-scope" role="radiogroup" aria-label="Where the rule applies">
            <label>
              <input
                type="radio"
                name={`allow-scope-${item.id}`}
                data-testid="allow-blocked-scope"
                data-scope="chat"
                checked={scope === 'chat'}
                disabled={locked}
                onChange={() => setScope('chat')}
              />{' '}
              This chat
            </label>
            <label>
              <input
                type="radio"
                name={`allow-scope-${item.id}`}
                data-testid="allow-blocked-scope"
                data-scope="agent"
                checked={scope === 'agent'}
                disabled={locked}
                onChange={() => setScope('agent')}
              />{' '}
              Always for {label}
            </label>
          </div>
        </>
      )}
      {error !== null && (
        <div className="field-error" role="alert" data-testid="allow-blocked-error">
          {error}
        </div>
      )}
      {!stuck && (
        <div className="approval-actions">
          <button
            type="button"
            className="btn primary"
            data-testid="allow-blocked-submit"
            disabled={!canSubmit}
            data-tip={running ? 'Wait for the reply to finish' : undefined}
            onClick={submit}
          >
            Allow and continue
          </button>
        </div>
      )}
    </div>
  )
}
