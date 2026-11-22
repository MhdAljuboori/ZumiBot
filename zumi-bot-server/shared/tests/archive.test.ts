import { describe, expect, it } from 'vitest'
import { archivePatch, isArchived } from '@zumibot/shared/archive'

describe('isArchived', () => {
  it('is false for a chat never archived', () => {
    expect(isArchived({})).toBe(false)
    expect(isArchived({ unarchivedAt: 5 })).toBe(false)
  })
  it('is true while the archive is the later of the two', () => {
    expect(isArchived({ archivedAt: 5 })).toBe(true)
    expect(isArchived({ archivedAt: 6, unarchivedAt: 5 })).toBe(true)
  })
  it('is false once unarchived after it', () => {
    expect(isArchived({ archivedAt: 5, unarchivedAt: 6 })).toBe(false)
    expect(isArchived({ archivedAt: 5, unarchivedAt: 5 })).toBe(false)
  })
})

describe('archivePatch', () => {
  it('archives at now', () => {
    expect(archivePatch({}, true, 100)).toEqual({ archivedAt: 100 })
    expect(archivePatch({ archivedAt: 10, unarchivedAt: 20 }, true, 100)).toEqual({ archivedAt: 100 })
  })
  it('unarchives at now', () => {
    expect(archivePatch({ archivedAt: 10 }, false, 100)).toEqual({ unarchivedAt: 100 })
  })
  it('changes nothing when the chat already is that way', () => {
    expect(archivePatch({}, false, 100)).toEqual({})
    expect(archivePatch({ archivedAt: 10 }, true, 100)).toEqual({})
    expect(archivePatch({ archivedAt: 10, unarchivedAt: 20 }, false, 100)).toEqual({})
  })
  it('lands past the other time even when that is ahead of the clock', () => {
    // A time synced from a faster clock must not leave the change invisible.
    const archived = { ...{ unarchivedAt: 500 }, ...archivePatch({ unarchivedAt: 500 }, true, 100) }
    expect(archived).toEqual({ unarchivedAt: 500, archivedAt: 501 })
    expect(isArchived(archived)).toBe(true)
    const back = { ...archived, ...archivePatch(archived, false, 100) }
    expect(back.unarchivedAt).toBe(502)
    expect(isArchived(back)).toBe(false)
  })
})
