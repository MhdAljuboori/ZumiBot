import { describe, expect, it } from 'vitest'
import type { NotifyPayload, NotifyPayloadKind } from '@zumibot/shared/notify'
import { agentsFor } from '../src/sw/mergePlan'

const p = (kind: NotifyPayloadKind, agent?: string): NotifyPayload => ({ v: 1, kind, tag: 'chat:1', chatId: '1', title: 't', agent, at: 1 })

describe('agentsFor', () => {
  it('merges replied after replied', () => {
    expect(agentsFor({ kind: 'replied', agents: ['writer'] }, p('replied', 'news'))).toEqual(['writer', 'news'])
  })
  it('does not repeat a name', () => {
    expect(agentsFor({ kind: 'replied', agents: ['writer'] }, p('replied', 'writer'))).toEqual(['writer'])
  })
  it('does not merge an error into a reply', () => {
    expect(agentsFor({ kind: 'replied', agents: ['writer'] }, p('error', 'news'))).toEqual(['news'])
  })
  it('does not merge a reply into an error', () => {
    expect(agentsFor({ kind: 'error', agents: ['news'] }, p('replied', 'writer'))).toEqual(['writer'])
  })
  it('never merges waiting', () => {
    expect(agentsFor({ kind: 'waiting', agents: ['writer'] }, p('waiting', 'news'))).toEqual(['news'])
  })
  it('ignores garbage previous data', () => {
    expect(agentsFor({ kind: 'replied', agents: 'writer' }, p('replied', 'news'))).toEqual(['news'])
    expect(agentsFor({ kind: 'replied', agents: [1, null, 'writer'] }, p('replied', 'news'))).toEqual(['writer', 'news'])
    expect(agentsFor({ agents: ['writer'] }, p('replied', 'news'))).toEqual(['news'])
    expect(agentsFor(null, p('replied', 'news'))).toEqual(['news'])
  })
  it('uses just the payload agent without a previous one', () => {
    expect(agentsFor(undefined, p('replied', 'news'))).toEqual(['news'])
    expect(agentsFor(undefined, p('replied'))).toEqual([])
  })
})
