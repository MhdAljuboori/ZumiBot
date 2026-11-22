import { useState } from 'react'
import { commandIssue, validCommands, type AgentCommand } from '@zumibot/shared/commands'
import { commandModelOptions } from '../state/commandModel'
import { forTextarea } from '../state/editorState'
import { EditorIcon } from './EditorIcon'
import { SearchSelect } from './SearchSelect'

interface Props {
  commands: AgentCommand[]
  onChange: (next: AgentCommand[]) => void
  /** Whether a command may pick a model: Claude's command models only (Codex has none). */
  claudeModels?: boolean
}

// The "/" is drawn outside the input and never stored; one typed or pasted in front is dropped.
const cleanName = (v: string): string => v.replace(/^\/+/, '').toLowerCase()

export function CommandsCard({ commands, onChange, claudeModels = true }: Props) {
  // Row messages stay hidden until that row was edited, so a legacy file opens without red text. Indexed like `commands`.
  const [touched, setTouched] = useState<boolean[]>([])
  const valid = validCommands(commands).length

  const edit = (i: number, patch: Partial<AgentCommand>): void => {
    setTouched((t) => {
      const next = commands.map((_, j) => t[j] ?? false)
      next[i] = true
      return next
    })
    onChange(commands.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  }

  // The agent's model drops the key, like an unticked to-dos box.
  const setModel = (i: number, model: string) =>
    onChange(
      commands.map((c, j) => {
        if (j !== i) return c
        const { model: _was, ...rest } = c
        return model === '' ? rest : { ...rest, model }
      })
    )
  // Unticked drops the key rather than writing `todos: false`; it is not a content edit, so no row message appears.
  const setTodos = (i: number, on: boolean): void => {
    onChange(
      commands.map((c, j) => {
        if (j !== i) return c
        const { todos: _was, ...rest } = c
        return on ? { ...rest, todos: true } : rest
      })
    )
  }

  return (
    <section className="card" aria-labelledby="card-commands">
      <header className="card-head">
        <EditorIcon name="list" />
        <h3 className="card-title" id="card-commands">
          Commands
        </h3>
        <span className="card-meta">{valid}</span>
      </header>
      {commands.length > 0 && (
        <div className="command-list">
          {commands.map((c, i) => {
            const issue = touched[i] ? commandIssue(commands, i) : null
            return (
              <div key={i} className="command-row" data-testid="command-row">
                <div className="command-top">
                  <div className="command-name">
                    <span className="command-slash mono" aria-hidden="true">
                      /
                    </span>
                    <input
                      className="field mono"
                      data-testid="command-name"
                      aria-label="Command name"
                      placeholder="name"
                      spellCheck={false}
                      autoCapitalize="none"
                      value={c.name}
                      aria-invalid={issue !== null}
                      onChange={(e) => edit(i, { name: cleanName(e.target.value) })}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn ghost small command-remove"
                    data-testid="remove-command"
                    aria-label={`Remove command ${c.name === '' ? i + 1 : `/${c.name}`}`}
                    data-tip="Remove command"
                    onClick={() => {
                      setTouched((t) => commands.map((_, j) => t[j] ?? false).filter((_, j) => j !== i))
                      onChange(commands.filter((_, j) => j !== i))
                    }}
                  >
                    <EditorIcon name="trash" />
                  </button>
                </div>
                <input
                  className="field"
                  data-testid="command-description"
                  aria-label="Command description"
                  placeholder="Shown in the menu"
                  value={c.description}
                  aria-invalid={issue !== null}
                  onChange={(e) => edit(i, { description: e.target.value })}
                />
                <textarea
                  className="field command-prompt"
                  data-testid="command-prompt"
                  aria-label="Command prompt"
                  placeholder="What the agent receives"
                  rows={3}
                  value={forTextarea(c.prompt)}
                  aria-invalid={issue !== null}
                  onChange={(e) => edit(i, { prompt: e.target.value })}
                />
                <div className="command-options">
                  <label className="tool-check command-todos">
                    <input
                      type="checkbox"
                      data-testid="command-todos"
                      checked={c.todos === true}
                      onChange={(e) => setTodos(i, e.target.checked)}
                    />
                    Makes to-dos
                  </label>
                  {claudeModels && (
                    <label className="command-model" data-tip="A chat this command starts runs on this model, and stays on it">
                      Model
                      <SearchSelect className="field" data-testid="command-model" value={c.model ?? ''} onChange={(v) => setModel(i, v)}>
                        {commandModelOptions(c.model).map(([value, text]) => (
                          <option key={value} value={value}>
                            {text}
                          </option>
                        ))}
                      </SearchSelect>
                    </label>
                  )}
                </div>
                {issue && <div className="field-error">{issue}</div>}
              </div>
            )
          })}
        </div>
      )}
      <button
        type="button"
        className="command-add"
        data-testid="add-command"
        onClick={() => onChange([...commands, { name: '', description: '', prompt: '' }])}
      >
        + Add command
      </button>
      <div className="hint">
        <EditorIcon name="info" />
        $ARGUMENTS marks where your text goes; without it, your text goes at the end.
      </div>
    </section>
  )
}
