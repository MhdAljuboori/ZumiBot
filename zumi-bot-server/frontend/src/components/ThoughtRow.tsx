import { useState } from 'react'
import { thoughtPreview, thoughtTitle, type ThinkingItem } from '../state/messageGroups'
import { Markdown } from './Markdown'

/** One thinking block in a run, as a tool row: how long it took, its first line dimmed under it; opens to the whole summary. */
export function ThoughtRow({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false)
  const preview = thoughtPreview(item.text, 'first')
  return (
    <div className="tool thought" data-testid="thought-row" data-item-id={item.id}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-head-title">▸ {thoughtTitle(item)}</span>
        {!open && preview !== '' && (
          <span className="tool-head-detail" data-tip={preview}>
            {preview}
          </span>
        )}
      </button>
      {open && (
        <div className="tool-panel thought-text">
          <Markdown text={item.text} />
        </div>
      )}
    </div>
  )
}
