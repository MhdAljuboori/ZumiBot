import type { MenuItemConstructorOptions } from 'electron'

export function trayMenuTemplate(a: { open(): void; sponsor(): void; quit(): void }): MenuItemConstructorOptions[] {
  return [{ label: 'Open', click: a.open }, { label: 'Sponsor ZumiBot', click: a.sponsor }, { type: 'separator' }, { label: 'Quit', click: a.quit }]
}
