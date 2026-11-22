import { Fragment, useMemo, useRef, useState } from 'react'
import { attachmentUrl, formatSize, isThumbnail } from '@zumibot/shared/attachments'
import type { AttachedFile, ChangedFile } from '@zumibot/shared/files'
import { displayName } from '@zumibot/shared/frontmatter'
import type { ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import {
  diffRows,
  diffSource,
  isTextAttachment,
  neededIds,
  quoteBlock,
  restoreButton,
  restoredText,
  selectedLines,
  sidesOf,
  splitPath,
  stepLabel,
  viewRows,
  whoLabel,
  type FileView,
  type RestoreButton,
  type Row,
  type Side,
  type StepPick
} from '../state/filesPanel'
import { languageOf, rowTokens, type Tok } from '../state/syntax'
import { useHighlighter } from '../useHighlighter'
import { cachedText, loadText, snapshotUrl, useLoadedTexts } from '../useSnapshotText'
import { ConfirmDialog } from './ConfirmDialog'
import { SelectionMenu, useMessageSelection } from './SelectionMenu'
import { SearchSelect } from './SearchSelect'

export type Target = { changed: ChangedFile } | { attached: AttachedFile }

interface Props {
  chat: ChatMeta
  target: Target
  onShow: (itemId: string) => void
  onQuote: (block: string) => void
  /** null while sending is not possible (offline, no claude). */
  onExplain: ((block: string, member?: string) => void) | null
}

// A very different file diffs as one hunk of up to a megabyte of rows: draw the first part, the rest on request.
const ROW_CAP = 2000
// Selections count only inside the lines, not the toolbar or the notices around them.
const ROWS = '[data-testid="file-rows"]'

const timeOf = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Revoked after the click is handled: some browsers start the download after this call returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** A line's text in its syntax colours (tokens spell the text exactly, see rowTokens), or plain. */
function Code({ text, toks }: { text: string; toks: Tok[] | null }) {
  if (text === '')
    return (
      <span className="code">
        <br />
      </span>
    )
  if (!toks) return <span className="code">{text}</span>
  return (
    <span className="code">
      {toks.map((t, k) =>
        t.tone ? (
          <span key={k} className={`tk-${t.tone}`}>
            {t.text}
          </span>
        ) : (
          <Fragment key={k}>{t.text}</Fragment>
        )
      )}
    </span>
  )
}

function RowView({ row, i, gutters, signs, toks }: { row: Row; i: number; gutters: 0 | 1 | 2; signs: boolean; toks: Tok[] | null }) {
  // A trailing \r is a Windows line ending: not drawn, the text itself is untouched.
  const text = row.text.replace(/\r$/, '')
  if (row.kind === 'miss')
    return (
      <div className="file-miss" data-testid="file-miss" data-row={i}>
        {row.text}
      </div>
    )
  if (row.kind !== 'ctx' && row.kind !== 'add' && row.kind !== 'del') {
    return (
      <div className="diff-row" data-testid="diff-row" data-kind={row.kind} data-row={i}>
        <span className="code">{text}</span>
      </div>
    )
  }
  return (
    <div className="diff-row" data-testid="diff-row" data-kind={row.kind} data-row={i}>
      {gutters === 2 && <span className="ln">{row.oldNo}</span>}
      {gutters > 0 && <span className="ln">{gutters === 2 ? row.newNo : (row.oldNo ?? row.newNo)}</span>}
      {signs && <span className="sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>}
      <Code text={text} toks={toks} />
    </div>
  )
}

/** The lines of a preview in their syntax colours, and the Quote / Explain menu over a selection in them. */
export function Lines({
  rows,
  status,
  shown,
  view,
  member,
  onQuote,
  onExplain,
  onComment,
  lang = null,
  full
}: {
  rows: Row[] | null
  status: 'loading' | 'failed'
  shown: string
  view: FileView
  member: string | undefined
  onQuote: Props['onQuote']
  onExplain: Props['onExplain']
  /** The Changes panel's review comment: the selected line range and its text. Absent elsewhere. */
  onComment?: (pick: { from: number; to: number; old: boolean; text: string }) => void
  /** highlight.js language (languageOf); null draws plain. */
  lang?: string | null
  /** The whole old and new texts, when the caller has them: colours then follow the whole file (see rowTokens). Memoize it. */
  full?: { old: string | null; new: string | null }
}) {
  const hl = useHighlighter(lang !== null)
  const toks = useMemo(() => (hl && lang !== null && rows ? rowTokens(rows, lang, hl, full) : null), [hl, lang, rows, full])
  const body = useRef<HTMLDivElement>(null)
  const [selection, clear] = useMessageSelection(body, ROWS)
  const [all, setAll] = useState(false)
  const numbered = rows?.some((r) => 'oldNo' in r && (r.oldNo !== null || r.newNo !== null)) ?? false
  const gutters = !numbered ? 0 : view === 'diff' ? 2 : 1
  const linesOf = (): ReturnType<typeof selectedLines> => {
    if (!selection || !rows || !selection.rows) return null
    return selectedLines(rows, selection.rows[0], selection.rows[1], view)
  }
  const done = (): void => {
    clear()
    window.getSelection()?.removeAllRanges()
  }
  const act = (send: (block: string) => void) => (): void => {
    if (!selection || !rows) return
    send(quoteBlock(shown, linesOf(), selection.text))
    done()
  }
  // A comment pins itself to a line range, so it is offered only where the rows carry line numbers.
  const comment = (): void => {
    const lines = linesOf()
    if (!selection || !onComment || !lines) return
    onComment({ from: lines.from, to: lines.to, old: lines.old, text: selection.text })
    done()
  }
  return (
    <div className="file-body" ref={body} data-testid="file-body">
      {rows === null ? (
        status === 'failed' ? (
          <div className="file-note error" role="alert">
            Couldn't load this file
          </div>
        ) : (
          <div className="file-note" role="status">
            <span className="spinner" aria-hidden="true" /> Loading…
          </div>
        )
      ) : (
        <div className={`file-rows${view === 'diff' ? ' diff' : ''}`} data-testid="file-rows">
          {(all ? rows : rows.slice(0, ROW_CAP)).map((r, i) => (
            <RowView key={i} row={r} i={i} gutters={gutters} signs={view === 'diff'} toks={toks?.[i] ?? null} />
          ))}
          {!all && rows.length > ROW_CAP && (
            <button type="button" className="btn small file-all" data-testid="file-show-all" onClick={() => setAll(true)}>
              Show all {rows.length} lines
            </button>
          )}
        </div>
      )}
      {selection && rows && (
        <SelectionMenu
          selection={selection}
          onQuote={act(onQuote)}
          {...(onExplain ? { onExplain: act((b) => onExplain(b, member)) } : {})}
          {...(onComment && numbered && selection.rows ? { onComment: comment } : {})}
        />
      )}
    </div>
  )
}

export function CopyButton({ text, disabled }: { text: () => Promise<string>; disabled: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn small"
      data-testid="file-copy"
      disabled={disabled}
      onClick={() => {
        text()
          .then((t) => navigator.clipboard.writeText(t))
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {}) // the clipboard can be denied; the button just stays as it was
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** Puts the file on disk back as it was before the picked change(s), after a confirm. The server checks the disk first. */
function RestoreControl({ chatId, path, button }: { chatId: string; path: string; button: RestoreButton }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null)
  const run = (): void => {
    setBusy(true)
    setSaid(null)
    api.files
      .restore(chatId, path, button.fromId, button.toId)
      .then(
        (r) => setSaid({ text: restoredText(r.done), error: false }),
        (err: unknown) => setSaid({ text: err instanceof Error ? err.message : String(err), error: true })
      )
      .finally(() => setBusy(false))
  }
  return (
    <>
      <button
        type="button"
        className="btn small"
        data-testid="file-restore"
        disabled={busy || button.disabled !== null}
        data-tip={button.disabled ?? undefined}
        onClick={() => setAsking(true)}
      >
        {button.label}
      </button>
      {said && (
        <span
          className={said.error ? 'file-restore-note error' : 'file-restore-note'}
          data-testid="file-restore-note"
          role={said.error ? 'alert' : 'status'}
        >
          {said.text}
        </span>
      )}
      {asking && (
        <ConfirmDialog
          title={`${button.label}?`}
          message={`${button.confirm} This happens only if the file is still exactly as the change left it.`}
          buttons={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Restore', value: 'restore', danger: true }
          ]}
          onResolve={(v) => {
            setAsking(false)
            if (v === 'restore') run()
          }}
        />
      )}
    </>
  )
}

function ShowButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="file-show" data-testid="file-show" onClick={onClick}>
      Show in chat ↗
    </button>
  )
}

function ChangedPreview({ chat, file, onShow, onQuote, onExplain }: Omit<Props, 'target'> & { file: ChangedFile }) {
  const [view, setView] = useState<FileView>('diff')
  const [pick, setPick] = useState<StepPick>('all')
  const { changes } = file
  // A step that is gone after a refresh falls back to all changes.
  const p: StepPick = pick !== 'all' && pick >= changes.length ? 'all' : pick
  const step = p === 'all' ? changes[changes.length - 1] : changes[p]
  const whoOf = (i: number): string => whoLabel({ ...changes[i], agent: changes[i].agent ?? chat.agentName }, displayName)
  const label = (i: number): string => stepLabel(changes[i], i, whoOf(i), timeOf(changes[i].ts))
  const sides = sidesOf(file, p)
  const source = view === 'diff' ? diffSource(file, p, label) : null
  const urls = [...new Set(neededIds(view, source, sides).map((id) => snapshotUrl(chat.id, id)))]
  const { ready, failed } = useLoadedTexts(urls)
  // The same file after a refresh is the same rows: the signature stands for its changes.
  const signature = changes.map((c) => c.id).join(' ')
  const rows = useMemo(() => {
    if (!ready) return null
    const textOf = (id: string): string | undefined => cachedText(snapshotUrl(chat.id, id))
    return source ? diffRows(source, textOf) : viewRows(view === 'old' ? sides.before : sides.after, view as 'old' | 'new', textOf)
  }, [chat.id, file.path, signature, view, p, ready])
  const side: Side = view === 'old' ? sides.before : sides.after // Copy and Download: Old is the old file, the rest the new one
  const name = splitPath(file.path).name
  const agents = [...new Set(changes.map((c) => displayName(c.agent ?? chat.agentName)))]
  const n = changes.length
  const restore = restoreButton(file, p, chat.inFlight)
  return (
    <>
      <div className="file-toolbar">
        <div className="seg" role="group" aria-label="View">
          {(['diff', 'old', 'new'] as const).map((v) => (
            <button key={v} type="button" data-testid={`file-view-${v}`} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'diff' ? 'Diff' : v === 'old' ? 'Old' : 'New'}
            </button>
          ))}
        </div>
        <SearchSelect
          className="file-step"
          data-testid="file-step"
          aria-label="Change"
          value={p === 'all' ? 'all' : String(p)}
          onChange={(v) => setPick(v === 'all' ? 'all' : Number(v))}
        >
          <option value="all">All changes (start → now)</option>
          {changes.map((c, i) => (
            <option key={`${c.id}:${i}`} value={String(i)}>
              {label(i)}
            </option>
          ))}
        </SearchSelect>
        <div className="file-actions">
          <CopyButton
            disabled={!('id' in side || 'text' in side)}
            text={() =>
              'text' in side
                ? Promise.resolve(side.text)
                : 'id' in side
                  ? loadText(snapshotUrl(chat.id, side.id))
                  : Promise.reject(new Error('not kept'))
            }
          />
          {'id' in side ? (
            <a
              className="btn small"
              data-testid="file-download"
              href={`${snapshotUrl(chat.id, side.id)}?download=${encodeURIComponent(name)}`}
              download={name}
            >
              Download
            </a>
          ) : (
            <button
              type="button"
              className="btn small"
              data-testid="file-download"
              disabled={!('text' in side)}
              onClick={() => 'text' in side && saveText(name, side.text)}
            >
              Download
            </button>
          )}
        </div>
      </div>
      <div className="file-meta">
        <span className="file-meta-path" data-tip={file.path}>
          {file.shown}
        </span>
        <span className="file-meta-who">
          {agents.join(', ')} · {n} {n === 1 ? 'change' : 'changes'}
        </span>
        <ShowButton onClick={() => onShow(step.itemId)} />
      </div>
      {restore && (
        <div className="file-restore">
          {/* Keyed by the range, so a note from another pick never shows under this one. */}
          <RestoreControl key={`${restore.fromId}>${restore.toId}`} chatId={chat.id} path={file.path} button={restore} />
        </div>
      )}
      <Lines
        key={`${view}:${p}`}
        rows={rows}
        status={failed ? 'failed' : 'loading'}
        shown={file.shown}
        view={view}
        member={chat.group ? step.agent : undefined}
        onQuote={onQuote}
        onExplain={onExplain}
        lang={languageOf(file.path)}
      />
    </>
  )
}

