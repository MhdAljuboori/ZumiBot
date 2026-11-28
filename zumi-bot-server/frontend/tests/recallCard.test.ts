import { describe, expect, it } from 'vitest'
import { recallChoices } from '../src/state/recallCard'

describe('recallChoices', () => {
  it('offers Off, Own chats and This folder, marking the file’s value', () => {
    expect(recallChoices(null).map((c) => [c.label, c.value, c.active])).toEqual([
      ['Off', null, true],
      ['Own chats', 'agent', false],
      ['This folder', 'folder', false]
    ])
    expect(recallChoices('folder').find((c) => c.active)?.value).toBe('folder')
  })
})
