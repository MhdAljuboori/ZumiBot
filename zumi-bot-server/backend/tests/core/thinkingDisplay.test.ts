import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThinkingProbe } from '../../src/core/chat/thinkingDisplay'
import { fakeBinName, writeFakeNodeBin } from '../support/fakeBin'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zumibot-thinking-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A fake CLI that answers the probe as claude does: its args go to a log, its text to stderr, exit 1.
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

test('a CLI that takes the flag stops for want of a prompt: yes, and asked once per binary', async () => {
  const bin = cli('new', 'Error: Input must be provided either through stdin or as a prompt argument when using --print')
  const probe = createThinkingProbe({ env })
  expect(await probe(bin)).toBe(true)
  expect(await probe(bin)).toBe(true)
  const { readFileSync } = await import('node:fs')
  expect(readFileSync(`${bin}.log`, 'utf8')).toBe('-p --thinking-display summarized\n')
})

test('an older CLI refuses the unknown option: no', async () => {
  const probe = createThinkingProbe({ env })
  expect(await probe(cli('old', "error: unknown option '--thinking-display'"))).toBe(false)
  // A later one that dropped a value refuses it naming the flag too.
  expect(await probe(cli('later', "error: option '--thinking-display <display>' argument 'summarized' is invalid."))).toBe(false)
})

test('a binary that cannot run, or never ends, is a no', async () => {
  const probe = createThinkingProbe({ env, version: async () => 'v' })
  expect(await probe(join(dir, 'missing'))).toBe(false)
  const hung = createThinkingProbe({ env, run: async () => null })
  expect(await hung('/bin/claude')).toBe(false)
  const thrown = createThinkingProbe({
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
  const probe = createThinkingProbe({
    env,
    version: async () => version,
    run: async (bin) => {
      asked.push(version)
      return version === 'v1' ? "unknown option '--thinking-display'" : 'Input must be provided'
    }
  })
  expect(await probe('/bin/claude')).toBe(false)
  expect(await probe('/bin/claude')).toBe(false)
  version = 'v2'
  expect(await probe('/bin/claude')).toBe(true)
  expect(asked).toEqual(['v1', 'v2'])
})
