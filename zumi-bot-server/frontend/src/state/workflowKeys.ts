// What a key does on the workflow canvas, as a pure rule so it is testable without a DOM. The editor switches on the
// answer; each action is wired where the feature it belongs to lives.

export type CanvasKey =
  | 'save'
  | 'selectAll'
  | 'delete'
  | 'clear'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'fit'
  | 'addNote'
  | 'addStep'
  | 'duplicate'
  | 'undo'
  | 'redo'
  | 'group'
  | 'ungroup'
  | 'expand'
  | 'collapse'
  | 'next'
  | 'prev'
  | 'up'
  | 'down'
  | 'allNext'
  | 'allPrev'
  | 'rename'
  | 'open'
  | 'panMode'
  | 'run'

export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const ARROWS: Record<string, [CanvasKey, CanvasKey]> = {
  ArrowRight: ['next', 'allNext'],
  ArrowLeft: ['prev', 'allPrev'],
  ArrowUp: ['up', 'up'],
  ArrowDown: ['down', 'down']
}

/**
 * Ctrl or Cmd+S saves from anywhere, even in a field. Every other key is the canvas's only when the user is not typing
 * (a Backspace in a prompt must not delete the step). Group keys match `code`, not `key`: Alt+G types © on a Mac.
 * Delete, Esc, F2 and Enter need something selected; a plain arrow may run with none, to pick the trigger.
 */
export function canvasKey(e: KeyLike, typing: boolean, hasSelection: boolean): CanvasKey | null {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (mod && !e.altKey && key === 's') return 'save'
  if (typing) return null

  if (e.code === 'KeyG') {
    if (mod && !e.altKey) return e.shiftKey ? 'ungroup' : 'group'
    if (e.altKey && !mod) return e.shiftKey ? 'collapse' : 'expand'
    return null
  }
  if (mod) {
    if (e.altKey) return null
    if (key === 'a') return 'selectAll'
    if (key === 'd') return 'duplicate'
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (key === 'y') return 'redo'
    if (e.key === 'Enter') return 'run'
    return null
  }
  if (e.altKey) return null

  const arrow = ARROWS[e.key]
  if (arrow) return e.shiftKey ? arrow[1] : arrow[0]
  if (e.shiftKey && key === 's') return 'addNote'
  // '+' and '_' are Shift characters on most keyboards, so Shift is no bar for the zoom keys.
  switch (e.key) {
    case '+':
    case '=':
      return 'zoomIn'
    case '-':
    case '_':
      return 'zoomOut'
    case '0':
      return 'zoomReset'
    case '1':
      return 'fit'
    case 'n':
      return 'addStep'
    case 'h':
      return 'panMode'
  }
  if (!hasSelection) return null
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete'
  if (e.key === 'Escape') return 'clear'
  if (e.key === 'F2') return 'rename'
  if (e.key === 'Enter') return 'open'
  return null
}
