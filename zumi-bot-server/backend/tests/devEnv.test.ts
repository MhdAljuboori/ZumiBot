import { afterEach, describe, expect, it, vi } from 'vitest'
import { aguiAllowLocal, devEnv, testWaitScale } from '../src/devEnv'
import { testVoiceOrigin } from '../src/core/voice/transcriber'

const FAKE = 'http://127.0.0.1:4555'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('devEnv', () => {
  it('passes a dev hook through outside production', () => {
    vi.stubEnv('ZUMIBOT_TEST_VOICE_URL', FAKE)
    vi.stubEnv('NODE_ENV', 'test')
    expect(devEnv('ZUMIBOT_TEST_VOICE_URL')).toBe(FAKE)
    vi.stubEnv('NODE_ENV', undefined)
    expect(devEnv('ZUMIBOT_TEST_VOICE_URL')).toBe(FAKE)
    // What app.ts hands the transcriber: the fake origin replaces OpenRouter.
    expect(testVoiceOrigin(devEnv('ZUMIBOT_TEST_VOICE_URL'))).toBe(FAKE)
  })

  it('ignores the voice hook under NODE_ENV=production, so the key only goes to OpenRouter', () => {
    vi.stubEnv('ZUMIBOT_TEST_VOICE_URL', FAKE)
    vi.stubEnv('NODE_ENV', 'production')
    expect(devEnv('ZUMIBOT_TEST_VOICE_URL')).toBeUndefined()
    expect(testVoiceOrigin(devEnv('ZUMIBOT_TEST_VOICE_URL'))).toBeNull()
  })

  it('reads the workflow wait scale outside production, so e2e waits a minute in a second', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('ZUMIBOT_TEST_WAIT_SCALE', '60')
    expect(testWaitScale()).toBe(60)
    for (const bad of ['', ' ', 'abc', '0', '0.5', '-60', 'Infinity', 'NaN']) {
      vi.stubEnv('ZUMIBOT_TEST_WAIT_SCALE', bad)
      expect(testWaitScale()).toBe(1)
    }
    vi.stubEnv('ZUMIBOT_TEST_WAIT_SCALE', undefined)
    expect(testWaitScale()).toBe(1)
  })

  it('ignores the wait scale under NODE_ENV=production, so a real Wait is never shortened', () => {
    vi.stubEnv('ZUMIBOT_TEST_WAIT_SCALE', '60')
    vi.stubEnv('NODE_ENV', 'production')
    expect(testWaitScale()).toBe(1)
  })

  it('allows local AG-UI endpoints only for exactly 1, and never under NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('ZUMIBOT_AGUI_ALLOW_LOCAL', '1')
    expect(aguiAllowLocal()).toBe(true)
    for (const other of ['', '0', 'true', 'yes', ' 1', '1 ']) {
      vi.stubEnv('ZUMIBOT_AGUI_ALLOW_LOCAL', other)
      expect(aguiAllowLocal()).toBe(false)
    }
    vi.stubEnv('ZUMIBOT_AGUI_ALLOW_LOCAL', undefined)
    expect(aguiAllowLocal()).toBe(false)
    vi.stubEnv('ZUMIBOT_AGUI_ALLOW_LOCAL', '1')
    vi.stubEnv('NODE_ENV', 'production')
    expect(aguiAllowLocal()).toBe(false)
  })
})
