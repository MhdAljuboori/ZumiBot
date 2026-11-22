import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { displayName } from '@zumibot/shared/frontmatter'
import type { CommandPick } from '@zumibot/shared/commands'
import { ROUTINE_CHAT_TITLE_MAX } from '@zumibot/shared/routines'
import type { SidebarSection } from '@zumibot/shared/sidebarLayout'
import { dayOf } from '@zumibot/shared/spendCaps'
import { ROLE_MAX_CHARS, isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import type { VaultListItem } from '@zumibot/shared/vault'
import { nameFromPath } from '@zumibot/shared/workflowTransform'
import {
  CHAT_NOT_FOUND,
  FAILING_KINDS,
  HTTP_HEADERS_MAX,
  HTTP_METHODS,
  NOTIFY_BODY_MAX,
  STEP_RULE_COMMAND_MAX,
  STEP_RULE_TOOL_MAX,
  TRANSFORM_FIELDS_MAX,
  WAIT_MAX,
  WAIT_MIN,
  failsBranch,
  roomFromAgents,
  type Effort,
  type HttpHeader,
  type ModelAlias,
  type Step,
  type StepRule,
  type TransformField,
  type Workflow,
  type WorkflowInput,
  type WorkflowRunSummary
} from '@zumibot/shared/workflows'
import { api } from '../api'
import { memberAgents, membersLabel } from '../state/groupChat'
import { shownSection } from '../state/routineDraft'
import { useDismiss } from '../useDismiss'
import { useConnected } from '../useConnected'
import { keepPick } from '../state/commandInput'
import { chatTitle, folderName } from '../state/sidebarTree'
import { renameStep, setFailurePath, setHandle, STEP_LABELS, updateStep } from '../state/workflowCanvas'
import { firstFieldIndex, stepAgents } from '../state/workflowEditor'
import { chatOptions, chatStepNote } from '../state/workflowChat'
import { ROOM_UNTITLED, draftRule, roomOptions, roomStepNote, ruleText, rulesWith } from '../state/workflowRoom'
import { roomSourceOf, stepCommandAgents, withKeep, withPrompt, withRoomSource } from '../state/workflowStepCommands'
import { Caret } from './Caret'
import { ExpandButton, ExpandDialog } from './ExpandDialog'
import { FolderIcon } from './FolderIcon'
import { MemberStack } from './MemberStack'
import { MembersMenu } from './MembersMenu'
import { PromptField } from './PromptField'
import { StepTest } from './StepTest'
import { StepIcon } from './WorkflowIcons'
import { MenuSearch } from './MenuSearch'
import { SearchSelect } from './SearchSelect'

// The server's cap on a step name (NAME_MAX in workflowInput.ts).
const STEP_NAME_MAX = 100
const MODELS: { value: ModelAlias; label: string }[] = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' }
]
const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

interface Props {
  draft: WorkflowInput
  step: Step
  /** This step's problems from problemsOf. */
  problems: string[]
  agents: AgentSummary[]
  /** Every chat, for a Room step's picker (the template rooms) and its member list. */
  chats: ChatMeta[]
  /** Every saved workflow, for a Sub-workflow step's picker. */
  workflows: Workflow[]
  /** The sidebar's sections, where a kept room can be placed. */
  sections: readonly SidebarSection[]
  /** What `{{` offers in this step's template fields. */
  fields: string[]
  /** `key` names a text field, whose typing undoes as one step. */
  edit: (change: (w: WorkflowInput) => WorkflowInput, key?: string) => void
  /** The trigger's own settings (TriggerInspector), shown for the trigger step. */
  triggerPanel: ReactNode
  runs: WorkflowRunSummary[]
  onRemove: () => void
  onOpenChat: (chatId: string) => void
  onError: (e: unknown) => void
  /** Asks for focus: the name field with its text selected, or the first editable field after it. `n` changes on every request. */
  focus?: { field: 'name' | 'first'; n: number }
  /** The request was handled: the editor drops it, so a step opened later does not take focus from an old one. */
  onFocused?: () => void
}

/**
 * A template field: PromptField with the `{{` menu over this step's fields. Expand opens it in a dialog, a second editor
 * on the same value, for reading and editing a long prompt.
 */
function TemplateField({
  label,
  testId,
  value,
  onChange,
  fields,
  placeholder,
  expand = true,
  commandAgents,
  grouped,
  pick,
  onPick,
  children
}: {
  label: string
  testId: string
  value: string
  onChange: (text: string) => void
  fields: string[]
  placeholder: string
  expand?: boolean
  /** The `/` menu's agents (Agent, For each, Room and Chat prompts); none = no menu. */
  commandAgents?: AgentSummary[]
  grouped?: boolean
  pick?: CommandPick | null
  onPick?: (pick: CommandPick) => void
  children?: ReactNode
}) {
  const commands = { commandAgents, grouped, pick, onPick }
  // One each: a PromptField clears its insertRef when it unmounts, which must not blank the inspector's.
  const insertRef = useRef<((path: string) => void) | null>(null)
  const bigInsertRef = useRef<((path: string) => void) | null>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const [big, setBig] = useState(false)
  const name = label.replace(/ \(optional\)$/, '')
  return (
    <div className="rt-fieldset wf-template">
      <div className="wf-field-head">
        <span className="rt-label">{label}</span>
        {expand && <ExpandButton ref={opener} label={name} testId={`${testId}-expand`} onClick={() => setBig(true)} />}
      </div>
      <PromptField
        value={value}
        onChange={onChange}
        fields={fields}
        insertRef={insertRef}
        placeholder={placeholder}
        ariaLabel={label}
        testId={testId}
        {...commands}
      />
      {children}
      {big && (
        <ExpandDialog
          title={name}
          testId={`${testId}-dialog`}
          onClose={() => {
            setBig(false)
            opener.current?.focus()
          }}
        >
          <PromptField
            value={value}
            onChange={onChange}
            fields={fields}
            insertRef={bigInsertRef}
            placeholder={placeholder}
            ariaLabel={label}
            testId={`${testId}-big`}
            menuAtCaret
            autoFocus
            {...commands}
          />
          {children}
        </ExpandDialog>
      )}
    </div>
  )
}

