import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { summaryOf, type DispatchStep, type DispatchSummary } from '@zumibot/shared/dispatch'
import { displayName } from '@zumibot/shared/frontmatter'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { agentBody, groupDispatch, stepsLabel, stepsShown, usageLine } from '../state/dispatchPanel'
import { useDispatchEntry } from '../useDispatchEntry'
import { Markdown } from './Markdown'
import { SideBackButton } from './SidePanelMenu'
import { ToolCallRow } from './ToolCallRow'

type ToolItem = Extract<ChatItem, { type: 'tool' }>

interface Props {
  chat: ChatMeta
  list: DispatchSummary[] | null
  failed: boolean
  onRetry: () => void
  connected: boolean
  /** Opens the panel on one agent (a chat row's Watch/View); `n` makes a repeat of the same agent a new request. */
  focusId: string | null
  focusRequest: number
  /** Agents whose tool call waits on an approval card in the chat. */
  waiting: ReadonlySet<string>
  onBack: () => void
  onClose: () => void
}

const FOLD_AT = 400
const REPORT_FOLD_AT = 2000 // the report is what the reader came for

const when = (ms: number): string => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** A clock for the running timers, ticking only while something runs. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  return now
}

/** Long text folded to its start, with Show all. */
function Folded({
  label,
  text,
  markdown,
  foldAt = FOLD_AT,
  testId
}: {
  label: string
  text: string
  markdown?: boolean
  foldAt?: number
  testId: string
}) {
  const [all, setAll] = useState(false)
  const long = text.length > foldAt
  const shown = long && !all ? `${text.slice(0, foldAt).trimEnd()}…` : text
  return (
    <div className={`dispatch-box ${testId === 'dispatch-report' ? 'report' : ''}`} data-testid={testId}>
      <div className="dispatch-box-label">{label}</div>
      {markdown ? <Markdown text={shown} /> : <div className="dispatch-plain">{shown}</div>}
      {long && (
        <button type="button" className="dispatch-show-all" data-testid="dispatch-show-all" onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}

const toolItemOf = (s: Extract<DispatchStep, { kind: 'tool' }>): ToolItem => ({
  type: 'tool',
  id: s.id,
  name: s.name,
  input: s.input,
  result: s.result,
  isError: s.isError,
  blocked: false,
  ts: s.ts
})

function Dot({ status }: { status: DispatchSummary['status'] }) {
  return <span className={`dispatch-dot ${status}`} aria-label={status} />
}

/** The side panel's Dispatched agents: every subagent of the chat's visible replies, then one agent's conversation. */
export function DispatchPanel({ chat, list, failed, onRetry, connected, focusId, focusRequest, waiting, onBack, onClose }: Props) {
  const [openId, setOpenId] = useState<string | null>(focusId)
  useEffect(() => {
    if (focusId !== null) setOpenId(focusId)
  }, [focusId, focusRequest])
  const running = (list ?? []).some((s) => s.status === 'running')
  const now = useNow(running)
  const groups = useMemo(() => groupDispatch(list ?? [], when), [list])
  const summary = openId === null ? undefined : list?.find((s) => s.id === openId)

  if (openId !== null) {
    return (
      <AgentView
        chatId={chat.id}
        id={openId}
        summary={summary}
        list={list ?? []}
        now={now}
        connected={connected}
        waiting={waiting.has(openId)}
        onOpen={setOpenId}
        onBack={() => setOpenId(summary?.parent && list?.some((s) => s.id === summary.parent) ? summary.parent : null)}
        onClose={onClose}
      />
    )
  }
  return (
    <aside className="files-panel side-panel dispatch-panel" data-testid="dispatch-panel" aria-label="Dispatched agents">
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title">Dispatched agents</span>
        </span>
        <button type="button" className="icon-btn" data-testid="dispatch-close" aria-label="Close dispatched agents" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="side-list">
        {failed && list === null && (
          <div className="file-note" role="alert">
            Couldn't load dispatched agents.{' '}
            <button type="button" className="btn small" data-testid="dispatch-retry" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {list === null && !failed && <div className="file-note">Loading…</div>}
        {list !== null && list.length === 0 && (
          <div className="file-note" data-testid="dispatch-empty">
            No dispatched agents yet. When an agent hands work to a subagent, you can watch it here.
          </div>
        )}
        {groups.map((g) => (
          <section key={g.turn} className="dispatch-group" data-testid="dispatch-group">
            <div className="dispatch-group-head">
              {g.label}
              {g.member !== undefined && <> · {displayName(g.member)}</>}
            </div>
            {g.rows.map(({ s, depth }) => (
              <button
                key={s.id}
                type="button"
                className={`dispatch-row${depth > 0 ? ' nested' : ''}`}
                style={depth > 1 ? { paddingInlineStart: `${16 + depth * 16}px` } : undefined}
                data-testid="dispatch-row"
                data-id={s.id}
                data-status={s.status}
                data-depth={depth}
                onClick={() => setOpenId(s.id)}
              >
                <span className="dispatch-row-top">
                  <Dot status={s.status} />
                  <span className="dispatch-name">
                    {depth > 0 && '↳ '}
                    {s.description || 'Agent'}
                  </span>
                  <span className="dispatch-chev" aria-hidden="true">
                    ›
                  </span>
                </span>
                {s.subagentType !== null && <span className="dispatch-type">{s.subagentType}</span>}
                {waiting.has(s.id) ? (
                  <span className="dispatch-wait" data-testid="dispatch-wait">
                    Waiting for your approval
                  </span>
                ) : (
                  s.status === 'running' &&
                  s.now !== null && (
                    <span className="dispatch-now" data-testid="dispatch-now">
                      {s.now}…
                    </span>
                  )
                )}
                <span className="dispatch-usage" data-testid="dispatch-usage">
                  {usageLine(s, now)}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </aside>
  )
}

interface AgentProps {
  chatId: string
  id: string
  summary: DispatchSummary | undefined
  list: DispatchSummary[]
  now: number
  connected: boolean
  waiting: boolean
  onOpen: (id: string) => void
  onBack: () => void
  onClose: () => void
}

function AgentView({ chatId, id, summary, list, now, connected, waiting, onOpen, onBack, onClose }: AgentProps) {
  const { entry, failed, retry } = useDispatchEntry(chatId, id, connected)
  // The list's summary is fresher between fetches (status, now, usage); the entry has the steps.
  const head: DispatchSummary | undefined = summary ?? (entry ? summaryOf(entry) : undefined)
  const parent = head?.parent ? list.find((s) => s.id === head.parent) : undefined
  const running = head?.status === 'running'
  const ref = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const steps = entry?.steps.length ?? 0
  const body = useMemo(() => (entry === null ? null : agentBody(entry)), [entry])
  // The reader's own fold of the steps, per agent. An agent that ends while watched keeps its steps open, so nothing
  // the reader was looking at folds away under them. A layout effect: set before paint, so they never flash folded.
  const [pick, setPick] = useState<boolean | null>(null)
  const seen = useRef({ id, running })
  useLayoutEffect(() => {
    const was = seen.current
    seen.current = { id, running }
    if (was.id !== id) setPick(null)
    else if (was.running && !running) setPick((p) => p ?? true)
  }, [id, running])
  const showSteps = stepsShown(pick, running, body?.report != null)
  // A running agent is followed at the bottom unless the reader scrolled up; a finished one opens at its top.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && running && atBottom.current) el.scrollTop = el.scrollHeight
  }, [steps, running])
  useEffect(() => {
    atBottom.current = true
  }, [id])
  const report =
    body?.report == null ? null : (
      <Folded label="Final report → back to main agent" text={body.report} markdown foldAt={REPORT_FOLD_AT} testId="dispatch-report" />
    )

  return (
    <aside className="files-panel side-panel dispatch-panel" data-testid="dispatch-panel" aria-label="Dispatched agent">
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title" data-tip={head?.description}>
            {head?.description || 'Agent'}
          </span>
        </span>
        <button type="button" className="icon-btn" data-testid="dispatch-close" aria-label="Close dispatched agents" onClick={onClose}>
          ✕
        </button>
      </header>
      <div
        className="side-list dispatch-detail"
        data-testid="dispatch-detail"
        data-id={id}
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {head && (
          <div className="dispatch-meta" data-testid="dispatch-meta">
            <Dot status={head.status} />
            {head.subagentType !== null && <span className="dispatch-type">{head.subagentType}</span>}
            <span className="dispatch-usage">{usageLine(head, now)}</span>
          </div>
        )}
        {waiting && (
          <div className="dispatch-wait boxed" data-testid="dispatch-wait">
            Waiting for your approval in the chat
          </div>
        )}
        {failed && entry === null && (
          <div className="file-note" role="alert">
            Couldn't load this agent.{' '}
            <button type="button" className="btn small" onClick={retry}>
              Retry
            </button>
          </div>
        )}
        {entry === null && !failed && <div className="file-note">Loading…</div>}
        {entry !== null && body !== null && (
          <>
            {/* Once it ended the report leads: it is the answer, the steps are how it got there. */}
            {!running && report}
            <Folded
              label={parent ? `Prompt from ${parent.description || 'its agent'}` : 'Prompt from main agent'}
              text={entry.prompt || '(no prompt)'}
              testId="dispatch-prompt"
            />
            {body.steps.length > 0 && (
              <button
                type="button"
                className="dispatch-steps-toggle"
                data-testid="dispatch-steps-toggle"
                aria-expanded={showSteps}
                onClick={() => setPick(!showSteps)}
              >
                <span className="tool-run-caret" aria-hidden="true">
                  ▸
                </span>{' '}
                {stepsLabel(body.steps.length)}
              </button>
            )}
            {showSteps &&
              body.steps.map((s, i) => (
                <Step key={s.kind === 'tool' || s.kind === 'agent' ? s.id : `${s.kind}-${i}`} step={s} list={list} onOpen={onOpen} />
              ))}
            {running && (
              <div className="dispatch-working" data-testid="dispatch-working">
                <span className="spinner" aria-hidden="true" /> {head?.now ? `${head.now}…` : 'working…'}
              </div>
            )}
            {running && report}
          </>
        )}
      </div>
    </aside>
  )
}

function Step({ step, list, onOpen }: { step: DispatchStep; list: DispatchSummary[]; onOpen: (id: string) => void }) {
  if (step.kind === 'text') {
    return (
      <div className="dispatch-text" data-testid="dispatch-step" data-kind="text">
        <Markdown text={step.text} />
      </div>
    )
  }
  if (step.kind === 'tool') {
    return (
      <div className="dispatch-tool" data-testid="dispatch-step" data-kind="tool">
        <ToolCallRow item={toolItemOf(step)} />
      </div>
    )
  }
  if (step.kind === 'agent') {
    const child = list.find((s) => s.id === step.id)
    return (
      <button type="button" className="dispatch-child" data-testid="dispatch-step" data-kind="agent" onClick={() => onOpen(step.id)}>
        {child && <Dot status={child.status} />}
        <span className="dispatch-name">↳ {child?.description || 'Agent'}</span>
        {child?.subagentType && <span className="dispatch-type">{child.subagentType}</span>}
        <span className="dispatch-chev" aria-hidden="true">
          ›
        </span>
      </button>
    )
  }
  return (
    <div className="file-note dispatch-gap" data-testid="dispatch-step" data-kind="gap">
      {step.dropped} steps in the middle were not kept
    </div>
  )
}
