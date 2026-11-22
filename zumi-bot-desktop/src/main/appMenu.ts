import type { MenuItemConstructorOptions } from 'electron'

/**
 * The macOS menu bar. A Mac has no menu-less window: with no application menu the Edit roles are gone too, so Cmd+C,
 * Cmd+V, Cmd+X, Cmd+A and Cmd+Z did nothing in the message box, and Cmd+Q and Cmd+H with them. Like the other systems'
 * menu-less window it has no Reload (it would drop unsaved editor edits) and no DevTools. Cmd+W closes the window, which
 * only hides it (the app lives in the menu bar).
 */
export function macMenuTemplate(a: { appName: string; quit(): void }): MenuItemConstructorOptions[] {
  return [
    {
      label: a.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // Not role 'quit': the tray's Quit runs the same close checks (unsaved edits, running replies).
        { label: `Quit ${a.appName}`, accelerator: 'Command+Q', click: a.quit }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }]
    }
  ]
}
