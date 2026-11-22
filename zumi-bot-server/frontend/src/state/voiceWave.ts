import type { TalkPhase } from './voiceTalk'

/** How many dots the waveform under the avatar has. */
export const WAVE_DOTS = 28

// A mic RMS of about 0.25 is loud speech; scaled so normal talking fills most of the height.
const LOUD = 0.25

const clamp = (v: number): number => Math.max(-1, Math.min(1, v))

/**
 * Each dot's vertical offset, -1..1, for one frame. Listening follows the mic level (flat in silence, so the user sees it
 * hears them); thinking moves on its own, so a busy talk never looks frozen; anything else lies flat.
 */
export function waveDots(phase: TalkPhase, level: number, nowMs: number): number[] {
  const t = nowMs / 1000
  const out: number[] = []
  for (let i = 0; i < WAVE_DOTS; i++) {
    const x = i / (WAVE_DOTS - 1) // 0..1 along the line
    const edge = Math.sin(Math.PI * x) // ends stay low, the middle moves most
    let v = 0
    if (phase === 'listening') {
      const amp = Math.min(1, Math.max(0, level) / LOUD)
      v = amp * edge * Math.sin(2 * Math.PI * (x * 2.5 - t * 1.6))
    } else if (phase === 'transcribing' || phase === 'sending') {
      // One soft bump travelling along the line.
      const centre = (t * 0.6) % 1
      const d = Math.min(Math.abs(x - centre), 1 - Math.abs(x - centre))
      v = 0.45 * Math.exp(-(d * d) / 0.006) * Math.sin(t * 4)
    }
    out.push(clamp(v))
  }
  return out
}
