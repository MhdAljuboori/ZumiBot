/**
 * Fields that bring up a phone's keyboard. styles/phone.css hides the tab bar while one inside the main area has focus
 * (`.main:has(:is(<this list>):focus)`), so the two must match. A checkbox, button or slider takes focus on a tap but no
 * keyboard, so it leaves the bar where it is: hiding it would move what sits above it under the finger.
 */
export const TYPING_FIELD =
  "textarea, [contenteditable='true'], input:not([type='checkbox'], [type='radio'], [type='range'], [type='button'], [type='submit'], [type='reset'], [type='file'], [type='color'], [type='image'])"

/** On `<html>` from the moment a typing field loses focus until the tap or click that took it away is over. */
const HOLD = 'typing-hold'

/** A typing field in the main area: the kind whose focus hides the tab bar. */
export function isTypingField(target: EventTarget | null): boolean {
  const el = target as Partial<Pick<Element, 'matches' | 'closest'>> | null
  return typeof el?.matches === 'function' && typeof el.closest === 'function' && el.matches(TYPING_FIELD) && el.closest('.main') !== null
}

/**
 * Keeps the phone's tab bar hidden after typing ends until the press that ended it is over. A tap on Send blurs the box
 * on its mousedown; the bar coming back right then pushes Send up by the bar's height before the mouseup, which lands
 * on the row below, so the click goes to the box around both (Chrome hit-tests again after mousedown): the keyboard
 * closed and nothing was sent. Every control above the bar moved the same way.
 * A touch's mouse events all come after its pointerup, in one task, so the next task is after its click. A mouse's
 * button is still down at its mousedown, so that waits for the pointerup first.
 */
export function holdTypingLayout(
  doc: EventTarget = document,
  root: Pick<HTMLElement, 'classList'> = document.documentElement,
  nextTask: (f: () => void) => void = (f) => void setTimeout(f, 0)
): () => void {
  let pressed = false
  let held = false
  const release = (): void =>
    nextTask(() => {
      // A press that began meanwhile lets go on its own pointerup.
      if (pressed || !held) return
      held = false
      root.classList.remove(HOLD)
    })
  const onDown = (): void => {
    pressed = true
  }
  const onUp = (): void => {
    pressed = false
    if (held) release()
  }
  const onFocusOut = (e: Event): void => {
    if (!isTypingField(e.target)) return
    held = true
    root.classList.add(HOLD)
    if (!pressed) release()
  }
  // Capture: a handler that stops propagation must not hide a press's end from the hold.
  const listeners: [string, (e: Event) => void][] = [
    ['pointerdown', onDown],
    ['pointerup', onUp],
    ['pointercancel', onUp],
    ['focusout', onFocusOut]
  ]
  for (const [type, f] of listeners) doc.addEventListener(type, f, { capture: true })
  return () => {
    for (const [type, f] of listeners) doc.removeEventListener(type, f, { capture: true })
  }
}
