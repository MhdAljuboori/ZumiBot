import { describe, expect, it, vi } from 'vitest'
import { cleanHotkey, createVoiceHotkey } from '../src/main/voiceHotkey'

describe('cleanHotkey', () => {
  it('keeps a valid accelerator', () => {
    expect(cleanHotkey('Ctrl+Alt+Space')).toBe('Ctrl+Alt+Space')
    expect(cleanHotkey('Ctrl+Shift+F12')).toBe('Ctrl+Shift+F12')
    expect(cleanHotkey('Super+7')).toBe('Super+7')
  })
  it('puts it in one form: modifier order, case', () => {
    expect(cleanHotkey('alt+ctrl+space')).toBe('Ctrl+Alt+Space')
    expect(cleanHotkey('shift+ctrl+k')).toBe('Ctrl+Shift+K')
  })
  it('needs a modifier and exactly one key', () => {
    expect(cleanHotkey('Space')).toBeNull()
    expect(cleanHotkey('Ctrl')).toBeNull()
    expect(cleanHotkey('Ctrl+Alt')).toBeNull()
    expect(cleanHotkey('Ctrl+A+B')).toBeNull()
    expect(cleanHotkey('Ctrl+Ctrl+A')).toBeNull()
  })
  it('refuses anything outside the grammar', () => {
    for (const bad of [
      'Ctrl+Alt+Space; rm',
      'Ctrl+Alt+Enter',
      'Ctrl+F13',
      'Ctrl+F0',
      'CommandOrControl+A',
      'Ctrl++',
      '',
      'Ctrl+Alt+Space\n',
      'Ctrl+' + 'A'.repeat(40),
      'Ctrl+AA'
    ])
      expect(cleanHotkey(bad), bad).toBeNull()
    for (const bad of [null, undefined, 5, {}, ['Ctrl+A']]) expect(cleanHotkey(bad)).toBeNull()
  })
})

const deps = (registers = true) => {
  const registered = new Set<string>()
  const d = {
    register: vi.fn((acc: string, _cb: () => void) => {
      if (!registers) return false
      registered.add(acc)
      return true
    }),
    unregister: vi.fn((acc: string) => void registered.delete(acc)),
    onPress: vi.fn()
  }
  return { d, registered }
}

describe('createVoiceHotkey', () => {
  it('registers an accelerator once and presses reach onPress', () => {
    const { d, registered } = deps()
    const h = createVoiceHotkey(d)
    expect(h.set('Ctrl+Alt+Space')).toEqual({ ok: true })
    expect(h.set('Ctrl+Alt+Space')).toEqual({ ok: true })
    expect(d.register).toHaveBeenCalledTimes(1)
    expect([...registered]).toEqual(['Ctrl+Alt+Space'])
    d.register.mock.calls[0]![1]()
    expect(d.onPress).toHaveBeenCalledTimes(1)
  })

  it('null unregisters', () => {
    const { d, registered } = deps()
    const h = createVoiceHotkey(d)
    h.set('Ctrl+Alt+Space')
    expect(h.set(null)).toEqual({ ok: true })
    expect(registered.size).toBe(0)
    expect(h.set(null)).toEqual({ ok: true })
    expect(d.unregister).toHaveBeenCalledTimes(1)
  })

  it('another accelerator replaces the first', () => {
    const { d, registered } = deps()
    const h = createVoiceHotkey(d)
    h.set('Ctrl+Alt+Space')
    expect(h.set('Ctrl+Shift+V')).toEqual({ ok: true })
    expect([...registered]).toEqual(['Ctrl+Shift+V'])
  })

  it('a failed register is not ok and keeps nothing registered', () => {
    const { d, registered } = deps(false)
    const h = createVoiceHotkey(d)
    expect(h.set('Ctrl+Alt+Space')).toEqual({ ok: false })
    expect(registered.size).toBe(0)
    h.dispose()
    expect(d.unregister).not.toHaveBeenCalled()
  })

  it('a failed replacement drops the old one too', () => {
    const { d, registered } = deps()
    const h = createVoiceHotkey(d)
    h.set('Ctrl+Alt+Space')
    d.register.mockReturnValueOnce(false)
    expect(h.set('Ctrl+Shift+V')).toEqual({ ok: false })
    expect(registered.size).toBe(0)
  })

  it('a register that throws is a failure, and an invalid accelerator is never registered', () => {
    const { d } = deps()
    d.register.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const h = createVoiceHotkey(d)
    expect(h.set('Ctrl+Alt+Space')).toEqual({ ok: false })
    expect(h.set('Space')).toEqual({ ok: false })
    expect(d.register).toHaveBeenCalledTimes(1)
  })

  it('dispose unregisters', () => {
    const { d, registered } = deps()
    const h = createVoiceHotkey(d)
    h.set('Ctrl+Alt+Space')
    h.dispose()
    expect(registered.size).toBe(0)
  })
})
