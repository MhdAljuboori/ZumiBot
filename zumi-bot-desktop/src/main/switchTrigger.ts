export const SWITCH_SERVER_FLAG = '--switch-server'

interface KeyInput {
  type: string
  key: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  isAutoRepeat?: boolean
}

/** Ctrl+Shift+S (Cmd+Shift+S on a Mac): the way back to the picker when the connected site is not ZumiBot and has no "Switch server…". */
export function isSwitchShortcut(i: KeyInput, mac = false): boolean {
  const mod = mac ? i.meta && !i.control : i.control && !i.meta
  return i.type === 'keyDown' && !i.isAutoRepeat && mod && i.shift && !i.alt && i.key.toLowerCase() === 's'
}

/** `zumibot --switch-server`, at startup or from a second launch. */
export function wantsSwitchServer(argv: readonly string[]): boolean {
  return argv.includes(SWITCH_SERVER_FLAG)
}
