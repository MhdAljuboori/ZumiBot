import { describe, expect, it } from 'vitest'
import { VOICE, voiceFromPath } from '@zumibot/shared/appPaths'

describe('voiceFromPath', () => {
  it('routes /voice, and reads ?start=1 as an ask to start at once', () => {
    expect(voiceFromPath('/voice', '')).toEqual({ start: false })
    expect(voiceFromPath('/voice', '?start=1')).toEqual({ start: true })
    expect(voiceFromPath('/voice', '?a=2&start=1')).toEqual({ start: true })
    expect(VOICE).toBe('/voice')
  })

  it('takes only start=1 for a start', () => {
    for (const q of ['?start=0', '?start=', '?start', '?restart=1', '?start=11'])
      expect(voiceFromPath('/voice', q)).toEqual({ start: false })
  })

  it('routes nothing else', () => {
    for (const p of ['/voices', '/voice/', '/voice/a', '/', '', '/chat/voice', '/Voice']) expect(voiceFromPath(p, '?start=1')).toBeNull()
  })
})
