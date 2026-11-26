import { describe, expect, it } from 'vitest'
import { sendKeyAction, takesSteers } from '../src/state/sendKeys'

type Keys = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }
const k = (o: Partial<Keys>): Keys => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...o })

describe('sendKeyAction', () => {
  it('Enter sends into the running reply; Ctrl or Cmd+Enter queues', () => {
    expect(sendKeyAction(k({}), false)).toBe('steer')
    expect(sendKeyAction(k({ ctrlKey: true }), false)).toBe('queue')
    expect(sendKeyAction(k({ metaKey: true }), false)).toBe('queue')
  })

  it("a touch keyboard's Enter is a new line; Ctrl or Cmd+Enter still sends (queues)", () => {
    expect(sendKeyAction(k({}), true)).toBeNull()
    expect(sendKeyAction(k({ metaKey: true }), true)).toBe('queue')
    expect(sendKeyAction(k({ ctrlKey: true }), true)).toBe('queue')
  })

  it('Shift+Enter, an IME composition and other keys never send', () => {
    expect(sendKeyAction(k({ shiftKey: true }), false)).toBeNull()
    expect(sendKeyAction(k({ shiftKey: true, ctrlKey: true }), false)).toBeNull()
    expect(sendKeyAction(k({ isComposing: true }), false)).toBeNull()
    expect(sendKeyAction(k({ key: 'a' }), false)).toBeNull()
  })
})

describe('takesSteers', () => {
  it('only a single Claude chat takes a message into its running reply', () => {
    expect(takesSteers({}, 'claude')).toBe(true)
    expect(takesSteers({ group: { members: [] } }, 'claude')).toBe(false)
    expect(takesSteers({}, 'codex')).toBe(false)
    expect(takesSteers({}, 'acp')).toBe(false)
    expect(takesSteers({}, 'ag-ui')).toBe(false)
  })
})
