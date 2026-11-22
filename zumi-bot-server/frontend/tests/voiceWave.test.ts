import { describe, expect, it } from 'vitest'
import { WAVE_DOTS, waveDots } from '../src/state/voiceWave'

const peak = (xs: number[]): number => Math.max(...xs.map(Math.abs))

describe('waveDots', () => {
  it('gives one offset per dot, each within -1..1', () => {
    for (const phase of ['idle', 'listening', 'transcribing', 'sending', 'ended'] as const) {
      for (const level of [0, 0.03, 1, 5]) {
        const d = waveDots(phase, level, 1234)
        expect(d).toHaveLength(WAVE_DOTS)
        for (const v of d) expect(v >= -1 && v <= 1).toBe(true)
      }
    }
  })

  it('lies flat when nothing is going on', () => {
    for (const phase of ['idle', 'ended'] as const) expect(peak(waveDots(phase, 1, 500))).toBe(0)
  })

  it('follows the voice while listening: flat in silence, tall when loud', () => {
    expect(peak(waveDots('listening', 0, 500))).toBe(0)
    const quiet = peak(waveDots('listening', 0.02, 500))
    const loud = peak(waveDots('listening', 0.3, 500))
    expect(loud).toBeGreaterThan(0.5)
    expect(loud).toBeGreaterThan(quiet)
  })

  it('moves on its own while thinking, so the user sees it is busy', () => {
    for (const phase of ['transcribing', 'sending'] as const) {
      expect(peak(waveDots(phase, 0, 500))).toBeGreaterThan(0)
      expect(waveDots(phase, 0, 500)).not.toEqual(waveDots(phase, 0, 900))
    }
  })
})
