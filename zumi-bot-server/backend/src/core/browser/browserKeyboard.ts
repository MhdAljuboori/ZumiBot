import type { BrowserInput } from './types'

const codes: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PrintScreen: 44,
  Insert: 45,
  Delete: 46,
  ContextMenu: 93,
  NumLock: 144,
  ScrollLock: 145,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  MetaLeft: 91,
  MetaRight: 92,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
  NumpadEnter: 13,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111
}
export function browserKeyEvent(input: Extract<BrowserInput, { type: 'keyDown' | 'keyUp' }>) {
  let keyCode = codes[input.code] ?? 0
  if (/^Key[A-Z]$/.test(input.code)) keyCode = input.code.charCodeAt(3)
  if (/^Digit[0-9]$/.test(input.code)) keyCode = input.code.charCodeAt(5)
  if (/^Numpad[0-9]$/.test(input.code)) keyCode = 96 + Number(input.code.slice(6))
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(input.code)) keyCode = 111 + Number(input.code.slice(1))
  const bits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
  // Printable/composed text arrives exactly once through Input.insertText.
  return {
    type: input.type === 'keyDown' ? ('rawKeyDown' as const) : ('keyUp' as const),
    key: input.key,
    code: input.code,
    windowsVirtualKeyCode: keyCode,
    modifiers: (input.modifiers ?? []).reduce((n, m) => n | bits[m], 0),
    isKeypad: input.code.startsWith('Numpad')
  }
}