/**
 * The handle field. It shows what the user types while it has focus; the workflow always holds a valid handle (made by
 * setHandle), so a save never fails on one, and the field shows that handle once focus leaves.
 */
function HandleField({ step, onSet }: { step: Step; onSet: (typed: string) => void }) {
  const [typed, setTyped] = useState<string | null>(null)
  return (
    <label className="rt-fieldset">
      <span className="rt-label">Handle</span>
      <input
        className="rt-input mono"
        data-testid="wf-step-handle"
        aria-label="Handle"
        maxLength={32}
        spellCheck={false}
        value={typed ?? step.handle}
        onFocus={() => setTyped(step.handle)}
        onBlur={() => setTyped(null)}
        onChange={(e) => {
          setTyped(e.target.value)
          onSet(e.target.value)
        }}
      />
      <span className="rt-hint">
        Other steps read this step's output as <span className="mono">{`{{steps.${step.handle}.output}}`}</span>. Lowercase letters, digits
        and dashes.
      </span>
    </label>
  )
}

type ApiKey = Extract<VaultListItem, { kind: 'apiKey' }>

/** The vault's API keys a workflow may send, refetched on every vault change; names and flags only, never a value. */
function useWorkflowKeys(on: boolean): ApiKey[] | null {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const connected = useConnected()
  useEffect(() => {
    if (!on || !connected) return
    let live = true
    const load = (): void => {
      api.vault.list().then(
        (items) => {
          if (live) setKeys(items.filter((i): i is ApiKey => i.kind === 'apiKey'))
        },
        () => {
          if (live) setKeys([])
        }
      )
    }
    load()
    const off = api.vault.onChanged(load)
    return () => {
      live = false
      off()
    }
  }, [on, connected])
  return keys
}

