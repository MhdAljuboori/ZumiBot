import { expect, it } from 'vitest'
import { voiceChatTitle } from '../../src/core/voice/voiceTitle'

it('voiceChatTitle names the day in the given zone', () => {
  expect(voiceChatTitle(Date.UTC(2026, 10, 13, 12), 'UTC')).toBe('Voice · Nov 13')
  expect(voiceChatTitle(Date.UTC(2026, 10, 13, 23), 'Asia/Tokyo')).toBe('Voice · Nov 14')
})
