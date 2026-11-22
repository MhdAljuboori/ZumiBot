import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { SidebarStore } from '../../src/core/store/sidebarStore'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-sidebar-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const work = (items: string[]) => ({ id: 's1', name: 'Work', collapsed: true, items })

describe('SidebarStore', () => {
  it('starts empty, and a missing or corrupt file reads as empty', async () => {
    expect(await new SidebarStore(dir).get()).toEqual({ sections: [], unassigned: [] })
    await fs.writeFile(join(dir, 'sidebar.json'), '{oops')
    expect(await new SidebarStore(dir).get()).toEqual({ sections: [], unassigned: [] })
  })

  it('save persists the layout', async () => {
    const l = { sections: [work(['agent:a'])], unassigned: ['group:g'] }
    await new SidebarStore(dir).save(l)
    expect(await new SidebarStore(dir).get()).toEqual(l)
  })

  it('renameAgent keeps the place under the new name; nothing to rename changes nothing', async () => {
    const s = new SidebarStore(dir)
    await s.save({ sections: [work(['agent:a', 'agent:b'])], unassigned: ['agent:c'] })
    expect(await s.renameAgent('a', 'z')).toEqual({ sections: [work(['agent:z', 'agent:b'])], unassigned: ['agent:c'] })
    expect(await s.renameAgent('nobody', 'x')).toBeNull()
    expect((await s.get()).sections[0].items).toEqual(['agent:z', 'agent:b'])
  })

  it('forgetChat drops the group; pins left in an older file are dropped on read', async () => {
    const s = new SidebarStore(dir)
    await fs.writeFile(
      join(dir, 'sidebar.json'),
      JSON.stringify({ sections: [work(['group:g1'])], unassigned: ['group:g1x'], pinned: ['g1'] })
    )
    expect(await s.get()).toEqual({ sections: [work(['group:g1'])], unassigned: ['group:g1x'] })
    expect(await s.forgetChat('g1')).toEqual({ sections: [work([])], unassigned: ['group:g1x'] })
    expect(await s.forgetChat('g1')).toBeNull()
  })

  it('placeFirst puts a room at the top of its section; a section deleted since changes nothing', async () => {
    const s = new SidebarStore(dir)
    await s.save({ sections: [work(['agent:a'])], unassigned: [] })
    expect(await s.placeFirst('s1', 'group:g1')).toEqual({ sections: [work(['group:g1', 'agent:a'])], unassigned: [] })
    expect(await s.placeFirst('s1', 'group:g1')).toBeNull()
    expect(await s.placeFirst('gone', 'group:g2')).toBeNull()
    expect(await s.get()).toEqual({ sections: [work(['group:g1', 'agent:a'])], unassigned: [] })
  })
})
