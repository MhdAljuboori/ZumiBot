import { useEffect, useState } from 'react'
import { formatSize } from '@zumibot/shared/attachments'
import { useBrowser } from '../useAgentBrowser'

export function BrowserFiles() {
  const browser = useBrowser(),
    status = browser?.state.status
  const [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const dialog = status?.dialog,
    chooser = status?.fileChooser
  const owned = browser?.state.control && status?.control === 'you'
  useEffect(() => {
    setText(dialog?.defaultValue ?? '')
    setError('')
  }, [dialog?.tabId, dialog?.type, dialog?.message, dialog?.defaultValue])
  useEffect(() => {
    setError('')
    setBusy(false)
  }, [status?.generation, status?.control, chooser?.tabId])
  if (!browser || !status) return null
  return (
    <div className="browser-files">
      {dialog && (
        <div className="browser-website-dialog" role="group" aria-label="Website dialog">
          <strong>Website {dialog.type === 'beforeunload' ? 'confirmation' : dialog.type}</strong>
          <p>{dialog.message}</p>
          {dialog.type === 'prompt' && (
            <input
              aria-label="Website prompt response"
              autoComplete="off"
              value={text}
              maxLength={16384}
              disabled={!owned}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <div className="browser-file-actions">
            <button
              type="button"
              className="btn small primary"
              aria-label="Accept website dialog"
              disabled={!owned}
              onClick={() => browser.navigate({ op: 'dialog', accept: true, ...(dialog.type === 'prompt' ? { text } : {}) })}
            >
              OK
            </button>
            {dialog.type !== 'alert' && (
              <button
                type="button"
                className="btn small"
                aria-label="Dismiss website dialog"
                disabled={!owned}
                onClick={() => browser.navigate({ op: 'dialog', accept: false })}
              >
                Cancel
              </button>
            )}
            {!owned && <span>Take control to answer this website dialog.</span>}
          </div>
        </div>
      )}
      {chooser && (
        <div className="browser-website-chooser" role="group" aria-label="Website upload">
          <label>
            Choose {chooser.multiple ? 'files' : 'a file'} for this website
            <input
              type="file"
              aria-label="Choose files for website"
              multiple={chooser.multiple}
              disabled={!owned || busy || chooser.tabId !== status.activeTabId}
              onChange={async (e) => {
                const files = Array.from(e.currentTarget.files ?? [])
                e.currentTarget.value = ''
                if (!files.length) return
                setBusy(true)
                setError('')
                try {
                  await browser.uploadFiles(files)
                } catch (error) {
                  setError(error instanceof Error ? error.message : 'Browser upload failed')
                } finally {
                  setBusy(false)
                }
              }}
            />
          </label>
          <button
            type="button"
            className="btn small"
            disabled={!owned || busy}
            onClick={() => browser.navigate({ op: 'chooseFiles', fileIds: [] })}
          >
            Cancel file selection
          </button>
          <span>{busy ? 'Uploading…' : 'Up to 25 MB per file.'}</span>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
      {!!status.downloads?.length && (
        <div className="browser-downloads" aria-label="Browser downloads">
          <strong>Downloads</strong>
          <span>Available for one hour</span>
          {status.downloads.map((file) => (
            <a
              key={file.id}
              href={`/api/browser/files/${encodeURIComponent(file.id)}`}
              download={file.name}
              aria-label={`Download ${file.name}`}
            >
              {file.name} <span>{formatSize(file.size)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
