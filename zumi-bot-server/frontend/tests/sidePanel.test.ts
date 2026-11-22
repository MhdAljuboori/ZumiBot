import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import type { AgentSummary } from '@zumibot/shared/types'
import { engineCaps, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import {
  browserMoved,
  closeSide,
  desktopRowShown,
  hasComputerUse,
  isChatView,
  isOpenBrowser,
  isOpenDesktop,
  liveMoved,
  panelLive,
  pendingHandoff,
  shownSide,
  sideFocusAfter,
  toggleChanges,
  toggleSide
} from '../src/state/sidePanel'

describe('toggleSide', () => {
  it('opens the launcher list when closed and closes whatever shows otherwise', () => {
    expect(toggleSide(null)).toBe('menu')
    expect(toggleSide('menu')).toBe(null)
    expect(toggleSide('files')).toBe(null)
    expect(toggleSide('browser')).toBe(null)
    expect(toggleSide('btw')).toBe(null)
    expect(toggleSide('todos')).toBe(null)
    expect(toggleSide('dispatch')).toBe(null)
  })
})

describe('closeSide', () => {
  it('brings back a browser hidden behind Files or the list', () => {
    expect(closeSide('files', 'browser')).toBe('browser')
    expect(closeSide('menu', 'browser')).toBe('browser')
    expect(closeSide('btw', 'browser')).toBe('browser')
    expect(closeSide('todos', 'browser')).toBe('browser')
    expect(closeSide('dispatch', 'browser')).toBe('browser')
    expect(closeSide('changes', 'browser')).toBe('browser')
  })
  it('closes the panel when no browser waits behind it', () => {
    expect(closeSide('files', null)).toBe(null)
    expect(closeSide('menu', null)).toBe(null)
    expect(closeSide('btw', null)).toBe(null)
    expect(closeSide('todos', null)).toBe(null)
    expect(closeSide('browser', 'browser')).toBe(null)
    expect(closeSide(null, 'browser')).toBe(null)
  })
})

describe('toggleChanges (the git chip)', () => {
  it('opens Changes from anything else, the closed panel and a live view included', () => {
    expect(toggleChanges(null, null)).toBe('changes')
    expect(toggleChanges('menu', null)).toBe('changes')
    expect(toggleChanges('files', 'browser')).toBe('changes')
    expect(toggleChanges('browser', 'browser')).toBe('changes')
  })
  it('closes Changes, bringing back a live view that waited behind it', () => {
    expect(toggleChanges('changes', null)).toBe(null)
    expect(toggleChanges('changes', 'desktop')).toBe('desktop')
  })
})

describe('isChatView', () => {
  it('is every view that belongs to the chat on screen, Changes included', () => {
    for (const v of ['menu', 'files', 'changes', 'btw', 'todos', 'dispatch'] as const) expect(isChatView(v)).toBe(true)
    expect(isChatView('browser')).toBe(false)
    expect(isChatView('desktop')).toBe(false)
    expect(isChatView(null)).toBe(false)
  })
})

describe('browserMoved', () => {
  it('takes the panel when the browser opens in it', () => {
    expect(browserMoved(null, false, true, true)).toBe('browser')
    expect(browserMoved('files', false, true, true)).toBe('browser')
    expect(browserMoved('menu', false, true, true)).toBe('browser')
  })
  it('leaves the panel alone when the browser opens inline in a handoff card', () => {
    expect(browserMoved('files', false, true, false)).toBe('files')
    expect(browserMoved(null, false, true, false)).toBe(null)
  })
  it('closes the panel when the browser it showed closes', () => {
    expect(browserMoved('browser', true, false, true)).toBe(null)
  })
  it('keeps Files or the list when a hidden browser closes', () => {
    expect(browserMoved('files', true, false, true)).toBe('files')
    expect(browserMoved('menu', true, false, true)).toBe('menu')
    expect(browserMoved('btw', true, false, true)).toBe('btw')
    expect(browserMoved('todos', true, false, true)).toBe('todos')
  })
  it('changes nothing without an edge', () => {
    expect(browserMoved('files', true, true, true)).toBe('files')
    expect(browserMoved('browser', false, false, true)).toBe('browser')
  })
})

describe('shownSide', () => {
  it('shows the list, Files and side questions only over a chat', () => {
    expect(shownSide('menu', true, null)).toBe('menu')
    expect(shownSide('files', true, 'browser')).toBe('files')
    expect(shownSide('btw', true, 'browser')).toBe('btw')
    expect(shownSide('todos', true, null)).toBe('todos')
    expect(shownSide('dispatch', true, null)).toBe('dispatch')
    expect(shownSide('dispatch', false, null)).toBe(null)
    expect(shownSide('todos', false, 'browser')).toBe(null)
    expect(shownSide('menu', false, null)).toBe(null)
    expect(shownSide('files', false, 'browser')).toBe(null)
    expect(shownSide('btw', false, null)).toBe(null)
  })
  it('shows the browser on any view while it is open in the panel', () => {
    expect(shownSide('browser', false, 'browser')).toBe('browser')
    expect(shownSide('browser', true, 'browser')).toBe('browser')
    expect(shownSide('browser', true, null)).toBe(null)
  })
  it('shows nothing when closed', () => {
    expect(shownSide(null, true, 'browser')).toBe(null)
  })
})

describe('isOpenBrowser', () => {
  it('matches the browser already open for that agent in that chat', () => {
    expect(isOpenBrowser(true, { agent: 'a', chatId: 'c' }, 'a', 'c')).toBe(true)
  })
  it('is false for another agent, another chat, a handoff, or a closed browser', () => {
    expect(isOpenBrowser(true, { agent: 'b', chatId: 'c' }, 'a', 'c')).toBe(false)
    expect(isOpenBrowser(true, { agent: 'a', chatId: 'd' }, 'a', 'c')).toBe(false)
    expect(isOpenBrowser(true, { agent: 'a', chatId: 'c', requestId: 'r' }, 'a', 'c')).toBe(false)
    expect(isOpenBrowser(false, { agent: 'a', chatId: 'c' }, 'a', 'c')).toBe(false)
    expect(isOpenBrowser(true, null, 'a', 'c')).toBe(false)
  })
})

describe('desktop in the panel', () => {
  it('desktop takes the slot when opened in the panel', () => {
    expect(liveMoved('files', 'desktop', false, true, true)).toBe('desktop')
    expect(liveMoved('files', 'desktop', false, true, false)).toBe('files')
    expect(shownSide('desktop', true, 'desktop')).toBe('desktop')
    expect(shownSide('desktop', false, 'desktop')).toBe('desktop')
  })
  it('chat view closes back to a desktop behind it', () => {
    expect(closeSide('files', 'desktop')).toBe('desktop')
    expect(closeSide('menu', 'desktop')).toBe('desktop')
    expect(closeSide('desktop', 'desktop')).toBe(null)
  })
  it('closing the desktop that was shown closes the panel, one behind a chat view leaves it', () => {
    expect(liveMoved('desktop', 'desktop', true, false, true)).toBe(null)
    expect(liveMoved('files', 'desktop', true, false, true)).toBe('files')
    expect(liveMoved('browser', 'desktop', true, false, true)).toBe('browser')
  })
  it('does not show a desktop slot for the browser or the reverse', () => {
    expect(shownSide('desktop', true, 'browser')).toBe(null)
    expect(shownSide('browser', true, 'desktop')).toBe(null)
  })
})

describe('isOpenDesktop', () => {
  it('matches the desktop already open for that agent in that chat only', () => {
    expect(isOpenDesktop(true, { agent: 'a', chatId: 'c' }, 'a', 'c')).toBe(true)
    expect(isOpenDesktop(true, { agent: 'a', chatId: 'c', requestId: 'r' }, 'a', 'c')).toBe(false)
    expect(isOpenDesktop(true, { agent: 'b', chatId: 'c' }, 'a', 'c')).toBe(false)
    expect(isOpenDesktop(false, { agent: 'a', chatId: 'c' }, 'a', 'c')).toBe(false)
    expect(isOpenDesktop(true, null, 'a', 'c')).toBe(false)
  })
})

describe('panelLive', () => {
  it('names the live view the panel holds', () => {
    expect(panelLive('menu', false, false)).toBe(null)
    expect(panelLive('browser', true, false)).toBe('browser')
    expect(panelLive('files', false, true)).toBe('desktop')
  })
  it('prefers the one the slot names while the other is still closing', () => {
    expect(panelLive('desktop', true, true)).toBe('desktop')
    expect(panelLive('browser', true, true)).toBe('browser')
  })
})

describe('pendingHandoff', () => {
  const handoff = (id: string, status: 'pending' | 'done', surface?: 'desktop'): ChatItem => ({
    type: 'browser-action',
    id: `item-${id}`,
    ts: 1,
    agent: 'a',
    ...(surface ? { surface } : {}),
    handoff: { id, profileId: 'p', generation: 'g', chatId: 'c', turnId: 't', site: '', reason: 'r', createdAt: 1, agent: 'a', status }
  })
  const items = [handoff('b', 'pending'), handoff('d', 'pending', 'desktop'), handoff('old', 'done', 'desktop')]
  it('matches a pending card of its own surface only', () => {
    expect(pendingHandoff(items, 'b', 'browser')).toBe(true)
    expect(pendingHandoff(items, 'd', 'desktop')).toBe(true)
    // Both kinds share the item type: a desktop card never holds the browser inline, nor the reverse.
    expect(pendingHandoff(items, 'd', 'browser')).toBe(false)
    expect(pendingHandoff(items, 'b', 'desktop')).toBe(false)
  })
  it('is false for a finished card, an unknown request or none', () => {
    expect(pendingHandoff(items, 'old', 'desktop')).toBe(false)
    expect(pendingHandoff(items, 'x', 'browser')).toBe(false)
    expect(pendingHandoff(items, undefined, 'browser')).toBe(false)
    expect(pendingHandoff([], 'b', 'browser')).toBe(false)
  })
})

describe('the Desktop row', () => {
  const agent = (name: string, patch: Partial<AgentSummary> = {}) => ({ name, error: null, ...patch }) as AgentSummary
  const agents = [agent('on', { computerUse: true }), agent('off'), agent('broken', { computerUse: true, error: 'bad file' })]
  it('knows who has computer use', () => {
    expect(hasComputerUse('on', agents)).toBe(true)
    expect(hasComputerUse('off', agents)).toBe(false)
    expect(hasComputerUse('broken', agents)).toBe(false)
    expect(hasComputerUse('gone', agents)).toBe(false)
  })
  it('a Codex agent has no computer use, whatever its file says, while Codex desktops are off', () => {
    const codex = [...agents, agent('cx', { computerUse: true, provider: 'codex' })]
    expect(hasComputerUse('cx', codex)).toBe(false)
    expect(desktopRowShown(['cx'], codex)).toBe(false)
    expect(desktopRowShown(['cx', 'on'], codex)).toBe(true)
    const desktopOn = (e: Engine): EngineCaps => ({ ...engineCaps(e), desktop: true })
    expect(hasComputerUse('cx', codex, desktopOn)).toBe(true)
  })
  it('shows only when some member has computer use', () => {
    expect(desktopRowShown(['on'], agents)).toBe(true)
    expect(desktopRowShown(['off'], agents)).toBe(false)
    expect(desktopRowShown(['off', 'broken', 'gone'], agents)).toBe(false)
    expect(desktopRowShown(['off', 'on'], agents)).toBe(true)
    expect(desktopRowShown([], agents)).toBe(false)
  })
})

describe('sideFocusAfter', () => {
  it('focuses the entry on that chat and counts a repeat as a new request', () => {
    const first = sideFocusAfter(null, 'c2', 'e1')
    expect(first).toEqual({ chatId: 'c2', id: 'e1', n: 1 })
    expect(sideFocusAfter(first, 'c2', 'e1')).toEqual({ chatId: 'c2', id: 'e1', n: 2 })
  })
  it('clears the focus when there is no entry', () => {
    expect(sideFocusAfter({ chatId: 'c2', id: 'e1', n: 4 }, 'c2', null)).toBeNull()
  })
})
