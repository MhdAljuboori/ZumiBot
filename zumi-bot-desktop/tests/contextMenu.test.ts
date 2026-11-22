import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { contextMenuTemplate, type MenuParams } from '../src/main/contextMenu'

const flags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: true,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: true
}

const params = (o: Partial<MenuParams> = {}): MenuParams => ({
  misspelledWord: '',
  dictionarySuggestions: [],
  isEditable: false,
  selectionText: '',
  editFlags: flags,
  ...o
})

function setup() {
  const replaced: string[] = []
  const learned: string[] = []
  const actions = { replace: (w: string) => replaced.push(w), learn: (w: string) => learned.push(w) }
  return { replaced, learned, actions }
}

const click = (item: MenuItemConstructorOptions): void => (item.click as () => void)()
const shape = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? i.role ?? i.type)

describe('contextMenuTemplate', () => {
  it('offers the suggestions for a misspelled word, each replacing it', () => {
    const { replaced, actions } = setup()
    const items = contextMenuTemplate(params({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] }), actions)
    expect(shape(items)).toEqual(['the', 'tech', 'Add to dictionary', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
    click(items[1])
    expect(replaced).toEqual(['tech'])
  })

  it('caps the suggestions at five', () => {
    const { actions } = setup()
    const items = contextMenuTemplate(
      params({ isEditable: true, misspelledWord: 'x', dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      actions
    )
    expect(shape(items).slice(0, 6)).toEqual(['a', 'b', 'c', 'd', 'e', 'Add to dictionary'])
  })

  it('says so when there are no suggestions, and still offers the dictionary', () => {
    const { learned, actions } = setup()
    const items = contextMenuTemplate(params({ isEditable: true, misspelledWord: 'qzxv' }), actions)
    expect(items[0]).toMatchObject({ label: 'No suggestions', enabled: false })
    click(items[1])
    expect(learned).toEqual(['qzxv'])
  })

  it('edit actions follow the edit flags', () => {
    const { actions } = setup()
    const items = contextMenuTemplate(
      params({ isEditable: true, editFlags: { ...flags, canCut: true, canCopy: true, canPaste: false } }),
      actions
    )
    expect(items.map((i) => [i.role ?? i.type, i.enabled])).toEqual([
      ['cut', true],
      ['copy', true],
      ['paste', false],
      ['separator', undefined],
      ['selectAll', true]
    ])
  })

  it('selected page text gets copy only', () => {
    const { actions } = setup()
    expect(shape(contextMenuTemplate(params({ selectionText: 'hello' }), actions))).toEqual(['copy'])
  })

  it('nothing to offer gives an empty menu', () => {
    const { actions } = setup()
    expect(contextMenuTemplate(params(), actions)).toEqual([])
    expect(contextMenuTemplate(params({ selectionText: '  \n' }), actions)).toEqual([])
  })
})
