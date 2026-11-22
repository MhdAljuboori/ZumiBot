import { describe, expect, it } from 'vitest'
import { stageErrors } from '@zumibot/shared/attachments'
import {
  addStaging,
  draftFileName,
  emptyDraftFiles,
  isStaging,
  readyIds,
  removeFile,
  settle,
  type DraftFile,
  type DraftFiles
} from '../src/state/draftFiles'
import type { Attachment } from '@zumibot/shared/types'

const att = (id: string): Attachment => ({ id, name: `${id}.png`, mime: 'image/png', size: 10, kind: 'image' })
const ready = (key: string): DraftFile => ({ key, name: `${key}.png`, status: 'ready', attachment: att(key) })
const withFiles = (n: number): DraftFiles => ({ files: Array.from({ length: n }, (_, i) => ready(`r${i}`)), error: null })

describe('addStaging', () => {
  it('accepts up to 10 and refuses the rest with the count error', () => {
    const incoming = [1, 2, 3, 4].map((i) => ({ key: `n${i}`, name: `n${i}.txt` }))
    const { draft, accepted } = addStaging(withFiles(8), incoming)
    expect(accepted).toEqual(['n1', 'n2'])
    expect(draft.files).toHaveLength(10)
    expect(draft.files.slice(8).every((f) => f.status === 'staging')).toBe(true)
    expect(draft.error).toBe(stageErrors.TOO_MANY)
  })

  it('clears an old error when everything fits', () => {
    const { draft } = addStaging({ files: [], error: 'old' }, [{ key: 'a', name: 'a.txt' }])
    expect(draft.error).toBeNull()
  })
})

describe('settle', () => {
  it('makes a file ready or drops it with its error', () => {
    const d = addStaging(emptyDraftFiles, [
      { key: 'a', name: 'a.png' },
      { key: 'b', name: 'b.png' }
    ]).draft
    const ok = settle(d, 'a', { ok: true, attachment: att('x') })
    expect(ok.files[0]).toEqual({ key: 'a', name: 'a.png', status: 'ready', attachment: att('x') })
    const bad = settle(ok, 'b', { ok: false, name: 'b.png', error: "b.png couldn't be read" })
    expect(bad.files.map((f) => f.key)).toEqual(['a'])
    expect(bad.error).toBe("b.png couldn't be read")
  })

  it('settle after remove leaves the draft unchanged', () => {
    const d = addStaging(emptyDraftFiles, [{ key: 'a', name: 'a.png' }]).draft
    const removed = removeFile(d, 'a')
    expect(settle(removed, 'a', { ok: true, attachment: att('x') })).toBe(removed)
  })
})

describe('removeFile, readyIds and isStaging', () => {
  it('removeFile clears the error', () => {
    expect(removeFile({ files: [ready('a')], error: 'boom' }, 'a')).toEqual({ files: [], error: null })
  })

  it('isStaging and readyIds', () => {
    const d = addStaging({ files: [ready('a')], error: null }, [{ key: 'b', name: 'b.txt' }]).draft
    expect(isStaging(d)).toBe(true)
    expect(readyIds(d)).toEqual(['a'])
    expect(isStaging(settle(d, 'b', { ok: true, attachment: att('b') }))).toBe(false)
    expect(readyIds(emptyDraftFiles)).toEqual([])
  })
})

describe('draftFileName', () => {
  const now = new Date(2026, 9, 25, 13, 5, 9)
  it('paste origin names the file pasted-YYYYMMDD-HHMMSS.png; drop keeps file.name', () => {
    const file = { name: 'image.png', type: 'image/png' }
    expect(draftFileName(file, 'paste', now)).toBe('pasted-20261025-130509.png')
    expect(draftFileName(file, 'drop', now)).toBe('image.png')
    expect(draftFileName(file, 'pick', now)).toBe('image.png')
  })
})
