import { useState } from 'react'
import type { Attachment } from '@zumibot/shared/types'
import { attachmentUrl, formatSize, isThumbnail } from '@zumibot/shared/attachments'
import type { DraftFile } from '../state/draftFiles'
import { previewUrl } from '../state/localPreviews'
import { draftItems, sentItems, viewer } from '../state/viewer'

const MISSING = 'File missing'

const RemoveButton = ({ name, onRemove }: { name: string; onRemove: () => void }) => (
  <button
    type="button"
    className="attach-remove"
    data-testid="draft-attachment-remove"
    aria-label={`Remove ${name}`}
    data-tip={`Remove ${name}`}
    onClick={onRemove}
  >
    ✕
  </button>
)

const FileIcon = () => (
  <svg className="attach-file-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 1.75h5l3 3v9.5H4z M9 1.75v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
)

/** An image attachment as a square thumbnail; a file that fails to load shows "File missing". */
export function AttachmentThumb({ url, name, onOpen, sent }: { url: string; name: string; onOpen?: () => void; sent?: boolean }) {
  const [broken, setBroken] = useState(false)
  const cls = sent ? 'attach-thumb sent' : 'attach-thumb'
  if (broken)
    return (
      <span className={`${cls} missing`} data-tip={name}>
        {MISSING}
      </span>
    )
  const img = <img src={url} alt={name} data-tip={name} loading={sent ? 'lazy' : undefined} decoding="async" onError={() => setBroken(true)} />
  return onOpen ? (
    <button type="button" className={cls} aria-label={`Open ${name}`} onClick={onOpen}>
      {img}
    </button>
  ) : (
    <span className={cls}>{img}</span>
  )
}

/** A non-image attachment (or one still being staged) as a name chip, with its size when known. */
export function AttachmentChip({
  name,
  size,
  onOpen,
  onRemove
}: {
  name: string
  size?: number
  onOpen?: () => void
  onRemove?: () => void
}) {
  const label = (
    <>
      <FileIcon />
      <span className="picker-text">{name}</span>
      {size !== undefined && <span className="attach-size">{formatSize(size)}</span>}
    </>
  )
  return (
    <span className="attach-chip">
      {onOpen ? (
        <button type="button" className="attach-open" data-tip={name} onClick={onOpen}>
          {label}
        </button>
      ) : (
        <span className="attach-open static" data-tip={name}>
          {label}
        </span>
      )}
      {onRemove && <RemoveButton name={name} onRemove={onRemove} />}
    </span>
  )
}

/** The files waiting in the composer: thumbnails for images, chips for the rest. */
export function DraftAttachments({ files, onRemove }: { files: DraftFile[]; onRemove: (key: string) => void }) {
  if (files.length === 0) return null
  // Opens the in-app viewer on this file, with the other staged ones a step away.
  const view = (key: string) => (): void => {
    const items = draftItems(files, previewUrl)
    viewer.open(
      items,
      items.findIndex((i) => i.key === key)
    )
  }
  return (
    <div className="draft-attachments" data-testid="draft-attachments">
      {files.map((f) => (
        <div key={f.key} className="draft-attachment" data-testid="draft-attachment" data-status={f.status}>
          {f.status === 'ready' && isThumbnail(f.attachment) ? (
            <>
              <AttachmentThumb
                url={previewUrl(f.attachment.id) ?? attachmentUrl(null, f.attachment.id)}
                name={f.name}
                onOpen={view(f.attachment.id)}
              />
              <RemoveButton name={f.name} onRemove={() => onRemove(f.key)} />
            </>
          ) : (
            <AttachmentChip
              name={f.name}
              size={f.status === 'ready' ? f.attachment.size : undefined}
              {...(f.status === 'ready' ? { onOpen: view(f.attachment.id) } : {})}
              onRemove={() => onRemove(f.key)}
            />
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * The files of a sent message, above its bubble. A click opens one in the in-app viewer, which also offers the default
 * app and Download. An image picked on this page shows from memory, so it is there the moment the message is sent.
 */
export function SentAttachments({ chatId, attachments }: { chatId: string; attachments: Attachment[] }) {
  if (attachments.length === 0) return null
  const open = (a: Attachment): void => viewer.open(sentItems(chatId, attachments, previewUrl), attachments.indexOf(a))
  return (
    <div className="sent-attachments" data-testid="sent-attachments">
      {attachments.map((a) =>
        isThumbnail(a) ? (
          <span key={a.id} className="sent-item" data-testid="sent-thumb">
            <AttachmentThumb sent url={previewUrl(a.id) ?? attachmentUrl(chatId, a.id)} name={a.name} onOpen={() => open(a)} />
          </span>
        ) : (
          <span key={a.id} className="sent-item" data-testid="sent-chip">
            <AttachmentChip name={a.name} size={a.size} onOpen={() => open(a)} />
          </span>
        )
      )}
    </div>
  )
}
