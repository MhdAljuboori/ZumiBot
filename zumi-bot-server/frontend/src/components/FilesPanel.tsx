import { useState } from 'react'
import { formatSize } from '@zumibot/shared/attachments'
import type { AttachedFile, ChangedFile, ChatFileList } from '@zumibot/shared/files'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { agentColor } from '../state/bot'
import { splitPath } from '../state/filesPanel'
import { findAgent } from '../state/groupChat'
import { FilePreview } from './FilePreview'
import { SideBackButton } from './SidePanelMenu'

interface Props {
  chat: ChatMeta
  /** null until the first answer. */
  list: ChatFileList | null
  /** The first fetch failed (only meaningful while `list` is null). */
  failed: boolean
  onRetry: () => void
  agents: AgentSummary[]
  /** Back to the side panel's list. */
  onBack: () => void
  onClose: () => void
  onShow: (itemId: string) => void
  onQuote: (block: string) => void
  onExplain: ((block: string, member?: string) => void) | null
}

type Picked = { kind: 'changed'; path: string } | { kind: 'attached'; key: string }

const attachedKey = (a: AttachedFile): string => `${a.itemId}:${a.attachment.id}`

/** One dot per agent that changed the file, in the colour the sidebar gives it. */
function Dots({ file, chat, agents }: { file: ChangedFile; chat: ChatMeta; agents: AgentSummary[] }) {
  const names = [...new Set(file.changes.map((c) => c.agent ?? chat.agentName))]
  return (
    <span className="file-dots">
      {names.map((name) => {
        const agent = findAgent(agents, name)
        const color = agent && agent.error === null ? agentColor(agent.color) : null
        return <span key={name} className="file-dot" data-tip={displayName(name)} style={color ? { background: color } : undefined} />
      })}
    </span>
  )
}

/** The Files panel: what the chat's agents changed and what the user attached, with a preview of the one picked. */
export function FilesPanel({ chat, list, failed, onRetry, agents, onBack, onClose, onShow, onQuote, onExplain }: Props) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const changed = list?.changed ?? []
  const attached = list?.attached ?? []
  // A pick that is gone after a refresh (a version switch) shows nothing.
  const file = picked?.kind === 'changed' ? changed.find((f) => f.path === picked.path) : undefined
  const item = picked?.kind === 'attached' ? attached.find((a) => attachedKey(a) === picked.key) : undefined
  const target = file ? { changed: file } : item ? { attached: item } : null
  return (
    <aside className="files-panel" data-testid="files-panel" aria-label="Files">
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title">Files</span>
        </span>
        <button type="button" className="icon-btn" data-testid="files-close" aria-label="Close files" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="files-list">
        {list === null && failed ? (
          <div className="file-note" role="alert">
            Couldn't load files.{' '}
            <button type="button" className="btn small" data-testid="files-retry" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : list === null ? (
          <div className="file-note" role="status">
            <span className="spinner" aria-hidden="true" /> Loading…
          </div>
        ) : changed.length === 0 && attached.length === 0 ? (
          <div className="file-note">No files in this chat yet.</div>
        ) : null}
        {changed.length > 0 && (
          <>
            <div className="files-section">Changed by agents</div>
            {changed.map((f) => {
              const { name, dir } = splitPath(f.shown)
              const n = f.changes.length
              return (
                <button
                  key={f.path}
                  type="button"
                  className={file === f ? 'file-row on' : 'file-row'}
                  data-testid="file-row"
                  data-path={f.path}
                  data-tip={f.path}
                  onClick={() => setPicked({ kind: 'changed', path: f.path })}
                >
                  <Dots file={f} chat={chat} agents={agents} />
                  <span className="file-name">{name}</span>
                  {dir !== '' && <span className="file-dir">{dir}</span>}
                  {f.created && <span className="file-badge">new</span>}
                  <span className="file-count">
                    {n} {n === 1 ? 'change' : 'changes'}
                  </span>
                </button>
              )
            })}
          </>
        )}
        {attached.length > 0 && (
          <>
            <div className="files-section">Attached by you</div>
            {attached.map((a) => (
              <button
                key={attachedKey(a)}
                type="button"
                className={item === a ? 'file-row on' : 'file-row'}
                data-testid="attached-row"
                data-tip={a.attachment.name}
                onClick={() => setPicked({ kind: 'attached', key: attachedKey(a) })}
              >
                <span className="file-name">{a.attachment.name}</span>
                <span className="file-count">{formatSize(a.attachment.size)}</span>
              </button>
            ))}
          </>
        )}
      </div>
      {target ? (
        <FilePreview
          key={file ? `c:${file.path}` : `a:${attachedKey(item!)}`}
          chat={chat}
          target={target}
          onShow={onShow}
          onQuote={onQuote}
          onExplain={onExplain}
        />
      ) : (
        <div className="file-note file-empty">Pick a file to see it.</div>
      )}
    </aside>
  )
}
