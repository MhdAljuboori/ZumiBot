import { dismissMessage, dismissToast, startUpdate, useUpdate } from '../useUpdate'

/** "A new version is out", bottom right; What's new opens Settings › About. An error from Update is its own line. */
export function UpdateToast({ onWhatsNew }: { onWhatsNew: () => void }) {
  const { toast, message, pending, reload } = useUpdate()
  // A message alone shows too: after Local mode's restart the new server has not checked yet, so there is no version to
  // offer, but why the update failed must not wait for that check.
  if (toast === null && reload === null && message === null) return null
  return (
    <div className="update-toast" role="status" data-testid="update-toast">
      {reload !== null && (
        <div className="update-toast-row" data-testid="update-toast-reload-row">
          <span className="update-toast-text">{reload}</span>
          <button type="button" className="btn small primary" data-testid="update-toast-reload" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      {toast !== null && (
        <div className="update-toast-row">
          <span className="update-toast-text">{`ZumiBot v${toast} is available`}</span>
          <button
            type="button"
            className="btn small primary"
            data-testid="update-toast-install"
            disabled={pending}
            onClick={() => void startUpdate('install')}
          >
            Update
          </button>
          <button type="button" className="btn small" data-testid="update-toast-notes" onClick={onWhatsNew}>
            What's new
          </button>
          <button type="button" className="update-toast-x" aria-label="Dismiss" data-testid="update-toast-dismiss" onClick={dismissToast}>
            ✕
          </button>
        </div>
      )}
      {message !== null && (
        <div className="update-toast-row update-toast-error" role="alert" data-testid="update-toast-error">
          <span className="update-toast-text">{message}</span>
          <button type="button" className="btn small" data-testid="update-toast-error-ok" onClick={dismissMessage}>
            OK
          </button>
        </div>
      )}
    </div>
  )
}
