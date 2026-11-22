import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SideQuestion } from '@zumibot/shared/btw'
import type { AgentSummary } from '@zumibot/shared/types'
import { sideThreads } from '../src/state/sideQuestions'
import { SideChip } from '../src/components/SideChip'

const agent: AgentSummary = {
  name: 'side-helper',
  filePath: '/agents/side-helper.md',
  description: '',
  color: 'blue',
  icon: null,
  error: null,
  builtIn: false
}
const entry: SideQuestion = { id: 'side', question: 'How far?', agent: agent.name, after: null, askedAt: 1, state: 'running', answer: '' }
const render = (q: SideQuestion, room = true, agents: AgentSummary[] = [agent], ...more: SideQuestion[]): string => {
  const list = [q, ...more]
  return renderToStaticMarkup(createElement(SideChip, { thread: sideThreads(list)[0], agents, room, onOpen: () => {} }))
}

describe('SideChip room attribution', () => {
  it('shows the answering member and their colour alongside the question', () => {
    const html = render(entry)
    expect(html).toContain('btw · How far?')
    expect(html).toContain('Side Helper')
    expect(html).toContain('data-agent-name="side-helper"')
    expect(html).toContain('var(--agent-blue)')
  })

  it('leaves picking unattributed until the answering member is selected', () => {
    const picking = render({ ...entry, agent: null, state: 'picking' })
    expect(picking).toContain('spinner')
    expect(picking).toContain('btw · How far?')
    expect(picking).not.toContain('data-agent-name=')
    expect(render({ ...entry, state: 'done' })).toContain('Side Helper')
  })

  it('keeps the stored answering name when the agent no longer exists', () => {
    const html = render({ ...entry, agent: 'old-member' }, true, [])
    expect(html).toContain('Old Member')
    expect(html).toContain('data-agent-name="old-member"')
    expect(html).not.toContain('var(--agent-')
  })

  it('does not add room attribution in a single-agent chat', () => {
    const html = render(entry, false)
    expect(html).toContain('btw · How far?')
    expect(html).not.toContain('data-agent-name=')
  })

  it('shows the thread state: spinner while a follow-up runs, a warning when the last entry failed', () => {
    const follow = (state: SideQuestion['state']): SideQuestion => ({ ...entry, id: 'f', thread: 'side', askedAt: 2, state })
    const running = render({ ...entry, state: 'done' }, false, [agent], follow('running'))
    expect(running).toContain('data-side-id="side"')
    expect(running).toContain('data-state="running"')
    expect(running).toContain('spinner')
    const failed = render({ ...entry, state: 'done' }, false, [agent], follow('error'))
    expect(failed).toContain('data-state="error"')
    expect(failed).toContain('side-warning')
    expect(failed).not.toContain('spinner')
  })
})
