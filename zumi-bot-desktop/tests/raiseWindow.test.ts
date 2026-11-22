import { describe, expect, it } from 'vitest'
import { raiseWindow, type RaiseMode } from '../src/main/raiseWindow'

function fakeWindow(s: { visible: boolean; minimized?: boolean }) {
  const calls: string[] = []
  const state = { visible: s.visible, minimized: s.minimized ?? false }
  const w = {
    isMinimized: () => state.minimized,
    isVisible: () => state.visible || state.minimized, // Electron counts a minimized window as visible on X11
    restore: () => {
      calls.push('restore')
      state.minimized = false
      state.visible = true
    },
    show: () => calls.push('raw show'), // never: a hidden window comes back through showHidden
    focus: () => calls.push('focus'),
    setVisibleOnAllWorkspaces: (on: boolean) => calls.push(`allWorkspaces:${on}`)
  }
  return { w, calls }
}

const run = (s: { visible: boolean; minimized?: boolean }, mode: RaiseMode): string[] => {
  const f = fakeWindow(s)
  raiseWindow(f.w, mode, () => {
    f.calls.push('showHidden')
  })
  return f.calls
}

describe('raiseWindow', () => {
  it('go: only focuses a visible window, so the window manager switches to its workspace and its size stays', () => {
    expect(run({ visible: true }, 'go')).toEqual(['focus'])
  })

  it('bring: moves a visible window onto the current workspace without unmapping it, then focuses it', () => {
    expect(run({ visible: true }, 'bring')).toEqual(['allWorkspaces:false', 'focus'])
  })

  it('shows a window hidden to the tray through showHidden (which keeps it maximized) before focusing it, in both modes', () => {
    expect(run({ visible: false }, 'go')).toEqual(['showHidden', 'focus'])
    expect(run({ visible: false }, 'bring')).toEqual(['showHidden', 'focus'])
  })

  it('restores a minimized window first', () => {
    expect(run({ visible: false, minimized: true }, 'go')).toEqual(['restore', 'focus'])
    expect(run({ visible: false, minimized: true }, 'bring')).toEqual(['restore', 'allWorkspaces:false', 'focus'])
  })

  it('never hides the window', () => {
    for (const mode of ['go', 'bring'] as const) {
      for (const visible of [true, false]) expect(run({ visible }, mode)).not.toContain('hide')
    }
  })
})
