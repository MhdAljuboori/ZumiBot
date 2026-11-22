import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  dialogKeyAction,
  folderPickerReducer,
  initialPicker,
  joinPath,
  listKeyIndex,
  nextTrapIndex,
  tabbableIndex,
  visibleDirs,
  type PickerState
} from '../src/net/folderPicker'
import { FolderList, FolderPicker } from '../src/components/FolderPicker'

const listing = (path: string, parent: string | null, dirs: string[]) => ({ type: 'loaded' as const, listing: { path, parent, dirs } })
const at = (path: string, parent: string | null, dirs: string[] = []): PickerState =>
  folderPickerReducer(initialPicker(path), listing(path, parent, dirs))

describe('folderPickerReducer', () => {
  it('navigating into a dir sets path and clears selection', () => {
    let s = at('/home/me', '/home', ['a', 'b'])
    s = folderPickerReducer(s, { type: 'select', name: 'a' })
    expect(s.selected).toBe('a')
    s = folderPickerReducer(s, { type: 'navigate', path: '/home/me/a' })
    expect(s.path).toBe('/home/me/a')
    expect(s.selected).toBeNull()
    expect(s.loading).toBe(true)
  })

  it('Up from / is disabled', () => {
    const s = at('/', null, ['usr'])
    expect(s.parent).toBeNull()
    expect(folderPickerReducer(s, { type: 'up' })).toBe(s)
    const sub = at('/usr', '/')
    expect(folderPickerReducer(sub, { type: 'up' }).path).toBe('/')
  })

  it('hidden folders filtered unless showHidden', () => {
    let s = at('/h', '/', ['.git', 'src', '.cache', 'docs'])
    expect(visibleDirs(s)).toEqual(['src', 'docs'])
    s = folderPickerReducer(s, { type: 'toggleHidden' })
    expect(visibleDirs(s)).toEqual(['.git', 'src', '.cache', 'docs'])
  })

  it('New folder with "a/b" shows the server error inline', () => {
    let s = at('/h', '/')
    s = folderPickerReducer(s, { type: 'newStart' })
    s = folderPickerReducer(s, { type: 'newName', name: 'a/b' })
    s = folderPickerReducer(s, { type: 'newFailed', error: 'Folder name cannot contain /' })
    expect(s.creating).toBe(true)
    expect(s.newError).toBe('Folder name cannot contain /')
    expect(folderPickerReducer(s, { type: 'newName', name: 'ab' }).newError).toBeNull()
  })

  it('Use this folder resolves current path', () => {
    const s = folderPickerReducer(at('/h/work', '/h'), { type: 'use' })
    expect(s.result).toBe('/h/work')
  })

  it('Use this folder resolves the selected folder when one is selected', () => {
    let s = at('/h/work', '/h', ['a', 'b'])
    s = folderPickerReducer(s, { type: 'select', name: 'b' })
    expect(folderPickerReducer(s, { type: 'use' }).result).toBe('/h/work/b')
    expect(folderPickerReducer(at('/', null, ['usr']), { type: 'use' }).result).toBe('/')
    s = folderPickerReducer(at('/', null, ['usr']), { type: 'select', name: 'usr' })
    expect(folderPickerReducer(s, { type: 'use' }).result).toBe('/usr')
  })

  it('failed initial listing falls back to the home listing and keeps the error', () => {
    let s = initialPicker('/stale')
    expect(s.loaded).toBe(false)
    s = folderPickerReducer(s, { type: 'loadedFallback', listing: { path: '/home/me', parent: '/home', dirs: ['x'] }, error: 'ENOENT' })
    expect(s.path).toBe('/home/me')
    expect(s.parent).toBe('/home')
    expect(s.dirs).toEqual(['x'])
    expect(s.error).toBe('ENOENT')
    expect(s.loading).toBe(false)
    expect(s.loaded).toBe(true)
    expect(folderPickerReducer(s, { type: 'up' }).path).toBe('/home')
    expect(folderPickerReducer(at('/h', '/'), { type: 'loadFailed', error: 'x' }).loaded).toBe(true)
  })
})

describe('joinPath', () => {
  it('joins onto / and onto a normal folder', () => {
    expect(joinPath('/', 'a')).toBe('/a')
    expect(joinPath('/h', 'a')).toBe('/h/a')
  })
})

