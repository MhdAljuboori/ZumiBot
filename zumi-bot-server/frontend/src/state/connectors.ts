// Pure rules for Settings › Connectors: what each card shows and how the per-agent switches move.
import { CONNECTOR_TEXT, connectorById, connectorEngineNote } from '@zumibot/shared/connectors'
import type { ConnectorCardView, ConnectorId, ConnectorState, ConnectorsView } from '@zumibot/shared/connectors'
import type { StatusTone } from './extensionsPage'

export interface CardModel {
  id: ConnectorId
  name: string
  blurb: string
  label: string
  tone: StatusTone
  hint: string | null
  action: { label: 'Connect' | 'Reconnect' | 'Manage on claude.ai'; href: string }
  customUrl: string | null
  onText: string
  unknownText: string | null
}

const TONE: Record<ConnectorState, StatusTone> = {
  connected: 'ok',
  'needs-attention': 'warn',
  'not-connected': 'idle',
  'off-in-claude-code': 'idle',
  unknown: 'idle'
}

const HINT: Record<ConnectorState, string | null> = {
  connected: null,
  'needs-attention': CONNECTOR_TEXT.needsAttention,
  'not-connected': CONNECTOR_TEXT.notConnected,
  'off-in-claude-code': CONNECTOR_TEXT.offInClaudeCode,
  unknown: null
}

const actionLabel = (state: ConnectorState): CardModel['action']['label'] =>
  state === 'not-connected' ? 'Connect' : state === 'needs-attention' ? 'Reconnect' : 'Manage on claude.ai'

export function cardModel(card: ConnectorCardView): CardModel {
  const c = connectorById(card.id)
  return {
    id: card.id,
    name: c.name,
    blurb: c.blurb,
    label: CONNECTOR_TEXT.labels[card.state],
    tone: TONE[card.state],
    hint: HINT[card.state],
    action: { label: actionLabel(card.state), href: c.connectUrl },
    customUrl: c.customUrl,
    onText: CONNECTOR_TEXT.onFor(card.on),
    unknownText: card.unknownTools.length > 0 ? CONNECTOR_TEXT.unknown(card.unknownTools) : null
  }
}

/** The page's notes for the engines of its agents that get no connectors (Codex, ACP, remote), once each, in the view's order. */
export function engineNotes(view: Pick<ConnectorsView, 'agents'> | null): string[] {
  const notes: string[] = []
  for (const a of view?.agents ?? []) {
    const note = connectorEngineNote(a.engine)
    if (note !== null && !notes.includes(note)) notes.push(note)
  }
  return notes
}

/** One switch per Claude agent, in the view's order: Codex, ACP and remote agents cannot use connectors. */
export function switchRows(view: ConnectorsView, id: ConnectorId): Array<{ agent: string; on: boolean }> {
  const on = view.connectors.find((c) => c.id === id)?.on ?? []
  return view.agents.filter((a) => a.engine === 'claude').map((a) => ({ agent: a.name, on: on.includes(a.name) }))
}

/** The view with one switch flipped, for the optimistic update; other cards keep their identity. */
export function withSwitch(view: ConnectorsView, id: ConnectorId, agent: string, on: boolean): ConnectorsView {
  return {
    ...view,
    connectors: view.connectors.map((c) => {
      if (c.id !== id) return c
      const rest = c.on.filter((n) => n !== agent)
      return { ...c, on: on ? [...rest, agent] : rest }
    })
  }
}

/** The view with one service's Remember switch flipped, for the optimistic update; other cards keep their identity. */
export function withRemember(view: ConnectorsView, id: ConnectorId, on: boolean): ConnectorsView {
  return { ...view, connectors: view.connectors.map((c) => (c.id === id ? { ...c, remember: on } : c)) }
}

export const REFRESH_GAP_MS = 5000

/** Reopening the page re-reads the connectors, but not twice within a few seconds. */
export function shouldRefresh(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= REFRESH_GAP_MS
}
