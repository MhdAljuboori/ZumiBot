import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

const MAX_SUGGESTIONS = 5

export type MenuParams = Pick<ContextMenuParams, 'misspelledWord' | 'dictionarySuggestions' | 'isEditable' | 'selectionText' | 'editFlags'>

// Electron shows no context menu of its own (Chrome builds its menu, spelling fixes included, outside the page),
// so the shell builds one from what was right-clicked. Empty = show nothing, as before.
export function contextMenuTemplate(
  p: MenuParams,
  a: { replace(word: string): void; learn(word: string): void }
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)) items.push({ label: s, click: () => a.replace(s) })
    if (!p.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false })
    items.push({ label: 'Add to dictionary', click: () => a.learn(p.misspelledWord) }, { type: 'separator' })
  }
  if (p.isEditable) {
    items.push(
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: p.editFlags.canSelectAll }
    )
  } else if (p.selectionText.trim()) {
    items.push({ role: 'copy' })
  }
  return items
}
