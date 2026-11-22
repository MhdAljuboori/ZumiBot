import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDropsTurnProbe, saysUnknownOption } from '../../src/core/chat/dropsTurnProbe'
import { fakeBinName, writeFakeNodeBin } from '../support/fakeBin'

// Whether a binary takes --resume-drops-turn, which makes it validate a cut against the turn the cut discards. A no must mean
// the cut goes unvalidated, never a failed rewind. See docs/architecture/edit-resend-fork.md.
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zumibot-drops-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function cli(name: string, stderr: string): string {
  // Logged beside the bin the app is given (`<bin>.log`), whatever its name on this platform.
  const log = `${join(dir, fakeBinName(name))}.log`
  return writeFakeNodeBin(
    dir,
    name,
    `import { appendFileSync } from 'node:fs'\n` +
      `appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')\n` +
      `process.stderr.write(${JSON.stringify(stderr + '\n')})\n` +
      `process.exit(1)\n`
  )
}
const env = () => ({ PATH: process.env.PATH ?? '' })

test('saysUnknownOption reads only the refusal of an unknown option', () => {
  expect(saysUnknownOption("error: unknown option '--resume-drops-turn'")).toBe(true)
  expect(saysUnknownOption('error: Unknown option --resume-drops-turn')).toBe(true)
  expect(saysUnknownOption('Error: --resume-drops-turn requires --resume-session-at')).toBe(false)
  expect(saysUnknownOption('')).toBe(false)
})

test('a CLI that has the flag asks for its pair: yes, and asked once per binary', async () => {
  const bin = cli('new', 'Error: --resume-drops-turn requires --resume-session-at')
  const probe = createDropsTurnProbe({ env })
  expect(await probe(bin)).toBe(true)
  expect(await probe(bin)).toBe(true)
  expect(readFileSync(`${bin}.log`, 'utf8')).toBe('-p --resume-drops-turn 00000000-0000-4000-8000-000000000000\n')
})

test('an older CLI refuses the unknown option: no, so the cut runs as it always did', async () => {
  const probe = createDropsTurnProbe({ env })
  expect(await probe(cli('old', "error: unknown option '--resume-drops-turn'"))).toBe(false)
})

test('a binary that cannot run, or never ends, is a no', async () => {
  const probe = createDropsTurnProbe({ env, version: async () => 'v' })
  expect(await probe(join(dir, 'missing'))).toBe(false)
  const hung = createDropsTurnProbe({ env, run: async () => null })
  expect(await hung('/bin/claude')).toBe(false)
  const thrown = createDropsTurnProbe({
    env,
    run: async () => {
      throw new Error('boom')
    },
    version: async () => 'v'
  })
  expect(await thrown('/bin/claude')).toBe(false)
})

test('an updated binary is asked again', async () => {
  let version = 'v1'
  const asked: string[] = []
  const probe = createDropsTurnProbe({
    env,
    version: async () => version,
    run: async () => {
      asked.push(version)
      return version === 'v1' ? "error: unknown option '--resume-drops-turn'" : 'Error: --resume-drops-turn requires --resume-session-at'
    }
  })
  expect(await probe('/bin/claude')).toBe(false)
  expect(await probe('/bin/claude')).toBe(false)
  version = 'v2'
  expect(await probe('/bin/claude')).toBe(true)
  expect(asked).toEqual(['v1', 'v2'])
})
