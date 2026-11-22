import { useState } from 'react'
import { UNTITLED_ROOM } from '@zumibot/shared/roomClone'
import type { RoomHandoff } from '@zumibot/shared/types'
import { handoffPreview } from '../state/cloneRoom'
import { Markdown, MentionScope } from './Markdown'
import { MenuIcon } from './MenuIcon'

interface Props {
  handoff: RoomHandoff
  /** The room it was cloned from is still listed: its name opens it. */
  sourceExists: boolean
  onOpenSource: () => void
}

/**
 * The note a cloned room's members read, at the top of the room. Not a message: no actions, never unread, not in the
 * Files panel.
 */
export function HandoffCard({ handoff, sourceExists, onOpenSource }: Props) {
  const [open, setOpen] = useState(false)
  const name = handoff.from.title.trim() || UNTITLED_ROOM
  return (
    <section className="handoff-card" data-testid="handoff-card" aria-label="Handoff note">
      <div className="handoff-head">
        <MenuIcon name="fileText" className="menu-icon handoff-icon" />
        <span className="handoff-title">
          Handoff from{' '}
          {sourceExists ? (
            <button type="button" className="handoff-source" data-testid="handoff-source" data-tip="Open that room" onClick={onOpenSource}>
              {name}
            </button>
          ) : (
            <span className="handoff-source-name">{name}</span>
          )}
        </span>
      </div>
      {open ? (
        // A plain note: @handles in it are not mentions here.
        <div className="handoff-body" dir="auto">
          <MentionScope.Provider value={null}>
            <Markdown text={handoff.text} />
          </MentionScope.Provider>
        </div>
      ) : (
        <p className="handoff-preview" dir="auto">
          {handoffPreview(handoff.text)}
        </p>
      )}
      <button type="button" className="handoff-toggle" data-testid="handoff-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Show less' : 'Show all'}
      </button>
    </section>
  )
}
