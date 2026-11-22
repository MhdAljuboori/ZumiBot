import { useContext, useState } from 'react'
import { automationSummary } from '@zumibot/shared/automations'
import { desktopActionSummary } from '@zumibot/shared/desktop'
import { processStartOf } from '@zumibot/shared/processes'
import { toolSummary } from '@zumibot/shared/toolSummary'
import type { ApprovalDecision } from '@zumibot/shared/types'
import { visibleJson, visibleText } from '@zumibot/shared/visibleText'
import { CONNECTOR_TEXT } from '@zumibot/shared/connectors'
import { allowScope, approvalChoices, approvalLine, connectorSummary, isActionable, type ApprovalItem } from '../state/approvals'
import { inputFields } from '../state/approvalFields'
import { desktopCardOffer } from '../state/desktopView'
import { DesktopShowContext } from '../useAgentDesktop'

const RISK_TEXT = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' } as const
const RISK_ICON = { low: '●', medium: '▲', high: '⚠' } as const

interface Props {
  item: ApprovalItem
  chatRunning: boolean
  /** The card is in a workflow's room copy, where a step's rules apply. */
  stepChoice: boolean
  onAnswer: (requestId: string, decision: ApprovalDecision) => void
}

export function ApprovalCard({ item, chatRunning, stepChoice, onAnswer }: Props) {
  // A connector write is acted on outside this machine, so its input shows by default.
  const [open, setOpen] = useState(item.connector !== undefined)
  const [raw, setRaw] = useState(false)
  const fields = inputFields(item.input)
  const actionable = isActionable(item, chatRunning)
  const showOnDesktop = useContext(DesktopShowContext)
  const isMcp = item.toolName.startsWith('mcp__')
  // A desktop action is meaningless to approve without seeing it, so its card says it in words. A delete card's name is
  // the agent's text, so hidden characters in it show as escapes, as a tool row's do.
  const automation = automationSummary(item.toolName, item.input)
  // A process start runs a command that outlives the turn: the card says so and shows the whole command, as Bash's does.
  const start = processStartOf(item.toolName, item.input)
  const summary =
    connectorSummary(item) ??
    desktopActionSummary(item.toolName, item.input) ??
    (automation === null ? null : visibleText(automation)) ??
    (start ? 'Start a background process' : isMcp ? item.toolName : toolSummary(item.toolName, item.input))
  const chatScope = allowScope(item.toolName, 'chat'),
    agentScope = allowScope(item.toolName, 'agent')
  const choices = approvalChoices(item.toolName, {
    step: stepChoice,
    input: item.input,
    onceOnly: item.onceOnly === true,
    connector: item.connector
  })
  const offer = actionable ? desktopCardOffer(item.toolName, item.input) : null
  const line = approvalLine(item.status) ?? 'Not answered'
  const muted = item.status === 'denied' || item.status === 'unanswered' || item.status === 'pending'

  return (
    <div
      className={actionable ? 'approval pending' : 'approval done'}
      data-testid="approval-card"
      data-status={item.status}
      data-request-id={item.id}
    >
      <button
        type="button"
        className={item.connector ? 'approval-head connector' : 'approval-head'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {actionable ? '🔒 ' : '▸ '}
        {summary}
      </button>
      {actionable && (
        <>
          {start && (
            <div className="approval-process" data-testid="approval-process">
              <pre className="approval-command">{visibleText(start.command)}</pre>
              <div className="approval-desc">
                In {start.cwd === null ? 'the chat folder' : visibleText(start.cwd)}
                {start.name !== null && <> · named {visibleText(start.name)}</>} · keeps running after this reply
              </div>
            </div>
          )}
          {(item.connector || item.risk) && (
            <div className="approval-meta">
              {item.risk && (
                <span
                  className="approval-risk"
                  data-risk={item.risk}
                  data-testid="approval-risk"
                  data-tip="Jev's guess from the tool and its input. Read the input yourself before you answer."
                >
                  <span aria-hidden="true">{RISK_ICON[item.risk]}</span> {RISK_TEXT[item.risk]}{' '}
                  <span className="approval-risk-by">· Jev's guess</span>
                </span>
              )}
              {item.connector && (
                <span className="approval-connector" data-testid="approval-connector">
                  {CONNECTOR_TEXT.cardAccount}
                </span>
              )}
            </div>
          )}
          {item.description && <div className="approval-desc">{item.description}</div>}
          {item.reason && <div className="approval-reason">{item.reason}</div>}
          {offer && showOnDesktop && (
            <div className="approval-desktop">
              {/* Watching only: it never takes control. A pointer action's point is marked on the live picture. */}
              {offer.point ? (
                <button
                  type="button"
                  className="btn small"
                  data-testid="approval-show-desktop"
                  onClick={() => showOnDesktop(item.agent, offer.point)}
                >
                  Show on desktop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn small"
                  data-testid="approval-open-desktop"
                  onClick={() => showOnDesktop(item.agent, null)}
                >
                  Open Desktop
                </button>
              )}
            </div>
          )}
        </>
      )}
      {open && (
        <div className="tool-panel approval-input">
          <div className="approval-input-head">
            <span className="tool-label">Input</span>
            {fields && (
              <button type="button" className="btn ghost small" data-testid="approval-raw" aria-pressed={raw} onClick={() => setRaw(!raw)}>
                {raw ? 'Show fields' : 'Show JSON'}
              </button>
            )}
          </div>
          {/* Hidden and reordering characters show as escapes in both views: this is the input the user is told to read. */}
          {fields && !raw ? (
            <dl className="approval-fields" data-testid="approval-fields">
              {fields.map((f) => (
                <div key={f.key} className={f.block ? 'approval-field block' : 'approval-field'}>
                  <dt data-tip={f.title}>{f.label}</dt>
                  <dd>{f.block ? <pre>{f.value}</pre> : f.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <pre>{visibleJson(item.input)}</pre>
          )}
        </div>
      )}
      {actionable ? (
        <div className="approval-actions">
          <button type="button" className="btn primary" data-testid="approval-allow-once" onClick={() => onAnswer(item.id, 'allow-once')}>
            Allow once
          </button>
          {choices.chat && (
            <button type="button" className="btn" data-testid="approval-allow-chat" onClick={() => onAnswer(item.id, 'allow-chat')}>
              Allow for this chat
              {chatScope && <span className="approval-sub">{chatScope}</span>}
            </button>
          )}
          {choices.agent && (
            <button type="button" className="btn" data-testid="approval-allow-agent" onClick={() => onAnswer(item.id, 'allow-agent')}>
              Allow always for this agent
              {agentScope && <span className="approval-sub">{agentScope}</span>}
            </button>
          )}
          {choices.step && (
            <button type="button" className="btn" data-testid="approval-allow-step" onClick={() => onAnswer(item.id, 'allow-step')}>
              Allow for this step
              {agentScope && <span className="approval-sub">{agentScope}</span>}
            </button>
          )}
          <button type="button" className="btn danger-outline" data-testid="approval-deny" onClick={() => onAnswer(item.id, 'deny')}>
            Deny
          </button>
        </div>
      ) : (
        <div className={muted ? 'approval-line muted' : 'approval-line'}>{line}</div>
      )}
    </div>
  )
}
