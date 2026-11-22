import { useEffect, useReducer, useRef } from 'react'
import type { DirListing } from '@zumibot/shared/types'
import { errorMessage } from '../errors'
import {
  crumbs,
  dialogKeyAction,
  folderPickerReducer,
  initialPicker,
  joinPath,
  listKeyIndex,
  nextTrapIndex,
  tabbableIndex,
  visibleDirs,
  type FocusKind
} from '../net/folderPicker'
import { FolderIcon } from './FolderIcon'

interface Props {
  start: string
  list: (path: string | null) => Promise<DirListing>
  makeDir: (parent: string, name: string) => Promise<string>
  onResolve: (path: string | null) => void
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex="0"]'

const focusKind = (el: EventTarget | null): FocusKind => {
  if (!(el instanceof HTMLElement)) return 'other'
  if (el.closest('input')) return 'input'
  if (el.closest('button')) return 'button'
  return el.getAttribute('role') === 'option' ? 'option' : 'other'
}

interface ListProps {
  dirs: string[]
  selected: string | null
  onSelect: (name: string) => void
  onOpen: (name: string) => void
  /** Rendered after the items (the empty-state row). */
  children?: React.ReactNode
}

/** The folder listbox with a roving tabindex: one tabbable item, arrows move the selection, Space selects, Enter opens. */
export function FolderList({ dirs, selected, onSelect, onOpen, children }: ListProps) {
  const tabbable = tabbableIndex(dirs, selected)
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>, i: number): void => {
    const to = listKeyIndex(e.key, i, dirs.length)
    if (to !== null) {
      e.preventDefault()
      onSelect(dirs[to])
      e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="option"]')[to]?.focus()
    } else if (e.key === ' ') {
      e.preventDefault()
      onSelect(dirs[i])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onOpen(dirs[i])
    }
  }
  return (
    <ul className="folder-picker-list" role="listbox" aria-label="Folders">
      {dirs.map((name, i) => (
        <li
          key={name}
          role="option"
          aria-selected={selected === name}
          tabIndex={i === tabbable ? 0 : -1}
          className={selected === name ? 'folder-picker-item selected' : 'folder-picker-item'}
          data-testid="folder-picker-item"
          data-name={name}
          onClick={() => onSelect(name)}
          onDoubleClick={() => onOpen(name)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <FolderIcon />
          <span>{name}</span>
        </li>
      ))}
      {children}
    </ul>
  )
}

/** The server's folders, browsed in the ConfirmDialog's frame (a browser cannot show the server's native folder dialog). */
export function FolderPicker({ start, list, makeDir, onResolve }: Props) {
  const [s, dispatch] = useReducer(folderPickerReducer, start, initialPicker)
  const target = useRef(start) // what the latest navigation asked for, so a slow older listing cannot overwrite it

  useEffect(() => {
    target.current = s.path
    if (!s.loading) return
    let live = true
    list(s.path).then(
      (listing) => live && target.current === s.path && dispatch({ type: 'loaded', listing }),
      (e) => {
        if (!live) return
        const error = errorMessage(e)
        if (s.loaded) return dispatch({ type: 'loadFailed', error })
        // The start folder is gone (stale last folder): open home so Up/Use are not a dead end, and still show why
        list(null).then(
          (listing) => live && dispatch({ type: 'loadedFallback', listing, error }),
          () => live && dispatch({ type: 'loadFailed', error })
        )
      }
    )
    return () => {
      live = false
    }
  }, [s.path, s.loading, s.loaded, list])

  useEffect(() => {
    if (s.result !== null) onResolve(s.result)
  }, [s.result, onResolve])

  const dialog = useRef<HTMLDivElement>(null)
  const live = useRef({ creating: s.creating })
  live.current = { creating: s.creating }

  useEffect(() => {
    dialog.current?.focus() // like ConfirmDialog's autofocus; the dialog itself so Enter works before the list has loaded
  }, [])

  useEffect(() => {
    // Keyboard lost with a removed list item (after navigating) lands on the body: bring it back into the dialog
    if (s.loading || document.activeElement !== document.body) return
    dialog.current?.focus()
  }, [s.loading, s.path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab') {
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        const to = nextTrapIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey)
        if (to !== null) {
          e.preventDefault()
          items[to].focus()
        }
        return
      }
      const action = dialogKeyAction(e.key, live.current.creating, focusKind(e.target))
      if (action === 'close') onResolve(null)
      else if (action) {
        e.preventDefault()
        dispatch(action)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResolve])

  const create = async (): Promise<void> => {
    const name = s.newName.trim()
    if (!name) return
    try {
      dispatch({ type: 'navigate', path: await makeDir(s.path, name) })
    } catch (e) {
      dispatch({ type: 'newFailed', error: errorMessage(e) })
    }
  }

  const dirs = visibleDirs(s)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onResolve(null)}>
      <div
        ref={dialog}
        tabIndex={-1}
        className="modal folder-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-picker-title"
        data-testid="folder-picker"
      >
        <h2 id="folder-picker-title" className="modal-title">
          Choose a folder
        </h2>
        <div className="folder-picker-bar">
          <button
            type="button"
            className="btn small"
            data-testid="folder-picker-up"
            disabled={s.parent === null}
            onClick={() => dispatch({ type: 'up' })}
          >
            Up
          </button>
          <nav className="folder-picker-path" data-testid="folder-picker-path" data-path={s.path} aria-label="Current folder">
            {crumbs(s.path).map((c) => (
              <button
                key={c.path}
                type="button"
                className="folder-picker-crumb"
                onClick={() => dispatch({ type: 'navigate', path: c.path })}
              >
                {c.name}
              </button>
            ))}
          </nav>
        </div>
        <FolderList
          dirs={dirs}
          selected={s.selected}
          onSelect={(name) => dispatch({ type: 'select', name })}
          onOpen={(name) => dispatch({ type: 'navigate', path: joinPath(s.path, name) })}
        >
          {!s.loading && s.error === null && dirs.length === 0 && <li className="folder-picker-empty">No folders here</li>}
        </FolderList>
        {s.error !== null && (
          <p className="folder-picker-error" role="alert">
            {s.error}
          </p>
        )}
        {s.creating && (
          <form
            className="folder-picker-new"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <input
              className="field"
              autoFocus
              value={s.newName}
              placeholder="Folder name"
              aria-label="New folder name"
              data-testid="folder-picker-new-name"
              onChange={(e) => dispatch({ type: 'newName', name: e.target.value })}
            />
            <button type="submit" className="btn small" data-testid="folder-picker-create">
              Create
            </button>
            <button type="button" className="btn small" onClick={() => dispatch({ type: 'newCancel' })}>
              Cancel
            </button>
          </form>
        )}
        {s.newError !== null && (
          <p className="folder-picker-error" role="alert" data-testid="folder-picker-new-error">
            {s.newError}
          </p>
        )}
        <label className="folder-picker-hidden">
          <input
            type="checkbox"
            checked={s.showHidden}
            data-testid="folder-picker-hidden"
            onChange={() => dispatch({ type: 'toggleHidden' })}
          />
          Show hidden
        </label>
        <div className="modal-buttons">
          <button
            type="button"
            className="btn"
            data-testid="folder-picker-new"
            disabled={s.creating}
            onClick={() => dispatch({ type: 'newStart' })}
          >
            New folder
          </button>
          <span className="modal-spacer" />
          <button type="button" className="btn" data-testid="folder-picker-cancel" onClick={() => onResolve(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="folder-picker-use"
            disabled={s.loading || s.error !== null}
            onClick={() => dispatch({ type: 'use' })}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  )
}