describe('listKeyIndex (roving list)', () => {
  it('arrows move and clamp, Home/End jump, others ignored', () => {
    expect(listKeyIndex('ArrowDown', 0, 3)).toBe(1)
    expect(listKeyIndex('ArrowDown', 2, 3)).toBe(2)
    expect(listKeyIndex('ArrowUp', 1, 3)).toBe(0)
    expect(listKeyIndex('ArrowUp', 0, 3)).toBe(0)
    expect(listKeyIndex('Home', 2, 3)).toBe(0)
    expect(listKeyIndex('End', 0, 3)).toBe(2)
    expect(listKeyIndex('a', 0, 3)).toBeNull()
    expect(listKeyIndex('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('tabbableIndex', () => {
  it('is the selected item, else the first, else -1', () => {
    expect(tabbableIndex(['a', 'b', 'c'], 'b')).toBe(1)
    expect(tabbableIndex(['a', 'b', 'c'], null)).toBe(0)
    expect(tabbableIndex(['a', 'b'], 'gone')).toBe(0)
    expect(tabbableIndex([], null)).toBe(-1)
  })
})

describe('nextTrapIndex (focus trap)', () => {
  it('wraps at both ends and enters from outside', () => {
    expect(nextTrapIndex(4, 3, false)).toBe(0)
    expect(nextTrapIndex(4, 0, true)).toBe(3)
    expect(nextTrapIndex(4, 1, false)).toBeNull() // browser moves focus inside on its own
    expect(nextTrapIndex(4, 2, true)).toBeNull()
    expect(nextTrapIndex(4, -1, false)).toBe(0)
    expect(nextTrapIndex(4, -1, true)).toBe(3)
    expect(nextTrapIndex(0, -1, false)).toBeNull()
  })
})

describe('dialogKeyAction', () => {
  it('Esc cancels the new-folder input first, then closes', () => {
    expect(dialogKeyAction('Escape', true, 'input')).toEqual({ type: 'newCancel' })
    expect(dialogKeyAction('Escape', false, 'input')).toBe('close')
    expect(dialogKeyAction('Escape', false, 'other')).toBe('close')
  })
  it('Enter uses the folder only from non-interactive focus', () => {
    expect(dialogKeyAction('Enter', false, 'other')).toEqual({ type: 'use' })
    expect(dialogKeyAction('Enter', false, 'button')).toBeNull()
    expect(dialogKeyAction('Enter', true, 'input')).toBeNull()
    expect(dialogKeyAction('Enter', false, 'option')).toBeNull()
    expect(dialogKeyAction('x', false, 'other')).toBeNull()
  })
})

describe('FolderPicker markup', () => {
  const html = renderToStaticMarkup(
    createElement(FolderPicker, {
      start: '/h',
      list: async () => ({ path: '/h', parent: '/', dirs: [] }),
      makeDir: async () => '',
      onResolve: () => {}
    })
  )
  it('is a modal dialog the focus can land on, with the test ids kept', () => {
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('tabindex="-1"')
    for (const id of [
      'folder-picker',
      'folder-picker-path',
      'folder-picker-up',
      'folder-picker-hidden',
      'folder-picker-new',
      'folder-picker-use',
      'folder-picker-cancel'
    ])
      expect(html).toContain(`data-testid="${id}"`)
  })
})

describe('FolderList markup (roving tabindex)', () => {
  const render = (selected: string | null) =>
    renderToStaticMarkup(createElement(FolderList, { dirs: ['a', 'b', 'c'], selected, onSelect: () => {}, onOpen: () => {} }))
  const count = (html: string, s: string) => html.split(s).length - 1

  it('has exactly one tabbable item: the first with no selection', () => {
    const html = render(null)
    expect(count(html, 'tabindex="0"')).toBe(1)
    expect(count(html, 'tabindex="-1"')).toBe(2)
    expect(html).toMatch(/tabindex="0"[^>]*data-name="a"/)
  })
  it('moves the tabbable item to the selected one and sets aria-selected', () => {
    const html = render('b')
    expect(count(html, 'tabindex="0"')).toBe(1)
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*data-name="b"/)
    expect(count(html, 'aria-selected="true"')).toBe(1)
    expect(html).toContain('role="listbox"')
  })
})
