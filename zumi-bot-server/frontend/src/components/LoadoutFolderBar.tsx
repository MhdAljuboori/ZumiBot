import { useState } from 'react'
import { api } from '../api'
import { FOLDER_RUN_NOTE } from '../state/extensionsPage'
import { FolderIcon } from './FolderIcon'

interface Props {
  folder: string
  /** The agent whose last folder the browser opens at; null for the page of everything (it opens at home). */
  agentName: string | null
  /** A probe is out. */
  loading: boolean
  onFolder: (path: string) => void
  onRefresh: () => void
}

/**
 * The folder a loadout is read for, with its picker and the Refresh that asks the CLI again, and the sentence that looking at a folder
 * starts its servers and hooks. Shared by Settings › Claude Code and Agent Studio's card.
 */
export function LoadoutFolderBar({ folder, agentName, loading, onFolder, onRefresh }: Props) {
  const [picking, setPicking] = useState(false)
  const pick = async (): Promise<void> => {
    setPicking(true)
    try {
      const path = await api.app.pickFolder(agentName)
      if (path) onFolder(path)
    } catch {
      // The picker has its own errors; a failed open changes nothing here.
    } finally {
      setPicking(false)
    }
  }
  return (
    <>
      <div className="ext-folder-bar">
        <span className="ext-folder-label">Folder</span>
        <span className="ext-folder" data-testid="ext-folder" data-tip={folder}>
          <FolderIcon />
          {folder === '' ? '…' : folder}
        </span>
        <button type="button" className="btn small" data-testid="ext-folder-pick" disabled={picking} onClick={() => void pick()}>
          Change…
        </button>
        <button type="button" className="btn small" data-testid="ext-refresh" disabled={loading || folder === ''} onClick={onRefresh}>
          Refresh
        </button>
        {loading && <span className="spinner" role="status" aria-label="Loading" data-testid="ext-loading" />}
      </div>
      {/* No confirm: the user picked the folder, and this says plainly what looking at it does (I3). */}
      <p className="ext-note" data-testid="ext-folder-note">
        {FOLDER_RUN_NOTE}
      </p>
    </>
  )
}
