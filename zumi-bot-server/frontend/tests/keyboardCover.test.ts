import { describe, expect, it } from 'vitest'
import { followKeyboardCover, keyboardCover } from '../src/keyboardCover'

describe('keyboardCover', () => {
  it('is the part on screen when a keyboard covers the page', () => {
    expect(keyboardCover({ innerHeight: 1152, height: 784.4, offsetTop: 300.2, scale: 1 })).toEqual({ top: 300, height: 784 })
  })

  it('is null where the keyboard shrinks the page, or there is none', () => {
    expect(keyboardCover({ innerHeight: 784, height: 784, offsetTop: 0, scale: 1 })).toBeNull()
    expect(keyboardCover({ innerHeight: 1152, height: 1152, offsetTop: 0, scale: 1 })).toBeNull()
  })

  it('is null for a small gap, which is no keyboard', () => {
    expect(keyboardCover({ innerHeight: 1152, height: 1100, offsetTop: 0, scale: 1 })).toBeNull()
  })

  it('leaves a pinch zoom alone', () => {
    expect(keyboardCover({ innerHeight: 1152, height: 576, offsetTop: 200, scale: 2 })).toBeNull()
  })
})

class FakeViewport extends EventTarget {
  height = 1152
  offsetTop = 0
  scale = 1
}

const fakeRoot = () => {
  const props = new Map<string, string>()
  const classes = new Set<string>()
  const root = {
    style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) }
  } as unknown as HTMLElement
  return { root, props, classes }
}

describe('followKeyboardCover', () => {
  it('sets the box while a keyboard covers the page and clears it when it closes', () => {
    const vv = new FakeViewport()
    const { root, props, classes } = fakeRoot()
    const stop = followKeyboardCover({ innerHeight: 1152, visualViewport: vv }, root)
    expect(classes.has('kb-cover')).toBe(false)

    vv.height = 784
    vv.dispatchEvent(new Event('resize'))
    expect(classes.has('kb-cover')).toBe(true)
    expect(props.get('--vv-height')).toBe('784px')
    expect(props.get('--vv-top')).toBe('0px')

    // The browser pans to the caret: the app follows.
    vv.offsetTop = 300
    vv.dispatchEvent(new Event('scroll'))
    expect(props.get('--vv-top')).toBe('300px')

    vv.height = 1152
    vv.offsetTop = 0
    vv.dispatchEvent(new Event('resize'))
    expect(classes.has('kb-cover')).toBe(false)
    expect(props.size).toBe(0)

    stop()
    vv.height = 784
    vv.dispatchEvent(new Event('resize'))
    expect(classes.has('kb-cover')).toBe(false)
  })

  it('does nothing without a visual viewport', () => {
    const { root, classes } = fakeRoot()
    followKeyboardCover({ innerHeight: 1152, visualViewport: null }, root)()
    expect(classes.size).toBe(0)
  })
})
