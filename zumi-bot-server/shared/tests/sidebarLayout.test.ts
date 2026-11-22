import { describe, expect, it } from 'vitest'
import { forgetChatInLayout, parseLayout, placeFirstInSection, renameAgentInLayout } from '../src/sidebarLayout'

const sec = (id: string, items: string[], name = id) => ({ id, name, collapsed: false, items })

describe('parseLayout', () => {
  it('refuses a wrong shape', () => {
    expect(parseLayout(null)).toBeNull()
    expect(parseLayout({ sections: [] })).toBeNull()
    expect(parseLayout({ sections: [{ id: '', name: 'x', collapsed: false, items: [] }], unassigned: [] })).toBeNull()
    expect(parseLayout({ sections: [{ id: 's', name: 'x', collapsed: 'no', items: [] }], unassigned: [] })).toBeNull()
    expect(parseLayout({ sections: [], unassigned: [1] })).toBeNull()
  })

  it('keeps each item in the first place it is listed, drops repeated sections, and leaves out pins from before', () => {
    const l = parseLayout({
      sections: [sec('a', ['agent:x', 'agent:y']), sec('b', ['agent:x', 'group:g']), sec('a', ['agent:z'])],
      unassigned: ['group:g', 'agent:w', 'agent:w'],
      pinned: ['c', 'c', 'd']
    })
    expect(l).toEqual({ sections: [sec('a', ['agent:x', 'agent:y']), sec('b', ['group:g'])], unassigned: ['agent:w'] })
  })

  it('trims names and cuts long ones', () => {
    const l = parseLayout({ sections: [sec('a', [], `  ${'n'.repeat(80)}  `)], unassigned: [] })
    expect(l?.sections[0].name).toBe('n'.repeat(60))
  })
})

describe('layout edits the server makes', () => {
  const l = { sections: [sec('a', ['agent:old', 'group:g1'])], unassigned: ['agent:other'] }

  it('renameAgentInLayout keeps the place', () => {
    expect(renameAgentInLayout(l, 'old', 'new').sections[0].items).toEqual(['agent:new', 'group:g1'])
  })

  it('forgetChatInLayout drops the group', () => {
    expect(forgetChatInLayout(l, 'g1')).toEqual({ sections: [sec('a', ['agent:old'])], unassigned: ['agent:other'] })
  })

  it('placeFirstInSection moves the item to the top of the section from wherever it was', () => {
    const two = { sections: [sec('a', ['agent:old', 'group:g1']), sec('b', ['agent:x'])], unassigned: ['group:g2'] }
    expect(placeFirstInSection(two, 'b', 'group:g1')).toEqual({
      sections: [sec('a', ['agent:old']), sec('b', ['group:g1', 'agent:x'])],
      unassigned: ['group:g2']
    })
    expect(placeFirstInSection(two, 'a', 'group:g2')).toEqual({
      sections: [sec('a', ['group:g2', 'agent:old', 'group:g1']), sec('b', ['agent:x'])],
      unassigned: []
    })
    expect(placeFirstInSection(two, 'b', 'group:new')).toEqual({ ...two, sections: [two.sections[0], sec('b', ['group:new', 'agent:x'])] })
  })

  it('placeFirstInSection leaves the layout as it is when the section is gone', () => {
    expect(placeFirstInSection(l, 'deleted', 'group:new')).toBe(l)
  })
})