function AttachedPreview({ chat, item, onShow, onQuote, onExplain }: Omit<Props, 'target'> & { item: AttachedFile }) {
  const a = item.attachment
  const url = attachmentUrl(chat.id, a.id)
  const image = isThumbnail(a)
  const text = isTextAttachment(a)
  const { ready, failed } = useLoadedTexts(text ? [url] : [])
  const rows = useMemo(() => (text && ready ? viewRows({ text: cachedText(url) ?? '' }, 'new', () => undefined) : null), [url, text, ready])
  const [gone, setGone] = useState(false)
  return (
    <>
      <div className="file-toolbar">
        <div className="file-actions">
          {text && <CopyButton disabled={!ready} text={() => loadText(url)} />}
          <a className="btn small" data-testid="file-download" href={`${url}?download=1`} download={a.name}>
            Download
          </a>
        </div>
      </div>
      <div className="file-meta">
        <span className="file-meta-path" data-tip={a.name}>
          {a.name}
        </span>
        <span className="file-meta-who">{formatSize(a.size)}</span>
        <ShowButton onClick={() => onShow(item.itemId)} />
      </div>
      {text ? (
        <Lines
          rows={rows}
          status={failed ? 'failed' : 'loading'}
          shown={a.name}
          view="new"
          member={undefined}
          onQuote={onQuote}
          onExplain={onExplain}
          lang={languageOf(a.name)}
        />
      ) : image ? (
        <div className="file-body" data-testid="file-body">
          {gone ? (
            <div className="file-note error">File missing</div>
          ) : (
            <img className="file-image" data-testid="file-image" src={url} alt={a.name} onError={() => setGone(true)} />
          )}
        </div>
      ) : (
        <div className="file-body" data-testid="file-body">
          <div className="file-note">
            No preview for this type of file.{' '}
            <button
              type="button"
              className="btn small"
              data-testid="file-open"
              onClick={() => void api.attachments.open(chat.id, a.id, a.name).then((ok) => setGone(!ok))}
            >
              Open
            </button>
            {gone && <span className="error"> File missing</span>}
          </div>
        </div>
      )}
    </>
  )
}

/** The panel's lower half: the picked file's view, or the picked attachment. The panel keys it by the pick, so each file starts at its diff. */
export function FilePreview({ target, ...rest }: Props) {
  return (
    <section className="file-preview" data-testid="file-preview" aria-label="File preview">
      {'changed' in target ? <ChangedPreview {...rest} file={target.changed} /> : <AttachedPreview {...rest} item={target.attached} />}
    </section>
  )
}
