import { useEffect, useRef } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import { groupOptions, type CommandOption } from '../state/commandInput'
import { BotIcon } from './BotIcon'

interface Props {
  options: readonly CommandOption[]
  /** A room: one header per agent over its commands. */
  grouped: boolean
  active: number
  onActive: (index: number) => void
  onPick: (option: CommandOption) => void
}

/** The `/` list of the composer and the message editor: two-line rows (the command, its description under it). */
export function CommandMenu({ options, grouped, active, onActive, onPick }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Arrow keys can move past the menu's max height; keep the row they reach in view.
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const row = (o: CommandOption, i: number) => {
    const name = 'builtin' in o ? o.builtin : o.command.name
    const description = 'builtin' in o ? o.description : o.command.description
    const agent = 'builtin' in o ? undefined : o.agent.name
    const makesTodos = !('builtin' in o) && o.command.todos === true
    return (
      <button
        key={`${agent ?? 'builtin'}/${name}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={i === active}
        className={i === active ? 'command-option on' : 'command-option'}
        data-testid="command-option"
        data-agent-name={agent}
        data-command-name={name}
        onMouseEnter={() => onActive(i)}
        onClick={() => onPick(o)}
      >
        <span className="command-name">
          /{name}
          {makesTodos && (
            <span className="command-todos" data-testid="command-todos" data-tip="Makes to-dos" role="img" aria-label="Makes to-dos">
              ☑
            </span>
          )}
        </span>
        <span className="command-desc">{description}</span>
      </button>
    )
  }

  // mousedown is held back so the text box keeps its focus (and caret) while a row is clicked.
  return (
    <div
      className="menu mention-menu command-menu"
      role="listbox"
      aria-label="Commands"
      data-testid="command-menu"
      ref={ref}
      onMouseDown={(e) => e.preventDefault()}
    >
      {grouped && options.map((o, i) => ('builtin' in o ? row(o, i) : null))}
      {grouped
        ? groupOptions(options).map((g) => (
            <div key={g.agent.filePath} className="command-group" role="group" aria-label={displayName(g.agent.name)}>
              <div className="command-agent" data-testid="command-agent" aria-hidden="true">
                <BotIcon icon={g.agent.icon} color={g.agent.color} builtIn={g.agent.builtIn} working={false} size={18} />
                <span className="picker-text">{displayName(g.agent.name)}</span>
              </div>
              {g.options.map((o) => row(o, options.indexOf(o)))}
            </div>
          ))
        : options.map(row)}
    </div>
  )
}

interface WorkflowProps {
  workflows: readonly { id: string; name: string }[]
  active: number
  onActive: (index: number) => void
  onPick: (workflow: { id: string; name: string }) => void
}

/** The second level of `/run-workflow `: the workflows to start, by name. */
export function WorkflowMenu({ workflows, active, onActive, onPick }: WorkflowProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  return (
    <div
      className="menu mention-menu"
      role="listbox"
      aria-label="Workflows"
      data-testid="workflow-menu"
      ref={ref}
      onMouseDown={(e) => e.preventDefault()}
    >
      {workflows.map((w, i) => (
        <button
          key={w.id}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={i === active}
          className={i === active ? 'on' : undefined}
          data-testid="workflow-option"
          data-workflow-id={w.id}
          onMouseEnter={() => onActive(i)}
          onClick={() => onPick(w)}
        >
          <span className="picker-text">{w.name}</span>
        </button>
      ))}
    </div>
  )
}
