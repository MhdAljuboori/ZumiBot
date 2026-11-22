import { describe, expect, it } from 'vitest'
import { decideClose, runningMessage } from '../src/main/quitGuard'

describe('decideClose', () => {
  it('closes when clean and idle', () => {
    expect(decideClose({ editorDirty: false, runningCount: 0 })).toBe('close')
  })
  it('asks about unsaved edits first', () => {
    expect(decideClose({ editorDirty: true, runningCount: 2 })).toBe('ask-unsaved')
  })
  it('asks about running replies when editor is clean', () => {
    expect(decideClose({ editorDirty: false, runningCount: 2 })).toBe('ask-running')
  })
})

describe('runningMessage', () => {
  it('uses singular for one', () => {
    expect(runningMessage(1)).toBe('1 reply still running. Stop it and quit?')
  })
  it('uses plural for many', () => {
    expect(runningMessage(3)).toBe('3 replies still running. Stop them and quit?')
  })
})

describe('background processes on quit', () => {
  it('ask before a quit that would stop them, though they are not replies', () => {
    expect(decideClose({ editorDirty: false, runningCount: 0, processCount: 2 })).toBe('ask-running')
    expect(decideClose({ editorDirty: false, runningCount: 0, processCount: 0 })).toBe('close')
    expect(runningMessage(0, 1)).toBe('1 background process will stop. Quit?')
    expect(runningMessage(0, 3)).toBe('3 background processes will stop. Quit?')
    expect(runningMessage(2, 1)).toBe('2 replies still running, and 1 background process will stop. Stop them and quit?')
    expect(runningMessage(1)).toBe('1 reply still running. Stop it and quit?')
  })
})

describe('switchMessage', () => {
  it('says the same as quitting, for a switch', async () => {
    const { switchMessage } = await import('../src/main/quitGuard')
    expect(switchMessage(0, 2)).toBe('2 background processes will stop. Switch server?')
    expect(switchMessage(1)).toBe('1 reply still running. Stop it and switch?')
    expect(switchMessage(2, 1)).toBe('2 replies still running, and 1 background process will stop. Stop them and switch?')
  })
})
