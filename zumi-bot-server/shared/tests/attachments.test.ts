import { describe, expect, it } from 'vitest'
import { attachmentUrl, formatSize, isThumbnail, pastedName, stageErrors } from '@zumibot/shared/attachments'

describe('attachments helpers', () => {
  it('attachmentUrl builds staged and chat urls', () => {
    expect(attachmentUrl(null, 'a1')).toBe('/api/attachments/staged/a1')
    expect(attachmentUrl('c1', 'a1')).toBe('/api/attachments/chat/c1/a1')
  })

  it('isThumbnail covers bmp but not pdf', () => {
    expect(isThumbnail({ mime: 'image/bmp' })).toBe(true)
    expect(isThumbnail({ mime: 'image/webp' })).toBe(true)
    expect(isThumbnail({ mime: 'application/pdf' })).toBe(false)
    expect(isThumbnail({ mime: 'image/svg+xml' })).toBe(false)
  })

  it('formatSize', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(14_336)).toBe('14 KB')
    expect(formatSize(3_355_443)).toBe('3.2 MB')
  })

  it('pastedName', () => {
    const now = new Date(2026, 9, 24, 9, 5, 7)
    expect(pastedName(now, 'image/jpeg')).toBe('pasted-20261024-090507.jpg')
    expect(pastedName(now, 'image/png')).toBe('pasted-20261024-090507.png')
    expect(pastedName(now, 'image/gif')).toBe('pasted-20261024-090507.gif')
    expect(pastedName(now, 'image/webp')).toBe('pasted-20261024-090507.webp')
    expect(pastedName(now, 'image/bmp')).toBe('pasted-20261024-090507.bmp')
    expect(pastedName(now, 'application/x-unknown')).toBe('pasted-20261024-090507.png')
  })

  it('stage error copy', () => {
    expect(stageErrors.tooBig('a.mov')).toBe('a.mov is over 25 MB')
    expect(stageErrors.folder('docs')).toBe("docs is a folder. Folders can't be attached.")
    expect(stageErrors.unreadable('x.bin')).toBe("x.bin couldn't be read")
    expect(stageErrors.TOO_MANY).toBe('You can attach up to 10 files per message.')
    expect(stageErrors.GONE).toBe('An attached file is gone. Attach it again.')
  })
})
