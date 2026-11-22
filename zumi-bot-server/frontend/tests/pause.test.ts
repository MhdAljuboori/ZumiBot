import { describe, expect, it } from 'vitest'
import type { ChatItem, GroupInfo } from '@zumibot/shared/types'
import { pauseControl, pausingLine, resumeRow } from '../src/state/pause'

const notice = (id: string, kind: 'userPaused' | 'paused' | 'stopped'): ChatItem => ({ type: 'notice', id, kind, text: kind, ts: 1 })
const room = (active: GroupInfo['active']): GroupInfo => ({ members: [], sessions: {}, seen: {}, role: '', active, queue: [] })

describe('pauseControl', () => {
  it('is null for an idle chat', () => {
    expect(pauseControl({ inFlight: false })).toBeNull()
  })
  it('is null while the CLI compacts', () => {
    expect(pauseControl({ inFlight: true, compacting: true })).toBeNull()
  })
  it('is null while a room member compacts', () => {
    expect(pauseControl({ inFlight: true, group: room([{ agent: 'a', turn: 't', since: 1, compacting: true }]) })).toBeNull()
  })
  it('is null in an asked chat, which nobody pauses', () => {
    expect(pauseControl({ inFlight: true, asked: { by: 'a', from: 'c', fromTitle: 't', chain: [] } })).toBeNull()
  })
  it('is pause for a running chat', () => {
    expect(pauseControl({ inFlight: true })).toBe('pause')
    expect(pauseControl({ inFlight: true, group: room([{ agent: 'a', turn: 't', since: 1 }]) })).toBe('pause')
  })
  it('is pausing once the pause was asked', () => {
    expect(pauseControl({ inFlight: true, pause: 'pausing' })).toBe('pausing')
  })
  it('is null when the engine cannot pause (Codex), and unchanged otherwise', () => {
    expect(pauseControl({ inFlight: true }, { pause: false })).toBeNull()
    expect(pauseControl({ inFlight: true, pause: 'pausing' }, { pause: false })).toBeNull()
    expect(pauseControl({ inFlight: true }, { pause: true })).toBe('pause')
    expect(pauseControl({ inFlight: true }, undefined)).toBe('pause')
  })
})

describe('resumeRow', () => {
  const items = [notice('a', 'userPaused'), notice('b', 'stopped'), notice('c', 'userPaused'), notice('d', 'paused')]
  it('finds the last userPaused notice of a paused chat', () => {
    expect(resumeRow(items, { inFlight: false, pause: 'paused' })).toBe('c')
  })
  it('is null while the chat runs', () => {
    expect(resumeRow(items, { inFlight: true, pause: 'paused' })).toBeNull()
  })
  it('is null once the pause is cleared or only asked', () => {
    expect(resumeRow(items, { inFlight: false })).toBeNull()
    expect(resumeRow(items, { inFlight: false, pause: 'pausing' })).toBeNull()
  })
  it('is null when no userPaused notice exists', () => {
    expect(resumeRow([notice('d', 'paused')], { inFlight: false, pause: 'paused' })).toBeNull()
  })
})

describe('pausingLine', () => {
  it('names the subagents the pause waits for', () => {
    expect(pausingLine(0)).toBe('Pausing…')
    expect(pausingLine(1)).toBe('Pausing — waiting for 1 subagent')
    expect(pausingLine(3)).toBe('Pausing — waiting for 3 subagents')
  })
})
