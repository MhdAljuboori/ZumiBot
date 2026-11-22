import type { MenuItemConstructorOptions } from 'electron'

export function trayMenuTemplate(a: { open(): void; quit(): void }): MenuItemConstructorOptions[] {
  return [{ label: 'Open', click: a.open }, { type: 'separator' }, { label: 'Quit', click: a.quit }]
}
