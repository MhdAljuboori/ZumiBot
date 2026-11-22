// Writes the audio file the voice e2e needs (committed, so this only reruns when they change):
//   mic-loop.wav: what Chrome's fake microphone plays, over and over: 0.8 s of a loud tone, then 2.4 s of faint noise. Chrome's default
//     fake device plays a tone forever, so the talk's endpointer would never see a pause (a 60 s clip); the noise (RMS far under the
//     endpointer's speech level) keeps the opus clips of the older cases from being digital silence.
// Usage: node zumi-bot-server/e2e/fixtures/makeVoiceAudio.mjs
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (n) => fileURLToPath(new URL(n, import.meta.url))

const RATE = 16_000
const TONE_S = 0.8
const QUIET_S = 2.4
const total = Math.round((TONE_S + QUIET_S) * RATE)
const pcm = Buffer.alloc(total * 2)
let seed = 1
for (let i = 0; i < total; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  const noise = ((seed / 0x7fffffff) * 2 - 1) * 0.004
  const v = i < TONE_S * RATE ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE) : noise
  pcm.writeInt16LE(Math.round(v * 32767), i * 2)
}
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20) // PCM
header.writeUInt16LE(1, 22) // mono
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)
writeFileSync(here('mic-loop.wav'), Buffer.concat([header, pcm]))
