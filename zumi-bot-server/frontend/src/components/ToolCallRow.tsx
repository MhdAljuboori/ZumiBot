import { useContext, useState } from 'react'
import { DISPATCH_TOOLS } from '@zumibot/shared/dispatch'
import type { ChatItem } from '@zumibot/shared/types'
import { visibleJson } from '@zumibot/shared/visibleText'
import { sandboxRowLine } from '../state/sandboxLine'
import { toolLabel } from '../state/toolLabel'
import { DispatchLinkContext } from './dispatchLink'

type ToolItem = Extract<ChatItem, { type: 'tool' }>

/** One tool call: what it did in words, the exact command, path or URL dimmed under it; opens to its Input and Result. */
export function ToolCallRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const words = toolLabel(item.name, item.input)
  const label = (
    <>
      <span className="tool-head-title">{item.blocked ? `⛔ blocked: ${words.title}` : `▸ ${words.title}`}</span>
      {words.detail !== null && (
        <span className="tool-head-detail" data-tip={words.detail}>
          {words.detail}
        </span>
      )}
    </>
  )
  // A clear line for what the sandbox refused; the row's own result keeps the CLI's text.
  const sandboxLine = sandboxRowLine(item)
  const link = useContext(DispatchLinkContext)
  // A dispatch whose subagent was recorded: Watch while it runs, View after.
  const watch = DISPATCH_TOOLS.has(item.name) ? link.state(item.id) : null
  const head = (
    <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      {label}
    </button>
  )

  return (
    <div className={item.blocked ? 'tool blocked' : item.isError ? 'tool failed' : 'tool'} data-testid="tool-row" data-tool-id={item.id}>
      {watch === null ? (
        head
      ) : (
        <div className="tool-head-row">
          {head}
          <button type="button" className={`dispatch-watch ${watch}`} data-testid="dispatch-watch" onClick={() => link.open(item.id)}>
            {watch === 'running' ? 'Watch ›' : 'View ›'}
          </button>
        </div>
      )}
      {sandboxLine && (
        <div className="tool-sandbox-line" data-testid="tool-sandbox-line">
          {sandboxLine}
        </div>
      )}
      {open && (
        <div className="tool-panel">
          <div className="tool-label">Input</div>
          {/* Hidden and reordering characters show as JSON escapes: this is the input the user is told to read. */}
          <pre>{visibleJson(item.input)}</pre>
          <div className="tool-label">Result</div>
          <pre>{item.result ?? '(no result yet)'}</pre>
        </div>
      )}
    </div>
  )
}
