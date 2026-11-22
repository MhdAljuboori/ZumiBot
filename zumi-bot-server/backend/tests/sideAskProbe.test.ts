// The side ask probe's verdicts (e2e/sideAskProbe.mjs) and exit codes, without the real CLI or any quota.
import { afterEach, expect, it, vi } from 'vitest'

const SIDE = 'mcp__zumibot_agents__side_question'
const ASK = 'mcp__zumibot_agents__ask'
// @ts-expect-error plain .mjs without types
const probe = (await import('../../e2e/sideAskProbe.mjs')) as {
  classify(r: unknown): { outcome: 'pass' | 'fail' | 'inconclusive'; reason: string | null }
  main(args?: string[], run?: () => Promise<{ outcome: string; version: string; reason: string | null }>): Promise<number>
}

const run = (o: { side?: boolean; ask?: boolean; bash?: boolean; attempted?: string[]; [k: string]: unknown } = {}) => ({
  version: '9.9.9',
  server: 'connected',
  asked: [],
  attempted: [SIDE, ASK, 'Bash'],
  result: { is_error: false },
  stderr: '',
  error: null,
  ...o,
  markers: { side: o.side ?? true, ask: o.ask ?? false, bash: o.bash ?? false }
})

it('passes only when the side tool ran and the model tried both ask and Bash, and neither ran', () => {
  expect(probe.classify(run())).toEqual({ outcome: 'pass', reason: null })
})

it('is inconclusive when the side tool ran but ask or Bash was never tried', () => {
  for (const [attempted, never] of [
    [[SIDE, 'Bash'], ASK],
    [[SIDE, ASK], 'Bash'],
    [[SIDE], `${ASK} or Bash`]
  ] as const) {
    const v = probe.classify(run({ attempted: [...attempted] }))
    expect(v.outcome).toBe('inconclusive')
    expect(v.reason).toContain(`never tried ${never}`)
  }
})

it('fails when ask or Bash ran, whatever else happened', () => {
  expect(probe.classify(run({ ask: true })).outcome).toBe('fail')
  expect(probe.classify(run({ bash: true, side: false })).outcome).toBe('fail')
  expect(probe.classify(run({ ask: true, bash: true })).reason).toBe('ask and bash ran although the guard must block it')
})

it('is inconclusive when the side tool did not run either', () => {
  const v = probe.classify(run({ side: false }))
  expect(v.outcome).toBe('inconclusive')
  expect(v.reason).toContain('did not run')
  expect(probe.classify(run({ side: false, attempted: [] })).reason).toContain(`never called ${SIDE}`)
  expect(probe.classify(run({ side: false, attempted: [], server: 'failed' })).reason).toContain('did not connect')
})

afterEach(() => vi.restoreAllMocks())

it('maps a verdict to the exit code: 0 pass, 1 failed, 2 inconclusive, 0 inconclusive with --soft', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const verdict = (outcome: string) => async () => ({ outcome, version: '9.9.9', reason: 'why' })
  expect(await probe.main([], verdict('pass'))).toBe(0)
  expect(await probe.main([], verdict('fail'))).toBe(1)
  expect(await probe.main(['--soft'], verdict('fail'))).toBe(1)
  expect(await probe.main([], verdict('inconclusive'))).toBe(2)
  expect(await probe.main(['--soft'], verdict('inconclusive'))).toBe(0)
  expect(err.mock.calls.flat().join('\n')).toMatch(/WARNING: the side ask probe was SKIPPED as inconclusive/)
  expect(
    await probe.main([], async () => {
      throw new Error('boom')
    })
  ).toBe(2)
})
