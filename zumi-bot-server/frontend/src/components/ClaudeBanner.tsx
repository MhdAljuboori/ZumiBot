import { useState } from 'react'
import { api } from '../api'
import { errorMessage } from '../errors'

interface Props {
  onPathFound: (path: string) => void
}

export function ClaudeBanner({ onPathFound }: Props) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (busy || path.trim() === '') return
    setBusy(true)
    setMessage(null)
    try {
      const res = await api.app.setClaudePath(path.trim())
      if (res.path === null) setMessage('Still not found at that path')
      else onPathFound(res.path)
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="claude-banner" data-testid="claude-banner" role="alert">
      <strong>Claude CLI not found.</strong>
      <input
        className="field"
        type="text"
        value={path}
        placeholder="/path/to/claude"
        aria-label="Path to the claude binary"
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void save()}
      />
      <button type="button" className="btn" disabled={busy || path.trim() === ''} onClick={() => void save()}>
        Save
      </button>
      {message && <span className="banner-note">{message}</span>}
    </div>
  )
}
