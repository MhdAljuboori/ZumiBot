import type { DirListing } from '@zumibot/shared/types'

export interface PickerState {
  path: string
  parent: string | null
  dirs: string[]
  selected: string | null
  showHidden: boolean
  loading: boolean
  loaded: boolean // a listing has arrived at least once (a failure before that falls back to home)
  error: string | null
  creating: boolean
  newName: string
  newError: string | null
  result: string | null // set by 'use': the folder chosen
}

export type PickerAction =
  | { type: 'navigate'; path: string }
  | { type: 'up' }
  | { type: 'loaded'; listing: DirListing }
  | { type: 'loadFailed'; error: string }
  | { type: 'loadedFallback'; listing: DirListing; error: string }
  | { type: 'select'; name: string }
  | { type: 'toggleHidden' }
  | { type: 'newStart' }
  | { type: 'newCancel' }
  | { type: 'newName'; name: string }
  | { type: 'newFailed'; error: string }
  | { type: 'use' }

export const initialPicker = (path: string): PickerState => ({
  path,
  parent: null,
  dirs: [],
  selected: null,
  showHidden: false,
  loading: true,
  loaded: false,
  error: null,
  creating: false,
  newName: '',
  newError: null,
  result: null
})

const go = (s: PickerState, path: string): PickerState => ({
  ...s,
  path,
  selected: null,
  loading: true,
  error: null,
  creating: false,
  newName: '',
  newError: null
})

export function folderPickerReducer(s: PickerState, a: PickerAction): PickerState {
  switch (a.type) {
    case 'navigate':
      return go(s, a.path)
    case 'up':
      return s.parent === null ? s : go(s, s.parent)
    case 'loaded':
      return {
        ...s,
        path: a.listing.path,
        parent: a.listing.parent,
        dirs: a.listing.dirs,
        selected: null,
        loading: false,
        loaded: true,
        error: null
      }
    case 'loadFailed':
      return { ...s, loading: false, loaded: true, error: a.error }
    case 'loadedFallback':
      return {
        ...s,
        path: a.listing.path,
        parent: a.listing.parent,
        dirs: a.listing.dirs,
        selected: null,
        loading: false,
        loaded: true,
        error: a.error
      }
    case 'select':
      return { ...s, selected: a.name }
    case 'toggleHidden':
      return { ...s, showHidden: !s.showHidden }
    case 'newStart':
      return { ...s, creating: true, newName: '', newError: null }
    case 'newCancel':
      return { ...s, creating: false, newName: '', newError: null }
    case 'newName':
      return { ...s, newName: a.name, newError: null }
    case 'newFailed':
      return { ...s, newError: a.error }
    case 'use':
      return s.loading || s.error !== null ? s : { ...s, result: s.selected === null ? s.path : joinPath(s.path, s.selected) } // the highlighted folder wins, like the native dialog
  }
}

export const visibleDirs = (s: PickerState): string[] => (s.showHidden ? s.dirs : s.dirs.filter((d) => !d.startsWith('.')))

/** Breadcrumb segments of an absolute path, each with the path it navigates to. */
export function crumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: '/', path: '/' }]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc += `/${part}`
    out.push({ name: part, path: acc })
  }
  return out
}

export const joinPath = (parent: string, name: string): string => (parent === '/' ? `/${name}` : `${parent}/${name}`)

/** Index the list's arrow/Home/End key moves to, or null when the key is not a list key. */
export function listKeyIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(current + 1, count - 1)
    case 'ArrowUp':
      return Math.max(current - 1, 0)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** The one list item that is in the Tab order (roving tabindex): the selected one, else the first. */
export function tabbableIndex(dirs: string[], selected: string | null): number {
  if (dirs.length === 0) return -1
  const i = selected === null ? -1 : dirs.indexOf(selected)
  return i === -1 ? 0 : i
}

/** Where Tab must jump to keep focus inside the dialog, or null to let the browser move it. current -1 = focus is outside. */
export function nextTrapIndex(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return null
  if (current === -1) return shift ? count - 1 : 0
  if (!shift && current === count - 1) return 0
  if (shift && current === 0) return count - 1
  return null
}

export type FocusKind = 'input' | 'button' | 'option' | 'other'

/** Dialog-wide keys: Esc cancels the new-folder input first and only then closes; Enter uses the folder from non-interactive focus. */
export function dialogKeyAction(key: string, creating: boolean, kind: FocusKind): PickerAction | 'close' | null {
  if (key === 'Escape') return creating ? { type: 'newCancel' } : 'close'
  if (key === 'Enter' && kind === 'other') return { type: 'use' }
  return null
}