/** Rows of two text inputs with a remove button each, and an Add row; for HTTP headers and Transform fields. */
function PairRows<K extends string>({
  rows,
  keys,
  labels,
  placeholders,
  max,
  addText,
  testId,
  onChange
}: {
  rows: Record<K, string>[]
  keys: [K, K]
  labels: [string, string]
  placeholders: [string, string]
  max: number
  addText: string
  testId: string
  onChange: (rows: Record<K, string>[]) => void
}) {
  const set = (i: number, k: K, v: string): void => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  return (
    <div className="wf-pairs" data-testid={testId}>
      {rows.map((r, i) => (
        <div className="wf-pair-row" key={i} data-testid={`${testId}-row`}>
          <input
            className="rt-input mono"
            aria-label={`${labels[0]} ${i + 1}`}
            placeholder={placeholders[0]}
            value={r[keys[0]]}
            spellCheck={false}
            onChange={(e) => set(i, keys[0], e.target.value)}
            data-testid={`${testId}-${keys[0]}`}
          />
          <input
            className="rt-input mono"
            aria-label={`${labels[1]} ${i + 1}`}
            placeholder={placeholders[1]}
            value={r[keys[1]]}
            spellCheck={false}
            onChange={(e) => set(i, keys[1], e.target.value)}
            data-testid={`${testId}-${keys[1]}`}
          />
          <button
            type="button"
            className="icon-btn wf-pair-remove"
            aria-label={`Remove ${labels[0].toLowerCase()} ${i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      {rows.length < max && (
        <button
          type="button"
          className="rt-insert"
          data-testid={`${testId}-add`}
          onClick={() => onChange([...rows, { [keys[0]]: '', [keys[1]]: '' } as Record<K, string>])}
        >
          {addText}
        </button>
      )}
    </div>
  )
}

/** A Room step's approval rules: one row per rule with Remove, and an Add row. Removing a rule changes only future runs. */
function RuleRows({ rules, members, onChange }: { rules: StepRule[]; members: string[]; onChange: (rules: StepRule[]) => void }) {
  const [agent, setAgent] = useState('')
  const [tool, setTool] = useState('')
  const [command, setCommand] = useState('')
  const [unsandboxed, setUnsandboxed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bash = tool.trim() === 'Bash'
  // A member picked for another room's list must not stay in force once it is not listed (the select would read Every member).
  const who = members.includes(agent) ? agent : ''
  const add = (): void => {
    const made = draftRule({ agent: who, tool, command, unsandboxed }, rules)
    if ('error' in made) {
      setError(made.error)
      return
    }
    onChange(rulesWith(rules, made.rule))
    setTool('')
    setCommand('')
    setUnsandboxed(false)
    setError(null)
  }
  return (
    <div className="rt-fieldset wf-rules" data-testid="wf-rules">
      <span className="rt-label">Approval rules</span>
      <span className="rt-hint">A tool call that matches a rule runs with no card. Everything else asks you, as it does in any room.</span>
      {rules.map((r, i) => (
        <div className="wf-rule" key={i} data-testid="wf-rule">
          <span className="wf-rule-text mono">{ruleText(r)}</span>
          <button
            type="button"
            className="icon-btn wf-pair-remove"
            data-testid="wf-rule-remove"
            aria-label={`Remove rule ${i + 1}`}
            onClick={() => onChange(rules.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="wf-rule-add">
        <SearchSelect className="rt-select" data-testid="wf-rule-agent" aria-label="Rule for" value={who} onChange={(v) => setAgent(v)}>
          <option value="">Every member</option>
          {members.map((m) => (
            <option key={m} value={m}>
              {displayName(m)}
            </option>
          ))}
        </SearchSelect>
        <input
          className="rt-input mono"
          data-testid="wf-rule-tool"
          aria-label="Tool"
          placeholder="Bash, Edit, mcp__server__tool"
          spellCheck={false}
          value={tool}
          maxLength={STEP_RULE_TOOL_MAX}
          onChange={(e) => {
            setTool(e.target.value)
            setError(null)
          }}
        />
        {bash && (
          <input
            className="rt-input mono"
            data-testid="wf-rule-command"
            aria-label="Exact command"
            placeholder="npm run build"
            spellCheck={false}
            value={command}
            maxLength={STEP_RULE_COMMAND_MAX}
            onChange={(e) => {
              setCommand(e.target.value)
              setError(null)
            }}
          />
        )}
        {bash && (
          <label className="wf-check">
            <input
              type="checkbox"
              data-testid="wf-rule-unsandboxed"
              checked={unsandboxed}
              onChange={(e) => setUnsandboxed(e.target.checked)}
            />
            <span>Also outside the sandbox</span>
          </label>
        )}
        <button type="button" className="rt-insert" data-testid="wf-rule-add" onClick={add}>
          Add rule
        </button>
        {error !== null && (
          <span className="rt-hint wf-rule-error" data-testid="wf-rule-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

/** An Agent or Room step's "After the step": archive its chat (default) or keep it in the sidebar, with a Title when kept. `children` follows the title (a kept room's section). */
function KeepFields({
  step,
  draft,
  onKeep,
  onTitle,
  children
}: {
  step: Extract<Step, { kind: 'agent' | 'room' }>
  draft: WorkflowInput
  onKeep: (keep: boolean) => void
  onTitle: (title: string) => void
  children?: ReactNode
}) {
  // What the chat is called when no title is set: the runner's `<workflow> · <step> · <day>`.
  const placeholder = [draft.name.trim() || 'Workflow name', step.name, dayOf(Date.now(), draft.timeZone).day].join(' · ')
  return (
    <>
      <label className="rt-fieldset">
        <span className="rt-label">After the step</span>
        <SearchSelect
          className="rt-select"
          data-testid="wf-keep"
          value={step.keep ? 'keep' : 'archive'}
          onChange={(v) => onKeep(v === 'keep')}
        >
          <option value="archive">Archive the chat</option>
          <option value="keep">Keep it in the sidebar</option>
        </SearchSelect>
        <span className="rt-hint">
          {step.keep
            ? 'The chat stays in the sidebar once the step is done, so you can read it and write back.'
            : "The chat is archived once the step is done; a failed step's chat stays."}
        </span>
      </label>
      {step.keep && (
        <label className="rt-fieldset">
          <span className="rt-label">Title</span>
          <input
            className="rt-input"
            data-testid="wf-title"
            aria-label="Chat title"
            maxLength={ROUTINE_CHAT_TITLE_MAX}
            placeholder={placeholder}
            value={step.title ?? ''}
            onChange={(e) => onTitle(e.target.value)}
          />
        </label>
      )}
      {step.keep && children}
    </>
  )
}

/** A Room step's members picker for a room made from agents. */
function RoomMembers({
  agents,
  selected,
  onChange
}: {
  agents: AgentSummary[]
  selected: string[]
  onChange: (members: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close)
  const picked = memberAgents(selected, agents)
  return (
    <div className="rt-fieldset">
      <span className="rt-label">Members</span>
      <span className="rt-pop-wrap" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="rt-pill rt-pick"
          data-testid="wf-room-members"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {picked.length > 0 && <MemberStack agents={picked} size={18} working={[]} max={3} />}
          <span>{selected.length > 0 ? membersLabel(selected.length) : 'Select agents'}</span>
          <Caret />
        </button>
        {open && (
          <div className="menu rt-members-menu" role="menu">
            <MenuSearch />
            <MembersMenu
              agents={agents}
              selected={selected}
              disabled={false}
              keepMinimum={false}
              optionTestId="wf-room-member-option"
              onChange={onChange}
            />
          </div>
        )}
      </span>
    </div>
  )
}

function ModelSelect({ value, onChange, testId }: { value: ModelAlias; onChange: (m: ModelAlias) => void; testId: string }) {
  return (
    <label className="rt-fieldset">
      <span className="rt-label">Model</span>
      <SearchSelect className="rt-select" data-testid={testId} value={value} onChange={(v) => onChange(v as ModelAlias)}>
        {MODELS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </SearchSelect>
    </label>
  )
}

export function StepInspector({
  draft,
  step,
  problems,
  agents,
  chats,
  workflows,
  sections,
  fields,
  edit,
  triggerPanel,
  runs,
  onRemove,
  onOpenChat,
  onError,
  focus,
  onFocused
}: Props) {
  const keys = useWorkflowKeys(step.kind === 'http')
  const root = useRef<HTMLDivElement>(null)
  // Keyed on `n`, so a second request refocuses. The fields after the name differ by kind and some load lazily (the
  // prompt editor), so "first" is looked up when asked: the first text field, or any control, after the name.
  const focusN = focus?.n
  useEffect(() => {
    if (!focus) return
    const name = root.current?.querySelector<HTMLInputElement>('[data-testid="wf-step-name"]')
    if (!name) return
    onFocused?.()
    if (focus.field === 'name') {
      name.focus()
      name.select()
      return
    }
    const after = [...root.current!.querySelectorAll<HTMLElement>('textarea, input:not([type="hidden"]), select, [contenteditable="true"]')]
      .filter((el) => el !== name && !el.matches('[data-testid="wf-step-handle"]') && !el.closest('.wf-test'))
      .filter((el) => name.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    const next =
      after[
        firstFieldIndex(
          after.map((el) => ({
            tagName: el.tagName,
            isContentEditable: el.isContentEditable,
            type: el.getAttribute('type') ?? undefined,
            disabled: el.matches(':disabled'),
            readOnly: el.hasAttribute('readonly')
          }))
        )
      ]
    if (next) next.focus()
    else name.focus()
  }, [focusN])
  // A default folder fetched for an agent the user has since changed must not land.
  const folderRequest = useRef(0)
  const set = (patch: Record<string, unknown>, field?: string): void =>
    edit((w) => updateStep(w, step.id, patch), field === undefined ? undefined : `${step.id}:${field}`)
  const kindLabel = step.kind === 'trigger' ? 'Trigger' : STEP_LABELS[step.kind]
  const hint = <div className="rt-hint">Type {'{{'} to put in this step's input, another step's output or a trigger field.</div>
  // Replaces this step through a function of it (the step helpers take whole steps). `field` coalesces typing into one undo step.
  const change = (fn: (s: Step) => Step, field?: string): void =>
    edit(
      (w) => ({ ...w, steps: w.steps.map((x) => (x.id === step.id ? fn(x) : x)) }),
      field === undefined ? undefined : `${step.id}:${field}`
    )
  // Memoized on what picks the agents: a new list each render would repaint the prompt's editor each render.
  const commandKey =
    step.kind === 'agent' || step.kind === 'foreach'
      ? step.agent
      : step.kind === 'room'
        ? `${step.room}\0${(roomFromAgents(step) ? step.members : []).join('\0')}`
        : step.kind === 'chat'
          ? step.chat
          : ''
  const commandTarget = useMemo(() => stepCommandAgents(step, agents, chats), [commandKey, step.kind, agents, chats])
  const hasCommands = commandTarget.agents.some((a) => a.error === null && (a.commands ?? []).length > 0)
  // The `/` menu of an Agent, For each, Room or Chat prompt: a pick is saved as `command` while the prompt still starts with its name.
  const promptField = (placeholder: string) => {
    if (step.kind !== 'agent' && step.kind !== 'foreach' && step.kind !== 'room' && step.kind !== 'chat') return null
    return (
      <TemplateField
        label="Prompt"
        testId="wf-prompt"
        value={step.prompt}
        onChange={(prompt) => change((x) => withPrompt(x, prompt), 'prompt')}
        fields={fields}
        placeholder={placeholder}
        commandAgents={commandTarget.agents}
        grouped={commandTarget.grouped}
        pick={keepPick(step.prompt, step.command ?? null)}
        onPick={(command) => set({ command }, 'command')}
      >
        {hint}
        {hasCommands && (
          <div className="rt-hint" data-testid="wf-prompt-command-hint">
            Start with / to run an agent's command.
          </div>
        )}
      </TemplateField>
    )
  }

  const pickAgent = (name: string): void => {
    const request = ++folderRequest.current
    set({ agent: name })
    if (!name || ((step.kind === 'agent' || step.kind === 'foreach') && step.cwd)) return
    api.app.lastFolder(name).then((cwd) => {
      if (request !== folderRequest.current || cwd === null) return
      edit((w) => {
        const s = w.steps.find((x) => x.id === step.id)
        return (s?.kind === 'agent' || s?.kind === 'foreach') && s.agent === name && !s.cwd ? updateStep(w, step.id, { cwd }) : w
      })
    }, onError)
  }
  const chooseFolder = (agent: string): void => {
    api.app.pickFolder(agent || null).then((cwd) => {
      if (cwd === null) return
      folderRequest.current++
      set({ cwd })
    }, onError)
  }

  let body: ReactNode = null
  switch (step.kind) {
    case 'trigger':
      body = triggerPanel
      break
    case 'agent':
    case 'foreach': {
      const pickable = stepAgents(agents)
      const each = step.kind === 'foreach'
      body = (
        <>
          <label className="rt-fieldset">
            <span className="rt-label">Agent</span>
            <SearchSelect className="rt-select" data-testid="wf-agent" value={step.agent} onChange={(v) => pickAgent(v)}>
              <option value="">Select agent</option>
              {step.agent && !pickable.some((a) => a.name === step.agent) && (
                <option value={step.agent}>{step.agent} (not available)</option>
              )}
              {pickable.map((a) => (
                <option key={a.filePath} value={a.name}>
                  {displayName(a.name)}
                </option>
              ))}
            </SearchSelect>
          </label>
          <div className="rt-fieldset">
            <span className="rt-label">Folder</span>
            <button
              type="button"
              className="rt-pill rt-pick"
              data-testid="wf-agent-folder"
              data-tip={step.cwd || undefined}
              onClick={() => chooseFolder(step.agent)}
            >
              <FolderIcon />
              <span>{step.cwd ? folderName(step.cwd) : 'Choose folder'}</span>
            </button>
            <span className="rt-hint rt-folder-hint">
              {each ? 'Each item starts a new chat with the agent here.' : 'Each run starts a new chat with the agent here.'}
            </span>
          </div>
          <label className="rt-fieldset">
            <span className="rt-label">Model</span>
            <SearchSelect
              className="rt-select"
              data-testid="wf-agent-model"
              value={step.model ?? ''}
              onChange={(v) => set({ model: v === '' ? undefined : v })}
            >
              <option value="">Agent's model</option>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </SearchSelect>
          </label>
          {promptField('What should the agent do?')}
          {step.kind === 'agent' && (
            <KeepFields
              step={step}
              draft={draft}
              onKeep={(keep) => change((x) => withKeep(x, keep))}
              onTitle={(title) => set({ title: title === '' ? undefined : title }, 'title')}
            />
          )}
          {each && (
            <label className="rt-fieldset">
              <span className="rt-label">Run at once</span>
              <SearchSelect
                className="rt-select"
                data-testid="wf-foreach-concurrency"
                value={String(step.concurrency ?? 1)}
                onChange={(v) => set({ concurrency: v === '1' ? undefined : Number(v) })}
              >
                <option value="1">1 (one after another)</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </SearchSelect>
              {(step.concurrency ?? 1) > 1 && (
                <span className="rt-hint" data-testid="wf-foreach-concurrency-hint">
                  Items run side by side, each in its own chat. They share the agent's browser and desktop, which take one item at a time.
                </span>
              )}
            </label>
          )}
          {each && (
            <div className="rt-hint" data-testid="wf-foreach-hint">
              Runs once per line of its input, each in a fresh chat. Use {'{{item}}'} for the line.
            </div>
          )}
        </>
      )
      break
    }
    case 'chat': {
      const { rooms, singles } = chatOptions(chats, step.chat, agents, ZUMI_BOT_NAME)
      const note = chatStepNote(step.chat, chats, agents, ZUMI_BOT_NAME)
      const chatListed = [...rooms, ...singles].some((c) => c.id === step.chat)
      const group = (label: string, list: ChatMeta[]) =>
        list.length > 0 && (
          <optgroup label={label}>
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {chatTitle(c, agents)}
              </option>
            ))}
          </optgroup>
        )
      body = (
        <>
          <label className="rt-fieldset">
            <span className="rt-label">Chat</span>
            <SearchSelect className="rt-select" data-testid="wf-chat" value={step.chat} onChange={(v) => set({ chat: v })}>
              <option value="">Select chat</option>
              {step.chat && !chatListed && <option value={step.chat}>{CHAT_NOT_FOUND}</option>}
              {group('Group chats', rooms)}
              {group('Chats', singles)}
            </SearchSelect>
            {note !== null && (
              <span className="rt-hint wf-chat-missing" data-testid="wf-chat-missing" role="alert">
                {note}
              </span>
            )}
            <span className="rt-hint">Each run posts the prompt into this chat as your own message.</span>
          </label>
          {promptField('What should the chat do?')}
          <label className="rt-fieldset">
            <span className="rt-label">Agent sessions</span>
            <SearchSelect
              className="rt-select"
              data-testid="wf-chat-session"
              value={step.session ?? 'continue'}
              onChange={(v) => set({ session: v === 'fresh' ? 'fresh' : undefined })}
            >
              <option value="continue">Continue each agent's session</option>
              <option value="fresh">Start fresh each run</option>
            </SearchSelect>
            <span className="rt-hint">
              {step.session === 'fresh'
                ? "Each run starts new agent sessions from the chat's recent messages. Uses far fewer tokens; older details stay in the chat but not in the agents' memory."
                : 'The agents keep everything from earlier runs. After a few idle hours a big chat is reloaded in full, which uses many tokens.'}
            </span>
          </label>
        </>
      )
      break
    }
    case 'room': {
      const source = roomSourceOf(step)
      const options = roomOptions(chats, step.room)
      const note = roomStepNote(step.room, chats)
      const members =
        source === 'agents' ? (step.members ?? []) : (chats.find((c) => c.id === step.room && isGroup(c))?.group?.members ?? [])
      const setSource = (next: 'copy' | 'agents'): void => {
        if (next === source) return
        const request = ++folderRequest.current
        change((x) => (x.kind === 'room' ? withRoomSource(x, next) : x))
        // As the new group chat screen does: the folder the last room used.
        if (next !== 'agents') return
        api.app.lastGroupFolder().then((cwd) => {
          if (request !== folderRequest.current || cwd === null) return
          edit((w) => {
            const s = w.steps.find((x) => x.id === step.id)
            return s?.kind === 'room' && roomFromAgents(s) && !s.cwd ? updateStep(w, step.id, { cwd }) : w
          })
        }, onError)
      }
      body = (
        <>
          <div className="rt-fieldset">
            <span className="rt-label">Room</span>
            <div className="rt-seg" role="group" aria-label="Room" data-testid="wf-room-source">
              {(['copy', 'agents'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={source === k} data-testid={`wf-room-source-${k}`} onClick={() => setSource(k)}>
                  {k === 'copy' ? 'Copy a room' : 'New room from agents'}
                </button>
              ))}
            </div>
          </div>
          {source === 'copy' ? (
            <label className="rt-fieldset">
              <span className="rt-label">Room to copy</span>
              <SearchSelect className="rt-select" data-testid="wf-room" value={step.room} onChange={(v) => set({ room: v })}>
                <option value="">Select room</option>
                {step.room && !options.some((c) => c.id === step.room) && <option value={step.room}>Room not found</option>}
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title || ROOM_UNTITLED}
                  </option>
                ))}
              </SearchSelect>
              {note !== null && (
                <span className="rt-hint wf-room-missing" data-testid="wf-room-missing" role="alert">
                  {note}
                </span>
              )}
              <span className="rt-hint">Each run starts a fresh copy of this room: same members, role and folder, no history.</span>
            </label>
          ) : (
            <>
              <RoomMembers agents={agents} selected={step.members ?? []} onChange={(next) => set({ members: next }, 'members')} />
              <label className="rt-fieldset">
                <span className="rt-label">Role</span>
                <textarea
                  className="rt-input rt-role"
                  data-testid="wf-room-role"
                  rows={3}
                  maxLength={ROLE_MAX_CHARS}
                  placeholder="How this team works. Every agent and the moderator read it."
                  value={step.role ?? ''}
                  onChange={(e) => set({ role: e.target.value }, 'role')}
                />
              </label>
              <div className="rt-fieldset">
                <span className="rt-label">Folder</span>
                <button
                  type="button"
                  className="rt-pill rt-pick"
                  data-testid="wf-room-folder"
                  data-tip={step.cwd || undefined}
                  onClick={() => chooseFolder('')}
                >
                  <FolderIcon />
                  <span>{step.cwd ? folderName(step.cwd) : 'Choose folder'}</span>
                </button>
                <span className="rt-hint rt-folder-hint">Each run starts a new room of these agents here.</span>
              </div>
            </>
          )}
          {promptField('What should the room do?')}
          <KeepFields
            step={step}
            draft={draft}
            onKeep={(keep) => change((x) => withKeep(x, keep))}
            onTitle={(title) => set({ title: title === '' ? undefined : title }, 'title')}
          >
            <label className="rt-fieldset">
              <span className="rt-label">Sidebar section</span>
              <SearchSelect
                className="rt-select"
                data-testid="wf-room-section"
                value={shownSection(step.section ?? '', sections)}
                onChange={(v) => set({ section: v === '' ? undefined : v })}
              >
                <option value="">Outside sections</option>
                {sections.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name || 'Untitled section'}
                  </option>
                ))}
              </SearchSelect>
            </label>
          </KeepFields>
          <RuleRows
            rules={step.rules ?? []}
            members={members}
            onChange={(rules) => set({ rules: rules.length ? rules : undefined }, 'rules')}
          />
        </>
      )
      break
    }
    case 'llm':
      body = (
        <>
          <div className="wf-pair">
            <ModelSelect value={step.model} onChange={(model) => set({ model })} testId="wf-llm-model" />
            <label className="rt-fieldset">
              <span className="rt-label">Effort</span>
              <SearchSelect
                className="rt-select"
                data-testid="wf-llm-effort"
                value={step.effort ?? ''}
                onChange={(v) => set({ effort: v === '' ? undefined : v })}
              >
                <option value="">Default</option>
                {EFFORTS.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </SearchSelect>
            </label>
          </div>
          <TemplateField
            label="Prompt"
            testId="wf-prompt"
            value={step.prompt}
            onChange={(prompt) => set({ prompt }, 'prompt')}
            fields={fields}
            placeholder="Summarise {{input}} in three lines"
          >
            {hint}
          </TemplateField>
          {/* Cleared means absent: the server's default system prompt then applies, never an empty one. */}
          <TemplateField
            label="System prompt (optional)"
            testId="wf-system"
            value={step.system ?? ''}
            onChange={(system) => set({ system: system === '' ? undefined : system }, 'system')}
            fields={fields}
            placeholder="Leave empty for the default"
          />
        </>
      )
      break
    case 'condition':
      body = (
        <>
          <ModelSelect value={step.model} onChange={(model) => set({ model })} testId="wf-condition-model" />
          <TemplateField
            label="Question"
            testId="wf-question"
            value={step.question}
            onChange={(question) => set({ question }, 'question')}
            fields={fields}
            placeholder="Does the input report a failure?"
          >
            {hint}
            <div className="rt-hint">The step leaves by Yes or No and hands on its own input.</div>
          </TemplateField>
        </>
      )
      break
    case 'approval':
      body = (
        <>
          <TemplateField
            label="Question"
            testId="wf-question"
            value={step.question}
            onChange={(question) => set({ question }, 'question')}
            fields={fields}
            placeholder="Send this reply?"
          >
            {hint}
          </TemplateField>
          <label className="wf-check">
            <input
              type="checkbox"
              data-testid="wf-approval-editable"
              checked={step.editable}
              onChange={(e) => set({ editable: e.target.checked })}
            />
            Let me edit the text
          </label>
          <div className="rt-hint">The run waits here until you answer, with no time limit.</div>
        </>
      )
      break
    case 'wait':
      body = (
        <label className="rt-fieldset">
          <span className="rt-label">Minutes</span>
          <input
            className="rt-input wf-minutes"
            data-testid="wf-wait-minutes"
            type="number"
            min={WAIT_MIN}
            max={WAIT_MAX}
            step={1}
            value={Number.isFinite(step.minutes) && step.minutes !== 0 ? step.minutes : ''}
            onChange={(e) => {
              // JSON has no NaN: an empty or odd value is kept as 0, which problemsOf shows as out of range.
              const n = Math.round(Number(e.target.value))
              set({ minutes: e.target.value === '' || !Number.isFinite(n) ? 0 : n }, 'minutes')
            }}
          />
          <span className="rt-hint">
            From {WAIT_MIN} to {WAIT_MAX} minutes, then the input goes on unchanged.
          </span>
        </label>
      )
      break
    case 'http': {
      const usable = (keys ?? []).filter((k) => k.workflows)
      const picked = step.key ? (keys ?? []).find((k) => k.id === step.key) : undefined
      body = (
        <>
          <div className="wf-pair">
            <label className="rt-fieldset wf-method">
              <span className="rt-label">Method</span>
              <SearchSelect className="rt-select" data-testid="wf-http-method" value={step.method} onChange={(v) => set({ method: v })}>
                {HTTP_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </SearchSelect>
            </label>
          </div>
          <TemplateField
            label="Address"
            testId="wf-http-url"
            value={step.url}
            onChange={(url) => set({ url }, 'url')}
            fields={fields}
            placeholder="https://api.example.com/items/{{input}}"
            expand={false}
          >
            <div className="rt-hint">The scheme and host are fixed: {'{{…}}'} only after the first /, and each value is URL-encoded.</div>
          </TemplateField>
          <div className="rt-fieldset">
            <span className="rt-label">Headers</span>
            <PairRows<keyof HttpHeader>
              rows={step.headers}
              keys={['name', 'value']}
              labels={['Header', 'Value']}
              placeholders={['Authorization', 'Bearer {{key}}']}
              max={HTTP_HEADERS_MAX}
              addText="Add header"
              testId="wf-http-headers"
              onChange={(headers) => set({ headers }, 'headers')}
            />
          </div>
          <label className="rt-fieldset">
            <span className="rt-label">API key (optional)</span>
            <SearchSelect
              className="rt-select"
              data-testid="wf-http-key"
              value={step.key ?? ''}
              onChange={(v) => set({ key: v === '' ? undefined : v })}
            >
              <option value="">None</option>
              {step.key && !usable.some((k) => k.id === step.key) && (
                <option value={step.key}>{picked ? `${picked.name} (not allowed for workflows)` : '(deleted key)'}</option>
              )}
              {usable.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </SearchSelect>
            <span className="rt-hint">
              Write {'{{key}}'} where it goes. Only vault API keys with "Workflow HTTP steps can use this" are listed (Settings › Vault).
            </span>
          </label>
          <label className="wf-check">
            <input
              type="checkbox"
              data-testid="wf-http-local"
              checked={step.allowLocalNetwork === true}
              onChange={(e) => set({ allowLocalNetwork: e.target.checked ? true : undefined })}
            />
            Allow local network
          </label>
          <div className="rt-hint">Lets the step reach this machine and the LAN. Off, it reaches only public addresses.</div>
          {step.method !== 'GET' && (
            <>
              <label className="rt-fieldset">
                <span className="rt-label">Body type</span>
                <SearchSelect
                  className="rt-select"
                  data-testid="wf-http-body-type"
                  value={step.bodyType}
                  onChange={(v) => set({ bodyType: v })}
                >
                  <option value="json">JSON</option>
                  <option value="text">Text</option>
                </SearchSelect>
              </label>
              <TemplateField
                label="Body (optional)"
                testId="wf-http-body"
                value={step.body ?? ''}
                onChange={(text) => set({ body: text === '' ? undefined : text }, 'body')}
                fields={fields}
                placeholder={'{"text": "{{input}}"}'}
              >
                {step.bodyType === 'json' && (
                  <div className="rt-hint">Inside quotes a value is escaped; outside them it goes in as is, so it must be JSON.</div>
                )}
              </TemplateField>
            </>
          )}
          <div className="rt-hint">The output is the response body. Any status from 400 up fails the step.</div>
          {hint}
        </>
      )
      break
    }
    case 'transform':
      body = (
        <>
          <div className="rt-fieldset">
            <span className="rt-label">Fields</span>
            <PairRows<keyof TransformField>
              rows={step.fields}
              keys={['name', 'path']}
              labels={['Name', 'Path']}
              placeholders={['title', 'pull_request.title']}
              max={TRANSFORM_FIELDS_MAX}
              addText="Add field"
              testId="wf-transform-fields"
              onChange={(f) => set({ fields: f }, 'fields')}
            />
            {step.fields.some((f) => !f.name.trim() && f.path.trim()) && (
              <button
                type="button"
                className="rt-insert"
                data-testid="wf-transform-names"
                onClick={() =>
                  set({ fields: step.fields.map((f) => (!f.name.trim() && f.path.trim() ? { ...f, name: nameFromPath(f.path) } : f)) })
                }
              >
                Name fields after their paths
              </button>
            )}
            <span className="rt-hint">
              A path reads the JSON input: <span className="mono">a.b</span>, <span className="mono">items.0.id</span>,{' '}
              <span className="mono">items[].title</span> for every item.
            </span>
          </div>
          <label className="rt-fieldset">
            <span className="rt-label">Output</span>
            <SearchSelect className="rt-select" data-testid="wf-transform-format" value={step.format} onChange={(v) => set({ format: v })}>
              <option value="json">JSON object of the fields</option>
              <option value="lines">One value per line</option>
            </SearchSelect>
            <span className="rt-hint">
              {step.format === 'lines'
                ? 'A list gives one line per item, ready for a For each step; one field gives its value alone.'
                : 'A field whose path finds nothing is null.'}
            </span>
          </label>
        </>
      )
      break
    case 'workflow': {
      const others = workflows.filter((x) => x.id !== draft.id)
      body = (
        <>
          <label className="rt-fieldset">
            <span className="rt-label">Workflow</span>
            <SearchSelect className="rt-select" data-testid="wf-sub-workflow" value={step.workflow} onChange={(v) => set({ workflow: v })}>
              <option value="">Select workflow</option>
              {step.workflow && !others.some((x) => x.id === step.workflow) && <option value={step.workflow}>(not available)</option>}
              {others.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </SearchSelect>
            <span className="rt-hint">It runs whether or not it is switched on, and its run shows in its own list.</span>
          </label>
          <TemplateField
            label="Input"
            testId="wf-sub-input"
            value={step.input}
            onChange={(input) => set({ input }, 'input')}
            fields={fields}
            placeholder="{{input}}"
          >
            <div className="rt-hint">
              What its trigger hands on. The step waits for the run to end, its approvals too, and hands on what its last steps made.
            </div>
          </TemplateField>
        </>
      )
      break
    }
    case 'notify':
      body = (
        <>
          <TemplateField
            label="Title"
            testId="wf-notify-title"
            value={step.title}
            onChange={(title) => set({ title }, 'title')}
            fields={fields}
            placeholder="Workflow finished"
            expand={false}
          />
          <TemplateField
            label="Body (optional)"
            testId="wf-notify-body"
            value={step.body ?? ''}
            onChange={(text) => set({ body: text === '' ? undefined : text }, 'body')}
            fields={fields}
            placeholder="More detail, if any"
          />
          <div className="rt-hint wf-lock" data-testid="wf-notify-warning">
            The title and the first {NOTIFY_BODY_MAX} characters of the body show on your lock screen; the Inbox keeps the whole text.
          </div>
          {hint}
        </>
      )
      break
  }

  return (
    <div ref={root} className="wf-inspect" data-testid="wf-step-inspector" data-step-id={step.id} data-kind={step.kind}>
      <div className="wf-inspect-head">
        <span className="rt-tile">
          <StepIcon kind={step.kind} />
        </span>
        <h3>{kindLabel}</h3>
      </div>
      {problems.length > 0 && (
        <ul className="rt-errors wf-step-problems" data-testid="wf-step-problems" role="alert">
          {problems.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <label className="rt-fieldset">
        <span className="rt-label">Name</span>
        <input
          className="rt-input"
          data-testid="wf-step-name"
          aria-label="Step name"
          maxLength={STEP_NAME_MAX}
          value={step.name}
          onChange={(e) => edit((w) => renameStep(w, step.id, e.target.value), `${step.id}:name`)}
        />
      </label>
      <HandleField step={step} onSet={(typed) => edit((w) => setHandle(w, step.id, typed), `${step.id}:handle`)} />
      {body}
      {FAILING_KINDS.includes(step.kind) && (
        <label className="rt-fieldset">
          <span className="rt-label">On failure</span>
          <SearchSelect
            className="rt-select"
            data-testid="wf-on-failure"
            value={failsBranch(step) ? 'branch' : 'stop'}
            onChange={(v) => edit((w) => setFailurePath(w, step.id, v === 'branch'))}
          >
            <option value="stop">Stop the run</option>
            <option value="branch">Go on along the failure path</option>
          </SearchSelect>
          <span className="rt-hint">
            {failsBranch(step)
              ? "Connect the red Failed port: it gets the error (and an HTTP error's body). A Stop, a restart or your own action still stops the run."
              : 'The run stops here until you press Retry.'}
          </span>
        </label>
      )}
      {['llm', 'condition', 'agent', 'foreach', 'http', 'transform'].includes(step.kind) && (
        <StepTest draft={draft} step={step} runs={runs} onOpenChat={onOpenChat} />
      )}
      {step.kind !== 'trigger' && (
        <button type="button" className="btn wf-remove" data-testid="wf-step-remove" onClick={onRemove}>
          Remove step
        </button>
      )}
    </div>
  )
}
