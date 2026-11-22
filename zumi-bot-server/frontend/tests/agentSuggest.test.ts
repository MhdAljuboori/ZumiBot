import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '@zumibot/shared/types'
import { suggestQuery } from '../src/state/agentSuggest'
import { emptyNewChatDraft } from '../src/state/newChat'

const agent = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...extra
})
const agents = [agent('writer'), agent('broken', { error: 'bad' })]
const draft = (o: Partial<typeof emptyNewChatDraft>) => ({ ...emptyNewChatDraft, ...o })

describe('suggestQuery', () => {
  it('asks with the trimmed text while no agent is picked', () => {
    expect(suggestQuery(draft({ text: '  Fix the failing login test  ' }), agents)).toBe('Fix the failing login test')
  })

  it('does not ask for a short text', () => {
    expect(suggestQuery(draft({ text: 'hi there' }), agents)).toBeNull()
  })

  it('does not ask once an agent is picked, or in group mode', () => {
    expect(suggestQuery(draft({ text: 'Fix the failing login test', agentName: 'writer' }), agents)).toBeNull()
    expect(suggestQuery(draft({ text: 'Fix the failing login test', mode: 'group' }), agents)).toBeNull()
  })

  it('asks again when the picked agent cannot be used', () => {
    expect(suggestQuery(draft({ text: 'Fix the failing login test', agentName: 'broken' }), agents)).toBe('Fix the failing login test')
  })
})
