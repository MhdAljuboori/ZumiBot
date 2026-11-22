// The real-CLI thinking probe (e2e/thinkingProbe.mjs): its verdicts over the CLI's stream lines, its exit codes, and whole runs
// against fake CLIs, so the probe's own plumbing is checked without the real CLI or any quota.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFakeNodeBin } from './support/fakeBin'

// A whole run starts the fake CLI more than once, each through a launcher and a slower node start on Windows: seconds there.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 })

// @ts-expect-error plain .mjs without types
const probe = (await import('../../e2e/thinkingProbe.mjs')) as {
  classify(lines: string[]): { outcome: 'PASS' | 'FAILED' | 'INCONCLUSIVE'; reason: string | null }
  probeThinking(o?: { bin?: string; log?: (s: string) => void }): Promise<{ outcome: string; version: string; reason: string | null }>
  main(args?: string[], run?: () => Promise<{ outcome: string; version: string; reason: string | null }>): Promise<number>
}

// ---------- stream lines shaped like the real CLI's (claude 2.1.322, stream-json, --verbose, partial messages) ----------
const j = (o: unknown) => JSON.stringify(o)
const init = j({ type: 'system', subtype: 'init', session_id: 's1', claude_code_version: '9.9.9-fake' })
const delta = (thinking: string, parent: string | null = null) =>
  j({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking, estimated_tokens: null } }
  })
const block = (thinking: string, parent: string | null = null) =>
  j({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking, signature: 'sig' }] }
  })
const text = j({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'n = 40' }] }
})
const done = j({ type: 'result', subtype: 'success', is_error: false, result: 'n = 40', session_id: 's1' })
const summary = "I'm checking n from 1 to 39."

it('passes when thinking streams text and the block keeps its summary', () => {
  expect(probe.classify([init, delta("I'm checking"), delta(' n.'), block(summary), text, done])).toEqual({ outcome: 'PASS', reason: null })
})

it('fails when every block comes empty, or when no delta carries text', () => {
  expect(probe.classify([init, delta(''), block(''), text, done]).outcome).toBe('FAILED')
  expect(probe.classify([init, delta(''), block(summary), text, done])).toMatchObject({
    outcome: 'FAILED',
    reason: expect.stringContaining('thinking_delta')
  })
})

it("is inconclusive without an init or when the model did not think; a subagent's thinking does not count", () => {
  expect(probe.classify([]).outcome).toBe('INCONCLUSIVE')
  expect(probe.classify([init, text, done])).toMatchObject({ outcome: 'INCONCLUSIVE', reason: expect.stringContaining('did not think') })
  expect(probe.classify([init, delta('sub', 'toolu_1'), block(summary, 'toolu_1'), text, done]).outcome).toBe('INCONCLUSIVE')
})

it('exit codes: pass 0, failed 1, inconclusive 2 (0 with --soft), and the skip env', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const as = (outcome: string) => async () => ({ outcome, version: '9.9.9', reason: outcome === 'PASS' ? null : 'why' })
    expect(await probe.main([], as('PASS'))).toBe(0)
    expect(await probe.main([], as('FAILED'))).toBe(1)
    expect(await probe.main(['--soft'], as('FAILED'))).toBe(1)
    expect(await probe.main([], as('INCONCLUSIVE'))).toBe(2)
    expect(await probe.main(['--soft'], as('INCONCLUSIVE'))).toBe(0)
    expect(
      await probe.main([], async () => {
        throw new Error('boom')
      })
    ).toBe(2)
    vi.stubEnv('ZUMIBOT_SKIP_THINKING_PROBE', '1')
    expect(await probe.main([], as('FAILED'))).toBe(0)
  } finally {
    vi.unstubAllEnvs()
    err.mockRestore()
    log.mockRestore()
  }
})

// ---------- whole runs against fake CLIs ----------
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thinking-probe-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Given no prompt (the app's check) it stops as claude does; given one, it prints `lines`. An old CLI refuses the flag either way.
function fakeCli(o: { takesFlag: boolean; lines: string[] }): string {
  const out = join(dir, 'out.jsonl')
  writeFileSync(out, o.lines.join('\n') + '\n')
  const fail = (text: string) => `{ process.stderr.write(${JSON.stringify(text + '\n')}); process.exit(1) }`
  return writeFakeNodeBin(
    dir,
    'claude',
    [
      "import { readFileSync } from 'node:fs'",
      o.takesFlag ? '' : fail("error: unknown option '--thinking-display'"),
      "if (process.argv.at(-1) === 'summarized')",
      `  ${fail('Error: Input must be provided either through stdin or as a prompt argument when using --print')}`,
      `process.stdout.write(readFileSync(${JSON.stringify(out)}, 'utf8'))`
    ].join('\n')
  )
}

it('a whole run: PASS against a CLI that streams summaries', async () => {
  const bin = fakeCli({ takesFlag: true, lines: [init, delta("I'm checking"), block(summary), text, done] })
  const r = await probe.probeThinking({ bin, log: () => {} })
  expect(r).toEqual({ outcome: 'PASS', version: '9.9.9-fake', reason: null })
})

it("a whole run: FAILED when the app's check finds no flag", async () => {
  const bin = fakeCli({ takesFlag: false, lines: [] })
  const r = await probe.probeThinking({ bin, log: () => {} })
  expect(r).toMatchObject({ outcome: 'FAILED', reason: expect.stringContaining("app's check") })
})

it('a whole run: inconclusive twice when the model never thinks', async () => {
  const bin = fakeCli({ takesFlag: true, lines: [init, text, done] })
  const logs: string[] = []
  const r = await probe.probeThinking({ bin, log: (s) => logs.push(s) })
  expect(r.outcome).toBe('INCONCLUSIVE')
  expect(logs.filter((l) => l.includes(': INCONCLUSIVE'))).toHaveLength(2)
})
