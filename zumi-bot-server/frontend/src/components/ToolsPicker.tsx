import { useState } from 'react'

export const KNOWN_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'Task'
] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
}

export function ToolsPicker({ value, onChange }: Props) {
  const [custom, setCustom] = useState('')
  const known: readonly string[] = KNOWN_TOOLS
  const customTools = value.filter((t) => !known.includes(t))

  const toggle = (tool: string): void => {
    onChange(value.includes(tool) ? value.filter((t) => t !== tool) : [...value, tool])
  }

  const add = (): void => {
    const name = custom.trim()
    if (name === '') return
    if (!value.includes(name)) onChange([...value, name])
    setCustom('')
  }

  return (
    <div className="tools-picker">
      <div className="tools-grid">
        {KNOWN_TOOLS.map((tool) => (
          <label key={tool} className="tool-check">
            <input type="checkbox" checked={value.includes(tool)} onChange={() => toggle(tool)} />
            {tool}
          </label>
        ))}
      </div>
      {customTools.length > 0 && (
        <div className="opts">
          {customTools.map((tool) => (
            <span key={tool} className="opt tool-tag">
              {tool}
              <button type="button" className="icon-btn" aria-label={`Remove ${tool}`} onClick={() => toggle(tool)}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="tools-add">
        <input
          className="field"
          aria-label="MCP tool name"
          placeholder="mcp__server__tool"
          spellCheck={false}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className="btn" onClick={add} disabled={custom.trim() === ''}>
          Add
        </button>
      </div>
      {value.length === 0 && <div className="hint">Nothing picked: the agent inherits all tools.</div>}
    </div>
  )
}
