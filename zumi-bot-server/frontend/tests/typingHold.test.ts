import { describe, expect, it } from 'vitest'
import { holdTypingLayout, isTypingField, TYPING_FIELD } from '../src/typingHold'
import { styleFile } from './stylesheet'

/** An element as the hold sees it: whether it is a typing field, and whether it sits in the main area. */
const field = (typing: boolean, inMain = true) => ({
  matches: (s: string) => s === TYPING_FIELD && typing,
  closest: (s: string) => (s === '.main' && inMain ? {} : null)
})

/** Dispatches `type` on the fake document as if it came from `target` (Node's EventTarget does not propagate). */
const fire = (doc: EventTarget, type: string, target?: object) => {
  const e = new Event(type)
  if (target) Object.defineProperty(e, 'target', { value: target })
  doc.dispatchEvent(e)
}

const setup = () => {
  const doc = new EventTarget()
  const classes = new Set<string>()
  const root = { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } as unknown as HTMLElement
  const queue: (() => void)[] = []
  // The next task: everything a tap dispatched in the current one (mouseup, click) has run.
  const nextTask = () => queue.splice(0).forEach((f) => f())
  const stop = holdTypingLayout(doc, root, (f) => queue.push(f))
  return { doc, held: () => classes.has('typing-hold'), nextTask, stop }
}

describe('isTypingField', () => {
  it('is a field that brings up the keyboard, inside the main area', () => {
    expect(isTypingField(field(true) as unknown as EventTarget)).toBe(true)
    expect(isTypingField(field(false) as unknown as EventTarget)).toBe(false)
    expect(isTypingField(field(true, false) as unknown as EventTarget)).toBe(false)
    expect(isTypingField(null)).toBe(false)
    expect(isTypingField(new EventTarget())).toBe(false)
  })
})

describe('holdTypingLayout', () => {
  it('keeps the bar away until a tap that ends the typing is over', () => {
    const { doc, held, nextTask } = setup()
    // A touch: its pointerup comes first, then mousedown (the blur), mouseup and click in one task.
    fire(doc, 'pointerdown')
    fire(doc, 'pointerup')
    fire(doc, 'focusout', field(true))
    expect(held()).toBe(true)
    nextTask()
    expect(held()).toBe(false)
  })

  it('waits for a mouse button to come up', () => {
    const { doc, held, nextTask } = setup()
    fire(doc, 'pointerdown')
    fire(doc, 'focusout', field(true))
    nextTask()
    expect(held()).toBe(true)
    fire(doc, 'pointerup')
    expect(held()).toBe(true)
    nextTask()
    expect(held()).toBe(false)
  })

  it('lets go on a cancelled press too', () => {
    const { doc, held, nextTask } = setup()
    fire(doc, 'pointerdown')
    fire(doc, 'focusout', field(true))
    fire(doc, 'pointercancel')
    nextTask()
    expect(held()).toBe(false)
  })

  it('holds nothing for a field that never hid the bar', () => {
    const { doc, held } = setup()
    fire(doc, 'focusout', field(false))
    fire(doc, 'focusout', field(true, false))
    expect(held()).toBe(false)
  })

  it('a press that starts before the release keeps the hold until it ends', () => {
    const { doc, held, nextTask } = setup()
    fire(doc, 'focusout', field(true))
    fire(doc, 'pointerdown')
    nextTask()
    expect(held()).toBe(true)
    fire(doc, 'pointerup')
    nextTask()
    expect(held()).toBe(false)
  })

  it('stops listening', () => {
    const { doc, held, stop } = setup()
    stop()
    fire(doc, 'focusout', field(true))
    expect(held()).toBe(false)
  })
})

describe('phone.css', () => {
  it('hides the tab bar for the same fields, and while held', () => {
    const css = styleFile('phone.css')
    expect(css).toContain(`.main:has(:is(${TYPING_FIELD}):focus) .tab-bar`)
    expect(css).toContain('html.typing-hold .tab-bar')
  })
})
